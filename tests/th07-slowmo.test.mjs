// Global slow motion (bullet-effects 10/11), spec-slowmo.md. The exe's model:
// one global rate DAT_0056baa8; effect 10 writes 1/param and retroactively
// rescales every live bullet's velocity vector (never the nominal speed);
// effect 11 is the exact inverse and restores rate 1; the ECL script clock
// is a split (int, frac) counter that advances by the rate per wall-clock
// frame; new bullets bake the rate into their spawn velocity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/slowmo';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/eclvm.ts src/data/th07-data.ts src/formats/anm.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { StageRuntime } = await import('../tests/.build/slowmo/game/eclvm.mjs');
const { TH07_DATA } = await import('../tests/.build/slowmo/data/th07-data.mjs');
const { Anm } = await import('../tests/.build/slowmo/formats/anm.mjs');

const i32 = (value) => ({ type: 'i32', value });
const f32 = (value) => ({ type: 'f32', value });

function instruction(time, id, args = [], paramMask = 0) {
  const bytes = new Uint8Array(12 + args.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, time, true);
  view.setUint16(4, id, true);
  view.setUint16(6, bytes.length, true);
  view.setUint16(8, 0xff00, true);
  view.setUint16(10, paramMask, true);
  args.forEach((arg, index) => {
    if (arg.type === 'f32') view.setFloat32(12 + index * 4, arg.value, true);
    else view.setInt32(12 + index * 4, arg.value, true);
  });
  return bytes;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function makeEcl(subs) {
  const headerSize = 4 + (16 + subs.length) * 4;
  const timeline = new Uint8Array(8);
  new DataView(timeline.buffer).setInt16(0, -1, true);
  const sentinel = new Uint8Array(12);
  new DataView(sentinel.buffer).setUint32(0, 0xffffffff, true);
  const bodies = subs.map((sub) => concat([...sub, sentinel]));
  const total = headerSize + timeline.length + bodies.reduce((sum, body) => sum + body.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, subs.length, true);
  view.setUint16(2, 1, true);
  view.setUint32(4, headerSize, true);
  let offset = headerSize + timeline.length;
  bodies.forEach((body, index) => {
    view.setUint32(4 + (16 + index) * 4, offset, true);
    out.set(body, offset);
    offset += body.length;
  });
  out.set(timeline, headerSize);
  return out;
}

const etama = new Anm(TH07_DATA.anm.etama, 'etama');
const noAnm = { hasScript: () => false };

function makeHost() {
  const bulletTimeVisuals = [];
  const host = {
    bulletTimeVisuals,
    rng: { range: () => 0, u32: () => 0, u32InRange: () => 0 },
    difficulty: 3,
    rank: 0,
    frame: 0,
    id: 1,
    player: { x: 192, y: 384 },
    enemies: [],
    enemyBullets: [],
    enemyLasers: [],
    items: [],
    power: 128,
    score: 0,
    timeStopped: false,
    slowRate: 1,
    setSlowRate(r) { host.slowRate = r; },
    setBulletTimeVisual(active) { bulletTimeVisuals.push(active); },
    addScore() {},
    spawnItem() {},
    spawnEffectParticles() {},
    playSfx() {},
    cancelBulletsToItems() {},
    cancelLasers() {},
    sweepBulletsToItems: () => 0,
    unpauseStd() {}
  };
  return host;
}

function makeBullet(poolSlot, overrides = {}) {
  return {
    id: 1000 + poolSlot,
    poolSlot,
    effectState: 0,
    x: 120, y: 100,
    vx: 3, vy: 0,
    speed: 3, angle: 0, age: 20, flags: 0,
    sprite: 0, spriteOffset: 0,
    rect: { x: 0, y: 0, w: 16, h: 16, imageKey: 'etama' },
    slowmoShapeBackupRect: { x: 0, y: 0, w: 16, h: 16, imageKey: 'etama' },
    grazeW: 4, grazeH: 4, grazed: false,
    spawnDuration: 0, spawnMoveScale: 1,
    exFlags: 0, exAccel: null, exAngle: null, exDir: null, exBounce: null,
    ...overrides
  };
}

// Note: spawnEclEnemy runs the sub's frame 0 immediately, so the t=0
// effect is live the moment the spawn call returns; a sub with no future
// instructions stops advancing its clock (runEcl returns before the tail).

test('effect 10 sets 1/param and rescales live bullet velocity, not nominal speed', () => {
  const sub = [instruction(0, 121, [i32(10), i32(2)])];
  const stage = { ...TH07_DATA.stages[1], ecl: makeEcl([sub]) };
  const runtime = new StageRuntime(stage, { etama, enemy: noAnm, effect: noAnm });
  const host = makeHost();
  host.enemyBullets.push(makeBullet(0));
  runtime.spawnEclEnemy(host, { subId: 0, x: 100, y: 100, life: 100, item: -1, score: 0 });
  assert.equal(host.slowRate, 0.5);
  assert.deepEqual(host.bulletTimeVisuals, [true]);
  assert.equal(host.enemyBullets[0].vx, 1.5); // 3 * 0.5
  assert.equal(host.enemyBullets[0].speed, 3); // nominal speed untouched
});

test('effects 10/11 swap the native 0x260..0x26f shape family to 0x26f and restore it', () => {
  const sub = [
    instruction(0, 121, [i32(10), i32(2)]),
    instruction(1, 121, [i32(11), i32(0)])
  ];
  const stage = { ...TH07_DATA.stages[1], ecl: makeEcl([sub]) };
  const runtime = new StageRuntime(stage, { etama, enemy: noAnm, effect: noAnm });
  const host = makeHost();
  const original = runtime.bulletRect(6, 4);
  host.enemyBullets.push(makeBullet(0, {
    sprite: 6,
    spriteOffset: 4,
    rect: original,
    slowmoShapeBackupRect: runtime.bulletRect(6, 0)
  }));
  const e = runtime.spawnEclEnemy(host, { subId: 0, x: 100, y: 100, life: 100, item: -1, score: 0 });

  assert.deepEqual(host.enemyBullets[0].rect, runtime.bulletRect(6, 15), 'enter binds fixed shape 0x26f');
  assert.equal(host.enemyBullets[0].spriteOffset, 4, 'FIRE color/filter field remains unchanged');
  runtime.updateEnemy(host, e);
  runtime.updateEnemy(host, e);
  assert.deepEqual(host.enemyBullets[0].rect, original, 'exit restores the shape saved at enter');
});

test('a template-6 bullet born during slowmo retains the template offset-0 backup used by native exit', () => {
  const sub = [instruction(0, 121, [i32(11), i32(0)])];
  const stage = { ...TH07_DATA.stages[1], ecl: makeEcl([sub]) };
  const runtime = new StageRuntime(stage, { etama, enemy: noAnm, effect: noAnm });
  const host = makeHost();
  host.slowRate = 0.5;
  host.enemyBullets.push(makeBullet(0, {
    sprite: 6,
    spriteOffset: 8,
    rect: runtime.bulletRect(6, 8),
    slowmoShapeBackupRect: runtime.bulletRect(6, 0)
  }));

  runtime.spawnEclEnemy(host, { subId: 0, x: 100, y: 100, life: 100, item: -1, score: 0 });
  assert.deepEqual(host.enemyBullets[0].rect, runtime.bulletRect(6, 0));
});

test('effect 11 restores velocities by the inverse of the current rate', () => {
  const sub = [
    instruction(0, 121, [i32(10), i32(4)]),
    instruction(10, 121, [i32(11), i32(0)])
  ];
  const stage = { ...TH07_DATA.stages[1], ecl: makeEcl([sub]) };
  const runtime = new StageRuntime(stage, { etama, enemy: noAnm, effect: noAnm });
  const host = makeHost();
  host.enemyBullets.push(makeBullet(0));
  const e = runtime.spawnEclEnemy(host, { subId: 0, x: 100, y: 100, life: 100, item: -1, score: 0 });
  // Spawn ran script frame 0: rate 0.25, vx rescaled 3 -> 0.75.
  assert.equal(host.slowRate, 0.25);
  assert.equal(host.enemyBullets[0].vx, 0.75);
  // The clock advances 0.25/wall-frame, so the t=10 instruction executes at
  // the top of wall update #40 after the spawn (10 / 0.25), not update #10.
  for (let i = 0; i < 39; i++) runtime.updateEnemy(host, e);
  assert.equal(host.slowRate, 0.25, 'still slowed through wall update #39');
  runtime.updateEnemy(host, e);
  assert.equal(host.slowRate, 1, 'effect 11 fired on wall update #40');
  assert.deepEqual(host.bulletTimeVisuals, [true, false]);
  assert.ok(Math.abs(host.enemyBullets[0].vx - 3) < 1e-6, 'velocity restored');
});

test('the ECL clock advances fractionally under the rate', () => {
  // A far-future second instruction keeps the sub (and its clock) alive.
  const sub = [instruction(0, 121, [i32(10), i32(2)]), instruction(999, 0, [])];
  const stage = { ...TH07_DATA.stages[1], ecl: makeEcl([sub]) };
  const runtime = new StageRuntime(stage, { etama, enemy: noAnm, effect: noAnm });
  const host = makeHost();
  const e = runtime.spawnEclEnemy(host, { subId: 0, x: 0, y: 0, life: 1, item: -1, score: 0 });
  const t0 = e.ecl.ctx.time; // 0, with frac 0.5 from the spawn frame
  runtime.updateEnemy(host, e);
  runtime.updateEnemy(host, e);
  assert.equal(e.ecl.ctx.time - t0, 1, 'two wall frames = one script frame at rate 0.5');
  runtime.updateEnemy(host, e);
  runtime.updateEnemy(host, e);
  assert.equal(e.ecl.ctx.time - t0, 2);
});

test('the ECL split fraction is stored as float32 before the integer carry', () => {
  const sub = [instruction(999, 0, [])];
  const stage = { ...TH07_DATA.stages[1], ecl: makeEcl([sub]) };
  const runtime = new StageRuntime(stage, { etama, enemy: noAnm, effect: noAnm });
  const host = makeHost();
  const e = runtime.spawnEclEnemy(host, { subId: 0, x: 0, y: 0, life: 1, item: -1, score: 0 });
  host.slowRate = 1 / 3;
  e.ecl.ctx.time = 10;
  // This is the kind of sub-ULP residue retained by repeated JS-double loop
  // clocks. FUN_00436acc stores it to enemy+0x6ec as f32 before the next add.
  e.ecl.ctx.timeFrac = 0.6666666666666659;

  runtime.updateEnemy(host, e);

  assert.equal(e.ecl.ctx.time, 11, 'the f32 add carries on this wall tick');
  assert.equal(e.ecl.ctx.timeFrac, 0);
});

test('op142 damage shield countdown retreats on the global split clock', () => {
  const sub = [instruction(0, 142, [i32(3)]), instruction(999, 0, [])];
  const stage = { ...TH07_DATA.stages[1], ecl: makeEcl([sub]) };
  const runtime = new StageRuntime(stage, { etama, enemy: noAnm, effect: noAnm });
  const host = makeHost();
  host.slowRate = 1 / 3;
  const e = runtime.spawnEclEnemy(host, { subId: 0, x: 0, y: 0, life: 1, item: -1, score: 0 });

  assert.deepEqual([e.ecl.damageShield, e.ecl.damageShieldFrac], [3, 0]);
  runtime.tickEnemyManagerTail(host, e);
  assert.equal(e.ecl.damageShield, 2, 'retreat clock borrows on the first slow wall tick');
  runtime.tickEnemyManagerTail(host, e);
  assert.equal(e.ecl.damageShield, 2, 'second wall tick remains in the same integer interval');
  runtime.tickEnemyManagerTail(host, e);
  assert.equal(e.ecl.damageShield, 1, 'f32 one-third borrows the next integer on the third wall tick');
  runtime.tickEnemyManagerTail(host, e);
  assert.equal(e.ecl.damageShield, 1, 'fourth wall tick begins the next fractional interval');
});

test('op161 arms the bomb/Border manager pause and retreats only the boss timer', () => {
  const sub = [instruction(0, 161, [i32(1)]), instruction(999, 0, [])];
  const stage = { ...TH07_DATA.stages[8], ecl: makeEcl([sub]) };
  const runtime = new StageRuntime(stage, { etama, enemy: noAnm, effect: noAnm });
  const host = makeHost();
  const e = runtime.spawnEclEnemy(host, { subId: 0, x: 0, y: 0, life: 1, item: -1, score: 0 });

  assert.equal(e.ecl.pauseDuringBombOrBorder, true,
    'dispatcher case 0xa0 stores arg&1 in enemy+0x2e2b bit3');
  e.ecl.bossTimer = 10;
  e.ecl.bossTimerPrevious = 4;
  e.ecl.bossTimerFrac = 0;
  runtime.tickEnemyPausedManagerClock(host, e);
  assert.deepEqual([e.ecl.bossTimer, e.ecl.bossTimerPrevious, e.ecl.bossTimerFrac], [9, 4, 0],
    'normal-rate FUN_00436a06 fast path changes only current');

  host.slowRate = 1 / 3;
  runtime.tickEnemyPausedManagerClock(host, e);
  assert.equal(e.ecl.bossTimer, 8, 'slow retreat borrows on its first zero-fraction tick');
  assert.equal(e.ecl.bossTimerPrevious, 9, 'slow path snapshots current before retreating');
  assert.ok(Math.abs(e.ecl.bossTimerFrac - Math.fround(2 / 3)) < 1e-7);
});

test('Extra/Phantasm spell ids 118+ suppress boss collisions throughout a bomb plus one release tick', () => {
  const stage = { ...TH07_DATA.stages[8], ecl: makeEcl([[]]) };
  const runtime = new StageRuntime(stage, { etama, enemy: noAnm, effect: noAnm });
  const host = makeHost();
  host.stageNumber = 8;
  let bombActive = true;
  host.isBombActive = () => bombActive;
  runtime.spellActive = true;
  runtime.currentSpellId = 136;
  const e = runtime.spawnEclEnemy(host, { subId: 0, x: 0, y: 0, life: 1, item: -1, score: 0 });
  e.ecl.isBoss = true;

  runtime.tickEnemyCore(host, e);
  assert.deepEqual(
    [e.ecl.bombCollisionSuppressed, e.ecl.bombCollisionSuppressionHold],
    [true, 1],
    'active high-numbered spell refreshes enemy+0x2e2b bit2 and +0x2e2c'
  );
  bombActive = false;
  runtime.tickEnemyCore(host, e);
  assert.deepEqual([e.ecl.bombCollisionSuppressed, e.ecl.bombCollisionSuppressionHold], [true, 0],
    'first post-bomb core consumes only the one-tick hold');
  runtime.tickEnemyCore(host, e);
  assert.equal(e.ecl.bombCollisionSuppressed, false,
    'the following core clears the collision-suppression bit');
});
