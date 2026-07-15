import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// CADENCE-001 core semantics (PLAN.md §3):
// 1. Spell-active is GLOBAL (Th07.exe DAT_012f40a8): while a spell card is
//    up, EVERY emitter — including op92/93 helpers spawned mid-spell — skips
//    the non-spell rank count/speed scaling (FIRE gate at all.c:8503).
// 2. The auto-fire tick (all.c:7194-7208) is gated on hp>0: a dead/dying
//    enemy neither fires nor advances its timer.

const outDir = 'tests/.build/ecl-cadence';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/eclvm.ts src/data/th07-data.ts src/formats/anm.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { StageRuntime } = await import(`../${outDir}/game/eclvm.mjs`);
const { TH07_DATA } = await import(`../${outDir}/data/th07-data.mjs`);
const { Anm } = await import(`../${outDir}/formats/anm.mjs`);

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

function makeRuntime(subs) {
  const stage = { ...TH07_DATA.stages[1], ecl: makeEcl(subs) };
  return new StageRuntime(stage, { etama, enemy: noAnm, effect: noAnm });
}

function makeHost() {
  return {
    rng: { range: () => 0, u32: () => 0, f: () => 0, u32InRange: () => 0 },
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

// op67 FIRE (aim mode 3): sprite 6 / offset 6, 5 bullets, speeds 1.8/1.2.
const fire = () => instruction(0, 67, [
  i32(6 | (6 << 16)), i32(5), i32(1), f32(1.8), f32(1.2), f32(0), f32(0), i32(0)
]);
// op90 spell declare: variant 0 / spellId 17, empty name (0xAA terminator).
const declare = () => instruction(0, 90, [i32(17 << 16), i32(0xaa)]);
const spellEnd = () => instruction(0, 91, []);

test('spell-active is global: helpers spawned mid-spell fire raw ECL speeds', () => {
  // sub0 declares the spell; sub1 is an independent helper that fires.
  const runtime = makeRuntime([[declare()], [fire()]]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100 });
  assert.equal(runtime.spellActive, true, 'op90 raised the global flag');
  runtime.spawnEclEnemy(game, { subId: 1, x: 200, y: 100 });
  const speeds = game.enemyBullets.map((b) => b.speed);
  assert.ok(speeds.length >= 5, `bullets fired (${speeds.length})`);
  assert.ok(speeds.every((v) => Math.abs(v - 1.8) < 1e-6 || Math.abs(v - 1.2) < 1e-6),
    `raw 1.8/1.2 during the spell, got ${speeds.slice(0, 6)}`);
});

test('fresh enemies use the native -0.15/+0.15 rank range (rank 0: 1.8 -> 1.65)', () => {
  const runtime = makeRuntime([[fire()]]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: 200, y: 100 });
  const speeds = game.enemyBullets.map((b) => b.speed);
  assert.ok(speeds.some((v) => Math.abs(v - 1.65) < 1e-6),
    `rank-0 non-spell speed 1.65 expected, got ${speeds.slice(0, 6)}`);
});

test('op91 clears the global flag for every later emitter', () => {
  const runtime = makeRuntime([[declare(), spellEnd()], [fire()]]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100 });
  assert.equal(runtime.spellActive, false);
  runtime.spawnEclEnemy(game, { subId: 1, x: 200, y: 100 });
  assert.ok(game.enemyBullets.some((b) => Math.abs(b.speed - 1.65) < 1e-6),
    'post-spell fire is rank-scaled again');
});

// --- Real-data fixtures (stage 2 ECL, PLAN.md CADENCE-001) ---------------

function makeRealRuntime(stageNumber) {
  return new StageRuntime(TH07_DATA.stages[stageNumber], { etama, enemy: noAnm, effect: noAnm });
}

