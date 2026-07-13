import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssets, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync('tests/replays/th7_udFe25.rpy'));

test('browser replay restore uses native seed/bootstrap and the recorded stage snapshot', () => {
  const stageIndex = 1;
  const recorded = rpy.stages[stageIndex];
  const entry = mod.replayStageEntry(rpy, stageIndex);
  const scene = new mod.StageScene(
    makeStubAssets(mod),
    makeStubAudio(),
    rpy.difficulty,
    rpy.character,
    entry.runtimeStageNumber,
    null,
    recorded.rngSeed
  );
  const postBootstrapSeed = scene.rng.seed;
  assert.notEqual(postBootstrapSeed, recorded.rngSeed, 'manager bootstrap consumes from the restored seed');

  mod.applyReplayStageSnapshot(scene, rpy, stageIndex);
  assert.equal(scene.rng.seed, postBootstrapSeed, 'snapshot application must not erase bootstrap draws');
  assert.equal(scene.score, rpy.stages[0].scoreAtEnd);
  assert.equal(scene.graze, recorded.graze);
  assert.equal(scene.pointItems, recorded.pointItems);
  assert.deepEqual(
    [scene.playerObj.power, scene.playerObj.lives, scene.playerObj.bombs],
    [recorded.power, recorded.lives, recorded.bombs]
  );
  assert.deepEqual(
    [scene.cherry.cherry, scene.cherry.cherryMax, scene.cherry.cherryPlus],
    [recorded.cherry, recorded.cherryMax, recorded.cherryPlus]
  );
  assert.equal(scene.extendThreshold, recorded.extendThreshold);
  assert.equal(scene.rank, recorded.rankByte);
});

test('replay stage routing distinguishes Phantasm from Extra in physical slot 7', () => {
  const fake = { difficulty: 5, stages: [{ stage: 7 }] };
  assert.equal(mod.replayStageEntry(fake, 0).runtimeStageNumber, 8);
  fake.difficulty = 4;
  assert.equal(mod.replayStageEntry(fake, 0).runtimeStageNumber, 7);
});

test('slowdown trailer exposes the native pointer+1 playback samples', () => {
  const stage1 = rpy.stages[0];
  assert.equal(stage1.slowdown.length, Math.ceil(stage1.inputs.length / 30));
  assert.deepEqual(Array.from(stage1.slowdown.slice(0, 3)), [46, 60, 60]);
});

test('slowdown playback uses the executable cadence buckets at every boundary', () => {
  const advances = (fps, count) => Array.from(
    { length: count },
    (_, i) => mod.replaySlowdownAdvances(fps, i + 1)
  );
  assert.deepEqual(advances(19, 6), [false, false, true, false, false, true]);
  assert.deepEqual(advances(20, 6), [false, true, false, true, false, true]);
  assert.deepEqual(advances(30, 6), [true, true, false, true, true, false]);
  assert.deepEqual(advances(40, 6), [true, true, true, true, true, false]);
  assert.deepEqual(advances(50, 3), [true, true, true]);
});

test('dialogue and boss-only playback repeat to their native modulo boundaries', () => {
  assert.deepEqual(
    [1, 2, 3].map((frame) => mod.replayFastForwardContinues(0, frame, true, false)),
    [true, false, true],
    'normal replay repeats skippable dialogue until frame mod 3 == 2'
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((frame) => mod.replayFastForwardContinues(2, frame, false, false)),
    [true, true, true, false, true],
    'boss-only replay repeats non-boss play until frame mod 5 == 4'
  );
  assert.equal(mod.replayFastForwardContinues(2, 14, true, false), false,
    'combined predicates meet at frame mod 15 == 14');
  assert.equal(mod.replayFastForwardContinues(2, 5, false, true), false,
    'an active boss disables boss-only acceleration');
});
