// SHT shooter behavior-func regression tests, locked to the values decoded
// from the embedded original .sht files (see the src/formats/sht.ts header
// table). funcs[0] === 4 is SakuyaA's focused spawn-aim — the data behind
// her auto-aim shot type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/sht-funcs';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/formats/sht.ts --bundle --format=esm --outfile=${outDir}/sht.mjs --log-level=silent`);
execSync(`npx esbuild src/formats/anm.ts --bundle --format=esm --outfile=${outDir}/anm.mjs --log-level=silent`);
execSync(`npx esbuild src/game/player.ts --bundle --format=esm --outfile=${outDir}/player.mjs --log-level=silent`);
execSync(`npx esbuild src/data/th07-data.ts --bundle --format=esm --outfile=${outDir}/th07-data.mjs --log-level=silent`);
const { Sht } = await import('../tests/.build/sht-funcs/sht.mjs');
const { Anm } = await import('../tests/.build/sht-funcs/anm.mjs');
const {
  Player, bombCherryDrainPerFrame, playerShotAllocationAllowed
} = await import('../tests/.build/sht-funcs/player.mjs');
const { TH07_DATA } = await import('../tests/.build/sht-funcs/th07-data.mjs');

const load = (name) => new Sht(TH07_DATA.sht[name]);
const allShots = (sht) => sht.levels.flatMap((l) => l.shots);

test('SakuyaA focused: every shooter carries spawn-aim func 4', () => {
  for (const s of allShots(load('ply02as'))) assert.equal(s.funcs[0], 4);
});

test('SakuyaA unfocused fan: no behavior funcs', () => {
  for (const s of allShots(load('ply02a'))) assert.deepEqual(s.funcs, [0, 0, 0, 0]);
});

test('ReimuA orbs: homing tick func mirrors shotType 1', () => {
  const orbs = allShots(load('ply00a')).filter((s) => s.orb !== 0);
  assert.ok(orbs.length > 0);
  for (const s of orbs) {
    assert.equal(s.shotType, 1);
    assert.deepEqual(s.funcs, [0, 1, 0, 0]);
  }
});

test('MarisaB focused laser: shotType 5 with pierce flag funcs[2]=1', () => {
  const lasers = allShots(load('ply01bs')).filter((s) => s.shotType === 5);
  assert.ok(lasers.length > 0);
  for (const s of lasers) assert.deepEqual(s.funcs, [3, 5, 1, 2]);
});

test('SakuyaB: option shooters carry the unknown func 5', () => {
  const options = allShots(load('ply02bs')).filter((s) => s.orb !== 0);
  assert.ok(options.length > 0);
  for (const s of options) assert.equal(s.funcs[0], 5);
});

test('power thresholds are strict: exact values select the following table', () => {
  const sht = load('ply02a');
  assert.equal(sht.shotsForPower(7), sht.levels[0].shots);
  assert.equal(sht.shotsForPower(8), sht.levels[1].shots, '8 advances to the 16 threshold table');
  assert.equal(sht.shotsForPower(127), sht.levels[7].shots);
  assert.equal(sht.shotsForPower(128), sht.levels[8].shots, '128 advances to the 999 threshold table');
});

test('MarisaB replaces a persistent laser when the power table changes record identity', () => {
  const player = new Player('marisaB', {
    player01: new Anm(TH07_DATA.anm.player01, 'player01')
  });
  player.focusHeld = true;
  player.focusGlideFrame = 8;
  player.fireFrame = 0;
  player.prevFireFrame = -999;
  player.power = 31;

  const first = player.fire().find((bullet) => bullet.shotType === 5);
  assert.ok(first);
  assert.equal(player.laserSlots[2]?.bullet, first);

  player.power = 32;
  const transition = player.fire().filter((bullet) => bullet.shotType === 5);
  assert.deepEqual(transition, [], 'record mismatch clears the owner without same-pass replacement');
  assert.equal(player.laserSlots[2], null);
  assert.equal(first.fadePending, true);

  const replacement = player.fire().find((bullet) => bullet.shotType === 5);
  assert.ok(replacement);
  assert.notEqual(replacement, first);
  assert.equal(player.laserSlots[2]?.bullet, replacement);
});

test('bomb-active shot cycles advance without allocating a new MarisaB laser owner', () => {
  const player = new Player('marisaB', {
    player01: new Anm(TH07_DATA.anm.player01, 'player01')
  });
  player.focusHeld = false;
  player.focusGlideFrame = 8;
  player.fireFrame = 16;
  player.prevFireFrame = 15;
  player.power = 128;
  player.bombTimer = 1;
  player.bombSpeedMult = 0.4;

  // Native PRE clock=duration-1 maps to remaining timer 1.  The bomb VM
  // consumes that final tick before the firing pass, but allocation is still
  // gated by the frame-entry state; only the following tick may spawn.
  const allowOnEndingTick = playerShotAllocationAllowed(player.character, player.bombTimer > 0);
  player.update({ held: new Set(['shoot']), pressed: new Set(), released: new Set() });
  assert.equal(player.bombTimer, 0);
  assert.deepEqual(player.fire(1, allowOnEndingTick), []);
  assert.equal(player.fireFrame, 17, 'FUN_0043a820 still advances the armed cycle');
  assert.equal(player.prevFireFrame, 16);
  assert.deepEqual(player.laserSlots, [null, null, null]);

  player.update({ held: new Set(['shoot']), pressed: new Set(), released: new Set() });
  const resumed = player.fire(1,
    playerShotAllocationAllowed(player.character, player.bombTimer > 0)
  ).find((bullet) => bullet.shotType === 4);
  assert.ok(resumed, 'allocation resumes on the next changed phase after the bomb gate opens');
});

test('bomb-active shot allocation gate is MarisaB-only', () => {
  for (const character of ['reimuA', 'reimuB', 'marisaA', 'sakuyaA', 'sakuyaB']) {
    assert.equal(playerShotAllocationAllowed(character, true), true, `${character} keeps firing`);
  }
  assert.equal(playerShotAllocationAllowed('marisaB', true), false);
  assert.equal(playerShotAllocationAllowed('marisaB', false), true);
});

test('post-Border cooldown gates a held-X bomb until it reaches zero', () => {
  const player = new Player('reimuA', {
    player00: new Anm(TH07_DATA.anm.player00, 'player00')
  });
  player.bombCooldown = 1;
  assert.equal(player.tryBomb(), false);
  player.bombCooldown = 0;
  assert.equal(player.tryBomb(), true);
});

test('bomb Cherry drain matches FUN_00407740 form and difficulty staging', () => {
  assert.equal(bombCherryDrainPerFrame('reimuA', false, 5, 432720, 140), 200,
    'Phantasm ReimuA unfocused: round(cherry*0.2)/3/140 floored to tens');
  assert.equal(bombCherryDrainPerFrame('reimuA', false, 1, 432720, 140), 610);
  assert.equal(bombCherryDrainPerFrame('marisaB', true, 4, 200000, 340), 80,
    'Extra MarisaB focused uses 0.41, /3, duration 340, minimum 10000');
});
