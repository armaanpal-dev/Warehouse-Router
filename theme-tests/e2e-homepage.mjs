// Homepage check: the custom product section renders with the milk cooler, adds to cart, and
// does not rewrite the homepage URL with ?variant=.
import { chromium } from 'playwright-core';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:9292';
const OUT = process.argv[2] || './e2e-shots';
const EXE = process.env.CHROMIUM || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: EXE });
for (const [label, viewport] of [['desktop', { width: 1366, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport });
  await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('product-page', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  check(`${label}: homepage has the product section`, await page.locator('product-page').count() === 1);
  check(`${label}: title is an h2 link to the product`, (await page.locator('h2.cp__title a').getAttribute('href'))?.includes('/products/precise-milk-cooler'));
  await page.locator('fieldset[data-option-index="1"] label:has(.cp-variants__text:text-is("12 Ltr"))').click();
  check(`${label}: variant change updates price`, (await page.locator('[data-price]').innerText()).includes('2,890'));
  check(`${label}: homepage URL not rewritten`, !page.url().includes('variant='), page.url());
  const resp = page.waitForResponse((r) => r.url().includes('/cart/add.js'));
  await page.locator('[data-add-button]').click();
  check(`${label}: add to cart works`, (await resp).status() === 200);
  await page.waitForSelector('cart-drawer-custom.is-open');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/home-${label}.png` });
  await page.evaluate(() => fetch('/cart/clear.js', { method: 'POST' }));
  await page.close();
}
await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
