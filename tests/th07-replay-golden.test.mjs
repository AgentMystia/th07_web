import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Replay-golden regression lock (Replay Golden workflow, M5).
//
// Replays the first frames of the committed fixture replay through the real
// headless StageScene and compares sparse per-frame state digests against
// tests/golden/stage1.digest.json. Any simulation-behavior change — intended
// or not — flips the stream at the exact frame it first manifests.
//
// These digests lock CURRENT behavior, not original-game truth (that is
// scripts/replay-verify.mjs's job): while the alignment campaign is running,
// an alignment fix is EXPECTED to change them — regenerate deliberately with
//   UPDATE_REPLAY_GOLDEN=1 npm test
// and commit the diff together with the fix that caused it.

const { loadEngine, runStage, digestFrame } = await import('../scripts/lib/replay-harness.mjs');

const REPLAY = 'tests/replays/th7_udFe25.rpy';
const GOLDEN = 'tests/golden/stage1.digest.json';
const FRAMES = 3000; // opener + first waves; ~60ms wall
const STRIDE = 50;

test('stage-1 replay digest matches the committed golden', async () => {
  const mod = await loadEngine();
  const rpy = new mod.Rpy(readFileSync(REPLAY));
  rpy.stages[0] = { ...rpy.stages[0], inputs: rpy.stages[0].inputs.slice(0, FRAMES) };
  const samples = [];
  await runStage(rpy, 0, {
    ghost: true, // survive misalignments; digests still cover them
    graceFrames: 0,
    onFrame: (f, scene) => {
      if (f % STRIDE === 0) samples.push(digestFrame(scene));
    }
  });

  if (process.env.UPDATE_REPLAY_GOLDEN === '1' || !existsSync(GOLDEN)) {
    writeFileSync(GOLDEN, JSON.stringify({ frames: FRAMES, stride: STRIDE, samples }, null, 1));
    console.log(`golden ${existsSync(GOLDEN) ? 'updated' : 'created'}: ${GOLDEN} (${samples.length} samples)`);
    return;
  }

  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  assert.equal(golden.stride, STRIDE, 'golden stride changed — regenerate');
  assert.equal(golden.frames, FRAMES, 'golden frame span changed — regenerate');
  for (let i = 0; i < golden.samples.length; i++) {
    assert.equal(
      samples[i],
      golden.samples[i],
      `state digest diverged at frame ${i * STRIDE} — first behavioral change is at or before ` +
        `this frame. If intentional (alignment fix), regenerate with UPDATE_REPLAY_GOLDEN=1.`
    );
  }
  assert.equal(samples.length, golden.samples.length);
});
