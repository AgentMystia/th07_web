// Stage-5 spell-card presentation gate for the default-on desynchronized
// canvas. The 8552afe regression ("spell background turns the whole screen
// invisible/flickering") came from incremental draws on a desynchronized
// front buffer; the renderer now finishes frames on a backbuffer and
// present() copies them in one op. This probe reaches a real Stage-5 spell
// card, lets the real rAF loop present live, and gates on the PRESENTED
// canvas pixels (displayPixelAt) — the persistent-black failure class.
//
// Honesty note: getImageData and page.screenshot read the logical canvas,
// not display scanout, so no readback can prove transient scanout flicker
// absent — the manual Stage-5 eyeball check in AGENTS.md remains part of
// acceptance. What this probe DOES catch: a present() regression, a black
// or stale presented frame, page errors, and any pixel divergence class.
//
// Usage: node scripts/desync-stage5-probe.mjs
//          [--desync 0|1] [--backbuffer] [--headed] [--require-desync]
// Exits: 0 ok; 2 never reached a spell card (diagnostic); 3 --require-desync
// but the browser did not grant it; 4 page errors; 5 black presented frame.
import { attachPageDiagnostics, launchChromium, startStaticServer, uniqueErrors } from './lib/browser-harness.mjs';
import { readPixelStats } from './lib/pixel-stats.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const desyncArg = valueOf('--desync');
const headed = has('--headed');
const requireDesync = has('--require-desync');

const query =
  '?test=1&paused=1&stage=5&difficulty=1' +
  (desyncArg != null ? `&desync=${desyncArg}` : '') +
  (has('--backbuffer') ? '&backbuffer=1' : '');

const FAST_FORWARD_CAP = 12000;
const CHUNK = 120;
// Presented-canvas sample points (backing-store 640×480 coordinates).
// Frame art at x=16/x=624 is static (healthy ≈ #400e20) — if BOTH read
// near-black the presented frame is blank regardless of spell art. The five
// playfield points cover center + inset corners; the spell background
// (scrolling eff01 sheet) keeps at least one of them lit.
const FRAME_POINTS = [[16, 240], [624, 240]];
const PLAYFIELD_POINTS = [[224, 240], [64, 48], [380, 48], [64, 430], [380, 430]];
const SAMPLES = 30;
const SAMPLE_INTERVAL_MS = 100;
const NEAR_BLACK = 24; // r+g+b at or below this counts as black

