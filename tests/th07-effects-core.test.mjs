import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/effects-core';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/eclvm.ts src/game/stage-scene.ts src/data/th07-data.ts src/formats/anm.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { StageRuntime, advanceBulletExBehavior } = await import('../tests/.build/effects-core/game/eclvm.mjs');
const { StageScene } = await import('../tests/.build/effects-core/game/stage-scene.mjs');
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
  const observations = { rngCalls: 0, rawRngDraws: 0 };
  return {
    observations,
    rng: {
      range(value) {
        return this.f() * value;
      },
      u32() {
        observations.rngCalls++;
        observations.rawRngDraws += 2;
        return rngValues[rngIndex++] ?? 0;
      },
      u16() {
        observations.rngCalls++;
        observations.rawRngDraws++;
        return 0;
      },
      f() {
        return this.u32() / 0x100000000;
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

// STG2-002 (陰陽「晴明大紋」): effect 1 filters on the FIRE second i16 —
// spriteOffset (exe bullet+0xbf8, FUN_00416da0) — sets nominal speed 0.3,
// wipes the behavior queue and installs a fresh opcode-0x20 slow-turn with
// its own elapsed counter. One RNG draw per matched bullet in pool-slot
// order; ±π/(rng01*60+180) per tick (+ for offsets 6/8, − for 2/4);
// E/N/H: 60 ticks @ +0.01666666753590107, Lunatic: 240 @ +0.005263158120214939.
test('effect 1 param 1 processes spriteOffset 8 (not sprite 8) and installs the slow-turn', () => {
  const runtime = makeRuntime();
  const game = makeHost([0, 0]);
  game.difficulty = 3;
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  const target = makeBullet(2, { sprite: 6, spriteOffset: 8, speed: 1.8, angle: 0.5 });
  const decoy = makeBullet(1, { sprite: 8, spriteOffset: 6, speed: 2.0 });
  const wrongOffset = makeBullet(3, { sprite: 6, spriteOffset: 4, speed: 1.8 });
  game.enemyBullets.push(target, decoy, wrongOffset);

  runtime.runBulletEffect(game, caller, 1, 1);
  assert.equal(target.effectState, 1, 'sprite=6 offset=8 IS processed by param 1');
  close(target.speed, 0.3, 'nominal speed declawed');
  assert.equal(target.exFlags, 0, 'queue wipe leaves the replacement pending until bullet-manager promotion');
  assert.equal(target.exBehaviorIndex, 0);
  assert.equal(target.exSlots[0].opcode, 0x20);
  advanceBulletExBehavior(target);
  assert.equal(target.exFlags, 0x20, 'slow-turn promoted on the bullet-manager tick');
  close(target.exAngle.angleDelta, Math.PI / 180, 'rng=0 -> +π/180 for offset 8');
  close(target.exAngle.speedDelta, 0.005263158120214939, 'Lunatic speed delta');
  assert.equal(target.exAngle.limit, 240, 'Lunatic duration');
  assert.equal(target.exAngleElapsed, 0, 'fresh elapsed counter');
  assert.equal(decoy.effectState, 0, 'sprite=8 offset=6 is NOT processed (old sprite-filter bug)');
  close(decoy.speed, 2.0, 'decoy untouched');
  assert.equal(wrongOffset.effectState, 0, 'offset 4 skipped by param 1');
  assert.equal(game.observations.rngCalls, 1, 'one RNG draw per matched bullet only');

  // Repeat call: the processed mark blocks re-processing.
  runtime.runBulletEffect(game, caller, 1, 1);
  assert.equal(game.observations.rngCalls, 1, 'processed bullets consume no further RNG');
});

test('effect 1 param 2 targets offset 4 with a negative turn; E/N/H use the 60-tick ramp', () => {
  const runtime = makeRuntime();
  const game = makeHost([0]);
  game.difficulty = 2; // Hard
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  const target = makeBullet(0, { sprite: 6, spriteOffset: 4, speed: 1.2 });
  const other = makeBullet(1, { sprite: 4, spriteOffset: 6, speed: 1.2 });
  game.enemyBullets.push(target, other);
  runtime.runBulletEffect(game, caller, 1, 2);
  assert.equal(target.effectState, 1);
  advanceBulletExBehavior(target);
  close(target.exAngle.angleDelta, -Math.PI / 180, 'rng=0 -> -π/180 for offset 4');
  close(target.exAngle.speedDelta, 0.01666666753590107, 'Hard speed delta');
  assert.equal(target.exAngle.limit, 60, 'Hard duration');
  assert.equal(other.effectState, 0, 'sprite=4 offset=6 not matched by param 2');
});

test('effect 1 slow-turn: first tick ~0.3+delta, stops exactly at the tick limit (H 1.3 / L ~1.563158)', () => {
  const scene = Object.create(StageScene.prototype);
  scene.slowRate = 1;
  scene.player = { x: 192, y: 384 };
  for (const [difficulty, delta, limit, endSpeed, firstTick] of [
    [2, 0.01666666753590107, 60, 1.3, 0.31666668],
    [3, 0.005263158120214939, 240, 1.5631579488515854, 0.30526317]
  ]) {
    const b = makeBullet(0, { speed: 0.3, angle: 0, vx: 0.3, vy: 0 });
    b.exFlags = 0x20;
    b.exAngle = { speedDelta: delta, angleDelta: Math.PI / 180, limit };
    b.exAngleElapsed = 0;
    b.exAngleFrac = 0;
    scene.updateBulletMotion(b);
    assert.ok(Math.abs(Math.hypot(b.vx, b.vy) - firstTick) < 1e-6,
      `difficulty ${difficulty}: first tick velocity ${Math.hypot(b.vx, b.vy)} ~ ${firstTick}`);
    for (let i = 1; i < limit; i++) scene.updateBulletMotion(b);
    assert.ok(Math.abs(b.speed - endSpeed) < 1e-6, `difficulty ${difficulty}: end speed ${b.speed} ~ ${endSpeed}`);
    assert.equal(b.exFlags & 0x20, 0x20, 'still armed on the last applying tick');
    scene.updateBulletMotion(b); // tick limit+1: behavior expires, no further delta
    assert.equal(b.exFlags & 0x20, 0, 'behavior expired');
    const after = b.speed;
    scene.updateBulletMotion(b);
    assert.equal(b.speed, after, 'no speed growth after expiry');
  }
});

// Stage 5 Sub64 arms effect 13 continuously. Th07.exe FUN_00418650 calls
// FUN_004260d0 for each newly tagged fixed bullet slot; that opcode-0x20
// record is gameplay motion, not a cosmetic-only attachment.
test('effect 13 installs the native parity turn and speed decay on bullets in the sword strip', () => {
  const runtime = makeRuntime();
  const game = makeHost();
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 180, y: 300 });
  const even = makeBullet(878, { x: 180, y: 344, speed: Math.fround(0.91396445), angle: Math.fround(Math.PI) });
  const odd = makeBullet(879, { x: 181, y: 345, speed: 1.8, angle: 0 });
  const xBoundary = makeBullet(880, { x: 196, y: 344, speed: 1 });
  const yBoundary = makeBullet(881, { x: 180, y: 352, speed: 1 });
  game.enemyBullets.push(yBoundary, odd, xBoundary, even);

  runtime.runBulletEffect(game, caller, 13, 1);

  assert.equal(even.effectState, 1);
  assert.equal(even.exBehaviorIndex, 0);
  assert.equal(even.exSlots[0].opcode, 0x20);
  assert.equal(even.exSlots[0].cond, 0);
  assert.equal(even.exSlots[0].arg3, 0xa0);
  close(even.exSlots[0].f0, Math.fround(-Math.fround(even.speed) / 180), 'speed delta is -nominalSpeed/180');
  close(even.exSlots[0].f1, Math.fround(-Math.PI / 60), 'even fixed slot turns -pi/60');
  close(odd.exSlots[0].f1, Math.fround(Math.PI / 60), 'odd fixed slot turns +pi/60');
  assert.equal(xBoundary.effectState, 0, 'strict x band excludes exactly +16');
  assert.equal(yBoundary.effectState, 0, 'strict y ceiling excludes exactly 352');

  advanceBulletExBehavior(even);
  assert.equal(even.exFlags & 0x20, 0x20);
  close(even.exAngle.speedDelta, Math.fround(-Math.fround(even.speed) / 180), 'promoted speed decay');
  close(even.exAngle.angleDelta, Math.fround(-Math.PI / 60), 'promoted parity turn');
  assert.equal(even.exAngle.limit, 160);
});

test('effect 14 queues the native 90-tick player-aimed acceleration behind effect 13', () => {
  const runtime = makeRuntime();
  const game = makeHost();
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  const tagged = makeBullet(12, { x: 160, y: 320, effectState: 1 });
  tagged.exFlags = 0x20;
  tagged.exFireFlags = 0x20;
  tagged.exBehaviorIndex = 1;
  tagged.exSlots = [
    { opcode: 0x20, cond: 0, arg3: 160, arg4: 0, f0: -0.01, f1: -0.02 },
    { opcode: 0x400, cond: 1, arg3: 2, arg4: 0, f0: 3, f1: 0 },
    null, null, null
  ];
  const untouched = makeBullet(13, { x: 170, y: 330, effectState: 0 });
  game.enemyBullets.push(untouched, tagged);

  runtime.runBulletEffect(game, caller, 14, 0);

  assert.equal(tagged.effectState, 2);
  assert.equal(tagged.exBehaviorIndex, 0);
  assert.equal(tagged.exSlots[0].opcode, 0x10);
  assert.equal(tagged.exSlots[0].cond, 0);
  assert.equal(tagged.exSlots[0].arg3, 90);
  close(tagged.exSlots[0].f0, Math.fround(0.02666666731238365), 'native acceleration magnitude');
  close(tagged.exSlots[0].f1, Math.fround(Math.atan2(64, 32)), 'angle captured toward current player position');
  assert.equal(tagged.exSlots[1], null, 'native clears the following queue opcode');
  assert.equal(tagged.exFlags, 0x20, 'the currently active effect-13 behavior is retained');
  advanceBulletExBehavior(tagged);
  assert.equal(tagged.exFlags, 0x20, 'cond 0 waits until the earlier behavior finishes');
  tagged.exFlags = 0;
  advanceBulletExBehavior(tagged);
  assert.equal(tagged.exFlags, 0x10, 'acceleration promotes after the prior behavior clears');
  assert.equal(tagged.exAccel.limit, 90);
  assert.equal(untouched.effectState, 0);
});

test('effects 2 and 6 filter on spriteOffset, not sprite', () => {
  const runtime = makeRuntime();
  const game = makeHost();
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100 });
  const near2 = makeBullet(0, { x: 110, y: 100, sprite: 5, spriteOffset: 2 });
  const nearSprite2 = makeBullet(1, { x: 110, y: 100, sprite: 2, spriteOffset: 5 });
  game.enemyBullets.push(near2, nearSprite2);
  runtime.runBulletEffect(game, caller, 2, 0);
  assert.equal(near2.dead, true, 'offset-2 bullet deleted');
  assert.equal(nearSprite2.dead, undefined, 'sprite-2/offset-5 bullet kept');

  const off15 = makeBullet(2, { sprite: 3, spriteOffset: 15 });
  const sprite15 = makeBullet(3, { sprite: 15, spriteOffset: 3 });
  game.enemyBullets.push(off15, sprite15);
  runtime.runBulletEffect(game, caller, 6, 1);
  assert.equal(off15.dead, true, 'offset-15 bullet deleted by param 1');
  assert.equal(sprite15.dead, undefined, 'sprite-15/offset-3 bullet kept');
});

