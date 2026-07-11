// Deterministic issue-reproduction probe (PLAN.md Phase 0).
//
// Drives a stage headlessly to a target boss spell (by global spell id) and
// captures full snapshots at phase-relative frame offsets (spell.declAge),
// without relying on a human pausing at the right moment. Only works against
// the ?test=1 hook; shipped gameplay is untouched.
//
// Usage:
//   node scripts/issue-probe.mjs --stage 2 --difficulty 3 --shot reimuA \
//     --spell 17 --offsets 219,220,221 [--power 128] [--player-path left|center|right]
//     [--budget 30000] [--out /tmp/issue-probes] [--screenshot]
//
// Without --spell, --offsets are absolute stageFrame values (stage-opener
// probes). Exit codes: 0 ok, 2 target spell never declared within budget,
// 3 spell ended before the last requested offset.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m) continue;
    const key = m[1];
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

const args = parseArgs(process.argv);
const stage = Number(args.stage ?? 1);
const difficulty = Number(args.difficulty ?? 3);
const shot = args.shot ?? 'reimuA';
const power = Number(args.power ?? 128);
const spellId = args.spell !== undefined ? Number(args.spell) : null;
const offsets = String(args.offsets ?? '0').split(',').map(Number).sort((a, b) => a - b);
const budget = Number(args.budget ?? 30000);
const playerPath = args['player-path'] ?? null;
const outDir = args.out ?? `/tmp/issue-probes/s${stage}-d${difficulty}-${spellId !== null ? `spell${spellId}` : 'frames'}${playerPath ? `-${playerPath}` : ''}`;
const takeShots = !!args.screenshot;

// Fixed pin positions in playfield coordinates (field is 384x448).
const PIN_X = { left: 96, center: 192, right: 288 };
const pinX = playerPath ? PIN_X[playerPath] : null;
if (playerPath && pinX === undefined) {
  console.error(`unknown --player-path ${playerPath} (left|center|right)`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.map': 'application/json'
};
const root = new URL('..', import.meta.url).pathname;
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
page.on('pageerror', (e) => errors.push(String(e).slice(0, 240)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 240));
});

await page.goto(`http://127.0.0.1:${port}/index.html?test=1&difficulty=${difficulty}&stage=${stage}&power=${power}&shot=${shot}`);
await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 30000 });
await page.evaluate(() => window.__TH07_TEST__.pause());

// Phase 1 (seek): hold shoot/skip with periodic press edges (dialogue waits
// need Z edges), refresh godmode, and burn boss HP — but stop the instant the
// target spell is declared so its own timing is unperturbed. All per-frame
// checks run browser-side; the batch returns early on declaration.
async function seek() {
  let done = 0;
  while (done < budget) {
    const batch = await page.evaluate(({ n, spellId, pinX }) => {
      const T = window.__TH07_TEST__;
      for (let i = 0; i < n; i++) {
        const pre = T.snapshot();
        if (spellId !== null && pre.spell && pre.spell.id === spellId) {
          return { advanced: i, declared: true };
        }
        if (spellId === null) return { advanced: i, declared: true };
        T.setLives(8);
        if (pre.frame % 60 === 0) T.setInvuln(300);
        T.inject(['shoot', 'skip'], i % 15 === 0 ? ['shoot'] : []);
        if (pinX !== null) T.setPlayer(pinX, 384);
        if (pre.bossActive && (!pre.spell || pre.spell.id !== spellId)) T.damageBoss(300);
        T.advance(1);
      }
      return { advanced: n, declared: false };
    }, { n: Math.min(60, budget - done), spellId, pinX });
    done += batch.advanced;
    if (batch.declared) return done;
  }
  return -1;
}

// Phase 2 (record): passive player (release held keys), pin position if
// requested, advance one frame at a time to each offset and capture evidence.
const records = [];
async function recordAtOffsets() {
  await page.evaluate(() => {
    window.__TH07_TEST__.clearInput();
    window.__TH07_TEST__.setInvuln(99999);
  });
  for (const offset of offsets) {
    const ok = await page.evaluate(({ offset, spellId, pinX }) => {
      const T = window.__TH07_TEST__;
      const age = () => {
        const s = T.snapshot();
        if (spellId === null) return { at: s.stageFrame, live: true };
        return s.spell && s.spell.id === spellId
          ? { at: s.spell.declAge, live: true }
          : { at: -1, live: false };
      };
      let cur = age();
      while (cur.live && cur.at < offset) {
        if (pinX !== null) T.setPlayer(pinX, 384);
        T.advance(1);
        cur = age();
      }
      return cur.live && cur.at === offset;
    }, { offset, spellId, pinX });
    if (!ok) return offset;
    const snap = await page.evaluate(() => window.__TH07_TEST__.snapshot());
    const lifecycle = await page.evaluate(() => window.__TH07_TEST__.lifecycleLog().slice(-64));
    records.push({ offset, snap, lifecycleTail: lifecycle });
    writeFileSync(join(outDir, `offset-${String(offset).padStart(4, '0')}.json`), JSON.stringify({ offset, snap, lifecycle }, null, 2));
    if (takeShots) await page.screenshot({ path: join(outDir, `offset-${String(offset).padStart(4, '0')}.png`) });
    console.log(JSON.stringify({
      offset,
      spell: snap.spell,
      enemies: snap.enemies,
      bullets: snap.bullets,
      bulletHistogram: snap.bulletHistogram,
      lasers: snap.lasers,
      bossOwner: snap.bossOwner,
      player: snap.player,
      rngSeed: snap.rngSeed,
      settledDamage: snap.settledDamage
    }));
  }
  return null;
}

const seekFrames = await seek();
let failedOffset = null;
let exitCode = 0;
if (seekFrames < 0) {
  console.error(`TARGET NOT REACHED: spell ${spellId} not declared within ${budget} frames`);
  exitCode = 2;
} else {
  failedOffset = await recordAtOffsets();
  if (failedOffset !== null) {
    console.error(`PHASE ENDED EARLY: spell ${spellId} was gone before offset ${failedOffset}`);
    exitCode = 3;
  }
}

const summary = {
  stage, difficulty, shot, power, spellId, offsets, playerPath,
  seekFrames: seekFrames >= 0 ? seekFrames : null,
  recorded: records.map((r) => r.offset),
  failedOffset,
  pageErrors: errors.slice(0, 10)
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('SUMMARY', JSON.stringify(summary));
if (errors.length) console.log('PAGE ERRORS', errors.slice(0, 5));

await browser.close();
server.close();
process.exit(exitCode);
