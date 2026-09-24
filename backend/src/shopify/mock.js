import { ShopifyError } from '../errors.js';

/**
 * In-memory stand-in for Shopify implementing the same interface as shopify/service.js.
 * It behaves like the parts of Shopify we depend on:
 *   - an order commits stock at the location Shopify's own routing picks (the first location, in
 *     priority order, that can ship every line), and checkout refuses to oversell in total;
 *   - moving a fulfillment order moves that commitment between locations;
 *   - cancelling an unfulfilled order releases the commitment.
 * Tests can inject failures with failNext().
 */

export const MOCK_LOCATIONS = {
  DEL: 'gid://shopify/Location/9000001',
  BLR: 'gid://shopify/Location/9000002',
  BOM: 'gid://shopify/Location/9000003',
};

// Precise Milk Cooler demo matrix: Color x Size, stock per warehouse [DEL, BLR, BOM].
export const MOCK_CATALOGUE = [
  { variant: '46001', sku: 'MC16-SLV-08', title: 'Silver / 8 Ltr', stock: [5, 3, 4] },
  { variant: '46002', sku: 'MC16-SLV-12', title: 'Silver / 12 Ltr', stock: [2, 0, 6] },
  { variant: '46003', sku: 'MC16-SLV-18', title: 'Silver / 18 Ltr', stock: [0, 1, 0] },
  { variant: '46004', sku: 'MC16-BLK-08', title: 'Black / 8 Ltr', stock: [4, 0, 0] },
  { variant: '46005', sku: 'MC16-BLK-12', title: 'Black / 12 Ltr', stock: [0, 0, 0] },
  { variant: '46006', sku: 'MC16-BLK-18', title: 'Black / 18 Ltr', stock: [3, 2, 2] },
  { variant: '46007', sku: 'MC16-WHT-08', title: 'White / 8 Ltr', stock: [0, 5, 0] },
  { variant: '46008', sku: 'MC16-WHT-12', title: 'White / 12 Ltr', stock: [1, 1, 1] },
];

const ROUTING_PRIORITY = ['DEL', 'BOM', 'BLR']; // Shopify's location priority in this fake store

