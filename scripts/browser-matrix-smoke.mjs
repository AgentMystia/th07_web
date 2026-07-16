// Cross-engine boot smoke for the default-on low-latency canvas.
// Pass 1 (real player path): boot with no desync param and assert the
// engine-appropriate outcome — Chromium may grant desynchronized (then the
// backbuffer path runs); Firefox/WebKit must feature-detect to the direct
// path (no backbuffer, no behavior change) with a healthy presented frame.
// Pass 2 (&backbuffer=1): force the backbuffer + present() path on engines
// that never grant desync, proving present() parity on Gecko/WebKit
// rasterizers, not just Chromium.
//
// Local-only (CI stays chromium-only): Firefox/WebKit need a one-time
//   npx playwright install firefox webkit
// Usage: node scripts/browser-matrix-smoke.mjs [--browser firefox|webkit|chromium]
import { chromium, firefox, webkit } from '@playwright/test';
import { attachPageDiagnostics, resolveChromiumExecutable, startStaticServer, uniqueErrors } from './lib/browser-harness.mjs';

const args = process.argv.slice(2);
const browserArg = args[args.indexOf('--browser') + 1];
const engineName = args.includes('--browser') ? browserArg : 'firefox';
const engines = { chromium, firefox, webkit };
const engine = engines[engineName];
if (!engine) {
  console.error('usage: node scripts/browser-matrix-smoke.mjs [--browser firefox|webkit|chromium]');
  process.exit(2);
}

const FRAME_POINTS = [[16, 240], [624, 240]]; // static frame art, healthy ≈ #400e20

const server = await startStaticServer();
let failures = 0;

const runPass = async (label, extraQuery, expectations) => {
  const browser = await engine.launch(
    engineName === 'chromium' ? { executablePath: resolveChromiumExecutable() } : {}
  );
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const pageErrors = attachPageDiagnostics(page);
  try {
    await page.goto(`${server.baseUrl}/index.html?test=1${extraQuery}`);
    await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 30000 });
    const result = await page.evaluate((framePoints) => {
      const t = window.__TH07_TEST__;
      t.advance(300);
      return {
        canvas: t.canvasContextAttributes(),
        enemies: t.snapshot().enemies,
        framePixels: framePoints.map(([x, y]) => t.displayPixelAt(x, y))
      };
    }, FRAME_POINTS);
    const errors = uniqueErrors(pageErrors);
    const presentedBlack = result.framePixels.every((px) => px[0] + px[1] + px[2] <= 24);
    const problems = [];
    if (errors.length) problems.push(`pageErrors: ${JSON.stringify(errors.slice(0, 3))}`);
    if (presentedBlack) problems.push(`presented frame black: ${JSON.stringify(result.framePixels)}`);
    if (!(result.enemies >= 1)) problems.push(`no enemies spawned (${result.enemies})`);
    for (const [key, expected] of Object.entries(expectations)) {
      const actual = key === 'granted' ? (result.canvas?.actual?.desynchronized ?? false) : result.canvas?.[key];
      if (actual !== expected) problems.push(`${key}: expected ${expected}, got ${actual}`);
    }
    console.log(`${engineName} ${label}: canvas=${JSON.stringify(result.canvas)} enemies=${result.enemies}`);
    if (problems.length) {
      failures++;
      console.error(`${engineName} ${label} FAILED: ${problems.join('; ')}`);
    } else {
      console.log(`${engineName} ${label} PASS`);
    }
  } finally {
    await browser.close();
  }
};

try {
  // Pass 1: shipped defaults. Non-Chromium engines must not grant desync
  // and must run the direct path.
  await runPass(
    'default',
    '',
    engineName === 'chromium' ? {} : { granted: false, backBuffered: false }
  );
  // Pass 2: forced backbuffer — present() must deliver frames on this
  // engine's rasterizer exactly like the Chromium desync path.
  await runPass('backbuffer', '&backbuffer=1', { backBuffered: true });
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await server.close();
}
process.exitCode = failures ? 4 : 0;
