import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadEngine,
  makeStubAssets,
  makeStubAudio
} from '../scripts/lib/replay-harness.mjs';

// Native provenance:
//   FUN_0042db77/FUN_0042dbf3 @ 0x42db77/0x42dbf3 (accumulator)
//   FUN_0041ed50 @ 0x41eda5-0x41ee20 (periodic survival award)
//   item manager @ 0x4310ae/0x43134e/0x43153c/0x43154a/0x431830
//   graze @ 0x43bc88, bomb @ 0x43dc3b, miss @ 0x43df74.

const mod = await loadEngine();
const assets = makeStubAssets(mod);
const audio = makeStubAudio();
const rpy = new mod.Rpy(readFileSync('tests/replays/th7_udFe25.rpy'));

function sceneFor(stageIndex = 0) {
  const stage = rpy.stages[stageIndex];
  return new mod.StageScene(
    assets, audio, rpy.difficulty, rpy.character,
    stage.stage, null, stage.rngSeed
  );
}

function item(type, overrides = {}) {
  return {
    id: 9000,
    x: 300,
    y: 300,
    vx: 0,
    vy: 0,
    type,
    age: 0,
    state: 0,
    dead: false,
    ...overrides
  };
}

test('graze and the lives-based survival clock reproduce the native f1919/f1920 rank transition', () => {
  const scene = sceneFor();
  scene.rank = 16;
  scene.rankAccumulator = 96;
  scene.rankSurvivalTicks = 0;
  scene.rankSurvivalFraction = 0;
  scene.rankSurvivalAdvanced = false;
  scene.slowRate = 1;

  // Processing frames 0..1919 advance the split counter to 1920. The award
  // is checked at the head of the following enemy-manager pass.
  for (let frame = 0; frame < 1920; frame++) scene.tickRankSurvival();
  assert.deepEqual([scene.rank, scene.rankAccumulator], [16, 96]);

  scene.onGrazeAward();
  assert.deepEqual([scene.rank, scene.rankAccumulator], [17, 2], 'f1919 graze +6');

  scene.tickRankSurvival();
  assert.deepEqual([scene.rank, scene.rankAccumulator], [18, 2], 'f1920 survival +100');
});

test('bomb and miss penalties use the accumulator and difficulty floor', () => {
  const bomb = sceneFor();
  bomb.rank = 20;
  bomb.rankAccumulator = 14;
  bomb.onBombUsed();
  assert.deepEqual([bomb.rank, bomb.rankAccumulator], [18, 14], 'successful bomb -200');

  const miss = sceneFor();
  miss.rank = 20;
  miss.rankAccumulator = 14;
  miss.playerObj.power = 0;
  miss.onPlayerDeath();
  assert.deepEqual(
    [miss.rank, miss.rankAccumulator],
    [10, 14],
    'miss -1600, clamped to the Normal/Hard/Lunatic floor'
  );
});

test('item rank events distinguish native item cases and PoC boundary', () => {
  const scene = sceneFor();
  scene.rank = 16;
  scene.rankAccumulator = 0;
  scene.playerObj.power = 0;

  scene.collectItem(item('power'));
  assert.equal(scene.rankAccumulator, 1, 'normal power +1');
  scene.collectItem(item('bigPower'));
  assert.equal(scene.rankAccumulator, 1, 'bigPower has no rank award');

  const line = scene.playerObj.sht.pocLineY;
  scene.collectItem(item('point', { y: line - 0.01 }));
  assert.equal(scene.rankAccumulator, 11, 'strictly above PoC +10');
  scene.collectItem(item('point', { y: line }));
  assert.equal(scene.rankAccumulator, 14, 'on the PoC boundary +3');

  scene.playerObj.bombs = 8;
  scene.collectItem(item('bomb'));
  assert.equal(scene.rankAccumulator, 19, 'bomb item +5 even at full stock');

  scene.playerObj.lives = 8;
  scene.playerObj.bombs = 7;
  scene.collectItem(item('life'));
  assert.equal(scene.playerObj.bombs, 8, 'life item falls back to a bomb');
  assert.deepEqual([scene.rank, scene.rankAccumulator], [18, 19], 'resource award +200');

  scene.collectItem(item('life'));
  assert.deepEqual([scene.rank, scene.rankAccumulator], [18, 19], 'full life+bomb stock awards no rank');
});

test('ordinary item cull subtracts three; tween-state drops bypass the cull', () => {
  const scene = sceneFor();
  scene.rank = 16;
  scene.rankAccumulator = 0;
  scene.playerObj.x = 0;
  scene.playerObj.y = 0;
  scene.items = [item('power', { y: 465 })];
  scene.updateItems();
  assert.deepEqual([scene.rank, scene.rankAccumulator], [15, 97]);
  assert.equal(scene.items.length, 0);

  const tween = sceneFor();
  tween.rank = 16;
  tween.rankAccumulator = 0;
  tween.playerObj.x = 0;
  tween.playerObj.y = 0;
  tween.items = [item('power', {
    y: 600,
    state: 2,
    tween: { sx: 300, sy: 600, tx: 300, ty: 600, elapsed: 0, frac: 0 }
  })];
  tween.updateItems();
  assert.deepEqual([tween.rank, tween.rankAccumulator], [16, 0]);
  assert.equal(tween.items.length, 1, 'mode-2 branch does not run ordinary cull');
});