export function createMockShopify({ catalogue = MOCK_CATALOGUE, latencyMs = 0 } = {}) {
  const variants = new Map();
  const levels = new Map(); // itemId -> Map(locationId -> available)
  const orders = new Map(); // orderGid -> { fos: [...], cancelled }
  const tags = new Map();
  const failures = [];
  let nextId = 5000;
  const calls = [];

  for (const c of catalogue) {
    const variantId = `gid://shopify/ProductVariant/${c.variant}`;
    const itemId = `gid://shopify/InventoryItem/${c.variant}9`;
    variants.set(variantId, { ...c, variantId, itemId, tracked: c.tracked ?? true });
    levels.set(itemId, new Map(Object.keys(MOCK_LOCATIONS).map((code, i) => [MOCK_LOCATIONS[code], c.stock[i]])));
  }

  const sleep = () => (latencyMs ? new Promise((r) => setTimeout(r, latencyMs)) : Promise.resolve());
  async function gate(method) {
    calls.push(method);
    await sleep();
    const i = failures.findIndex((f) => f.method === method || f.method === '*');
    if (i >= 0) {
      const f = failures[i];
      if (--f.times <= 0) failures.splice(i, 1);
      throw f.error;
    }
  }
  const levelList = (itemId) => [...levels.get(itemId)].map(([locationId, available]) => ({ locationId, available }));
  const adjust = (itemId, loc, delta) => levels.get(itemId).set(loc, levels.get(itemId).get(loc) + delta);

  return {
    mode: 'mock',
    calls,

    /** Make the next `times` calls to `method` ('*' = any) throw. Defaults to a retryable outage. */
    failNext(method, times = 1, error = new ShopifyError('Mock Shopify outage', { retryable: true, code: 'UPSTREAM_5XX' })) {
      failures.push({ method, times, error });
    },

    async listLocations() {
      await gate('listLocations');
      return Object.entries(MOCK_LOCATIONS).map(([code, id]) => ({ id, name: `${code} (mock)`, isActive: true, fulfillsOnlineOrders: true }));
    },

    async getVariantInventory(variantGid) {
      await gate('getVariantInventory');
      const v = variants.get(variantGid);
      if (!v) return null;
      return {
        variantId: v.variantId, sku: v.sku, title: v.title, productTitle: 'Precise - Milk Cooler',
        tracked: v.tracked, inventoryPolicy: 'DENY', inventoryItemId: v.itemId, levels: levelList(v.itemId),
      };
    },

    async getInventoryLevels(itemIds) {
      await gate('getInventoryLevels');
      return new Map(itemIds.filter((id) => levels.has(id)).map((id) => [id, levelList(id)]));
    },

    async getFulfillmentOrders(orderGid) {
      await gate('getFulfillmentOrders');
      const o = orders.get(orderGid);
      return o ? structuredClone(o.fos) : null;
    },

    async moveFulfillmentOrder(foId, newLocationId, lineItems) {
      await gate('moveFulfillmentOrder');
      for (const o of orders.values()) {
        const fo = o.fos.find((f) => f.id === foId);
        if (!fo) continue;
        const moving = lineItems ?? fo.lineItems.map((l) => ({ id: l.id, quantity: l.remainingQuantity }));
        const newFo = { id: `gid://shopify/FulfillmentOrder/${nextId++}`, status: 'OPEN', locationId: newLocationId, lineItems: [] };
        for (const { id, quantity } of moving) {
          const li = fo.lineItems.find((l) => l.id === id);
          if (!li || quantity > li.remainingQuantity) throw new ShopifyError('fulfillmentOrderMove: invalid line item quantity');
          li.remainingQuantity -= quantity;
          newFo.lineItems.push({ id: `gid://shopify/FulfillmentOrderLineItem/${nextId++}`, lineItemId: li.lineItemId, remainingQuantity: quantity, itemId: li.itemId });
          adjust(li.itemId, fo.locationId, quantity);
          adjust(li.itemId, newLocationId, -quantity);
        }
        fo.lineItems = fo.lineItems.filter((l) => l.remainingQuantity > 0);
        if (!fo.lineItems.length) fo.status = 'CLOSED';
        o.fos.push(newFo);
        return { id: newFo.id };
      }
      throw new ShopifyError('fulfillmentOrderMove: fulfillment order not found');
    },

    async listOrdersSince(sinceIso) {
      await gate('listOrdersSince');
      const since = Date.parse(sinceIso);
      return [...orders.values()].map((o) => structuredClone(o.payload)).filter((p) => Date.parse(p.created_at) >= since);
    },

    async addOrderTags(orderGid, newTags) {
      await gate('addOrderTags');
      tags.set(orderGid, [...new Set([...(tags.get(orderGid) || []), ...newTags])]);
    },

    /* ---------- Test / dev helpers: act like a shopper checking out in Shopify ---------- */

    /** Create an order the way Shopify would and return the orders/create webhook payload. */
    createOrder({ pincode, lines, name }) {
      const resolved = lines.map((l) => {
        const v = variants.get(`gid://shopify/ProductVariant/${l.variant_id}`);
        if (!v) throw new Error(`Unknown mock variant ${l.variant_id}`);
        return { ...l, v };
      });
      for (const l of resolved) {
        const total = [...levels.get(l.v.itemId).values()].reduce((a, b) => a + Math.max(0, b), 0);
        if (l.v.tracked && total < l.quantity) throw new Error(`Checkout refused: only ${total} of ${l.v.sku} left`);
      }
      const orderNum = nextId++;
      const orderGid = `gid://shopify/Order/${orderNum}`;
      const lineItems = resolved.map((l) => ({ id: nextId++, variant_id: Number(l.variant_id), quantity: l.quantity, sku: l.v.sku, title: l.v.title, fulfillable_quantity: l.quantity, fulfillment_status: null, requires_shipping: true, itemId: l.v.itemId }));
      // Like Shopify: one location that can ship everything if there is one, otherwise split each line
      // across locations in priority order. Stock is committed at checkout, before any webhook.
      const at = (itemId, c) => levels.get(itemId).get(MOCK_LOCATIONS[c]) ?? 0;
      const single = ROUTING_PRIORITY.find((c) => lineItems.every((li) => at(li.itemId, c) >= li.quantity));
      const fosByLoc = new Map();
      const assign = (code, li, qty) => {
        const loc = MOCK_LOCATIONS[code];
        if (!fosByLoc.has(loc)) fosByLoc.set(loc, { id: `gid://shopify/FulfillmentOrder/${nextId++}`, status: 'OPEN', locationId: loc, lineItems: [] });
        fosByLoc.get(loc).lineItems.push({ id: `gid://shopify/FulfillmentOrderLineItem/${nextId++}`, lineItemId: `gid://shopify/LineItem/${li.id}`, remainingQuantity: qty, itemId: li.itemId });
        adjust(li.itemId, loc, -qty);
      };
      for (const li of lineItems) {
        if (single) { assign(single, li, li.quantity); continue; }
        let left = li.quantity;
        for (const c of ROUTING_PRIORITY) {
          const take = Math.min(left, Math.max(0, at(li.itemId, c)));
          if (take > 0) { assign(c, li, take); left -= take; }
          if (!left) break;
        }
      }
      const payload = {
        id: orderNum,
        admin_graphql_api_id: orderGid,
        name: name || `#MOCK${orderNum}`,
        created_at: new Date().toISOString(),
        cancelled_at: null,
        shipping_address: { zip: pincode, country_code: 'IN' },
        note_attributes: [],
        line_items: lineItems.map(({ itemId, ...li }) => li),
      };
      orders.set(orderGid, { fos: [...fosByLoc.values()], cancelled: false, payload });
      return structuredClone(payload);
    },

    /** Cancel an order the way Shopify would and return the orders/cancelled webhook payload. */
    cancelOrder(payload) {
      const o = orders.get(payload.admin_graphql_api_id);
      const cancelledAt = new Date().toISOString();
      if (o && !o.cancelled) {
        o.cancelled = true;
        o.payload.cancelled_at = cancelledAt;
        for (const fo of o.fos) for (const li of fo.lineItems) adjust(li.itemId, fo.locationId, li.remainingQuantity);
      }
      return { ...payload, cancelled_at: cancelledAt, cancel_reason: 'customer' };
    },

    /** Physical stock change outside this service (a stock count, a return) — for discrepancy tests. */
    setAvailable(variantId, code, qty) {
      const v = variants.get(`gid://shopify/ProductVariant/${variantId}`);
      levels.get(v.itemId).set(MOCK_LOCATIONS[code], qty);
    },
    getAvailable(variantId, code) {
      const v = variants.get(`gid://shopify/ProductVariant/${variantId}`);
      return levels.get(v.itemId).get(MOCK_LOCATIONS[code]);
    },
    getTags: (orderGid) => tags.get(orderGid) || [],
  };
}
