import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Aux-column alignment inference (see detectAuxAlignment in
// src/formats/rpy.ts): real .rpy files come in two per-recording-environment
// conventions — aux[i] describes tick i ("recorder-synchronous", offset 0)
// or tick i-1 ("recorder-lagged", offset 1) — with no header marker. The
// committed golden fixture is native-trace-proven synchronous (Fe25 first
// kill: native tick 610, kill bit at record index 610), and pinning its
// detected offset here is the tripwire that keeps a hypothetical global
// 1-frame engine-timing regression from being silently absorbed as a
// "different recording convention" by the detector.

const { loadEngine, runStage } = await import('../scripts/lib/replay-harness.mjs');

const KILL = 0x20;
const COLLECT = 0x40;

function stageWith(auxByIndex, frames = 64) {
  const auxFlags = new Uint16Array(frames);
  for (const [i, bits] of Object.entries(auxByIndex)) auxFlags[i] = bits;
  return { stage: 1, auxFlags };
}

test('detectAuxAlignment picks the offset with the longer exact prefix', async () => {
  const mod = await loadEngine();
  // Events at ticks 10, 20, 30; lagged recording stores bits at 11, 21, 31.
  const lagged = stageWith({ 11: KILL, 21: KILL, 31: COLLECT });
  const ours = [
    { bit: KILL, frames: [10, 20] },
    { bit: COLLECT, frames: [30] }
  ];
  const d1 = mod.detectAuxAlignment(lagged, ours);
  assert.equal(d1.offset, 1);
  assert.deepEqual(d1.prefixByOffset, [0, 3]);

  // Synchronous recording stores the same events at their own indices.
  const sync = stageWith({ 10: KILL, 20: KILL, 30: COLLECT });
  const d0 = mod.detectAuxAlignment(sync, ours);
  assert.equal(d0.offset, 0);
  assert.deepEqual(d0.prefixByOffset, [3, 0]);
});

test('detectAuxAlignment refuses an ambiguous vote', async () => {
  const mod = await loadEngine();
  // Our stream disagrees with both alignments from event #0.
  const stage = stageWith({ 11: KILL });
  assert.throws(
    () => mod.detectAuxAlignment(stage, [{ bit: KILL, frames: [40] }]),
    /ambiguous/
  );
  // No events at all is equally undecidable.
  assert.throws(
    () => mod.detectAuxAlignment(stageWith({}), [{ bit: KILL, frames: [] }]),
    /ambiguous/
  );
});

test('golden fixture stage 1 detects as recorder-synchronous (offset 0)', async () => {
  const mod = await loadEngine();
  const rpy = new mod.Rpy(readFileSync('tests/replays/th7_udFe25.rpy'));
  const r = await runStage(rpy, 0, { graceFrames: 0 });
  const detected = mod.detectAuxAlignment(rpy.stages[0], [
    { bit: mod.RPY_AUX_BITS.enemyKill, frames: r.killFrames },
    { bit: mod.RPY_AUX_BITS.itemCollect, frames: r.collectFrames },
    { bit: mod.RPY_AUX_BITS.playerHit, frames: r.playerHitFrames }
  ]);
  assert.equal(
    detected.offset,
    0,
    'the golden fixture is native-trace-proven synchronous; a flip to 1 means ' +
      'the engine gained a global 1-frame timing shift, not that the fixture changed'
  );
});
