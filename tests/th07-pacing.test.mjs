// Frame-loop pacing policy (src/core/pacing.ts): fixed 60Hz timestep with
// bounded catch-up, a vsync snap, and a drift ledger. The snap exists
// because real displays and browsers do not deliver exact 16.667ms rAF
// deltas: 59.94Hz panels tick at 16.683ms, and Firefox/Safari quantize rAF
// timestamps to ~1ms (deltas read 16 or 17). An exact accumulator drifts
// against those until a tick releases 0 steps (present skipped = visible
// stutter + a 16.7ms input-latency spike) or 2 steps (doubled motion).
// The drift ledger banks what the snap pretends away and repays it in
// whole steps, so long-run sim rate stays exactly 60 steps per wall-clock
// second even on sustained in-band off-rates (~58Hz panel modes,
// battery-saver rAF throttling) — the old accumulator's hard guarantee.
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
  let drift = 0;
  const steps = [];
  for (const delta of deltas) {
    const result = pace(acc, delta, snap, drift);
    acc = result.acc;
    drift = result.drift;
    steps.push(result.steps);
  }
  return steps;
}

const repeat = (value, n) => new Array(n).fill(value);
const total = (steps) => steps.reduce((a, b) => a + b, 0);
const count = (steps, v) => steps.filter((s) => s === v).length;

// Long-run wall-clock convergence: total steps must equal elapsed/STEP_MS
// within one step, for ANY sustained delta the pacer accepts. Round the
// expected value so floating-point in elapsed/STEP_MS can't push a 1-step
// convergence a hair over the bound.
function assertConverges(deltas, snap, label) {
  const steps = run(deltas, snap);
  const elapsed = deltas.reduce((a, b) => a + b, 0);
  const expected = Math.round(elapsed / STEP_MS);
  assert.ok(
    Math.abs(total(steps) - expected) <= 1,
    `${label}: total ${total(steps)} vs expected ${expected}`
  );
  return steps;
}

test('exact 60.00Hz delivery: one step per tick, no corrections, snap or not', () => {
  for (const snap of [true, false]) {
    const steps = run(repeat(1000 / 60, 10000), snap);
    assert.ok(steps.every((s) => s === 1), `snap=${snap}`);
  }
});

test('59.94Hz panel (16.683ms): rare whole-step corrections instead of the raw 2-step beat, exact long-run rate', () => {
  const deltas = repeat(1000 / 59.94, 10000);
  const snapped = assertConverges(deltas, true, '59.94Hz snap');
  // Drift accrues ~0.017ms/tick -> one 2-step repayment per ~1000 ticks
  // (measured 10/10000). The raw accumulator exhibits the SAME beat, but
  // scattered as jittery single-frame double-steps the snap consolidates.
  assert.ok(count(snapped, 2) <= 12, `corrections ${count(snapped, 2)}`);
  assert.equal(count(snapped, 0), 0, 'no skipped presents at 59.94Hz');
  const raw = assertConverges(deltas, false, '59.94Hz raw');
  assert.ok(count(raw, 2) > 5, 'exact accumulator must exhibit the 2-step beat this band smooths');
});

test('60.06Hz-style fast panel (16.65ms): rare 0-step corrections instead of the raw skip beat, exact long-run rate', () => {
  const deltas = repeat(16.65, 10000);
  const snapped = assertConverges(deltas, true, '60.06Hz snap');
  assert.ok(count(snapped, 0) <= 12, `corrections ${count(snapped, 0)}`);
  assert.equal(count(snapped, 2), 0);
  const raw = run(deltas, false);
  assert.ok(count(raw, 0) > 5, 'exact accumulator must exhibit the 0-step (skipped present) beat');
});

test('Firefox/Safari ~1ms rAF quantization (17,17,16 pattern): zero net drift, one step per tick forever', () => {
  const pattern = [];
  for (let i = 0; i < 9999; i += 3) pattern.push(17, 17, 16);
  const snapped = run(pattern, true);
  assert.ok(snapped.every((s) => s === 1), 'quantization cancels in the ledger — no corrections at all');
  const raw = run(pattern, false);
  assert.ok(raw.some((s) => s !== 1), 'quantized timestamps beat without the snap');
});

test('sustained in-band off-rate (17.2ms ~ 58Hz throttling): game speed stays exactly 60 steps/s via periodic repayments', () => {
  const deltas = repeat(17.2, 10000);
  const steps = assertConverges(deltas, true, '58Hz-class');
  // Without the drift ledger every tick would release exactly 1 step
  // (10000 total, ~3.2% slow); the ledger must add ~320 repayment steps.
  assert.ok(count(steps, 2) > 250, `repayments ${count(steps, 2)}`);
});

test('144Hz (6.944ms): snap never engages — step sequence identical to the exact accumulator', () => {
  const deltas = repeat(1000 / 144, 10000);
  assert.deepEqual(run(deltas, true), run(deltas, false));
  assertConverges(deltas, true, '144Hz');
});

test('120Hz and 75Hz: out of band, identical to the exact accumulator', () => {
  for (const hz of [120, 75]) {
    const deltas = repeat(1000 / hz, 10000);
    assert.deepEqual(run(deltas, true), run(deltas, false), `${hz}Hz`);
  }
});

test('30Hz delivery (33.37ms): snaps to the k=2 band, 2 steps per tick, exact long-run rate', () => {
  const steps = assertConverges(repeat(1000 / 29.97, 10000), true, '30Hz');
  assert.ok(steps.every((s) => s === 2 || s === 3));
  // Drift repayments on the k=2 band surface as occasional 3-step ticks
  // (measured ~19/10000); the rare-3 bound documents that without flaking.
  assert.ok(count(steps, 3) <= 30, `repayments ${count(steps, 3)}`);
});

test('long stall: delta clamped, 3 catch-up steps, at most one banked step of debt', () => {
  const result = pace(0, 5000, true, 0);
  assert.equal(result.steps, CATCHUP_STEPS);
  assert.ok(result.acc <= STEP_MS);
  assert.equal(result.drift, 0, 'out-of-band ticks never touch the ledger');
});

test('band edges: k*STEP_MS±tolerance snaps and banks the difference; just outside does not', () => {
  const inside = pace(0, STEP_MS + SNAP_TOLERANCE_MS, true, 0);
  assert.equal(inside.steps, 1);
  assert.equal(inside.acc, 0);
  assert.ok(Math.abs(inside.drift - SNAP_TOLERANCE_MS) < 1e-9, 'snapped-away time lands in the ledger');
  const outside = pace(0, STEP_MS + SNAP_TOLERANCE_MS + 0.01, true, 0);
  assert.equal(outside.steps, 1);
  assert.ok(outside.acc > 0, 'outside the band the exact accumulator keeps the remainder');
  assert.equal(outside.drift, 0);
});

test('drift repayment is clamped to one whole step per tick', () => {
  // Even entering with an absurd banked drift, a single tick repays at
  // most one step (and the step loop is capped at CATCHUP_STEPS).
  const result = pace(0, STEP_MS, true, STEP_MS * 0.99);
  assert.equal(result.steps, 1);
  const repaid = pace(0, STEP_MS, true, STEP_MS * 1.5);
  assert.equal(repaid.steps, 2);
  assert.ok(Math.abs(repaid.drift - STEP_MS * 0.5) < 1e-9);
});

test('pure function: same inputs, same outputs', () => {
  const a = pace(3.2, 16.7, true, 0.4);
  const b = pace(3.2, 16.7, true, 0.4);
  assert.deepEqual(a, b);
});
