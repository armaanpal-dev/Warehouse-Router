import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, VARIANTS } from './harness.js';

const byTitle = (t) => VARIANTS.find((v) => v.title === t);

test('initial render: price, stock and URL for the selected variant', () => {
  const { $, window } = setup();
  assert.equal($('[data-price]').textContent.trim(), '₹2,450.00');
  assert.equal($('[data-stock]').textContent, 'In stock');
  assert.equal(new URL(window.location.href).searchParams.get('variant'), String(VARIANTS[0].id));
  assert.equal($('[data-add-button]').disabled, false);
});

test('changing size updates price, id, URL and stock message', () => {
  const { $, choose, window } = setup();
  choose(1, '18 Ltr');
  const v = byTitle('Silver / 18 Ltr');
  assert.equal($('[data-variant-input]').value, String(v.id));
  assert.equal($('[data-price]').textContent.trim(), '₹3,590.00');
  assert.equal($('[data-stock]').textContent, 'Only 1 left');
  assert.equal(new URL(window.location.href).searchParams.get('variant'), String(v.id));
});

test('changing colour updates price, because every variant has its own price', () => {
  const { $, choose } = setup();
  choose(0, 'Black');
  assert.equal($('[data-variant-input]').value, String(byTitle('Black / 8 Ltr').id));
  assert.equal($('[data-price]').textContent.trim(), '₹2,599.00');
  choose(0, 'White');
  assert.equal($('[data-price]').textContent.trim(), '₹2,499.00');
});

test('sold-out combination is disabled for the current colour, and labelled for screen readers', () => {
  const { choose, input } = setup();
  choose(0, 'Black');
  const twelve = input(1, '12 Ltr');
  assert.equal(twelve.disabled, true);
  assert.equal(twelve.nextElementSibling.querySelector('[data-state-label]').textContent, ' – sold out');
  assert.equal(input(1, '8 Ltr').disabled, false);
  assert.equal(input(1, '18 Ltr').disabled, false);
});

test('non-existent combination (White / 18 Ltr) is disabled as unavailable', () => {
  const { choose, input } = setup();
  choose(0, 'White');
  const eighteen = input(1, '18 Ltr');
  assert.equal(eighteen.disabled, true);
  assert.equal(eighteen.nextElementSibling.querySelector('[data-state-label]').textContent, ' – unavailable');
});

test('no dead ends: picking a colour whose current size is unavailable moves to an available size', () => {
  const { choose, $ } = setup({ variantId: byTitle('Silver / 18 Ltr').id });
  choose(0, 'White'); // White / 18 Ltr doesn't exist
  assert.equal($('[data-variant-input]').value, String(byTitle('White / 8 Ltr').id));
  assert.equal($('fieldset[data-option-index="1"] [data-selected-label]').textContent, '8 Ltr');
  assert.equal($('[data-add-button]').disabled, false);
});

test('colours are only disabled when no size of that colour is in stock', () => {
  const { input } = setup();
  for (const c of ['Silver', 'Black', 'White']) assert.equal(input(0, c).disabled, false, c);
});

test('quantity is capped at stock for tracked, deny-policy variants', () => {
  const { choose, $ } = setup();
  choose(1, '18 Ltr'); // 1 left
  const qty = $('[data-quantity-input]');
  const [minus, plus] = $('quantity-stepper').querySelectorAll('[data-step]');
  assert.equal(qty.max, '1');
  assert.equal(plus.disabled, true);
  assert.equal(minus.disabled, true);
});

test('an unavailable variant cannot be added: button disabled and submit blocked before any request', async () => {
  const { $, cart, window } = setup({ variantId: byTitle('Black / 12 Ltr').id }); // e.g. ?variant= deep link
  const btn = $('[data-add-button]');
  assert.equal(btn.disabled, true);
  assert.equal($('[data-add-label]').textContent, 'Sold out');
  $('[data-product-form]').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cart.requests.length, 0);
  assert.equal($('[data-form-error]').hidden, false);
});

test('add to cart posts the selected variant id and quantity, then opens the drawer with fresh HTML', async () => {
  const { $, choose, cart, window, wait } = setup();
  choose(0, 'Black'); // Black / 8 Ltr
  const qty = $('[data-quantity-input]');
  $('quantity-stepper [data-step="1"]').click();
  assert.equal(qty.value, '2');
  $('[data-product-form]').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await wait(40);
  const req = cart.requests.find((r) => r.url.endsWith('cart/add.js'));
  assert.deepEqual(req.body.items, [{ id: byTitle('Black / 8 Ltr').id, quantity: 2 }]);
  assert.deepEqual(req.body.sections, ['custom-cart-drawer', 'cart-icon-bubble']);
  const drawer = $('cart-drawer-custom');
  assert.ok(drawer.classList.contains('is-open'));
  assert.equal(drawer.hasAttribute('inert'), false);
  assert.equal(drawer.querySelectorAll('[data-line-key]').length, 1);
  assert.equal($('#cart-icon-bubble .count').textContent, '2');
});