test('effect 5 copies the tracked boss live position, not its orbit target', () => {
  const runtime = makeRuntime();
  const game = makeHost();
  const boss = runtime.spawnEclEnemy(game, { subId: 0, x: 192, y: 112 });
  boss.ecl.isBoss = true;
  boss.ecl.bossSlot = 0;
  boss.ecl.orbitTarget = { x: 7, y: 9, z: 11 };
  boss.ecl.orbitSpeed = 48;
  boss.ecl.orbitAngularVelocity = 0.125;
  runtime.bossSlots[0] = boss;
  const helper = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });

  runtime.runBulletEffect(game, helper, 5, 0);
  assert.deepEqual(helper.ecl.orbitTarget, { x: 192, y: 112, z: 0 });
  assert.equal(helper.ecl.orbitSpeed, 48);
  assert.equal(helper.ecl.orbitAngularVelocity, 0.125);
});

test('effect 2 converts one nearby parent into two real accelerating bullets in native RNG order', () => {
  const runtime = makeRuntime();
  const game = makeHost();
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100 });
  const parent = makeBullet(5, { x: 110, y: 100, spriteOffset: 2 });
  game.enemyBullets.push(parent);

  runtime.runBulletEffect(game, caller, 2, 0);
  const children = game.enemyBullets.filter((bullet) => bullet !== parent && !bullet.dead);
  assert.equal(parent.dead, true);
  assert.equal(children.length, 2);
  assert.equal(game.observations.rawRngDraws, 6,
    'one acceleration frand plus two aimMode-6 frands consume six raw draws');
  assert.ok(children.every((bullet) => bullet.sprite === 0 && bullet.spriteOffset === 6));
  assert.ok(children.every((bullet) => bullet.flags === 0x12 && bullet.exFlags === 0x10));
  assert.ok(children.every((bullet) => bullet.exAccel?.limit === 0xb4));
  assert.ok(children.every((bullet) => Math.abs(bullet.exAccel?.mag - Math.fround(0.013)) < 1e-9));
  assert.ok(children.every((bullet) => Math.abs(bullet.speed - Math.fround(0.7)) < 1e-9));
});

