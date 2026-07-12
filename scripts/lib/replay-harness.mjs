// Headless T7RP replay runner (Replay Golden workflow, M2).
//
// Drives the real StageScene in plain Node — no browser, no canvas, no
// Playwright. update() is DOM-free by design; only draw() touches images and
// it is never called here. Each stage is verified independently: the scene
// is constructed from the stage's recorded entry snapshot, the RNG is
// re-seeded with the recorded per-stage seed (mirroring Th07.exe
// FUN_00440480 @ all.c:29748), and the recorded input words are fed one per
// update tick through the same InputFrame seam live keyboards use.
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/replay-harness';

let modsPromise = null;

// Bundles src/testkit/replay-entry.ts once per process and imports it.
export function loadEngine() {
  modsPromise ??= (async () => {
    mkdirSync(outDir, { recursive: true });
    execSync(
      `npx esbuild src/testkit/replay-entry.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`
    );
    return import(`../../${outDir}/replay-entry.mjs`);
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

// Applies a stage's recorded entry snapshot to a freshly constructed scene —
// the same fields StageScene's own carry block sets, without triggering the
// mid-run stage transition (frame alignment against the recorded stream is
// calibrated separately).
export function applySnapshot(scene, rpy, stageIndex) {
  const s = rpy.stages[stageIndex];
  scene.score = stageIndex > 0 ? rpy.stages[stageIndex - 1].scoreAtEnd : 0;
  scene.hiScore = Math.max(scene.hiScore, rpy.score);
  scene.graze = s.graze;
  scene.pointItems = s.pointItems;
  scene.playerObj.lives = s.lives;
  scene.playerObj.bombs = s.bombs;
  scene.playerObj.power = s.power;
  scene.cherry.cherry = s.cherry;
  scene.cherry.cherryMax = s.cherryMax;
  scene.cherry.cherryPlus = s.cherryPlus;
  scene.cherry.spellsCaptured = s.spellsCaptured;
  scene.extendLevel = s.extendLevel;
  // Recorded rank (DAT_00625884). The port's rank dynamics are under review;
  // seeding the recorded stage-entry value keeps the entry state faithful.
  scene.rank = s.rankByte;
  scene.rng.seed = s.rngSeed;
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
  return h >>> 0;
}

// Runs one recorded stage. Returns a report; opts.onFrame(frameIndex, scene)
// runs after every update tick (trace/digest hook).
//
// End conditions:
//  - completed: onStageComplete fired (arcade stages 1-5) — carryOut captured;
//  - stage 6 has no onStageComplete; the run ends when the input stream does;
//  - aborted: game over reached the continue screen, or input exhausted plus
//    `graceFrames` empty-input ticks without completion.
export async function runStage(rpy, stageIndex, opts = {}) {
  const mod = await loadEngine();
  const stage = rpy.stages[stageIndex];
  const scene = new mod.StageScene(
    makeStubAssets(mod),
    makeStubAudio(),
    rpy.difficulty,
    rpy.character,
    stage.stage,
    null
  );
  scene.mode = 'arcade';
  applySnapshot(scene, rpy, stageIndex);

  // RNG draw counter: every consumer bottoms out in u16(), and the recorder
  // snapshots the LIVE RNG state per stage — so the LCG step count between
  // adjacent stage seeds is the original's total draw budget (mod 65536).
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
    scene.spawnEffectParticles = (effectId, x, y, count, color) => {
      const before = rngDraws;
      origSpawn(effectId, x, y, count, color);
      const rec = rngProfile.get(effectId) ?? { calls: 0, particles: 0, draws: 0 };
      rec.calls++;
      rec.particles += Math.max(0, count | 0);
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
  // Our sim's per-frame event streams, mirroring the replay aux-word oracle
  // (RPY_AUX_BITS): kill frames (enemy-slot-vacate events) and item collects.
  const killFrames = [];
  const collectFrames = [];
  let prevEnemies = new Map();
  let prevItems = new Map();
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
  // Array-membership diffing alone (below) sees only removals, so it misses
  // (A) for modes 1-3 entirely — the enemy-audit RE confirmed this blind spot.
  // Tap killEnemy() directly for (A); the removal diff supplies (B), skipping
  // the same-frame mode-0 removal already counted at its call.
  const killCallFrame = new Map(); // enemy id -> frame killEnemy() fired (A)
  const killModeTally = { 0: 0, 1: 0, 2: 0, 3: 0 };
  {
    const origKill = scene.runtime.killEnemy.bind(scene.runtime);
    scene.runtime.killEnemy = (g, e) => {
      // interactable===false is the exe's death gate (all.c:14303); such a
      // call is a no-op that never reaches the switch, so it fires no aux bit.
      if (e.ecl.interactable) {
        killFrames.push(f);
        killCallFrame.set(e.id, f);
        killModeTally[e.ecl.deathMode & 7] = (killModeTally[e.ecl.deathMode & 7] ?? 0) + 1;
      }
      return origKill(g, e);
    };
  }
  for (; f < stage.inputs.length + graceFrames; f++) {
    const word = f < stage.inputs.length ? stage.inputs[f] : 0;
    if (f >= stage.inputs.length) extraFrames++;
    // Ghost mode: survive everything. Timeline calibration needs the whole
    // input stream to play out even while patterns still misalign — the
    // permanent invuln suppresses hit outcomes without touching RNG use
    // inside the collision path (graze still runs, like the exe's states 3/4).
    if (opts.ghost) scene.playerObj.invulnFrames = Math.max(scene.playerObj.invulnFrames, 2);
    scene.update(source.frame(word));
    if (scene.playerObj.lives < prevLives) deaths.push({ frame: f, stageFrame: scene.stageFrame });
    if (scene.playerObj.bombs < prevBombs) bombs.push({ frame: f, stageFrame: scene.stageFrame });
    prevLives = scene.playerObj.lives;
    prevBombs = scene.playerObj.bombs;
    {
      // (B) enemy-slot free: count every removal EXCEPT the same-frame mode-0
      // removal whose (A) fire was already recorded at the killEnemy() call.
      const cur = new Map();
      for (const e of scene.enemies) cur.set(e.id, e);
      for (const [id] of prevEnemies) {
        if (!cur.has(id) && killCallFrame.get(id) !== f) killFrames.push(f);
      }
      prevEnemies = cur;
      const items = new Map();
      for (const it of scene.items) items.set(it.id, it);
      for (const [id, it] of prevItems) {
        // Collected = removed before reaching the bottom cull.
        if (!items.has(id) && it.y <= 448) collectFrames.push(f);
      }
      prevItems = items;
    }
    opts.onFrame?.(f, scene);
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
    exited,
    gameOver: scene.gameOver ?? false,
    carryOut,
    deaths,
    bombs,
    hits: scene.hitLog,
    killFrames,
    killModeTally,
    collectFrames,
    rngDraws,
    rngProfile: rngProfile
      ? [...rngProfile.entries()]
          .map(([effectId, rec]) => ({ effectId, ...rec }))
          .sort((a, b) => b.draws - a.draws)
      : null,
    wallMs: performance.now() - start,
    scene
  };
}
