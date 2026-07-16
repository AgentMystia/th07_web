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

test('mid-glide reversal advances old and new native split counters', () => {
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

  // Native th7_ud8141 processing 8631: a focus-in counter at 5 reverses by
  // advancing old 5->6, complementing to 2, then advancing new 2->3.
  // Two ordinary state-4 ticks later the shot origin is exactly timer 5.
  player.focusHeld = true;
  player.focusGlideFrame = 5;
  player.updateFocusGlide(false, 1);
  assert.equal(player.focusGlideFrame, 3);
  assert.equal(player.focusTransition, 'out');
  assert.deepEqual(player.orbOffset(1), { x: -10.25, y: -20 });

  player.updateFocusGlide(false, 1);
  player.updateFocusGlide(false, 1);
  assert.equal(player.focusGlideFrame, 5);
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
  assert.equal(player.focusGlideFrame, 3.5, 'old state crosses to 5, complement 3, new fraction 0.5');
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

test('SakuyaB option angle advances only while firing unfocused outside messages', () => {
  const makePlayer = () => {
    const player = Object.create(Player.prototype);
    player.character = 'sakuyaB';
    player.unfocused = player.focused = {
      speed: 4,
      focusedSpeed: 2,
      diagSpeed: 3,
      diagFocusedSpeed: 1.5
    };
    player.focusHeld = false;
    player.focusGlideFrame = 8;
    player.focusTransition = null;
    player.invulnFrames = 0;
    player.invulnFrac = 0;
    player.bombInvuln = 0;
    player.bombTimer = 0;
    player.bombSpeedMult = 1;
    player.materializeFrame = -1;
    player.dyingFrame = -1;
    player.hitState = false;
    player.deathbombMeter = 8;
    player.fireFrame = -1;
    player.fireFrameFrac = 0;
    player.orbitAngle = -1.8;
    player.x = 100;
    player.y = 100;
    player.runner = { update() {} };
    player.updatePose = () => {};
    return player;
  };

  const released = makePlayer();
  released.update({ held: new Set(['right']), pressed: new Set(), released: new Set() });
  assert.equal(released.orbitAngle, -1.8, 'released Z freezes the option angle');

  const focused = makePlayer();
  focused.update({ held: new Set(['shoot', 'focus', 'right']), pressed: new Set(), released: new Set() });
  assert.equal(focused.orbitAngle, -1.8, 'focused firing freezes the option angle');

  const message = makePlayer();
  message.update({ held: new Set(['shoot', 'right']), pressed: new Set(), released: new Set() }, 1, false);
  assert.equal(message.orbitAngle, -1.8, 'an active message freezes the option angle');

  const active = makePlayer();
  active.update({ held: new Set(['shoot', 'right']), pressed: new Set(), released: new Set() });
  assert.equal(active.orbitAngle, -1.8 + 4 * Math.PI / 200);
});

test('the bomb-ending tick still uses its frame-entry movement multiplier', () => {
  const player = Object.create(Player.prototype);
  player.unfocused = player.focused = {
    speed: 5,
    focusedSpeed: 2.5,
    diagSpeed: Math.fround(5 / Math.sqrt(2)),
    diagFocusedSpeed: Math.fround(2.5 / Math.sqrt(2))
  };
  player.focusHeld = false;
  player.focusGlideFrame = 8;
  player.focusTransition = null;
  player.invulnFrames = 0;
  player.invulnFrac = 0;
  player.bombInvuln = 1;
  player.bombTimer = 1;
  player.bombSpeedMult = 0.4;
  player.materializeFrame = -1;
  player.dyingFrame = -1;
  player.hitState = false;
  player.deathbombMeter = 8;
  player.fireFrame = -1;
  player.fireFrameFrac = 0;
  player.orbitAngle = -Math.PI / 2;
  player.x = 100;
  player.y = 100;
  player.runner = { update() {} };
  player.updatePose = () => {};

  player.update({
    held: new Set(['right', 'down']), pressed: new Set(), released: new Set()
  });

  const step = Math.fround(player.unfocused.diagSpeed * 0.4);
  assert.equal(player.x, Math.fround(100 + step));
  assert.equal(player.y, Math.fround(100 + step));
  assert.equal(player.bombTimer, 0);
  assert.equal(player.bombSpeedMult, 1, 'the reset is visible to the next tick');
});
