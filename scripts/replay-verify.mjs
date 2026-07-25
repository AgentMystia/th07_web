// T7RP replay golden verification (Replay Golden workflow, M3).
//
// Replays each recorded stage headlessly and compares our end-of-stage state
// against the NEXT stage's recorded entry snapshot — ground truth written by
// the original engine. PASS also requires the exact RNG residue, an authored
// stage end, and all SEVEN per-frame AUX event streams (kills, collects,
// player contacts, misses, bombs, border starts, border breaks) matching
// frame for frame. Final-stage blocks include recorder sentinel/padding words
// after the last native gameplay row, so array exhaustion is not a completion
// oracle. Any unexpected player death is reported with its frame: the original
// player demonstrably survived every frame their replay shows them surviving,
// so a death localizes the first observable bullet misalignment at or before it.
//
// Usage:
//   node scripts/replay-verify.mjs [--replay a.rpy[,b.rpy…]]
//     [--all]             verify every replay/*.rpy (local evidence) plus the
//                         committed fixture, and print a difficulty×stage matrix
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
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
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

const FIXTURE = 'tests/replays/th7_udFe25.rpy';
// Local, git-ignored evidence: the E/N/H/Extra/Phantasm replays live here so
// third-party recordings never enter the repository. Only FIXTURE is committed
// and only FIXTURE gates CI.
const LOCAL_REPLAY_DIR = 'replay';

function resolveReplayPaths(args) {
  if (args.replay && args.replay !== true) return String(args.replay).split(',');
  if (!args.all) return [FIXTURE];
  const local = existsSync(LOCAL_REPLAY_DIR)
    ? readdirSync(LOCAL_REPLAY_DIR)
        .filter((f) => f.endsWith('.rpy'))
        .sort()
        .map((f) => join(LOCAL_REPLAY_DIR, f))
    : [];
  return [FIXTURE, ...local];
}

const args = parseArgs(process.argv);
const replayPaths = resolveReplayPaths(args);
const onlyStage = args.stage ? Number(args.stage) : null;

const mod = await loadEngine();
const DIFFICULTY_NAMES = ['Easy', 'Normal', 'Hard', 'Lunatic', 'Extra', 'Phantasm'];

// Expected end-of-stage state for stage index i: the entry snapshot of stage
// i+1. The final fixture stage has one directly measured native-playback
// exception: its saved metadata is one raw score unit below the live v1.00b
// result. Behavior fidelity follows the executable; the recorded value stays
// visible as an advisory instead of silently becoming the behavior oracle.
function nativeLiveFinalScore(rpy, stage) {
  // th7_udFe25.rpy identity + native evidence (2026-07-13): Th07.exe v1.00b
  // reads 116283036 from DAT_0061c258+4 at PRE25779 and retains it through
  // the last captured PRE26433. The stage/global RPY fields store 116283035.
  if (rpy.shotByte === 4 && rpy.difficulty === 3 && rpy.score === 116283035 &&
      stage.stage === 6 && stage.rngSeed === 0x20a4 && stage.inputs.length === 26436) {
    return 116283036;
  }
  return null;
}

