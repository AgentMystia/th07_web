// T7RP replay metadata inspector (Replay Golden workflow, M1).
//
// Prints the decoded global header and per-stage sub-headers of one or more
// TH07 .rpy files — the first sanity gate before feeding a replay to the
// headless verifier. Field semantics: reference/re-specs/exe-replay.md.
//
// Usage:
//   node scripts/replay-inspect.mjs [file.rpy ...]
// Defaults to tests/replays/*.rpy plus the local-only reference demo replays
// when no files are given.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const outDir = 'tests/.build/replay-inspect';
mkdirSync(outDir, { recursive: true });
execSync(
  `npx esbuild src/formats/rpy.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`
);
const { Rpy } = await import(`../${outDir}/rpy.mjs`);

const DIFFICULTIES = ['Easy', 'Normal', 'Hard', 'Lunatic', 'Extra'];

function defaultFiles() {
  const files = [];
  const dirs = ['tests/replays', 'reference/th07-original'];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.rpy')) files.push(join(dir, f));
    }
  }
  return files;
}

const files = process.argv.length > 2 ? process.argv.slice(2) : defaultFiles();
if (!files.length) {
  console.error('no .rpy files found');
  process.exit(1);
}

let failed = false;
for (const file of files) {
  console.log(`=== ${file} ===`);
  let rpy;
  try {
    rpy = new Rpy(readFileSync(file));
  } catch (err) {
    console.log(`  PARSE FAILED: ${err.message}`);
    failed = true;
    continue;
  }
  console.log(
    `  ${rpy.character}  ${DIFFICULTIES[rpy.difficulty] ?? `diff=${rpy.difficulty}`}  ` +
      `date=${rpy.date}  name="${rpy.name}"  score=${rpy.score * 10} (raw ${rpy.score})`
  );
  for (const s of rpy.stages) {
    const mins = (s.inputs.length / 60 / 60).toFixed(2);
    console.log(
      `  stage ${s.stage}: ${s.inputs.length} frames (${mins} min)  seed=0x${s.rngSeed
        .toString(16)
        .padStart(4, '0')}  rankByte=${s.rankByte}`
    );
    console.log(
      `    scoreAtEnd=${s.scoreAtEnd} points=${s.pointItems} cherry=${s.cherry}/${s.cherryMax}+${s.cherryPlus} ` +
        `graze=${s.graze} extend=${s.extendLevel}@${s.extendThreshold} power=${s.power} lives=${s.lives} ` +
        `bombs=${s.bombs} spells=${s.spellsCaptured} b26=${s.b26}`
    );
    // Input-word histogram (top 8) — quick eyeball that bit semantics hold.
    const hist = new Map();
    for (const w of s.inputs) hist.set(w, (hist.get(w) ?? 0) + 1);
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(
      `    top input words: ${top.map(([w, n]) => `0x${w.toString(16)}×${n}`).join(' ')} (${hist.size} distinct)`
    );
  }
}
process.exit(failed ? 1 : 0);
