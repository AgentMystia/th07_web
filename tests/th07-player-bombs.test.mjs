import assert from 'node:assert/strict';
import test from 'node:test';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/player-bombs';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/player-bombs.ts --bundle --format=esm --outfile=${outDir}/player-bombs.mjs --log-level=silent`);
const { BombEngine, BombRunner } = await import('../tests/.build/player-bombs/player-bombs.mjs');

test('focused ReimuA homing orbs launch at speed 8 in native slots 1..7', () => {
  const engine = new BombEngine();
  const runner = new BombRunner(engine, 'reimuA', true);
  const ctx = {
    player: { x: 100, y: 100 },
    fx: { spawn() {} },
    rng: { range: () => Math.PI }, // launch angle = 0
    frame: 0,
    duration: 300,
    focused: true,
    rate: 1,
    enemies: [],
    enemyBullets: [],
    playSfx() {},
    spawnParticles() {},
    startScreenShake() {},
    addBulletClearRegion() {},
    createBombAnmRunner() { throw new Error('unused'); }
  };
  runner.start(ctx);

  ctx.frame = 80;
  runner.tick(ctx);
  assert.equal(engine.slots[0].active, false, 'native wave index 0 is skipped');
  assert.deepEqual(
    { x: engine.slots[1].x, y: engine.slots[1].y, w: engine.slots[1].radiusX },
    { x: 100, y: 100, w: 48 }
  );

  ctx.frame = 81;
  runner.tick(ctx);
  assert.equal(engine.slots[1].x, 108, 'FUN_004074e0 seeds cos(0)*8, not a unit vector');
  assert.equal(engine.slots[1].y, 100);
});

test('ReimuA publishes r128 clear circles only while each orb is in state 1', () => {
  const makeCtx = () => ({
    player: { x: 100, y: 100 },
    fx: { spawn() {} },
    rng: { range: () => Math.PI },
    frame: 0,
    duration: 300,
    focused: false,
    rate: 1,
    enemies: [],
    enemyBullets: [],
    playSfx() {},
    spawnParticles() {},
    startScreenShake() {},
    clearRegions: [],
    addBulletClearRegion(x, y, radius, growth, frames) {
      this.clearRegions.push({ x, y, radius, growth, frames });
    },
    createBombAnmRunner() { throw new Error('unused'); }
  });

  const unfocusedEngine = new BombEngine();
  const unfocused = new BombRunner(unfocusedEngine, 'reimuA', false);
  const u = makeCtx();
  unfocused.start(u);
  u.frame = 12;
  unfocused.tick(u);
  u.frame = 55;
  for (let i = 0; i < 62; i++) unfocused.tick(u);
  assert.equal(u.clearRegions.length, 64,
    'the maturity tick allocates its expanding detonation circle and still executes the state-1 clear call');
  assert.deepEqual(u.clearRegions[0], { x: 100, y: 100, radius: 128, growth: 0, frames: 0 });
  assert.deepEqual(
    u.clearRegions.slice(-2).map(({ radius, growth, frames }) => ({ radius, growth, frames })),
    [
      { radius: 64, growth: Math.fround(64 / 15), frames: 30 },
      { radius: 128, growth: 0, frames: 0 }
    ]
  );
  unfocused.tick(u);
  assert.equal(u.clearRegions.length, 64, 'state-2 aftermath attack slots do not republish clear regions');

  const focusedEngine = new BombEngine();
  const focused = new BombRunner(focusedEngine, 'reimuA', true);
  const f = makeCtx();
  f.focused = true;
  focused.start(f);
  f.frame = 80;
  focused.tick(f);
  focusedEngine.slots[1].hitTally = 100;
  f.frame = 81;
  focused.tick(f);
  assert.equal(f.clearRegions.length, 3,
    'the focused detonation tick publishes its final r128 circle followed by the expanding burst');
  assert.deepEqual(
    f.clearRegions.slice(-2).map(({ radius, growth, frames }) => ({ radius, growth, frames })),
    [
      { radius: 128, growth: 0, frames: 0 },
      { radius: 32, growth: Math.fround(20 / 3), frames: 15 }
    ]
  );
  f.frame = 82;
  focused.tick(f);
  assert.equal(f.clearRegions.length, 3, 'focused state 2 does not republish a circle');
});

test('unfocused MarisaB uses authored VM spacing and publishes circular clear regions', () => {
  const engine = new BombEngine();
  const updates = [0, 0, 0];
  const runners = updates.map((_, i) => ({
    spriteHeight: () => 94,
    currentScaleY: () => 7,
    spriteFrame: () => ({ id: i }),
    update: () => { updates[i]++; }
  }));
  const clearRegions = [];
  const shakes = [];
  const runner = new BombRunner(engine, 'marisaB', false);
  const ctx = {
    player: { x: 320, y: 140 },
    fx: { spawn() {} },
    rng: { range: () => 0 },
    frame: 0,
    elapsed: 0,
    duration: 300,
    focused: false,
    rate: 1,
    enemies: [],
    enemyBullets: [],
    playSfx() {},
    spawnParticles() {},
    startScreenShake(duration, from, to) { shakes.push({ duration, from, to }); },
    addBulletClearRegion(x, y, radius, growth, frames) {
      clearRegions.push({ x, y, radius, growth, frames });
    },
    createBombAnmRunner(scriptId) { return runners[scriptId - 12]; }
  };
  runner.start(ctx);
  runner.tick(ctx);
  assert.equal([...engine.activeSlots()].length, 0, 'native frame 0 is setup only');
  assert.deepEqual(updates, [0, 0, 0]);

  ctx.frame = 1;
  ctx.elapsed = 1;
  runner.tick(ctx);
  assert.equal([...engine.activeSlots()].length, 18);
  assert.deepEqual(updates, [1, 1, 1]);
  assert.equal(clearRegions.length, 18);
  assert.deepEqual(clearRegions[0], {
    x: engine.slots[0].x, y: engine.slots[0].y, radius: 64, growth: 0, frames: 0
  });
  const d0 = Math.hypot(engine.slots[0].x - 320, engine.slots[0].y - 140);
  const d1 = Math.hypot(engine.slots[1].x - 320, engine.slots[1].y - 140);
  assert.ok(Math.abs(d0 - 32) < 1e-4);
  assert.ok(Math.abs(d1 - 163.6) < 1e-3,
    'spacing is 94*7/5=131.6, not the old fixed 76px approximation');

  const draws = [];
  runner.draw({ drawAnmFrame: (...args) => draws.push(args) }, 32, 16);
  assert.equal(draws.length, 3, 'all three authored Master Spark beam VMs are drawn');
  assert.deepEqual(draws.map((draw) => draw.slice(1, 3)), [
    [352, 156], [352, 156], [352, 156]
  ], 'beam VMs follow the live player origin');
  assert.ok(Math.abs(draws[0][3].rotation) < 1e-3,
    'the straight-up beam applies the native +pi/2 sprite-axis correction');

  ctx.frame = 20;
  ctx.elapsed = 20;
  runner.tick(ctx);
  ctx.frame = 80;
  ctx.elapsed = 80;
  runner.tick(ctx);
  assert.deepEqual(shakes, [
    { duration: 60, from: 1, to: 7 },
    { duration: 100, from: 24, to: 0 }
  ]);
});
