import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/op45';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/eclvm.ts src/data/th07-data.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { StageRuntime } = await import('../tests/.build/op45/game/eclvm.mjs');
const { TH07_DATA } = await import('../tests/.build/op45/data/th07-data.mjs');

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

function makeHost() {
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
    unpauseStd() {}
  };
}

function makeRuntime(subs) {
  const stage = { ...TH07_DATA.stages[1], ecl: makeEcl(subs) };
  const noAnm = { hasScript: () => false };
  return new StageRuntime(stage, { etama: noAnm, enemy: noAnm, effect: noAnm });
}

test('op45 Wait(2) yields immediately, freezes ECL time, and never freezes movement', () => {
  const runtime = makeRuntime([[
    instruction(0, 4, [i32(10000), i32(2)]),
    instruction(0, 49, [f32(1)]),
    instruction(0, 45, [i32(10000)], 1),
    // This speed change pins the exe's ECL-before-movement ordering on resume.
    instruction(0, 49, [f32(3)]),
    instruction(0, 4, [i32(10001), i32(7)]),
    instruction(1, 4, [i32(10002), i32(9)])
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });

  assert.deepEqual(
    { index: enemy.ecl.ctx.index, time: enemy.ecl.ctx.time, wait: enemy.ecl.ctx.waitTimer },
    { index: 3, time: 0, wait: 1 }
  );
  assert.equal(enemy.ecl.vars[1], 0, 'same-time instruction after op45 must not run on the op45 frame');

  runtime.updateEnemy(game, enemy);
  assert.equal(enemy.x, 1, 'mode-1 movement continues while the ECL wait counts down');
  assert.equal(enemy.ecl.ctx.time, 0);
  assert.equal(enemy.ecl.ctx.waitTimer, 0);
  assert.equal(enemy.ecl.vars[1], 0);

  runtime.updateEnemy(game, enemy);
  assert.equal(enemy.ecl.vars[1], 7, 'same-time execution resumes exactly two frames after op45');
  assert.equal(enemy.ecl.ctx.time, 1);
  assert.equal(enemy.x, 4, 'the resumed ECL speed write applies before this frame movement');
});

test('op144 periodic gosub runs during a parent wait and restores its wait context', () => {
  const runtime = makeRuntime([
    [
      instruction(0, 45, [i32(3)]),
      instruction(0, 4, [i32(10001), i32(77)])
    ],
    [
      instruction(0, 17, [i32(10005)]),
      instruction(0, 42)
    ]
  ]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  enemy.ecl.periodicSub = { period: 1, subId: 1, elapsed: 0, savedVars: new Float64Array(26) };

  assert.equal(enemy.ecl.ctx.waitTimer, 2);
  runtime.updateEnemy(game, enemy);

  // The periodic sub runs on its own persistent block (exe +0x2ee8 stash):
  // its op17 increment lands in savedVars and the live vars roll back.
  assert.equal(enemy.ecl.periodicSub.savedVars[5], 1, 'periodic callee must execute even while its parent is waiting');
  assert.equal(enemy.ecl.vars[5], 0, 'the interrupted flow keeps its own variable block');
  assert.equal(enemy.ecl.stack.length, 0);
  assert.deepEqual(
    { sub: enemy.ecl.ctx.subId, index: enemy.ecl.ctx.index, time: enemy.ecl.ctx.time, wait: enemy.ecl.ctx.waitTimer },
    { sub: 0, index: 1, time: 0, wait: 1 }
  );
});

test('death callback initializes a fresh context with no inherited op45 wait', () => {
  const runtime = makeRuntime([
    [instruction(0, 45, [i32(8)])],
    [],
    [instruction(0, 4, [i32(10006), i32(42)])]
  ]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  // Default death mode 0 deletes directly in the exe; mode 2 is the
  // callback-preserving phase-transition mode this fixture intends to test.
  enemy.ecl.deathMode = 2;
  enemy.ecl.deathCallbackSub = 2;
  enemy.hp = 0;

  assert.equal(enemy.ecl.ctx.waitTimer, 7);
  assert.equal(runtime.killEnemy(game, enemy), true);
  assert.deepEqual(
    { sub: enemy.ecl.ctx.subId, time: enemy.ecl.ctx.time, wait: enemy.ecl.ctx.waitTimer },
    { sub: 2, time: 0, wait: 0 }
  );

  runtime.updateEnemy(game, enemy);
  assert.equal(enemy.ecl.vars[6], 42, 'callback t=0 must not be delayed by the prior phase wait');
});
