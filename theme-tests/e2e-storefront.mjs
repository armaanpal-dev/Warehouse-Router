// End-to-end check of the product page on the real store, via `shopify theme dev` (127.0.0.1:9292).
// Usage: node e2e-storefront.mjs [outDir]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:9292';
const OUT = process.argv[2] || './e2e-shots';
const EXE = process.env.CHROMIUM || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: EXE, headless: true });

async function run(label, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Ignore platform scripts the local theme-dev proxy (127.0.0.1) can't load cross-origin; page errors still count.
  page.on('console', (m) => { if (m.type() === 'error' && !/cdn\.shopify\.com\/shopifycloud|shop\.app|Failed to load resource|net::ERR_FAILED/.test(m.text())) errors.push(m.text()); });

  await page.goto(`${BASE}/products/precise-milk-cooler`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('product-page', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  const themeId = await page.evaluate(() => window.Shopify?.theme?.id);
  check(`${label}: rendered by Senior Assessment theme`, themeId === 131486187602, `Shopify.theme.id=${themeId}`);
  check(`${label}: custom section present`, await page.locator('product-page').count() === 1);
  await page.screenshot({ path: `${OUT}/${label}-1-initial.png`, fullPage: false });

  const price = () => page.locator('[data-price]').innerText();
  const sizeInput = (v) => page.locator(`fieldset[data-option-index="1"] input[value="${v}"]`);
  const pick = (opt, v) => page.locator(`fieldset[data-option-index="${opt}"] label:has(.cp-variants__text:text-is("${v}"))`).click();

  check(`${label}: initial price`, (await price()).includes('2,450'), await price());

  await pick(0, 'Black');
  check(`${label}: Black / 12 Ltr disabled (sold out)`, await sizeInput('12 Ltr').isDisabled());
  await pick(0, 'White');
  check(`${label}: White / 18 Ltr disabled (does not exist)`, await sizeInput('18 Ltr').isDisabled());
  await pick(0, 'Silver');
  await pick(1, '18 Ltr');
  check(`${label}: price updates to 18 Ltr`, (await price()).includes('3,590'), await price());
  check(`${label}: low-stock message`, (await page.locator('[data-stock]').innerText()).includes('Only 1 left'));
  check(`${label}: URL carries variant`, page.url().includes('variant=42753591541842'), page.url());
  await page.screenshot({ path: `${OUT}/${label}-2-silver18.png` });

  // Pincode
  const pin = page.locator('[data-pincode-input]');
  await pin.fill('12345'); await page.locator('[data-pincode-submit]').click();
  check(`${label}: invalid pincode error`, (await page.locator('[data-pincode-result]').innerText()).includes('valid 6-digit'));
  await pin.fill('999999'); await page.locator('[data-pincode-submit]').click();
  check(`${label}: unserviceable pincode`, (await page.locator('[data-pincode-result]').innerText()).includes('deliver to 999999'));
  await pin.fill('560001'); await page.locator('[data-pincode-submit]').click();
  await page.waitForTimeout(300);
  const pinText = await page.locator('[data-pincode-result]').innerText();
  check(`${label}: serviceable pincode`, pinText.includes('Delivery by'), pinText);
  await page.locator('pincode-checker').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${label}-3-pincode.png` });

  // Add to cart: Silver / 8 Ltr x2
  await pick(1, '8 Ltr');
  await page.locator('quantity-stepper [data-step="1"]').click();
  const addResp = page.waitForResponse((r) => r.url().includes('/cart/add.js'));
  await page.locator('[data-add-button]').click();
  const add = await addResp;
  const addBody = JSON.parse(add.request().postData());
  check(`${label}: add.js got variant + qty`, add.status() === 200 && addBody.items[0].id === 42753591476306 && addBody.items[0].quantity === 2, `${add.status()} ${JSON.stringify(addBody.items)} ${add.status() !== 200 ? await add.text() : ""}`);
  await page.waitForSelector('cart-drawer-custom.is-open');
  await page.waitForTimeout(400);
  check(`${label}: drawer opened with 1 line`, await page.locator('cart-drawer-custom [data-line-key]').count() === 1);
  const total1 = await page.locator('[data-cart-total]').innerText();
  check(`${label}: drawer total`, total1.includes('4,620'), total1);
  await page.screenshot({ path: `${OUT}/${label}-4-drawer.png` });

  // Quantity +1 (debounced) -> 3
  const chg = page.waitForResponse((r) => r.url().includes('/cart/change.js'));
  await page.locator('cart-drawer-custom [data-qty-step="1"]').click();
  await chg; await page.waitForTimeout(300);
  const total2 = await page.locator('[data-cart-total]').innerText();
  check(`${label}: qty update refreshes total`, total2.includes('6,930'), total2);
  const bubble = await page.locator('#cart-icon-bubble').innerText();
  check(`${label}: header count updated`, bubble.includes('3'), bubble.replace(/\s+/g, ' '));

  // Remove
  const rm = page.waitForResponse((r) => r.url().includes('/cart/change.js'));
  await page.locator('cart-drawer-custom [data-remove]').click();
  await rm; await page.waitForTimeout(300);
  check(`${label}: remove empties cart`, (await page.locator('[data-cart-render]').innerText()).includes('Your cart is empty'));
  await page.keyboard.press('Escape');

  // Stock guard: Silver / 18 Ltr has 1 — second add must be refused by Shopify and shown.
  await pick(1, '18 Ltr');
  await page.locator('[data-add-button]').click();
  await page.waitForSelector('cart-drawer-custom.is-open'); await page.keyboard.press('Escape');
  const second = page.waitForResponse((r) => r.url().includes('/cart/add.js'));
  await page.locator('[data-add-button]').click();
  const r2 = await second;
  await page.waitForTimeout(200);
  const err = await page.locator('[data-form-error]').innerText();
  check(`${label}: over-stock add refused and shown`, r2.status() === 422 && err.length > 0, `${r2.status()} ${err}`);

  // Horizontal overflow (mobile layout sanity)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${label}: no horizontal scroll`, overflow <= 0, `overflow ${overflow}px`);
  check(`${label}: no JS errors`, errors.length === 0, errors.join(' | ').slice(0, 300));

  // clean the cart for the next run
  await page.evaluate(() => fetch('/cart/clear.js', { method: 'POST' }));
  await ctx.close();
}

await run('desktop', { width: 1366, height: 900 });
await run('mobile', { width: 390, height: 844 });
await browser.close();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
