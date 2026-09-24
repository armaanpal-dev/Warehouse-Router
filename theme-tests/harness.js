/**
 * Loads the theme's real JS (assets/custom-product.js, assets/custom-cart.js) into jsdom, over markup
 * that mirrors what the Liquid renders, with a fake Shopify Cart API behind fetch().
 */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const ASSETS = new URL('../theme/assets/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, ASSETS), 'utf8');

// Mirrors the product created by scripts/setup-product.js (White / 18 Ltr intentionally absent).
export const VARIANTS = [
  ['42753591476306', 'Silver', '8 Ltr', 231000, 12], ['42753591509074', 'Silver', '12 Ltr', 289000, 8],
  ['42753591541842', 'Silver', '18 Ltr', 345000, 1], ['42753591574610', 'Black', '8 Ltr', 231000, 4],
  ['42753591607378', 'Black', '12 Ltr', 289000, 0], ['42753591640146', 'Black', '18 Ltr', 345000, 7],
  ['42753591672914', 'White', '8 Ltr', 231000, 5], ['42753591705682', 'White', '12 Ltr', 289000, 3],
].map(([id, color, size, price, qty]) => ({
  id: Number(id), title: `${color} / ${size}`, options: [color, size], available: qty > 0,
  price, compareAtPrice: 0, sku: 'SKU-' + id.slice(-4), mediaId: null, maxQty: qty,
}));

const OPTIONS = [['Color', ['Silver', 'Black', 'White']], ['Size', ['8 Ltr', '12 Ltr', '18 Ltr']]];

function productMarkup(selected) {
  const fieldsets = OPTIONS.map(([name, values], i) => `
    <fieldset class="cp-variants__group" data-option-index="${i}">
      <legend>${name}: <span data-selected-label>${selected.options[i]}</span></legend>
      <div class="cp-variants__values">
        ${values.map((v, j) => `
          <input type="radio" id="o${i}-${j}" name="opt-${i}" value="${v}" ${selected.options[i] === v ? 'checked' : ''}>
          <label for="o${i}-${j}" class="cp-variants__value"><span class="cp-variants__text">${v}</span><span data-state-label></span></label>`).join('')}
      </div>
    </fieldset>`).join('');
  return `
    <header><a id="cart-icon-bubble" href="/cart">Cart</a></header>
    <product-page data-section="main" data-url="/products/precise-milk-cooler" data-low-stock="5">
      <div data-price></div>
      <form data-product-form action="/cart/add" method="post">
        <input type="hidden" name="id" value="${selected.id}" data-variant-input>
        <div data-variant-picker>${fieldsets}</div>
        <p><span data-sku><span data-sku-value></span></span><span data-stock></span></p>
        <quantity-stepper class="qty">
          <button type="button" data-step="-1">-</button>
          <input type="number" name="quantity" value="1" min="1" data-quantity-input>
          <button type="button" data-step="1">+</button>
        </quantity-stepper>
        <button type="submit" data-add-button><span data-add-label>Add to cart</span></button>
        <p data-form-error hidden></p>
      </form>
      <pincode-checker data-api="" data-cutoff="14">
        <form data-pincode-form><input data-pincode-input><button type="submit" data-pincode-submit>Check</button></form>
        <div data-pincode-result></div>
        <script type="application/json" data-zones>[{"from":11,"to":19,"warehouse":"Delhi","days":2},{"from":56,"to":59,"warehouse":"Bengaluru","days":2},{"from":60,"to":69,"warehouse":"Bengaluru","days":3}]</script>
      </pincode-checker>
      <script type="application/json" data-product-json>${JSON.stringify({ moneyFormat: '₹{{amount}}', options: OPTIONS.map((o) => o[0]), variants: VARIANTS })}</script>
    </product-page>
    ${drawerShell(renderDrawer([]))}`;
}

const drawerShell = (inner) => `
  <cart-drawer-custom class="cd" inert>
    <span class="cd__overlay" data-cart-close></span>
    <div class="cd__panel" role="dialog" tabindex="-1">
      <div class="cd__render" data-cart-render>${inner}</div>
      <p data-cart-status></p>
    </div>
  </cart-drawer-custom>`;

/** Server-side drawer HTML for a cart state (what sections=custom-cart-drawer returns). */
export function renderDrawer(lines) {
  const items = lines.map((l) => `
    <li class="cd__item" data-line-key="${l.key}">
      <button data-qty-step="-1" data-focus-key="minus:${l.key}">-</button>
      <input data-qty-input value="${l.quantity}" ${l.max ? `max="${l.max}"` : ''} data-focus-key="qty:${l.key}">
      <button data-qty-step="1" data-focus-key="plus:${l.key}">+</button>
      <button data-remove data-focus-key="remove:${l.key}">Remove</button>
      <p data-line-error hidden></p>
    </li>`).join('');
  const total = lines.reduce((s, l) => s + l.quantity * l.price, 0);
  return `<button data-cart-close data-focus-key="close">x</button>
    ${lines.length ? `<ul>${items}</ul><span data-cart-total>${total}</span>` : '<p>Your cart is empty.</p>'}`;
}

/** Fake Shopify Cart API. Enforces stock like Shopify does (422 when exceeding inventory). */
export function fakeCart() {
  const lines = [];
  const requests = [];
  let failNextChange = null;
  const sections = () => ({
    'custom-cart-drawer': `<div class="shopify-section">${drawerShell(renderDrawer(lines))}</div>`,
    'cart-icon-bubble': `<div id="shopify-section-cart-icon-bubble" class="shopify-section"><span class="count">${lines.reduce((s, l) => s + l.quantity, 0)}</span></div>`,
  });
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

  async function fetch(url, opts = {}) {
    const body = opts.body ? JSON.parse(opts.body) : null;
    requests.push({ url: String(url), body });
    await new Promise((r) => setTimeout(r, 5));
    const u = String(url);
    if (u.includes('?sections=')) return json(200, sections());
    if (u.endsWith('cart/add.js')) {
      for (const it of body.items) {
        const v = VARIANTS.find((x) => x.id === Number(it.id));
        const line = lines.find((l) => l.id === v.id);
        const inCart = line ? line.quantity : 0;
        if (!v.available || inCart + it.quantity > v.maxQty) {
          return json(422, { status: 422, message: 'Cart Error', description: `You can't add more ${v.title} to the cart.` });
        }
        if (line) line.quantity += it.quantity;
        else lines.push({ key: `${v.id}:abc${lines.length}`, id: v.id, quantity: it.quantity, price: v.price, max: v.maxQty });
      }
      return json(200, { items: body.items, sections: sections() });
    }
    if (u.endsWith('cart/change.js')) {
      if (failNextChange) { const f = failNextChange; failNextChange = null; return json(422, { status: 422, message: 'Cart Error', description: f }); }
      const i = lines.findIndex((l) => l.key === body.id);
      if (i < 0) return json(400, { status: 400, description: 'no such line' });
      if (body.quantity === 0) lines.splice(i, 1);
      else lines[i].quantity = Math.min(body.quantity, lines[i].max);
      return json(200, { item_count: lines.length, sections: sections() });
    }
    if (u.endsWith('cart/update.js')) return json(200, { attributes: body.attributes, sections: sections() });
    return json(404, {});
  }
  return { fetch, lines, requests, failChangeWith: (msg) => { failNextChange = msg; } };
}

export function setup({ variantId = VARIANTS[0].id } = {}) {
  const selected = VARIANTS.find((v) => v.id === variantId);
  const dom = new JSDOM(`<!doctype html><html><body>${productMarkup(selected)}</body></html>`, {
    url: 'https://another-shpyfy-store.myshopify.com/products/precise-milk-cooler', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const cart = fakeCart();
  window.fetch = cart.fetch;
  window.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
  window.eval(read('custom-cart.js'));
  window.eval(read('custom-product.js'));
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];
  const input = (option, value) => $$(`fieldset[data-option-index="${option}"] input`).find((i) => i.value === value);
  const choose = (option, value) => {
    const el = input(option, value);
    el.checked = true;
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const page = $('product-page');
  return { window, dom, cart, $, $$, input, choose, page, wait: (ms) => new Promise((r) => setTimeout(r, ms)) };
}