function expectedEnd(rpy, i) {
  const next = rpy.stages[i + 1];
  const scoreAtEnd = rpy.stages[i].scoreAtEnd;
  if (!next) return { score: nativeLiveFinalScore(rpy, rpy.stages[i]) ?? scoreAtEnd };
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
    spellsCaptured: next.spellsCaptured,
    powerItemCountForScore: next.powerItemCountForScore
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
    spellsCaptured: scene.cherry.spellsCaptured,
    powerItemCountForScore: scene.powerItemCountForScore
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

const report = { replays: [] };
let failed = false;

const outDir = args.out ?? 'tmp/replay';
const traceRange = args.trace ? String(args.trace).split(',').map(Number) : null;
const damageRange = args['trace-damage'] ? String(args['trace-damage']).split(',').map(Number) : null;
const dumpFrame = args['dump-frame'] !== undefined ? Number(args['dump-frame']) : null;

// Damage attribution. "We killed this boss N frames early/late" is the shape
// of almost every remaining divergence, and the AUX oracle localizes it to a
// frame but not to a shot. Wrapping the two seams of the exe's damage pipeline
// (FUN_0041ed50: per-hit accumulation, then one settlement per enemy per
// frame) gives the missing half without any production hook: every contact is
// attributed to a player-shot pool slot, and every settlement reports what the
// 70-cap / spell-divisor / shield chain actually removed.
function installDamageTrace(scene, currentFrame, range, sink) {
  const inRange = () => currentFrame() >= range[0] && currentFrame() <= range[1];
  const origDamage = scene.damageEnemy.bind(scene);
  scene.damageEnemy = (enemy, damage, kind = 'shot') => {
    if (inRange()) {
      // damageEnemy() receives only the resolved number (exactly as
      // FUN_0041ed50 does), so recover the shot side geometrically: every
      // still-live shot whose AABB currently overlaps this enemy's hitbox.
      // The collision pass flips a shot to 'collided' only AFTER the damage
      // call, so the contributing slot is always in this list; slots listed
      // beyond it are the ones queued to hit on a later pass.
      const box = enemy.ecl?.hitbox ?? { x: 0, y: 0 };
      const overlapping = scene.playerBullets
        .filter((b) => !b.dead && b.state === 'fired' &&
          Math.abs(b.x - enemy.x) <= (box.x + b.hitboxW) * 0.5 &&
          Math.abs(b.y - enemy.y) <= (box.y + b.hitboxH) * 0.5)
        .map((b) => `${b.poolSlot}:${b.damage}`);
      sink.push({
        f: currentFrame(),
        ev: 'hit',
        kind,
        enemy: enemy.poolSlot,
        sub: enemy.ecl?.subId ?? null,
        boss: Boolean(enemy.ecl?.isBoss),
        ex: Number(enemy.x.toFixed(3)),
        ey: Number(enemy.y.toFixed(3)),
        hitbox: `${box.x}x${box.y}`,
        hp: enemy.hp,
        damage,
        overlappingShots: overlapping
      });
    }
    return origDamage(enemy, damage, kind);
  };
  const origSettle = scene.settlePendingDamage.bind(scene);
  scene.settlePendingDamage = (enemy) => {
    const rawShot = enemy.pendingShotDmg;
    const rawBomb = enemy.pendingBombDmg;
    const hpBefore = enemy.hp;
    const out = origSettle(enemy);
    if (inRange() && (rawShot > 0 || rawBomb > 0)) {
      sink.push({
        f: currentFrame(),
        ev: 'settle',
        enemy: enemy.poolSlot,
        sub: enemy.ecl?.subId ?? null,
        rawShot,
        rawBomb,
        settled: enemy.damageThisFrame,
        hpBefore,
        hpAfter: enemy.hp,
        spell: Boolean(scene.spellcard),
        shield: enemy.ecl?.damageShield ?? 0
      });
    }
    return out;
  };
}

for (const replayPath of replayPaths) {
const rpy = new mod.Rpy(readFileSync(replayPath));
const replayReport = {
  replay: replayPath,
  character: rpy.character,
  difficulty: rpy.difficulty,
  difficultyName: DIFFICULTY_NAMES[rpy.difficulty] ?? String(rpy.difficulty),
  stages: []
};
report.replays.push(replayReport);
console.log(
  `\n=== ${replayPath} — ${rpy.character} ${replayReport.difficultyName} "${rpy.name}" ` +
    `${rpy.stages.length} stages, final score ${rpy.score}`
);

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
            ,bossHp: scene.runtime.bossSlots?.[0]?.hp ?? null
            ,bossTimer: scene.runtime.bossSlots?.[0]?.ecl?.bossTimer ?? null
            ,bossSub: scene.runtime.bossSlots?.[0]?.ecl?.ctx?.subId ?? null
            ,bossCtxTime: scene.runtime.bossSlots?.[0]?.ecl?.ctx?.time ?? null
            ,bossX: scene.runtime.bossSlots?.[0]?.x ?? null
            ,bossY: scene.runtime.bossSlots?.[0]?.y ?? null
            ,bossDamage: scene.runtime.bossSlots?.[0]?.damageThisFrame ?? null
            ,bossTimerThreshold: scene.runtime.bossSlots?.[0]?.ecl?.timerCallbackThreshold ?? null
            ,bossDeathCallback: scene.runtime.bossSlots?.[0]?.ecl?.deathCallbackSub ?? null
            ,dialogue: scene.dialogue ? { idx: scene.dialogue.idx ?? null, time: scene.dialogue.time ?? null, waitAge: scene.dialogue.waitAge ?? null, done: scene.dialogue.done } : null
          })
        );
      }
      if (dumpFrame === f) dumped = mod.stageSnapshot(scene);
    };
  }

  const damageLines = [];
  const r = await runStage(rpy, i, {
    onFrame,
    onScene: damageRange
      ? (scene, currentFrame) => installDamageTrace(scene, currentFrame, damageRange, damageLines)
      : undefined,
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
  //
  // The aux column's alignment differs per recording environment (aux[i]
  // describes tick i or i-1 — see detectAuxAlignment in src/formats/rpy.ts);
  // infer it once per stage before comparing. An ambiguous vote is reported
  // and falls back to raw indices, which cannot PASS spuriously (exactness
  // still gates it).
  // Every bit the AUX word actually carries is an independent frame-exact
  // oracle, so all seven streams are compared and all seven gate PASS. The
  // sparse ones (bombs, misses, border start/break) are what localize a
  // divergence in a stage whose kill/collect traffic is thin.
  const STREAMS = [
    ['kills', mod.RPY_AUX_BITS.enemyKill, r.killFrames],
    ['collects', mod.RPY_AUX_BITS.itemCollect, r.collectFrames],
    ['playerHits', mod.RPY_AUX_BITS.playerHit, r.playerHitFrames],
    ['misses', mod.RPY_AUX_BITS.playerMiss, r.missFrames],
    ['bombs', mod.RPY_AUX_BITS.bomb, r.bombFrames],
    ['borderStarts', mod.RPY_AUX_BITS.borderStart, r.borderStartFrames],
    ['borderBreaks', mod.RPY_AUX_BITS.borderBreak, r.borderBreakFrames]
  ];
  let auxAlignment;
  try {
    auxAlignment = mod.detectAuxAlignment(
      stage,
      STREAMS.map(([, bit, frames]) => ({ bit, frames }))
    );
  } catch (e) {
    auxAlignment = { offset: 0, prefixByOffset: null, ambiguous: e.message };
  }
  const alignment = {};
  for (const [name, bit, ourFrames] of STREAMS) {
    const oracle = mod.auxEventFrames(stage, bit, auxAlignment.offset);
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
    // The frame the two streams actually part ways: whichever side fired
    // first at the first differing index. A missing entry on one side is not
    // a frame, so a null there falls back to the other side's frame.
    const divergesAt = firstMismatch === null
      ? null
      : Math.min(firstMismatch.expected ?? Infinity, firstMismatch.actual ?? Infinity);
    alignment[name] = {
      oracle: oracle.length,
      ours: ourFrames.length,
      exact: firstMismatch === null,
      firstMismatch,
      divergesAt: Number.isFinite(divergesAt) ? divergesAt : null,
      matchedWithin3: matched,
      firstGap
    };
  }

  // One number to drive the convergence loop: the earliest frame at which ANY
  // native event stream disagrees. Reading three (now seven) separate lines
  // hid earlier signals — e.g. th7_udYo01 stage 2's contact and miss are both
  // exact while the true first break is an item collect thousands of frames
  // before the first kill mismatch.
  let earliestDivergence = null;
  for (const [name, a] of Object.entries(alignment)) {
    if (a.divergesAt === null) continue;
    if (!earliestDivergence || a.divergesAt < earliestDivergence.frame) {
      earliestDivergence = { frame: a.divergesAt, stream: name };
    }
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

  if (traceLines.length || dumped || damageLines.length) {
    mkdirSync(outDir, { recursive: true });
    if (damageLines.length) {
      const p = join(outDir, `stage${stage.stage}-damage.jsonl`);
      writeFileSync(p, damageLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      console.log(`damage trace written to ${p}`);
    }
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
  // AUX-0x04 records the original's misses frame-exactly (all.c:28596), so an
  // unexpected death is now a set difference against the recording rather
  // than the lives-arithmetic lower bound `impliedDeaths` used to supply.
  const oracleMisses = new Set(mod.auxEventFrames(stage, mod.RPY_AUX_BITS.playerMiss, auxAlignment.offset));
  const unexpectedDeaths = r.missFrames.filter((frame) => !oracleMisses.has(frame));
  const completion = { requirement: 'stageComplete', met: r.completed };
  const nativeFinalScore = !rpy.stages[i + 1] ? nativeLiveFinalScore(rpy, stage) : null;
  const metadataAdvisories = nativeFinalScore !== null && stage.scoreAtEnd !== nativeFinalScore
    ? [{
        field: 'score',
        recorded: stage.scoreAtEnd,
        nativeLive: nativeFinalScore,
        actual: actual.score,
        provenance: 'Th07.exe v1.00b PRE25779..26433, DAT_0061c258+4'
      }]
    : [];
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
    auxAlignment,
    alignment,
    earliestDivergence,
    rngBudget,
    impliedDeaths: implied,
    unexpectedDeaths,
    metadataAdvisories,
    diffs
  };
  replayReport.stages.push(stageReport);

  console.log(`\nstage ${stage.stage}: ${args.ghost ? 'GHOST (diagnostic-only)' : pass ? 'PASS' : 'FAIL'}  ` +
    `(${r.framesRun}/${r.framesAvailable} frames, ${Math.round(r.wallMs)}ms)`);
  console.log(
    auxAlignment.ambiguous
      ? `  aux alignment: AMBIGUOUS (${auxAlignment.ambiguous}) — comparing at raw indices`
      : `  aux alignment: offset ${auxAlignment.offset} ` +
        `(${auxAlignment.offset === 1 ? 'recorder-lagged' : 'recorder-synchronous'}; ` +
        `exact-prefix ${auxAlignment.prefixByOffset[0]}@0 vs ${auxAlignment.prefixByOffset[1]}@1)`
  );
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
  if (earliestDivergence) {
    console.log(
      `  EARLIEST DIVERGENCE: frame ${earliestDivergence.frame} (${earliestDivergence.stream}) ` +
        `— ${((earliestDivergence.frame / r.framesAvailable) * 100).toFixed(1)}% into the recorded stream`
    );
  }
  if (rngBudget) {
    console.log(
      `  rng draws: ours ${rngBudget.ourDraws} (≡${rngBudget.ourResidue} mod 65536), ` +
        `original ≡${rngBudget.residue} — Δresidue ${rngBudget.residue - rngBudget.ourResidue}` +
        `; bootstrap ${rngBudget.bootstrapDraws}; exact ${rngBudget.exact ? 'yes' : 'NO'}`
    );
  }
  for (const advisory of metadataAdvisories) {
    console.log(
      `  metadata advisory: ${advisory.field} recorded ${advisory.recorded}, ` +
      `native-live ${advisory.nativeLive}, ours ${advisory.actual} ` +
      `(${advisory.provenance})`
    );
  }
  if (unexpectedDeaths.length) {
    console.log(
      `  UNEXPECTED DEATHS: ${unexpectedDeaths.length} of ${r.missFrames.length} ` +
        `(recording has ${oracleMisses.size}; lives arithmetic implies ${implied ?? '?'}) — ` +
        `first at frame ${unexpectedDeaths[0]}. The original demonstrably survived ` +
        `every frame their replay shows them surviving.`
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
}

// Regression matrix. Every fidelity fix has to be re-measured against every
// available difficulty/shot-type combination — a change that converges one
// replay while moving another's exact prefix backward is a regression, not a
// fix, and only a side-by-side table makes that obvious.
if (report.replays.length > 1) {
  const stageIds = [...new Set(report.replays.flatMap((rep) => rep.stages.map((s) => s.stage)))]
    .sort((a, b) => a - b);
  const label = (rep) => `${rep.difficultyName}/${rep.character}`.padEnd(17);
  console.log('\n=== matrix (PASS, or the earliest diverging frame) ===');
  console.log(`${''.padEnd(17)}${stageIds.map((s) => `st${s}`.padStart(9)).join('')}`);
  for (const rep of report.replays) {
    const cells = stageIds.map((id) => {
      const s = rep.stages.find((st) => st.stage === id);
      if (!s) return ''.padStart(9);
      if (s.pass) return 'PASS'.padStart(9);
      return String(s.earliestDivergence ? s.earliestDivergence.frame : 'FAIL').padStart(9);
    });
    console.log(`${label(rep)}${cells.join('')}`);
  }
}

if (args.json) {
  writeFileSync(args.json, JSON.stringify(report, null, 2));
  console.log(`\nreport written to ${args.json}`);
}
process.exit(failed ? 2 : 0);