test('effect 6 converts each Lunatic offset-6 parent into five real grace-ring bullets with zero RNG', () => {
  const runtime = makeRuntime();
  const game = makeHost();
  game.difficulty = 3;
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  const parent = makeBullet(7, { x: 180, y: 120, spriteOffset: 6, speed: 2, angle: 0.25 });
  const decoy = makeBullet(9, { spriteOffset: 15 });
  game.enemyBullets.push(decoy, parent);

  runtime.runBulletEffect(game, caller, 6, 0);
  const children = game.enemyBullets.filter((bullet) => bullet !== parent && bullet !== decoy && !bullet.dead);
  assert.equal(parent.dead, true);
  assert.equal(decoy.dead, undefined, 'param 0 selects only offset 6 parents');
  assert.equal(children.length, 5, 'Lunatic ring counts are 2 + 2 + 1');
  assert.equal(game.observations.rawRngDraws, 0, 'FUN_00417440 conversion consumes no RNG');
  assert.ok(children.every((bullet) => bullet.sprite === 6 && bullet.spriteOffset === 15));
  assert.deepEqual(children.map((bullet) => bullet.flags), [0x2002, 0x2002, 0x2000, 0x2000, 0x2000]);
  assert.ok(children.every((bullet) => bullet.graceFrames === 0x82));
  assert.deepEqual(children.map((bullet) => Number(bullet.speed.toFixed(6))), [2.2, 2.2, 1.4, 1.4, 1.7]);
});

