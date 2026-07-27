// Player-shot ANM lifecycle regression tests. Th07.exe drives every player
// bullet through an embedded ANM VM: SHT `sprite` is a global script id at
// player base 1024 (FUN_00438b70 stores it at slot+0x1d8), the impact switch
// re-arms the VM with script sprite+0x20 (FUN_0043a980 @ 0x43aa8c), and the
// bullet slot is freed when its script ends (FUN_0043a290: FUN_0044aa20
// nonzero → +0x34a = 0). These tests pin the data-side invariants the port
// relies on: every shipped shooter record resolves to a real flight script,
// every non-laser record has an impact script, and every impact script ENDS
// on a short schedule while flight scripts never do.
//
// "Ends" has two authored spellings and the engine must honor both: op1
// `remove` (Reimu/Sakuya impacts, 20-30f) and op2 `static` (ReimuB's orb
// impacts 98-101 and MarisaA's missile impacts 97-104, 20-45f, authored at
// the exact tick their fade reaches alpha 0). Flight scripts also end in
// static, but at t=10000/20000 — unreachable, so a flying shot only ever
// dies by bounds. Honoring remove alone left the static-ending impacts
// squatting the fixed 96-slot pool for hundreds of frames, starving new
// spawns (th7_udFi03 Hard stage 3: pool full at 96/96 across the dry
// windows of a scripted x=40 descent, killing it 9 frames late).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/player-shot';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/formats/anm.ts --bundle --format=esm --outfile=${outDir}/anm.mjs --log-level=silent`);
execSync(`npx esbuild src/formats/sht.ts --bundle --format=esm --outfile=${outDir}/sht.mjs --log-level=silent`);
execSync(`npx esbuild src/data/th07-data.ts --bundle --format=esm --outfile=${outDir}/th07-data.mjs --log-level=silent`);
const { Anm, AnmRunner } = await import('../tests/.build/player-shot/anm.mjs');
const { Sht } = await import('../tests/.build/player-shot/sht.mjs');
const { TH07_DATA } = await import('../tests/.build/player-shot/th07-data.mjs');

const PLAYER_SPRITE_BASE = 1024;
const ANMS = {
  ply00: new Anm(TH07_DATA.anm.player00, 'player00'),
  ply01: new Anm(TH07_DATA.anm.player01, 'player01'),
  ply02: new Anm(TH07_DATA.anm.player02, 'player02')
};
const SHT_FILES = ['ply00a', 'ply00as', 'ply00b', 'ply00bs', 'ply01a', 'ply01as', 'ply01b', 'ply01bs', 'ply02a', 'ply02as', 'ply02b', 'ply02bs'];
const POWERS = [0, 8, 16, 32, 48, 64, 80, 96, 128];

test('every shipped shooter record resolves to a real flight ANM script', () => {
  for (const name of SHT_FILES) {
    const anm = ANMS[name.slice(0, 5)];
    const sht = new Sht(TH07_DATA.sht[name]);
    for (const power of POWERS) {
      for (const shot of sht.shotsForPower(power)) {
        const script = shot.sprite - PLAYER_SPRITE_BASE;
        assert.ok(anm.hasScript(script), `${name} p${power}: script ${script}`);
        if (shot.shotType !== 4 && shot.shotType !== 5) {
          // Types 4/5 (MarisaB lasers) never switch to the impact ANM.
          assert.ok(anm.hasScript(script + 0x20), `${name} p${power}: impact ${script + 0x20}`);
        }
      }
    }
  }
});

test('flight scripts persist; remove-ending impact scripts self-remove on schedule', () => {
  // Flight scripts end in `static` — a bullet is culled by bounds, never by
  // its own script. 300 frames ≫ any on-screen flight time.
  const flight = new AnmRunner(ANMS.ply02, 64);
  for (let i = 0; i < 300; i++) flight.update();
  assert.equal(flight.removed, false);
  assert.ok(flight.spriteFrame(), 'flight sprite stays visible');
  // Sakuya impact scripts 96/97: additive stretch-fade, remove() at t=20.
  const impact = new AnmRunner(ANMS.ply02, 96);
  let frames = 0;
  while (!impact.removed && frames < 100) {
    impact.update();
    frames++;
  }
  assert.ok(impact.removed, 'impact script removes itself');
  assert.ok(frames >= 18 && frames <= 24, `sakuya impact lifetime ~20f, got ${frames}`);
  // Reimu impact 96 runs 30 frames.
  const reimuImpact = new AnmRunner(ANMS.ply00, 96);
  frames = 0;
  while (!reimuImpact.removed && frames < 100) {
    reimuImpact.update();
    frames++;
  }
  assert.ok(frames >= 28 && frames <= 34, `reimu impact lifetime ~30f, got ${frames}`);
});

