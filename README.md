# Shopify Senior Developer Assessment

| | What | Where |
|---|---|---|
| Task 1 | Custom product page, variant picker, pincode checker, AJAX cart drawer | `theme/` → pushed as the unpublished theme **"Senior Assessment" #131486187602** |
| Task 1 tests | 17 headless tests of the real theme JS (jsdom + a fake Cart API) | `theme-tests/` |
| Task 2 | Multi-warehouse availability + allocation API, webhooks, outbox, reconciliation | `backend/`. See **[backend/README.md](backend/README.md)** |
| Store setup | Scripts that created the warehouses and the demo product | `scripts/` |

Store: `another-shpyfy-store.myshopify.com` (a password-protected dev store).

- Preview: `https://another-shpyfy-store.myshopify.com/products/precise-milk-cooler?preview_theme_id=131486187602`
- Editor: `https://another-shpyfy-store.myshopify.com/admin/themes/131486187602/editor`

## Demo data

The reference product on brewinggadgets.com has a single variant, but the brief asks for colour and size.
`scripts/setup-product.js` created **Precise - Milk Cooler** with the real image and specs, and a
Colour × Size matrix built to exercise every state:

| | 8 Ltr (₹2,310) | 12 Ltr (₹2,890) | 18 Ltr (₹3,450) |
|---|---|---|---|
| **Silver** | DEL 5 · BLR 3 · BOM 4 | DEL 2 · BOM 6 | BLR 1 (low stock) |
| **Black** | DEL 4 (fallback demo) | **sold out** | DEL 3 · BLR 2 · BOM 2 |
| **White** | BLR 5 | 1 · 1 · 1 | **does not exist** |

The prices for 12 and 18 Ltr are made up for the demo. Stock is tracked with the inventory policy set to
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
