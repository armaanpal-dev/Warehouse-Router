import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signedWebhook, waitFor, orderPayload, ADMIN_KEY } from './helpers.js';
import { MOCK_LOCATIONS } from '../src/shopify/mock.js';

let t;
beforeEach(async () => { t = await startApp(); });
afterEach(() => t.close());

const send = async (payload, topic, opts = {}) => {
  const { body, headers } = signedWebhook(payload, { topic, ...opts });
  const res = await t.post('/webhooks', body, headers);
  return { status: res.status, body: await res.json() };
};
const processed = (orderId) => waitFor(() => {
  const o = t.ctx.orders.get(orderId);
  return o && o.status !== 'allocating' ? o : null;
});
const ledger = (variantId) => {
  const row = t.ctx.db.prepare('SELECT inventory_item_id FROM variants WHERE variant_id = ?').get(`gid://shopify/ProductVariant/${variantId}`);
  return t.ctx.inventory.ledger(row.inventory_item_id);
};

test('rejects bad signatures and foreign shops', async () => {
  const { body, headers } = signedWebhook({ id: 1 }, { topic: 'orders/create' });
  let res = await t.post('/webhooks', body, { ...headers, 'X-Shopify-Hmac-Sha256': 'AAAA' });
  assert.equal(res.status, 401);
  res = await t.post('/webhooks', body.replace('1', '2'), headers); // tampered body
  assert.equal(res.status, 401);
  const other = signedWebhook({ id: 1 }, { topic: 'orders/create', shop: 'other.myshopify.com' });
  res = await t.post('/webhooks', other.body, other.headers);
  assert.equal(res.status, 403);
});

test('orders/create allocates from the pincode warehouse, moves the fulfillment order and tags the order', async () => {
  const order = t.shopify.createOrder({ pincode: '560001', lines: [{ variant_id: '46001', quantity: 2 }] });
  // Shopify's own routing committed it at DEL (highest priority location with stock).
  assert.equal(t.shopify.getAvailable('46001', 'DEL'), 3);

  const r = await send(order, 'orders/create');
  assert.equal(r.status, 200);
  const o = await processed(order.id);
  assert.equal(o.status, 'allocated');
  assert.deepEqual(o.allocations.map((a) => [a.warehouse, a.quantity, a.status]), [['BLR', 2, 'allocated']]);

  await t.ctx.outbox.drain();
  const fos = await t.shopify.getFulfillmentOrders(order.admin_graphql_api_id);
  const open = fos.filter((f) => f.status === 'OPEN');
  assert.equal(open.length, 1);
  assert.equal(open[0].locationId, MOCK_LOCATIONS.BLR);
  assert.deepEqual(t.shopify.getTags(order.admin_graphql_api_id), ['warehouse-BLR']);
  // After the move Shopify's per-location stock and our ledger agree.
  assert.equal(t.shopify.getAvailable('46001', 'DEL'), 5);
  assert.equal(t.shopify.getAvailable('46001', 'BLR'), 1);
  await t.ctx.inventory.refreshItems(t.ctx.inventory.allItemIds(), 'test');
  assert.deepEqual(ledger('46001'), { DEL: 5, BLR: 1, BOM: 4 });
});

test('an order does not compete with its own Shopify commitment (regression: live order #1007)', async () => {
  // Silver / 12 Ltr: DEL 2, BOM 6. Shopify splits 7 units DEL 2 + BOM 5 and commits them at checkout,
  // so by the time the webhook arrives Shopify's "available" shows only 1 unit left in total.
  const order = t.shopify.createOrder({ pincode: '110001', lines: [{ variant_id: '46002', quantity: 7 }] });
  assert.equal(t.shopify.getAvailable('46002', 'DEL') + t.shopify.getAvailable('46002', 'BOM'), 1);
  await send(order, 'orders/create');
  const o = await processed(order.id);
  assert.equal(o.status, 'allocated');
  assert.deepEqual(o.allocations.map((a) => [a.warehouse, a.quantity]), [['DEL', 2], ['BOM', 5]]);
  await t.ctx.outbox.drain();
  assert.deepEqual(t.shopify.getTags(order.admin_graphql_api_id).sort(), ['warehouse-BOM', 'warehouse-DEL']);
  // Ledger now matches Shopify: nothing double-counted.
  await t.ctx.inventory.refreshItems(t.ctx.inventory.allItemIds(), 'test');
  const disc = t.ctx.db.prepare(`SELECT * FROM discrepancies WHERE source = 'test'`).all();
  assert.deepEqual(disc, []);
});

test('own-commitment add-back also works when the order lands on the primary warehouse', async () => {
  const order = t.shopify.createOrder({ pincode: '110001', lines: [{ variant_id: '46001', quantity: 5 }] }); // DEL has exactly 5
  await send(order, 'orders/create');
  const o = await processed(order.id);
  assert.equal(o.status, 'allocated');
  assert.deepEqual(o.allocations.map((a) => [a.warehouse, a.quantity]), [['DEL', 5]]);
});

