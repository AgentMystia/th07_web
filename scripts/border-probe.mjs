// Deterministic Supernatural Border lifecycle probe. Run `npm run build`
// first; assertions cover hit-break, bomb-break, and natural expiry.
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

async function openStage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 300));
  });
  await page.goto(`http://127.0.0.1:${port}/index.html?test=1&difficulty=3&stage=1&power=128`);
  await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 20000 });
  await page.evaluate(() => window.__TH07_TEST__.pause());
  return page;
}

async function snapshot(page) {
  return page.evaluate(() => window.__TH07_TEST__.snapshot());
}

async function advance(page, frames, setup = {}) {
  await page.evaluate(({ frames, setup }) => {
    if (setup.lives != null) window.__TH07_TEST__.setLives(setup.lives);
    if (setup.invuln != null) window.__TH07_TEST__.setInvuln(setup.invuln);
    if (setup.clearBullets) window.__TH07_TEST__.clearEnemyBullets();
    if (setup.pressed) window.__TH07_TEST__.inject([], setup.pressed);
    window.__TH07_TEST__.advance(frames);
  }, { frames, setup });
}

try {
  // Hit break: source bullet vanishes without an item; the expanding field
  // later converts only the non-immune bullet at 160px to its type-8 petal.
  const hitPage = await openStage();
  for (let frame = 0; frame < 1800; frame += 30) {
    await advance(hitPage, 30, { lives: 8, invuln: 60 });
    if ((await snapshot(hitPage)).bullets > 0) break;
  }
  await hitPage.evaluate(() => {
    window.__TH07_TEST__.setInvuln(0);
    window.__TH07_TEST__.addCherry(50000);
    if (!window.__TH07_TEST__.primeBorderCollision()) throw new Error('no real bullet template');
  });
  const hitBefore = await snapshot(hitPage);
  const [directId, sweptId, immuneId] = hitBefore.bulletDump.map((bullet) => bullet.id);
  await advance(hitPage, 1);
  const hitAfter = await snapshot(hitPage);
  assert.equal(hitAfter.player.lives, hitBefore.player.lives);
  assert.equal(hitAfter.player.bombs, hitBefore.player.bombs);
  assert.equal(hitAfter.player.deathTimer, -1);
  assert.equal(hitAfter.player.invuln, 40);
  assert.equal(hitAfter.cherry.border, 0);
  assert.equal(hitAfter.cherry.clearWave.radius, 32);
  assert.equal(hitAfter.cherry.clearWave.ticksLeft, 50);
  assert.equal(hitAfter.bulletDump.filter((bullet) => bullet.dead).length, 1);
  await advance(hitPage, 9);
  const hitWave = await snapshot(hitPage);
  assert.equal(hitWave.cherry.clearWave.radius, 176);
  assert.equal(hitWave.cherry.clearWave.ticksLeft, 41);
  assert.equal(hitWave.bulletDump.some((bullet) => bullet.id === directId), false);
  assert.equal(hitWave.bulletDump.some((bullet) => bullet.id === sweptId), false);
  const immune = hitWave.bulletDump.find((bullet) => bullet.id === immuneId);
  assert.ok(immune, '0x1000-immune fixture bullet must survive the expanding field');
  assert.equal(immune.flags & 0x1000, 0x1000);
  assert.equal(hitWave.cherry.plus, 0);
  assert.equal(hitWave.cherry.border, 0);
  const waveItem = hitWave.itemDump.find((item) => item.type === 'pointBullet');
  assert.ok(waveItem, 'Border-break circle must spawn the exe type-8 petal');

  // Collect the petal and pin its exact economy. The 0x1000 fixture shares
  // the wave region; zone-result precedence keeps it alive even on contact.
  await hitPage.evaluate(({ x, y }) => window.__TH07_TEST__.setPlayer(x, y), waveItem);
  const pickupBefore = await snapshot(hitPage);
  await advance(hitPage, 1);
  const pickupAfter = await snapshot(hitPage);
  assert.equal(pickupAfter.items, pickupBefore.items - 1);
  assert.equal(pickupAfter.cherry.plus, pickupBefore.cherry.plus + 30);
  assert.equal(pickupAfter.cherry.c, pickupBefore.cherry.c + 100);
  assert.equal(pickupAfter.bulletDump.find((bullet) => bullet.id === immuneId)?.dead, false);
  await advance(hitPage, 120);
  const noLoop = await snapshot(hitPage);
  assert.equal(noLoop.cherry.border, 0);
  assert.ok(noLoop.cherry.plus < 50000);
  await hitPage.screenshot({ path: '/tmp/border-break.png' });
  await hitPage.close();

  // Player states 1/2/3 consume a touching bullet without an item. This is
  // the generic FUN_0043b200 behavior, not a Border-only shield.
  const shieldPage = await openStage();
  for (let frame = 0; frame < 1800; frame += 30) {
    await advance(shieldPage, 30, { lives: 8, invuln: 60 });
    if ((await snapshot(shieldPage)).bullets > 0) break;
  }
  await shieldPage.evaluate(() => {
    window.__TH07_TEST__.setInvuln(40);
    if (!window.__TH07_TEST__.primeBorderCollision()) throw new Error('no real bullet template');
  });
  const shieldBefore = await snapshot(shieldPage);
  const shieldBulletId = shieldBefore.bulletDump[0].id;
  await advance(shieldPage, 1);
  const shieldContact = await snapshot(shieldPage);
  assert.equal(shieldContact.bulletDump.find((bullet) => bullet.id === shieldBulletId)?.dead, true);
  assert.equal(shieldContact.items, shieldBefore.items);
  assert.equal(shieldContact.cherry.border, 0);
  await advance(shieldPage, 1);
  const shieldAfter = await snapshot(shieldPage);
  assert.equal(shieldAfter.bulletDump.some((bullet) => bullet.id === shieldBulletId), false);
  await shieldPage.close();

  // Bomb break: free cancel. Because the bomb input runs after the zone
  // updater in the exe, the creation frame remains radius 32/ticks 50.
  const bombPage = await openStage();
  await bombPage.evaluate(() => {
    window.__TH07_TEST__.setInvuln(0);
    window.__TH07_TEST__.addCherry(50000);
  });
  const bombBefore = await snapshot(bombPage);
  await advance(bombPage, 1, { pressed: ['bomb'] });
  const bombAfter = await snapshot(bombPage);
  assert.equal(bombAfter.player.bombs, bombBefore.player.bombs);
  assert.equal(bombAfter.player.lives, bombBefore.player.lives);
  assert.equal(bombAfter.player.deathTimer, -1);
  assert.equal(bombAfter.player.invuln, 39);
  assert.equal(bombAfter.cherry.border, 0);
  assert.equal(bombAfter.cherry.clearWave.radius, 32);
  assert.equal(bombAfter.cherry.clearWave.ticksLeft, 50);
  await bombPage.close();

  // Natural expiry: hold ordinary state-3 invulnerability until the last
  // tick so enemy fire cannot perturb the payout, then assert the exact
  // post-+10000 score/display ordering from FUN_0043e620.
  const bonusPage = await openStage();
  await bonusPage.evaluate(() => {
    window.__TH07_TEST__.setPlayer(0, 448);
    window.__TH07_TEST__.setInvuln(0);
    window.__TH07_TEST__.addCherry(50000);
  });
  const start = await snapshot(bonusPage);
  assert.equal(start.cherry.border, 540);
  assert.equal(start.cherry.message.type, 2);
  for (let frame = 0; frame < 510; frame += 30) {
    await advance(bonusPage, 30, { lives: 8, invuln: 30, clearBullets: true });
  }
  await advance(bonusPage, 29, { lives: 8, invuln: 30, clearBullets: true });
  const bonusBefore = await snapshot(bonusPage);
  assert.equal(bonusBefore.cherry.border, 1);
  await advance(bonusPage, 1, { clearBullets: true });
  const bonusAfter = await snapshot(bonusPage);
  assert.equal(bonusAfter.cherry.border, 0);
  assert.equal(bonusAfter.cherry.c, bonusBefore.cherry.c + 10000);
  assert.equal(bonusAfter.cherry.max, bonusBefore.cherry.max + 10000);
  assert.equal(bonusAfter.score - bonusBefore.score, bonusAfter.cherry.c);
  assert.equal(bonusAfter.player.invuln, 40);
  assert.equal(bonusAfter.cherry.clearWave, null);
  assert.equal(bonusAfter.cherry.message.type, 4);
  assert.equal(bonusAfter.cherry.message.value, bonusAfter.cherry.c * 10);
  assert.equal(bonusAfter.cherry.message.age, 0);
  assert.equal(bonusAfter.cherry.message.timer, 180);
  await advance(bonusPage, 30, { clearBullets: true });
  await bonusPage.screenshot({ path: '/tmp/border-bonus.png' });
  await bonusPage.close();

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    hit: {
      lives: hitAfter.player.lives,
      invuln: hitAfter.player.invuln,
      initialWave: hitAfter.cherry.clearWave,
      expandedWave: hitWave.cherry.clearWave,
      waveItemTypes: hitWave.itemDump.map((item) => item.type),
      cherryPlusAfterPickup: pickupAfter.cherry.plus,
      immuneSurvivedWaveContact:
        pickupAfter.bulletDump.find((bullet) => bullet.id === immuneId)?.dead === false,
      fixtureIds: { directId, sweptId, immuneId },
      remainingFixtureIds: hitWave.bulletDump
        .filter((bullet) => [directId, sweptId, immuneId].includes(bullet.id))
        .map((bullet) => bullet.id)
    },
    bomb: {
      bombsBefore: bombBefore.player.bombs,
      bombsAfter: bombAfter.player.bombs,
      invuln: bombAfter.player.invuln,
      wave: bombAfter.cherry.clearWave
    },
    invulnerability: {
      consumedWithoutItem: !shieldAfter.bulletDump.some((bullet) => bullet.id === shieldBulletId)
    },
    natural: {
      scoreDelta: bonusAfter.score - bonusBefore.score,
      cherry: bonusAfter.cherry.c,
      cherryMax: bonusAfter.cherry.max,
      invuln: bonusAfter.player.invuln,
      message: bonusAfter.cherry.message
    }
  }));
} finally {
  await browser.close();
  server.close();
}
