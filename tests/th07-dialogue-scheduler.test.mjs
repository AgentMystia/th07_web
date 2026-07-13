import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  applySnapshot,
  loadEngine,
  makeStubAssets,
  makeStubAudio
} from '../scripts/lib/replay-harness.mjs';

// Native provenance:
//   FUN_00426656 services FUN_00428392 from a manager registered at priority
//   13 (FUN_0042e290(..., 0xd), all.c:18954). Stage timeline/enemies are
//   priority 10, effects 11, and items+enemy bullets/lasers 12. Therefore a
//   dialogue created by timeline op8 gets its first MSG tick at the END of
//   that same scheduler pass.
//
//   FUN_0041de20 @ all.c:13533-13720 also has no global dialogue gate on its
//   tail clock increment.  Only timeline op9 holds, by cancelling that one
//   increment while the message is active.  In particular op8 at time 1914
//   advances the timeline clock to 1915 in the same pass.
//
//   FUN_00428392 @ all.c:17763-18002 dispatches only while
//   currentInstruction.time <= messageClock, then increments that clock at
//   its priority-13 tail. Stage 6 entry 22 has timestamp groups at
//   0/40/120/210/300 and ends at 330; it has no op-4 wait and is nonblocking
//   gameplay presentation, but timeline op9 still polls it as active.
//
//   A focused native trace of FUN_0043eef0/FUN_0043a290/FUN_0043a820 shows
//   DAT_0061c25c remains zero throughout this timestamp-only message. The
//   player-shot MOVE and FIRE passes therefore keep running. FUN_0043be00
//   separately gates FUN_0043a930 on FUN_00429483()==0: an already-armed
//   cycle drains to frame 29, but holding Z cannot re-arm it until MSG ends.
test('Stage 6 entry 22 follows native MSG timestamps while timeline op9 holds', async () => {
  const mod = await loadEngine();
  const rpy = new mod.Rpy(readFileSync('tests/replays/th7_udFe25.rpy'));
  const stageIndex = 5;
  const stage = rpy.stages[stageIndex];
  const scene = new mod.StageScene(
    makeStubAssets(mod),
    makeStubAudio(),
    rpy.difficulty,
    rpy.character,
    stage.stage,
    null,
    stage.rngSeed
  );
  applySnapshot(scene, rpy, stageIndex, { restoreRng: false });
  const source = new mod.ReplayInputSource();
  const cadence = [];
  const collectFrames = new Set();
  const checkpoints = new Map();
  const spawn = scene.spawnEffectParticles.bind(scene);
  scene.spawnEffectParticles = (id, x, y, count, color, seed, ownerEnemyId) => {
    if (id === 31 && count === 2 && scene.frame >= 1900 && scene.frame <= 1921) {
      cadence.push(scene.frame);
    }
    return spawn(id, x, y, count, color, seed, ownerEnemyId);
  };
  const collect = scene.collectItem.bind(scene);
  scene.collectItem = (item) => {
    collectFrames.add(scene.frame);
    return collect(item);
  };

  const wanted = new Set([1914, 1915, 1916, 1920, 1954, 1955, 1965, 2034,
    2035, 2124, 2125, 2214, 2215, 2238, 2244, 2245, 2246, 2247]);
  for (let inputFrame = 0; inputFrame < 2247; inputFrame++) {
    scene.update(source.frame(stage.inputs[inputFrame] ?? 0));
    if (wanted.has(scene.frame)) {
      const cursor = scene.runtime.timelineCursors[0];
      const next = scene.runtime.ecl.timelines[0][cursor.index];
      const enemy = scene.enemies.find((candidate) => candidate.poolSlot === 1);
      checkpoints.set(scene.frame, {
        timeline: [cursor.frame, cursor.index, next?.time, next?.op],
        dialogue: scene.dialogue && [scene.dialogue.idx, scene.dialogue.time,
          scene.dialogue.waitTimer, scene.dialogue.blocking],
        line0: scene.dialogue?.lines[0] ?? null,
        enemyHp: enemy?.hp,
        playerFireFrame: scene.playerObj.fireFrame,
        activePlayerShots: scene.playerBulletSlots.filter(Boolean).length
      });
    }
  }

  assert.deepEqual(checkpoints.get(1914)?.timeline, [1914, 47, 1914, 8]);
  assert.deepEqual(checkpoints.get(1915)?.timeline, [1915, 49, 1915, 9]);
  assert.deepEqual(checkpoints.get(1915)?.dialogue, [7, 1, 0, false]);
  assert.deepEqual(checkpoints.get(1916)?.timeline, [1915, 49, 1915, 9]);

  assert.deepEqual(checkpoints.get(1954)?.dialogue, [7, 40, 0, false]);
  assert.equal(checkpoints.get(1954)?.line0, null);
  assert.deepEqual(checkpoints.get(1955)?.dialogue, [10, 41, 0, false]);
  assert.notEqual(checkpoints.get(1955)?.line0, null);
  assert.deepEqual(checkpoints.get(2034)?.dialogue?.slice(0, 2), [10, 120]);
  assert.deepEqual(checkpoints.get(2035)?.dialogue?.slice(0, 2), [11, 121]);
  assert.deepEqual(checkpoints.get(2124)?.dialogue?.slice(0, 2), [11, 210]);
  assert.deepEqual(checkpoints.get(2125)?.dialogue?.slice(0, 2), [14, 211]);
  assert.deepEqual(checkpoints.get(2214)?.dialogue?.slice(0, 2), [14, 300]);
  assert.deepEqual(checkpoints.get(2215)?.dialogue?.slice(0, 2), [16, 301]);
  assert.deepEqual(checkpoints.get(2244)?.dialogue?.slice(0, 2), [16, 330]);
  assert.equal(checkpoints.get(2245)?.dialogue, null);

  assert.equal(checkpoints.get(1965)?.enemyHp, 1,
    'timeline op10 must not phase-transition Sub18 before entry 22 ends');
  assert.deepEqual(
    [checkpoints.get(1915)?.playerFireFrame, checkpoints.get(1915)?.activePlayerShots],
    [15, 53],
    'the armed cycle and existing slots keep ticking after MSG activation'
  );
  assert.deepEqual(
    [checkpoints.get(1920)?.playerFireFrame, checkpoints.get(1920)?.activePlayerShots],
    [20, 57]
  );
  assert.deepEqual(
    [checkpoints.get(2238)?.playerFireFrame, checkpoints.get(2238)?.activePlayerShots],
    [-1, 0],
    'MSG-active FUN_00429483 blocks re-arm after the cycle and slots drain'
  );
  assert.deepEqual(
    [checkpoints.get(2245)?.playerFireFrame, checkpoints.get(2245)?.activePlayerShots],
    [-1, 0]
  );
  assert.deepEqual(
    [checkpoints.get(2246)?.playerFireFrame, checkpoints.get(2246)?.activePlayerShots],
    [1, 7],
    'holding Z re-arms on the first player tick after MSG ends'
  );
  assert.deepEqual(checkpoints.get(2245)?.timeline, [1915, 49, 1915, 9]);
  assert.deepEqual(checkpoints.get(2246)?.timeline, [1916, 50, 1916, 10]);
  assert.deepEqual(checkpoints.get(2247)?.timeline, [1917, 51, 1917, 12]);
  assert.deepEqual(cadence, [1901, 1905, 1909, 1913, 1917, 1921]);
  assert.ok(collectFrames.has(1915),
    'priority-12 items consume startDialogue forced-collect state on the native AUX-0x40 frame');
});