const server = await startStaticServer();
const browser = await launchChromium({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const pageErrors = attachPageDiagnostics(page);

try {
  await page.goto(`${server.baseUrl}/index.html${query}`);
  await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 30000 });

  const canvas = await page.evaluate(() => window.__TH07_TEST__.canvasContextAttributes());
  const granted = canvas?.actual?.desynchronized ?? false;
  console.log('canvas:', JSON.stringify(canvas));
  if (requireDesync && !granted) {
    console.error('desynchronized was not granted in this environment (--require-desync)');
    process.exitCode = 3;
    throw new Error('halt');
  }

  // Fast-forward (paused, synchronous advance) to a boss spell card. One
  // shoot press-edge per chunk advances dialogue lines; held shoot damages
  // the (mid)boss so a spell declares without scripted damage overshoot.
  let frames = 0;
  let snap = null;
  while (frames < FAST_FORWARD_CAP) {
    await page.evaluate((n) => {
      const t = window.__TH07_TEST__;
      t.setLives(9);
      t.setInvuln(100000);
      t.clearInput();
      t.inject(['shoot'], ['shoot']);
      t.advance(n);
    }, CHUNK);
    frames += CHUNK;
    snap = await page.evaluate(() => window.__TH07_TEST__.snapshot());
    if (snap.bossActive && snap.spellName) break;
    if (snap.bossActive) await page.evaluate(() => window.__TH07_TEST__.damageBoss(150));
  }
  if (!snap?.bossActive || !snap?.spellName) {
    console.error(`no spell card within ${FAST_FORWARD_CAP} frames`, JSON.stringify({ frame: snap?.frame, bossActive: snap?.bossActive, spellName: snap?.spellName }));
    process.exitCode = 2;
    throw new Error('halt');
  }
  console.log(`spell reached at frame ${snap.frame}: ${JSON.stringify(snap.spellName)}`);

  // Live presentation: restart the real rAF loop and sample the presented
  // canvas while the spell background animates.
  await page.evaluate(() => {
    const t = window.__TH07_TEST__;
    t.clearInput();
    t.setInvuln(100000);
    t.resume();
  });

  // A persistent all-black presented canvas is the real failure class; a
  // single transient dark frame (spell-portrait fade, a dark band of the
  // scrolling sheet) is normal. So require a RUN of consecutive fully-blank
  // samples (both static frame-art points AND all playfield points dark) to
  // count as black — a momentary dark frame resets the run.
  const PERSISTENT_BLACK_RUN = 3; // ~300ms of solid black = persistent
  let blackPresents = 0;
  let consecutiveBlack = 0;
  let maxBlackRun = 0;
  let persistent = false;
  let spellHeld = 0;
  const screenshots = [];
  for (let i = 0; i < SAMPLES; i++) {
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
    const sample = await page.evaluate(({ framePoints, playfieldPoints }) => {
      const t = window.__TH07_TEST__;
      return {
        frame: t.snapshot().frame,
        spellName: t.snapshot().spellName,
        framePixels: framePoints.map(([x, y]) => t.displayPixelAt(x, y)),
        playfieldPixels: playfieldPoints.map(([x, y]) => t.displayPixelAt(x, y))
      };
    }, { framePoints: FRAME_POINTS, playfieldPoints: PLAYFIELD_POINTS });
    const sum = (px) => px[0] + px[1] + px[2];
    // Fully blank: static frame art is dark too (≈ #400e20 → 0x40=64 > NEAR_BLACK
    // when healthy), so its presence rules out a merely-dark playfield.
    const fullyBlank =
      sample.framePixels.every((px) => sum(px) <= NEAR_BLACK) &&
      sample.playfieldPixels.every((px) => sum(px) <= NEAR_BLACK);
    if (fullyBlank) {
      consecutiveBlack++;
      blackPresents++;
      maxBlackRun = Math.max(maxBlackRun, consecutiveBlack);
      if (consecutiveBlack >= PERSISTENT_BLACK_RUN) persistent = true;
      console.error(`sample ${i}: black presented frame (run ${consecutiveBlack})`);
    } else {
      consecutiveBlack = 0;
    }
    if (sample.spellName) spellHeld++;
    if (i === 0 || i === SAMPLES - 1) {
      const path = `/tmp/th07-desync-stage5-${i === 0 ? 'first' : 'last'}.png`;
      await page.screenshot({ path });
      screenshots.push(path);
    }
  }
  await page.evaluate(() => window.__TH07_TEST__.pause());

  // Screenshot statistics: authoritative for the non-granted arm; on a
  // granted context headless capture may bypass the compositor, so treat
  // blackness there as a warning for manual eyeballing, not a failure.
  const shotStats = screenshots.map((path) => {
    const { regions } = readPixelStats(path, ['32,16,384,448:playfield', '4,200,24,60:frame-left', '612,200,24,60:frame-right']);
    return { path, playfield: regions.playfield, frameLeft: regions['frame-left'], frameRight: regions['frame-right'] };
  });
  for (const stat of shotStats) {
    console.log(`shot ${stat.path}: playfield brightness ${stat.playfield?.brightness?.toFixed(1)} texture ${stat.playfield?.texture?.toFixed(1)}% frames ${stat.frameLeft?.brightness?.toFixed(1)}/${stat.frameRight?.brightness?.toFixed(1)}`);
  }
  const shotsBlack = shotStats.some((stat) => (stat.playfield?.brightness ?? 0) < 4 && (stat.frameLeft?.brightness ?? 0) < 4);

  const errors = uniqueErrors(pageErrors);
  const report = {
    granted,
    backBuffered: canvas?.backBuffered ?? false,
    spellFrames: `${spellHeld}/${SAMPLES}`,
    blackPresents,
    maxBlackRun,
    persistentBlack: persistent,
    shotsBlack,
    pageErrors: errors
  };
  console.log(JSON.stringify(report));

  if (errors.length) process.exitCode = 4;
  else if (persistent) process.exitCode = 5;
  else if (shotsBlack && !granted) process.exitCode = 5;
  else if (shotsBlack && granted) {
    console.warn('WARNING: screenshots read black while presented pixels are healthy — headless capture may bypass the compositor on a desynchronized canvas; manual eyeball required.');
  }
  if (spellHeld === 0) {
    // The spell ended before sampling began — pixels were gated against the
    // wrong scene; rerun rather than trust the result.
    console.error('spell card did not persist through the sampling window');
    process.exitCode = process.exitCode || 2;
  }
} catch (err) {
  if (err?.message !== 'halt') {
    console.error(err);
    process.exitCode = process.exitCode || 1;
  }
} finally {
  await browser.close();
  await server.close();
}
