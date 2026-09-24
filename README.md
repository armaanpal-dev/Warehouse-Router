# Shopify Senior Developer Assessment

| | What | Where |
|---|---|---|
| Task 1 | Custom product page, variant picker, pincode checker, AJAX cart drawer | `theme/` → pushed as the unpublished theme **"Senior Assessment" #131486187602** |
| Task 1 tests | 17 headless tests of the real theme JS (jsdom + a fake Cart API) | `theme-tests/` |
| Task 2 | Multi-warehouse availability + allocation API, webhooks, outbox, reconciliation. **Live** on the store via the Dev Dashboard app "Warehouse Router"; real checkout orders routed (#1006 → Delhi, #1007 → split Delhi 2 + Mumbai 5). 29 tests | `backend/`. See **[backend/README.md](backend/README.md)** |
| Store setup | Scripts that created the warehouses and the demo product | `scripts/` |

Store: `another-shpyfy-store.myshopify.com` (a password-protected dev store).

- Preview: `https://another-shpyfy-store.myshopify.com/products/precise-milk-cooler?preview_theme_id=131486187602`
- Editor: `https://another-shpyfy-store.myshopify.com/admin/themes/131486187602/editor`

## Demo data

The reference product on brewinggadgets.com has a single variant, but the brief asks for colour and size.
`scripts/setup-product.js` created **Precise - Milk Cooler** with the real image and specs, and a
Colour × Size matrix built to exercise every state:

| | 8 Ltr | 12 Ltr | 18 Ltr |
|---|---|---|---|
| **Silver** | ₹2,450 · DEL 5 · BLR 3 · BOM 4 | ₹2,990 · DEL 2 · BOM 6 | ₹3,590 · BLR 1 (low stock) |
| **Black** | ₹2,599 · DEL 4 (fallback demo) | ₹3,199 · **sold out** | ₹3,799 · DEL 3 · BLR 2 · BOM 2 |
| **White** | ₹2,499 · BLR 5 | ₹3,099 · 1 · 1 · 1 | **does not exist** |

That was the starting stock. On 2026-09-24 every variant got **+2 at each warehouse**
(`node scripts/add-stock.js 2`), after two test orders. Later the same day Black / 12 Ltr was zeroed at all three
warehouses (`node scripts/reprice-and-zero-black.js`), so it is sold out again. White / 18 Ltr still doesn't
exist, which demos the "unavailable" state. The live numbers are in Shopify admin → Products.

Every variant has its own price, so choosing a colour changes the price as well as choosing a size. Only
₹2,310 (Silver / 8 Ltr, the reference product) was ever a real price; all of these are made up for the demo. Stock is tracked with the inventory policy set to
`DENY`. Three locations were created: Delhi, Bengaluru and Mumbai Warehouse. The backend's mock uses the
same matrix, so both demos behave the same way.

## Task 1 walkthrough

**Files** (all new, prefixed `custom-`; Dawn's own files are untouched apart from 2 lines in `layout/theme.liquid`):

| File | Role |
|---|---|
| `sections/custom-main-product.liquid` | Product section: gallery, price, picker, quantity, add to cart, pincode checker; theme-editor settings |
| `snippets/custom-variant-picker.liquid` | One radio `fieldset` per option; colour options render as swatches |
| `snippets/custom-price.liquid` | Price, compare-at, % off (the JS mirrors this markup) |
| `snippets/custom-pincode-checker.liquid` | Checker markup; delivery zones parsed from a section setting |
| `sections/custom-cart-drawer.liquid` | Cart drawer. The **only** place cart markup exists |
| `assets/custom-product.js` | `<product-page>`, `<quantity-stepper>`, `<pincode-checker>` custom elements |
| `assets/custom-cart.js` | `<cart-drawer-custom>` + `window.CustomCart` (add / change / setAttributes / refresh) |
| `templates/product.custom.json` | The template the product uses (`templateSuffix: custom`) |
| `templates/index.json` | Homepage: a placeholder image banner linking to the product. The Custom product section also has a *Product* setting, so it can be placed on any page |

**Variant selection.** Variant data is emitted as JSON from Liquid, including stock (`maxQty`) only
where it's meaningful (tracked + deny). Each option is judged against the options *before* it: Size
values are enabled only if that colour + size is in stock. Colours are disabled only if no size of that
colour is in stock. That rules out dead ends: picking White while on 18 Ltr (which doesn't exist)
switches to White / 8 Ltr instead of stranding the shopper. Disabled values carry a visually-hidden
"– sold out" or "– unavailable" for screen readers. Price, SKU, stock message, quantity cap, media and the
`?variant=` URL all update on change.

**Unavailable variants can't be added.** There are three layers: the radio is `disabled`; the button
is disabled and reads "Sold out"; and `onSubmit` re-checks before any request (this covers a stale page
or a `?variant=` deep link). Shopify's `/cart/add.js` 422 is the final gate, and its message is shown
under the button.

**Correct variant and quantity reach the cart.** The hidden `id` input is always the resolved variant.
Add-to-cart posts `{ items: [{ id, quantity }], sections: [...] }` to `/cart/add.js`. Without JS, the
same form posts natively to `/cart/add` (progressive enhancement).

**Pincode checker.** It validates 6 digits (first digit non-zero), with `inputmode="numeric"` and
digits-only input. It resolves the pincode against delivery zones set in the theme editor, **or**, if
"Availability API URL" is set, calls the Task 2 endpoint for live per-warehouse stock. It shows success
("Express delivery available. Delivery by Thu, 26 Sep") or a specific error (invalid / not serviceable /
out of stock / API unreachable). The delivery date respects a dispatch cutoff in IST and skips Sundays.
A successful pincode is remembered in `localStorage` and saved as the cart attribute
`Delivery pincode`. That attribute reaches the order as a note attribute, and the Task 2 backend uses
it as a fallback when routing. The checker re-runs automatically when the variant changes.

**AJAX cart drawer.**
- **Section Rendering API.** Every cart write asks for `sections=custom-cart-drawer,cart-icon-bubble`,
  so the server returns the new drawer HTML with the response. The JS never builds line-item HTML.
- **Line keys, not variant ids,** for `/cart/change.js`, because two lines can share a variant.
- **A single promise queue** for all cart writes, so responses can't arrive out of order and show an
  old cart.
- **Per-line debounce (350 ms).** Five quick "+" clicks become one request. The requested quantity is
  captured at click time and re-applied after any re-render, so a click made while a request is in
  flight is never lost.
- **On an error** (e.g. more than stock), the drawer re-syncs to the real cart and shows Shopify's
  message on that line.
- **Accessibility:** `role="dialog"`, `aria-modal`, focus trap, Escape to close, focus returned to the
  opener, focus kept on the same control across re-renders, an `aria-live` status, and `inert` when
  closed.
- The header cart icon opens the drawer (it stays a normal link to `/cart` without JS), and the
  bfcache is handled (`pageshow` → refresh).
- `cart_type` is set to `page` in this theme, so Dawn's own drawer doesn't also render.

**Responsive.** The gallery is a scroll-snap strip on mobile and a stage + thumbnails from 750 px. The
layout is two columns from 990 px, with a full-width buy button and quantity on mobile and 44 px+ tap
targets. The drawer is `min(42rem, 100vw)` with a safe-area inset. Everything uses Dawn's
colour-scheme variables, so it follows theme settings.

**Verification**
- `shopify theme check`: 0 offenses in the new files.
- `cd theme-tests && npm install && npm test`: 17 tests run the real `custom-product.js` and
  `custom-cart.js` in jsdom against a fake Cart API that enforces stock. They cover the variant states,
  add-to-cart payloads, the debounce and in-flight race, removal, errors, focus handling and the
  pincode cases.
- Push verified by pulling the files back and diffing them.
- **End to end on the real store:** `node theme-tests/e2e-storefront.mjs` drives headless Chromium
  through the live theme (served by `shopify theme dev --theme 131486187602`) at 1366 px and 390 px.
  It checks the theme id, variant states, price/URL/stock updates, the pincode cases, the real
  `/cart/add.js` payload, drawer quantity and remove with totals, Shopify's 422 when adding past stock,
  no horizontal scroll, and no page errors: **40/40 pass**. Screenshots are in `theme-tests/e2e-shots/`.
  This run caught two issues, both now fixed. Custom elements default to `display:inline`, which broke
  the layout. And the store's floating video app sat above the drawer; the drawer now uses the maximum
  z-index.

## Task 2 walkthrough

**Files** (all in `backend/`; Node 22.13+, Express 5, built-in `node:sqlite`, one runtime dependency):

| File | Role |
|---|---|
| `src/server.js` | Boots the API, starts the background workers (outbox, webhook retry sweeper, reconciler), graceful shutdown |
| `src/app.js` | Wires the services together and defines the routes: availability, webhooks, admin, health |
| `src/config.js` | Loads `.env` and validates it at boot (fails fast on missing or weak secrets) |
| `src/warehouses.js` | The 3 warehouses, pincode → region → primary warehouse + fallback order, delivery days |
| `src/db.js` | SQLite schema: stock ledger, orders, allocations, webhook events, outbox, discrepancies |
| `src/services/availability.js` | `POST /api/express-availability`: validation and the response shape |
| `src/services/allocation.js` | Pure planning: primary → nearest single fallback → split → insufficient |
| `src/services/inventory.js` | The stock ledger: syncs from Shopify, never lets a stale read roll it back |
| `src/services/orders.js` | Order allocation and cancellation, the atomic part |
| `src/services/webhooks.js` | HMAC check, durable intake, duplicate guard, retry sweeper |
| `src/services/outbox.js` + `jobs.js` | Durable writes back to Shopify (move fulfillment order, tag order, resync) with retries |
| `src/shopify/graphql.js` | Admin API client: access token via client credentials, retries, rate-limit handling |
| `src/shopify/service.js` | The Admin GraphQL operations used (variants, inventory levels, fulfillment orders, tags) |
| `src/shopify/mock.js` | The same interface over an in-memory fake Shopify, for tests and demos without a store |
| `src/middleware.js` | Request id, CORS allow-list, rate limit, admin API key, app-proxy signature, error handler |
| `scripts/register-webhooks.js` | Points `orders/create` + `orders/cancelled` at the public URL (idempotent) |

**Checking inventory by warehouse (req. 8).** `POST /api/express-availability` takes the brief's exact
body, `{ "variant_id", "quantity", "pincode" }`. It validates every field (400 with per-field
details), reads the variant's stock at each warehouse from Shopify, and answers with whether it's
available, whether it's express, which warehouse ships, the allocation per warehouse and the delivery
days. "Not enough stock" is a valid answer, so it returns 200 with `available: false` and the maximum
available quantity, not an error.

**Pincode → warehouse (req. 9).** Indian pincodes encode geography in their first digits, so
`warehouses.js` maps 2-digit prefix ranges to a region, a **primary** warehouse, and a **fallback order**
ranked by distance: `11xxxx` Delhi → DEL, BOM, BLR; `56xxxx` Karnataka → BLR, BOM, DEL; `40xxxx`
Maharashtra → BOM, BLR, DEL, and so on for all regions. The warehouse's own city (`110`, `560-562`,
`400-401`) gets next-day delivery; the rest of its region 2–3 days; any fallback 4–6 days. Pincodes
outside every region (e.g. `9xxxxx`, Army Post Office) return 422 `PINCODE_NOT_SERVICEABLE`.

**Enough stock for the variant and quantity? (req. 10).** Stock comes live from Shopify's inventory
levels per location (cached 10 s) and is kept in a local ledger. For a real order, the server also reads
where Shopify reserved *that order's* units at checkout and counts them as the order's own. Without that
step an order competes with its own reservation; live order #1007 exposed this bug, and it's fixed and
covered by regression tests.

**Fallback logic (req. 11).** A pure function in `allocation.js`, used for both the availability check
and real orders:
1. The **primary** warehouse, if it has the full quantity: one parcel, express.
2. Otherwise the **nearest fallback that has the full quantity**: one parcel. This beats a split that
   includes the primary, because the customer gets one delivery and the merchant pays for one label.
3. Otherwise a **split** across warehouses in distance order.
4. Otherwise **insufficient**: an order allocates what it can and is tagged `allocation-review`.

**Shopify Admin API integration (req. 12).** A Dev Dashboard app ("Warehouse Router") gives the server
its access. The server fetches its own token (client credentials grant), caches it, renews it before
expiry and retries once on a 401. It reads product variants and their inventory items, locations, and
available quantity per location (`productVariant`, `inventoryLevels`, `locations`). It writes back by
moving fulfillment orders to the chosen warehouse (`fulfillmentOrderMove`) and tagging orders
(`tagsAdd`). The same interface is implemented by `mock.js`, so everything also runs without a store.

**Webhooks for order creation and cancellation (req. 13).**
- **Order created:** verify the HMAC and the shop → store the event and reply 200 immediately (Shopify
  retries anything slower than 5 s) → allocate stock per warehouse → queue the Shopify writes → the
  order moves to the chosen warehouse and gets tagged `warehouse-DEL` / `-BLR` / `-BOM`.
- **Order cancelled:** unfulfilled units go back to the warehouse they were reserved at, any pending move
  is dropped, and stock is re-read from Shopify. Already-shipped lines stay consumed.
- **Cancel arriving before create** (Shopify doesn't guarantee order): a tombstone is recorded and the
  late create is ignored.

**Concurrency, duplicates, API failures, discrepancies (req. 14).**
- **Concurrent orders:** every order is allocated inside one `BEGIN IMMEDIATE` transaction with no network
  call inside it, and every decrement is conditional (`available = available - n WHERE available >= n`).
  Two orders can't take the same last unit, and stock never goes negative.
- **Duplicate webhooks:** the webhook id is a primary key, so a redelivery is acknowledged and dropped. A
  second guard on the Shopify order id stops a replay under a new webhook id.
- **Stale data:** a Shopify read that started before the last applied one is discarded, and items with
  Shopify writes still in flight aren't overwritten by syncs.
- **API failures:** the client retries network errors, 5xx, 429 and GraphQL `THROTTLED`, with backoff.
  Shopify writes go through a **transactional outbox**, retried for up to 8 attempts, and are visible at
  `/api/admin/outbox` if they die. Failed webhook events are retried by a sweeper. If Shopify is down,
  availability serves the ledger if it's under 5 minutes old (flagged `inventory_source: "cache"`),
  otherwise 503.
- **Discrepancies:** every 5 minutes (or on demand at `/api/admin/reconcile`) the ledger is compared with
  Shopify. Each difference (POS sale, stock count, manual edit) is logged in `discrepancies` and
  corrected to Shopify's number.

**Security and errors (req. 15).** Credentials live only in `.env`, which is git-ignored; the access
token is never stored. Webhooks are verified by HMAC over the raw body, the app-proxy route by Shopify's
signature, and admin routes by `X-Api-Key`, all compared in constant time. The public endpoint has a CORS
allow-list, a per-IP rate limit and a 16 kB body limit. Every error has one shape,
`{ error: { code, message, details? }, request_id }`: 400 validation / invalid JSON, 401 bad signature
or key, 403 unknown shop, 404 unknown variant, 422 unserviceable pincode, 429 rate limited, 502 / 503
Shopify errors. Stack traces are never sent to the client.

**Live setup.** The store has 3 locations (Delhi, Bengaluru, Mumbai Warehouse), all set up as shipping
origins, holding the product's per-variant stock. The app is installed with the scopes `read_products,
read_inventory, read_locations, read_orders, write_orders, read/write_merchant_managed_fulfillment_orders`
and "Store management" protected customer data. The webhooks point at the server through an HTTPS
tunnel (`scripts/register-webhooks.js`). Full setup steps are in [backend/README.md](backend/README.md).

**Verification**
- `cd backend && npm install && npm test`: **29 tests** cover pincode routing, availability, fallback and
  split, validation and error codes, HMAC and shop checks, duplicate webhooks, **8 simultaneous orders for
  1 unit → exactly 1 allocated**, **20 orders against 12 units → exactly 12, filled BLR → BOM → DEL**,
  cancel-before-create, Shopify outages with retries, reconciliation, and the #1007 regression.
- Live availability calls against the store's real stock: express from Bengaluru, fallback to Delhi,
  a Delhi + Mumbai split, and out of stock all answered correctly.
- **Real checkout orders** delivered by Shopify webhooks: **#1006** (110003) → routed to Delhi Warehouse,
  tagged `warehouse-DEL`. **#1007** (7 units to 110003, Delhi had 2) → split Delhi 2 + Mumbai 5 in
  Shopify, tagged `warehouse-DEL` + `warehouse-BOM`.
- Sample requests and responses for every case are in [backend/README.md](backend/README.md#sample-requests-and-responses).
