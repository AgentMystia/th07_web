import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';

const outDir = 'tests/.build/capture-anm';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/formats/anm.ts src/data/th07-data.ts src/game/stage-scene.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { Anm, AnmRunner } = await import('../tests/.build/capture-anm/formats/anm.mjs');
const { TH07_DATA } = await import('../tests/.build/capture-anm/data/th07-data.mjs');
const { StageScene } = await import('../tests/.build/capture-anm/game/stage-scene.mjs');

const near = (actual, expected, epsilon = 1e-5) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

test('capture and character loading ANMs retain the original stage-clear assets', () => {
  const capture = new Anm(TH07_DATA.anm.capture, 'capture');
  assert.equal(capture.entries[0].name, '@');
  assert.equal(capture.entries[0].width, 512);
  assert.equal(capture.entries[0].height, 512);
  assert.deepEqual(capture.entries[0].scriptIds, [0, 1, 2, 3]);
  assert.deepEqual(
    capture.entries[0].spriteIds.map((id) => {
      const s = capture.sprites.get(id);
      return [s.x, s.y, s.w, s.h];
    }),
    [[0, 0, 128, 128], [128, 0, 384, 448], [128, 0, 32, 32]]
  );

  for (const key of ['loading', 'loading2', 'loading3']) {
    const loading = new Anm(TH07_DATA.anm[key], key);
    assert.equal(loading.entries[0].name, `data/image/${key}.png`);
    assert.deepEqual(loading.entries[0].scriptIds, [0]);
    const frame = new AnmRunner(loading, 0).spriteFrame();
    assert.ok(frame);
    assert.equal(frame.imageKey, key);
    assert.equal(frame.anchorTopLeft, true);
    assert.deepEqual([frame.vmX, frame.vmY, frame.w, frame.h], [32, 16, 384, 448]);
    const png = `assets/th07-img/${key}.png`;
    assert.equal(existsSync(png), true);
    assert.ok(statSync(png).size > 100000, `${png} must contain the extracted original art`);
  }
});

test('stage clear selects loading art by character family and creates no extra capture runners', () => {
  const anms = {
    capture: new Anm(TH07_DATA.anm.capture, 'capture'),
    loading: new Anm(TH07_DATA.anm.loading, 'loading'),
    loading2: new Anm(TH07_DATA.anm.loading2, 'loading2'),
    loading3: new Anm(TH07_DATA.anm.loading3, 'loading3')
  };
  for (const [character, expected] of [
    ['reimuA', 'loading'], ['marisaB', 'loading2'], ['sakuyaA', 'loading3']
  ]) {
    const scene = Object.create(StageScene.prototype);
    scene.stageNumber = 1;
    scene.playerObj = { character };
    scene.assets = { anms };
    scene.startStageClearPresentation();
    assert.equal(scene.clearLoadingKey, expected);
    assert.equal(scene.clearLoadingRunner.scriptId, 0);
    assert.equal(scene.clearCaptureRunner.scriptId, 1);
    assert.equal(scene.clearCaptureArmed, true);
  }

  const final = Object.create(StageScene.prototype);
  final.stageNumber = 6;
  final.playerObj = { character: 'reimuA' };
  final.assets = { anms };
  final.startStageClearPresentation();
  assert.equal(final.clearLoadingRunner, undefined);
  assert.equal(final.clearCaptureRunner, undefined);
});

test('capture script 1 rotates and shrinks the 1:1 playfield copy to its resting inset', () => {
  const capture = new Anm(TH07_DATA.anm.capture, 'capture');
  const runner = new AnmRunner(capture, 1, { imageKey: 'capture:@' });
  const initial = runner.spriteFrame();
  assert.ok(initial);
  assert.equal(initial.imageKey, 'capture:@');
  assert.equal(initial.anchorTopLeft, true);
  assert.deepEqual([initial.x, initial.y, initial.w, initial.h], [128, 0, 384, 448]);
  assert.deepEqual([initial.vmX, initial.vmY, initial.scaleX, initial.scaleY], [32, 16, 1, 1]);
  assert.equal(initial.alpha, 255);

  for (let i = 0; i < 61; i++) runner.update();
  const resting = runner.spriteFrame();
  assert.ok(resting);
  near(resting.vmX, 48);
  near(resting.vmY, 128);
  near(resting.scaleX, 0.4);
  near(resting.scaleY, 0.4);
  near(resting.rotation, 0);
  assert.equal(resting.alpha, 160);
  assert.equal(resting.color & 0xffffff, 0x80c0e0);
  assert.equal(runner.waiting, true);

  assert.equal(runner.interrupt(1), true);
  assert.equal(runner.removed, false);
  runner.update();
  assert.equal(runner.removed, true);
});

test('mid-run stage entry builds the exe 12x14 staggered capture-tile wipe', () => {
  const capture = new Anm(TH07_DATA.anm.capture, 'capture');
  const scene = Object.create(StageScene.prototype);
  scene.assets = { anms: { capture } };
  scene.stageTransitionTiles = [];
  scene.startStageTransition();

  assert.equal(scene.stageTransitionTiles.length, 168);
  assert.equal(scene.stageTransitionCaptureArmed, true);
  assert.equal(scene.stageTransitionTimer, 0);
  const first = scene.stageTransitionTiles[0];
  const second = scene.stageTransitionTiles[1];
  const nextRow = scene.stageTransitionTiles[12];
  const last = scene.stageTransitionTiles.at(-1);
  assert.deepEqual(
    [first.runner.scriptId, first.delay, first.x, first.y, first.sourceX, first.sourceY],
    [2, 0, 15.5, 15.5, 0, 0]
  );
  assert.deepEqual(
    [second.runner.scriptId, second.delay, second.x, second.sourceX],
    [3, 2, 47.5, 32]
  );
  assert.deepEqual(
    [nextRow.runner.scriptId, nextRow.delay, nextRow.y, nextRow.sourceY],
    [3, 1, 47.5, 32]
  );
  assert.deepEqual(
    [last.runner.scriptId, last.delay, last.x, last.y, last.sourceX, last.sourceY],
    [2, 35, 367.5, 431.5, 352, 416]
  );

  for (let i = 0; i < 20; i++) {
    first.runner.update();
    last.runner.update();
  }
  assert.ok(first.runner.spriteFrame().rotationX > 0, 'delay-0 cell must be tumbling');
  assert.equal(last.runner.spriteFrame().rotationX, 0, 'delay-35 cell must still be waiting');
  for (let i = 20; i < 62; i++) {
    first.runner.update();
    last.runner.update();
  }
  assert.equal(first.runner.removed, true);
  assert.equal(last.runner.removed, true);
});
