import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  applySnapshot,
  loadEngine,
  makeStubAssets,
  makeStubAudio
} from '../scripts/lib/replay-harness.mjs';

test('op138 trail tail keeps the Stage 6 sub4 enemy alive at native frame 896', async () => {
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

  for (let inputFrame = 0; inputFrame < 896; inputFrame++) {
    scene.update(source.frame(stage.inputs[inputFrame] ?? 0));
  }

  const enemy = scene.enemies.find((e) => e.poolSlot === 2 && e.ecl.subId === 4);
  assert.ok(enemy, 'native slot 2 remains occupied while the 48-frame trail tail is on-screen');
  assert.equal(enemy.ecl.trailFlags, 25);
  assert.equal(enemy.ecl.trailCount, 48);
  assert.equal(enemy.ecl.trailStart, 16);
  assert.equal(enemy.ecl.trailStride, 1);
  assert.ok(Math.abs(enemy.x - 281.408) < 0.001);
  assert.ok(Math.abs(enemy.y - -8.099) < 0.001);

  const oldest = enemy.ecl.trailHistory[47];
  assert.ok(Math.abs(oldest.x - 285.39734) < 0.001);
  assert.ok(Math.abs(oldest.y - 81.071236) < 0.001);
});

test('fresh op138 history uses the native -999 X sentinel and releases the Stage 5 tail slot', async () => {
  const mod = await loadEngine();
  const rpy = new mod.Rpy(readFileSync('tests/replays/th7_udFe25.rpy'));
  const stageIndex = 4;
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

  const fresh = scene.runtime.makeEnemyState(0, false, -1, null);
  assert.ok(fresh.trailHistory.every((point) => point.x === -999 && point.y === 0 && point.z === 0));

  for (let inputFrame = 0; inputFrame < 8169; inputFrame++) {
    scene.update(source.frame(stage.inputs[inputFrame] ?? 0));
  }
  assert.equal(scene.enemySlots[2], null,
    'the off-screen 48-sample tail frees native fixed slot 2 by PRE8169');

  for (let inputFrame = 8169; inputFrame < 8185; inputFrame++) {
    scene.update(source.frame(stage.inputs[inputFrame] ?? 0));
  }
  assert.equal(scene.enemySlots[2]?.ecl.subId, 28,
    'the next Stage-5 actor reuses the native slot instead of being displaced to slot 7');
});
