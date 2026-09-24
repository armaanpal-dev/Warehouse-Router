# Warehouse availability API (Task 2)

Pincode-based inventory allocation across three warehouses (Delhi, Bengaluru, Mumbai) for a Shopify store.
It answers "can this pincode get this quantity, and how fast?", allocates stock when an order is placed,
routes the order to the right warehouse in Shopify, and releases stock on cancellation.

- Node 22.13+ (uses the built-in `node:sqlite`), Express 5. One runtime dependency.
- **Live:** connected to the dev store `another-shpyfy-store.myshopify.com` through a Dev Dashboard app
  ("Warehouse Router"), receiving real `orders/create` and `orders/cancelled` webhooks from checkout.
  See [Live results](#live-results-real-checkout-orders).
- Also runs with **no Shopify at all** in `mock` mode, a documented in-memory Shopify that the tests use.

| `SHOPIFY_MODE` | Talks to | Use |
|---|---|---|
| `mock` (default) | In-memory fake Shopify (`src/shopify/mock.js`) | Tests, local demo, reviewers without a store |
| `token` | Admin GraphQL API over HTTPS with the app's token | Production / the live demo |
| `cli` | `shopify store execute` using your Shopify CLI login | Dev only, for reading a store without an app |

## Setup

### Quick start (mock mode, no Shopify needed)

```bash
cd backend
npm install
cp .env.example .env          # set SHOPIFY_API_SECRET and ADMIN_API_KEY to long random strings
npm test                      # 30 tests: routing, availability, webhooks, concurrency, failures, regressions
npm start                     # http://127.0.0.1:3000 (PORT in .env)
```

### Against a real store (how the live demo is set up)

**1. Create the app** (dev.shopify.com → Apps → Create app). Custom apps can no longer be created in the
store admin (*Develop apps*) since January 2026, so use the Dev Dashboard.
- Create a version with these access scopes, then **Release** it:
  `read_products, read_inventory, read_locations, read_orders, write_orders,
  read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders`
- **Protected customer data access** → tick **Store management** → Save. Without this, Shopify refuses
  order webhooks with *"This app is not approved to subscribe to webhook topics containing protected
  customer data"*. Custom apps don't need review; it applies immediately.
- **Install** the app on the store. You don't need to choose a distribution for a store in your own organisation.

**2. Configure `.env`:**
```ini
SHOPIFY_MODE=token
SHOPIFY_SHOP=your-store.myshopify.com
SHOPIFY_CLIENT_ID=<app client id>
SHOPIFY_API_SECRET=<app client secret>   # also verifies webhook HMACs
SHOPIFY_ADMIN_TOKEN=                     # leave blank: the server fetches and renews a token itself
```
The server gets its access token with the **client credentials grant** (`POST /admin/oauth/access_token`),
caches it, refreshes it 5 minutes before expiry, and retries once with a new token on a 401.
If the grant returns `app_not_installed`, the app isn't installed on the store yet.

**3. Set up the warehouses in Shopify.**
- Create three locations whose names contain *Delhi*, *Bengaluru* and *Mumbai*.
- Run `npm run sync-locations` and paste the three `WAREHOUSE_*_LOCATION_ID` lines it prints into `.env`.
- **Add all three as shipping origins** (Settings → Shipping and delivery → General profile → origins).
  Otherwise checkout reports stocked items as **"Sold out"**, because no location that holds them can ship.

**4. Expose the server and register the webhooks:**
```bash
npm start
ngrok http 3000                                                    # or any HTTPS tunnel / host
node scripts/register-webhooks.js https://<your-public-host>       # idempotent; replaces old URLs
node scripts/register-webhooks.js --list
```
Re-run `register-webhooks.js` whenever the public URL changes (e.g. a new ngrok session).

**Hosting.** Any always-on Node host with a persistent disk works (Render, Railway, Fly.io, a VM). Serverless
platforms such as Vercel are **not** suitable: the retry sweeper, outbox worker and reconciler are
background loops, and the SQLite ledger needs a disk that persists.

`SHOPIFY_MODE=cli` is a dev-only shortcut: it can read a real store without an app, but webhooks can't be
real in that mode, so post signed test webhooks with `scripts/send-webhook.js`.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/express-availability` | CORS allow-list + rate limit | Availability for a variant, quantity and pincode |
| POST | `/proxy/express-availability` | Shopify App Proxy signature | The same endpoint, served to the storefront via an app proxy |
| POST | `/webhooks` | `X-Shopify-Hmac-Sha256` | `orders/create`, `orders/cancelled` |
| GET | `/api/admin/orders/:id` | `X-Api-Key` | The allocation recorded for an order |
| GET | `/api/admin/stock/:variantId` | `X-Api-Key` | The ledger per warehouse for a variant, and whether a Shopify write is still in flight |
| POST | `/api/admin/reconcile` | `X-Api-Key` | Compare every tracked item with Shopify now |
| POST | `/api/admin/catch-up` | `X-Api-Key` | Allocate and tag any order from the last 72 h whose webhook never arrived |
| GET | `/api/admin/discrepancies` | `X-Api-Key` | Ledger-vs-Shopify differences found |
| GET | `/api/admin/outbox?status=dead` | `X-Api-Key` | Shopify writes that failed permanently |
| POST | `/api/admin/outbox/:id/retry` | `X-Api-Key` | Requeue a dead write |
| GET | `/api/admin/webhooks` | `X-Api-Key` | Recent webhook events and their status |
| GET | `/health` | none | Liveness and DB check |

## Sample requests and responses

These were captured from `npm start` in mock mode. The demo matrix is in `src/shopify/mock.js`:
Silver / 8 Ltr (`46001`) has DEL 5, BLR 3, BOM 4 units; Silver / 12 Ltr (`46002`) has DEL 2, BLR 0, BOM 6.

**The sample from the brief: 2 units to 560001 (Bengaluru) ship express from Bengaluru**

```http
POST /api/express-availability
Content-Type: application/json

{ "variant_id": "46001", "quantity": 2, "pincode": "560001" }
```
```json
HTTP 200
{
  "variant_id": "46001", "sku": "MC16-SLV-08", "quantity": 2, "pincode": "560001",
  "region": "South", "primary_warehouse": "BLR", "inventory_source": "live",
  "checked_at": "2026-09-24T06:57:41.862Z",
  "available": true,
  "express": true,
  "fulfillment": {
    "type": "single",
    "warehouse": { "code": "BLR", "name": "Bengaluru Warehouse", "city": "Bengaluru" },
    "is_primary_warehouse": true,
    "fallback_used": false,
    "allocations": [{ "warehouse": "BLR", "quantity": 2 }],
    "estimated_delivery_days": { "min": 1, "max": 1 }
  },
  "message": "Express delivery in 1 day from Bengaluru Warehouse."
}
```

**Primary short (BLR has 3, asked for 4): fallback to Mumbai, not express**

```json
{ "available": true, "express": false,
  "fulfillment": { "type": "single", "warehouse": { "code": "BOM", ... }, "fallback_used": true,
                   "allocations": [{ "warehouse": "BOM", "quantity": 4 }], "estimated_delivery_days": { "min": 4, "max": 6 } },
  "message": "Ships from Mumbai Warehouse; delivery in 4-6 days." }
```

**No single warehouse has enough: split shipment** (`46002`, 7 units to 110001)

```json
{ "available": true, "express": false,
  "fulfillment": { "type": "split", "warehouse": null,
                   "allocations": [{ "warehouse": "DEL", "quantity": 2 }, { "warehouse": "BOM", "quantity": 5 }],
                   "estimated_delivery_days": { "min": 4, "max": 6 } } }
```

**Not enough stock anywhere.** This is a valid answer, so it returns 200, not an error:

```json
{ "available": false, "express": false, "reason": "INSUFFICIENT_STOCK", "max_available_quantity": 8,
  "message": "Only 8 available for delivery to 110001." }
```

**Errors.** Every error has the same shape: `{ error: { code, message, details? }, request_id }`.

| Case | Status | `error.code` |
|---|---|---|
| Bad fields (`{"variant_id":"x","quantity":0,"pincode":"12"}`) | 400 | `VALIDATION_ERROR`, with one `details[]` entry per field |
| Body is not JSON | 400 | `INVALID_JSON` |
| Bad webhook HMAC / missing or wrong admin key / bad app-proxy signature | 401 | `UNAUTHORIZED` |
| Webhook from another shop | 403 | `UNKNOWN_SHOP` |
| Unknown variant | 404 | `VARIANT_NOT_FOUND` |
| Pincode outside every delivery region (e.g. 999999) | 422 | `PINCODE_NOT_SERVICEABLE` |
| Rate limit exceeded | 429 | `RATE_LIMITED` (with `Retry-After`) |
| Shopify rejected the request | 502 | `UPSTREAM_ERROR` |
| Shopify is unreachable and the ledger is stale | 503 | `INVENTORY_UNAVAILABLE` |

```json
HTTP 422
{ "error": { "code": "PINCODE_NOT_SERVICEABLE", "message": "We don't deliver to 999999 yet.", "details": { "pincode": "999999" } },
  "request_id": "b9198d5e-8db0-4392-9e49-953563812d76" }
```

**Against the real dev store** (live Admin API data from the three Shopify locations, 2026-09-24, with the
original demo stock before the later +2 restock):

| Request | Result |
|---|---|
| Silver / 8 Ltr (`42753591476306`) ×2 → 560001 | `express: true`, BLR, 1 day |
| Black / 8 Ltr (`42753591574610`) ×2 → 560001 (stock only in Delhi) | `fallback_used: true`, DEL, 4–6 days |
| Silver / 12 Ltr (`42753591509074`) ×7 → 110001 | `split`: DEL 2 + BOM 5 |
| Black / 12 Ltr (`42753591607378`) ×1 → 400001 | `available: false`, `OUT_OF_STOCK` |

In `token` mode each availability call takes about 0.5–1 s (a live Shopify read), or less when cached.

**Webhook flow in mock mode**, driven by `scripts/send-webhook.js`, which signs the payload exactly as Shopify does:

```text
$ node scripts/send-webhook.js create 46001 2 560001
Created mock order #MOCK5000
POST /webhooks (orders/create) -> 200 {"received":true,"duplicate":false,"status":"received"}

GET /api/admin/orders/5000   ->  status "allocated", allocations [{ warehouse: "BLR", quantity: 2, status: "allocated" }]
GET /api/admin/stock/46001   ->  ledger { DEL: 5, BLR: 1, BOM: 4 }

$ node scripts/send-webhook.js replay data/order-5000.json   # same order, new webhook id
-> 200, and the order is not allocated a second time

$ node scripts/send-webhook.js cancel data/order-5000.json
GET /api/admin/orders/5000   ->  status "cancelled", allocation status "released"
GET /api/admin/stock/46001   ->  ledger { DEL: 5, BLR: 3, BOM: 4 }
```

## Live results: real checkout orders

These orders were placed through the storefront checkout (test payment), delivered to the server by Shopify
webhooks, allocated, and written back to Shopify.

| Order | Items → pincode | Server decision | In Shopify admin |
|---|---|---|---|
| **#1006** | Silver / 8 Ltr ×1 → 110003 (Delhi) | Primary DEL has stock → `allocated`, DEL 1 | Ships from **Delhi Warehouse**, tag `warehouse-DEL` |
| **#1007** | Silver / 12 Ltr ×7 → 110003 (Delhi) | DEL has only 2 → **split** DEL 2 + BOM 5 | Fulfillment orders at **Delhi (2)** and **Mumbai (5)**, tags `warehouse-DEL`, `warehouse-BOM` |
| **#1008** | ×1 → 110003 (Delhi) | Placed while the server was down; **recovered by catch-up** on restart → DEL 1 | Tag `warehouse-DEL` |
| **#1009** | ×9 → 110003 (Delhi) | Placed while the server was down; recovered by catch-up → **split** DEL 3 + BOM 3 + BLR 3 | Tags `warehouse-DEL`, `warehouse-BOM`, `warehouse-BLR` |

**Missed webhooks, found by #1008 and #1009.** Both were placed while the server and tunnel were stopped,
so no webhook reached us and the orders had no warehouse tag. Shopify retries a failed delivery for a
while and then gives up, so waiting is not a fix. The server now runs a **catch-up** (`createCatchUp` in
`src/services/jobs.js`) on boot and every 5 minutes: it lists the last 72 hours of orders from Shopify
(`listOrdersSince` in `src/shopify/service.js`, mapped to the webhook payload shape) and sends any order it
has no record of through the same `allocate()`. A webhook that arrives at the same moment is harmless:
`allocate()` re-checks the order id inside its transaction. On restart it recovered #1008 and #1009 and
tagged both.

How to check an order yourself:
```bash
curl -H "X-Api-Key: $ADMIN_API_KEY" http://127.0.0.1:3000/api/admin/orders/<shopify order id>
curl -H "X-Api-Key: $ADMIN_API_KEY" http://127.0.0.1:3000/api/admin/webhooks
```

**A bug found by #1007, and the fix.** At first the server allocated only 1 of the 7 units and tagged the
order `allocation-review`. Shopify **commits an order's stock at checkout**, before the webhook is
sent. So when the server read "available", this order's own 7 units were already missing, and the order
was competing with itself. In the mock tests every warehouse had spare stock, so it never showed.

The fix (`src/services/orders.js`, `ownCommitments`): before allocating, the server reads the order's own
fulfillment orders to see where Shopify committed its units. It then counts those units as available *to
this order*, but only when the ledger is known to contain that commitment: synced from a Shopify read that
started after the webhook arrived, or safely after the order's `created_at`. A slow, older read can no
longer overwrite a newer one either (`syncLedger` drops reads that started before the last applied one).
In doubt it under-counts, never over-counts. Two regression tests reproduce the case, and #1007 was
re-processed to the correct split.

## How it works

### Pincode → warehouse

Indian pincodes encode geography in their leading digits. `src/warehouses.js` maps 2-digit prefix
ranges to a region, a **primary** warehouse, and a **fallback order** ranked by distance. For example
`56xxxx` (Karnataka) → BLR, then BOM, then DEL; `70xxxx` (Kolkata) → DEL, then BLR, then BOM. The
warehouse's own city (`110`, `560-562`, `400-401`) is "metro". Delivery estimates:

| Ships from | Days |
|---|---|
| Primary, metro pincode | 1 |
| Primary, rest of region | 2–3 |
| Any fallback warehouse | 4–6 |

`express: true` means the whole quantity ships from the primary warehouse. Pincodes outside every
range (e.g. `9xxxxx`, Army Post Office) get a 422.

### Allocation and fallback (`src/services/allocation.js`)

A pure function, used both for the availability answer and for real orders:

1. **Primary** warehouse has the full quantity → one parcel, express.
2. Otherwise the **first fallback**, in distance order, that has the full quantity → one parcel.
   One parcel from a fallback beats a split that includes the primary: the customer gets one delivery
   and the merchant pays for one shipping label.
3. Otherwise a **split** across warehouses in distance order.
4. Otherwise **insufficient**. The availability check answers `available: false`. For a real order,
   whatever can be allocated is allocated, the remainder is recorded as `unallocated`, and the order is
   tagged `allocation-review`.

Untracked variants (inventory not managed by Shopify) always ship from the primary warehouse.

### Overselling prevention

Shopify is the source of truth for physical stock. Shopify's checkout already refuses to oversell the
*total* across locations when the inventory policy is `DENY`. What it can't do is keep two concurrent
orders from both being routed to the *same warehouse* for its last unit. That's the job here.

- **The ledger** (`stock` table) holds sellable units per item per warehouse, synced from Shopify.
- **Atomic allocation.** An order is allocated inside one `BEGIN IMMEDIATE` SQLite transaction with no
  `await` in it, so no other allocation can run in between. Every decrement is conditional:
  `UPDATE stock SET available = available - ? WHERE … AND available >= ?`, so stock cannot go negative.
  Network calls happen *before* the transaction. Test: 8 simultaneous orders for 1 unit → exactly 1
  allocated. 20 orders against 12 units → exactly 12, filled BLR → BOM → DEL.
- **The sync rule.** After we allocate, our ledger is *ahead* of Shopify until the fulfillment-order move
  lands. Any item with a Shopify write still in the outbox (`pending_items`) is not overwritten by
  syncs, so the same unit can't be handed out twice in that window.
- **An order never competes with itself.** Shopify commits stock at checkout, so the order's own units
  are already gone from "available" when the webhook arrives. They're added back for that order only,
  and only when the ledger provably contains the commitment (see [Live results](#live-results-real-checkout-orders)).
- **Stale reads can't roll the ledger back.** Each sync records when its Shopify read *started*; a read
  that started earlier than the last applied one is dropped.
- **Where it errs, it errs safe.** In the rare cases where it can't be sure (e.g. the ledger is ahead of
  Shopify because another order's move is in flight), a unit may be counted as taken for a few seconds.
  That can undersell briefly; it can never oversell. The next sync removes the difference.
- **Shopify-side guards too.** Stock adjustments by the setup scripts use Shopify's compare-and-set
  (`changeFromQuantity`) plus an `@idempotent` key, so a concurrent change or a retried request can't
  apply twice.
- **Scaling out.** SQLite's write lock covers several processes on one host. For several hosts, move the
  ledger to Postgres: the same conditional `UPDATE` is atomic there, with `SELECT … FOR UPDATE` on the
  stock rows if you need them read first.

### Webhooks: duplicates, ordering and failures

- **Signature.** HMAC-SHA256 over the *raw* body (the route is mounted before `express.json()`),
  compared in constant time. `X-Shopify-Shop-Domain` must match the configured shop.
- **Fast acknowledgement.** The event is written to `webhook_events` and answered `200` straight away.
  Processing happens after the response, because Shopify retries anything slower than 5 s, and those
  retries would create duplicates.
- **Duplicates.** `webhook_id` is the primary key, so a redelivery is acknowledged and dropped. A second
  guard: `orders` is keyed by Shopify order id, so the same order under a *new* webhook id is still
  allocated only once.
- **Out-of-order delivery.** If `orders/cancelled` arrives before `orders/create`, we record a
  tombstone and the late create is ignored.
- **Failures.** If Shopify is down while an event is processed, the event is marked `failed` and a sweeper
  retries it with exponential backoff (up to 6 attempts). Events accepted just before a crash are picked
  up on boot.
- **Webhooks that never arrive** (server or tunnel down longer than Shopify keeps retrying): the catch-up
  job lists the last 72 h of orders from Shopify, on boot and every 5 minutes, and allocates any it has no
  record of. Window: `CATCHUP_WINDOW_MS`.
- **Cancellation** releases every unfulfilled allocation back to the warehouse it came from. Lines
  already `fulfilled` stay consumed; restocking those is a returns/refund concern. It also cancels any
  pending routing job, and queues a resync from Shopify, which releases its own commitment on cancel.

### Writing to Shopify: the outbox

The allocation transaction also writes **outbox** rows, so the ledger change and the intent to update
Shopify commit together or not at all. A worker then:

- `route_order`: moves each allocated quantity onto a fulfillment order at the chosen location
  (`fulfillmentOrderMove`), so the warehouse team sees it in their queue. It's safe to re-run: it first
  counts what's already at the target location and moves only the difference.
- `tag_order`: tags the order `warehouse-BLR` etc. (plus `allocation-review` when short).
- `resync_items`: re-reads levels after a cancel.

A failed write is retried with backoff (1 s, doubling, capped at 5 min). After 8 attempts, or on a
non-retryable error such as a missing scope, the job goes `dead`. It shows at
`/api/admin/outbox?status=dead` and can be requeued. A dead job also releases its hold on the ledger, so
Shopify becomes authoritative again.

### Shopify API failures and inventory discrepancies

- **Client** (`src/shopify/graphql.js`): 8 s timeout. It retries network errors, 5xx, HTTP 429
  (honouring `Retry-After`) and GraphQL `THROTTLED` (waiting exactly as long as the cost bucket needs to
  refill), with exponential backoff and jitter. It does not retry 4xx or access-denied errors.
- **Degraded reads.** Inventory reads are cached for 10 s. If Shopify is unreachable, the availability
  endpoint serves the ledger when it was synced within the last 5 minutes and says so
  (`"inventory_source": "cache"`). Otherwise it returns 503 rather than guessing.
- **Reconciliation** runs every 5 minutes (and on demand at `/api/admin/reconcile`). It compares every
  tracked item with Shopify and records each difference in `discrepancies`: POS sales, stock counts,
  manual adjustments. Shopify's number wins, except for items with writes in flight.

### Security

- Credentials live only in `.env`, which is git-ignored. Config is validated at boot, and production
  refuses short secrets. The access token is never stored; it's fetched at runtime from the client ID + secret.
- Least privilege: the app asks only for the scopes above, and for protected customer data it declares
  only "Store management".
- Webhooks: HMAC. App proxy: Shopify's `signature` parameter. Admin: `X-Api-Key`. All three are
  checked with `timingSafeEqual`.
- The public endpoint has a CORS allow-list, a per-IP rate limit, a 16 kB body limit and strict input
  validation. Every response carries `X-Request-Id`. Error bodies never include stack traces or
  upstream messages.

## Project layout

```
src/
  server.js            boot, background workers, graceful shutdown
  app.js               wiring (createContext) and routes (createApp)
  config.js            env loading and validation
  warehouses.js        warehouses, pincode routing, lead times
  db.js                schema, transaction()
  middleware.js        request id, CORS, rate limit, API key, app-proxy signature, error handler
  shopify/
    graphql.js         transports (token / cli), client-credentials token, the retrying client
    service.js         the Admin API operations we use
    mock.js            the same interface over an in-memory store
  services/
    allocation.js      pure planning: primary → fallback → split
    availability.js    POST /api/express-availability
    inventory.js       the ledger and its sync rule
    orders.js          allocate / cancel (the atomic part)
    outbox.js          durable Shopify writes with retry
    jobs.js            outbox handlers and the reconciler
    webhooks.js        HMAC, durable intake, dedupe, retry sweeper
scripts/
  register-webhooks.js point orders/create + orders/cancelled at a public URL (idempotent)
  sync-locations.js    find the warehouse location GIDs for .env
  send-webhook.js      send correctly signed test webhooks (mock demo, replays)
test/                  node:test suites, 30 tests (npm test)
```

Store setup scripts (they created the demo data) are in `../scripts/`:
`setup-locations.js` (the 3 warehouses), `setup-product.js` (the product and its stock matrix), and
`add-stock.js` (restock: `node add-stock.js 2` adds 2 units per variant per warehouse).

## Current live state

```
Store      another-shpyfy-store.myshopify.com (password-protected dev store)
Product    Precise - Milk Cooler, 8 variants (Silver/Black/White × 8/12/18 Ltr; White/18 Ltr doesn't exist)
Locations  Delhi Warehouse, Bengaluru Warehouse, Mumbai Warehouse (all shipping origins)
Webhooks   ORDERS_CREATE, ORDERS_CANCELLED → <public URL>/webhooks
```
