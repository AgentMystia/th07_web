// T7RP replay golden verification (Replay Golden workflow, M3).
//
// Replays each recorded stage headlessly and compares our end-of-stage state
// against the NEXT stage's recorded entry snapshot — ground truth written by
// the original engine. PASS also requires the exact RNG residue, exact
// per-frame kill/collect/player-hit AUX streams, and an authored stage end
// (stage-complete callback for 1-5; recorded input exhaustion for stage 6).
// Any unexpected player death is reported with its frame: the original player
// demonstrably survived every frame their replay shows them surviving, so a
// death localizes the first observable bullet misalignment at or before it.
//
// Usage:
//   node scripts/replay-verify.mjs [--replay tests/replays/th7_udFe25.rpy]
//     [--stage N]         verify only stage N (1-based)
//     [--json out.json]   write the full machine-readable report
//     [--trace A,B]       input + pre/post RNG + fixed-slot JSONL for A..B
//     [--dump-frame F]    full stageSnapshot at frame F -> frame-F.json
//     [--out DIR]         output dir for trace/dump files (default tmp/replay)
//     [--ghost]           forced invuln — runs the FULL recorded input stream
//                         regardless of hits, for whole-stage event/RNG-budget
//                         diagnostics (checkpoint fields will show FAIL, since
//                         ghost mode is diagnostic-only and never PASSes)
//
// Exit codes: 0 = all verified stages PASS; 2 = divergence; 1 = error.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEngine, runStage } from './lib/replay-harness.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[m[1]] = true;
    else {
      args[m[1]] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const replayPath = args.replay ?? 'tests/replays/th7_udFe25.rpy';
const onlyStage = args.stage ? Number(args.stage) : null;

const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync(replayPath));
console.log(
  `replay: ${replayPath} — ${rpy.character} diff=${rpy.difficulty} "${rpy.name}" ` +
    `${rpy.stages.length} stages, final score ${rpy.score}`
);

// Expected end-of-stage state for stage index i: the entry snapshot of stage
// i+1. The last stage only has the file-global score (block +0x00 equals it).
function expectedEnd(rpy, i) {
  const next = rpy.stages[i + 1];
  const scoreAtEnd = rpy.stages[i].scoreAtEnd;
  if (!next) return { score: scoreAtEnd };
  return {
    score: scoreAtEnd,
    graze: next.graze,
    pointItems: next.pointItems,
    power: next.power,
    lives: next.lives,
    bombs: next.bombs,
    cherry: next.cherry,
    cherryMax: next.cherryMax,
    cherryPlus: next.cherryPlus,
    extendLevel: next.extendLevel,
    spellsCaptured: next.spellsCaptured
  };
}

function actualEnd(scene) {
  return {
    score: scene.score,
    graze: scene.graze,
    pointItems: scene.pointItems,
    power: scene.playerObj.power,
    lives: scene.playerObj.lives,
    bombs: scene.playerObj.bombs,
    cherry: scene.cherry.cherry,
    cherryMax: scene.cherry.cherryMax,
    cherryPlus: scene.cherry.cherryPlus,
    extendLevel: scene.extendLevel,
    spellsCaptured: scene.cherry.spellsCaptured
  };
}

// Deaths the recorded run itself implies for stage i (lives lost = extends
// gained minus net lives change; 1-up items are folded into extends gained
// only via extendLevel, so this is a lower bound — but any deaths beyond it
// are certain divergence, and for a no-miss replay any death at all is).
function impliedDeaths(rpy, i) {
  const next = rpy.stages[i + 1];
  if (!next) return null; // unknown for the last stage
  const cur = rpy.stages[i];
  const extendsGained = next.extendLevel - cur.extendLevel;
  return Math.max(0, cur.lives + extendsGained - next.lives);
}

const report = { replay: replayPath, stages: [] };
let failed = false;

const outDir = args.out ?? 'tmp/replay';
const traceRange = args.trace ? String(args.trace).split(',').map(Number) : null;
const dumpFrame = args['dump-frame'] !== undefined ? Number(args['dump-frame']) : null;