test('effect 12 cuts each Lunatic big bullet into 25 real accelerating bullets', () => {
  const runtime = makeRuntime();
  const game = makeHost();
  game.difficulty = 3;
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 100 });
  const outsideBand = makeBullet(3, {
    x: 160, y: 148,
    sprite: 10,
    rect: { x: 0, y: 0, w: 64, h: 64, imageKey: 'etama2' }
  });
  const wideButShort = makeBullet(5, {
    x: 140, y: 100,
    sprite: 10,
    rect: { x: 0, y: 0, w: 64, h: 32, imageKey: 'etama2' }
  });
  const cut = makeBullet(7, {
    x: 120, y: 100,
    sprite: 10,
    rect: { x: 0, y: 0, w: 64, h: 64, imageKey: 'etama2' }
  });
  game.enemyBullets.push(cut, wideButShort, outsideBand);

  runtime.runBulletEffect(game, caller, 12, 0);
  const children = game.enemyBullets.filter((bullet) =>
    bullet !== cut && bullet !== wideButShort && bullet !== outsideBand && !bullet.dead);
  assert.equal(cut.dead, true, 'matching big bullet is deleted after child allocation');
  assert.equal(wideButShort.dead, undefined, 'descriptor width alone does not pass the native +0x2c height gate');
  assert.equal(outsideBand.dead, undefined, 'strict Lunatic ±48 Y band excludes its boundary');
  assert.equal(children.length, 25, 'Lunatic id12 emits 25 collidable enemy bullets');
  assert.equal(game.observations.rawRngDraws, 25 * 9, 'each child consumes nine raw u16 draws');
  assert.ok(children.every((bullet) => bullet.sprite === 0 && bullet.spriteOffset === 2),
    'kind u16=0 selects the native id12 sprite/offset pair');
  assert.deepEqual(children.map((bullet) => bullet.flags),
    Array.from({ length: 25 }, (_, i) => 0x20 | (i & 1 ? 2 : 0)),
    'id12 alternates spawn-state bit 2 while retaining EX bit 0x20');
  assert.ok(children.every((bullet) => bullet.exFlags === 0x20), 'constructor promotes the angle/speed behavior');
  assert.ok(children.every((bullet) => bullet.exAngle?.limit === 100), 'child EX duration is 100 ticks');
  assert.ok(children.every((bullet) => Math.abs(bullet.exAngle?.speedDelta - Math.fround(0.01)) < 1e-9));
  close(children[0].x, 104, 'first non-bloom child random X origin');
  close(children[0].y, 84, 'first non-bloom child random Y origin');
  close(children[0].angle, -Math.PI / 2, 'param 0 uses the broad arc starting at -pi/2');
});

