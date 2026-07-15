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

function nativeWrapF32(value) {
  const pi = Math.fround(Math.PI);
  const tau = Math.fround(Math.PI * 2);
  let result = Math.fround(value);
  while (result > pi) result = Math.fround(result - tau);
  while (result < -pi) result = Math.fround(result + tau);
  return result;
}

test('FUN_00421e90 stages FIRE origin, polar vector, and spawn backup through float32', () => {
  const scene = sceneForTest();
  scene.slowRate = 1 / 3;
  scene.playerObj.x = 347.123456789;
  scene.playerObj.y = 401.987654321;
  const enemy = {
    id: 9100,
    x: 191.23456789,
    y: 127.87654321,
    ecl: { subId: 12, shootOffset: { x: 0.34567891, y: -0.23456789, z: 0 } }
  };
  const props = {
    sprite: 0, offset: 0, count1: 1, count2: 1,
    speed1: Math.fround(3.451679422576988),
    speed2: Math.fround(0.812345678),
    angle1: Math.fround(0.2718281828), angle2: Math.fround(0.125),
    flags: 0x200, sfx: 0, exSlots: [null, null, null, null, null], aimMode: 0
  };

  scene.runtime.spawnBullets(scene, enemy, props);
  const normal = scene.enemyBullets[0];
  const shootX = Math.fround(enemy.x + enemy.ecl.shootOffset.x);
  const shootY = Math.fround(enemy.y + enemy.ecl.shootOffset.y);
  const dx = Math.fround(scene.playerObj.x - shootX);
  const dy = Math.fround(scene.playerObj.y - shootY);
  const aim = Math.fround(Math.atan2(dy, dx));
  const angle = nativeWrapF32(Math.fround(aim + props.angle1));
  const speed = Math.fround(props.speed1);
  const scaledSpeed = Math.fround(speed * Math.fround(scene.slowRate));
  const vx = Math.fround(Math.cos(angle) * scaledSpeed);
  const vy = Math.fround(Math.sin(angle) * scaledSpeed);

  assert.equal(normal.x, shootX, 'normal-state origin is copied from the f32 FIRE template');
  assert.equal(normal.y, shootY);
  assert.equal(normal.angle, angle, 'completed angle is wrapped and stored as f32');
  assert.equal(normal.speed, speed, 'nominal speed remains the f32 unscaled value');
  assert.equal(normal.vx, vx, 'FUN_004074e0 stores the cosine product as f32');
  assert.equal(normal.vy, vy, 'FUN_004074e0 stores the sine product as f32');

  scene.clearEnemyBullets();
  scene.enemyBulletManagerEntryCount = 0;
  scene.runtime.spawnBullets(scene, enemy, { ...props, flags: 0x202 });
  const spawned = scene.enemyBullets[0];
  assert.equal(spawned.x, Math.fround(shootX - Math.fround(vx * 4)),
    'spawn-state X backs up four stored velocity vectors with f32 stores');
  assert.equal(spawned.y, Math.fround(shootY - Math.fround(vy * 4)),
    'spawn-state Y backs up four stored velocity vectors with f32 stores');
});

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

test('spawn ANM lifetime uses a split counter under 1/3 slowmo', () => {
  const scene = sceneForTest();
  scene.slowRate = 1 / 3;
  const largeBall = fireOne(scene, 0x2, [null, null, null, null, null], 3, 10);
  for (let i = 0; i < 69; i++) scene.updateBullets();
  assert.equal(largeBall.spawnAge, 23);
  assert.equal(largeBall.spawnAgeFrac, 0);
  scene.updateBullets();
  assert.equal(largeBall.spawnAge, 24, 'the frame-1 VM reaches time 24 on wall tick 70');
  assert.equal(largeBall.spawnAgeFrac, 0);
  assert.equal(largeBall.age, 0, 'the transition tick still falls through to normal state');
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

test('op79 acceleration retains the slow rate from its promotion tick', () => {
  const scene = sceneForTest();
  scene.slowRate = 0.5;
  const bullet = fireOne(scene, 0x10, [
    slot(0x10, 1, 10, 0, 0.06, Math.PI / 2),
    null, null, null, null
  ], 0);

  // FUN_004229f0 first stores a rate-baked acceleration vector. The active
  // FUN_00423910 tick then applies the current rate to that retained vector.
  assert.equal(bullet.exAccel.mag, Math.fround(Math.fround(0.06) * 0.5));
  assert.equal(bullet.exAccel.vx,
    Math.fround(Math.cos(Math.fround(Math.PI / 2)) * bullet.exAccel.mag));
  assert.equal(bullet.exAccel.vy,
    Math.fround(Math.sin(Math.fround(Math.PI / 2)) * bullet.exAccel.mag));
  scene.updateBullets();
  assert.ok(Math.abs(bullet.vy - 0.015) < 1e-8);
});

test('op79 angle-change and acceleration store every persistent bullet field as float32', () => {
  const scene = sceneForTest();
  const bullet = fireOne(scene, 0x30, [
    slot(0x20, 1, 180, 0, 0.011111111380159855, -0.01745329238474369),
    slot(0x10, 0, 120, 0, 0.006666666828095913, -999),
    null, null, null
  ], 0);

  let expectedSpeed = Math.fround(bullet.speed);
  let expectedAngle = Math.fround(bullet.angle);
  for (let i = 0; i < 180; i++) {
    expectedAngle = nativeWrapF32(
      Math.fround(expectedAngle + Math.fround(bullet.exAngle.angleDelta))
    );
    expectedSpeed = Math.fround(expectedSpeed + Math.fround(bullet.exAngle.speedDelta));
    scene.updateBulletMotion(bullet);
  }
  assert.equal(bullet.speed, expectedSpeed, 'angle-change speed is fstp-stored each tick');
  assert.equal(bullet.angle, expectedAngle, 'angle-change heading is fstp-stored each tick');

  // One pass clears the completed behavior; the following pass promotes
  // acceleration and immediately performs its first active tick. Its vector
  // is captured once from the retained f32 heading.
  scene.updateBulletMotion(bullet);
  scene.updateBulletMotion(bullet);
  assert.ok(bullet.exAccel, 'the queued acceleration behavior is promoted');
  let expectedVx = Math.fround(bullet.vx);
  let expectedVy = Math.fround(bullet.vy);
  const accelX = Math.fround(bullet.exAccel.vx);
  const accelY = Math.fround(bullet.exAccel.vy);
  for (let i = 1; i < 120; i++) {
    expectedVx = Math.fround(expectedVx + accelX);
    expectedVy = Math.fround(expectedVy + accelY);
    scene.updateBulletMotion(bullet);
  }
  assert.equal(bullet.vx, expectedVx, 'acceleration X adds and stores through float32');
  assert.equal(bullet.vy, expectedVy, 'acceleration Y adds and stores through float32');
});
