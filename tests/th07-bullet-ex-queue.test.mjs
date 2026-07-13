import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssets, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync('tests/replays/th7_udFe25.rpy'));
const stage = rpy.stages[0];

function sceneForTest() {
  const scene = new mod.StageScene(
    makeStubAssets(mod), makeStubAudio(), rpy.difficulty, rpy.character,
    stage.stage, null, stage.rngSeed
  );
  scene.clearEnemyBullets();
  scene.enemyBulletManagerEntryCount = 0;
  scene.playerObj.x = 360;
  scene.playerObj.y = 420;
  return scene;
}

function slot(opcode, cond = 1, arg3 = 0, arg4 = 0, f0 = 0, f1 = 0) {
  return { opcode, cond, arg3, arg4, f0, f1 };
}

function fireOne(scene, flags, exSlots, speed = 2, sprite = 0) {
  const enemy = { id: 9001, x: 192, y: 128, ecl: { subId: 20, shootOffset: { x: 0, y: 0, z: 0 } } };
  scene.runtime.spawnBullets(scene, enemy, {
    sprite, offset: 0, count1: 1, count2: 1,
    speed1: speed, speed2: speed, angle1: 0, angle2: 0,
    flags, sfx: 0, exSlots, aimMode: 3
  });
  assert.equal(scene.enemyBullets.length, 1);
  return scene.enemyBullets[0];
}

test('op79 promotes one movement slot per native bullet-manager tick', () => {
  const scene = sceneForTest();
  // Stage-1 sub20 shape: speed ramp at construction, angle change on the
  // 16-frame spawn-state exit, direction change on the following tick.
  const bullet = fireOne(scene, 0x65, [
    slot(1),
    slot(0x20, 1, 120, 0, 0, Math.PI / 60),
    slot(0x40, 1, 30, 1, Math.PI / 6, -999),
    null, null
  ]);

  assert.equal(bullet.exFlags, 0x1, 'constructor promotes only slot 0');
  assert.equal(bullet.exBehaviorIndex, 1);
  for (let i = 0; i < 15; i++) scene.updateBullets();
  assert.equal(bullet.spawnAge, 15);
  assert.equal(bullet.exFlags, 0x1, 'spawn states do not advance the queue');

  scene.updateBullets();
  assert.equal(bullet.spawnAge, 16);
  assert.equal(bullet.exFlags, 0x21, 'transition tick promotes exactly slot 1');
  assert.equal(bullet.exBehaviorIndex, 2);
  assert.equal(bullet.age, 0, 'normal age remains zero after the transition tick');
  assert.equal(bullet.exRampElapsed, 1, 'active behavior clock advances on transition');
  assert.equal(bullet.exAngleElapsed, 1);

  scene.updateBullets();
  assert.equal(bullet.exFlags, 0x61, 'following normal tick promotes slot 2');
  assert.equal(bullet.exBehaviorIndex, 3);
  assert.equal(bullet.age, 1);
  assert.equal(bullet.exRampElapsed, 2);
  assert.equal(bullet.exAngleElapsed, 2);
  assert.equal(bullet.exDirElapsed, 1);
});

test('spawn lifetime comes from both the selected state and native bullet template', () => {
  const scene = sceneForTest();
  const ordinary = fireOne(scene, 0x8, [null, null, null, null, null], 2, 6);

  assert.equal(ordinary.spawnDuration, 32, 'template 6 uses the 32-tick state-4 ANM');
  scene.clearEnemyBullets();

  const ringState3 = fireOne(scene, 0x4, [null, null, null, null, null], 2, 7);
  assert.equal(ringState3.spawnDuration, 32, 'template 7 shares one 32-tick ANM across spawn states');
  scene.clearEnemyBullets();

  const ringState2 = fireOne(scene, 0x2, [null, null, null, null, null], 2, 7);
  assert.equal(ringState2.spawnDuration, 32, 'template 7 state 2 also selects the shared ANM');
  scene.clearEnemyBullets();

  const largeBall = fireOne(scene, 0x8, [null, null, null, null, null], 2, 10);
  assert.equal(largeBall.spawnDuration, 24, 'template 10 uses the 24-tick state-4 ANM');
  for (let i = 0; i < 23; i++) scene.updateBullets();
  assert.equal(largeBall.spawnAge, 23);
  assert.equal(largeBall.age, 0);

  scene.updateBullets();
  assert.equal(largeBall.spawnAge, 24);
  assert.equal(largeBall.age, 0, 'transition tick falls through but leaves normal age at zero');
});

test('enemy-bullet integration stores float32 position every manager tick', () => {
  const scene = sceneForTest();
  const bullet = fireOne(scene, 0, [null, null, null, null, null]);
  bullet.x = Math.fround(310.7702331542969);
  bullet.y = Math.fround(419.0166015625);
  bullet.vx = Math.fround(0.07044501602649689);
  bullet.vy = Math.fround(0.15104727447032928);

  let expectedX = bullet.x;
  let expectedY = bullet.y;
  for (let i = 0; i < 4; i++) {
    expectedX = Math.fround(expectedX + bullet.vx);
    expectedY = Math.fround(expectedY + bullet.vy);
    scene.updateBullets();
  }
  assert.deepEqual([bullet.x, bullet.y], [expectedX, expectedY]);
  assert.notEqual(bullet.y, 419.0166015625 + 4 * bullet.vy,
    'native slot storage rounds each intermediate add, not only the final read');
});

test('op79 skips unselected/grace slots in one pass but stops after one movement slot', () => {
  const scene = sceneForTest();
  const bullet = fireOne(scene, 0x2020, [
    slot(0x10, 1, 60, 0, 0.1, 0), // not selected by FIRE flags
    slot(0x2000, 1, 45),           // grace loops without consuming the budget
    slot(0x20, 1, 30, 0, 0.01, 0.02),
    slot(0x40, 1, 10, 1, 0.5, 1),
    null
  ]);

  assert.equal(bullet.graceFrames, 45);
  assert.equal(bullet.exFlags, 0x20);
  assert.equal(bullet.exBehaviorIndex, 3);
  assert.equal(bullet.exDir, null, 'second selected movement waits for a manager tick');
});

test('op79 cond-zero slot waits until all earlier behavior flags clear', () => {
  const scene = sceneForTest();
  const bullet = fireOne(scene, 0x11, [
    slot(1),
    slot(0x10, 0, 10, 0, 0.01, -999),
    null, null, null
  ], 0.1);

  for (let i = 0; i < 17; i++) scene.updateBullets();
  assert.equal(bullet.exBehaviorIndex, 1);
  assert.equal(bullet.exFlags, 1);
  scene.updateBullets();
  assert.equal(bullet.exFlags, 0, 'speed ramp clears before the cond slot can pass');
  scene.updateBullets();
  assert.equal(bullet.exBehaviorIndex, 2);
  assert.equal(bullet.exFlags, 0x10);
  assert.equal(bullet.exAccelElapsed, 1);
});
