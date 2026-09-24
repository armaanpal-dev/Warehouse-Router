/**
 * Look up the three warehouse locations in Shopify by name and print the .env lines for them.
 * Uses the same SHOPIFY_MODE (token | cli) as the server.
 */
import { loadConfig } from '../src/config.js';
import { createGraphqlClient, tokenTransport, cliTransport } from '../src/shopify/graphql.js';
import { createShopifyService } from '../src/shopify/service.js';

const config = loadConfig(process.env, { requireLocations: false });
if (config.shopify.mode === 'mock') { console.error('Set SHOPIFY_MODE=token (or cli) first.'); process.exit(1); }
const transport = config.shopify.mode === 'token' ? tokenTransport(config.shopify) : cliTransport(config.shopify);
const shopify = createShopifyService(createGraphqlClient(transport));

const NAMES = { DEL: /delhi/i, BLR: /bengaluru|bangalore/i, BOM: /mumbai/i };
const locations = await shopify.listLocations();
for (const [code, re] of Object.entries(NAMES)) {
  const hit = locations.find((l) => re.test(l.name) && l.isActive);
  console.log(hit ? `WAREHOUSE_${code}_LOCATION_ID=${hit.id}   # ${hit.name}` : `# ${code}: no active location matching ${re}`);
}
