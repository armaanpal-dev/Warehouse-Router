import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let t;
before(async () => { t = await startApp(); });
after(() => t.close());

const check = async (body) => {
  const res = await t.post('/api/express-availability', body);
  return { status: res.status, body: await res.json() };
};

test('sample request: 2 units to 560001 ships express from Bengaluru', async () => {
  const { status, body } = await check({ variant_id: '46001', quantity: 2, pincode: '560001' });
  assert.equal(status, 200);
  assert.equal(body.available, true);
  assert.equal(body.express, true);
  assert.equal(body.fulfillment.warehouse.code, 'BLR');
  assert.equal(body.fulfillment.fallback_used, false);
  assert.deepEqual(body.fulfillment.estimated_delivery_days, { min: 1, max: 1 });
  assert.equal(body.inventory_source, 'live');
});

test('primary short: falls back to the next-nearest warehouse that can ship it whole', async () => {
  const { body } = await check({ variant_id: '46001', quantity: 4, pincode: '560001' }); // BLR has 3
  assert.equal(body.available, true);
  assert.equal(body.express, false);
  assert.equal(body.fulfillment.warehouse.code, 'BOM');
  assert.equal(body.fulfillment.fallback_used, true);
  assert.deepEqual(body.fulfillment.estimated_delivery_days, { min: 4, max: 6 });
});

test('no single warehouse has enough: split shipment', async () => {
  const { body } = await check({ variant_id: '46002', quantity: 7, pincode: '110001' }); // DEL 2, BOM 6
  assert.equal(body.fulfillment.type, 'split');
  assert.deepEqual(body.fulfillment.allocations, [{ warehouse: 'DEL', quantity: 2 }, { warehouse: 'BOM', quantity: 5 }]);
});

test('not enough anywhere / out of stock is a 200 with available:false', async () => {
  let r = await check({ variant_id: '46002', quantity: 9, pincode: '110001' });
  assert.equal(r.status, 200);
  assert.equal(r.body.available, false);
  assert.equal(r.body.reason, 'INSUFFICIENT_STOCK');
  assert.equal(r.body.max_available_quantity, 8);
  r = await check({ variant_id: '46005', quantity: 1, pincode: '110001' });
  assert.equal(r.body.reason, 'OUT_OF_STOCK');
});

test('validation errors are 400 with per-field details', async () => {
  const r = await check({ variant_id: 'abc', quantity: 0, pincode: '12' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(r.body.error.details.map((d) => d.field).sort(), ['pincode', 'quantity', 'variant_id']);
  assert.ok(r.body.request_id);
});

test('malformed JSON is 400 INVALID_JSON', async () => {
  const res = await t.post('/api/express-availability', '{"variant_id":');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'INVALID_JSON');
});

test('unserviceable pincode is 422, unknown variant is 404', async () => {
  let r = await check({ variant_id: '46001', quantity: 1, pincode: '999999' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'PINCODE_NOT_SERVICEABLE');
  r = await check({ variant_id: '123456789', quantity: 1, pincode: '560001' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'VARIANT_NOT_FOUND');
});

test('GID variant ids are accepted', async () => {
  const r = await check({ variant_id: 'gid://shopify/ProductVariant/46001', quantity: 1, pincode: '400001' });
  assert.equal(r.body.fulfillment.warehouse.code, 'BOM');
});

test('Shopify outage: serves the recent ledger (flagged), 503 when there is nothing recent', async () => {
  await check({ variant_id: '46006', quantity: 1, pincode: '560001' }); // warms the ledger
  t.shopify.failNext('getVariantInventory', 1);
  let r = await check({ variant_id: '46006', quantity: 1, pincode: '560001' });
  assert.equal(r.status, 200);
  assert.equal(r.body.inventory_source, 'cache');

  t.shopify.failNext('getVariantInventory', 1);
  r = await check({ variant_id: '46008', quantity: 1, pincode: '560001' }); // never seen before
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'INVENTORY_UNAVAILABLE');
});

test('CORS: allow-listed storefront origin only', async () => {
  let res = await fetch(`${t.base}/api/express-availability`, { method: 'OPTIONS', headers: { Origin: 'https://test-shop.myshopify.com', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://test-shop.myshopify.com');
  res = await fetch(`${t.base}/api/express-availability`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('admin endpoints require the API key', async () => {
  let res = await t.get('/api/admin/stock/46001');
  assert.equal(res.status, 401);
  res = await t.get('/api/admin/stock/46001', { 'X-Api-Key': 'test-admin-key-0123456789' });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).ledger, { DEL: 5, BLR: 3, BOM: 4 });
});