test('effect 21 uses its wider band and all children carry EX without a spawn bloom', () => {
  const runtime = makeRuntime();
  const game = makeHost();
  game.difficulty = 3;
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 100 });
  const cut = makeBullet(0, {
    x: 200, y: 279.5,
    sprite: 10,
    rect: { x: 0, y: 0, w: 64, h: 64, imageKey: 'etama2' }
  });
  game.enemyBullets.push(cut);

  runtime.runBulletEffect(game, caller, 21, 1);
  const children = game.enemyBullets.filter((bullet) => bullet !== cut && !bullet.dead);
  assert.equal(children.length, 15);
  assert.equal(game.observations.rawRngDraws, 15 * 9);
  assert.ok(children.every((bullet) => bullet.sprite === 0 && bullet.spriteOffset === 4));
  assert.ok(children.every((bullet) => bullet.flags === 0x20 && bullet.spawnDuration === 0));
  close(children[0].angle, Math.PI / 4, 'param 1 wraps the narrow arc around pi/4');
});

test('effect 22 constructs the Extra large-bullet aura volleys in fixed-slot order', () => {
  const runtime = makeRuntime();
  const game = makeHost([0]);
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  caller.ecl.bossTimer = 2;
  const eligible = makeBullet(7, {
    x: 120, y: 100, spriteOffset: 1,
    rect: { x: 0, y: 0, w: 64, h: 64, imageKey: 'etama2' }
  });
  const tagged = makeBullet(3, {
    x: 140, y: 100, exFlags: 0x40,
    rect: { x: 0, y: 0, w: 64, h: 64, imageKey: 'etama2' }
  });
  const boundary = makeBullet(5, {
    x: 160, y: 100,
    rect: { x: 0, y: 0, w: 64, h: 60, imageKey: 'etama2' }
  });
  game.enemyBullets.push(eligible, boundary, tagged);

  runtime.runBulletEffect(game, caller, 22, 0);
  const children = game.enemyBullets.filter((bullet) =>
    bullet !== eligible && bullet !== boundary && bullet !== tagged && !bullet.dead);
  assert.equal(children.length, 2, 'even non-third timer emits the native opposite pair');
  assert.equal(game.observations.rawRngDraws, 2, 'one frand per qualifying large parent');
  assert.ok(children.every((bullet) => bullet.sprite === 3 && bullet.spriteOffset === 6));
  assert.ok(children.every((bullet) => bullet.flags === 0x208 && bullet.spawnDuration === 32));
  assert.deepEqual(children.map((bullet) => Number(bullet.angle.toFixed(6))),
    [Number((-Math.PI).toFixed(6)), 0]);
  assert.equal(tagged.exFlags, 0x40, 'active EX bit 6 excludes the parent');
  assert.equal(boundary.dead, undefined, 'height exactly 60 is excluded');
});

