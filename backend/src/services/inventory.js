import { transaction } from '../db.js';
import { AppError, ShopifyError } from '../errors.js';

/**
 * The stock ledger.
 *
 * Shopify owns physical stock. We keep a per-warehouse copy so that allocation can be a single
 * synchronous, atomic database transaction (no network call inside it), and so that we can subtract
 * allocations we've made before Shopify reflects them.
 *
 * Sync rule: a Shopify read overwrites the ledger for an item UNLESS a Shopify write for that item
 * is still queued in the outbox (pending_items). In that window the ledger is ahead of Shopify, and
 * overwriting it would hand out the same unit twice.
 */
export function createInventoryService({ db, shopify, warehouseLocations, cacheMs, staleMaxMs, logger, now = Date.now }) {
  const codes = Object.keys(warehouseLocations);
  const codeByLocation = new Map(Object.entries(warehouseLocations).map(([code, id]) => [id, code]));
  const cache = new Map(); // variantGid -> { at, variant }

  const q = {
    getVariant: db.prepare('SELECT * FROM variants WHERE variant_id = ?'),
    upsertVariant: db.prepare(`INSERT INTO variants (variant_id, inventory_item_id, sku, title, tracked, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(variant_id) DO UPDATE SET inventory_item_id = excluded.inventory_item_id,
      sku = excluded.sku, title = excluded.title, tracked = excluded.tracked, updated_at = excluded.updated_at`),
    stockRows: db.prepare('SELECT warehouse, available, synced_at FROM stock WHERE inventory_item_id = ?'),
    stockRow: db.prepare('SELECT available FROM stock WHERE inventory_item_id = ? AND warehouse = ?'),
    upsertStock: db.prepare(`INSERT INTO stock (inventory_item_id, warehouse, available, synced_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(inventory_item_id, warehouse) DO UPDATE SET available = excluded.available, synced_at = excluded.synced_at`),
    pendingFor: db.prepare(`SELECT 1 FROM pending_items p JOIN outbox o ON o.id = p.outbox_id
      WHERE p.inventory_item_id = ? AND o.status = 'pending' LIMIT 1`),
    addDiscrepancy: db.prepare(`INSERT INTO discrepancies (inventory_item_id, warehouse, ledger_qty, shopify_qty, source, detected_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    allItems: db.prepare('SELECT DISTINCT inventory_item_id FROM stock'),
  };

  function hasPending(itemId) { return !!q.pendingFor.get(itemId); }

  /**
   * Apply Shopify's levels to the ledger (see sync rule above). Returns discrepancies found.
   * `readAt` is when the Shopify read *started*; it becomes synced_at, and a read that started before
   * the last applied one is dropped, so a slow response can never roll the ledger back in time.
   */
  function syncLedger(itemId, levels, source, readAt = now()) {
    return transaction(db, () => {
      if (hasPending(itemId)) return { skipped: true, discrepancies: [] };
      const last = Math.max(0, ...q.stockRows.all(itemId).map((r) => r.synced_at));
      if (readAt < last) return { skipped: true, stale: true, discrepancies: [] };
      const found = [];
      const t = readAt;
      for (const code of codes) {
        const level = levels.find((l) => codeByLocation.get(l.locationId) === code);
        const shopifyQty = level ? level.available : 0; // not stocked at that warehouse = 0
        const prev = q.stockRow.get(itemId, code);
        if (prev && prev.available !== shopifyQty) {
          q.addDiscrepancy.run(itemId, code, prev.available, shopifyQty, source, t);
          found.push({ warehouse: code, ledger: prev.available, shopify: shopifyQty });
        }
        q.upsertStock.run(itemId, code, shopifyQty, t);
      }
      if (found.length && source === 'reconcile') logger?.warn('inventory.discrepancy', { itemId, found });
      return { skipped: false, discrepancies: found };
    });
  }

  function ledger(itemId) {
    const out = Object.fromEntries(codes.map((c) => [c, 0]));
    for (const r of q.stockRows.all(itemId)) out[r.warehouse] = r.available;
    return out;
  }

  /**
   * Variant + ledger, refreshed from Shopify at most every `cacheMs`. If Shopify is down we fall back to
   * the ledger when it was synced recently enough (flagged source: 'cache'), otherwise 503.
   */
  /**
   * `fresh` bypasses the cache (order allocation needs Shopify's post-order numbers). The result's
   * `ledgerSynced` says whether the ledger now mirrors Shopify as of this read — false when served from
   * cache or when the sync was skipped because writes for the item are still in flight.
   */
  async function getVariant(variantGid, { fresh = false } = {}) {
    const hit = cache.get(variantGid);
    if (!fresh && hit && now() - hit.at < cacheMs) return { ...hit.variant, source: 'live', ledgerSynced: false };
    try {
      const readAt = now();
      const v = await shopify.getVariantInventory(variantGid);
      if (!v) { cache.delete(variantGid); return null; }
      q.upsertVariant.run(variantGid, v.inventoryItemId, v.sku, v.title, v.tracked ? 1 : 0, now());
      const synced = v.tracked ? !syncLedger(v.inventoryItemId, v.levels, 'read', readAt).skipped : false;
      const variant = { variantId: variantGid, sku: v.sku, title: v.title, productTitle: v.productTitle, tracked: v.tracked, inventoryItemId: v.inventoryItemId };
      cache.set(variantGid, { at: now(), variant });
      return { ...variant, source: 'live', ledgerSynced: synced };
    } catch (err) {
      if (!(err instanceof ShopifyError)) throw err;
      const row = q.getVariant.get(variantGid);
      const rows = row ? q.stockRows.all(row.inventory_item_id) : [];
      const oldest = rows.length ? Math.min(...rows.map((r) => r.synced_at)) : 0;
      if (row && (!row.tracked || now() - oldest <= staleMaxMs)) {
        logger?.warn('inventory.serving_cached', { variantGid, error: err.message });
        return { variantId: variantGid, sku: row.sku, title: row.title, tracked: !!row.tracked, inventoryItemId: row.inventory_item_id, source: 'cache', syncedAt: oldest };
      }
      throw new AppError(503, 'INVENTORY_UNAVAILABLE', 'Inventory service is temporarily unavailable. Please retry shortly.', { upstream: err.code });
    }
  }

  /** Re-read many items from Shopify and sync them. Used by reconciliation and after outbox writes. */
  async function refreshItems(itemIds, source) {
    if (!itemIds.length) return [];
    const readAt = now();
    const levels = await shopify.getInventoryLevels(itemIds);
    const report = [];
    for (const [itemId, lv] of levels) report.push({ itemId, ...syncLedger(itemId, lv, source, readAt) });
    return report;
  }

  return {
    codes,
    locationFor: (code) => warehouseLocations[code],
    codeFor: (locationId) => codeByLocation.get(locationId),
    getVariant,
    ledger,
    syncLedger,
    refreshItems,
    hasPending,
    allItemIds: () => q.allItems.all().map((r) => r.inventory_item_id),
    invalidate: (variantGid) => (variantGid ? cache.delete(variantGid) : cache.clear()),
  };
}
