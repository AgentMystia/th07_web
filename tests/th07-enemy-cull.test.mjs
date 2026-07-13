import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadEngine,
  makeStubAssets,
  makeStubAudio
} from '../scripts/lib/replay-harness.mjs';

// Th07.exe FUN_0041ed50 @ 0x41f30d gates its current-sprite cull on
// enemy+0x2e29 bit 3, written by ECL op132. Stage-1 Sub43 is an invisible
// controller whose fixed slot must survive after its path leaves the field.
test('ECL-invisible enemies skip the native seen-then-offscreen cull', async () => {
  const mod = await loadEngine();
  const scene = new mod.StageScene(
    makeStubAssets(mod),
    makeStubAudio(),
    3,
    'sakuyaA',
    1,
    null,
    0x1234
  );
  const enemy = scene.runtime.spawnEclEnemy(scene, {
    subId: 43,
    x: 0,
    y: 0,
    life: 1,
    item: -2,
    score: 10
  });
  assert.ok(enemy.ecl.anmRunner?.spriteSize(), 'Sub43 selected a current sprite');

  enemy.ecl.seen = true;
  enemy.ecl.offscreenCullExempt = false;
  enemy.ecl.trailFlags = 0;
  enemy.x = -1000;
  enemy.y = 224;
  enemy.ecl.invisible = true;
  scene.updateEnemyCull(enemy);
  assert.notEqual(enemy.dead, true, 'op132 invisible bit bypasses culling');

  enemy.ecl.invisible = false;
  enemy.ecl.anmRunner.visible = false;
  enemy.ecl.anmRunner.removed = true;
  scene.updateEnemyCull(enemy);
  assert.equal(enemy.dead, true,
    'hidden/removed ANM draw state still culls through the raw current-sprite size');
});
