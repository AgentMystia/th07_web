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
  const observations = { scores: [], drops: [], effects: [], sfx: [], deathEffects: 0, bossPresence: [] };
  return {
    observations,
    rng: {
      range: () => 0,
      u16: () => rngValues[rngIndex++] ?? 0,
      u16InRange: () => 0,
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
    spawnEffectParticles(id, x, y, count, color) {
      observations.effects.push({ id, x, y, count, color });
    },
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
  const game = makeHost();
  const signs = [0, 1];
  let u16Calls = 0;
  let u32Calls = 0;
  game.rng.u16 = () => signs[u16Calls++] ?? 0;
  game.rng.u32 = () => { u32Calls++; return 0; };
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });

  assert.equal(enemy.ecl.vars[0], -7);
  assert.equal(enemy.ecl.vars[4], 2.5);
  assert.equal(u16Calls, 2, 'each sign assignment consumes one raw u16');
  assert.equal(u32Calls, 0, 'sign assignment never enters the u32 wrapper');
});

test('integer writes do not alias float-backed ECL locals', () => {
  const runtime = makeRuntime([[
    instruction(0, 5, [f32(10004), f32(400)]),
    instruction(0, 10, [i32(10004), i32(0)])
  ]]);
  const game = makeHost();
  let u16Calls = 0;
  game.rng.u16 = () => { u16Calls++; return 0; };
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });

  // FUN_0040dda0 does not map float local 10004. Native therefore writes
  // into the instruction operand and leaves enemy+0x70c untouched. Stage-3
  // Sub8 uses the retained 400.0 value as its FIRE ring-angle stride.
  assert.equal(enemy.ecl.vars[4], 400);
  assert.equal(u16Calls, 1, 'the invalid typed destination still consumes the sign draw');
});