for (let i = 0; i < rpy.stages.length; i++) {
  const stage = rpy.stages[i];
  if (onlyStage && stage.stage !== onlyStage) continue;

  let onFrame;
  const traceLines = [];
  let dumped = null;
  if (traceRange || dumpFrame !== null) {
    onFrame = (f, scene, frameTrace) => {
      if (traceRange && f >= traceRange[0] && f <= traceRange[1]) {
        const occupiedSlots = (values) => values
          .map((value) => value.poolSlot)
          .filter((slot) => Number.isInteger(slot))
          .sort((a, b) => a - b);
        const effectIds = {};
        for (const particle of scene.particles) {
          effectIds[particle.effectId] = (effectIds[particle.effectId] ?? 0) + 1;
        }
        traceLines.push(
          JSON.stringify({
            f,
            input: frameTrace.input,
            stageFrame: scene.stageFrame,
            rng: scene.rng.seed,
            preStageFrame: frameTrace.preStageFrame,
            postStageFrame: frameTrace.postStageFrame,
            preSeed: frameTrace.preSeed,
            postSeed: frameTrace.postSeed,
            preDraws: frameTrace.preDraws,
            postDraws: frameTrace.postDraws,
            px: Number(scene.playerObj.x.toFixed(3)),
            py: Number(scene.playerObj.y.toFixed(3)),
            enemies: scene.enemies.length,
            bullets: scene.enemyBullets.length,
            slots: {
              enemies: occupiedSlots(scene.enemies),
              playerShots: occupiedSlots(scene.playerBullets),
              attacks: occupiedSlots(scene.activeBombSlots ?? []),
              enemyBullets: occupiedSlots(scene.enemyBullets),
              effects: occupiedSlots(scene.particles)
            },
            effectCursor: scene.effectPoolCursor,
            effectIds,
            score: scene.score,
            graze: scene.graze,
            rank: scene.rank,
            rankAccumulator: scene.rankAccumulator,
            cherry: scene.cherry.cherry,
            hit: scene.playerObj.hitState,
            invuln: scene.playerObj.invulnFrames
          })
        );
      }
      if (dumpFrame === f) dumped = mod.stageSnapshot(scene);
    };
  }

  const r = await runStage(rpy, i, {
    onFrame,
    ghost: Boolean(args.ghost),
    // Formal verification ends at the recorded stream boundary. Empty-input
    // tail ticks can be useful for diagnosis, but must never manufacture a
    // stage clear that the replay itself did not reach.
    graceFrames: 0
  });

  // Event-stream oracles: the aux word is a bitfield, so multiple events of
  // the same kind during one tick collapse to one frame marker. The harness
  // mirrors that per-frame de-duplication. Exact arrays are a PASS condition;
  // the ±3-frame count remains diagnostic context only.
  const alignment = {};
  for (const [name, bit] of [
    ['kills', mod.RPY_AUX_BITS.enemyKill],
    ['collects', mod.RPY_AUX_BITS.itemCollect],
    ['playerHits', mod.RPY_AUX_BITS.playerHit]
  ]) {
    const oracle = mod.auxEventFrames(stage, bit);
    const ourFrames = name === 'kills'
      ? r.killFrames
      : name === 'collects'
        ? r.collectFrames
        : r.playerHitFrames;
    let matched = 0;
    let ptr = 0;
    let firstGap = null;
    for (const of_ of oracle) {
      while (ptr < ourFrames.length && ourFrames[ptr] < of_ - 3) ptr++;
      if (ptr < ourFrames.length && Math.abs(ourFrames[ptr] - of_) <= 3) {
        matched++;
        ptr++;
      } else if (firstGap === null) {
        firstGap = of_;
      }
    }
    const mismatchIndex = oracle.findIndex((frame, index) => ourFrames[index] !== frame);
    const firstMismatch = mismatchIndex >= 0
      ? { index: mismatchIndex, expected: oracle[mismatchIndex], actual: ourFrames[mismatchIndex] ?? null }
      : oracle.length === ourFrames.length
        ? null
        : { index: oracle.length, expected: null, actual: ourFrames[oracle.length] ?? null };
    alignment[name] = {
      oracle: oracle.length,
      ours: ourFrames.length,
      exact: firstMismatch === null,
      firstMismatch,
      matchedWithin3: matched,
      firstGap
    };
  }

  // RNG draw budget: the recorder snapshots the live RNG per stage, so the
  // LCG step count between adjacent stage seeds is the original's exact
  // total draw count for this stage (known mod 65536, the LCG's period).
  let rngBudget = null;
  const next = rpy.stages[i + 1];
  if (next) {
    let s = stage.rngSeed;
    for (let n = 1; n <= 65536; n++) {
      const a = (s ^ 0x9630) - 0x6553 & 0xffff;
      s = (((a & 0xc000) >> 14) + a * 4) & 0xffff;
      if (s === next.rngSeed) {
        rngBudget = {
          residue: n,
          ourDraws: r.rngDraws,
          ourResidue: r.rngDraws % 65536,
          bootstrapDraws: r.rngBootstrapDraws,
          exact: r.rngDraws % 65536 === n
        };
        break;
      }
    }
  }

  if (traceLines.length || dumped) {
    mkdirSync(outDir, { recursive: true });
    if (traceLines.length) {
      const p = join(outDir, `stage${stage.stage}-trace.jsonl`);
      writeFileSync(p, traceLines.join('\n') + '\n');
      console.log(`trace written to ${p}`);
    }
    if (dumped) {
      const p = join(outDir, `stage${stage.stage}-frame-${dumpFrame}.json`);
      writeFileSync(p, JSON.stringify(dumped, null, 2));
      console.log(`snapshot written to ${p}`);
    }
  }
  const expected = expectedEnd(rpy, i);
  const actual = actualEnd(r.scene);
  const diffs = [];
  for (const [key, want] of Object.entries(expected)) {
    if (actual[key] !== want) diffs.push({ field: key, expected: want, actual: actual[key] });
  }
  const implied = impliedDeaths(rpy, i);
  const unexpectedDeaths = implied === null ? r.deaths : r.deaths.slice(implied);
  const completion = stage.stage === 6
    ? { requirement: 'inputExhausted', met: r.inputExhausted }
    : { requirement: 'stageComplete', met: r.completed };
  const eventsExact = Object.values(alignment).every((entry) => entry.exact);
  const rngExact = rngBudget?.exact ?? true;
  const verifiedPass = diffs.length === 0 && unexpectedDeaths.length === 0 &&
    completion.met && eventsExact && rngExact;
  const pass = !args.ghost && verifiedPass;
  if (!pass && !args.ghost) failed = true;

  const stageReport = {
    stage: stage.stage,
    pass,
    framesRun: r.framesRun,
    framesAvailable: r.framesAvailable,
    completed: r.completed,
    inputExhausted: r.inputExhausted,
    completion,
    gameOver: r.gameOver,
    wallMs: Math.round(r.wallMs),
    deaths: r.deaths,
    bombs: r.bombs,
    hits: r.hits,
    alignment,
    rngBudget,
    impliedDeaths: implied,
    diffs
  };
  report.stages.push(stageReport);

  console.log(`\nstage ${stage.stage}: ${args.ghost ? 'GHOST (diagnostic-only)' : pass ? 'PASS' : 'FAIL'}  ` +
    `(${r.framesRun}/${r.framesAvailable} frames, ${Math.round(r.wallMs)}ms)`);
  for (const [name, a] of Object.entries(alignment)) {
    console.log(
      `  ${name}: oracle ${a.oracle}, ours ${a.ours}, exact ${a.exact ? 'yes' : 'NO'}, ` +
        `matched±3f ${a.matchedWithin3}` +
        (a.firstMismatch
          ? ` — first mismatch #${a.firstMismatch.index}: expected ${a.firstMismatch.expected}, got ${a.firstMismatch.actual}`
          : '') +
        (a.firstGap !== null ? `; first unmatched oracle event @${a.firstGap}` : '')
    );
  }
  if (rngBudget) {
    console.log(
      `  rng draws: ours ${rngBudget.ourDraws} (≡${rngBudget.ourResidue} mod 65536), ` +
        `original ≡${rngBudget.residue} — Δresidue ${rngBudget.residue - rngBudget.ourResidue}` +
        `; bootstrap ${rngBudget.bootstrapDraws}; exact ${rngBudget.exact ? 'yes' : 'NO'}`
    );
  }
  if (r.deaths.length) {
    const first = r.deaths[0];
    console.log(
      `  deaths: ${r.deaths.length} (implied by replay: ${implied ?? '?'}) — ` +
        `FIRST DIVERGENCE at/before frame ${first.frame} (stageFrame ${first.stageFrame})`
    );
    for (const h of r.hits.slice(0, 3)) {
      const b = h.bullet;
      console.log(
        `  hit@${h.frame} ${h.kind} player(${h.playerX.toFixed(1)},${h.playerY.toFixed(1)})` +
          (b
            ? ` <- bullet sprite ${b.sprite}:${b.spriteOffset} owner enemy#${b.ownerId} sub${b.ownerSub} ` +
              `fired@${b.spawnFrame} angle=${b.angle.toFixed(3)} speed=${b.speed.toFixed(2)} age=${b.age}`
            : '')
      );
    }
  }
  if (!completion.met) {
    console.log(
      `  ${completion.requirement === 'stageComplete' ? 'stage did not complete' : 'stage 6 input was not exhausted'} ` +
        `(gameOver=${r.gameOver})`
    );
  }
  for (const d of diffs) {
    console.log(`  ${d.field}: expected ${d.expected}, got ${d.actual}`);
  }
}

if (args.json) {
  writeFileSync(args.json, JSON.stringify(report, null, 2));
  console.log(`\nreport written to ${args.json}`);
}
process.exit(failed ? 2 : 0);