test('duplicate delivery (same webhook id) is acknowledged but not re-processed', async () => {
  const order = t.shopify.createOrder({ pincode: '560001', lines: [{ variant_id: '46001', quantity: 1 }] });
  const first = await send(order, 'orders/create', { webhookId: 'wh-1' });
  await processed(order.id);
  const again = await send(order, 'orders/create', { webhookId: 'wh-1' });
  assert.equal(first.body.duplicate, false);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(t.ctx.orders.get(order.id).allocations.length, 1);
});

test('same order under a new webhook id is still allocated only once', async () => {
  const order = t.shopify.createOrder({ pincode: '560001', lines: [{ variant_id: '46001', quantity: 1 }] });
  await send(order, 'orders/create', { webhookId: 'a' });
  await processed(order.id);
  const before = ledger('46001');
  await send(order, 'orders/create', { webhookId: 'b' });
  await waitFor(() => t.ctx.webhooks.recent().find((e) => e.webhook_id === 'b' && e.status === 'processed'));
  assert.deepEqual(ledger('46001'), before);
  assert.equal(t.ctx.orders.get(order.id).allocations.length, 1);
});

test('concurrent orders never oversell a warehouse', async () => {
  // Silver / 18 Ltr: exactly 1 unit, in BLR. 8 simultaneous orders for it.
  const orders = Array.from({ length: 8 }, (_, i) => orderPayload(7000 + i, { pincode: '560001', lines: [{ variant_id: '46003', quantity: 1 }] }));
  await Promise.all(orders.map((o) => send(o, 'orders/create')));
  const results = await Promise.all(orders.map((o) => processed(o.id)));
  assert.equal(results.filter((o) => o.status === 'allocated').length, 1);
  assert.equal(results.filter((o) => o.status === 'needs_review').length, 7);
  assert.deepEqual(ledger('46003'), { DEL: 0, BLR: 0, BOM: 0 });
});

test('concurrent orders across warehouses: allocations never exceed total stock and fall back correctly', async () => {
  // Silver / 8 Ltr: DEL 5, BLR 3, BOM 4 = 12 units. 20 orders of 1 unit to Bengaluru.
  const orders = Array.from({ length: 20 }, (_, i) => orderPayload(8000 + i, { pincode: '560001', lines: [{ variant_id: '46001', quantity: 1 }] }));
  await Promise.all(orders.map((o) => send(o, 'orders/create')));
  const results = await Promise.all(orders.map((o) => processed(o.id)));
  const allocated = results.flatMap((o) => o.allocations.filter((a) => a.status === 'allocated'));
  assert.equal(allocated.length, 12);
  const byWh = allocated.reduce((m, a) => ({ ...m, [a.warehouse]: (m[a.warehouse] || 0) + 1 }), {});
  assert.deepEqual(byWh, { BLR: 3, BOM: 4, DEL: 5 }); // primary first, then fallbacks in distance order
  assert.deepEqual(ledger('46001'), { DEL: 0, BLR: 0, BOM: 0 });
});

test('orders/cancelled releases unfulfilled stock back to the allocated warehouse, once', async () => {
  const order = t.shopify.createOrder({ pincode: '400001', lines: [{ variant_id: '46001', quantity: 3 }] });
  await send(order, 'orders/create');
  await processed(order.id);
  await t.ctx.outbox.drain();
  assert.equal(ledger('46001').BOM, 1);

  const cancelled = t.shopify.cancelOrder(order);
  await send(cancelled, 'orders/cancelled', { webhookId: 'c1' });
  await waitFor(() => t.ctx.orders.get(order.id).status === 'cancelled');
  assert.equal(ledger('46001').BOM, 4);
  assert.deepEqual(t.ctx.orders.get(order.id).allocations.map((a) => a.status), ['released']);

  await send(cancelled, 'orders/cancelled', { webhookId: 'c2' }); // replay under a new id
  await waitFor(() => t.ctx.webhooks.recent().find((e) => e.webhook_id === 'c2' && e.status === 'processed'));
  assert.equal(ledger('46001').BOM, 4); // not released twice

  await t.ctx.outbox.drain(); // resync job: ledger converges with Shopify
  assert.deepEqual(ledger('46001'), { DEL: 5, BLR: 3, BOM: 4 });
});

test('cancel arriving before create leaves a tombstone; the late create is ignored', async () => {
  const order = orderPayload(9100, { pincode: '560001', lines: [{ variant_id: '46001', quantity: 1 }] });
  await send({ ...order, cancelled_at: new Date().toISOString() }, 'orders/cancelled');
  await waitFor(() => t.ctx.orders.get(order.id));
  await send(order, 'orders/create');
  await waitFor(() => t.ctx.webhooks.recent().filter((e) => e.status === 'processed').length === 2);
  const o = t.ctx.orders.get(order.id);
  assert.equal(o.status, 'cancelled');
  assert.equal(o.allocations.length, 0);
});

