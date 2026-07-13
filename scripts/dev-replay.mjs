// Browser-local replay acceptance driver.
// Usage: node scripts/dev-replay.mjs <file.rpy> [stage=1] [frames=300] [shot.png] [mode=0]
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const [fileArg, stageArg = '1', framesArg = '300', out = '/tmp/th07-replay.png', modeArg = '0'] = process.argv.slice(2);
if (!fileArg) {
  console.error('usage: node scripts/dev-replay.mjs <file.rpy> [stage] [frames] [shot.png] [mode]');
  process.exit(2);
}
const wantedStage = Number(stageArg);
const frames = Number(framesArg);
const mode = Number(modeArg);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.map': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const data = await readFile(join(root, p));
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((done) => server.listen(0, done));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error).slice(0, 240)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 240)); });

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
  await page.goto(`http://127.0.0.1:${port}/index.html?test=1&menu=1&paused=1`);
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
  console.log(JSON.stringify(snap));
  if (errors.length) console.log('PAGE ERRORS:', JSON.stringify([...new Set(errors)].slice(0, 5)));
} finally {
  await browser.close();
  server.close();
}
