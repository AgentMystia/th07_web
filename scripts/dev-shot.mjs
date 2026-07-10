// Dev screenshot tool: node scripts/dev-shot.mjs <outfile.png> [frames] [query] [heldKeys]
// e.g. node scripts/dev-shot.mjs /tmp/shot.png 900 "shot=marisaA&difficulty=1" shoot
// A heldKeys entry prefixed with + (e.g. "shoot,+bomb") is injected as a
// pressed edge on the first batch only — for actions that need a press edge
// (bombing) rather than a hold.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const [out = '/tmp/shot.png', framesArg = '300', query = '', held = ''] = process.argv.slice(2);
const frames = Number(framesArg);
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
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${port}/index.html?test=1${query ? '&' + query : ''}`);
await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 20000 });
const keyArgs = held ? held.split(',') : [];
const heldKeys = keyArgs.filter((k) => !k.startsWith('+'));
const pressKeys = keyArgs.filter((k) => k.startsWith('+')).map((k) => k.slice(1));
for (let done = 0; done < frames; done += 30) {
  await page.evaluate(({ keys, pressed, n }) => {
    if (keys.length || pressed.length) window.__TH07_TEST__.inject(keys, pressed);
    window.__TH07_TEST__.advance(n);
  }, { keys: heldKeys, pressed: done === 0 ? pressKeys : [], n: Math.min(30, frames - done) });
}
await page.screenshot({ path: out });
const snap = await page.evaluate(() => window.__TH07_TEST__.snapshot());
const bgm = await page.evaluate(() => window.__TH07_TEST__.bgm());
console.log(JSON.stringify({
  frame: snap.frame,
  enemies: snap.enemies,
  bullets: snap.bullets,
  playerBullets: snap.playerBullets,
  score: snap.score,
  boss: snap.bossActive,
  spell: snap.spellName,
  cherry: snap.cherry,
  player: snap.player,
  bgm
}));
if (errors.length) console.log('PAGE ERRORS:', JSON.stringify(errors.slice(0, 5)));
await browser.close();
server.close();
