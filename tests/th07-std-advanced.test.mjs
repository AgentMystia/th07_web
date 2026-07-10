import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/std-advanced';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/formats/std.ts src/game/eclvm.ts src/data/th07-data.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { Std, applyStdFormula } = await import('../tests/.build/std-advanced/formats/std.mjs');
const { StageRuntime } = await import('../tests/.build/std-advanced/game/eclvm.mjs');
const { TH07_DATA } = await import('../tests/.build/std-advanced/data/th07-data.mjs');

function stageStd(stage) {
  return new Std(TH07_DATA.stages[stage].std);
}

function advance(std, count) {
  for (let i = 0; i < count; i++) std.advance();
}

function close(actual, expected, epsilon = 1e-5) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

function closeVec(actual, expected, epsilon = 1e-5) {
  close(actual.x, expected.x, epsilon);
  close(actual.y, expected.y, epsilon);
  close(actual.z, expected.z, epsilon);
}

function eclInstruction(time, id, args = [], paramMask = 0) {
  const bytes = new Uint8Array(12 + args.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, time, true);
  view.setUint16(4, id, true);
  view.setUint16(6, bytes.length, true);
  view.setUint16(8, 0xff00, true);
  view.setUint16(10, paramMask, true);
  args.forEach((arg, index) => view.setInt32(12 + index * 4, arg, true));
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
  const out = new Uint8Array(headerSize + timeline.length + bodies.reduce((sum, body) => sum + body.length, 0));
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

function makeHost(std, labels) {
  return {
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
    addScore() {},
    spawnItem() {},
    spawnEffectParticles() {},
    spawnEnemyDeathEffect() {},
    playSfx() {},
    cancelBulletsToItems() {},
    cancelLasers() {},
    sweepBulletsToItems: () => 0,
    unpauseStd(label) {
      labels.push(label);
      std.requestResume(label);
    }
  };
}

test('STD easing modes use the executable table, not the ANM numbering', () => {
  const values = [0.5, 0.75, 0.875, 0.9375, 0.25, 0.125, 0.0625];
  for (let mode = 0; mode <= 6; mode++) close(applyStdFormula(0.5, mode), values[mode]);
});

test('stage 5 camera follows authored op14-18 cubic Hermite segments', () => {
  const std = stageStd(5);
  advance(std, 2600);
  assert.equal(std.frame, 2600);
  closeVec(std.camera(), { x: 0, y: 999.75, z: -1799.75 });

  advance(std, 2600);
  closeVec(std.camera(), { x: 0, y: 2000, z: -2800 });

  advance(std, 300);
  assert.equal(std.frame, 5500);
  closeVec(std.camera(), { x: -50, y: 2050, z: -2800 });

  advance(std, 1500);
  assert.equal(std.frame, 7000);
  closeVec(std.camera(), { x: -50, y: 3550, z: -4300 });
});

test('stage 4 op24-28 drives the LookAt up vector and op29 switches primary VM', () => {
  const std = stageStd(4);
  advance(std, 750);
  closeVec(std.upHint(), { x: 1, y: 0, z: 0 });
  const camera = std.cameraFrame(std.frame);
  closeVec(
    { x: camera.rightX, y: camera.rightY, z: camera.rightZ },
    { x: 0, y: -1, z: 0 }
  );
  closeVec(
    { x: camera.upX, y: camera.upY, z: camera.upZ },
    { x: 1, y: 0, z: 0 }
  );
  assert.deepEqual(std.primaryAnm, { script: 0, age: 749 });

  advance(std, 6250);
  assert.equal(std.frame, 7000);
  assert.deepEqual(std.primaryAnm, { script: 0, age: 6999 });
  std.advance();
  assert.deepEqual(std.primaryAnm, { script: 16, age: 0 });

  advance(std, 4207);
  assert.equal(std.frame, 11208);
  assert.deepEqual(std.primaryAnm, { script: 16, age: 4207 });
  std.advance();
  assert.equal(std.primaryAnm, null);
});

test('stage 6 op3 pauses only script time and requestResume runs after op31 in the same tick', () => {
  const std = stageStd(6);
  std.advance();
  assert.deepEqual(std.primaryAnm, { script: 5, age: 0 });
  assert.deepEqual(std.secondaryAnm, { script: 4, age: 0 });

  advance(std, 2000);
  assert.equal(std.frame, 2000);
  assert.equal(std.paused, true);
  closeVec(std.camera(), { x: 0, y: 4000, z: -500 });
  const animationAtPause = std.animationFrame;
  const primaryAgeAtPause = std.primaryAnm.age;

  advance(std, 10);
  assert.equal(std.frame, 2000);
  assert.equal(std.animationFrame, animationAtPause + 10);
  assert.equal(std.primaryAnm.age, primaryAgeAtPause + 10);

  std.requestResume(1);
  std.advance();
  assert.equal(std.paused, false);
  assert.equal(std.frame, 2001);
  assert.ok(std.camera().y > 4000, 'post-label camera instructions must execute on the resume tick');

  advance(std, 320);
  assert.equal(std.frame, 2320);
  assert.equal(std.paused, true);
  std.requestResume(2);
  std.advance();
  assert.equal(std.frame, 2321);
  assert.deepEqual(std.primaryAnm, { script: 6, age: 0 });
  assert.ok(std.secondaryAnm.age > 2000);

  std.requestResume(3);
  std.advance();
  assert.equal(std.frame, 3201);
  assert.deepEqual(std.primaryAnm, { script: 7, age: 0 });
});

test('ECL op125 resolves its variable label before resuming the stage 6 STD VM', () => {
  const ecl = makeEcl([
    [eclInstruction(0, 125, [999])],
    [
      eclInstruction(0, 4, [10000, 1]),
      eclInstruction(0, 125, [10000], 1)
    ]
  ]);
  const noAnm = { hasScript: () => false };
  const runtime = new StageRuntime(
    { ...TH07_DATA.stages[6], ecl },
    { etama: noAnm, enemy: noAnm, effect: noAnm }
  );
  const labels = [];
  const game = makeHost(runtime.std, labels);
  advance(runtime.std, 2001);
  assert.equal(runtime.std.paused, true);

  runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  runtime.std.advance();
  assert.deepEqual(labels, [999]);
  assert.equal(runtime.std.paused, true, 'an absent label must not consume the pause');

  runtime.spawnEclEnemy(game, { subId: 1, x: 0, y: 0 });
  assert.deepEqual(labels, [999, 1], 'op125 must resolve var10000 to label 1');
  runtime.std.advance();
  assert.equal(runtime.std.paused, false);
  assert.equal(runtime.std.frame, 2001);
  assert.ok(runtime.std.camera().y > 4000, 'instructions after label 1 execute on the resume tick');
});

test('stage 1 op4 rewinds script time without rewinding quad animation time', () => {
  const std = stageStd(1);
  advance(std, 6022);
  assert.equal(std.frame, 6022);
  assert.equal(std.animationFrame, 6022);
  std.advance();
  assert.equal(std.frame, 5511);
  assert.equal(std.animationFrame, 6023);
});
