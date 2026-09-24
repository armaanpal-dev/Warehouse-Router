// Add N units (default 2) of every milk-cooler variant at each warehouse. Usage: node add-stock.js [delta]
const fs = require('fs');
const path = require('path');
const { gql } = require('./gql');

const DELTA = Number(process.argv[2] || 2);
const LOC = JSON.parse(fs.readFileSync(path.join(__dirname, 'locations.json'), 'utf8'));
const tmp = (n, b) => { const p = path.join(__dirname, '.tmp-' + n); fs.writeFileSync(p, typeof b === 'string' ? b : JSON.stringify(b)); return p; };

const product = gql(tmp('q.graphql', `{ productByIdentifier(identifier: { handle: "precise-milk-cooler" }) {
  variants(first: 50) { nodes { title inventoryItem { id inventoryLevels(first: 20) { nodes { location { id } quantities(names: ["available"]) { quantity } } } } } } } }`)).productByIdentifier;

const changes = product.variants.nodes.flatMap((v) =>
  Object.values(LOC).map((locationId) => {
    const level = v.inventoryItem.inventoryLevels.nodes.find((l) => l.location.id === locationId);
    // changeFromQuantity: compare-and-set. If someone else changed the level since we read it, Shopify rejects the change.
    return { inventoryItemId: v.inventoryItem.id, locationId, delta: DELTA, changeFromQuantity: level ? level.quantities[0].quantity : 0 };
  }));

const r = gql(tmp('m.graphql', `mutation($input: InventoryAdjustQuantitiesInput!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: "${require('crypto').randomUUID()}") { inventoryAdjustmentGroup { reason } userErrors { field message } } }`),
  tmp('v.json', { input: { name: 'available', reason: 'correction', referenceDocumentUri: 'logistics://assessment/restock-2026-09-24', changes } }), true);
if (r.inventoryAdjustQuantities.userErrors.length) throw new Error(JSON.stringify(r.inventoryAdjustQuantities.userErrors));
console.log(`Added ${DELTA} to ${changes.length} inventory levels (${product.variants.nodes.length} variants x ${Object.keys(LOC).length} warehouses)`);
for (const f of ['q.graphql', 'm.graphql', 'v.json']) fs.rmSync(path.join(__dirname, '.tmp-' + f), { force: true });
