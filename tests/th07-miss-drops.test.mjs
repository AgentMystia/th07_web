import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// Miss-drop rules from Th07.exe FUN_0043dca0 (all.c:28601-28641): power loss
// lands BEFORE the drops; power<1 refunds 5x fullPower and skips the cherry
// penalty; otherwise power zeroes below 17 (else -16) and drops
// 1x bigPower + 5x power — never cherry-family, at any starting power.

const outDir = 'tests/.build/miss-drops';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/stage-scene.ts --bundle --format=esm --outfile=${outDir}/stage-scene.mjs --log-level=silent`);
const { StageScene } = await import('../tests/.build/miss-drops/stage-scene.mjs');

function deathScene(power) {
  const scene = Object.create(StageScene.prototype);
  scene.id = 1;
  scene.slowRate = 1;
  scene.items = [];
  scene.enemyBullets = [];
  scene.enemyLasers = [];
  scene.particles = [];
  scene.postBombLaserCounter = 0;
  scene.rng = { f: () => 0.5, range: (v) => v / 2, u16: () => 0, u16InRange: () => 0 };
  scene.playerObj = {
    x: 192, y: 400, power,
    character: 'reimuA',
    sht: { cherryLossOnDeath: 0.5 }
  };
  const cherryCalls = [];
  scene.cherry = { onDeath: (...args) => cherryCalls.push(args) };
  scene.cherryCalls = cherryCalls;
  scene.playerEffects = { clear: () => {} };
  scene.voidSpellCapture = () => {};
  scene.playSfx = () => {};
  scene.spawnEffectParticles = () => {};
  return scene;
}

test('miss at power>16 drops 1 bigPower + 5 power after losing 16 power', () => {
  const scene = deathScene(128);
  scene.onPlayerDeath();
  assert.equal(scene.playerObj.power, 112);
  assert.deepEqual(
    scene.items.map((it) => it.type).sort(),
    ['bigPower', 'power', 'power', 'power', 'power', 'power']
  );
  // Never cherry-family even from a max-power death (the old ordering bug).
  assert.ok(!scene.items.some((it) => it.type === 'bigCherry' || it.type === 'cherry'));
  assert.equal(scene.cherryCalls.length, 1);
});

test('miss below 17 power zeroes power, same drop set', () => {
  const scene = deathScene(9);
  scene.onPlayerDeath();
  assert.equal(scene.playerObj.power, 0);
  assert.equal(scene.items.filter((it) => it.type === 'power').length, 5);
  assert.equal(scene.items.filter((it) => it.type === 'bigPower').length, 1);
});

test('miss at power 0 refunds 5 fullPower and skips the cherry penalty', () => {
  const scene = deathScene(0);
  scene.onPlayerDeath();
  assert.deepEqual(scene.items.map((it) => it.type), ['fullPower', 'fullPower', 'fullPower', 'fullPower', 'fullPower']);
  assert.equal(scene.cherryCalls.length, 0);
});

test('completing the power bar converts other live power items to bigCherry with an upward nudge', () => {
  const scene = deathScene(0);
  scene.items.push(
    { id: 1, x: 10, y: 20, vx: 0.4, vy: 1.2, type: 'power', age: 0, state: 0 },
    { id: 2, x: 30, y: 40, vx: 0, vy: -0.9, type: 'bigPower', age: 0, state: 0 },
    { id: 3, x: 50, y: 60, vx: 0, vy: 0, type: 'point', age: 0, state: 0 }
  );
  scene.convertLivePowerItems();
  assert.deepEqual(scene.items.map((it) => it.type), ['bigCherry', 'bigCherry', 'point']);
  // Falling item snapped to the (0, -0.5) nudge; rising item untouched.
  assert.deepEqual([scene.items[0].vx, scene.items[0].vy], [0, -0.5]);
  assert.deepEqual([scene.items[1].vx, scene.items[1].vy], [0, -0.9]);
});
