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

function deathScene(power, rngValues = null) {
  const scene = Object.create(StageScene.prototype);
  scene.id = 1;
  scene.slowRate = 1;
  scene.items = [];
  scene.enemyBullets = [];
  scene.enemyLasers = [];
  scene.particles = [];
  scene.postBombLaserCounter = 0;
  let rngIndex = 0;
  scene.rng = {
    f: () => (rngValues ? rngValues[rngIndex++ % rngValues.length] : 0.5),
    range: (v) => v / 2,
    u16: () => 0,
    u16InRange: () => 0
  };
  scene.playerObj = {
    x: 192, y: 400, power,
    character: 'reimuA',
    // The dead player never latches/collects during the drop flight.
    alive: false,
    sht: { cherryLossOnDeath: 0.5, pocLineY: 128, autocollectSpeed: 8, itemRadius: 24 }
  };
  const cherryCalls = [];
  scene.cherry = { onDeath: (...args) => cherryCalls.push(args), borderActive: false };
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

// ITEM-002: death drops must fly the exe's spawn-mode-2 positional tween
// (Th07.exe FUN_00430970 all.c:21852-21862 / FUN_00430c10 all.c:21936-21956):
// pos = lerp(deathPoint, target, t) with t = elapsed/60 for elapsed 0..59;
// at elapsed 60 the velocity zeroes, the item drops to normal fall from rest.
// Target: x = rand*288+48, y = rand*192-64 (one rand pair per drop).
test('death drops fly a 60-frame positional tween to the rand target, then fall from rest', () => {
  const scene = deathScene(128); // rng.f fixed 0.5 -> every target (192, 32)
  scene.onPlayerDeath();
  const it = scene.items[0];
  const [sx, sy] = [192, 400];
  const [tx, ty] = [0.5 * 288 + 48, 0.5 * 192 - 64];
  assert.equal(it.state, 2, 'death drops spawn in tween state (mode 2)');
  assert.deepEqual([it.x, it.y], [sx, sy], 'frame 0: at the death point');

  const at = (t) => [t * tx + (1 - t) * sx, t * ty + (1 - t) * sy];
  scene.updateItems(); // elapsed 0 -> t=0 (no move on the first tick)
  assert.deepEqual([it.x, it.y], [sx, sy], 'frame 1: t=0 keeps the origin');
  scene.updateItems(); // elapsed 1 -> t=1/60
  let [ex, ey] = at(1 / 60);
  assert.ok(Math.abs(it.x - ex) < 1e-6 && Math.abs(it.y - ey) < 1e-6, `frame 2: t=1/60 (${it.x},${it.y})`);
  for (let k = 3; k <= 20; k++) scene.updateItems();
  [ex, ey] = at(19 / 60);
  assert.ok(Math.abs(it.x - ex) < 1e-6 && Math.abs(it.y - ey) < 1e-6, `frame 20: t=19/60 (${it.x},${it.y})`);
  for (let k = 21; k <= 60; k++) scene.updateItems();
  [ex, ey] = at(59 / 60);
  assert.ok(Math.abs(it.x - ex) < 1e-6 && Math.abs(it.y - ey) < 1e-6, `frame 60: t=59/60 — the lerp never reaches the target`);
  assert.equal(it.state, 2, 'still mode 2 on the last lerp frame');

  scene.updateItems(); // elapsed 60: velocity zeroed, state -> 0, no move
  assert.equal(it.state, 0, 'frame 61: tween over, normal item');
  assert.deepEqual([it.vx, it.vy], [0, 0], 'frame 61: velocity zeroed');
  assert.ok(Math.abs(it.x - ex) < 1e-6 && Math.abs(it.y - ey) < 1e-6, 'frame 61: position holds');

  scene.updateItems(); // first normal-fall frame: gravity from rest
  assert.ok(Math.abs(it.y - (ey + 0.03)) < 1e-6, `frame 62: falls 0.03 from rest (${it.y})`);
  assert.equal(it.x, ex, 'frame 62: no horizontal drift after the tween');
});

test('a top-of-field target rises during the tween but falls back after it ends', () => {
  // First rand pair -> target (48, -64): the exe's legal off-top window.
  const scene = deathScene(128, [0, 0]);
  scene.onPlayerDeath();
  const it = scene.items[0];
  for (let k = 0; k < 61; k++) scene.updateItems();
  assert.ok(it.y < 0, 'tween carried the drop above the field top');
  assert.equal(it.state, 0);
  const apex = it.y;
  let y = it.y;
  let rising = false;
  for (let k = 0; k < 300 && !it.dead; k++) {
    scene.updateItems();
    if (it.y < y - 1e-9) rising = true;
    y = it.y;
  }
  assert.equal(rising, false, 'no residual upward motion after the tween');
  assert.ok(y > apex, 'the drop falls back down (no moon flight)');
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