test('Sub36 (stage-2 road, Lunatic): allocator core advances op74 once, HP gate freezes', () => {
  const runtime = makeRealRuntime(2);
  const game = makeHost();
  const r = 37; // fixed op74 initial phase
  game.rng.u32InRange = () => r;
  const e = runtime.spawnEclEnemy(game, { subId: 36, x: 100, y: 60, life: 60 });
  assert.equal(game.enemyBullets.length, 0, 'op75 suppressed the immediate FIRE');
  // FUN_0041da10 runs one complete FUN_0040f6c0 core synchronously, so the
  // randomized phase r advances once before the manager's first update.
  const firstManagerUpdate = 120 - r - 1;
  for (let k = 1; k < firstManagerUpdate; k++) {
    runtime.updateEnemy(game, e);
    assert.equal(game.enemyBullets.length, 0, `no fire at update ${k}`);
  }
  runtime.updateEnemy(game, e);
  assert.equal(game.enemyBullets.length, 10,
    `first volley at manager update ${firstManagerUpdate}: count1*count2 = 2*5 bullets`);
  assert.ok(game.enemyBullets.every((b) => b.sprite === 3 && b.spriteOffset === 10), 'Lunatic template 3:10');
  // Steady cadence: next volley exactly 120 updates later.
  for (let k = 1; k < 120; k++) {
    runtime.updateEnemy(game, e);
    assert.equal(game.enemyBullets.length, 10, `steady interval (update +${k})`);
  }
  runtime.updateEnemy(game, e);
  assert.equal(game.enemyBullets.length, 20, 'second volley exactly 120 ECL ticks later');
  // HP=0 freezes the timer and never back-fills the round.
  e.hp = 0;
  for (let k = 0; k < 200; k++) runtime.updateEnemy(game, e);
  assert.equal(game.enemyBullets.length, 20, 'no fire while dead');
  e.hp = 60;
  for (let k = 1; k < 120; k++) {
    runtime.updateEnemy(game, e);
    assert.equal(game.enemyBullets.length, 20, 'timer resumes from its frozen phase');
  }
  runtime.updateEnemy(game, e);
  assert.equal(game.enemyBullets.length, 30, 'full interval after revival');
});

test('Sub58 (晴明大紋): both volleys fire on the wall schedule shifted by the CALL[2] flash loop', () => {
  // The spell declares at local t=120; each CALL[2] (the 30-iteration
  // SE+flash helper, 4 ticks/iteration) costs ~120 WALL frames inside the
  // callee before the volley CALLs at t=250-290 / t=390-430 run. The exe
  // pays the same cost — its op2/op3 jumps re-enter the eval loop at
  // LAB_0040f83a exactly like the port's 'flow' continue — so the second
  // volley legitimately lands ~120 frames after its local time. This
  // fixture pins the schedule; PLAN.md's original offsets (effect at
  // declAge 219-221) were mis-derived without the flash-loop cost.
  const runtime = makeRealRuntime(2);
  const game = makeHost();
  const e = runtime.spawnEclEnemy(game, { subId: 58, x: 192, y: 128, life: 2200 });
  const count = (off) => game.enemyBullets.filter((b) => b.sprite === 6 && b.spriteOffset === off && !b.dead).length;
  let firstV1 = -1;
  let v1Done = -1;
  let firstV2 = -1;
  let v2Done = -1;
  // One lap only: Sub58's op2 at t=550 loops the whole attack back to
  // t=240, so a longer window would double-count the next lap's volleys.
  for (let k = 1; k <= 620; k++) {
    runtime.updateEnemy(game, e);
    if (firstV1 < 0 && count(8) > 0) firstV1 = k;
    if (v1Done < 0 && count(8) === 345) v1Done = k;
    if (firstV2 < 0 && count(4) > 0) firstV2 = k;
    if (v2Done < 0 && count(4) === 345) v2Done = k;
  }
  assert.equal(count(8), 345, 'volley 1: 5 CALLs x 69 bullets, offset 8');
  assert.equal(count(4), 345, 'volley 2: 5 CALLs x 69 bullets, offset 4');
  // The sub enters at local t=122 (the Lunatic declare path jumps there),
  // so with the ~120-frame first flash loop, t=250's volley lands at wall
  // ~250: the stall exactly cancels the 122-tick head start.
  assert.ok(firstV1 > 240 && firstV1 < 265, `volley 1 wall start (${firstV1})`);
  assert.ok(firstV2 - v1Done > 90, `volley 2 waits out the second flash loop (${v1Done} -> ${firstV2})`);
  assert.ok(v2Done > 0, `volley 2 completes (${v2Done})`);
});

