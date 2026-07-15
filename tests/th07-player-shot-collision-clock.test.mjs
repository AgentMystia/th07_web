import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssets, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync('tests/replays/th7_udFe25.rpy'));
const stage = rpy.stages[0];

function makeScene() {
  return new mod.StageScene(
    makeStubAssets(mod), makeStubAudio(), rpy.difficulty, rpy.character,
    stage.stage, null, stage.rngSeed
  );
}

function collisionTarget() {
  return {
    dead: false,
    ecl: {
      shotCollision: true,
      interactable: true,
      invisible: false,
      hitbox: { x: 32, y: 32, z: 32 },
      hitbox2: null
    }
  };
}

// Th07.exe FUN_0043a980 @ all.c:27626 compares the generic player-state
// timer (+0x16a08) with its previous integer value (+0x16a00) before it
// scans any of the 96 player-shot or 112 attack slots. FUN_0043e2e0's
// normal-state branch snapshots current->previous and advances that timer
// through FUN_00436acc, so rate 1/3 permits collisions once every 3 frames.
test('player-shot enemy collision follows the native slowmo split clock', () => {
  const scene = makeScene();
  const enemy = collisionTarget();
  let scans = 0;
  scene.collidePlayerShotsInBox = () => { scans++; };
  scene.slowRate = 1 / 3;

  scene.tickPlayerShotCollisionClock(false);
  scene.collidePlayerShots(enemy);
  assert.equal(scans, 0, 'first fractional tick leaves current == previous');

  scene.tickPlayerShotCollisionClock(false);
  scene.collidePlayerShots(enemy);
  assert.equal(scans, 0, 'second fractional tick still skips the native pool scan');

  scene.tickPlayerShotCollisionClock(false);
  scene.collidePlayerShots(enemy);
  assert.equal(scans, 1, 'third tick advances the integer and enables collision');
});

test('invulnerability/Border collision clock retreats at the native slowmo cadence', () => {
  const scene = makeScene();
  const enemy = collisionTarget();
  let scans = 0;
  scene.collidePlayerShotsInBox = () => { scans++; };
  scene.slowRate = 1 / 4;

  scene.tickPlayerShotCollisionClock(true);
  scene.collidePlayerShots(enemy);
  assert.equal(scans, 1, 'the zero-fraction first special-state tick retreats immediately');

  scene.tickPlayerShotCollisionClock(true);
  scene.collidePlayerShots(enemy);
  scene.tickPlayerShotCollisionClock(true);
  scene.collidePlayerShots(enemy);
  scene.tickPlayerShotCollisionClock(true);
  scene.collidePlayerShots(enemy);
  assert.equal(scans, 1, 'the following three quarter-rate ticks retain the same integer');

  scene.tickPlayerShotCollisionClock(true);
  scene.collidePlayerShots(enemy);
  assert.equal(scans, 2, 'the fifth wall tick crosses below zero and retreats again');

  scene.tickPlayerShotCollisionClock(false);
  scene.collidePlayerShots(enemy);
  assert.equal(scans, 2, 'state exit resets fractional residue before normal cadence resumes');
});

test('natural Border expiry resets the shared state-3 collision split timer', () => {
  const scene = makeScene();
  const enemy = collisionTarget();
  let scans = 0;
  scene.collidePlayerShotsInBox = () => { scans++; };
  scene.slowRate = 1 / 2;

  // The expiry frame first advances the still-active state-4 clock. Its
  // fraction is now 0.5, then FUN_0043e620 replaces the timer with a fresh
  // state-3 current=40/frac=0/previous=-999 tuple.
  scene.tickPlayerShotCollisionClock(true);
  scene.cherry.borderTimer = 1;
  scene.cherry.borderTimerFrac = 0;
  scene.cherry.tick(scene.slowRate);

  scene.tickPlayerShotCollisionClock(true);
  scene.collidePlayerShots(enemy);
  assert.equal(scans, 1,
    'the first state-3 half-rate tick retreats immediately after Border expiry');
});

test('the enemy manager skips every collision and aim-cache phase while high-spell bomb suppression is set', () => {
  const scene = makeScene();
  const ecl = scene.runtime.makeEnemyState(0, false, -1, null);
  ecl.bombCollisionSuppressed = true;
  const enemy = {
    id: 999,
    poolSlot: 0,
    x: 192,
    y: 128,
    z: 0,
    hp: 100,
    maxHp: 100,
    pendingShotDmg: 0,
    pendingBombDmg: 0,
    score: 0,
    frame: 0,
    dead: false,
    ecl
  };
  scene.enemies.length = 0;
  scene.enemies.push(enemy);
  scene.enemySlots.fill(null);
  scene.enemySlots[0] = enemy;
  scene.tickRankSurvival = () => {};
  scene.runtime.update = () => {};
  scene.runtime.tickEnemyCore = () => {};
  scene.runtime.integrateEnemyPosition = () => {};
  scene.tickSpellBonusDecay = () => {};
  scene.updateEnemyTrailHistory = () => {};
  scene.updateEnemyCull = () => {};
  scene.runtime.processEnemyCallbacks = () => false;
  scene.runtime.updateEnemyAnm = () => {};
  scene.runtime.tickEnemyManagerTail = () => {};
  const calls = [];
  scene.collideEnemyBody = () => calls.push('body');
  scene.collidePlayerShots = () => calls.push('shots');
  scene.settlePendingDamage = () => calls.push('damage');
  scene.accumulatePlayerAimCaches = () => calls.push('aim');

  scene.updateEnemies();

  assert.deepEqual(calls, [],
    'enemy+0x2e2b bit2 bypasses body, FUN_0043a980, settlement and homing publication');
});
