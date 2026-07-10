// Drives the real arcade Stage 1 clear confirmation into Stage 2 and checks
// that every run-global field is carried through StageScene#carryState.
// Run `npm run build` first.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.map': 'application/json'
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') path = '/index.html';
    const data = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
});
const errors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 300));
  });
  await page.goto(
    `http://127.0.0.1:${port}/index.html?test=1&arcade=1&difficulty=3&stage=1&power=128`
  );
  await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 30000 });
  await page.evaluate(() => window.__TH07_TEST__.pause());

  let clear = null;
  for (let frame = 0; frame < 16000; frame += 30) {
    await page.evaluate(() => {
      window.__TH07_TEST__.setLives(8);
      window.__TH07_TEST__.setInvuln(300);
      for (let i = 0; i < 30; i++) {
        window.__TH07_TEST__.inject(['shoot', 'skip'], i % 15 === 0 ? ['shoot'] : []);
        if (window.__TH07_TEST__.snapshot().bossActive) window.__TH07_TEST__.damageBoss(300);
        window.__TH07_TEST__.advance(1);
      }
    });
    const snap = await page.evaluate(() => window.__TH07_TEST__.snapshot());
    if (snap.stageClear) {
      clear = snap;
      break;
    }
  }
  assert.ok(clear, 'Stage 1 did not reach its clear tally');
  assert.equal(clear.stageNumber, 1);
  assert.equal(clear.mode, 'arcade');

  // stageClearTimer starts at zero on the clear frame. Let it pass the
  // 90-frame confirmation lock without pressing Z, then snapshot the exact
  // carry source state immediately before the transition.
  await page.evaluate(() => {
    for (let i = 0; i < 91; i++) {
      window.__TH07_TEST__.setInvuln(300);
      window.__TH07_TEST__.inject([], []);
      window.__TH07_TEST__.advance(1);
    }
  });
  const before = await page.evaluate(() => window.__TH07_TEST__.snapshot());
  assert.equal(before.stageNumber, 1);
  assert.equal(before.stageClear, true);

  await page.evaluate(() => {
    window.__TH07_TEST__.inject([], ['shoot']);
    window.__TH07_TEST__.advance(1);
  });
  const after = await page.evaluate(() => window.__TH07_TEST__.snapshot());
  const bgm = await page.evaluate(() => window.__TH07_TEST__.bgm());
  assert.equal(after.stageNumber, 2);
  assert.equal(after.stageClear, false);
  assert.equal(after.mode, 'arcade');
  assert.equal(after.difficulty, before.difficulty);
  assert.equal(after.character, before.character);

  const carried = {
    score: after.score,
    hiScore: after.hiScore,
    graze: after.graze,
    pointItems: after.pointItems,
    lives: after.player.lives,
    bombs: after.player.bombs,
    power: after.player.power,
    cherry: after.cherry.c,
    cherryMax: after.cherry.max,
    cherryPlus: after.cherry.plus,
    spellsCaptured: after.spellsCaptured
  };
  const expected = {
    score: before.score,
    hiScore: Math.max(before.hiScore, before.score),
    graze: before.graze,
    pointItems: before.pointItems,
    lives: before.player.lives,
    bombs: before.player.bombs,
    power: before.player.power,
    cherry: before.cherry.c,
    cherryMax: before.cherry.max,
    cherryPlus: before.cherry.plus,
    spellsCaptured: before.spellsCaptured
  };
  assert.deepEqual(carried, expected);
  assert.equal(bgm.active, 'th07_04');
  assert.deepEqual(errors, []);

  await page.screenshot({ path: '/tmp/arcade-stage2-intro.png' });
  console.log(JSON.stringify({
    clearFrame: clear.frame,
    fromStage: before.stageNumber,
    toStage: after.stageNumber,
    carried,
    bgm: bgm.active,
    pageErrors: errors.length
  }));
} finally {
  await browser.close();
  server.close();
}