test('Shopify 422 on add (more than stock) is shown to the shopper', async () => {
  const { $, choose, window, wait } = setup();
  choose(1, '18 Ltr'); // 1 in stock
  $('[data-product-form]').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await wait(30);
  $('[data-product-form]').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await wait(30);
  assert.match($('[data-form-error]').textContent, /can't add more/);
});

test('drawer: rapid + clicks are debounced into one change.js keyed by line key', async () => {
  const { window, wait, cart, $ } = setup();
  await window.CustomCart.add([{ id: VARIANTS[0].id, quantity: 1 }]);
  const line = $('[data-line-key]');
  const key = line.dataset.lineKey;
  for (let i = 0; i < 3; i++) $('[data-qty-step="1"]').click();
  assert.equal($('[data-qty-input]').value, '4'); // optimistic
  await wait(500);
  const changes = cart.requests.filter((r) => r.url.endsWith('cart/change.js'));
  assert.equal(changes.length, 1);
  assert.deepEqual({ id: changes[0].body.id, quantity: changes[0].body.quantity }, { id: key, quantity: 4 });
  assert.equal(cart.lines[0].quantity, 4);
  assert.equal($('[data-qty-input]').value, '4');
});

test('drawer: a click during an in-flight request is not lost when the response re-renders', async () => {
  const { window, wait, cart, $ } = setup();
  await window.CustomCart.add([{ id: VARIANTS[0].id, quantity: 1 }]);
  $('[data-qty-step="1"]').click(); // -> 2
  await wait(360); // debounce fires, request in flight
  $('[data-qty-step="1"]').click(); // -> 3 while the response for 2 is coming back
  await wait(500);
  assert.equal(cart.lines[0].quantity, 3);
  assert.equal($('[data-qty-input]').value, '3');
});

test('drawer: remove sends quantity 0 and shows the empty state', async () => {
  const { window, wait, cart, $ } = setup();
  await window.CustomCart.add([{ id: VARIANTS[0].id, quantity: 2 }]);
  $('[data-remove]').click();
  await wait(50);
  assert.equal(cart.lines.length, 0);
  assert.match($('[data-cart-render]').textContent, /Your cart is empty/);
});

test('drawer: a failed change re-syncs to the real cart and shows the error on the line', async () => {
  const { window, wait, cart, $ } = setup();
  await window.CustomCart.add([{ id: VARIANTS[0].id, quantity: 1 }]);
  cart.failChangeWith('Only 12 left.');
  $('[data-qty-step="1"]').click();
  await wait(500);
  assert.equal($('[data-qty-input]').value, '1'); // back to the server's truth
  const err = $('[data-line-error]');
  assert.equal(err.hidden, false);
  assert.equal(err.textContent, 'Only 12 left.');
});

test('drawer: Escape closes and returns focus; header cart icon opens it', async () => {
  const { window, $ } = setup();
  const icon = $('#cart-icon-bubble');
  icon.focus();
  icon.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const drawer = $('cart-drawer-custom');
  assert.ok(drawer.classList.contains('is-open'));
  drawer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(drawer.classList.contains('is-open'), false);
  assert.equal(window.document.activeElement, icon);
});

test('pincode: invalid, unserviceable and serviceable answers; success saves the pincode to the cart', async () => {
  const { $, window, wait, cart } = setup();
  const input = $('[data-pincode-input]');
  const submit = () => $('[data-pincode-form]').dispatchEvent(new window.Event('submit', { cancelable: true }));
  input.value = '12345';
  submit(); await wait(10);
  assert.match($('[data-pincode-result]').className, /is-error/);
  assert.equal(input.getAttribute('aria-invalid'), 'true');

  input.value = '999999';
  submit(); await wait(10);
  assert.match($('[data-pincode-result]').textContent, /don’t deliver to 999999/);

  input.value = '560001';
  submit(); await wait(30);
  assert.match($('[data-pincode-result]').className, /is-success/);
  assert.match($('[data-pincode-result]').textContent, /Express delivery available\. Delivery by/);
  const update = cart.requests.find((r) => r.url.endsWith('cart/update.js'));
  assert.deepEqual(update.body.attributes, { 'Delivery pincode': '560001' });
});

test('pincode: a sold-out variant is never reported as deliverable', async () => {
  const { $, window, wait } = setup({ variantId: byTitle('Black / 12 Ltr').id });
  $('[data-pincode-input]').value = '560001';
  $('[data-pincode-form]').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await wait(10);
  assert.match($('[data-pincode-result]').textContent, /out of stock/);
});
