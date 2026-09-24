// Creates the demo "Precise - Milk Cooler" product with Color x Size variants and per-warehouse stock.
// Idempotent on handle: refuses to run if the product already exists.
const fs = require('fs');
const path = require('path');
const { gql } = require('./gql');

const HANDLE = 'precise-milk-cooler';
const SOURCE = 'https://brewinggadgets.com/products/precise-milk-cooler-8-ltr.js';
const ONLINE_STORE = 'gid://shopify/Publication/92317745234';
const LOC = JSON.parse(fs.readFileSync(path.join(__dirname, 'locations.json'), 'utf8'));

// Every variant has its own price, so a colour change moves the price as well as a size change (repriced 2026-09-24).
const PRICES = {
  'Silver / 8 Ltr': '2450.00', 'Silver / 12 Ltr': '2990.00', 'Silver / 18 Ltr': '3590.00',
  'Black / 8 Ltr': '2599.00', 'Black / 12 Ltr': '3199.00', 'Black / 18 Ltr': '3799.00',
  'White / 8 Ltr': '2499.00', 'White / 12 Ltr': '3099.00',
};
// [color, size, DEL, BLR, BOM] — matches backend/src/shopify/mock.js so both demos tell the same story.
const MATRIX = [
  ['Silver', '8 Ltr', 5, 3, 4], ['Silver', '12 Ltr', 2, 0, 6], ['Silver', '18 Ltr', 0, 1, 0],
  ['Black', '8 Ltr', 4, 0, 0], ['Black', '12 Ltr', 0, 0, 0], ['Black', '18 Ltr', 3, 2, 2],
  ['White', '8 Ltr', 0, 5, 0], ['White', '12 Ltr', 1, 1, 1],
  // White / 18 Ltr deliberately not created: demonstrates a combination that doesn't exist.
];
const SKU = (c, s) => `MC16-${{ Silver: 'SLV', Black: 'BLK', White: 'WHT' }[c]}-${s.replace(' Ltr', '').padStart(2, '0')}`;

const tmp = (name, body) => { const p = path.join(__dirname, '.tmp-' + name); fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body)); return p; };

(async () => {
  const exists = gql(tmp('q.graphql', `{ productByIdentifier(identifier: { handle: "${HANDLE}" }) { id } }`)).productByIdentifier;
  if (exists) { console.log('Product already exists:', exists.id); return; }

  const src = await (await fetch(SOURCE)).json();
  // The supplier description is pasted from Word; keep only the "Label: value" facts as a clean list.
  const facts = [...src.description.matchAll(/<b>([^<]+?):?<\/b>\s*([^<]+)/g)].map((m) => [m[1].replace(/:$/, '').trim(), m[2].trim()]);
  const descriptionHtml = '<ul>' + facts.map(([k, v]) => `<li><strong>${k}:</strong> ${v}</li>`).join('') + '</ul>';
  const image = 'https:' + src.images[0].split('?')[0];

  const created = gql(tmp('m.graphql', `mutation($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) { product { id handle } userErrors { field message } } }`),
    tmp('v.json', {
      product: {
        title: 'Precise - Milk Cooler', handle: HANDLE, vendor: 'Precise', productType: 'Milk Coolers',
        status: 'ACTIVE', templateSuffix: 'custom', descriptionHtml,
        productOptions: [
          { name: 'Color', values: ['Silver', 'Black', 'White'].map((name) => ({ name })) },
          { name: 'Size', values: ['8 Ltr', '12 Ltr', '18 Ltr'].map((name) => ({ name })) },
        ],
      },
      media: [{ originalSource: image, mediaContentType: 'IMAGE', alt: 'Precise milk cooler' }],
    }), true).productCreate;
  if (created.userErrors.length) throw new Error(JSON.stringify(created.userErrors));
  const productId = created.product.id;
  console.log('created product', productId);

  const variants = MATRIX.map(([color, size, del, blr, bom]) => ({
    optionValues: [{ optionName: 'Color', name: color }, { optionName: 'Size', name: size }],
    price: PRICES[`${color} / ${size}`],
    inventoryPolicy: 'DENY',
    inventoryItem: { sku: SKU(color, size), tracked: true, requiresShipping: true },
    inventoryQuantities: [
      { locationId: LOC.DEL, availableQuantity: del },
      { locationId: LOC.BLR, availableQuantity: blr },
      { locationId: LOC.BOM, availableQuantity: bom },
    ],
  }));
  const bulk = gql(tmp('m.graphql', `mutation($id: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $id, variants: $variants, strategy: REMOVE_STANDALONE_VARIANT) {
        productVariants { id title sku } userErrors { field message } } }`),
    tmp('v.json', { id: productId, variants }), true).productVariantsBulkCreate;
  if (bulk.userErrors.length) throw new Error(JSON.stringify(bulk.userErrors));
  for (const v of bulk.productVariants) console.log('  variant', v.id.split('/').pop(), v.title, v.sku);

  const pub = gql(tmp('m.graphql', `mutation($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { field message } } }`),
    tmp('v.json', { id: productId, input: [{ publicationId: ONLINE_STORE }] }), true).publishablePublish;
  if (pub.userErrors.length) throw new Error(JSON.stringify(pub.userErrors));
  console.log('published to Online Store');

  fs.writeFileSync(path.join(__dirname, 'product.json'), JSON.stringify({ productId, variants: bulk.productVariants }, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
