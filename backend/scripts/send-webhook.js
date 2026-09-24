/**
 * Send a correctly signed Shopify webhook to the running API — for demos and local testing.
 *
 *   node scripts/send-webhook.js create <variant_id> <qty> <pincode>   (mock mode: creates the order in the
 *                                                                       fake Shopify first, like a real checkout)
 *   node scripts/send-webhook.js cancel <order-json-file>
 *   node scripts/send-webhook.js replay <order-json-file> [topic]      (re-send, to show duplicate handling)
 *   node scripts/send-webhook.js raw <topic> <payload-json-file>
 *
 * Reads PORT, SHOPIFY_SHOP and SHOPIFY_API_SECRET from .env.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;
const SHOP = process.env.SHOPIFY_SHOP;
const SECRET = process.env.SHOPIFY_API_SECRET;

async function sendWebhook(topic, payload, webhookId = crypto.randomUUID()) {
  const body = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', SECRET).update(body).digest('base64');
  const res = await fetch(`${BASE}/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': topic, 'X-Shopify-Hmac-Sha256': hmac, 'X-Shopify-Shop-Domain': SHOP, 'X-Shopify-Webhook-Id': webhookId },
    body,
  });
  console.log(`POST /webhooks (${topic}, id ${webhookId}) -> ${res.status}`, await res.text());
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'create') {
  const [variant_id, qty, pincode] = args;
  const res = await fetch(`${BASE}/__mock/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pincode, lines: [{ variant_id, quantity: Number(qty) }] }) });
  if (!res.ok) { console.error('Mock checkout failed:', res.status, await res.text()); process.exit(1); }
  const order = await res.json();
  const file = `data/order-${order.id}.json`;
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(file, JSON.stringify(order, null, 2));
  console.log(`Created mock order ${order.name} (saved to ${file})`);
  await sendWebhook('orders/create', order);
} else if (cmd === 'cancel') {
  const order = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  const res = await fetch(`${BASE}/__mock/orders/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order) });
  await sendWebhook('orders/cancelled', res.ok ? await res.json() : { ...order, cancelled_at: new Date().toISOString() });
} else if (cmd === 'replay') {
  await sendWebhook(args[1] || 'orders/create', JSON.parse(fs.readFileSync(args[0], 'utf8')), 'replayed-' + crypto.randomUUID());
} else if (cmd === 'raw') {
  await sendWebhook(args[0], JSON.parse(fs.readFileSync(args[1], 'utf8')));
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
}
