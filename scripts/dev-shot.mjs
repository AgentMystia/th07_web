// Dev screenshot tool: node scripts/dev-shot.mjs <outfile.png> [frames] [query] [heldKeys]
// e.g. node scripts/dev-shot.mjs /tmp/shot.png 900 "shot=marisaA&difficulty=1" shoot
// A heldKeys entry prefixed with + (e.g. "shoot,+bomb") is injected as a
// pressed edge on the first batch only — for actions that need a press edge
// (bombing) rather than a hold.
import { attachPageDiagnostics, launchChromium, startStaticServer, uniqueErrors } from './lib/browser-harness.mjs';

const [out = '/tmp/shot.png', framesArg = '300', query = '', held = ''] = process.argv.slice(2);
const frames = Number(framesArg);
const server = await startStaticServer();
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const errors = attachPageDiagnostics(page);
await page.goto(`${server.baseUrl}/index.html?test=1&paused=1${query ? '&' + query : ''}`);
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
const pageErrors = uniqueErrors(errors);
if (pageErrors.length) console.log('PAGE ERRORS:', JSON.stringify(pageErrors.slice(0, 5)));
await browser.close();
await server.close();
if (pageErrors.length) process.exitCode = 4;
