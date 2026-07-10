import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/ecl-fidelity';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/eclvm.ts src/data/th07-data.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { StageRuntime } = await import('../tests/.build/ecl-fidelity/game/eclvm.mjs');
const { TH07_DATA } = await import('../tests/.build/ecl-fidelity/data/th07-data.mjs');

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

function makeHost(rngValues = []) {
  let rngIndex = 0;
  const observations = { scores: [], drops: [], sfx: [], deathEffects: 0, bossPresence: [] };
  return {
    observations,
    rng: {
      range: () => 0,
      u32: () => rngValues[rngIndex++] ?? 0,
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
    addScore(value) { observations.scores.push(value); },
    spawnItem(type, x, y) { observations.drops.push({ type, x, y }); },
    spawnEffectParticles() {},
    spawnEnemyDeathEffect() { observations.deathEffects++; },
    playSfx(id) { observations.sfx.push(id); },
    cancelBulletsToItems() {},
    cancelLasers() {},
    sweepBulletsToItems: () => 0,
    setBossPresent(present, enemy) { observations.bossPresence.push({ present, enemy }); },
    unpauseStd() {}
  };
}

function makeRuntime(subs) {
  const stage = { ...TH07_DATA.stages[1], ecl: makeEcl(subs) };
  const noAnm = { hasScript: () => false };
  return new StageRuntime(stage, { etama: noAnm, enemy: noAnm, effect: noAnm });
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, got ${actual}`);
}

test('ops 10 and 11 apply random sign through their int and float paths', () => {
  const runtime = makeRuntime([[
    instruction(0, 10, [i32(10000), i32(7)]),
    instruction(0, 11, [f32(10004), f32(2.5)])
  ]]);
  const game = makeHost([0, 1]);
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });

  assert.equal(enemy.ecl.vars[0], -7);
  assert.equal(enemy.ecl.vars[4], 2.5);
});

test('mode-2 movement uses the exe easing table and advances on its first tick', () => {
  const expectedAtHalf = [0.5, 0.25, 0.125, 0.0625, 0.75, 0.875, 0.9375];
  for (let mode = 0; mode <= 6; mode++) {
    const runtime = makeRuntime([[
      instruction(0, 55, [i32(4), i32(mode), f32(1), f32(0), f32(0)])
    ]]);
    const game = makeHost();
    const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });

    runtime.updateEnemy(game, enemy);
    close(enemy.x, mode === 0 ? 0.25 : mode === 1 ? 0.0625 : mode === 2 ? 0.015625
      : mode === 3 ? 0.00390625 : mode === 4 ? 0.4375 : mode === 5 ? 0.578125 : 0.68359375,
    `mode ${mode} first tick`);
    runtime.updateEnemy(game, enemy);
    close(enemy.x, expectedAtHalf[mode], `mode ${mode} halfway`);
  }
});

test('op54 uses speed times duration and mirrors the X delta', () => {
  for (const [mirrored, expected] of [[false, 8], [true, -8]]) {
    const runtime = makeRuntime([[
      instruction(0, 4, [i32(10000), i32(4)]),
      instruction(0, 54, [i32(10000), i32(0), f32(0), f32(2)], 1)
    ]]);
    const game = makeHost();
    const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0, mirrored });
    runtime.updateEnemy(game, enemy);
    close(enemy.x, mirrored ? -2 : 2, `mirrored=${mirrored} first tick`);
    runtime.updateEnemy(game, enemy);
    runtime.updateEnemy(game, enemy);
    runtime.updateEnemy(game, enemy);
    close(enemy.x, expected, `mirrored=${mirrored} final position`);
  }

  const runtime = makeRuntime([[
    instruction(0, 55, [i32(2), i32(0), f32(8), f32(0), f32(0)])
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0, mirrored: true });
  runtime.updateEnemy(game, enemy);
  runtime.updateEnemy(game, enemy);
  close(enemy.x, -8, 'op55 mirrored delta');
});

test('op59 bounds mode-1 recomputation but preserves its final velocity', () => {
  const runtime = makeRuntime([[
    instruction(0, 40, [f32(0)]),
    instruction(0, 49, [f32(1)]),
    instruction(0, 59, [i32(2)])
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });

  runtime.updateEnemy(game, enemy);
  assert.equal(enemy.ecl.moveMode, 1);
  close(enemy.x, 1, 'first mode-1 tick');
  runtime.updateEnemy(game, enemy);
  assert.equal(enemy.ecl.moveMode, 0);
  close(enemy.x, 2, 'second mode-1 tick');
  runtime.updateEnemy(game, enemy);
  close(enemy.x, 3, 'last velocity persists after mode bits clear');
});

test('op106 death modes preserve the exe lifecycle, scoring, and callback rules', () => {
  const runtime = makeRuntime([[], [instruction(0, 4, [i32(10000), i32(99)])]]);

  const mode0Game = makeHost();
  const mode0 = runtime.spawnEclEnemy(mode0Game, { subId: 0, x: 10, y: 20, item: 3, score: 1000 });
  mode0.ecl.invisible = true;
  mode0.ecl.deathCallbackSub = 1;
  mode0.ecl.isBoss = true;
  mode0.ecl.bossSlot = 2;
  runtime.bossSlots[2] = mode0;
  mode0.hp = 0;
  assert.equal(runtime.killEnemy(mode0Game, mode0), false, 'mode 0 removes even an invisible actor');
  assert.deepEqual(mode0Game.observations.scores, [100]);
  assert.deepEqual(mode0Game.observations.drops.map((drop) => drop.type), ['bomb']);
  assert.equal(mode0.ecl.deathCallbackSub, -1);
  assert.equal(mode0Game.observations.bossPresence.at(-1).present, false);
  assert.equal(runtime.bossSlots[2], mode0, 'mode 0 leaves slot cleanup to releaseEnemy');

  const mode1Game = makeHost();
  const mode1 = runtime.spawnEclEnemy(mode1Game, { subId: 0, x: 0, y: 0, item: 0, score: 500 });
  mode1.ecl.deathMode = 1;
  mode1.ecl.deathCallbackSub = 1;
  mode1.ecl.isBoss = true;
  mode1.ecl.bossSlot = 0;
  runtime.bossSlots[0] = mode1;
  mode1.hp = 0;
  assert.equal(runtime.killEnemy(mode1Game, mode1), true);
  assert.equal(mode1.ecl.interactable, false);
  assert.equal(mode1.ecl.ctx.subId, 1);
  assert.deepEqual(mode1Game.observations.scores, [50]);
  assert.deepEqual(mode1Game.observations.drops.map((drop) => drop.type), ['power']);
  assert.equal(mode1Game.observations.bossPresence.at(-1).present, false);
  assert.equal(runtime.bossSlots[0], mode1, 'mode 1 keeps its boss-slot pointer for callback ECL');

  const mode2Game = makeHost();
  const mode2 = runtime.spawnEclEnemy(mode2Game, { subId: 0, x: 0, y: 0, item: 1, score: 500 });
  mode2.ecl.deathMode = 2;
  mode2.ecl.deathCallbackSub = 1;
  mode2.ecl.isBoss = true;
  mode2.ecl.bossSlot = 3;
  runtime.bossSlots[3] = mode2;
  mode2.hp = 0;
  assert.equal(runtime.killEnemy(mode2Game, mode2), true);
  assert.equal(mode2.ecl.interactable, true);
  assert.equal(mode2.ecl.ctx.subId, 1);
  assert.deepEqual(mode2Game.observations.scores, []);
  assert.deepEqual(mode2Game.observations.drops.map((drop) => drop.type), ['point']);
  assert.deepEqual(mode2Game.observations.bossPresence, [], 'mode 2 keeps boss presence set');
  assert.equal(runtime.bossSlots[3], mode2);

  const mode3Game = makeHost();
  const mode3 = runtime.spawnEclEnemy(mode3Game, { subId: 0, x: 0, y: 0, item: 2, score: 500 });
  mode3.ecl.deathMode = 3;
  mode3.ecl.deathCallbackSub = 1;
  mode3.ecl.invisible = true;
  mode3.ecl.isBoss = true;
  mode3.ecl.bossSlot = 1;
  runtime.bossSlots[1] = mode3;
  mode3.hp = 0;
  assert.equal(runtime.killEnemy(mode3Game, mode3), true);
  assert.equal(mode3.hp, 1);
  assert.equal(mode3.ecl.canTakeDamage, false);
  assert.equal(mode3.ecl.deathMode, 0);
  assert.equal(mode3.ecl.ctx.subId, 1);
  assert.deepEqual(mode3Game.observations.scores, []);
  assert.deepEqual(mode3Game.observations.drops, []);
  assert.equal(mode3Game.observations.bossPresence.at(-1).present, false);
  assert.equal(runtime.bossSlots[1], mode3, 'mode 3 keeps its boss-slot pointer for callback ECL');

  const disabledGame = makeHost();
  const disabled = runtime.spawnEclEnemy(disabledGame, { subId: 0, x: 0, y: 0 });
  disabled.ecl.interactable = false;
  disabled.ecl.deathMode = 2;
  disabled.ecl.deathCallbackSub = 1;
  disabled.hp = 0;
  assert.equal(runtime.killEnemy(disabledGame, disabled), true);
  assert.equal(disabled.ecl.deathCallbackSub, 1, 'disabled actors do not consume death callbacks');
  assert.equal(disabled.ecl.ctx.subId, 0);
});

test('stage-4 unset interrupt 12 defaults to sub 0 and cleans slots 4-6', () => {
  const noAnm = { hasScript: () => false };
  const runtime = new StageRuntime(TH07_DATA.stages[4], { etama: noAnm, enemy: noAnm, effect: noAnm });
  const game = makeHost();
  const helpers = [108, 115, 118].map((subId) =>
    runtime.spawnEclEnemy(game, { subId, x: 0, y: 0, life: 1, item: -2, score: 0 }));

  assert.deepEqual(helpers.map((enemy) => enemy.ecl.bossSlot), [4, 5, 6]);
  assert.deepEqual(helpers.map((enemy) => enemy.ecl.interrupts[12]), [109, 0, 0]);

  runtime.spawnEclEnemy(game, { subId: 50, x: 0, y: 0, life: 1, item: -2, score: 0 });
  assert.deepEqual(helpers.map((enemy) => enemy.ecl.pendingInterrupt), [12, 12, 12]);
  helpers.forEach((enemy) => runtime.updateEnemy(game, enemy));
  assert.ok(helpers.every((enemy) => enemy.dead), 'all three late helpers must run their delete interrupt');
});
