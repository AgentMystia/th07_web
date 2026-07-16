// Real-loop throughput + presentation-cadence smoke under CPU throttle 2x.
//
// Two arms by default:
//   1. shipped default (desync on where granted) — gated on rAF CADENCE:
//      with the backbuffer active, present() forces the scene's batched
//      raster to flush synchronously inside the timed draw callback, so the
//      cost ring counts work that otherwise runs after the callback. That
//      inflates draw numbers without changing real frame delivery — the
//      honest FPS-drop signal for players is vsync tick regularity.
//   2. desync=0 control — gated on the cost rings (game-code cost,
//      like-for-like with the historical p99<=16ms / dropRate<=0.001 gate).
// Passing an explicit query (e.g. `npm run perf:smoke -- desync=0`) runs
// only that arm: cadence gate always, cost-ring gate when not backbuffered.
import { attachPageDiagnostics, launchChromium, startStaticServer, uniqueErrors } from './lib/browser-harness.mjs';

const explicitQuery = process.argv[2] != null ? `&${process.argv[2].replace(/^&/, '')}` : null;

const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return {
    samples: sorted.length,
    p50: pick(0.50),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted.at(-1) ?? 0,
    dropRate: sorted.length ? sorted.filter((value) => value > 1000 / 60).length / sorted.length : 1
  };
};

const server = await startStaticServer();
const browser = await launchChromium();
let failed = false;

async function runArm(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = attachPageDiagnostics(page);
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 2 });
  try {
    await page.goto(`${server.baseUrl}/index.html?test=1&perf=1&difficulty=3&power=128${query}`);
    await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 30000 });
    await page.waitForFunction(() => window.__TH07_TEST__.snapshot().frame >= 120, null, { timeout: 30000 });
    await page.evaluate(() => {
      window.__TH07_TEST__.fillItems(1100);
      window.__TH07_TEST__.inject(['shoot'], ['shoot']);
    });
    // Record vsync tick intervals while the real loop runs the dense
    // scenario; the sim advances ~600 frames during collection.
    const cadence = await page.evaluate(async () => {
      const intervals = [];
      let last = null;
      const startFrame = window.__TH07_TEST__.snapshot().frame;
      await new Promise((resolve) => {
        const tick = (time) => {
          if (last != null) intervals.push(time - last);
          last = time;
          if (intervals.length >= 600) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { intervals, frames: window.__TH07_TEST__.snapshot().frame - startFrame };
    });
    const costs = await page.evaluate(() => window.__TH07_TEST__.frameCost());
    const canvas = await page.evaluate(() => window.__TH07_TEST__.canvasContextAttributes());
    const update = costs.update.slice(120);
    const draw = costs.draw.slice(120);
    const total = update.map((value, index) => value + (draw[index] ?? 0));
    const cadenceStats = summarize(cadence.intervals);
    const over25ms = cadence.intervals.filter((value) => value > 25).length;
    const report = {
      metric: 'real-loop paced throughput + presentation cadence',
      arm: query || '(default)',
      cpuThrottle: 2,
      canvas,
      cadence: { ...cadenceStats, dropRate: undefined, over25ms, simFrames: cadence.frames },
      update: summarize(update),
      draw: summarize(draw),
      total: summarize(total),
      pageErrors: uniqueErrors(errors)
    };
    console.log(JSON.stringify(report, null, 2));

    const problems = [];
    if (report.pageErrors.length) problems.push('page errors');
    // Presentation gate (all arms): vsync ticks must stay regular. 17.5ms
    // allows headless timestamp jitter above the 16.7ms period; a >25ms
    // gap is a visibly dropped frame.
    if (cadenceStats.p99 > 17.5) problems.push(`cadence p99 ${cadenceStats.p99.toFixed(1)}ms > 17.5ms`);
    if (over25ms > 0) problems.push(`${over25ms} vsync gaps > 25ms`);
    // Game-code cost gate: only meaningful without the backbuffer flush in
    // the ring (see header comment).
    if (!canvas.backBuffered) {
      if (report.total.p99 > 16) problems.push(`total p99 ${report.total.p99.toFixed(1)}ms > 16ms`);
      if (report.total.dropRate > 0.001) problems.push(`cost dropRate ${report.total.dropRate}`);
    }
    if (problems.length) {
      failed = true;
      console.error(`perf-smoke arm '${report.arm}' FAILED: ${problems.join('; ')}`);
    }
  } finally {
    await page.close();
  }
}

try {
  if (explicitQuery != null) await runArm(explicitQuery);
  else {
    await runArm('');
    await runArm('&desync=0');
  }
  if (failed) process.exitCode = 4;
} finally {
  await browser.close();
  await server.close();
}
