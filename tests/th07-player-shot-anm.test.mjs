// Player-shot ANM lifecycle regression tests. Th07.exe drives every player
// bullet through an embedded ANM VM: SHT `sprite` is a global script id at
// player base 1024 (FUN_00438b70 stores it at slot+0x1d8), the impact switch
// re-arms the VM with script sprite+0x20 (FUN_0043a980 @ 0x43aa8c), and the
// bullet slot is freed when its script ends (FUN_0043a290: FUN_0044aa20
// nonzero → +0x34a = 0). These tests pin the data-side invariants the port
// relies on: every shipped shooter record resolves to a real flight script,
// every non-laser record has an impact script, and the impact scripts
// self-remove (flight scripts never do).
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

test('flight scripts persist; impact scripts self-remove on schedule', () => {
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
