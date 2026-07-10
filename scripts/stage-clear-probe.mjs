// Long-run stage-clear probe for data-driven stage progression.
// Usage:
//   node scripts/stage-clear-probe.mjs [stage=1] [difficulty=3] [maxFrames=20000] [outDir=/tmp/stage-probes] [shot=reimuA]
// Holds shoot, refreshes lives/invuln every 60 frames, dumps snapshots +
// screenshots at interesting milestones until stageClear or maxFrames.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const stage = Number(process.argv[2] ?? 1);
const difficulty = Number(process.argv[3] ?? 3);
const maxFrames = Number(process.argv[4] ?? 20000);
const outDir = process.argv[5] ?? `/tmp/stage-probes/s${stage}-d${difficulty}`;
const shotType = process.argv[6] ?? 'reimuA';
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.map': 'application/json'
};

await mkdir(outDir, { recursive: true });
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
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const errors = [];
const unhandledOps = new Set();
page.on('pageerror', (e) => errors.push(String(e).slice(0, 240)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errors.push(t.slice(0, 240));
  const um = /unhandled ECL op (\d+)/i.exec(t);
  if (um) unhandledOps.add(Number(um[1]));
  if (/unhandled|warn/i.test(t) && /ECL|op /i.test(t)) {
    // keep a short trail of ECL warnings for diagnosis
    if (errors.length < 40) errors.push(`[console] ${t.slice(0, 200)}`);
  }
});

const query = `difficulty=${difficulty}&stage=${stage}&power=128&shot=${shotType}`;
await page.goto(`http://127.0.0.1:${port}/index.html?test=1&${query}`);
await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 30000 });
await page.evaluate(() => window.__TH07_TEST__.pause());

const milestones = new Set([200, 800, 2500, 4000, 5600, 7000, 9000, 12000, 15000, 18000]);
const log = [];
let lastBoss = false;
let maxLasers = 0;
let clearFrame = null;
let captureMatchesPreviousFrame = null;
const presentation = [];
let done = 0;

while (done < maxFrames) {
  const n = Math.min(30, maxFrames - done);
  // Refresh godmode every 60 frames so late-stage content is reachable.
  if (done % 60 === 0) {
    await page.evaluate(() => {
      window.__TH07_TEST__.setLives(8);
      window.__TH07_TEST__.setInvuln(300);
    });
  }
  // Dialogue waits advance on a Z *press edge* after 12 frames (all.c
  // 17849-17858) — a held-only inject never skips them, so post-boss
  // 300/900/1200-frame tails would stall the clear probe. Fire a press
  // edge every 15 frames (and hold skip/CTRL for skippable waits).
  // Also pump damageBoss while a boss is registered so off-screen
  // controller bosses (stage 4 slot-0) and high-HP late phases die under
  // the probe's time budget.
  const batch = await page.evaluate(({ n }) => {
    let clearEdge = null;
    for (let i = 0; i < n; i++) {
      const edge = i % 15 === 0 ? ['shoot'] : [];
      window.__TH07_TEST__.inject(['shoot', 'skip'], edge);
      const snap = window.__TH07_TEST__.snapshot();
      if (snap.bossActive) window.__TH07_TEST__.damageBoss(300);
      const beforePixel = window.__TH07_TEST__.pixelAt(200, 200);
      window.__TH07_TEST__.advance(1);
      const after = window.__TH07_TEST__.snapshot();
      if (!snap.stageClear && after.stageClear) {
        clearEdge = {
          beforePixel,
          capturedPixel: window.__TH07_TEST__.capturePixel(296, 184)
        };
        return { advanced: i + 1, clearEdge };
      }
    }
    return { advanced: n, clearEdge };
  }, { n });
  done += batch.advanced;

  const frame = done;
  const snap = await page.evaluate(() => window.__TH07_TEST__.snapshot());
  maxLasers = Math.max(maxLasers, Number(snap.lasers ?? 0));

  const bossNow = !!snap.bossActive;
  const interesting =
    milestones.has(frame) ||
    (bossNow && !lastBoss) ||
    (!bossNow && lastBoss) ||
    snap.stageClear ||
    (frame % 2000 === 0);
  lastBoss = bossNow;

  if (interesting) {
    const shot = join(outDir, `f${String(frame).padStart(5, '0')}.png`);
    await page.screenshot({ path: shot });
    const row = {
      frame,
      stageClear: !!snap.stageClear,
      boss: bossNow,
      bossHp: snap.bossHp ?? null,
      spell: snap.spellName ?? null,
      enemies: snap.enemies,
      bullets: snap.bullets,
      lasers: snap.lasers,
      score: snap.score,
      player: snap.player,
      timelines: snap.timelines,
      enemyDump: snap.enemyDump
    };
    log.push(row);
    console.log(JSON.stringify(row));
  }

  if (snap.stageClear) {
    clearFrame = frame;
    captureMatchesPreviousFrame =
      JSON.stringify(batch.clearEdge?.beforePixel) === JSON.stringify(batch.clearEdge?.capturedPixel);
    const shot = join(outDir, `clear-f${frame}.png`);
    await page.screenshot({ path: shot });
    presentation.push({ offset: 0, timer: snap.stageClearTimer, state: snap.clearPresentation });
    let age = 0;
    for (const target of [1, 30, 61]) {
      await page.evaluate((frames) => {
        for (let i = 0; i < frames; i++) {
          window.__TH07_TEST__.inject([], []);
          window.__TH07_TEST__.advance(1);
        }
      }, target - age);
      age = target;
      const state = await page.evaluate(() => window.__TH07_TEST__.snapshot());
      const file = join(outDir, `clear-plus-${String(target).padStart(2, '0')}.png`);
      await page.screenshot({ path: file });
      presentation.push({
        offset: target,
        timer: state.stageClearTimer,
        state: state.clearPresentation,
        samples: {
          loading: await page.evaluate(() => window.__TH07_TEST__.pixelAt(380, 420)),
          inset: await page.evaluate(() => window.__TH07_TEST__.pixelAt(100, 200))
        }
      });
    }
    break;
  }
}

const summary = {
  stage,
  difficulty,
  shotType,
  clearFrame,
  captureMatchesPreviousFrame,
  presentation,
  maxLasers,
  unhandledOps: [...unhandledOps].sort((a, b) => a - b),
  pageErrors: errors.slice(0, 10),
  milestones: log
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('SUMMARY', JSON.stringify({
  stage, difficulty, shotType, clearFrame, captureMatchesPreviousFrame, maxLasers,
  unhandledOps: summary.unhandledOps,
  pageErrors: summary.pageErrors.length
}));

await browser.close();
server.close();
process.exit(clearFrame == null ? 2 : 0);
