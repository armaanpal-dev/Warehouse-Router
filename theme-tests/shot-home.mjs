// Screenshot the homepage at desktop and mobile widths. Usage: node shot-home.mjs [outDir]
import { chromium } from 'playwright-core';
import path from 'node:path';
const OUT = process.argv[2] || './e2e-shots';
const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe') });
for (const [label, viewport] of [['desktop', { width: 1366, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport });
  await page.goto('http://127.0.0.1:9292/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => ({
    theme: window.Shopify?.theme?.id,
    banner: !!document.querySelector('.banner'),
    productSection: !!document.querySelector('product-page'),
    heading: document.querySelector('.banner__heading')?.textContent.trim(),
    button: document.querySelector('.banner__buttons a')?.getAttribute('href'),
  }));
  console.log(label, JSON.stringify(info));
  await page.screenshot({ path: `${OUT}/banner-${label}.png` });
  await page.close();
}
await browser.close();
