import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/popups-cancel';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/stage-scene.ts --bundle --format=esm --outfile=${outDir}/stage-scene.mjs --log-level=silent`);
const { StageScene } = await import('../tests/.build/popups-cancel/stage-scene.mjs');

function popupScene() {
  const scene = Object.create(StageScene.prototype);
  scene.slowRate = 1;
  scene.playerObj = { x: -1000, y: -1000 };
  scene.popupsLarge = Array.from({ length: 720 }, () => ({
    digits: [0], color: 0, x: 0, y: 0, timer: 0, timerFrac: 0, active: false
  }));
  scene.popupsSmall = Array.from({ length: 3 }, () => ({
    digits: [0], color: 0, x: 0, y: 0, timer: 0, timerFrac: 0, active: false
  }));
  scene.popupCursorLarge = 0;
  scene.popupCursorSmall = 0;
  return scene;
}

function cancelScene() {
  const scene = Object.create(StageScene.prototype);
  scene.id = 1;
  scene.playerObj = { power: 0 };
  scene.items = [];
  scene.enemyBullets = [];
  scene.enemyLasers = [];
  scene.postBombLaserCounter = 0;
  return scene;
}

function laser(overrides = {}) {
  return {
    inUse: true,
    flags: 0,
    state: 1,
    phaseFrame: 20,
    width: 12,
    displayWidth: 7,
    shrinkCutoff: 30,
    x: 10,
    y: 20,
    angle: 0,
    nearDist: 32,
    farDist: 97,
    ...overrides
  };
}

test('score popups rise 0.5px/tick, use the authored glyph banks, and retire after tick 60', () => {
  const scene = popupScene();
  scene.spawnScorePopup(10, 100, 200, 0xffffffff);
  const pop = scene.popupsLarge[0];
  const draws = [];
  const renderer = { drawSprite: (...args) => draws.push(args) };

  scene.drawPopups(renderer, 0, 0);
  assert.deepEqual(draws.map((d) => d.slice(1, 5)), [[8, 0, 8, 8], [0, 0, 8, 8]]);

  for (let i = 0; i < 52; i++) scene.updatePopups();
  draws.length = 0;
  scene.drawPopups(renderer, 0, 0);
  assert.deepEqual(draws.map((d) => d.slice(1, 5)), [[136, 0, 8, 8], [128, 0, 8, 8]]);

  for (let i = 52; i < 56; i++) scene.updatePopups();
  draws.length = 0;
  scene.drawPopups(renderer, 0, 0);
  assert.deepEqual(draws.map((d) => d.slice(1, 5)), [[136, 8, 8, 8], [128, 8, 8, 8]]);

  for (let i = 56; i < 60; i++) scene.updatePopups();
  assert.equal(pop.active, true);
  assert.equal(pop.y, 170);
  scene.updatePopups();
  assert.equal(pop.active, false);
});

test('PowerUp popup uses ascii.anm sprite 10 rather than the HUD digit strip', () => {
  const scene = popupScene();
  scene.spawnScorePopup(-1, 100, 200, 0xffffc0a0);
  const draws = [];
  scene.drawPopups({ drawSprite: (...args) => draws.push(args) }, 0, 0);
  assert.deepEqual(draws[0].slice(1, 5), [80, 0, 48, 8]);
});

test('FUN_00422ea0(1) converts live bullets and samples non-immune lasers every 32px', () => {
  const scene = cancelScene();
  scene.enemyBullets.push({ x: 1, y: 2 }, { x: 3, y: 4, dead: true });
  const normal = laser();
  const immune = laser({ x: 200, flags: 4 });
  scene.enemyLasers.push(normal, immune);

  scene.cancelBulletsToItems();

  assert.deepEqual(scene.items.map((it) => [it.type, it.x, it.y, it.state]), [
    ['cherry', 1, 2, 1],
    ['cherry', 10, 20, 1],
    ['cherry', 42, 20, 1],
    ['cherry', 74, 20, 1],
    ['cherry', 106, 20, 1]
  ]);
  assert.equal(scene.enemyBullets.length, 0);
  assert.equal(normal.state, 2);
  assert.equal(normal.width, 7);
  assert.equal(normal.shrinkCutoff, 0);
  assert.equal(immune.state, 1);
  assert.equal(scene.postBombLaserCounter, 10);
});

test('FUN_00423100 sweep converts immune lasers but excludes laser items from score total', () => {
  const scene = cancelScene();
  scene.enemyBullets.push({ x: 1, y: 2 }, { x: 3, y: 4, dead: true });
  scene.enemyLasers.push(laser({ flags: 4, nearDist: 0, farDist: 33 }));
  const popups = [];
  scene.spawnScorePopup = (...args) => popups.push(args);

  assert.equal(scene.sweepBulletsToItems(), 2000);
  assert.deepEqual(popups, [[2000, 1, 2, 0xffffffff]]);
  // Bullet + laser origin + d=0 + d=32. The duplicate origin is native.
  assert.equal(scene.items.length, 4);
  assert.equal(scene.enemyLasers[0].state, 2);
});

test('bomb attack slots convert bullets to small cherry even at full power', () => {
  const scene = cancelScene();
  scene.playerObj.power = 128;
  scene.slowRate = 1;
  scene.bombFrame = 0;
  scene.enemies = [];
  scene.enemyBullets.push(
    { x: 12, y: 34, flags: 0, dead: false },
    { x: 12, y: 34, flags: 0x1000, dead: false }
  );
  scene.tickBombChoreography = () => {};
  scene.bombEngine = {
    activeSlots: () => [{ x: 12, y: 34, radiusX: 16, radiusY: 16, damage: 1, hitTally: 0 }]
  };

  scene.applyBombEffects();

  assert.equal(scene.enemyBullets[0].dead, true);
  assert.equal(scene.enemyBullets[1].dead, false);
  assert.deepEqual(scene.items.map((it) => [it.type, it.state]), [['cherry', 1]]);
});
