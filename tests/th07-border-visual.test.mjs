import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// Supernatural Border visuals against the native decomp:
// - background dim envelope (Player.cpp:1975-1995, integer math) and the
//   double-SmoothBlendColor application (Stage.cpp:512-532 + :566-573);
// - the authentic ring VM (etama.anm script 219 = effect 28) and its
//   caller-poked spin/scale/fade state (Player.cpp:2126-2137, :2159-2174);
// - the 32 fixed petal burst directions (Player.cpp:2183-2190).

const outDir = 'tests/.build/border-visual';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/cherry.ts src/formats/anm.ts src/data/th07-data.ts src/game/stage-scene.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { borderDimRequest, smoothBlendColor, BORDER_DURATION } = await import(`../${outDir}/game/cherry.mjs`);
const { Anm, AnmRunner } = await import(`../${outDir}/formats/anm.mjs`);
const { TH07_DATA } = await import(`../${outDir}/data/th07-data.mjs`);
const { BORDER_PETAL_DIRS } = await import(`../${outDir}/game/stage-scene.mjs`);

test('dim envelope matches the native integer ramp', () => {
  assert.equal(borderDimRequest(540), 128);        // first frame: neutral
  assert.equal(borderDimRequest(539), 126);        // ramping in (trunc(80/30)=2)
  assert.equal(borderDimRequest(511), 51);
  assert.equal(borderDimRequest(510), 48);         // fully dim
  assert.equal(borderDimRequest(300), 48);         // steady state
  assert.equal(borderDimRequest(30), 48);
  assert.equal(borderDimRequest(29), 51);          // ramping out
  assert.equal(borderDimRequest(1), 126);
});

test('double-feed SmoothBlendColor averages and trails one frame past the end', () => {
  // Emulates StageScene#borderDimLevel over three frames: two active frames
  // at the steady value, then the border ends.
  const state = { a: 0, rgb: 128 };
  const frame = (active, timer) => {
    const c = borderDimRequest(timer);
    if (active) smoothBlendColor(state, c);
    const applied = state.a > 0 ? state.rgb : -1;
    state.a = 0; state.rgb = 128;
    if (active) smoothBlendColor(state, c);
    return applied;
  };
  assert.equal(frame(true, 300), 48);   // first feed wins outright
  assert.equal(frame(true, 300), 48);   // (48+48)>>1
  assert.equal(frame(false, 0), 48);    // trailing dim frame after the end
  assert.equal(frame(false, 0), -1);    // then clean
});

test('border ring is etama script 219 with the authored spin and alpha ramp', () => {
  const etama = new Anm(TH07_DATA.anm.etama, 'etama');
  const runner = new AnmRunner(etama, 0, { entryIndex: 3, spriteIndexOffset: etama.entries[3].spriteBase });
  const frame0 = runner.spriteFrame();
  assert.ok(frame0, 'ring sprite present');
  assert.equal(frame0.imageKey, 'etama4');
  assert.equal(frame0.alpha, 0); // alpha(0) at time 0
  // Activation poke (Player.cpp:2135-2136): var0 stretches the t=1 wait to
  // the full border, and the authored spin is negated.
  runner.setVariable(0, BORDER_DURATION);
  runner.negateRotationSpeedZ();
  runner.update();
  const rotAfter1 = runner.spriteFrame().rotation;
  runner.update();
  const rotAfter2 = runner.spriteFrame().rotation;
  close(rotAfter2 - rotAfter1, -0.00314159, 1e-6);
  // Alpha fades 0 -> 160 over the first 30 frames (fadeTime formula 0).
  for (let i = 0; i < 28; i++) runner.update();
  const a30 = runner.spriteFrame().alpha;
  assert.ok(a30 >= 150 && a30 <= 160, `alpha ${a30} near 160 after 30 frames`);
  // The t=1 wait(var0) self-removes the VM at 540 (runner is at frame 30
  // here; removal fires when the frame clock reaches 1+540).
  let frames = 30;
  while (!runner.removed && frames < 600) { runner.update(); frames++; }
  assert.equal(runner.removed, true);
  assert.ok(frames >= 540 && frames <= 542, `removed at frame ${frames}`);
});

test('break poke fades the ring 255 -> 0 over 30 frames with t² easing', () => {
  const etama = new Anm(TH07_DATA.anm.etama, 'etama');
  const runner = new AnmRunner(etama, 0, { entryIndex: 3, spriteIndexOffset: etama.entries[3].spriteBase });
  runner.setVariable(0, 30);
  runner.armFade(30, 1, 255, 0);
  assert.equal(runner.spriteFrame().alpha, 255);
  runner.update(); // frame 1: t=1/30, t² = 1/900
  const a1 = runner.spriteFrame().alpha;
  assert.ok(a1 >= 254 && a1 <= 255, `alpha ${a1} barely moved at t=1/30`);
  for (let i = 0; i < 14; i++) runner.update(); // frame 15: t=0.5, alpha=191/192
  const a15 = runner.spriteFrame().alpha;
  assert.ok(a15 >= 185 && a15 <= 200, `alpha ${a15} ~192 mid-fade`);
  let frames = 15;
  while (!runner.removed && frames < 40) { runner.update(); frames++; }
  assert.equal(runner.removed, true);
  // wait(var0=30) arms at frame 1 -> removal at frame 31 (loop counter +1).
  assert.ok(frames >= 30 && frames <= 32, `break ring removed at frame ${frames}`);
});

test('32 petal burst directions are the native -PI + i*PI/16 fan', () => {
  assert.equal(BORDER_PETAL_DIRS.length, 32);
  for (let i = 0; i < 32; i++) {
    const angle = -Math.PI + i * (Math.PI / 16);
    close(BORDER_PETAL_DIRS[i].x, Math.cos(angle), 1e-12);
    close(BORDER_PETAL_DIRS[i].y, Math.sin(angle), 1e-12);
  }
  // The petal sprite (etama entry-1 embedded 28, global 196): the big
  // 64x64 pink orb on the etama2 sheet.
  const etama = new Anm(TH07_DATA.anm.etama, 'etama');
  const sprite = etama.sprites.get(etama.entries[1].spriteBase + 28);
  assert.ok(sprite, 'petal sprite present');
  assert.equal(sprite.imageKey, 'etama2');
  assert.equal(sprite.w, 64);
  assert.equal(sprite.h, 64);
});

function close(a, b, eps) {
  assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
}
