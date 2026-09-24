import crypto from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApp, createContext } from '../src/app.js';
import { createMockShopify } from '../src/shopify/mock.js';

export const SECRET = 'test-webhook-secret-0123456789';
export const SHOP = 'test-shop.myshopify.com';
export const ADMIN_KEY = 'test-admin-key-0123456789';

export function testConfig(overrides = {}) {
  return {
    port: 0, env: 'test', logLevel: 'silent',
    shopify: { mode: 'mock', shop: SHOP, apiVersion: '2026-07', adminToken: '', apiSecret: SECRET },
    warehouseLocations: {},
    adminApiKey: ADMIN_KEY,
    corsOrigins: ['https://test-shop.myshopify.com'],
    databasePath: ':memory:',
    inventoryCacheMs: 0, // always read through to (mock) Shopify unless a test says otherwise
    staleMaxMs: 300_000,
    reconcileIntervalMs: 999_999,
    rateLimitPerMinute: 1000,
    ...overrides,
  };
}

/** Boot the real app on an ephemeral port with an in-memory DB and a fresh mock Shopify. */
export async function startApp(overrides = {}, { mockOptions } = {}) {
  const config = testConfig(overrides);
  const shopify = createMockShopify(mockOptions);
  const ctx = createContext(config, { shopify, db: openDatabase(':memory:') });
  const app = createApp(ctx);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ctx, shopify, base,
    close: async () => { await ctx.outbox.stop(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); ctx.db.close(); },
    post: (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    get: (path, headers = {}) => fetch(base + path, { headers }),
  };
}

export function signedWebhook(payload, { topic, webhookId = crypto.randomUUID(), shop = SHOP, secret = SECRET } = {}) {
  const body = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', secret).update(body).digest('base64');
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Topic': topic,
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Shop-Domain': shop,
      'X-Shopify-Webhook-Id': webhookId,
    },
  };
}

export async function waitFor(fn, { timeout = 3000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** A raw orders/create payload, bypassing the mock checkout (for concurrency tests). */
export function orderPayload(id, { pincode = '560001', lines }) {
  return {
    id, admin_graphql_api_id: `gid://shopify/Order/${id}`, name: `#T${id}`, cancelled_at: null,
    shipping_address: { zip: pincode },
    line_items: lines.map((l, i) => ({ id: id * 100 + i, variant_id: Number(l.variant_id), quantity: l.quantity, fulfillable_quantity: l.quantity, requires_shipping: true, fulfillment_status: null })),
  };
}
