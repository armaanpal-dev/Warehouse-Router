// 2026-09-24: give every milk-cooler variant its own price, and zero Black / 12 Ltr at every warehouse.
const fs = require('fs');
const path = require('path');
const { gql } = require('./gql');

const PRODUCT = 'gid://shopify/Product/7663752806482';
const PRICES = {
  'Silver / 8 Ltr': '2450.00', 'Silver / 12 Ltr': '2990.00', 'Silver / 18 Ltr': '3590.00',
  'Black / 8 Ltr': '2599.00', 'Black / 12 Ltr': '3199.00', 'Black / 18 Ltr': '3799.00',
  'White / 8 Ltr': '2499.00', 'White / 12 Ltr': '3099.00',
};
const ZERO = 'Black / 12 Ltr';
const tmp = (n, b) => { const p = path.join(__dirname, '.tmp-' + n); fs.writeFileSync(p, typeof b === 'string' ? b : JSON.stringify(b)); return p; };

const product = gql(tmp('q.graphql', `{ product(id: "${PRODUCT}") { status variants(first: 50) { nodes { id title price
  inventoryItem { id inventoryLevels(first: 20) { nodes { location { id } quantities(names: ["available"]) { quantity } } } } } } } }`)).product;

// Prices
const variants = product.variants.nodes.map((v) => {
  if (!PRICES[v.title]) throw new Error('No price for ' + v.title);
  return { id: v.id, price: PRICES[v.title] };
});
const p = gql(tmp('m1.graphql', `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { title price } userErrors { field message } } }`),
  tmp('v1.json', { productId: PRODUCT, variants }), true).productVariantsBulkUpdate;
if (p.userErrors.length) throw new Error(JSON.stringify(p.userErrors));
console.log('Prices:', p.productVariants.map((v) => `${v.title}=${v.price}`).join(', '));

// Zero the one Black variant (compare-and-set against what we just read)
const target = product.variants.nodes.find((v) => v.title === ZERO);
const changes = target.inventoryItem.inventoryLevels.nodes
  .map((l) => ({ inventoryItemId: target.inventoryItem.id, locationId: l.location.id, delta: -l.quantities[0].quantity, changeFromQuantity: l.quantities[0].quantity }))
  .filter((c) => c.delta !== 0);
if (changes.length) {
  const r = gql(tmp('m2.graphql', `mutation($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: "${require('crypto').randomUUID()}") { inventoryAdjustmentGroup { reason } userErrors { field message } } }`),
    tmp('v2.json', { input: { name: 'available', reason: 'correction', referenceDocumentUri: 'logistics://assessment/zero-black-12-2026-09-24', changes } }), true).inventoryAdjustQuantities;
  if (r.userErrors.length) throw new Error(JSON.stringify(r.userErrors));
}
console.log(`${ZERO}: zeroed ${changes.length} inventory levels`);
for (const f of ['q.graphql', 'm1.graphql', 'v1.json', 'm2.graphql', 'v2.json']) fs.rmSync(path.join(__dirname, '.tmp-' + f), { force: true });