test('Shopify write failures are retried from the outbox without re-allocating', async () => {
  const order = t.shopify.createOrder({ pincode: '560001', lines: [{ variant_id: '46001', quantity: 1 }] });
  t.shopify.failNext('moveFulfillmentOrder', 1);
  await send(order, 'orders/create');
  await processed(order.id);
  await t.ctx.outbox.drain();
  let job = t.ctx.db.prepare(`SELECT * FROM outbox WHERE type = 'route_order'`).get();
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 1);
  // While the move is pending the ledger is ahead of Shopify and a sync must not overwrite it.
  assert.equal(t.ctx.inventory.hasPending(t.ctx.orders.get(order.id).allocations[0].inventory_item_id), true);

  t.ctx.db.prepare('UPDATE outbox SET next_run_at = 0').run(); // skip the backoff
  await t.ctx.outbox.drain();
  job = t.ctx.db.prepare(`SELECT * FROM outbox WHERE type = 'route_order'`).get();
  assert.equal(job.status, 'done');
  assert.equal(t.ctx.orders.get(order.id).allocations.length, 1);
});

test('a failed webhook (Shopify down, nothing cached) is retried by the sweeper', async () => {
  const order = orderPayload(9200, { pincode: '560001', lines: [{ variant_id: '46007', quantity: 1 }] });
  t.shopify.failNext('getVariantInventory', 1);
  await send(order, 'orders/create', { webhookId: 'retry-me' });
  await waitFor(() => t.ctx.webhooks.recent().find((e) => e.webhook_id === 'retry-me' && e.status === 'failed'));
  t.ctx.db.prepare('UPDATE webhook_events SET processed_at = 0').run(); // skip the backoff
  await t.ctx.webhooks.sweep();
  assert.equal(t.ctx.orders.get(order.id).status, 'allocated');
  assert.equal(t.ctx.orders.get(order.id).allocations[0].warehouse, 'BLR');
});

test('reconciliation records and corrects external stock changes', async () => {
  await t.post('/api/express-availability', { variant_id: '46006', quantity: 1, pincode: '560001' });
  t.shopify.setAvailable('46006', 'DEL', 10); // e.g. a stock count or return processed in Shopify admin
  const res = await t.post('/api/admin/reconcile', {}, { 'X-Api-Key': ADMIN_KEY });
  const report = await res.json();
  assert.equal(report.discrepancies.length, 1);
  assert.deepEqual(report.discrepancies[0].warehouse, 'DEL');
  assert.equal(report.discrepancies[0].ledger, 3);
  assert.equal(report.discrepancies[0].shopify, 10);
  assert.equal(ledger('46006').DEL, 10);
});

test('orders with no serviceable pincode go to review, and consume no stock', async () => {
  const order = orderPayload(9300, { pincode: '999999', lines: [{ variant_id: '46001', quantity: 1 }] });
  await send(order, 'orders/create');
  const o = await processed(order.id);
  assert.equal(o.status, 'needs_review');
  assert.equal(o.allocations[0].status, 'unallocated');
});

test('catch-up recovers orders whose webhook never arrived, and skips ones already handled', async () => {
  // Server was down: Shopify took two orders (one later cancelled) and no webhook reached us.
  const missed = t.shopify.createOrder({ pincode: '560001', lines: [{ variant_id: '46001', quantity: 1 }] });
  const cancelled = t.shopify.cancelOrder(t.shopify.createOrder({ pincode: '110001', lines: [{ variant_id: '46006', quantity: 1 }] }));
  // A third one did arrive normally.
  const seen = t.shopify.createOrder({ pincode: '400001', lines: [{ variant_id: '46006', quantity: 1 }] });
  await send(seen, 'orders/create');
  await processed(seen.id);

  const res = await t.post('/api/admin/catch-up', {}, { 'X-Api-Key': ADMIN_KEY });
  const r = await res.json();
  assert.equal(r.checked, 3);
  assert.deepEqual(r.recovered.map((o) => [o.order_id, o.status]), [[String(missed.id), 'allocated'], [String(cancelled.id), 'cancelled']]);

  await t.ctx.outbox.drain();
  assert.deepEqual(t.shopify.getTags(missed.admin_graphql_api_id), ['warehouse-BLR']);
  assert.deepEqual(t.shopify.getTags(cancelled.admin_graphql_api_id), []);

  // Shopify's retry of the missed webhook arriving afterwards is a no-op, and so is a second run.
  const late = await send(missed, 'orders/create');
  assert.equal(late.status, 200);
  assert.equal((await t.ctx.catchUp.run()).recovered.length, 0);
  assert.equal(t.ctx.orders.get(missed.id).allocations.length, 1);
});
