// PERF-001 measurement harness (PLAN.md). Reads the Loop's per-frame
// update/draw cost rings via the ?test=1 hook and reports p50/p95/max per
// run, plus determinism invariants (entity counts + RNG seed at fixed
// checkpoints must match across runs).
//
// Usage:
//   node scripts/perf-probe.mjs --scenario dense-items --runs 3
//   node scripts/perf-probe.mjs --stage 3 --difficulty 3 --until first-wave-clear --runs 3
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

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

async function runOnce(runIndex) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${port}/index.html?test=1&paused=1&difficulty=${difficulty}&stage=${stage}&power=128`);
  await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 30000 });

  const result = await page.evaluate(async ({ scenario, until, warmup }) => {
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
    let frames = 0;
    if (scenario === 'dense-items') {
      T.fillItems(1100);
      T.inject(['shoot'], ['shoot']);
      for (let i = 0; i < 600; i++) { step(true); frames++; }
    } else {
      // stage-entry: advance until the first wave has spawned AND cleared
      // (enemies rose above 0 then returned to 0), or 3600 frames.
      T.inject(['shoot', 'skip'], ['shoot']);
      let seenWave = false;
      for (let i = 0; i < 3600; i++) {
        if (i % 15 === 0) T.inject(['shoot', 'skip'], ['shoot']);
        step(true);
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
  }, { scenario, until, warmup });

  await page.close();
  const u = [...result.update].sort((a, b) => a - b);
  const d = [...result.draw].sort((a, b) => a - b);
  const total = result.update.map((v, i) => v + (result.draw[i] ?? 0)).sort((a, b) => a - b);
  const stats = {
    run: runIndex,
    frames: result.frames,
    update: { p50: pct(u, 0.5), p95: pct(u, 0.95), max: u[u.length - 1] },
    draw: { p50: pct(d, 0.5), p95: pct(d, 0.95), max: d[d.length - 1] },
    total: { p50: pct(total, 0.5), p95: pct(total, 0.95), max: total[total.length - 1] },
    final: result.final,
    checkpoints: result.checkpoints,
    pageErrors: errors.slice(0, 5)
  };
  console.log(JSON.stringify(stats));
  return stats;
}

const all = [];
for (let i = 0; i < runs; i++) all.push(await runOnce(i));

// Determinism invariant: identical seeds/counts at every checkpoint. Only
// meaningful for the stage scenario (dense-items floods relative to a
// boot-jittered frame). The final frame count varies by a few boot rAF
// ticks; checkpoints are indexed from the scenario start and must match.
const keys = all.map((r) => JSON.stringify(r.checkpoints));
const deterministic = scenario === 'dense-items' ? true : keys.every((k) => k === keys[0]);
const p95s = all.map((r) => r.total.p95);
console.log('SUMMARY', JSON.stringify({
  scenario, stage, difficulty, runs,
  deterministic,
  totalP95: { min: Math.min(...p95s), max: Math.max(...p95s) },
  worstFrame: Math.max(...all.map((r) => r.total.max)),
  pageErrors: all.flatMap((r) => r.pageErrors).length
}));
await browser.close();
server.close();
process.exit(deterministic ? 0 : 4);
