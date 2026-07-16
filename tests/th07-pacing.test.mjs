// Frame-loop pacing policy (src/core/pacing.ts): fixed 60Hz timestep with
// bounded catch-up and a vsync snap. The snap exists because real displays
// and browsers do not deliver exact 16.667ms rAF deltas: 59.94Hz panels
// tick at 16.683ms, and Firefox/Safari quantize rAF timestamps to ~1ms
// (deltas read 16 or 17). An exact accumulator drifts against those until
// a tick releases 0 steps (present skipped = visible stutter + a 16.7ms
// input-latency spike) or 2 steps (doubled motion). These tests document
// both the snap behavior and the beat it removes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/pacing';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/core/pacing.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { pace, STEP_MS, CATCHUP_STEPS, SNAP_TOLERANCE_MS } = await import('../tests/.build/pacing/pacing.mjs');

// Run a delta sequence through the pacer, collecting per-tick step counts.
function run(deltas, snap = true) {
  let acc = 0;
  const steps = [];
  for (const delta of deltas) {
    const result = pace(acc, delta, snap);
    acc = result.acc;
    steps.push(result.steps);
  }
  return steps;
}

const repeat = (value, n) => new Array(n).fill(value);

test('exact 60.00Hz delivery: one step per tick, snap or not', () => {
  for (const snap of [true, false]) {
    const steps = run(repeat(1000 / 60, 10000), snap);
    assert.ok(steps.every((s) => s === 1), `snap=${snap}`);
  }
});

test('59.94Hz panel (16.683ms): snap holds 1 step/tick; raw accumulator double-steps on the beat', () => {
  const deltas = repeat(1000 / 59.94, 10000);
  const snapped = run(deltas, true);
  assert.ok(snapped.every((s) => s === 1), 'snap must absorb the 0.016ms drift');
  const raw = run(deltas, false);
  assert.ok(raw.some((s) => s === 2), 'exact accumulator must exhibit the 2-step beat this band exists to fix');
});

test('60.06Hz-style fast panel (16.65ms): snap holds 1 step/tick; raw accumulator skips draws on the beat', () => {
  const deltas = repeat(16.65, 10000);
  const snapped = run(deltas, true);
  assert.ok(snapped.every((s) => s === 1));
  const raw = run(deltas, false);
  assert.ok(raw.some((s) => s === 0), 'exact accumulator must exhibit the 0-step (skipped present) beat');
});

test('Firefox/Safari ~1ms rAF quantization (17,17,16 pattern): snap holds 1 step/tick', () => {
  const pattern = [];
  for (let i = 0; i < 9999; i += 3) pattern.push(17, 17, 16);
  const snapped = run(pattern, true);
  assert.ok(snapped.every((s) => s === 1));
  const raw = run(pattern, false);
  assert.ok(raw.some((s) => s !== 1), 'quantized timestamps beat without the snap');
});

test('144Hz (6.944ms): snap never engages — step sequence identical to the exact accumulator', () => {
  const deltas = repeat(1000 / 144, 10000);
  assert.deepEqual(run(deltas, true), run(deltas, false));
  const steps = run(deltas, true);
  const total = steps.reduce((a, b) => a + b, 0);
  // 10000 ticks at 144Hz span 69.44s -> 4166 sim steps (60/s).
  assert.ok(Math.abs(total - 10000 * 60 / 144) <= 1, `total ${total}`);
});

test('120Hz and 75Hz: out of band, identical to the exact accumulator', () => {
  for (const hz of [120, 75]) {
    const deltas = repeat(1000 / hz, 10000);
    assert.deepEqual(run(deltas, true), run(deltas, false), `${hz}Hz`);
  }
});

test('30Hz delivery (33.37ms): snaps to the k=2 band, exactly 2 steps per tick', () => {
  const steps = run(repeat(1000 / 29.97, 10000), true);
  assert.ok(steps.every((s) => s === 2));
});

test('long stall: delta clamped, 3 catch-up steps, at most one banked step of debt', () => {
  const result = pace(0, 5000, true);
  assert.equal(result.steps, CATCHUP_STEPS);
  assert.ok(result.acc <= STEP_MS);
});

test('band edges: k*STEP_MS±tolerance snaps, just outside does not', () => {
  const inside = pace(0, STEP_MS + SNAP_TOLERANCE_MS, true);
  assert.equal(inside.steps, 1);
  assert.equal(inside.acc, 0);
  const outside = pace(0, STEP_MS + SNAP_TOLERANCE_MS + 0.01, true);
  assert.equal(outside.steps, 1);
  assert.ok(outside.acc > 0, 'outside the band the exact accumulator keeps the remainder');
});

test('pure function: same inputs, same outputs', () => {
  const a = pace(3.2, 16.7, true);
  const b = pace(3.2, 16.7, true);
  assert.deepEqual(a, b);
});
