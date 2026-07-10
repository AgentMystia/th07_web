import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/fire-sfx';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/eclvm.ts src/data/th07-data.ts src/formats/anm.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { StageRuntime } = await import('../tests/.build/fire-sfx/game/eclvm.mjs');
const { TH07_DATA } = await import('../tests/.build/fire-sfx/data/th07-data.mjs');
const { Anm } = await import('../tests/.build/fire-sfx/formats/anm.mjs');

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

function makeEcl(sub) {
  const headerSize = 4 + 17 * 4;
  const timeline = new Uint8Array(8);
  new DataView(timeline.buffer).setInt16(0, -1, true);
  const sentinel = new Uint8Array(12);
  new DataView(sentinel.buffer).setUint32(0, 0xffffffff, true);
  const body = concat([...sub, sentinel]);
  const out = new Uint8Array(headerSize + timeline.length + body.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, 1, true);
  view.setUint32(4, headerSize, true);
  view.setUint32(4 + 16 * 4, headerSize + timeline.length, true);
  out.set(timeline, headerSize);
  out.set(body, headerSize + timeline.length);
  return out;
}

const etama = new Anm(TH07_DATA.anm.etama, 'etama');
const noAnm = { hasScript: () => false };

function makeRuntime(sub) {
  const stage = { ...TH07_DATA.stages[1], ecl: makeEcl(sub) };
  return new StageRuntime(stage, { etama, enemy: noAnm, effect: noAnm });
}

function makeHost() {
  const sfx = [];
  return {
    sfx,
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
    slowRate: 1,
    addScore() {},
    spawnItem() {},
    spawnEffectParticles() {},
    playSfx(id) { sfx.push(id); },
    cancelBulletsToItems() {},
    cancelLasers() {},
    sweepBulletsToItems: () => 0,
    unpauseStd() {}
  };
}

function fire(flags, time = 0) {
  return instruction(time, 64, [
    i32(0), i32(1), i32(1), f32(1), f32(1), f32(0), f32(0), i32(flags)
  ]);
}

test('direct FIRE obeys its literal 0x200 flag and a flagged default uses SE 0', () => {
  const runtime = makeRuntime([fire(0), fire(0x200)]);
  const host = makeHost();
  const enemy = runtime.spawnEclEnemy(host, { subId: 0, x: 100, y: 100 });

  assert.deepEqual(host.enemyBullets.map((bullet) => bullet.flags), [0, 0x200]);
  assert.deepEqual(host.sfx, [0]);
  assert.equal(enemy.ecl.bulletSfx, 0, 'enemy zero-fill supplies the default SE index');
});

test('op81 sets and clears only the current template sound flag', () => {
  const runtime = makeRuntime([
    fire(0),
    instruction(0, 81, [i32(7), i32(25)]),
    instruction(0, 77),
    instruction(0, 81, [i32(-1), i32(33)]),
    instruction(0, 77)
  ]);
  const host = makeHost();
  const enemy = runtime.spawnEclEnemy(host, { subId: 0, x: 100, y: 100 });

  assert.deepEqual(host.sfx, [7]);
  assert.equal(host.enemyBullets.length, 3);
  assert.equal(enemy.ecl.bulletSfx, 7, 'negative op81 preserves the last SE index');
  assert.equal(enemy.ecl.bulletProps.flags & 0x200, 0);
  assert.equal(enemy.ecl.bulletSfxInterval, 33, 'arg1 is retained as enemy+0x2ca0 state');
});

test('a direct FIRE after op81 overwrites the template flags with its literal', () => {
  const runtime = makeRuntime([
    fire(0),
    instruction(0, 81, [i32(7), i32(25)]),
    fire(0)
  ]);
  const host = makeHost();
  const enemy = runtime.spawnEclEnemy(host, { subId: 0, x: 100, y: 100 });

  assert.deepEqual(host.sfx, []);
  assert.deepEqual(host.enemyBullets.map((bullet) => bullet.flags), [0, 0]);
  assert.equal(enemy.ecl.bulletProps.flags, 0);
  assert.equal(enemy.ecl.bulletProps.sfx, 7);
});

test('auto-shoot uses the template flags modified by op81', () => {
  const runtime = makeRuntime([
    fire(0),
    instruction(0, 81, [i32(5), i32(25)]),
    instruction(0, 73, [i32(1)]),
    instruction(2, 81, [i32(-1), i32(33)])
  ]);
  const host = makeHost();
  const enemy = runtime.spawnEclEnemy(host, { subId: 0, x: 100, y: 100 });

  runtime.updateEnemy(host, enemy); // template bit set: fires SE 5
  runtime.updateEnemy(host, enemy); // op81(-1) clears it before this tick

  assert.deepEqual(host.sfx, [5]);
  assert.deepEqual(host.enemyBullets.map((bullet) => bullet.flags), [0, 0x200, 0]);
});
