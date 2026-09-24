/**
 * Point the app's orders/create and orders/cancelled webhooks at <public-url>/webhooks.
 * Idempotent: keeps a matching subscription, replaces ones that point at an old URL (e.g. a previous tunnel).
 *
 *   node scripts/register-webhooks.js https://<public-host>
 *   node scripts/register-webhooks.js --list
 */
import { loadConfig } from '../src/config.js';
import { createGraphqlClient, tokenTransport } from '../src/shopify/graphql.js';

const config = loadConfig();
if (config.shopify.mode !== 'token') { console.error('Needs SHOPIFY_MODE=token (webhooks belong to the app).'); process.exit(1); }
const request = createGraphqlClient(tokenTransport(config.shopify));
const TOPICS = ['ORDERS_CREATE', 'ORDERS_CANCELLED'];

const list = async () => (await request(`{ webhookSubscriptions(first: 50) { nodes { id topic uri } } }`)).webhookSubscriptions.nodes;

const arg = process.argv[2];
if (!arg || arg === '--list') {
  console.table(await list());
  process.exit(0);
}
const uri = `${arg.replace(/\/+$/, '')}/webhooks`;
if (!uri.startsWith('https://')) { console.error('The callback URL must be https.'); process.exit(1); }

const existing = await list();
for (const topic of TOPICS) {
  const mine = existing.filter((s) => s.topic === topic);
  if (mine.some((s) => s.uri === uri)) { console.log(`ok       ${topic} -> ${uri}`); continue; }
  for (const old of mine) {
    const d = await request(`mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { userErrors { message } } }`, { id: old.id });
    console.log(`removed  ${topic} -> ${old.uri}`, d.webhookSubscriptionDelete.userErrors);
  }
  const r = await request(
    `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id uri } userErrors { field message } }
    }`,
    { topic, sub: { uri, format: 'JSON' } },
  );
  const res = r.webhookSubscriptionCreate;
  if (res.userErrors.length) { console.error(`FAILED   ${topic}`, res.userErrors); process.exitCode = 1; }
  else console.log(`created  ${topic} -> ${res.webhookSubscription.uri}`);
}