test('MSG op4 retains native first-tick, Z-age, and CTRL timestamp semantics', async () => {
  const mod = await loadEngine();
  const rpy = new mod.Rpy(readFileSync('tests/replays/th7_udFe25.rpy'));
  const stage = rpy.stages[5];
  const makeScene = () => new mod.StageScene(
    makeStubAssets(mod), makeStubAudio(), rpy.difficulty, rpy.character,
    stage.stage, null, stage.rngSeed
  );

  const zScene = makeScene();
  zScene.startDialogue(0); // Sakuya family offset -> op-4 story entry 20.
  const z = zScene.dialogue;
  assert.ok(z);
  for (let i = 0; i < 60; i++) z.update(false, false);
  assert.deepEqual([z.idx, z.time, z.waitTimer, z.blocking], [3, 60, 0, false]);
  z.update(false, false);
  assert.deepEqual([z.idx, z.time, z.waitAge, z.waitTimer], [4, 60, 1, 299]);
  for (let i = 0; i < 11; i++) z.update(false, false);
  assert.equal(z.waitAge, 12);
  z.update(true, false);
  assert.deepEqual([z.idx, z.time, z.waitTimer], [5, 61, 0]);

  const ctrlScene = makeScene();
  ctrlScene.startDialogue(0);
  const ctrl = ctrlScene.dialogue;
  assert.ok(ctrl);
  ctrl.update(false, false);
  assert.deepEqual([ctrl.idx, ctrl.time], [3, 1]);
  ctrl.update(false, true);
  assert.deepEqual([ctrl.idx, ctrl.time, ctrl.waitTimer], [5, 61, 0]);
});

test('op-4 story dialogue leaves gameplay managers live while MSG input gates remain active', async () => {
  const mod = await loadEngine();
  const rpy = new mod.Rpy(readFileSync('tests/replays/th7_udFe25.rpy'));
  const stage = rpy.stages[0];
  const scene = new mod.StageScene(
    makeStubAssets(mod), makeStubAudio(), rpy.difficulty, rpy.character,
    stage.stage, null, stage.rngSeed
  );
  applySnapshot(scene, rpy, 0, { restoreRng: false });
  const source = new mod.ReplayInputSource();
  for (let f = 0; f <= 5770; f++) scene.update(source.frame(stage.inputs[f] ?? 0));

  assert.equal(scene.isDialogueBlocking(), false,
    'native DAT_0061c25c stays zero during the Stage-1 story message');
  const controller = scene.enemies.find((enemy) => enemy.poolSlot === 0);
  assert.ok(controller && !controller.ecl.interactable, 'Stage-1 snow controller remains resident');
  const playerAtFreeze = [scene.playerObj.x, scene.playerObj.y];
  const controllerFrame = controller.frame;
  const itemAges = scene.items.map((item) => item.age);
  let snow = 0;
  const spawn = scene.spawnEffectParticles.bind(scene);
  scene.spawnEffectParticles = (id, x, y, count, color, seed, ownerEnemyId) => {
    if (id === 20) snow += count;
    return spawn(id, x, y, count, color, seed, ownerEnemyId);
  };

  // Three ticks cover one Sub1 id20 cadence. Player and priority-12 are live
  // because MSG op4 itself does not set DAT_0061c25c.
  for (let i = 0; i < 3; i++) scene.update(source.frame(0x20));

  assert.notDeepEqual([scene.playerObj.x, scene.playerObj.y], playerAtFreeze);
  assert.equal(controller.frame, controllerFrame + 3);
  assert.equal(snow, 1, 'priority-10 ECL controller continues its three-frame snow cadence');
  assert.deepEqual(scene.items.map((item) => item.age), itemAges.map((age) => age + 3),
    'priority-12 item manager continues alongside the message');
});