test('effect 23 constructs the Phantasm odd-group aura bullet with the FUN_00426190 speed-ramp release', () => {
  const runtime = makeRuntime();
  const game = makeHost([0]);
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  caller.ecl.bossTimer = 1;
  const parent = makeBullet(4, {
    x: 180, y: 319.5, spriteOffset: 2,
    rect: { x: 0, y: 0, w: 64, h: 64, imageKey: 'etama2' }
  });
  game.enemyBullets.push(parent);

  runtime.runBulletEffect(game, caller, 23, 0);
  const child = game.enemyBullets.find((bullet) => bullet !== parent && !bullet.dead);
  assert.ok(child);
  assert.equal(game.observations.rawRngDraws, 2);
  // The odd group carries the 0x80 EX-record activation bit (native fire flags
  // 0x208 | 0x80 = 0x288, all.c:11276 FUN_00426190 -> FUN_00426080 which ORs
  // 0x80 into template flags +0xc4 -> bullet +0xbf6). FUN_00421e90 copies the
  // template's +0x20 record into the bullet's own +0xc14 op-79 queue and the
  // construction-time FUN_004229f0 pass promotes it.
  assert.deepEqual([child.sprite, child.spriteOffset, child.flags], [1, 10, 0x288]);
  assert.equal(child.exFlags, 0x80, 'odd-group promotes the 0x80 speed-ramp record at construction');
  assert.ok(child.exDir, 'a real speed-ramp release record is installed (not a cosmetic no-op)');
  assert.equal(child.exDir.interval, 0x28, 'op23 release fires after 40 frames');
  assert.equal(child.exDir.maxTimes, 1, 'one-shot release');
  close(child.exDir.angle, 0, 'aim offset 0 (re-aims straight at the player)');
  close(child.exDir.newSpeed, Math.fround(2.9), 'op23 release speed 2.9 (0x4039999a)');
  // Speed stays nominal at construction; FUN_00423e70 (0x80 dirChangeBullet
  // 'aimed') decays it toward 0 over 40 frames, then snaps it to 2.9.
  close(child.speed, Math.fround(1.2), 'odd-group nominal spawn speed (before the ramp)');
});

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
    makeBullet(9, { x: 210, y: 100 }),
    makeBullet(8, { x: 110 - 1e-6, y: 100 })
  ];
  const outside = [
    makeBullet(1, { x: 110 - 1e-4, y: 100 }),
    makeBullet(3, { x: 110, y: 110 + 1e-4 }),
    makeBullet(4, { x: 210 + 1e-4, y: 100 })
  ];
  const slotOneBullet = makeBullet(6, { x: 120, y: 200 });
  game.enemyBullets.push(...boundaries.reverse(), ...outside, slotOneBullet);
  caller.ecl.bossTimer = 0;
  runtime.runBulletEffect(game, caller, 7, 0);
  assert.ok(boundaries.every((bullet) => bullet.effectState === 10),
    'inclusive edges and sub-ULP inputs that store onto an edge rebound');
  assert.ok(outside.every((bullet) => bullet.effectState === 0), 'strictly outside points are rejected');
  assert.equal(slotOneBullet.effectState, 0, 'timer 0 does not process global laser slot 1');
  caller.ecl.bossTimer = 1;
  runtime.runBulletEffect(game, caller, 7, 0);
  assert.equal(slotOneBullet.effectState, 10, 'timer 1 processes global laser slot 1');

  const reachesZero = makeBullet(0, {
    x: 120, y: 100, effectState: 1, vx: 1, vy: 0,
    sprite: 2, spriteOffset: 4
  });
  const cooldown = makeBullet(1, { x: 120, y: 100, effectState: 10, vx: 1, vy: 0 });
  const leavesBox = makeBullet(2, { x: 20, y: 20, effectState: 9, vx: 1, vy: 0 });
  const negativeSide = makeBullet(3, { x: 120, y: 100, effectState: 0, vx: 0, vy: -1 });
  game.enemyBullets = [negativeSide, leavesBox, cooldown, reachesZero];
  caller.ecl.bossTimer = 0;
  runtime.runBulletEffect(game, caller, 7, 0);

  assert.equal(reachesZero.effectState, 10, '1 -> 0 rebounds in the same callback');
  close(reachesZero.speed, 0.9, 'strict speed decrement');
  close(reachesZero.angle, Math.PI / 2, 'nonnegative side uses +normal');
  assert.equal(reachesZero.sprite, 5, 'effect 7 copies the native deflection template');
  assert.deepEqual(reachesZero.rect, runtime.bulletRect(5, 4));
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
  const valid = makeBullet(0, { x: 120, y: 115 + 1e-6, vx: 1, vy: 0 });
  const outside = makeBullet(1, { x: 120, y: 115 + 1e-4 });
  const alreadyUsed = makeBullet(2, { x: 120, y: 100, effectState: -1 });
  const sameLaser = makeBullet(3, { x: 120, y: 100, effectState: 1 });
  easy.enemyBullets.push(outside, alreadyUsed, sameLaser, valid);
  caller.ecl.bossTimer = 0;
  runtime.runBulletEffect(easy, caller, 8, 0);
  assert.equal(easy.observations.rngCalls, 1);
  assert.equal(valid.speed, Math.fround(0.699999988079071), 'Easy rng=0 uses the exe f32 base');
  assert.equal(valid.angle, Math.fround(Math.PI / 2), 'zero dot chooses +normal and stores atan2 as f32');
  assert.equal(valid.vx, Math.fround(Math.cos(valid.angle) * valid.speed));
  assert.equal(valid.vy, Math.fround(Math.sin(valid.angle) * valid.speed));
  assert.equal(valid.effectState, -1);
  runtime.runBulletEffect(easy, caller, 8, 0);
  assert.equal(easy.observations.rngCalls, 1, 'negative/same/outside filters consume no RNG');

  const hardRuntime = makeRuntime();
  const hard = makeHost([0x80000000, 0x80000000]);
  hard.difficulty = 3;
  const hardCaller = hardRuntime.spawnEclEnemy(hard, { subId: 0, x: 0, y: 0 });
  hard.enemyLasers.push(makeLaser(0));
  const crossing = makeBullet(0, {
    x: 120, y: 100, vx: 1, vy: 0,
    sprite: 2, spriteOffset: 3
  });
  hard.enemyBullets.push(crossing);
  hardRuntime.runBulletEffect(hard, hardCaller, 8, 0);
  close(crossing.speed, 1, 'Hard rng=.5 multiplier');
  assert.equal(crossing.effectState, 1);
  assert.equal(crossing.sprite, 5, 'native deflection copies bullet template 5');
  assert.equal(crossing.spriteOffset, 3, 'the original FIRE color offset survives the template copy');
  assert.deepEqual(crossing.rect, hardRuntime.bulletRect(5, 3),
    'template 5 ANM restarts at the preserved color offset');
  assert.equal(crossing.grazeW, 4);
  assert.equal(crossing.grazeH, 4);
  hardRuntime.runBulletEffect(hard, hardCaller, 8, 0);
  assert.equal(hard.observations.rngCalls, 1, 'same global laser is rejected');

  hard.enemyLasers.push(makeLaser(3));
  hardRuntime.runBulletEffect(hard, hardCaller, 8, 0);
  assert.equal(hard.observations.rngCalls, 2, 'overlapping same-modulo laser consumes a second RNG');
  assert.equal(crossing.effectState, 4, 'identity advances to global slot 3 + 1');
});

