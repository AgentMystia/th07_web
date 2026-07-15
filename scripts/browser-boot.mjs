import { resolve } from 'node:path';
import { attachPageDiagnostics, launchChromium, startStaticServer, uniqueErrors } from './lib/browser-harness.mjs';

const root = resolve(process.argv[2] ?? '.');
const frames = Number(process.argv[3] ?? 300);
const server = await startStaticServer(root);
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const errors = attachPageDiagnostics(page);
try {
  await page.goto(`${server.baseUrl}/index.html?test=1&paused=1&difficulty=3`);
  await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 30000 });
  await page.evaluate((count) => window.__TH07_TEST__.advance(count), frames);
  const snapshot = await page.evaluate(() => window.__TH07_TEST__.snapshot());
  console.log(JSON.stringify(snapshot));
  const pageErrors = uniqueErrors(errors);
  if (pageErrors.length) {
    console.error('PAGE ERRORS:', JSON.stringify(pageErrors.slice(0, 5)));
    process.exitCode = 4;
  } else if ((snapshot.enemies ?? 0) < 1) {
    console.error('BOOT FAILED: no enemies spawned');
    process.exitCode = 5;
  }
} finally {
  await browser.close();
  await server.close();
}
