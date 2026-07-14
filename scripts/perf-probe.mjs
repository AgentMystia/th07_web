// PERF-001 measurement harness. Reads the Loop's per-frame update/draw cost
// rings via the ?test=1 hook and reports p50/p95/p99/max + drop-rate per run,
// plus determinism invariants (entity counts + RNG seed at fixed checkpoints
// must match across runs). Supports CPU throttling (CDP) to emulate "half the
// machine's compute", and a --baseline mode that captures rate 1 & 2 to a JSON.
//
// Usage:
//   node scripts/perf-probe.mjs --scenario dense-items --runs 3
//   node scripts/perf-probe.mjs --stage 3 --difficulty 3 --until first-wave-clear --runs 3
//   node scripts/perf-probe.mjs --throttle 2 --runs 3            # half-speed
//   node scripts/perf-probe.mjs --scenario dense-items --baseline              # writes scripts/perf-baseline.json
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const FRAME_BUDGET_MS = 1000 / 60; // 16.667 — a logical tick is "dropped" if it exceeds this

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[m[1]] = true;
    else { args[m[1]] = next; i++; }
  }
  return args;
}
const args = parseArgs(process.argv);
const scenario = args.scenario ?? (args.stage ? 'stage-entry' : 'dense-items');
const stage = Number(args.stage ?? 1);
const difficulty = Number(args.difficulty ?? 3);
const runs = Number(args.runs ?? 3);
const until = args.until ?? null;
const throttle = Number(args.throttle ?? 1);
const baseline = !!args.baseline;
const paced = !!args.paced; // rAF-paced: advance(1) per rAF (real-game cadence + idle GC time)
const warmup = 120; // frames dropped from stats (JIT/decoder warmup)

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.map': 'application/json'
};
const root = new URL('..', import.meta.url).pathname;
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const data = await readFile(join(root, p));
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
});

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const summarize = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const max = s[s.length - 1];
  const dropped = s.filter((v) => v > FRAME_BUDGET_MS).length;
  return {
    p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), max,
    dropRate: +(dropped / s.length).toFixed(6), samples: s.length
  };
};

async function runOnce(runIndex, rate) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  // CPU throttle emulates "the machine running at 1/rate of its speed".
  if (rate > 1) {
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setCPUThrottlingRate', { rate });
  }
  await page.goto(`http://127.0.0.1:${port}/index.html?test=1&paused=1&difficulty=${difficulty}&stage=${stage}&power=128`);
  await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 30000 });

  const result = await page.evaluate(async ({ scenario, until, warmup, paced }) => {
    const T = window.__TH07_TEST__;
    const costs = { update: [], draw: [] };
    const checkpoints = [];
    const drain = () => {
      const c = T.frameCost();
      costs.update.push(...c.update.slice(-1));
      costs.draw.push(...c.draw.slice(-1));
    };
    const step = (godmode) => {
      if (godmode) { T.setLives(8); T.setInvuln(300); }
      T.advance(1);
      drain();
    };
    // rAF-paced wrapper: yields between frames so V8 can run incremental GC
    // during idle (as in the real game) instead of one stop-the-world pause.
    const rafWait = () => new Promise((res) => requestAnimationFrame(() => res()));
    const stepPaced = async (godmode) => { await rafWait(); step(godmode); };
    const doStep = paced ? stepPaced : async (g) => step(g);
    let frames = 0;
    if (scenario === 'dense-items') {
      T.fillItems(1100);
      T.inject(['shoot'], ['shoot']);
      for (let i = 0; i < 600; i++) { await doStep(true); frames++; }
    } else {
      T.inject(['shoot', 'skip'], ['shoot']);
      let seenWave = false;
      for (let i = 0; i < 3600; i++) {
        if (i % 15 === 0) T.inject(['shoot', 'skip'], ['shoot']);
        await doStep(true);
        frames++;
        const s = T.snapshot();
        if (i === 300 || i === 600 || i === 900) {
          checkpoints.push({ f: i, enemies: s.enemies, bullets: s.bullets, items: s.items, rngSeed: s.rngSeed });
        }
        if (until === 'first-wave-clear') {
          if (s.enemies > 0) seenWave = true;
          else if (seenWave && s.enemies === 0 && i > 120) break;
        }
      }
    }
    const snap = T.snapshot();
    return {
      frames,
      update: costs.update.slice(warmup),
      draw: costs.draw.slice(warmup),
      checkpoints,
      final: { enemies: snap.enemies, bullets: snap.bullets, items: snap.items, rngSeed: snap.rngSeed, frame: snap.frame }
    };
  }, { scenario, until, warmup, paced });

  await page.close();
  const total = result.update.map((v, i) => v + (result.draw[i] ?? 0));
  const stats = {
    run: runIndex,
    rate,
    frames: result.frames,
    update: summarize(result.update),
    draw: summarize(result.draw),
    total: summarize(total),
    final: result.final,
    checkpoints: result.checkpoints,
    pageErrors: errors.slice(0, 5)
  };
  console.log(JSON.stringify(stats));
  return stats;
}

function summarizeRuns(all, rate) {
  const keys = all.map((r) => JSON.stringify(r.checkpoints));
  const deterministic = scenario === 'dense-items' ? true : keys.every((k) => k === keys[0]);
  // Take the WORST (max) per-run p99/dropRate across runs — the binding number.
  const agg = (field) => ({
    p50: Math.max(...all.map((r) => r[field].p50)),
    p95: Math.max(...all.map((r) => r[field].p95)),
    p99: Math.max(...all.map((r) => r[field].p99)),
    max: Math.max(...all.map((r) => r[field].max)),
    dropRate: Math.max(...all.map((r) => r[field].dropRate))
  });
  return {
    rate, runs: all.length, deterministic,
    update: agg('update'), draw: agg('draw'), total: agg('total'),
    pageErrors: all.flatMap((r) => r.pageErrors).length
  };
}

let ok = true;
if (baseline) {
  // Capture both rates for the DoD baseline.
  const rates = {};
  for (const rate of [1, 2]) {
    const all = [];
    for (let i = 0; i < runs; i++) all.push(await runOnce(i, rate));
    rates[rate] = summarizeRuns(all, rate);
    if (!rates[rate].deterministic) ok = false;
  }
  const out = {
    capturedAt: new Date().toISOString(),
    scenario, stage, difficulty, runs, frameBudgetMs: FRAME_BUDGET_MS,
    rates,
    // DoD targets for reference
    targets: { halfSpeedUpdateP99Ms: 16.0, halfSpeedDropRate: 0.001 }
  };
  const path = join(root, 'scripts', 'perf-baseline.json');
  await writeFile(path, JSON.stringify(out, null, 2));
  console.log('BASELINE_WRITTEN', path);
  console.log(JSON.stringify(out, null, 2));
} else {
  const all = [];
  for (let i = 0; i < runs; i++) all.push(await runOnce(i, throttle));
  const s = summarizeRuns(all, throttle);
  if (!s.deterministic) ok = false;
  console.log('SUMMARY', JSON.stringify({ scenario, stage, difficulty, runs, throttle, ...s }));
}

await browser.close();
server.close();
// Exit non-zero if any run was non-deterministic (anomaly guard: catches
// iteration-order / RNG drift introduced by a perf change).
process.exit(ok ? 0 : 4);
