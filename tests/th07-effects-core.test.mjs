import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/effects-core';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/eclvm.ts src/data/th07-data.ts src/formats/anm.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { StageRuntime } = await import('../tests/.build/effects-core/game/eclvm.mjs');
const { TH07_DATA } = await import('../tests/.build/effects-core/data/th07-data.mjs');
const { Anm } = await import('../tests/.build/effects-core/formats/anm.mjs');

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

function makeRuntime(subs = [[]]) {
  const stage = { ...TH07_DATA.stages[1], ecl: makeEcl(subs) };
  return new StageRuntime(stage, { etama, enemy: noAnm, effect: noAnm });
}

function makeHost(rngValues = []) {
  let rngIndex = 0;
  const observations = { rngCalls: 0 };
  return {
    observations,
    rng: {
      range: () => 0,
      u32() {
        observations.rngCalls++;
        return rngValues[rngIndex++] ?? 0;
      },
      u32InRange: () => 0
    },
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
    addScore() {},
    spawnItem() {},
    spawnEffectParticles() {},
    playSfx() {},
    cancelBulletsToItems() {},
    cancelLasers() {},
    sweepBulletsToItems: () => 0,
    unpauseStd() {}
  };
}

function makeBullet(poolSlot, overrides = {}) {
  const angle = overrides.angle ?? 0;
  const speed = overrides.speed ?? 1;
  return {
    id: 1000 + poolSlot,
    poolSlot,
    effectState: 0,
    x: 120,
    y: 100,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    speed,
    angle,
    age: 20,
    flags: 0,
    sprite: 0,
    spriteOffset: 0,
    rect: { x: 0, y: 0, w: 16, h: 16, imageKey: 'etama' },
    grazeW: 4,
    grazeH: 4,
    grazed: false,
    spawnDuration: 0,
    spawnMoveScale: 1,
    exFlags: 0,
    exAccel: null,
    exAngle: null,
    exDir: null,
    exBounce: null,
    ...overrides
  };
}

