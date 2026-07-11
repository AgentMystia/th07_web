// PLAYER-002 live probe: drives a real hit into the deathbomb window and
// verifies, against the running game (?test=1), the meter model, the Held
// bomb rescue, the state-2 main-sprite visibility (pixel evidence), and the
// full miss sequence (squish -> respawn -> mode-2 drops).
// Usage: node scripts/player-probe.mjs [shot=reimuA]
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import assert from 'node:assert/strict';

const shot = process.argv[2] ?? 'reimuA';
const WINDOWS = { reimu: 15, marisa: 8, sakuya: 6 };
const N = WINDOWS[shot.replace(/[AB]$/, '')];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.map': 'application/json'
};
const root = new URL('..', import.meta.url).pathname;
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
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
});
const errors = [];

async function openStage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  await page.goto(`http://127.0.0.1:${port}/index.html?test=1&difficulty=3&stage=1&power=0&shot=${shot}`);
  await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 20000 });
  await page.evaluate(() => window.__TH07_TEST__.pause());
  return page;
}
const snapshot = (page) => page.evaluate(() => window.__TH07_TEST__.snapshot());

// Advance until live enemy bullets exist, then park a real bullet on the
// player with spawn-invuln off so the next frame lands a genuine hit.
async function forceHit(page) {
  for (let f = 0; f < 3600; f += 30) {
    await page.evaluate(() => {
      window.__TH07_TEST__.setLives(8);
      window.__TH07_TEST__.setInvuln(60);
      window.__TH07_TEST__.advance(30);
    });
    if ((await snapshot(page)).bullets > 0) break;
  }
  await page.evaluate(() => {
    window.__TH07_TEST__.setInvuln(0);
    if (!window.__TH07_TEST__.primeBorderCollision()) throw new Error('no bullet to prime');
    window.__TH07_TEST__.advance(1);
  });
  const snap = await snapshot(page);
  assert.equal(snap.player.hitState, true, 'hit landed: deathbomb window open');
  return snap;
}

// Max brightness on a small cross around the player center. The canvas
// backing store is 640x480, so pixelAt takes game coordinates directly.
async function playerBrightness(page, snap) {
  const cx = Math.round(32 + snap.player.x);
  const cy = Math.round(16 + snap.player.y);
  const pts = [[0, 0], [0, -4], [0, 4], [-3, 0], [3, 0], [0, -8], [0, 8]];
  let best = 0;
  for (const [dx, dy] of pts) {
    const rgba = await page.evaluate(([x, y]) => window.__TH07_TEST__.pixelAt(x, y), [cx + dx, cy + dy]);
    best = Math.max(best, (rgba[0] + rgba[1] + rgba[2]) / 3);
  }
  return best;
}

// --- Scenario 1: rescue by a held bomb late in the window ---------------
{
  const page = await openStage();
  const hit = await forceHit(page);
  assert.equal(hit.player.deathbombMeter, N, `meter still ${N} on the hit frame (tick order)`);
  // State-2 visibility: the main sprite must be drawn during the window.
  const bright = await playerBrightness(page, hit);
  assert.ok(bright >= 100, `player sprite visible in the window (max brightness ${bright})`);
  // Burn all but the last legal frame, then rescue with a HELD bomb (no edge).
  await page.evaluate((n) => {
    for (let i = 0; i < n; i++) window.__TH07_TEST__.advance(1);
  }, N - 1);
  const lastFrame = await snapshot(page);
  assert.equal(lastFrame.player.hitState, true, 'window still open on its last legal frame');
  assert.equal(lastFrame.player.deathbombMeter, 1);
  const before = lastFrame.player;
  await page.evaluate(() => {
    window.__TH07_TEST__.inject(['bomb'], []); // held only, no press edge
    window.__TH07_TEST__.advance(1);
    window.__TH07_TEST__.clearInput();
  });
  const after = (await snapshot(page)).player;
  assert.equal(after.hitState, false, 'held-only bomb rescued at the last frame');
  assert.equal(after.bombs, before.bombs - 1, 'exactly one bomb spent');
  assert.equal(after.lives, before.lives, 'no miss');
  assert.equal(after.deathbombMeter, Math.min(N, 7), 'meter min(N, 1+6) after the late rescue');
  console.log(JSON.stringify({ scenario: 'deathbomb-rescue', shot, window: N, meterAfter: after.deathbombMeter, brightness: Math.round(bright) }));
  await page.close();
}

// --- Scenario 2: no bomb -> full miss sequence ---------------------------
{
  const page = await openStage();
  await forceHit(page);
  // Run the window out plus one commit frame.
  await page.evaluate((n) => {
    for (let i = 0; i < n; i++) window.__TH07_TEST__.advance(1);
  }, N);
  const committed = await snapshot(page);
  assert.equal(committed.player.hitState, false, 'window lapsed');
  assert.ok(committed.player.dyingFrame >= 0, 'death squish running');
  const tweens = committed.itemDump.filter((it) => it.state === 2);
  assert.ok(tweens.length >= 5, `death drops in mode-2 tween (${tweens.length})`);
  const livesBefore = committed.player.lives;
  await page.evaluate(() => {
    for (let i = 0; i < 31; i++) window.__TH07_TEST__.advance(1);
  });
  const respawned = await snapshot(page);
  assert.equal(respawned.player.lives, livesBefore - 1, 'life lost at the respawn teleport');
  assert.ok(respawned.player.materializeFrame >= 0, 'materialize running');
  assert.equal(respawned.player.deathbombMeter, 0, 'meter pinned at 0 during materialize');
  assert.equal(respawned.player.x, 192);
  assert.equal(respawned.player.y, 384);
  await page.evaluate(() => {
    for (let i = 0; i < 31; i++) window.__TH07_TEST__.advance(1);
  });
  const settled = await snapshot(page);
  assert.equal(settled.player.materializeFrame, -1, 'materialize done');
  assert.equal(settled.player.deathbombMeter, N, 'meter reseeded at the invuln handoff');
  assert.ok(settled.player.invuln > 200, '240-tick respawn invulnerability');
  console.log(JSON.stringify({ scenario: 'deathbomb-miss', shot, drops: tweens.length, meterReseed: settled.player.deathbombMeter }));
  await page.close();
}

if (errors.length) {
  console.log('PAGE ERRORS', errors.slice(0, 5));
  process.exitCode = 1;
} else {
  console.log('OK');
}
await browser.close();
server.close();
