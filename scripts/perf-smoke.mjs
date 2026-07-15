import { attachPageDiagnostics, launchChromium, startStaticServer, uniqueErrors } from './lib/browser-harness.mjs';

const server = await startStaticServer();
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const errors = attachPageDiagnostics(page);
const client = await page.context().newCDPSession(page);
await client.send('Emulation.setCPUThrottlingRate', { rate: 2 });

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

try {
  await page.goto(`${server.baseUrl}/index.html?test=1&perf=1&difficulty=3&power=128`);
  await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 30000 });
  await page.waitForFunction(() => window.__TH07_TEST__.snapshot().frame >= 120, null, { timeout: 30000 });
  await page.evaluate(() => {
    window.__TH07_TEST__.fillItems(1100);
    window.__TH07_TEST__.inject(['shoot'], ['shoot']);
  });
  const start = await page.evaluate(() => window.__TH07_TEST__.snapshot().frame);
  await page.waitForFunction((frame) => window.__TH07_TEST__.snapshot().frame >= frame + 600, start, { timeout: 30000 });
  const costs = await page.evaluate(() => window.__TH07_TEST__.frameCost());
  const update = costs.update.slice(120);
  const draw = costs.draw.slice(120);
  const total = update.map((value, index) => value + (draw[index] ?? 0));
  const report = {
    metric: 'real-loop paced throughput',
    cpuThrottle: 2,
    update: summarize(update),
    draw: summarize(draw),
    total: summarize(total),
    pageErrors: uniqueErrors(errors)
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.pageErrors.length || report.total.p99 > 16 || report.total.dropRate > 0.001) process.exitCode = 4;
} finally {
  await browser.close();
  await server.close();
}