test('effect 8 stages rotated normal selection, atan2, and FUN_004074e0 velocity through f32', () => {
  const runtime = makeRuntime();
  const raw = 0x12345678;
  const game = makeHost([raw]);
  game.difficulty = 3;
  const caller = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  const angle = Math.fround(0.7312345);
  const sin = Math.fround(Math.sin(angle));
  const cos = Math.fround(Math.cos(angle));
  const nx = Math.fround(-sin);
  const ny = cos;
  game.enemyLasers.push(makeLaser(0, { angle }));
  const oldSpeed = Math.fround(1.2345678);
  const bullet = makeBullet(0, {
    x: 120, y: 100, speed: oldSpeed,
    vx: Math.fround(-nx), vy: Math.fround(-ny)
  });
  game.enemyBullets.push(bullet);

  runtime.runBulletEffect(game, caller, 8, 0);

  const random = raw / 0x100000000;
  const expectedSpeed = Math.fround(
    (random * 0.4000000059604645 + 0.800000011920929) * oldSpeed
  );
  const chosenX = Math.fround(-nx);
  const chosenY = Math.fround(-ny);
  const expectedAngle = Math.fround(Math.atan2(chosenY, chosenX));
  assert.equal(bullet.speed, expectedSpeed);
  assert.equal(bullet.angle, expectedAngle);
  assert.equal(bullet.vx, Math.fround(Math.cos(expectedAngle) * expectedSpeed));
  assert.equal(bullet.vy, Math.fround(Math.sin(expectedAngle) * expectedSpeed));
  assert.equal(bullet.effectState, 1);
  assert.equal(game.observations.rngCalls, 1);
});

