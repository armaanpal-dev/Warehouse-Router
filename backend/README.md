# Warehouse availability API (Task 2)

Pincode-based inventory allocation across three warehouses (Delhi, Bengaluru, Mumbai) for a Shopify store.
It answers "can this pincode get this quantity, and how fast?", allocates stock when an order is placed,
routes the order to the right warehouse in Shopify, and releases stock on cancellation.

- Node 22.13+ (uses the built-in `node:sqlite`), Express 5. One runtime dependency.
- Runs with **no Shopify at all** in `mock` mode (the default). The tests use that mode.
- The same code talks to the real Admin GraphQL API in `token` mode.

## Setup

```bash
cd backend
npm install
cp .env.example .env          # then set SHOPIFY_API_SECRET and ADMIN_API_KEY to long random strings
npm test                      # 27 tests: routing, availability, webhooks, concurrency, failure handling
npm start                     # http://127.0.0.1:3000
```

### Against a real store

1. Create an app in the Shopify Dev Dashboard with the scopes `read_products`, `read_inventory`,
   `read_locations`, `read_orders`, `write_orders`, `read_merchant_managed_fulfillment_orders` and
   `write_merchant_managed_fulfillment_orders`. Install it on the store.
2. In `.env`: `SHOPIFY_MODE=token`, `SHOPIFY_SHOP`, `SHOPIFY_ADMIN_TOKEN`, and `SHOPIFY_API_SECRET` = the app's client secret.
   Webhook HMACs are verified with that secret.
3. Create the three locations in Shopify (their names must contain Delhi, Bengaluru and Mumbai), then run
   `npm run sync-locations` and paste the three `WAREHOUSE_*_LOCATION_ID` lines it prints into `.env`.
4. Subscribe the app to `orders/create` and `orders/cancelled` pointing at `https://<host>/webhooks`
   (in `shopify.app.toml`, or with `webhookSubscriptionCreate`).

`SHOPIFY_MODE=cli` is a dev-only shortcut. It runs every call through `shopify store execute` using your
Shopify CLI login, so you can read a real store without creating an app. Webhook signatures can't be
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

**Against the real dev store** (`SHOPIFY_MODE=cli`, live Admin API data from the three Shopify
locations, 2026-09-24):

| Request | Result |
|---|---|
| Silver / 8 Ltr (`42753591476306`) ×2 → 560001 | `express: true`, BLR, 1 day |
| Black / 8 Ltr (`42753591574610`) ×2 → 560001 (stock only in Delhi) | `fallback_used: true`, DEL, 4–6 days |
| Silver / 12 Ltr (`42753591509074`) ×7 → 110001 | `split`: DEL 2 + BOM 5 |
| Black / 12 Ltr (`42753591607378`) ×1 → 400001 | `available: false`, `OUT_OF_STOCK` |

**Webhook flow**, driven by `scripts/send-webhook.js`, which signs the payload exactly as Shopify does:

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
- **Known conservative window.** Between an order's creation and our routing of it, Shopify has
  committed the stock at *its* chosen location and we have committed it at *ours*. The unit is briefly
  counted twice. That can undersell for a few seconds; it can never oversell. The next sync after the
  move removes the double count.
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
  refuses short secrets.
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
    graphql.js         transports (token / cli) and the retrying client
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
scripts/               send-webhook.js, sync-locations.js
test/                  node:test suites (run with npm test)
```
