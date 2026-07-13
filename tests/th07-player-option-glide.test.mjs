// The non-SakuyaB option state machine is gameplay-relevant: shooter records
// spawn from these live positions. Th07.exe FUN_0043be00 (v1.00b),
// all.c:28343-28345/28360-28362, eases X quadratically and Y linearly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/player-option-glide';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/player.ts --bundle --format=esm --outfile=${outDir}/player.mjs --log-level=silent`);
const { Player } = await import('../tests/.build/player-option-glide/player.mjs');

test('SakuyaA option glide uses the exe quadratic-X / linear-Y curves', () => {
  const player = Object.create(Player.prototype);
  player.character = 'sakuyaA';
  player.focusGlideFrame = 4; // t=1/2, after FUN_00436acc's frame tick

  player.focusHeld = true;
  assert.deepEqual(player.orbOffset(1), { x: -20, y: -16 });
  assert.deepEqual(player.orbOffset(2), { x: 20, y: -16 });

  player.focusHeld = false;
  assert.deepEqual(player.orbOffset(1), { x: -12, y: -16 });
  assert.deepEqual(player.orbOffset(2), { x: 12, y: -16 });
});

test('mid-glide reversal preserves the native asymmetric split-counter order', () => {
  const player = Object.create(Player.prototype);
  player.character = 'sakuyaA';
  player.focusTransition = null;

  // Native Stage-1 trace: processing f2599 is state-4/unfocused timer 5;
  // focus is pressed at f2600 and the exe ends that frame at state-2 timer 3
  // (advance old state, complement, clear fraction, advance new state).
  player.focusHeld = false;
  player.focusGlideFrame = 5;
  player.updateFocusGlide(true, 1);
  assert.equal(player.focusGlideFrame, 3);
  assert.equal(player.focusTransition, 'in');
  assert.deepEqual(player.orbOffset(1), { x: -21.75, y: -12 });

  player.updateFocusGlide(true, 1);
  assert.equal(player.focusGlideFrame, 4);
  assert.deepEqual(player.orbOffset(1), { x: -20, y: -16 });

  // The reverse direction enters state 4 before its single advance. This
  // direction was already correct: focused timer 4 becomes unfocused 5.
  player.focusHeld = true;
  player.focusGlideFrame = 4;
  player.updateFocusGlide(false, 1);
  assert.equal(player.focusGlideFrame, 5);
  assert.equal(player.focusTransition, 'out');
  assert.deepEqual(player.orbOffset(1), { x: -14.25, y: -12 });
});

test('focus reversal discards the old split fraction and advances the new state at slow rate', () => {
  const player = Object.create(Player.prototype);
  player.character = 'sakuyaA';
  player.focusTransition = null;

  player.focusHeld = false;
  player.focusGlideFrame = 5.75;
  player.updateFocusGlide(true, 0.5);
  assert.equal(player.focusGlideFrame, 2.5, 'old state crosses to 6, complement 2, new fraction 0.5');

  player.focusHeld = true;
  player.focusGlideFrame = 4.75;
  player.updateFocusGlide(false, 0.5);
  assert.equal(player.focusGlideFrame, 4.5, 'complement integer 4, discard .75, new fraction 0.5');
});

test('player center clamps to the executable field insets', () => {
  const player = Object.create(Player.prototype);
  player.unfocused = player.focused = {
    speed: 4,
    focusedSpeed: 2,
    diagSpeed: 3,
    diagFocusedSpeed: 1.5
  };
  player.focusHeld = false;
  player.bombTimer = 0;
  player.bombSpeedMult = 1;

  player.x = 9;
  player.y = 17;
  player.move({ held: new Set(['left', 'up']) });
  assert.deepEqual([player.x, player.y], [8, 16]);

  player.x = 375;
  player.y = 431;
  player.move({ held: new Set(['right', 'down']) });
  assert.deepEqual([player.x, player.y], [376, 432]);
});

test('player movement accumulates through the native float32 position fields', () => {
  const player = Object.create(Player.prototype);
  player.unfocused = player.focused = {
    speed: 2.2,
    focusedSpeed: 2.2,
    diagSpeed: 2.2,
    diagFocusedSpeed: 2.2
  };
  player.focusHeld = false;
  player.bombTimer = 0;
  player.bombSpeedMult = 1;
  player.x = 192;
  player.y = 384;

  for (let i = 0; i < 57; i++) player.move({ held: new Set(['right']) });

  // FUN_0043be00 stores velocity to +0x9cc and position to +0x930 as f32
  // on every tick. A JS-double accumulator would be 317.39999999999935.
  assert.equal(player.lastVx, Math.fround(2.2));
  assert.equal(player.x, 317.4002380371094);
  assert.equal(player.y, 384);
});
