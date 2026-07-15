import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEngine, makeStubAssets, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// Native player+0x16a20 remains set for one player callback after the
// remaining bomb timer reaches zero (cleanup tick). FUN_0043e890 defers a
// pending Supernatural Border while that flag is set. Web models the same
// gate with bombCleanupDefersBorder so a cherryPlus fill during the bomb
// cannot start the border on the cleanup tick (Extra MarisaB oracle AUX
// bit 0x8 @ frame 10367).
test('pending border stays deferred through the bomb cleanup tick', async () => {
  const mod = await loadEngine();
  const scene = new mod.StageScene(
    makeStubAssets(mod),
    makeStubAudio(),
    4,
    'marisaB',
    7,
    null,
    0x1234
  );
  const p = scene.playerObj;
  p.x = 192;
  p.y = 350;
  p.bombs = 2;
  p.deathbombMeter = 8;
  p.invulnFrames = 0;
  p.invulnFrac = 0;

  // Arm a short bomb and force cherryPlus to the border trigger.
  assert.equal(p.tryBomb(), true);
  scene.onBombUsed();
  scene.cherry.cherryPlus = 50000;
  scene.cherry.borderPending = true;
  // Drain the remaining timer to 1 so the next update ends the bomb.
  p.bombTimer = 1;
  p.bombInvuln = 1;

  const holdNone = { held: new Set(), pressed: new Set(), released: new Set() };
  // Frame A: timer 1 -> 0, arms cleanup pending; border must still defer.
  scene.update(holdNone);
  assert.equal(p.bombTimer, 0, 'bomb timer consumed');
  assert.equal(scene.cherry.borderActive, false, 'border not active on end tick');
  assert.equal(scene.cherry.borderPending, true, 'border still pending on end tick');

  // player+0x23dc stays set for the cleanup callback too. A type-6 item
  // collected there must still use the bomb's flat 100/10 score instead of
  // the graze-scaled value (4000 graze would otherwise award 130).
  scene.graze = 4000;
  scene.score = 0;
  scene.spawnItem('cherry', p.x, p.y, { state: 1 });

  // Frame B: cleanup tick — native +0x16a20 still set; border still defers.
  scene.update(holdNone);
  assert.equal(scene.cherry.borderActive, false, 'border still deferred on cleanup tick');
  assert.equal(scene.cherry.borderPending, true, 'pending preserved on cleanup tick');
  assert.equal(scene.score, 10, 'cleanup-tick Cherry keeps the bomb score rule');

  // Frame C: flag clear; pending border may start.
  scene.update(holdNone);
  assert.equal(scene.cherry.borderPending, false, 'pending cleared when border starts');
  assert.equal(scene.cherry.borderActive, true, 'border starts the frame after cleanup');
});
