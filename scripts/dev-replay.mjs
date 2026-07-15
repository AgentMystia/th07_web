// Browser-local replay acceptance driver.
// Usage: node scripts/dev-replay.mjs <file.rpy> [stage=1] [frames=300] [shot.png] [mode=0] [query]
import { resolve } from 'node:path';
import { attachPageDiagnostics, launchChromium, startStaticServer, uniqueErrors } from './lib/browser-harness.mjs';

const [
  fileArg, stageArg = '1', framesArg = '300', out = '/tmp/th07-replay.png',
  modeArg = '0', queryArg = ''
] = process.argv.slice(2);
if (!fileArg) {
  console.error('usage: node scripts/dev-replay.mjs <file.rpy> [stage] [frames] [shot.png] [mode] [query]');
  process.exit(2);
}
const wantedStage = Number(stageArg);
const frames = Number(framesArg);
const mode = Number(modeArg);
const server = await startStaticServer();
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const errors = attachPageDiagnostics(page);

const advance = (n) => page.evaluate((count) => window.__TH07_TEST__.advance(count), n);
const press = async (key) => {
  await page.evaluate((button) => {
    window.__TH07_TEST__.inject([], [button]);
    window.__TH07_TEST__.advance(1);
    window.__TH07_TEST__.inject([], []);
    window.__TH07_TEST__.advance(1);
  }, key);
};

try {
  const extraQuery = queryArg ? `&${queryArg.replace(/^&/, '')}` : '';
  await page.goto(`${server.baseUrl}/index.html?test=1&menu=1&paused=1${extraQuery}`);
  await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 20000 });
  await page.locator('#replay-file').setInputFiles(resolve(fileArg));
  await page.waitForFunction(() => window.__TH07_TEST__.snapshot().scene === 'replay');
  let snap = await page.evaluate(() => window.__TH07_TEST__.snapshot());
  while (snap.stage !== wantedStage) {
    await press('down');
    snap = await page.evaluate(() => window.__TH07_TEST__.snapshot());
    if (snap.cursor === 0 && snap.stage !== wantedStage) throw new Error(`stage ${wantedStage} is not present in replay`);
  }
  await press('confirm');
  for (let i = 0; i < mode; i++) await press('down');
  await press('confirm');
  await advance(30 + frames);
  await page.screenshot({ path: out });
  snap = await page.evaluate(() => window.__TH07_TEST__.snapshot());
  const canvas = await page.evaluate(() => window.__TH07_TEST__.canvasContextAttributes());
  console.log(JSON.stringify({ ...snap, canvas }));
  const pageErrors = uniqueErrors(errors);
  if (pageErrors.length) {
    console.log('PAGE ERRORS:', JSON.stringify(pageErrors.slice(0, 5)));
    process.exitCode = 4;
  }
} finally {
  await browser.close();
  await server.close();
}