test('op40 wraps its float-variable operand in place without changing movement mode', () => {
  const runtime = makeRuntime([[
    instruction(0, 5, [f32(10004), f32(-5 * Math.PI / 4)]),
    instruction(0, 40, [f32(10004)], 1),
    instruction(0, 5, [f32(10005), f32(5 * Math.PI / 4)]),
    instruction(0, 40, [f32(10005)], 1)
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });

  close(enemy.ecl.vars[4], 3 * Math.PI / 4, 'negative angle wraps upward by 2pi');
  close(enemy.ecl.vars[5], -3 * Math.PI / 4, 'positive angle wraps downward by 2pi');
  assert.equal(enemy.ecl.moveMode, 0, 'op40 does not arm mode-1 movement');
});

test('op151 writes cosine to its first destination and sine to its second', () => {
  const runtime = makeRuntime([[
    instruction(0, 151, [f32(10004), f32(10005), f32(Math.PI / 6), f32(8)])
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });

  // Th07.exe (v1.00b) @ 0x4156d9-0x4157b3: fsin writes operand 1,
  // then fcos writes operand 0. The older probable spec had them reversed.
  close(enemy.ecl.vars[4], Math.cos(Math.PI / 6) * 8, 'first destination is X/cos');
  close(enemy.ecl.vars[5], Math.sin(Math.PI / 6) * 8, 'second destination is Y/sin');
});

test('integer operands truncate float-backed variables like native _ftol', () => {
  const positive = makeRuntime([[
    instruction(0, 5, [f32(10004), f32(15.846416)]),
    instruction(0, 4, [i32(10000), i32(10004)], 2)
  ]]).spawnEclEnemy(makeHost(), { subId: 0, x: 0, y: 0 });
  assert.equal(positive.ecl.vars[0], 15,
    'FUN_00481260 truncates a positive float variable toward zero');

  const negative = makeRuntime([[
    instruction(0, 5, [f32(10004), f32(-15.846416)]),
    instruction(0, 4, [i32(10000), i32(10004)], 2)
  ]]).spawnEclEnemy(makeHost(), { subId: 0, x: 0, y: 0 });
  assert.equal(negative.ecl.vars[0], -15,
    'FUN_00481260 truncates a negative float variable toward zero');
});

test('op27 own-position targets roll back into the manager delta and retain the final velocity', () => {
  const interp = (target, end) => instruction(0, 27, [
    f32(target), i32(1), i32(0), i32(0),
    f32(0), f32(end), f32(0), f32(0)
  ]);
  const runtime = makeRuntime([[
    interp(10018, 10),
    interp(10019, 20)
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 1, y: 2 });

  assert.deepEqual([enemy.x, enemy.y], [1, 2],
    'allocator core rolls temporary own-position writes back before manager integration');
  assert.deepEqual([enemy.ecl.axisSpeed.x, enemy.ecl.axisSpeed.y], [9, 18]);

  runtime.integrateEnemyPosition(enemy);
  assert.deepEqual([enemy.x, enemy.y], [10, 20], 'manager applies the captured op27 delta once');

  runtime.tickEnemyCore(game, enemy);
  runtime.integrateEnemyPosition(enemy);
  assert.deepEqual([enemy.x, enemy.y], [19, 38],
    'the final op27 delta remains in +0x2b18/1c after the interpolation slot frees');
});

test('op100 allocates the native id13 aura at the enemy position', () => {
  const runtime = makeRuntime([[
    instruction(0, 100, [i32(6), f32(-0.3), f32(-0.7), f32(-0.3), f32(96)])
  ]]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: 64, y: -32, z: 0 });
  assert.deepEqual(game.observations.effects, [{
    id: 13, x: 64, y: -32, count: 1, color: 0xffffe0ff
  }]);
});

test('op51 is the generic ranged float draw; op52 chooses a player-side movement cone', () => {
  const ranged = makeRuntime([[
    instruction(0, 51, [f32(10004), f32(-2), f32(6)])
  ]]);
  const rangedGame = makeHost([0x40000000]); // 0.25 of [-2, 6) = 0
  const rangedEnemy = ranged.spawnEclEnemy(rangedGame, { subId: 0, x: 0, y: 0 });
  close(rangedEnemy.ecl.vars[4], 0, 'op51 ranged result');

  const heading = makeRuntime([[
    instruction(0, 62, [f32(0), f32(0), f32(384), f32(448)]),
    // The apparent -pi/pi operands are ignored by the native op52.
    instruction(0, 52, [f32(10004), f32(-Math.PI), f32(Math.PI)])
  ]]);

  const leftGame = makeHost([0x40000000]); // r=0.25 -> 7pi/8 in left cone
  const left = heading.spawnEclEnemy(leftGame, { subId: 0, x: 200, y: 200 });
  close(left.ecl.vars[4], 7 * Math.PI / 8, 'enemy right of player chooses leftward cone');

  const rightGame = makeHost([0x40000000]); // r=0.25 -> -pi/8 in right cone
  const right = heading.spawnEclEnemy(rightGame, { subId: 0, x: 100, y: 200 });
  close(right.ecl.vars[4], -Math.PI / 8, 'enemy left of player chooses rightward cone');
});

test('op52 reflects at op62 margins and preserves the native right-wall old-heading bug', () => {
  const reflected = makeRuntime([[
    instruction(0, 54, [i32(0), i32(0), f32(0.3), f32(0)]),
    instruction(0, 62, [f32(0), f32(0), f32(384), f32(448)]),
    instruction(0, 52, [f32(10004), f32(-Math.PI), f32(Math.PI)])
  ]]);

  const leftWallGame = makeHost([0x40000000]);
  leftWallGame.player.x = 0; // x=50 is to the player's right: initial 7pi/8
  const leftWall = reflected.spawnEclEnemy(leftWallGame, { subId: 0, x: 50, y: 200 });
  close(leftWall.ecl.vars[4], Math.PI / 8, 'left wall reflects a leftward heading');

  const bottomGame = makeHost([0xc0000000]); // right cone starts at +pi/8
  const bottom = reflected.spawnEclEnemy(bottomGame, { subId: 0, x: 100, y: 420 });
  close(bottom.ecl.vars[4], -Math.PI / 8, 'bottom margin reflects a downward heading');

  const oldHeadingGame = makeHost([0xc0000000]);
  oldHeadingGame.player.x = 400; // x=350 chooses the +pi/8 rightward cone
  const oldHeading = reflected.spawnEclEnemy(oldHeadingGame, { subId: 0, x: 350, y: 200 });
  close(oldHeading.ecl.vars[4], Math.PI - Math.fround(0.3),
    'right-wall positive arm subtracts the previous heading, not the new draw');
});

test('mode-2 movement runs controller step 1 in the allocator and step 2 on the first manager tick', () => {
  const expectedAtQuarter = [0.25, 0.0625, 0.015625, 0.00390625, 0.4375, 0.578125, 0.68359375];
  const expectedAtHalf = [0.5, 0.25, 0.125, 0.0625, 0.75, 0.875, 0.9375];
  const expectedAtThreeQuarters = [0.75, 0.5625, 0.421875, 0.31640625, 0.9375, 0.984375, 0.99609375];
  for (let mode = 0; mode <= 6; mode++) {
    const runtime = makeRuntime([[
      instruction(0, 55, [i32(4), i32(mode), f32(1), f32(0), f32(0)])
    ]]);
    const game = makeHost();
    const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });

    close(enemy.x, 0, `mode ${mode} allocator does not integrate position`);
    close(enemy.ecl.axisSpeed.x, expectedAtQuarter[mode], `mode ${mode} allocator controller step`);
    runtime.updateEnemy(game, enemy);
    close(enemy.x, expectedAtHalf[mode], `mode ${mode} first manager tick is controller step 2`);
    runtime.updateEnemy(game, enemy);
    close(enemy.x, expectedAtThreeQuarters[mode], `mode ${mode} second manager tick`);
    runtime.updateEnemy(game, enemy);
    close(enemy.x, 1, `mode ${mode} completion snap`);
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
    close(enemy.ecl.axisSpeed.x, 2, `mirrored=${mirrored} allocator controller step`);
    runtime.updateEnemy(game, enemy);
    close(enemy.x, mirrored ? -4 : 4, `mirrored=${mirrored} first manager tick`);
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
  close(enemy.x, -8, 'op55 mirrored delta');
});

test('op54 duration zero preserves live angular velocity and acceleration', () => {
  const runtime = makeRuntime([[
    instruction(0, 48, [f32(0.25)]),
    instruction(0, 50, [f32(0.5)]),
    instruction(0, 54, [i32(0), i32(0), f32(0), f32(1)])
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });

  close(enemy.ecl.angularVelocity, 0.25, 'angular velocity survives op54');
  close(enemy.ecl.acceleration, 0.5, 'acceleration survives op54');
  // The synchronous allocator core immediately applies both preserved rates.
  close(enemy.ecl.angle, 0.25, 'preserved angular velocity advances heading');
  close(enemy.ecl.speed, 1.5, 'preserved acceleration advances speed');
});

test('timeline op6 applies mirroring only after its allocator core', () => {
  const sub = [[instruction(0, 54, [i32(4), i32(0), f32(0), f32(2)])]];

  const earlyRuntime = makeRuntime(sub);
  const earlyGame = makeHost();
  earlyRuntime.runTimelineEvent(earlyGame, {
    op: 2, arg0: 0, x: 0, y: 0, z: 0, life: -1, item: -1, score: -1
  }, 0);
  const early = earlyGame.enemies[0];
  earlyRuntime.updateEnemy(earlyGame, early);
  close(early.x, -4, 'op2 allocator core is already mirrored');

  const lateRuntime = makeRuntime(sub);
  const lateGame = makeHost();
  lateRuntime.runTimelineEvent(lateGame, {
    op: 6, arg0: 0, x: 0, y: 0, z: 0, life: -1, item: -1, score: -1
  }, 0);
  const late = lateGame.enemies[0];
  assert.equal(late.ecl.mirrored, true);
  lateRuntime.updateEnemy(lateGame, late);
  close(late.x, 4, 'op6 allocator core arms unmirrored displacement');
});

test('vars 10063-10065 expose the previous manager-pass displacement', () => {
  const runtime = makeRuntime([[
    instruction(0, 47, [f32(0), f32(2), f32(3)]),
    instruction(2, 5, [f32(10004), f32(10063)], 2),
    instruction(2, 5, [f32(10005), f32(10065)], 2)
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 10, y: 20, z: 5 });

  assert.equal(enemy.ecl.frameVx, 0, 'allocator core does not run FUN_0041d050');
  runtime.updateEnemy(game, enemy);
  close(enemy.ecl.frameVx, 10, 'first manager pass measures spawn X from template zero');
  close(enemy.ecl.frameVz, 5, 'first manager pass measures spawn Z from template zero');
  runtime.updateEnemy(game, enemy);

  // The time-2 ECL dispatch ran before this pass replaced frameV* with the
  // 2/0/3 displacement produced by the preceding integration.
  close(enemy.ecl.vars[4], 10, 'ECL read sees prior latched X displacement');
  close(enemy.ecl.vars[5], 5, 'ECL read sees prior latched Z displacement');
  close(enemy.ecl.frameVx, 2, 'current latch advances after dispatch');
  close(enemy.ecl.frameVy, 0, 'current Y displacement');
  close(enemy.ecl.frameVz, 3, 'current Z displacement');
});

test('op59 bounds mode-1 recomputation but preserves its final velocity', () => {
  const runtime = makeRuntime([[
    instruction(0, 54, [i32(0), i32(0), f32(0), f32(0)]),
    instruction(0, 49, [f32(1)]),
    instruction(0, 59, [i32(2)])
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });

  assert.equal(enemy.ecl.moveMode, 1, 'allocator consumes the first bounded controller tick');
  runtime.updateEnemy(game, enemy);
  assert.equal(enemy.ecl.moveMode, 0, 'first manager core consumes the second and final bounded tick');
  close(enemy.x, 1, 'first mode-1 tick');
  runtime.updateEnemy(game, enemy);
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
  mode1.ecl.bulletRankSpeedLow = -0.15;
  mode1.ecl.bulletRankSpeedHigh = 0.15;
  mode1.ecl.bulletRankAmount1Low = -2;
  mode1.ecl.bulletRankAmount1High = 3;
  mode1.ecl.bulletRankAmount2Low = -4;
  mode1.ecl.bulletRankAmount2High = 5;
  mode1.ecl.isBoss = true;
  mode1.ecl.bossSlot = 0;
  runtime.bossSlots[0] = mode1;
  mode1.hp = 0;
  assert.equal(runtime.killEnemy(mode1Game, mode1), true);
  assert.equal(mode1.ecl.interactable, false);
  assert.equal(mode1.ecl.ctx.subId, 1);
  assert.deepEqual([
    mode1.ecl.bulletRankSpeedLow, mode1.ecl.bulletRankSpeedHigh,
    mode1.ecl.bulletRankAmount1Low, mode1.ecl.bulletRankAmount1High,
    mode1.ecl.bulletRankAmount2Low, mode1.ecl.bulletRankAmount2High
  ], [-0.5, 0.5, 0, 0, 0, 0], 'death callback resets the native bullet-rank template');
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

test('helper sweep defers death callbacks to each fixed-slot manager pass', () => {
  const runtime = makeRuntime([
    [
      instruction(1, 9, [f32(10004), f32(1), f32(0)]),
      instruction(1, 9, [f32(10005), f32(1), f32(0)]),
      instruction(1, 9, [f32(10006), f32(1), f32(0)]),
      instruction(1, 93, [i32(2), f32(0), f32(0), f32(0), i32(1), i32(-2), i32(0)]),
      instruction(1, 72, [i32(0), i32(1), i32(1), f32(1), f32(1), f32(0), f32(0), i32(0)])
    ],
    [instruction(0, 4, [i32(10000), i32(99)])],
    []
  ]);
  const game = makeHost();
  let randomCalls = 0;
  game.rng.range = () => { randomCalls++; return 0; };
  const helper = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  helper.ecl.deathMode = 1;
  helper.ecl.deathCallbackSub = 1;
  helper.ecl.sweepItemFlag = true;
  helper.ecl.trailFlags = 1;
  helper.ecl.trailCount = 12;
  helper.ecl.trailHistory[0] = { x: 10, y: 20, z: 0 };
  helper.ecl.trailHistory[6] = { x: 30, y: 40, z: 0 };

  const sweepScore = runtime.killNonBossEnemies(game, null, 0);

  assert.equal(helper.hp, 0, 'FUN_004217c0 only writes HP');
  assert.equal(helper.ecl.ctx.subId, 0, 'sweep does not enter the callback eagerly');
  assert.equal(helper.ecl.deathCallbackSub, 1, 'manager still owns callback dispatch');
  assert.equal(Boolean(helper.dead), false);
  assert.deepEqual(game.observations.drops, [
    { type: 'cherry', x: 0, y: 0 },
    { type: 'cherry', x: 10, y: 20 },
    { type: 'cherry', x: 30, y: 40 }
  ], 'sweep drops the head and every sixth op138 history position');
  assert.equal(sweepScore, 2000 + 2030 + 2060,
    'the native 30-point sweep ramp advances for trail items as well as the head');

  runtime.tickEnemyCore(game, helper);
  assert.equal(randomCalls, 3,
    'a later fixed slot executes its current ECL tick after an earlier-slot sweep');
  assert.equal(game.enemies.length, 1,
    'zero-HP op93 parent does not allocate a replacement helper');
  assert.equal(game.enemyBullets.length, 0,
    'zero-HP FIRE does not decode random template operands or spawn bullets');
  assert.equal(runtime.killEnemy(game, helper), true);
  assert.equal(helper.ecl.ctx.subId, 1, 'normal death switch enters the callback afterward');
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
