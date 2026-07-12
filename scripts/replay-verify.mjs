// T7RP replay golden verification (Replay Golden workflow, M3).
//
// Replays each recorded stage headlessly and compares our end-of-stage state
// against the NEXT stage's recorded entry snapshot — ground truth written by
// the original engine. Any unexpected player death is reported with its
// frame: the original player demonstrably survived every frame their replay
// shows them surviving, so a death localizes the first observable bullet
// misalignment at or before that frame.
//
// Usage:
//   node scripts/replay-verify.mjs [--replay tests/replays/th7_udFe25.rpy]
//     [--stage N]         verify only stage N (1-based)
//     [--json out.json]   write the full machine-readable report
//     [--trace A,B]       per-frame JSONL for frames A..B -> trace.jsonl
//     [--dump-frame F]    full stageSnapshot at frame F -> frame-F.json
//     [--out DIR]         output dir for trace/dump files (default tmp/replay)
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
    onFrame = (f, scene) => {
      if (traceRange && f >= traceRange[0] && f <= traceRange[1]) {
        traceLines.push(
          JSON.stringify({
            f,
            stageFrame: scene.stageFrame,
            rng: scene.rng.seed,
            px: Number(scene.playerObj.x.toFixed(3)),
            py: Number(scene.playerObj.y.toFixed(3)),
            enemies: scene.enemies.length,
            bullets: scene.enemyBullets.length,
            score: scene.score,
            graze: scene.graze,
            cherry: scene.cherry.cherry,
            hit: scene.playerObj.hitState,
            invuln: scene.playerObj.invulnFrames
          })
        );
      }
      if (dumpFrame === f) dumped = mod.stageSnapshot(scene);
    };
  }

  const r = await runStage(rpy, i, { onFrame });

  // Event-stream oracles: the aux word records per-frame kill/collect
  // events of the ORIGINAL run — align ours against them (±3 frames).
  const alignment = {};
  for (const [name, bit] of [
    ['kills', mod.RPY_AUX_BITS.enemyKill],
    ['collects', mod.RPY_AUX_BITS.itemCollect]
  ]) {
    const oracle = mod.auxEventFrames(stage, bit);
    const ourFrames = name === 'kills' ? r.killFrames : r.collectFrames;
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
    alignment[name] = { oracle: oracle.length, ours: ourFrames.length, matched, firstGap };
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
        rngBudget = { residue: n, ourDraws: r.rngDraws, ourResidue: r.rngDraws % 65536 };
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
  const incomplete = i < rpy.stages.length - 1 && !r.completed;
  const pass = diffs.length === 0 && unexpectedDeaths.length === 0 && !incomplete;
  if (!pass) failed = true;

  const stageReport = {
    stage: stage.stage,
    pass,
    framesRun: r.framesRun,
    framesAvailable: r.framesAvailable,
    completed: r.completed,
    gameOver: r.gameOver,
    wallMs: Math.round(r.wallMs),
    deaths: r.deaths,
    bombs: r.bombs,
    hits: r.hits,
    alignment,
    impliedDeaths: implied,
    diffs
  };
  report.stages.push(stageReport);

  console.log(`\nstage ${stage.stage}: ${pass ? 'PASS' : 'FAIL'}  ` +
    `(${r.framesRun}/${r.framesAvailable} frames, ${Math.round(r.wallMs)}ms)`);
  for (const [name, a] of Object.entries(alignment)) {
    console.log(
      `  ${name}: oracle ${a.oracle}, ours ${a.ours}, matched±3f ${a.matched}` +
        (a.firstGap !== null ? ` — first unmatched oracle event @${a.firstGap}` : '')
    );
  }
  if (rngBudget) {
    console.log(
      `  rng draws: ours ${rngBudget.ourDraws} (≡${rngBudget.ourResidue} mod 65536), ` +
        `original ≡${rngBudget.residue} — Δresidue ${rngBudget.residue - rngBudget.ourResidue}`
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
  if (incomplete) console.log(`  stage did not complete (gameOver=${r.gameOver})`);
  for (const d of diffs) {
    console.log(`  ${d.field}: expected ${d.expected}, got ${d.actual}`);
  }
}

if (args.json) {
  writeFileSync(args.json, JSON.stringify(report, null, 2));
  console.log(`\nreport written to ${args.json}`);
}
process.exit(failed ? 2 : 0);
