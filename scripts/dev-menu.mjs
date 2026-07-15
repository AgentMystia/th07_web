// Menu navigation screenshot helper. Drives edge-triggered key presses through
// the menu flow, screenshotting at each labelled step.
// Usage: node scripts/dev-menu.mjs <outdir> "<step1>;<step2>;..."
// Each step is "key@shotName" e.g. "confirm@title" presses confirm then shoots
// a PNG named <shotName>.png. "wait@x" advances without a press. Keys:
// up/down/left/right/confirm/back. A leading "N*" repeats the key N times.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { attachPageDiagnostics, launchChromium, startStaticServer, uniqueErrors } from './lib/browser-harness.mjs';

const [outdir = '/tmp/menu', script = 'shot@title'] = process.argv.slice(2);
await mkdir(outdir, { recursive: true });
const server = await startStaticServer();
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const errors = attachPageDiagnostics(page);
await page.goto(`${server.baseUrl}/index.html?test=1&menu=1&paused=1`);
await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 20000 });

// Edge-triggered press: inject as `pressed` for one sim frame, then clear.
async function press(key) {
  await page.evaluate((k) => {
    window.__TH07_TEST__.inject([], [k]);
    window.__TH07_TEST__.advance(1);
    window.__TH07_TEST__.inject([], []);
    window.__TH07_TEST__.advance(1);
  }, key);
}
async function settle(n = 40) {
  await page.evaluate((f) => window.__TH07_TEST__.advance(f), n);
}

await settle(130); // intro animations
for (const raw of script.split(';')) {
  const [action, name] = raw.split('@');
  let key = action, times = 1;
  const m = action.match(/^(\d+)\*(.+)$/);
  if (m) { times = Number(m[1]); key = m[2]; }
  if (key !== 'wait') {
    for (let i = 0; i < times; i++) { await press(key); await settle(10); }
  }
  await settle(40);
  const snap = await page.evaluate(() => window.__TH07_TEST__.snapshot());
  if (name) {
    await page.screenshot({ path: join(outdir, `${name}.png`) });
    console.log(`${name}:`, JSON.stringify(snap));
  }
}
const pageErrors = uniqueErrors(errors);
if (pageErrors.length) console.log('PAGE ERRORS:', JSON.stringify(pageErrors.slice(0, 5)));
await browser.close();
await server.close();
if (pageErrors.length) process.exitCode = 4;
