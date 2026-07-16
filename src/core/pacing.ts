export const STEP_MS = 1000 / 60;
export const MAX_FRAME_DELTA_MS = 250;
// Bounded catch-up: when rAF ticks arrive slower than 60 Hz (throttling,
// 48/50 Hz displays, jitter), up to this many sim steps run per tick so
// game speed stays 60 steps/second.
export const CATCHUP_STEPS = 3;
// Vsync snap band (see pace()). ±1.0ms around k*STEP_MS: wide enough for
// 59.94/60.06 Hz panels and the ~1ms rAF timestamp quantization of
// Firefox/Safari (16ms and 17ms deltas both land in the k=1 band), narrow
// enough that 144/120/90/75/72/50/48 Hz deltas never snap. Worst-case
// sustained speed error at the band edge is 1.0/16.67 ≈ 6%, and only on a
// display actually running at that rate — inside the band the game tracks
// the display clock exactly like the vsync-locked original.
export const SNAP_TOLERANCE_MS = 1.0;

export interface PaceResult {
  steps: number;
  acc: number;
  // Wall-clock time (ms) the snap has pretended away so far; carried
  // across ticks and repaid in whole steps (see below).
  drift: number;
}

// Pure fixed-timestep pacer: given the accumulator, a raw rAF delta and the
// carried snap drift, decide how many 60Hz sim steps to run and the new
// accumulator/drift values.
//
// The snap kills the accumulator beat against near-vsync-multiple deltas:
// an unsnapped 16.683ms (59.94 Hz) or quantized 16/17ms delta drifts the
// accumulator until a tick releases 0 steps (present skipped — a visible
// stutter and a 16.7ms input-latency spike) or 2 steps (doubled motion).
// Snapping deltas within SNAP_TOLERANCE_MS of k*STEP_MS (k=1..CATCHUP_STEPS)
// to exactly k*STEP_MS makes in-band displays release exactly k steps per
// tick; k=2/3 likewise stabilizes 30 Hz delivery and missed-vsync double
// periods. Out-of-band deltas (high-refresh displays, stalls) use the
// exact accumulator, byte-identical to the pre-snap loop.
//
// The DRIFT ledger preserves the old loop's hard invariant that long-run
// sim rate converges to exactly 60 steps per wall-clock second even when
// the display sustains an in-band off-rate (a ~58Hz panel mode or
// battery-saver rAF throttling at ~17.2ms would otherwise run the game
// permanently ~3% slow — the "player feels too slow" class again). Every
// snap banks the pretended-away time; once a whole step of it accumulates,
// one tick repays it (a single 2-step or 0-step tick). On real near-60Hz
// panels that's one correction per ~17s instead of the raw accumulator's
// once per second, and browser 16/17ms timestamp quantization cancels to
// zero net drift — no corrections at all.
export function pace(acc: number, rawDeltaMs: number, snap = true, drift = 0): PaceResult {
  let delta = Math.min(MAX_FRAME_DELTA_MS, rawDeltaMs);
  if (snap) {
    const k = Math.round(delta / STEP_MS);
    if (k >= 1 && k <= CATCHUP_STEPS && Math.abs(delta - k * STEP_MS) <= SNAP_TOLERANCE_MS) {
      drift += delta - k * STEP_MS;
      delta = k * STEP_MS;
      if (drift >= STEP_MS) {
        delta += STEP_MS;
        drift -= STEP_MS;
      } else if (drift <= -STEP_MS) {
        delta -= STEP_MS;
        drift += STEP_MS;
      }
    }
  }
  acc += delta;
  let steps = 0;
  while (acc >= STEP_MS && steps < CATCHUP_STEPS) {
    steps++;
    acc -= STEP_MS;
  }
  // Never bank more than one step of debt — avoids a catch-up spiral after
  // long stalls (tab switch etc).
  if (acc > STEP_MS) acc = STEP_MS;
  return { steps, acc, drift };
}
