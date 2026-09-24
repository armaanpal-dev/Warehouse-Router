import { ShopifyError } from '../errors.js';

/**
 * Outbox job handlers — the Shopify side-effects of an allocation.
 *
 * route_order moves each allocated quantity onto a fulfillment order at the chosen warehouse, so the
 * warehouse team sees it in their queue and Shopify's committed stock moves to the right location.
 * It is written to be re-runnable: it first counts what is already at the target location (from an
 * earlier partial run, or because Shopify's own routing happened to pick the same warehouse) and only
 * moves the difference.
 */
export function registerJobs({ outbox, shopify, inventory, logger }) {
  outbox.register('route_order', async ({ orderGid, moves }) => {
    const fos = await shopify.getFulfillmentOrders(orderGid);
    if (!fos) throw new ShopifyError(`Order ${orderGid} not visible yet`, { retryable: true });

    // Working copy of what's movable: open FO lines with remaining quantity.
    const pool = fos
      .filter((fo) => fo.status === 'OPEN' || fo.status === 'SCHEDULED')
      .flatMap((fo) => fo.lineItems.map((li) => ({ foId: fo.id, locationId: fo.locationId, id: li.id, lineItemId: li.lineItemId, left: li.remainingQuantity })));

    const batches = new Map(); // `${foId}|${targetLocation}` -> [{ id, quantity }]
    for (const m of moves) {
      const target = inventory.locationFor(m.warehouse);
      let need = m.quantity;
      // 1. Already at the target warehouse: nothing to move.
      for (const p of pool.filter((p) => p.lineItemId === m.lineItemGid && p.locationId === target && p.left > 0)) {
        const take = Math.min(need, p.left); p.left -= take; need -= take;
        if (!need) break;
      }
      // 2. Move the rest from wherever Shopify put it.
      for (const p of pool.filter((p) => p.lineItemId === m.lineItemGid && p.locationId !== target && p.left > 0)) {
        if (!need) break;
        const take = Math.min(need, p.left); p.left -= take; need -= take;
        const key = `${p.foId}|${target}`;
        if (!batches.has(key)) batches.set(key, []);
        batches.get(key).push({ id: p.id, quantity: take });
      }
      if (need > 0) logger?.warn('route.unmatched', { orderGid, lineItem: m.lineItemGid, missing: need });
    }

    for (const [key, lines] of batches) {
      const [foId, target] = key.split('|');
      await shopify.moveFulfillmentOrder(foId, target, lines);
      logger?.info('route.moved', { orderGid, foId, to: inventory.codeFor(target), lines: lines.length });
    }
  });

  outbox.register('tag_order', async ({ orderGid, tags }) => {
    await shopify.addOrderTags(orderGid, tags);
  });

  outbox.register('resync_items', async ({ itemIds }) => {
    await inventory.refreshItems(itemIds, 'resync');
  });
}

/**
 * Catch-up for missed webhooks. Shopify gives up on a webhook after its retries run out, so an order
 * placed while this server (or its tunnel) was down would otherwise never be routed or tagged. This
 * lists recent orders from Shopify and feeds any we have no record of through the normal allocate()
 * path. Safe to overlap with live webhooks: allocate() re-checks the order id inside its transaction.
 */
export function createCatchUp({ shopify, orders, logger, windowMs, now = Date.now }) {
  let running = false;
  async function run() {
    if (running) return { skipped: true };
    running = true;
    try {
      const since = new Date(now() - windowMs).toISOString();
      const recent = await shopify.listOrdersSince(since);
      const recovered = [];
      for (const order of recent) {
        if (orders.get(order.id)) continue;
        // A cancelled order we never saw has nothing to release; recording it still stops a late
        // orders/create delivery from allocating it.
        const r = order.cancelled_at ? orders.cancel(order) : await orders.allocate(order);
        if (!r.duplicate) recovered.push({ order_id: String(order.id), name: order.name, status: r.status });
      }
      if (recovered.length) logger?.warn('catchup.recovered', { count: recovered.length, orders: recovered.map((o) => o.name) });
      return { checked: recent.length, since, recovered };
    } finally {
      running = false;
    }
  }
  return { run };
}

/** Periodic reconciliation: Shopify vs ledger for every item we track. Returns what changed. */
export function createReconciler({ inventory, logger }) {
  let running = false;
  async function run() {
    if (running) return { skipped: true };
    running = true;
    try {
      const ids = inventory.allItemIds();
      const report = await inventory.refreshItems(ids, 'reconcile');
      const discrepancies = report.flatMap((r) => r.discrepancies.map((d) => ({ inventory_item_id: r.itemId, ...d })));
      const skipped = report.filter((r) => r.skipped).map((r) => r.itemId);
      logger?.info('reconcile.done', { items: ids.length, discrepancies: discrepancies.length, skipped: skipped.length });
      return { items_checked: ids.length, discrepancies, skipped_in_flight: skipped };
    } finally {
      running = false;
    }
  }
  return { run };
}
