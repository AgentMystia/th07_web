// Headless T7RP replay runner (Replay Golden workflow, M2).
//
// Drives the real StageScene in plain Node — no browser, no canvas, no
// Playwright. update() is DOM-free by design; only draw() touches images and
// it is never called here. Each stage is verified independently: the scene
// is constructed from the stage's recorded entry snapshot, the RNG is
// re-seeded with the recorded per-stage seed (mirroring Th07.exe
// FUN_00440480 @ all.c:29748), and the recorded input words are fed one per
// update tick through the same InputFrame seam live keyboards use.
import { cachedEsbuild } from './test-build-cache.mjs';

let modsPromise = null;
let loadedMod = null;

// Bundles src/testkit/replay-entry.ts once per process and imports it.
export function loadEngine() {
  modsPromise ??= (async () => {
    const mod = await cachedEsbuild({
      name: 'replay-harness',
      entryPoints: ['src/testkit/replay-entry.ts']
    });
    loadedMod = mod;
    return mod;
  })();
  return modsPromise;
}

export function makeStubAssets(mod) {
  const anms = Object.fromEntries(
    Object.entries(mod.TH07_DATA.anm).map(([key, b64]) => [key, new mod.Anm(b64, key)])
  );
  // images are only dereferenced inside draw(), which the harness never calls.
  return { anms, images: {} };
}

export function makeStubAudio() {
  return {
    preloadSfx() {},
    preloadBgm() {},
    playBgm() {},
    fadeOutBgm() {},
    sfx() {}
  };
}

// Applies a stage's recorded entry snapshot to a freshly constructed scene.
//
// This is a thin wrapper over the PRODUCTION restore (Th07.exe FUN_00440480,
// src/game/replay-playback.ts) — browser playback and the Node verifier must
// enter a stage in exactly the same state, or the verifier certifies something
// the shipped game does not do. The hand-written copy that used to live here
// had silently lost `powerItemCountForScore` and `replayHasStage5Data` (the
// Gui.cpp:1365 stage-6 clear-bonus arm).
//
// The only harness-side addition is `restoreRng`: runStage constructs the
// scene with the recorded seed so manager bootstrap consumes from it (like
// native playback) and therefore passes `false`, while ad-hoc test scenes that
// were built with some other seed can ask for the seed to be re-seated.
export function applySnapshot(scene, rpy, stageIndex, opts = {}) {
  if (!loadedMod) throw new Error('applySnapshot: await loadEngine() first');
  loadedMod.applyReplayStageSnapshot(scene, rpy, stageIndex);
  if (opts.restoreRng !== false) {
    scene.rng.seed = rpy.stages[stageIndex].rngSeed;
    scene.runtime.initializeRandomCounters(scene.rng);
  }
}