test('op144 periodic subs disarm on phase transitions and death callbacks (the 米弹 leak, LIFE-001)', () => {
  // Phase 1 (sub 0): arm a period-2 emitter targeting sub 1, register an
  // HP-threshold transition to sub 2. The exe writes +0x2ee4 = -1 on every
  // phase entry (all.c:13754) and in the death dispatch (all.c:14309);
  // leaving it armed leaked Yuyuko's 幽曲 rice into 桜符 for ~1020 frames.
  const phase1 = [
    instruction(0, 144, [i32(2), i32(1)]),
    instruction(0, 112, [i32(50)]),
    instruction(0, 113, [i32(2)])
  ];
  const periodicFire = [fire(), instruction(0, 42, [])];
  const phase2 = [];
  const runtime = makeRuntime([phase1, periodicFire, phase2]);
  const game = makeHost();
  const e = runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100, life: 100 });
  for (let k = 0; k < 6; k++) runtime.updateEnemy(game, e);
  const beforeTransition = game.enemyBullets.length;
  assert.ok(beforeTransition > 0, 'periodic emitter fires during its own phase');
  // Native phase entry also restores enemy+0x2bd4..+0x2ca7 from the default
  // FIRE template and clears +0x2ca8.  Seed fields which are otherwise not
  // used by this small fixture so the reset boundary remains regression-
  // locked independently of the periodic-sub assertion.
  e.ecl.bulletExSlots[2] = { opcode: 0x20, cond: 0, arg3: 90, arg4: 0, f0: 1, f1: 0 };
  e.ecl.bulletSfx = 7;
  e.ecl.bulletSfxInterval = 33;
  e.ecl.shootInterval = 90;
  e.ecl.shootTimer = 17;
  // Cross the HP threshold: the transition must disarm the periodic.
  e.hp = 40;
  runtime.updateEnemy(game, e);
  assert.equal(e.ecl.ctx.subId, 2, 'entered the threshold sub');
  assert.equal(e.ecl.periodicSub, null, 'periodic slot disarmed on phase entry');
  assert.equal(e.ecl.bulletProps, null, 'FIRE template restored on phase entry');
  assert.ok(e.ecl.bulletExSlots.every((slot) => slot === null), 'all op79 template slots restored');
  assert.equal(e.ecl.bulletSfx, 0, 'op81 sound index restored with the template');
  assert.equal(e.ecl.bulletSfxInterval, 0, 'op81 sound interval restored with the template');
  assert.equal(e.ecl.shootInterval, 0, 'auto-fire interval cleared on phase entry');
  assert.equal(e.ecl.shootTimer, 18,
    'the current manager tick advances the native split counter, then phase reset preserves it');
  const atTransition = game.enemyBullets.length;
  for (let k = 0; k < 30; k++) runtime.updateEnemy(game, e);
  assert.equal(game.enemyBullets.length, atTransition, 'no foreign bullets leak into the new phase');
});

test('retained death callbacks restore the FIRE/op79 template before entering the callback sub', () => {
  // FUN_0041ed50 repeats the same DAT_009a26bc copy used by HP/timeout phase
  // transitions before a mode-1/2/3 actor enters its retained callback.
  const runtime = makeRuntime([[], []]);
  const game = makeHost();
  const e = runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100, life: 100 });
  e.ecl.deathMode = 1;
  e.ecl.deathCallbackSub = 1;
  e.ecl.bulletProps = {
    sprite: 6, offset: 6, count1: 1, count2: 1, speed1: 1, speed2: 1,
    angle1: 0, angle2: 0, aimMode: 1, flags: 0, sfx: 7,
    exSlots: [null, null, null, null, null]
  };
  e.ecl.bulletExSlots[3] = { opcode: 0x20, cond: 0, arg3: 90, arg4: 0, f0: 1, f1: 0 };
  e.ecl.bulletSfx = 7;
  e.ecl.bulletSfxInterval = 33;
  e.ecl.shootInterval = 90;
  e.ecl.shootTimer = 17;
  e.hp = 0;
  assert.equal(runtime.killEnemy(game, e), true, 'mode-1 callback retains the actor');
  assert.equal(e.ecl.ctx.subId, 1, 'entered the death callback sub');
  assert.equal(e.ecl.bulletProps, null);
  assert.ok(e.ecl.bulletExSlots.every((slot) => slot === null));
  assert.equal(e.ecl.bulletSfx, 0);
  assert.equal(e.ecl.bulletSfxInterval, 0);
  assert.equal(e.ecl.shootInterval, 0);
  assert.equal(e.ecl.shootTimer, 17, 'death dispatch itself does not advance the split counter');
});

