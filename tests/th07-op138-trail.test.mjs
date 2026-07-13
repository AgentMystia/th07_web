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
