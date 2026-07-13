import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// LASER-001: automated grow/hold/shrink geometry + player hit/graze tests
// (PLAN.md acceptance: player on the telegraph line, the effective line and
// outside). Grow-phase displayWidth follows the exe's two-branch formula
// (flat 1.2 hairline until the last min(grow,30) frames — all.c:16223-16241);
// shrinkCutoff gates COLLISION only (render draws while allocated).

const outDir = 'tests/.build/laser-collision';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/stage-scene.ts --bundle --format=esm --outfile=${outDir}/stage-scene.mjs --log-level=silent`);
const { StageScene } = await import(`../${outDir}/stage-scene.mjs`);

function makeLaser(overrides = {}) {
  return {
    id: 1, poolSlot: 0, ownerId: 0, inUse: true, sprite: 1, color: 2,
    x: 0, y: 0, angle: 0, speed: 0,
    nearDist: 10, farDist: 110, maxLength: 110,
    width: 20, displayWidth: 1.2,
    growDuration: 90, holdDuration: 60, shrinkDuration: 200,
    telegraphDelay: 70, shrinkCutoff: 16,
    flags: 0, state: 0, phaseFrame: 0, hideTipDuringGrow: false,
    ...overrides
  };
}

function scene(player = {}) {
  const s = Object.create(StageScene.prototype);
  s.slowRate = 1;
  s.enemyLasers = [];
  s.playerObj = { x: 60, y: 0, hitboxHalf: 1, grazeboxHalf: 2, alive: true, ...player };
  s.onPlayerHit = () => {};
  s.onGrazeAward = () => {};
  return s;
}

test('grow displayWidth: flat 1.2 hairline until the last 30 frames, then the grow-normalized ramp', () => {
  const s = scene();
  const l = makeLaser({ growDuration: 90, width: 16 });
  s.enemyLasers.push(l);
  // Calls 1..61 evaluate phaseFrames 0..60 — all in the flat branch
  // (ramp requires growDuration-30=60 < phaseFrame).
  for (let call = 1; call <= 61; call++) {
    s.updateLasers();
    assert.equal(l.displayWidth, 1.2, `call ${call}: hairline`);
  }
  s.updateLasers(); // evaluates phaseFrame 61 -> ramp
  // Exe formula: phaseFrame*width/growDuration (not window-normalized) —
  // the telegraph pops from the hairline onto the tail of the full ramp.
  assert.ok(Math.abs(l.displayWidth - (61 * 16) / 90) < 1e-9, `pop onto the ramp (${l.displayWidth})`);
  while (l.state === 0) s.updateLasers();
  assert.equal(l.state, 1, 'grow handed off to hold');
  assert.equal(l.displayWidth, 16, 'full width at hold');
});

test('collision: telegraph frames are safe, post-telegraph grow nub hits, hold spans the beam', () => {
  const s = scene({ x: 60, y: 0 });
  const l = makeLaser({ state: 0, phaseFrame: 69, displayWidth: 1.2 });
  assert.equal(s.checkLaserCollision(l), 'miss', 'before telegraphDelay nothing hits');
  l.phaseFrame = 70;
  assert.equal(s.checkLaserCollision(l), 'hit', 'on the line once the telegraph arms');
  // Off the hairline nub, inside where the HOLD beam will be: still safe in grow.
  s.playerObj.x = 100;
  l.phaseFrame = 71; // non-multiple of 12: no graze either
  assert.equal(s.checkLaserCollision(l), 'miss', 'grow only kills around the midpoint nub');
  // HOLD: the full near..far span kills.
  const hold = makeLaser({ state: 1, phaseFrame: 1, displayWidth: 20 });
  for (const x of [15, 60, 105]) {
    s.playerObj.x = x;
    s.playerObj.y = 0;
    assert.equal(s.checkLaserCollision(hold), 'hit', `hold hits along the beam (x=${x})`);
  }
  s.playerObj.x = 60;
  s.playerObj.y = 6.5; // outside width/4 + hitboxHalf = 6
  assert.equal(s.checkLaserCollision(hold), 'miss', 'just off the kill width, off the graze tick');
  hold.phaseFrame = 12;
  assert.equal(s.checkLaserCollision(hold), 'graze', 'graze pad on the 12-frame tick');
  s.playerObj.y = 60; // beyond the flat 48 pad
  assert.equal(s.checkLaserCollision(hold), 'miss', 'outside the graze pad entirely');
});

test('shrink: collision gates at shrinkCutoff while the slot stays drawable until shrinkDuration', () => {
  const s = scene({ x: 60, y: 0 });
  const l = makeLaser({ state: 2, phaseFrame: 15, displayWidth: 18, shrinkCutoff: 16, shrinkDuration: 200 });
  assert.equal(s.checkLaserCollision(l), 'hit', 'shrink still kills before the cutoff');
  l.phaseFrame = 16;
  assert.equal(s.checkLaserCollision(l), 'miss', 'shrinkCutoff closes collision');
  // The slot itself lives (and keeps drawing) until shrinkDuration.
  s.enemyLasers.push(l);
  let calls = 0;
  while (l.inUse && calls < 300) {
    s.updateLasers();
    calls++;
  }
  assert.equal(l.inUse, false, 'freed when the shrink finishes');
  assert.equal(calls, 185, 'allocated for the whole 200-frame shrink, not just to the cutoff');
});

test('laser manager tests the native phase before advancing its split counter', () => {
  const s = scene({ x: 60, y: 6.5 });
  let grazes = 0;
  s.onGrazeAward = () => { grazes++; };
  const l = makeLaser({ state: 1, phaseFrame: 12, displayWidth: 20 });
  s.enemyLasers.push(l);

  s.updateLasers();
  assert.equal(grazes, 1, 'phase-12 graze occurs before the counter becomes 13');
  assert.equal(l.phaseFrame, 13);
});

test('laser phase transitions collide in both old and new states before the common tail tick', () => {
  const growScene = scene();
  const growCalls = [];
  growScene.resolveLaserCollision = (laser, geometryState = laser.state) => {
    growCalls.push({ state: laser.state, phase: laser.phaseFrame, width: laser.displayWidth, geometryState });
  };
  const grow = makeLaser({ state: 0, phaseFrame: 90, growDuration: 90, width: 20 });
  growScene.enemyLasers.push(grow);
  growScene.updateLasers();
  assert.deepEqual(growCalls.map(({ state, phase }) => [state, phase]), [[0, 90], [1, 0]],
    'grow completion evaluates final-grow then phase-0 hold collision');
  assert.deepEqual(growCalls.map(({ geometryState }) => geometryState), [0, 0],
    'phase-0 hold call retains the grow branch collision box');
  assert.equal(grow.state, 1);
  assert.equal(grow.phaseFrame, 1, 'shared tail advances the new hold phase');

  const holdScene = scene();
  const holdCalls = [];
  holdScene.resolveLaserCollision = (laser, geometryState = laser.state) => {
    holdCalls.push({ state: laser.state, phase: laser.phaseFrame, width: laser.displayWidth, geometryState });
  };
  const hold = makeLaser({ state: 1, phaseFrame: 60, holdDuration: 60, shrinkDuration: 200, width: 20 });
  holdScene.enemyLasers.push(hold);
  holdScene.updateLasers();
  assert.deepEqual(holdCalls.map(({ state, phase }) => [state, phase]), [[1, 60], [2, 0]],
    'hold completion evaluates final-hold then phase-0 shrink collision');
  assert.deepEqual(holdCalls.map(({ geometryState }) => geometryState), [1, 2],
    'phase-0 shrink call recomputes the shrinking midpoint box');
  assert.equal(hold.state, 2);
  assert.equal(hold.phaseFrame, 1, 'shared tail advances the new shrink phase');
});

test('angled laser projection uses the native FUN_00430070 orientation', () => {
  const s = scene({ x: 200.763397217, y: 418.516937256, hitboxHalf: 1.1 });
  const l = makeLaser({
    x: 206.124359131, y: 213.701629639, angle: 1.753861785,
    state: 2, phaseFrame: 12, nearDist: 0, farDist: 500,
    width: 1.2, displayWidth: 0.3, shrinkCutoff: 16
  });
  assert.equal(s.checkLaserCollision(l), 'graze',
    'Stage-3 native slot 1 reaches the player only with the positive-angle rotation');
});