test('var 10024 is the aim TOWARD the player (snapshot-then-absolute-fan idiom, VM-001)', () => {
  // The stage-4 opener idiom: op5 snapshots var 10024 into a local, then
  // fires an absolute-mode fan with angle1 = that local. The exe resolves
  // 10024 through the shared FUN_0043f2b0 (angle from position toward the
  // player) — the reversed sign fired the whole fan 180° away.
  const snapshotAim = instruction(0, 5, [f32(10004), f32(10024)]);
  const fireAbs = instruction(0, 65, [
    i32(6 | (6 << 16)), i32(1), i32(1), f32(1.0), f32(1.0), f32(10004), f32(0), i32(0)
  ]);
  const runtime = makeRuntime([[snapshotAim, fireAbs]]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100 });
  assert.equal(game.enemyBullets.length, 1);
  // FUN_0043f2b0 stores dx/dy and the FPATAN result as f32 before the FIRE
  // constructor adds/wraps the per-bullet angle.
  const expected = Math.fround(Math.atan2(Math.fround(384 - 100), Math.fround(192 - 100)));
  assert.equal(game.enemyBullets[0].angle, expected,
    `fan center aims at the player (${game.enemyBullets[0].angle} vs ${expected})`);
});

test('var 10024 uses the executable pi/2 fallback at exact player overlap', () => {
  const snapshotAim = instruction(0, 5, [f32(10004), f32(10024)]);
  const fireAbs = instruction(0, 65, [
    i32(6 | (6 << 16)), i32(1), i32(1), f32(4.5), f32(1.0), f32(10004), f32(0), i32(0)
  ]);
  const runtime = makeRuntime([[snapshotAim, fireAbs]]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: game.player.x, y: game.player.y });

  const bullet = game.enemyBullets[0];
  assert.equal(bullet.angle, Math.fround(Math.PI / 2));
  assert.equal(bullet.vx, Math.fround(Math.cos(bullet.angle) * bullet.speed));
  assert.equal(bullet.vy, bullet.speed);
});

test('random FIRE interpolates raw angle endpoints before final wrapping', () => {
  // Th07.exe FUN_0040f6c0 -> FUN_00421e90 keeps an endpoint above +pi raw
  // while interpolating aim mode 8, then wraps the constructed result. The
  // Stage-3 Sub12 interval 2.734..3.362 must remain the short arc; wrapping
  // 3.362 to -2.921 first sprays across nearly the whole circle.
  const angle1 = 3.362481117248535;
  const angle2 = 2.7341625690460205;
  const fireRandom = instruction(0, 72, [
    i32(4 | (2 << 16)), i32(1), i32(1), f32(2.5), f32(0.8),
    f32(angle1), f32(angle2), i32(0x200)
  ]);
  const runtime = makeRuntime([[fireRandom]]);
  runtime.spellActive = true;
  const game = makeHost();
  game.rng.range = (span) => span * 0.5;
  runtime.spawnEclEnemy(game, { subId: 0, x: 192, y: 128 });
  assert.equal(game.enemyBullets.length, 1);
  assert.ok(Math.abs(game.enemyBullets[0].angle - (angle1 + angle2) / 2) < 1e-6,
    `raw short-arc midpoint expected, got ${game.enemyBullets[0].angle}`);
});

test('op93 resolves life during t0, before the allocator writes wrapper item/score', () => {
  // The stage-5 pattern: an invisible wrapper carries the timeline's real
  // HP/item/score in its own hp/itemDrop/score fields and passes them to
  // the visible child via var refs 10027/10070/10071 (exe all.c:8972-9027,
  // paramMask 0x70 -> FUN_0040d750 resolution). Reading the raw words gave
  // children 10027 HP. The allocator supplies HP before the synchronous t0
  // core, but writes the timeline item and score after FUN_0040f6c0 returns;
  // an op93 executed inside that core therefore sees the template -1/100.
  const spawnChild = instruction(0, 93, [
    i32(1), f32(0), f32(0), f32(0), i32(10027), i32(10070), i32(10071)
  ]);
  const runtime = makeRuntime([[spawnChild], []]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100, life: 80, item: 1, score: 1500 });
  assert.equal(game.enemies.length, 2, 'wrapper + child');
  const child = game.enemies[1];
  assert.equal(child.hp, 80, 'child inherits the wrapper HP, not the var id');
  assert.equal(child.maxHp, 80);
  assert.equal(child.ecl.itemDrop, -1, 't0 child sees the wrapper template item');
  assert.equal(child.score, 100, 't0 child sees the wrapper template score');
});