// Per-frame state digest (FNV-1a over the divergence-sensitive core state).
// Any behavioral change in the simulation shifts the stream at the exact
// frame it first manifests — the regression-golden test compares sparse
// samples of it.
export function digestFrame(scene) {
  let h = 0x811c9dc5;
  const mix = (v) => {
    h ^= v & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (v >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (v >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (v >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(scene.rng.seed);
  mix(Math.round(scene.playerObj.x * 8));
  mix(Math.round(scene.playerObj.y * 8));
  mix(scene.enemies.length);
  mix(scene.enemyBullets.length);
  mix(scene.score >>> 0);
  mix(scene.graze);
  mix(scene.cherry.cherry >>> 0);
  // Fixed-slot identity/position is gameplay state even before it changes an
  // aggregate count or RNG draw. Catch allocator/cull drift at its source.
  for (const enemy of scene.enemies) {
    mix(enemy.poolSlot);
    mix(enemy.ecl.subId);
    mix(Math.round(enemy.x * 8));
    mix(Math.round(enemy.y * 8));
  }
  // Player-shot positions carry the live option-glide clock, so lock the
  // 96-slot pool before a bad spawn origin becomes a later collision drift.
  for (const shot of scene.playerBullets) {
    mix(shot.poolSlot);
    mix(shot.state === 'fired' ? 1 : 2);
    mix(Math.round(shot.x * 8));
    mix(Math.round(shot.y * 8));
  }
  return h >>> 0;
}

// Runs one recorded stage. Returns a report;
// opts.onFrame(frameIndex, scene, frameTrace) runs after every update tick
// (trace/digest hook). frameTrace carries the raw replay input and the RNG
// state/counter on both sides of that tick, so native PRE-state traces can be
// compared without an off-by-one correction.
// opts.onScene(scene, currentFrame) runs ONCE after construction and snapshot
// restore, before the first tick, for diagnostics that need to instrument the
// scene from frame 0 (e.g. the damage attribution trace). `currentFrame` reads
// the live frame index so a wrapper can stamp its own records.
//
// End conditions:
//  - completed: onStageComplete fired (arcade stages 1-5) — carryOut captured;
//  - stage 6 has no onStageComplete; the run ends when the input stream does;
//  - aborted: game over reached the continue screen, or input exhausted plus
//    `graceFrames` empty-input ticks without completion.
export async function runStage(rpy, stageIndex, opts = {}) {
  const mod = await loadEngine();
  const entry = mod.replayStageEntry(rpy, stageIndex);
  const stage = entry.stage;
  const scene = new mod.StageScene(
    makeStubAssets(mod),
    makeStubAudio(),
    rpy.difficulty,
    rpy.character,
    entry.runtimeStageNumber,
    null,
    stage.rngSeed
  );
  scene.mode = 'arcade';
  applySnapshot(scene, rpy, stageIndex, { restoreRng: false });

  // RNG draw counter: every consumer bottoms out in u16(), and the recorder
  // snapshots the LIVE RNG state per stage — so the LCG step count between
  // adjacent stage seeds is the original's total draw budget (mod 65536).
  // StageScene's manager initialization consumes from the restored replay
  // seed before the first replay frame. Count those bootstrap draws in the
  // stage-wide RNG budget, while keeping the per-frame trace counter based at
  // zero (native PRE traces likewise subtract their frame-0 raw counter).
  let rngBootstrapDraws = 0;
  {
    let seed = stage.rngSeed;
    while (seed !== scene.rng.seed && rngBootstrapDraws < 65536) {
      const a = ((seed ^ 0x9630) - 0x6553) & 0xffff;
      seed = (((a & 0xc000) >> 14) + a * 4) & 0xffff;
      rngBootstrapDraws++;
    }
    if (seed !== scene.rng.seed) {
      throw new Error(`stage ${stage.stage}: initialized RNG state is not reachable from replay seed`);
    }
  }
  let rngDraws = 0;
  {
    const orig = scene.rng.u16.bind(scene.rng);
    scene.rng.u16 = () => {
      rngDraws++;
      return orig();
    };
  }

  // Optional per-effectId RNG profiling: wrap spawnEffectParticles and bucket
  // the rngDraws delta by effectId, plus tally call/particle counts. Since the
  // whole engine draws from ONE stream (confirmed: all 147 exe call sites pass
  // state 0x495e00), an effect type that draws the wrong count per particle
  // shifts every later gameplay draw that frame — so this bucket breakdown
  // localizes where our stage-1 draw budget diverges from the exe's.
  const rngProfile = opts.profileRng ? new Map() : null;
  if (rngProfile) {
    const origSpawn = scene.spawnEffectParticles.bind(scene);
    scene.spawnEffectParticles = (effectId, x, y, count, color, seed, ownerEnemyId) => {
      const before = rngDraws;
      const beforeParticles = scene.particles.length;
      origSpawn(effectId, x, y, count, color, seed, ownerEnemyId);
      const rec = rngProfile.get(effectId) ?? { calls: 0, requested: 0, particles: 0, draws: 0 };
      rec.calls++;
      rec.requested += Math.max(0, count | 0);
      rec.particles += Math.max(0, scene.particles.length - beforeParticles);
      rec.draws += rngDraws - before;
      rngProfile.set(effectId, rec);
    };
  }

  let completed = false;
  let carryOut = null;
  let exited = false;
  scene.onStageComplete = (carry) => {
    completed = true;
    carryOut = carry;
  };
  scene.onExitToTitle = () => {
    exited = true;
  };

  const source = new mod.ReplayInputSource();
  const deaths = [];
  const bombs = [];
  // Our sim's per-frame event streams, one per RPY_AUX_BITS entry. Each is a
  // Set because AUX is a bitfield: several events of one kind inside a single
  // tick collapse to one frame marker in the recording, so ours must too.
  const killFrames = new Set();
  const collectFrames = new Set();
  const playerHitFrames = new Set();
  const bombFrames = new Set();
  const missFrames = new Set();
  const borderStartFrames = new Set();
  const borderBreakFrames = new Set();
  let prevLives = scene.playerObj.lives;
  let prevBombs = scene.playerObj.bombs;
  const graceFrames = opts.graceFrames ?? 900;
  const start = performance.now();

  let f = 0;
  let extraFrames = 0;

  // Precise aux-0x20 ("enemy slot vacated") oracle. The exe sets it at three
  // sites (all.c 13887/14351/14360). Two are distinct in TIME per enemy:
  //   (A) 14351/14360 — the HP-kill switch, exactly once per killEnemy() call
  //       (all death modes). Mode 0 also removes the actor the SAME frame;
  //       modes 1-3 retain a scripted-death husk (killEnemy returns true).
  //   (B) 13887 via 14050/14133 — natural ECL exit or off-screen+trail cull,
  //       fired when the slot is finally freed. For a mode-1/2/3 kill this is
  //       a SECOND, later event; for a pure despawn it is the only event.
  // Array-membership diffing sees only removals and misses (A) for modes 1-3,
  // as well as actors allocated and released in one manager pass. Tap both
  // lifecycle methods instead. Since AUX is a bitfield, the Set intentionally
  // collapses a same-frame mode-0 kill+release pair to one frame marker.
  const killModeTally = { 0: 0, 1: 0, 2: 0, 3: 0 };
  {
    const origKill = scene.runtime.killEnemy.bind(scene.runtime);
    scene.runtime.killEnemy = (g, e, ...args) => {
      // interactable===false is the exe's death gate (all.c:14303); such a
      // call is a no-op that never reaches the switch, so it fires no aux bit.
      if (e.ecl.interactable) {
        killFrames.add(f);
        killModeTally[e.ecl.deathMode & 7] = (killModeTally[e.ecl.deathMode & 7] ?? 0) + 1;
      }
      // Observation wrappers must be behavior-transparent. In particular,
      // FUN_0041ed50 forwards its per-frame bomb-contact flag to the death
      // drop constructor; dropping later arguments here silently changed
      // replay behavior while the uninstrumented engine remained correct.
      return origKill(g, e, ...args);
    };
    const origRelease = scene.runtime.releaseEnemy.bind(scene.runtime);
    scene.runtime.releaseEnemy = (g, e) => {
      killFrames.add(f);
      return origRelease(g, e);
    };
    // Item removal alone cannot distinguish a pickup from a bottom cull and
    // misses an item spawned and collected within one update. The authored
    // pickup routine is the exact AUX-0x40 writer seam.
    const origCollect = scene.collectItem.bind(scene);
    scene.collectItem = (item) => {
      collectFrames.add(f);
      return origCollect(item);
    };
    // Replay AUX-0x02 is written at the collision-contact seam, before the
    // player-state/invulnerability outcome gate. Native Stage-5 frame 11587
    // records a slot-917 bullet contact while state 3 absorbs it; hitLog is
    // intentionally committed-hit-only and therefore cannot serve as this
    // oracle. Tap the shared contact handler instead without changing play.
    scene.onPlayerContact = () => playerHitFrames.add(f);
    // AUX-0x01 is written inside FUN_0043d9a0's ACCEPT branch (all.c:28486),
    // right next to the -200 rank call our onBombUsed() ports. The free
    // Border-break branch above it returns early and writes nothing, so the
    // bomb stream must not tap the raw held-X button or the timer.
    const origBombUsed = scene.onBombUsed.bind(scene);
    scene.onBombUsed = () => {
      bombFrames.add(f);
      return origBombUsed();
    };
    // AUX-0x04 (all.c:28596) fires the frame the deathbomb meter reaches zero
    // and the miss COMMITS — 30 squish frames before the life counter drops.
    // `deaths` below tracks the life decrement instead and is 30 frames late,
    // which is why it is reporting-only and never the oracle.
    const origPlayerDeath = scene.onPlayerDeath.bind(scene);
    scene.onPlayerDeath = () => {
      missFrames.add(f);
      return origPlayerDeath();
    };
    // AUX-0x08 (all.c:28928) at the tail of FUN_0043e890's success path;
    // CherrySystem calls onBorderStart from exactly that seam.
    const cherryEvents = scene.cherry.events;
    const origBorderStart = cherryEvents.onBorderStart;
    cherryEvents.onBorderStart = () => {
      borderStartFrames.add(f);
      return origBorderStart?.call(cherryEvents);
    };
    // AUX-0x10 (all.c:28994) is the tail of FUN_0043eb00 — the forced
    // break/cancel path ONLY. The natural expiry / cherry-full path
    // (FUN_0043e620, our finishBorderSurvival) writes no bit, so tapping
    // onBorderEnd would over-report. applyBorderBreakEffects is our port of
    // FUN_0043eb00 and is reached by both the hit break and the marker-2
    // cancel, which is exactly the exe's call graph.
    const origBreakEffects = scene.applyBorderBreakEffects.bind(scene);
    scene.applyBorderBreakEffects = (...args) => {
      borderBreakFrames.add(f);
      return origBreakEffects(...args);
    };
  }
  opts.onScene?.(scene, () => f);
  for (; f < stage.inputs.length + graceFrames; f++) {
    const word = f < stage.inputs.length ? stage.inputs[f] : 0;
    if (f >= stage.inputs.length) extraFrames++;
    const preSeed = scene.rng.seed;
    const preDraws = rngDraws;
    const preStageFrame = scene.stageFrame;
    // Ghost mode: survive everything. Timeline calibration needs the whole
    // input stream to play out even while patterns still misalign — the
    // permanent invuln suppresses hit outcomes without touching RNG use
    // inside the collision path (graze still runs, like the exe's states 3/4).
    if (opts.ghost && scene.playerObj.invulnFrames < 2) {
      scene.playerObj.invulnFrames = 2;
      scene.playerObj.invulnFrac = 0;
    }
    scene.update(source.frame(word));
    // MSG op9 arms the native results tally while replay recording continues;
    // op11 later requests the next game state and is the last authored PRE
    // boundary. The compressed block can retain zero sentinel/padding records
    // after that transition, so verification stops on the stage-flow latch
    // instead of manufacturing result-screen ticks from array exhaustion.
    if (!completed && scene.stageClear) {
      completed = true;
      carryOut = scene.carryState();
    }
    if (scene.playerObj.lives < prevLives) deaths.push({ frame: f, stageFrame: scene.stageFrame });
    if (scene.playerObj.bombs < prevBombs) bombs.push({ frame: f, stageFrame: scene.stageFrame });
    prevLives = scene.playerObj.lives;
    prevBombs = scene.playerObj.bombs;
    opts.onFrame?.(f, scene, {
      input: word,
      preStageFrame,
      postStageFrame: scene.stageFrame,
      preSeed,
      postSeed: scene.rng.seed,
      preDraws,
      postDraws: rngDraws
    });
    if (completed || exited) {
      f++;
      break;
    }
  }

  return {
    stage: stage.stage,
    framesAvailable: stage.inputs.length,
    framesRun: f,
    extraFrames,
    completed,
    inputExhausted: f >= stage.inputs.length,
    exited,
    gameOver: scene.gameOver ?? false,
    carryOut,
    deaths,
    bombs,
    hits: scene.hitLog,
    killFrames: [...killFrames],
    killModeTally,
    collectFrames: [...collectFrames],
    playerHitFrames: [...playerHitFrames],
    bombFrames: [...bombFrames],
    missFrames: [...missFrames],
    borderStartFrames: [...borderStartFrames],
    borderBreakFrames: [...borderBreakFrames],
    rngBootstrapDraws,
    rngDraws: rngBootstrapDraws + rngDraws,
    rngProfile: rngProfile
      ? [...rngProfile.entries()]
          .map(([effectId, rec]) => ({ effectId, ...rec }))
          .sort((a, b) => b.draws - a.draws)
      : null,
    wallMs: performance.now() - start,
    scene
  };
}
