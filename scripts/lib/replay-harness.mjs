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
  let prevLives = scene.playerObj.lives;
  let prevBombs = scene.playerObj.bombs;
  const graceFrames = opts.graceFrames ?? 900;
  const start = performance.now();

  let f = 0;
  let extraFrames = 0;
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
    wallMs: performance.now() - start,
    scene
  };
}