function makeLaser(poolSlot, overrides = {}) {
  return {
    id: 2000 + poolSlot,
    poolSlot,
    ownerId: 0,
    inUse: true,
    sprite: 1,
    color: 10,
    x: 100,
    y: 100,
    angle: 0,
    speed: 0,
    nearDist: 10,
    farDist: 110,
    maxLength: 110,
    width: 20,
    displayWidth: 1,
    growDuration: 120,
    holdDuration: 300,
    shrinkDuration: 16,
    telegraphDelay: 120,
    shrinkCutoff: 16,
    flags: 0,
    state: 0,
    phaseFrame: 0,
    hideTipDuringGrow: false,
    ...overrides
  };
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, got ${actual}`);
}

test('effect 0 copies tracked motion and permanently suppresses movement after disarm', () => {
  const runtime = makeRuntime();
  const game = makeHost();
  const target = runtime.spawnEclEnemy(game, { subId: 0, x: 30, y: 40, z: 5 });
  const follower = runtime.spawnEclEnemy(game, { subId: 0, x: 1, y: 2, z: 3 });
  target.ecl.axisSpeed = { x: 4, y: 5, z: 6 };
  target.ecl.angle = 0.75;
  runtime.bossSlots[0] = target;

  runtime.runBulletEffect(game, follower, 0, 0);
  assert.deepEqual([follower.x, follower.y, follower.z], [30, 40, 5]);
  assert.deepEqual(follower.ecl.axisSpeed, target.ecl.axisSpeed);
  close(follower.ecl.angle, 0.75, 'heading copied');
  assert.equal(follower.ecl.movementSuppressedByEffect0, true);

  follower.ecl.effectArm = null;
  follower.ecl.axisSpeed = { x: 20, y: 30, z: 40 };
  follower.ecl.moveMode = 1;
  follower.ecl.speed = 10;
  runtime.updateEnemy(game, follower);
  assert.deepEqual([follower.x, follower.y, follower.z], [30, 40, 5]);
  assert.equal(follower.ecl.movementSuppressedByEffect0, true, 'disarm does not clear exe bit');
});

test('effect 7 uses inclusive full-width bounds, timer-selected global slots, and in-box c08 countdown', () => {
  const runtime = makeRuntime();
  const game = makeHost();
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  game.enemyLasers.push(makeLaser(0), makeLaser(1, { y: 200 }));

  const boundaries = [
    makeBullet(5, { x: 110, y: 90 }),
    makeBullet(2, { x: 110, y: 110 }),
    makeBullet(9, { x: 210, y: 100 })
  ];
  const outside = [
    makeBullet(1, { x: 110 - 1e-6, y: 100 }),
    makeBullet(3, { x: 110, y: 110 + 1e-6 }),
    makeBullet(4, { x: 210 + 1e-6, y: 100 })
  ];
  const slotOneBullet = makeBullet(6, { x: 120, y: 200 });
  game.enemyBullets.push(...boundaries.reverse(), ...outside, slotOneBullet);
  caller.ecl.bossTimer = 0;
  runtime.runBulletEffect(game, caller, 7, 0);
  assert.ok(boundaries.every((bullet) => bullet.effectState === 10), 'all inclusive edges rebound');
  assert.ok(outside.every((bullet) => bullet.effectState === 0), 'strictly outside points are rejected');
  assert.equal(slotOneBullet.effectState, 0, 'timer 0 does not process global laser slot 1');
  caller.ecl.bossTimer = 1;
  runtime.runBulletEffect(game, caller, 7, 0);
  assert.equal(slotOneBullet.effectState, 10, 'timer 1 processes global laser slot 1');

  const reachesZero = makeBullet(0, { x: 120, y: 100, effectState: 1, vx: 1, vy: 0 });
  const cooldown = makeBullet(1, { x: 120, y: 100, effectState: 10, vx: 1, vy: 0 });
  const leavesBox = makeBullet(2, { x: 20, y: 20, effectState: 9, vx: 1, vy: 0 });
  const negativeSide = makeBullet(3, { x: 120, y: 100, effectState: 0, vx: 0, vy: -1 });
  game.enemyBullets = [negativeSide, leavesBox, cooldown, reachesZero];
  caller.ecl.bossTimer = 0;
  runtime.runBulletEffect(game, caller, 7, 0);

  assert.equal(reachesZero.effectState, 10, '1 -> 0 rebounds in the same callback');
  close(reachesZero.speed, 0.9, 'strict speed decrement');
  close(reachesZero.angle, Math.PI / 2, 'nonnegative side uses +normal');
  assert.equal(cooldown.effectState, 9, '10 -> 9 does not rebound');
  close(cooldown.speed, 1, 'cooldown preserves speed');
  assert.equal(leavesBox.effectState, 9, 'countdown freezes outside the box');
  close(negativeSide.angle, -Math.PI / 2, 'negative side uses -normal');
  assert.equal(game.observations.rngCalls, 0, 'effect 7 consumes no RNG');
});

test('effect 8 consumes RNG only after collision and preserves per-laser identity rules', () => {
  const runtime = makeRuntime();
  const easy = makeHost([0]);
  easy.difficulty = 0;
  const caller = runtime.spawnEclEnemy(easy, { subId: 0, x: 0, y: 0 });
  easy.enemyLasers.push(makeLaser(0));
  const valid = makeBullet(0, { x: 120, y: 114, vx: 1, vy: 0 });
  const outside = makeBullet(1, { x: 120, y: 115 + 1e-6 });
  const alreadyUsed = makeBullet(2, { x: 120, y: 100, effectState: -1 });
  const sameLaser = makeBullet(3, { x: 120, y: 100, effectState: 1 });
  easy.enemyBullets.push(outside, alreadyUsed, sameLaser, valid);
  caller.ecl.bossTimer = 0;
  runtime.runBulletEffect(easy, caller, 8, 0);
  assert.equal(easy.observations.rngCalls, 1);
  close(valid.speed, 0.7, 'Easy rng=0 multiplier');
  close(valid.angle, Math.PI / 2, 'zero dot chooses +normal');
  assert.equal(valid.effectState, -1);
  runtime.runBulletEffect(easy, caller, 8, 0);
  assert.equal(easy.observations.rngCalls, 1, 'negative/same/outside filters consume no RNG');

  const hardRuntime = makeRuntime();
  const hard = makeHost([0x80000000, 0x80000000]);
  hard.difficulty = 3;
  const hardCaller = hardRuntime.spawnEclEnemy(hard, { subId: 0, x: 0, y: 0 });
  hard.enemyLasers.push(makeLaser(0));
  const crossing = makeBullet(0, { x: 120, y: 100, vx: 1, vy: 0 });
  hard.enemyBullets.push(crossing);
  hardRuntime.runBulletEffect(hard, hardCaller, 8, 0);
  close(crossing.speed, 1, 'Hard rng=.5 multiplier');
  assert.equal(crossing.effectState, 1);
  hardRuntime.runBulletEffect(hard, hardCaller, 8, 0);
  assert.equal(hard.observations.rngCalls, 1, 'same global laser is rejected');

  hard.enemyLasers.push(makeLaser(3));
  hardRuntime.runBulletEffect(hard, hardCaller, 8, 0);
  assert.equal(hard.observations.rngCalls, 2, 'overlapping same-modulo laser consumes a second RNG');
  assert.equal(crossing.effectState, 4, 'identity advances to global slot 3 + 1');
});

test('global laser allocation uses the lowest free one of 64 slots', () => {
  const packedSpriteColor = (10 << 16) | 1;
  const fireLaser = () => instruction(0, 82, [
    i32(packedSpriteColor), f32(0), f32(0), f32(0), f32(100), f32(100), f32(20),
    i32(1), i32(100), i32(1), i32(0), i32(1), i32(0)
  ]);
  const runtime = makeRuntime([Array.from({ length: 65 }, fireLaser), [fireLaser()]]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100 });
  assert.equal(game.enemyLasers.length, 64, 'the 65th laser is not generated');
  assert.deepEqual(game.enemyLasers.map((laser) => laser.poolSlot), Array.from({ length: 64 }, (_, i) => i));

  game.enemyLasers[5].inUse = false;
  runtime.spawnEclEnemy(game, { subId: 1, x: 100, y: 100 });
  assert.equal(game.enemyLasers.at(-1).poolSlot, 5, 'spawn rescans from slot zero');
});

test('effect 16 emits forty real bullets across eight calls while retaining its seed', () => {
  const runtime = makeRuntime();
  const game = makeHost();
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  caller.ecl.vars[5] = 1.25;
  const seed = makeBullet(0, { x: 50, y: 60, sprite: 8, spriteOffset: 4, angle: 0.25 });
  game.enemyBullets.push(seed);
  for (let i = 0; i < 8; i++) runtime.runBulletEffect(game, caller, 16, 0);

  const emitted = game.enemyBullets.filter((bullet) => bullet !== seed);
  assert.equal(emitted.length, 40);
  assert.equal(seed.dead, undefined, 'effect 16 retains the seed');
  assert.ok(emitted.every((bullet) => bullet.sprite === 0 && bullet.spriteOffset === 6));
  assert.ok(emitted.every((bullet) => bullet.x === 50 && bullet.y === 60 && bullet.flags === 2));
  assert.equal(new Set(game.enemyBullets.map((bullet) => bullet.poolSlot)).size, 41, 'bullet slots stay unique');
  assert.deepEqual(emitted.slice(0, 5).map((bullet) => bullet.poolSlot), [1, 2, 3, 4, 5]);
});

test('effect 17 deletes every type-8 seed and exposes overridden vars to child t=0', () => {
  const child = [
    instruction(0, 5, [f32(10014), f32(10004)]),
    instruction(0, 5, [f32(10015), f32(10011)])
  ];
  const runtime = makeRuntime([[], child]);
  const game = makeHost();
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  for (let i = 0; i < 26; i++) caller.ecl.vars[i] = 100 + i;

  const nonSeed = makeBullet(0, { sprite: 0, spriteOffset: 0 });
  const otherOffset = makeBullet(1, { sprite: 8, spriteOffset: 2 });
  const first = makeBullet(2, { x: 20, sprite: 8, spriteOffset: 4, angle: 0.25 });
  const blocked = makeBullet(3, { sprite: 8, spriteOffset: 4, effectState: 2 });
  const lastOffset = makeBullet(5, { sprite: 8, spriteOffset: 7 });
  const second = makeBullet(8, { x: 80, sprite: 8, spriteOffset: 4, angle: 1.25 });
  game.enemyBullets.push(second, nonSeed, blocked, first, lastOffset, otherOffset);

  runtime.runBulletEffect(game, caller, 17, 0);
  const children = game.enemies.slice(1);
  assert.equal(children.length, 2);
  assert.deepEqual(children.map((enemy) => enemy.x), [20, 80], 'children follow pool-slot order');
  assert.ok([otherOffset, first, blocked, lastOffset, second].every((seed) => seed.dead));
  assert.equal(nonSeed.dead, undefined);

  assert.equal(children[0].ecl.vars[3], 103, 'parent scratch vars are inherited');
  close(children[0].ecl.vars[4], 0.25, 'first seed angle override');
  close(children[0].ecl.vars[11], -Math.PI, 'first fan override');
  close(children[0].ecl.vars[14], 0.25, 'child t=0 read var10004');
  close(children[0].ecl.vars[15], -Math.PI, 'child t=0 read var10011');
  close(children[1].ecl.vars[4], 1.25, 'second seed angle override');
  close(children[1].ecl.vars[11], -3 * Math.PI / 4, 'fan advances only for qualifying seeds');
  close(children[1].ecl.vars[15], -3 * Math.PI / 4, 'second child t=0 sees advanced fan');
});

test('effect 18 counts only live offset-4 seeds whose shared state is zero', () => {
  const runtime = makeRuntime();
  const game = makeHost();
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  caller.ecl.vars[0] = 999;
  const countedA = makeBullet(7, { sprite: 8, spriteOffset: 4 });
  const countedB = makeBullet(2, { sprite: 8, spriteOffset: 4 });
  const used = makeBullet(1, { sprite: 8, spriteOffset: 4, effectState: 1 });
  const otherOffset = makeBullet(3, { sprite: 8, spriteOffset: 3 });
  const dead = makeBullet(4, { sprite: 8, spriteOffset: 4, dead: true });
  game.enemyBullets.push(countedA, used, dead, otherOffset, countedB);

  runtime.runBulletEffect(game, caller, 18, 0);
  assert.equal(caller.ecl.vars[0], 2);
  assert.ok([countedA, countedB, used, otherOffset].every((bullet) => !bullet.dead), 'effect 18 never deletes');
});