test('mode-3 orbit updates the live heading (exe +0x2b54) that op120/var10045 read', () => {
  // op56: duration 0, target (200,150), angle -π/2, angvel π/120, speed 0,
  // accel 0.5 — the Letty テーブルターニング Sub57 parameter shape.
  const orbit = instruction(0, 56, [
    i32(0), f32(200), f32(150), f32(0), f32(-Math.PI / 2), f32(Math.PI / 120), f32(0), f32(0.5)
  ]);
  const runtime = makeRuntime([[orbit]]);
  const game = makeHost();
  const e = runtime.spawnEclEnemy(game, { subId: 0, x: 200, y: 150 });
  for (let i = 0; i < 10; i++) runtime.updateEnemy(game, e);
  const s = e.ecl;
  assert.ok(s.axisSpeed.x !== 0 || s.axisSpeed.y !== 0, 'orbiter is moving');
  assert.equal(s.heading, Math.fround(Math.atan2(s.axisSpeed.y, s.axisSpeed.x)),
    'heading tracks the live controller vector through the native f32 field');
  assert.equal(s.angle, 0, 'the mode-1 polar angle stays untouched by mode 3');
  // The heading persists when the enemy stops (mode cleared, velocity zero).
  const lastHeading = s.heading;
  s.moveMode = 0;
  s.axisSpeed = { x: 0, y: 0, z: 0 };
  runtime.updateEnemy(game, e);
  assert.equal(s.heading, lastHeading, 'stationary enemy retains the last heading');
});

test('auto-fire is hp-gated: a dead enemy neither fires nor advances its timer', () => {
  // op75 suppresses the immediate FIRE (template only); op73 interval 10.
  const sub = [
    instruction(0, 75, []),
    fire(),
    instruction(0, 73, [i32(10)])
  ];
  const runtime = makeRuntime([sub]);
  const game = makeHost();
  const e = runtime.spawnEclEnemy(game, { subId: 0, x: 200, y: 100, life: 100 });
  assert.equal(game.enemyBullets.length, 0, 'op75 suppressed the immediate fire');
  // op73 at rank 0 scales interval 10 -> 12 (iv + iv/5).
  e.hp = 0;
  for (let i = 0; i < 30; i++) runtime.updateEnemy(game, e);
  assert.equal(game.enemyBullets.length, 0, 'no auto-fire while hp<=0');
  e.hp = 50;
  // The synchronous allocator core advanced the timer from 0 to 1 before
  // death. Ten resumed manager ticks reach 11; the next reaches interval 12.
  for (let i = 0; i < 10; i++) runtime.updateEnemy(game, e);
  assert.equal(game.enemyBullets.length, 0, 'timer was frozen, not banked, while dead');
  runtime.updateEnemy(game, e);
  assert.ok(game.enemyBullets.length > 0, 'first volley lands after the remaining 11 manager ticks');
});

test('auto-fire uses the native integer/fraction split counter under 1/3 slowmo', () => {
  // FUN_0040f6c0 stores +0x2cb4 (integer) and +0x2cb0 (fraction)
  // separately. A single JS double reaches only 4.999999999999999 after
  // fifteen additions of 1/3 in this reset cadence and fires one wall tick
  // late; the native split counter reaches integer 5 exactly on tick 15.
  const sub = [instruction(0, 75, []), fire()];
  const runtime = makeRuntime([sub]);
  const game = makeHost();
  game.slowRate = 1 / 3;
  const e = runtime.spawnEclEnemy(game, { subId: 0, x: 200, y: 100, life: 100 });
  e.ecl.shootInterval = 5;
  e.ecl.shootTimer = 0;
  e.ecl.shootTimerFrac = 0;
  for (let i = 0; i < 14; i++) runtime.updateEnemy(game, e);
  assert.equal(game.enemyBullets.length, 0, 'interval 5 has not elapsed after 14 wall ticks');
  runtime.updateEnemy(game, e);
  assert.ok(game.enemyBullets.length > 0, 'interval 5 fires on wall tick 15');
  assert.equal(e.ecl.shootTimer, 0);
  assert.equal(e.ecl.shootTimerFrac, 0);
});
