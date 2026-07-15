import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEngine, makeStubAssets, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// Native provenance:
//   Th07.exe (v1.00b) FUN_00445790 @ 0x4457c4-0x4458d6 advances the
//   shake's split counter first, then draws two u32 values only while the
//   advanced counter is still below duration. A duration-3 shake therefore
//   consumes RNG on counter values 1 and 2, and is already dead at 3.
test('screen shake advances before its duration gate', async () => {
  const mod = await loadEngine();
  const scene = new mod.StageScene(
    makeStubAssets(mod),
    makeStubAudio(),
    3,
    'sakuyaA',
    5,
    null,
    0x1234
  );

  let draws = 0;
  const u16 = scene.rng.u16.bind(scene.rng);
  scene.rng.u16 = () => {
    draws++;
    return u16();
  };

  scene.startScreenShake(3, 8, 0);
  scene.tickScreenFx();
  assert.equal(draws, 4, 'counter 1 draws two u32 values');
  scene.tickScreenFx();
  assert.equal(draws, 8, 'counter 2 draws two u32 values');
  scene.tickScreenFx();
  assert.equal(draws, 8, 'counter 3 terminates before drawing');
  assert.equal(scene.screenShakes.length, 0);
});

test('overlapping screen shakes keep independent clocks and last writer wins', async () => {
  const mod = await loadEngine();
  const scene = new mod.StageScene(
    makeStubAssets(mod),
    makeStubAudio(),
    3,
    'reimuA',
    8,
    null,
    0x1234
  );

  let draws = 0;
  scene.rng.u32InRange = () => {
    draws += 2;
    return 1;
  };

  scene.startScreenShake(3, 9, 0);
  scene.startScreenShake(2, 20, 10);
  scene.tickScreenFx();
  assert.equal(draws, 8, 'two live instances each draw two u32 values');
  assert.equal(scene.screenShakes.length, 2);
  assert.equal(scene.shakeX, 15, 'later scheduler instance overwrites shared X');
  assert.equal(scene.shakeY, 15, 'later scheduler instance overwrites shared Y');

  scene.tickScreenFx();
  assert.equal(draws, 12, 'expired later instance draws nothing; earlier one survives');
  assert.equal(scene.screenShakes.length, 1);
  assert.equal(scene.shakeX, 3);
  assert.equal(scene.shakeY, 3);

  scene.tickScreenFx();
  assert.equal(draws, 12);
  assert.equal(scene.screenShakes.length, 0);
});
