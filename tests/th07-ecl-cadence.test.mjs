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

test('without a spell the rank-0 scaling applies (1.8 -> 1.3)', () => {
  const runtime = makeRuntime([[fire()]]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: 200, y: 100 });
  const speeds = game.enemyBullets.map((b) => b.speed);
  assert.ok(speeds.some((v) => Math.abs(v - 1.3) < 1e-6),
    `rank-0 non-spell speed 1.3 expected, got ${speeds.slice(0, 6)}`);
});

test('op91 clears the global flag for every later emitter', () => {
  const runtime = makeRuntime([[declare(), spellEnd()], [fire()]]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100 });
  assert.equal(runtime.spellActive, false);
  runtime.spawnEclEnemy(game, { subId: 1, x: 200, y: 100 });
  assert.ok(game.enemyBullets.some((b) => Math.abs(b.speed - 1.3) < 1e-6),
    'post-spell fire is rank-scaled again');
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
  for (let i = 0; i < 11; i++) runtime.updateEnemy(game, e);
  assert.equal(game.enemyBullets.length, 0, 'timer was frozen, not banked, while dead');
  runtime.updateEnemy(game, e);
  assert.ok(game.enemyBullets.length > 0, 'first volley lands a full interval after revival');
});
