import { transaction } from '../db.js';
import { routeForPincode, PINCODE_RE } from '../warehouses.js';
import { toGid } from '../shopify/ids.js';
import { planAllocation } from './allocation.js';

/**
 * Order allocation and cancellation, driven by the orders/create and orders/cancelled webhooks.
 *
 * Overselling prevention: every decrement is a conditional UPDATE (`... WHERE available >= ?`) inside
 * a BEGIN IMMEDIATE transaction that contains no await. Two orders for the last unit therefore run
 * one after the other, and the second sees 0 and falls back / goes to review. It never drives stock
 * negative, whatever the webhook arrival order or concurrency.
 *
 * Idempotency: the orders table is keyed by Shopify order id, so a re-delivered or replayed webhook
 * for an order we've already handled is a no-op, even if it arrives with a new webhook id.
 */
export function createOrderService({ db, inventory, outbox, shopify, logger, now = Date.now }) {
  const q = {
    order: db.prepare('SELECT * FROM orders WHERE order_id = ?'),
    insertOrder: db.prepare('INSERT INTO orders (order_id, order_name, pincode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    setStatus: db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?'),
    stock: db.prepare('SELECT warehouse, available, synced_at FROM stock WHERE inventory_item_id = ?'),
    decrement: db.prepare('UPDATE stock SET available = available - ? WHERE inventory_item_id = ? AND warehouse = ? AND available >= ?'),
    increment: db.prepare('UPDATE stock SET available = available + ? WHERE inventory_item_id = ? AND warehouse = ?'),
    insertAlloc: db.prepare(`INSERT INTO allocations (order_id, line_item_id, variant_id, inventory_item_id, warehouse, quantity, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    allocs: db.prepare('SELECT * FROM allocations WHERE order_id = ? ORDER BY id'),
    release: db.prepare(`UPDATE allocations SET status = 'released' WHERE id = ?`),
  };

  function pincodeOf(order) {
    const candidates = [
      order.shipping_address?.zip,
      order.note_attributes?.find((a) => /pincode/i.test(a.name))?.value,
      order.billing_address?.zip,
    ];
    for (const c of candidates) {
      const p = String(c ?? '').replace(/\s+/g, '');
      if (PINCODE_RE.test(p)) return p;
    }
    return null;
  }

  function ledgerFor(itemId) {
    const out = Object.fromEntries(inventory.codes.map((c) => [c, 0]));
    for (const r of q.stock.all(itemId)) out[r.warehouse] = r.available;
    return out;
  }

  /** Where Shopify committed this order's tracked units: Map itemId -> { DEL: n, ... }. */
  async function ownCommitments(orderGid, lines, variants) {
    const own = new Map();
    const tracked = lines.filter((l) => variants.get(toGid('ProductVariant', l.variant_id))?.tracked);
    if (!tracked.length || !shopify) return own;
    const fos = await shopify.getFulfillmentOrders(orderGid);
    if (!fos) return own; // not visible yet: treat as no commitment (under-counts, never over-counts)
    const itemByLine = new Map(tracked.map((l) => [
      toGid('LineItem', String(l.id)),
      variants.get(toGid('ProductVariant', l.variant_id)).inventoryItemId,
    ]));
    for (const fo of fos) {
      if (!['OPEN', 'SCHEDULED', 'IN_PROGRESS'].includes(fo.status)) continue;
      const wh = inventory.codeFor(fo.locationId);
      if (!wh) continue;
      for (const li of fo.lineItems) {
        const itemId = itemByLine.get(li.lineItemId);
        if (!itemId || !li.remainingQuantity) continue;
        const m = own.get(itemId) || {};
        m[wh] = (m[wh] || 0) + li.remainingQuantity;
        own.set(itemId, m);
      }
    }
    return own;
  }

  async function allocate(order) {
    const orderId = String(order.id);
    const orderGid = order.admin_graphql_api_id || toGid('Order', orderId);
    if (order.cancelled_at) return cancel(order); // created already-cancelled, or a late create

    if (q.order.get(orderId)) return { orderId, duplicate: true };

    const pincode = pincodeOf(order);
    const route = pincode ? routeForPincode(pincode) : null;
    const lines = (order.line_items || []).filter((l) => l.variant_id && l.requires_shipping !== false && (l.fulfillable_quantity ?? l.quantity) > 0);

    // Resolve variants (network) BEFORE the transaction; `fresh` forces a read of Shopify's current,
    // post-order numbers into the ledger. If Shopify is down and the ledger is too stale, this throws
    // and the webhook event is retried later.
    const receivedAt = now(); // every read from here on happens after the order existed in Shopify
    const variants = new Map();
    for (const l of lines) {
      const gid = toGid('ProductVariant', l.variant_id);
      if (!variants.has(gid)) variants.set(gid, await inventory.getVariant(gid, { fresh: true }));
    }

    // Shopify commits an order's stock the moment it is placed, so the "available" we just read no
    // longer includes this order's own units. Find where Shopify committed them, so this order can
    // count them as its own instead of competing with itself.
    const own = await ownCommitments(orderGid, lines, variants); // Map itemId -> { [warehouse]: qty }
    const createdMs = Date.parse(order.created_at) || 0;

    const result = transaction(db, () => {
      // Re-check inside the lock: a concurrent delivery may have won while we were resolving variants.
      if (q.order.get(orderId)) return { orderId, duplicate: true };
      const t = now();
      q.insertOrder.run(orderId, order.name ?? null, pincode, 'allocating', t, t);

      // Give back this order's own commitment — only where the ledger is known to contain it:
      //  - synced from a read we started after this webhook arrived (the order existed by then), or
      //  - synced from a read that started safely after the order's created_at (2s margin for clock
      //    skew and Shopify's second-precision timestamps).
      // Otherwise the ledger never saw the commitment and adding it back would double count. When in
      // doubt we under-count (may fall back / review), never over-count (could oversell a warehouse).
      for (const [itemId, byWarehouse] of own) {
        const syncedAt = Math.min(...q.stock.all(itemId).map((r) => r.synced_at ?? 0));
        const knownToInclude = syncedAt >= receivedAt || (createdMs && syncedAt >= createdMs + 2000);
        if (!knownToInclude) continue;
        for (const [wh, qty] of Object.entries(byWarehouse)) q.increment.run(qty, itemId, wh);
      }

      const moves = []; // { lineItemGid, warehouse, quantity }
      const touchedItems = new Set();
      let short = 0;

      for (const l of lines) {
        const qty = l.fulfillable_quantity ?? l.quantity;
        const lineId = String(l.id);
        const v = variants.get(toGid('ProductVariant', l.variant_id));
        if (!v || !route) {
          q.insertAlloc.run(orderId, lineId, String(l.variant_id), v?.inventoryItemId ?? null, null, qty, 'unallocated', t);
          short += qty;
          continue;
        }
        const plan = planAllocation(route, ledgerFor(v.inventoryItemId), qty, { tracked: v.tracked });
        for (const part of plan.parts) {
          if (v.tracked) {
            const r = q.decrement.run(part.quantity, v.inventoryItemId, part.warehouse, part.quantity);
            if (r.changes !== 1) throw new Error(`Invariant: conditional decrement failed for ${v.inventoryItemId}@${part.warehouse}`);
            touchedItems.add(v.inventoryItemId);
          }
          q.insertAlloc.run(orderId, lineId, String(l.variant_id), v.inventoryItemId, part.warehouse, part.quantity, 'allocated', t);
          moves.push({ lineItemGid: toGid('LineItem', lineId), warehouse: part.warehouse, quantity: part.quantity });
        }
        if (plan.shortfall > 0) {
          q.insertAlloc.run(orderId, lineId, String(l.variant_id), v.inventoryItemId, null, plan.shortfall, 'unallocated', t);
          short += plan.shortfall;
        }
      }

      const status = !route ? 'needs_review' : short === 0 ? 'allocated' : moves.length ? 'partially_allocated' : 'needs_review';
      q.setStatus.run(status, t, orderId);

      if (moves.length) {
        outbox.enqueue('route_order', { orderGid, moves }, { dedupeKey: `route:${orderId}`, itemIds: [...touchedItems] });
      }
      const tags = [...new Set(moves.map((m) => `warehouse-${m.warehouse}`))];
      if (status !== 'allocated') tags.push('allocation-review');
      if (tags.length) outbox.enqueue('tag_order', { orderGid, tags }, { dedupeKey: `tag:${orderId}` });

      return { orderId, status, pincode, region: route?.region ?? null, allocations: q.allocs.all(orderId) };
    });

    if (!result.duplicate) {
      logger?.info('order.allocated', { orderId, status: result.status, pincode: result.pincode });
      outbox.kick();
    }
    return result;
  }

  /**
   * Release stock for unfulfilled allocations. If the cancel beats the create (Shopify does not
   * guarantee delivery order), we record a tombstone so the late create is ignored.
   */
  function cancel(order) {
    const orderId = String(order.id);
    const fulfilledLines = new Set((order.line_items || []).filter((l) => l.fulfillment_status === 'fulfilled').map((l) => String(l.id)));

    const result = transaction(db, () => {
      const existing = q.order.get(orderId);
      const t = now();
      if (!existing) {
        q.insertOrder.run(orderId, order.name ?? null, null, 'cancelled', t, t);
        return { orderId, status: 'cancelled', tombstone: true, released: [] };
      }
      if (existing.status === 'cancelled') return { orderId, duplicate: true };

      const released = [];
      for (const a of q.allocs.all(orderId)) {
        if (a.status !== 'allocated' || fulfilledLines.has(a.line_item_id)) continue; // shipped stock stays shipped
        if (a.inventory_item_id) q.increment.run(a.quantity, a.inventory_item_id, a.warehouse);
        q.release.run(a.id);
        released.push({ line_item_id: a.line_item_id, warehouse: a.warehouse, quantity: a.quantity });
      }
      q.setStatus.run('cancelled', t, orderId);
      outbox.cancel(`route:${orderId}`, 'order cancelled');
      // Shopify releases its own commitment on cancel; re-read to converge the ledger with it.
      const items = [...new Set(q.allocs.all(orderId).map((a) => a.inventory_item_id).filter(Boolean))];
      if (items.length) outbox.enqueue('resync_items', { itemIds: items }, { dedupeKey: `resync:cancel:${orderId}` });
      return { orderId, status: 'cancelled', released };
    });

    if (!result.duplicate) {
      logger?.info('order.cancelled', { orderId, released: result.released?.length ?? 0, tombstone: !!result.tombstone });
      outbox.kick();
    }
    return result;
  }

  return {
    allocate,
    cancel,
    get: (orderId) => {
      const o = q.order.get(String(orderId));
      return o ? { ...o, allocations: q.allocs.all(String(orderId)) } : null;
    },
  };
}