test('player-shot impact re-arm frees a t20 script after exactly 20 following ticks', () => {
  // FUN_0043a980 -> FUN_004486e0 synchronously consumes the t=0 init before
  // returning to the enemy manager. StageScene therefore seeds the runner's
  // next-tick clock at 1 rather than replaying t=0 on the following frame.
  const impact = new AnmRunner(ANMS.ply02, 97);
  impact.frame = 1;
  for (let i = 0; i < 19; i++) impact.update();
  assert.equal(impact.removed, false);
  impact.update();
  assert.equal(impact.removed, true);
});

test('static-ending impact scripts end on schedule without ever setting removed', () => {
  // ReimuB's orb impacts (player00 98-101) and MarisaA's missile impacts
  // (player01 97-104) close on op2 `static`, not op1 `remove`. Seeded like the
  // production re-arm (StageScene sets runner.frame = 1 after FUN_004486e0
  // consumed t=0), each must report script-over on its authored tick.
  const cases = [
    ['ply00', 98, 20], ['ply00', 99, 20], ['ply00', 100, 20], ['ply00', 101, 20],
    ['ply01', 97, 20], ['ply01', 98, 20], ['ply01', 99, 20], ['ply01', 100, 20],
    ['ply01', 101, 30], ['ply01', 102, 30], ['ply01', 103, 35], ['ply01', 104, 45]
  ];
  for (const [anmName, script, ticks] of cases) {
    const impact = new AnmRunner(ANMS[anmName], script);
    impact.frame = 1;
    for (let i = 0; i < ticks - 1; i++) impact.update();
    assert.equal(impact.stopped, false, `${anmName}/${script} ended before tick ${ticks}`);
    impact.update();
    assert.equal(impact.stopped, true, `${anmName}/${script} did not end on tick ${ticks}`);
    // `static` never raises removed — the engine must treat both spellings of
    // "script over" as the slot-release signal, or these squat the pool.
    assert.equal(impact.removed, false, `${anmName}/${script} ends static, not remove`);
  }
});

test('every shipped non-beam impact script ends within 64 ticks', () => {
  // The 96-slot pool only recycles when a script ends, so an impact that
  // neither removes nor goes static is an unbounded slot leak. This covers
  // every character, including MarisaA, whose forms no replay exercises yet.
  for (const name of SHT_FILES) {
    const anm = ANMS[name.slice(0, 5)];
    const sht = new Sht(TH07_DATA.sht[name]);
    for (const power of POWERS) {
      for (const shot of sht.shotsForPower(power)) {
        if (shot.shotType === 4 || shot.shotType === 5) continue;
        const script = shot.sprite - PLAYER_SPRITE_BASE + 0x20;
        const runner = new AnmRunner(anm, script);
        runner.frame = 1;
        let ticks = 0;
        while (!runner.removed && !runner.stopped && ticks < 64) {
          runner.update();
          ticks++;
        }
        assert.ok(runner.removed || runner.stopped,
          `${name} p${power}: impact ${script} never ended in 64 ticks`);
      }
    }
  }
});

test('flight scripts never end on their own within a full screen crossing', () => {
  // Their authored `static` sits at t=10000/20000 — a flying shot is culled by
  // bounds, never by its script. If one of these ever ended, the bounds cull
  // would stop being the only exit and every shot lifetime would shorten.
  for (const name of SHT_FILES) {
    const anm = ANMS[name.slice(0, 5)];
    const sht = new Sht(TH07_DATA.sht[name]);
    for (const power of POWERS) {
      for (const shot of sht.shotsForPower(power)) {
        const runner = new AnmRunner(anm, shot.sprite - PLAYER_SPRITE_BASE);
        for (let i = 0; i < 400; i++) runner.update();
        assert.equal(runner.removed, false, `${name} p${power}: flight script removed itself`);
        assert.equal(runner.stopped, false, `${name} p${power}: flight script ended itself`);
      }
    }
  }
});

test('sakuya knife flight scripts carry the vanilla auto-rotate/alpha state', () => {
  for (const script of [64, 65]) {
    const runner = new AnmRunner(ANMS.ply02, script);
    const frame = runner.spriteFrame();
    assert.ok(frame, `script ${script} visible at t=0`);
    assert.equal(frame.autoRotate, true, `script ${script} auto-rotates`);
    assert.equal(frame.alpha, 96, `script ${script} alpha 96`);
    assert.equal(frame.scaleX, 1.5, `script ${script} scale 1.5`);
  }
});