test('laser deflection resets template-5 spawn ANM clocks without disturbing normal-state clocks', () => {
  const runtime = makeRuntime();
  const spawning = makeBullet(0, {
    sprite: 10,
    spriteOffset: 4,
    flags: 4,
    spawnAge: 5,
    spawnAgeFrac: 0.25,
    spawnDuration: 24,
    age: 17
  });
  runtime.resetDeflectedBulletTemplate(spawning);
  assert.equal(spawning.sprite, 5);
  assert.deepEqual(spawning.rect, runtime.bulletRect(5, 4));
  assert.equal(spawning.spawnAge, 0);
  assert.equal(spawning.spawnAgeFrac, 0);
  assert.equal(spawning.spawnDuration, 16, 'template 5 state-3 ANM lasts 16 ticks');
  assert.equal(spawning.age, 17, 'normal bullet age lies outside the copied template block');

  const normal = makeBullet(1, {
    sprite: 2,
    spriteOffset: 4,
    spawnAge: 10,
    spawnAgeFrac: 0,
    spawnDuration: 10,
    age: 23
  });
  runtime.resetDeflectedBulletTemplate(normal);
  assert.equal(normal.spawnAge, 10, 'normal-state bullets do not re-enter a spawn state');
  assert.equal(normal.spawnDuration, 10);
  assert.equal(normal.age, 23);
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
  assert.ok(emitted.every((bullet) => bullet.flags === 2));
  assert.ok(emitted.every((bullet) =>
    bullet.x === Math.fround(Math.fround(50) - Math.fround(bullet.vx * 4)) &&
    bullet.y === Math.fround(Math.fround(60) - Math.fround(bullet.vy * 4))
  ), 'flags-selected spawn states begin four velocity vectors behind the emitter');
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
