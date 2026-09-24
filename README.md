# Shopify Senior Developer Assessment

| | What | Where |
|---|---|---|
| Task 1 | Custom product page, variant picker, pincode checker, AJAX cart drawer | `theme/` → pushed as the unpublished theme **"Senior Assessment" #131486187602** |
| Task 1 tests | 18 headless tests of the real theme JS (jsdom + a fake Cart API) | `theme-tests/` |
| Task 2 | Multi-warehouse availability + allocation API, webhooks, outbox, reconciliation. **Live** on the store via the Dev Dashboard app "Warehouse Router"; real checkout orders routed (#1006 → Delhi, #1007 → split Delhi 2 + Mumbai 5, #1009 → split across all 3). 30 tests | `backend/`. See **[backend/README.md](backend/README.md)** |
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
| `sections/custom-main-product.liquid` | Product section: gallery plus a block-based info column (vendor, title, price, variant picker, SKU/stock, quantity + add to cart, pincode checker, description, text, app blocks) that can be reordered in the theme editor |
| `snippets/custom-variant-picker.liquid` | One radio `fieldset` per option; colour options render as swatches |
| `snippets/custom-price.liquid` | Price, compare-at, % off (the JS mirrors this markup) |
| `snippets/custom-pincode-checker.liquid` | Checker markup; delivery zones parsed from the pincode block setting |
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
- `cd theme-tests && npm install && npm test`: 18 tests run the real `custom-product.js` and
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
- **Webhook never arrives** (server down past Shopify's retries): a catch-up job lists the last 72 h of
  orders from Shopify on boot and every 5 minutes and allocates any the server has no record of.

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
- `cd backend && npm install && npm test`: **30 tests** cover pincode routing, availability, fallback and
  split, validation and error codes, HMAC and shop checks, duplicate webhooks, **8 simultaneous orders for
  1 unit → exactly 1 allocated**, **20 orders against 12 units → exactly 12, filled BLR → BOM → DEL**,
  cancel-before-create, Shopify outages with retries, reconciliation, and the #1007 regression.
- Live availability calls against the store's real stock: express from Bengaluru, fallback to Delhi,
  a Delhi + Mumbai split, and out of stock all answered correctly.
- **Real checkout orders** delivered by Shopify webhooks: **#1006** (110003) → routed to Delhi Warehouse,
  tagged `warehouse-DEL`. **#1007** (7 units to 110003, Delhi had 2) → split Delhi 2 + Mumbai 5 in
  Shopify, tagged `warehouse-DEL` + `warehouse-BOM`. **#1008** and **#1009** were placed while the server was
  down; the catch-up job recovered both on restart and tagged them (#1009, 9 units: DEL 3 + BOM 3 + BLR 3).
- Sample requests and responses for every case are in [backend/README.md](backend/README.md#sample-requests-and-responses).

## Edge cases handled

Every edge case the code handles, where it lives, and how. Paths are relative to the repo root; line
numbers are for the submitted code. Tests for Task 1 are in `theme-tests/`, for Task 2 in `backend/test/`.

### Task 1: product page

| # | Edge case | How it's handled | Code |
|---|---|---|---|
| 1 | Product loads on a sold-out variant | Liquid starts from `selected_or_first_available_variant`, so an in-stock variant is preselected | `theme/sections/custom-main-product.liquid:26` |
| 2 | Colour + size combination that **doesn't exist** (White / 18 Ltr) | Value disabled and read out as "– unavailable". Picking White while on 18 Ltr moves size to the first in-stock White instead of stranding the shopper | `theme/assets/custom-product.js:105-111`, `:147-165` |
| 3 | Combination that exists but is **sold out** (Black / 12 Ltr) | Radio `disabled`, label "– sold out" for screen readers, button disabled and reads "Sold out" | `custom-product.js:156-162`, `:200-204` |
| 4 | Dead ends in the picker | Option N is judged only against options 0..N-1, so every in-stock variant is reachable working left to right | `custom-product.js:142-151` |
| 5 | Adding an unavailable variant anyway (stale page, `?variant=` deep link, crafted request) | Three layers: disabled radio, disabled button, `onSubmit` re-checks `available`. Shopify's `/cart/add.js` 422 is the final gate; its message is shown under the button | `custom-product.js:219-221`, `theme/assets/custom-cart.js:63-66` |
| 6 | Quantity above stock | `maxQty` sent only for tracked + `deny` variants; the stepper clamps to it and disables "+" at the limit. Untracked / "continue selling" variants have no cap | `custom-main-product.liquid:247`, `custom-product.js:39-56` |
| 7 | Quantity typed as 0, negative, text or empty | Parsed and clamped to 1..max on every change | `custom-product.js:35-40` |
| 8 | Different price per variant, sale price | Price re-rendered on every change; compare-at and % off shown only when it is higher | `custom-product.js:167-177` |
| 9 | Money formats other than `{{amount}}` | The shop's own format is used, including no-decimals, comma and apostrophe separators | `custom-product.js:9-24` |
| 10 | Theme editor removes a block (price, stock, buy buttons, picker) | Every renderer null-guards its element | `custom-product.js:90`, `:169`, `:186`, `:201`, `:241-242` |
| 11 | Blocks reordered so the buy button leaves its `<form>` | The form is an empty target; quantity and button use `form=""`, so any order still submits | `custom-main-product.liquid:9` |
| 12 | Section embedded on a non-product page | `?variant=` written to the URL only on the product page itself | `custom-product.js:127-132` |
| 13 | JavaScript unavailable | The form posts natively to `/cart/add`; the cart icon stays a link to `/cart` | `custom-product.js:222`, `custom-cart.js:36-42` |
| 14 | Custom elements upgraded in a different order | The pincode checker reads the product page's state directly if it missed the first event | `custom-product.js:293-297` |

### Task 1: pincode checker

| # | Edge case | How it's handled | Code |
|---|---|---|---|
| 15 | Invalid pincode (5 digits, leading 0, letters, spaces) | Input strips non-digits and caps at 6; `^[1-9][0-9]{5}$` checked before any request; `aria-invalid` set | `custom-product.js:247`, `:268-271`, `:288-292` |
| 16 | Valid but unserviceable pincode | Specific "we don't deliver to X yet" error (zones mode) or the API's 422 message | `custom-product.js:313`, `:322-327`, `:337` |
| 17 | Checking a sold-out variant | Short-circuits with "out of stock" instead of promising delivery | `custom-product.js:299-301` |
| 18 | Not enough stock for the quantity (API mode) | Asks the shopper to try a smaller quantity | `custom-product.js:339-341` |
| 19 | API down or 5xx | "Couldn't check right now" error; button re-enabled | `custom-product.js:315-319`, `:338` |
| 20 | Double-submitting while a check runs | Button disabled during the request | `custom-product.js:304`, `:318` |
| 21 | Variant or quantity changes after a successful check | Re-checks automatically (quantity only in API mode, where it changes the answer) | `custom-product.js:273-281` |
| 22 | API text injected into the page | API messages rendered with `textContent`, never `innerHTML` | `custom-product.js:370-375` |
| 23 | Late in the day, Sundays | Delivery date uses a dispatch cutoff in IST and skips Sundays | `custom-product.js:356-368` |
| 24 | `localStorage` blocked (private mode) | Reads and writes wrapped in try/catch | `custom-product.js:249-252` |
| 25 | Pincode should reach the order | Saved as cart attribute `Delivery pincode`; the backend uses it when the shipping zip is missing or invalid | `custom-product.js:311`, `backend/src/services/orders.js:31-43` |

### Task 1: cart drawer

| # | Edge case | How it's handled | Code |
|---|---|---|---|
| 26 | Rapid clicks racing each other | One promise queue for every cart write, so responses can't land out of order; a failed write doesn't block the next | `custom-cart.js:50-54` |
| 27 | Five quick "+" clicks | Per-line 350 ms debounce: one request for the final quantity | `custom-cart.js:177-189` |
| 28 | A click made while an earlier request is in flight | Quantity captured at click time and re-applied after the re-render | `custom-cart.js:180-182`, `:196-202` |
| 29 | Remove clicked while a quantity change is pending | Pending change cancelled first | `custom-cart.js:162-165` |
| 30 | Two lines with the same variant (different properties) | Changes keyed by line-item `key`, never variant id | `custom-cart.js:6-7`, `:86` |
| 31 | Increasing past stock in the drawer | "+" disabled at the stock level in Liquid; if Shopify still returns 422, the drawer re-syncs to the real cart and shows the message on that line | `theme/sections/custom-cart-drawer.liquid:33-34`, `:86`, `custom-cart.js:91-97`, `:142-146` |
| 32 | Cart markup drifting between Liquid and JS | Section Rendering API: every write returns the drawer HTML; JS never builds line items | `custom-cart.js:8-9`, `:60`, `:116-138` |
| 33 | Empty cart | Empty state rendered by the same section | `custom-cart-drawer.liquid:23-25` |
| 34 | Back/forward cache restores a stale cart | `pageshow` with `persisted` triggers a refresh | `custom-cart.js:43-44` |
| 35 | Ctrl/Cmd/Shift-click on the cart icon | Left alone, so `/cart` opens in a new tab | `custom-cart.js:39` |
| 36 | Keyboard and screen-reader users | `role="dialog"` + `aria-modal`, focus trap, Escape, focus returned to the opener and kept across re-renders, `aria-live` status, `inert` when closed | `custom-cart.js:33-34`, `:123-129`, `:148-151`, `:204-230`, `custom-cart-drawer.liquid:9-11` |
| 37 | App overlays (the store's floating reel at z-index 2147483000) | Drawer uses the maximum z-index | `theme/assets/custom-cart-drawer.css:17-19` |
| 38 | Page scrolling behind the drawer; iPhone home bar | Scroll lock on `<html>`; footer padded with `env(safe-area-inset-bottom)` | `custom-cart-drawer.css:16`, `:57` |
| 39 | Dawn's own drawer also rendering | `cart_type` set to `page` | `theme/config/settings_data.json:124` |
| 40 | Script on a page without the drawer | `window.CustomCart` defined only when the drawer exists; the product page falls back to a form post | `custom-cart.js:235-245`, `custom-product.js:222` |

### Task 2: availability API

| # | Edge case | How it's handled | Code |
|---|---|---|---|
| 41 | Missing or malformed `variant_id` | 400 `VALIDATION_ERROR` with per-field details; numeric id or `ProductVariant` GID accepted | `backend/src/services/availability.js:8-18` |
| 42 | Quantity 0, negative, fractional, a string, or huge | Integer 1-100 required (defaults to 1 if omitted) | `availability.js:6`, `:13-14` |
| 43 | Pincode with spaces, wrong length, leading 0 | Whitespace stripped, then `^[1-9]\d{5}$` | `availability.js:15-16`, `backend/src/warehouses.js:47` |
| 44 | Well-formed but unserviceable (9xxxxx Army Post Office, gaps) | 422 `PINCODE_NOT_SERVICEABLE` | `warehouses.js:53-62`, `availability.js:30` |
| 45 | Variant doesn't exist | 404 `VARIANT_NOT_FOUND` | `availability.js:33` |
| 46 | Out of stock vs not enough stock | 200 with `available: false`, reason `OUT_OF_STOCK` or `INSUFFICIENT_STOCK`, and `max_available_quantity`: an answer, not an error | `availability.js:50-61` |
| 47 | Primary short, a fallback has it all | One parcel from the nearest fallback beats a split that includes the primary | `backend/src/services/allocation.js:20-21` |
| 48 | No single warehouse has it all | Split in distance order; delivery estimate = slowest parcel | `allocation.js:23-30`, `:35-38` |
| 49 | Untracked variant | Always available, ships from the primary | `allocation.js:17-19` |
| 50 | Negative stock in Shopify | Treated as 0 in every sum and split | `allocation.js:26`, `availability.js:37` |
| 51 | Metro vs rest of region vs fallback | Different delivery days for each | `warehouses.js:18-22`, `:45`, `:64-68` |
| 52 | Invalid JSON / body over 16 kB | 400 `INVALID_JSON` / 413 `PAYLOAD_TOO_LARGE`, same error shape | `backend/src/app.js:70`, `backend/src/middleware.js:91-92` |
| 53 | Abuse or scraping | Per-IP rate limit, 429 with `Retry-After` | `middleware.js:34-50` |
| 54 | Calls from other websites | CORS allow-list, including Chrome's private-network preflight | `middleware.js:16-31` |

### Task 2: orders and webhooks

| # | Edge case | How it's handled | Code |
|---|---|---|---|
| 55 | Forged or tampered webhook | HMAC-SHA256 over the **raw** body (route mounted before `express.json()`), constant-time compare, 401 | `app.js:54-55`, `backend/src/services/webhooks.js:4-10` |
| 56 | Webhook for another shop | 403 `UNKNOWN_SHOP` | `app.js:56-57` |
| 57 | Missing topic/id headers, non-JSON body | 400 | `app.js:58-62` |
| 58 | Shopify's 5 s timeout causing retries | Event stored and 200 returned first; processing happens after the response | `app.js:63-67` |
| 59 | **Duplicate delivery** (same webhook id) | `webhook_id` is the primary key (`ON CONFLICT DO NOTHING`): acknowledged and dropped | `webhooks.js:24-25`, `:34-42` |
| 60 | **Same order under a new webhook id** | `orders` keyed by Shopify order id, checked before *and* inside the transaction | `backend/src/services/orders.js:81`, `:105` |
| 61 | Same event processed twice at once | In-flight set | `webhooks.js:45` |
| 62 | Topics we don't handle | Stored as `skipped`, still 200 so Shopify doesn't retry | `webhooks.js:35` |
| 63 | Processing fails (Shopify down mid-order) | Event marked `failed`; sweeper retries with exponential backoff, up to 6 attempts | `webhooks.js:19`, `:55-60`, `:65-72` |
| 64 | Crash after accepting an event | Sweeper runs on boot and every 5 s | `backend/src/server.js:10`, `:17` |
| 65 | **Webhook never arrives** (server or tunnel down past Shopify's retries; found by #1008 / #1009) | Catch-up lists the last 72 h of orders from Shopify on boot and every 5 min, and allocates any it has no record of through the same `allocate()` | `backend/src/services/jobs.js:58-86`, `backend/src/shopify/service.js:104-165`, `server.js:12-18`. Test: *catch-up recovers orders…* |
| 66 | **Cancel arrives before create** | Tombstone recorded; the late create does nothing | `orders.js:180-185` |
| 67 | Order created already cancelled | Goes straight to cancel handling | `orders.js:79` |
| 68 | Cancel delivered twice | Second is a no-op | `orders.js:186` |
| 69 | Cancelling a partly shipped order | Only unfulfilled allocations released; shipped lines stay consumed | `orders.js:188-194` |
| 70 | Cancel while routing is still queued | Pending `route_order` job abandoned; stock re-read from Shopify | `orders.js:196-199` |
| 71 | Shipping zip missing or not a pincode | Falls back to the `Delivery pincode` attribute, then the billing zip; with none, `needs_review` + tag `allocation-review` | `orders.js:31-43`, `:128-133`, `:151`, `:158` |
| 72 | Digital items, removed variants, already-fulfilled lines | Skipped: only lines with a variant, needing shipping, with quantity left | `orders.js:85` |
| 73 | Not enough stock anywhere for an order | Allocates what it can, records the rest as `unallocated`, `partially_allocated`, tag `allocation-review` | `orders.js:145-151`, `:158` |
| 74 | **Order competing with its own reservation** (Shopify commits stock at checkout; found by #1007) | Reads where Shopify committed this order's units and adds them back, only when the ledger provably contains them | `orders.js:51-74`, `:96-122`. Test: *regression: live order #1007* |

### Task 2: concurrency, overselling and inventory drift

| # | Edge case | How it's handled | Code |
|---|---|---|---|
| 75 | **Two orders for the last unit at once** | One `BEGIN IMMEDIATE` transaction with no `await` inside (enforced at runtime), and every decrement is conditional (`WHERE available >= ?`) | `backend/src/db.js:113-128`, `orders.js:23`, `:138-139`. Tests: 8 orders for 1 unit → 1 allocated; 20 orders vs 12 units → 12 |
| 76 | A second process on the same DB | SQLite write lock, `busy_timeout` 5 s | `db.js:14-16` |
| 77 | A sync overwriting stock just allocated, before Shopify catches up | Items with Shopify writes still queued (`pending_items`) aren't overwritten | `backend/src/services/inventory.js:45` |
| 78 | A slow, older Shopify read landing after a newer one | Each sync records when its read *started*; older reads are dropped | `inventory.js:47` |
| 79 | Variant not stocked at a warehouse | Treated as 0 there | `inventory.js:52` |
| 80 | **Stock changed outside the app** (POS, stock count, manual edit) | Reconciliation every 5 min (and on demand) logs each difference to `discrepancies` and corrects to Shopify | `inventory.js:53-56`, `jobs.js:89-107`, `server.js:12-16` |
| 81 | Overlapping reconcile or catch-up runs | Guard flag; a second run returns `skipped` | `jobs.js:67`, `:93` |
| 82 | A failing Shopify write blocking the queue | Transactional outbox: backoff (1 s doubling, 5 min cap), `dead` after 8 attempts or a non-retryable error, requeueable at `/api/admin/outbox` | `backend/src/services/outbox.js:3-4`, `:52-68` |
| 83 | Same write queued twice | Outbox `dedupe_key` (`route:<order>`, `tag:<order>`) | `outbox.js:19`, `orders.js:155`, `:159` |
| 84 | Order not yet visible to the API when the job runs | Retryable error, tried again | `jobs.js:15` |
| 85 | Routing re-run after a partial run, or Shopify already chose the right warehouse | Counts what's already at the target and moves only the difference | `jobs.js:26-37` |
| 86 | Overlapping outbox drains | Serialised: callers share the running drain | `outbox.js:73-84` |

### Task 2: Shopify API failures and security

| # | Edge case | How it's handled | Code |
|---|---|---|---|
| 87 | Network error, timeout, 5xx | 8 s timeout; exponential backoff + jitter, up to 4 attempts | `backend/src/shopify/graphql.js:62-65`, `:76`, `:127-153` |
| 88 | HTTP 429 / GraphQL `THROTTLED` | Waits `Retry-After`, or exactly as long as the cost bucket needs | `graphql.js:72-75`, `:132-138` |
| 89 | Access denied, bad query | Not retried; surfaced as 502 | `graphql.js:139-143`, `:148` |
| 90 | Access token expired or revoked | Cached until 5 min before expiry; on 401 dropped and refetched once; concurrent callers share one request | `graphql.js:34-43`, `:67-71` |
| 91 | Shopify down while a shopper checks availability | Serves the ledger if under 5 min old (`inventory_source: "cache"`), else 503 `INVENTORY_UNAVAILABLE` rather than guessing | `inventory.js:92-102`, `availability.js:46` |
| 92 | Misconfiguration (bad mode, missing location GIDs, weak production secrets) | Validated at boot; the server refuses to start | `backend/src/config.js:40-56` |
| 93 | Credentials leaking | `.env` only (git-ignored); token fetched at runtime, never stored; errors never include stack traces or upstream messages | `backend/.gitignore`, `middleware.js:82-98` |
| 94 | Unauthorised admin or forged app-proxy calls | `X-Api-Key` and Shopify's proxy `signature`, both constant-time; admin disabled (503) if no key is set | `middleware.js:52-80` |
| 95 | Tracing a failure | Every response carries `X-Request-Id` (client value capped at 64 chars) | `middleware.js:4-8` |
| 96 | Shutdown mid-write | SIGINT/SIGTERM stop the timers, let the outbox finish, close the DB; forced exit after 10 s | `server.js:24-36` |
