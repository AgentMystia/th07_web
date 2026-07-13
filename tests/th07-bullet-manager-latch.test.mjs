import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  applySnapshot,
  loadEngine,
  makeStubAssets,
  makeStubAudio
} from '../scripts/lib/replay-harness.mjs';

// Native provenance:
//   FUN_004241c0 @ 0x424203-0x4242ee recounts live slots into
//   bullet-manager+0x37a128 (DAT_0099fa60) before updating/culling them.
//   FUN_00423480 @ 0x42348b gates a whole volley on that latched count.
// Stage 6 PRE1673 proves the distinction: DAT_0099fa60=1024 while ten
// already-culled fixed slots are free (1014 live), so Sub12's 5x2 volley is
// rejected. Counting the current pool instead creates the extra graze that
// first desynchronizes RNG at PRE1777.
test('enemy FIRE uses the previous bullet-manager entry census, not current free slots', async () => {
  const mod = await loadEngine();
  const rpy = new mod.Rpy(readFileSync('tests/replays/th7_udFe25.rpy'));
  const stageIndex = 5;
  const stage = rpy.stages[stageIndex];
  const scene = new mod.StageScene(
    makeStubAssets(mod),
    makeStubAudio(),
    rpy.difficulty,
    rpy.character,
    stage.stage,
    null,
    stage.rngSeed
  );
  applySnapshot(scene, rpy, stageIndex, { restoreRng: false });
  const source = new mod.ReplayInputSource();

  for (let inputFrame = 0; inputFrame < 1673; inputFrame++) {
    scene.update(source.frame(stage.inputs[inputFrame] ?? 0));
  }

  assert.equal(scene.frame, 1673);
  assert.equal(scene.enemyBulletManagerEntryCount, 1024, 'native DAT_0099fa60 at PRE1673');
  assert.equal(scene.enemyBullets.length, 1014, 'ten slots were culled after the census');
  assert.equal(scene.runtime.bulletPoolCursor, 340, 'native fixed-pool cursor at PRE1673');

  const owner = scene.enemies.find((enemy) => enemy.poolSlot === 22 && enemy.ecl.subId === 12);
  assert.ok(owner, 'Stage 6 Sub12 emitter occupies native enemy slot 22');
  assert.ok(Math.abs(owner.x - 164.82004) < 0.001);
  assert.equal(owner.y, 64);

  scene.update(source.frame(stage.inputs[1673] ?? 0));

  assert.equal(scene.frame, 1674);
  assert.equal(scene.enemyBulletManagerEntryCount, 1014, 'next manager entry recounts the 1014 live slots');
  assert.equal(scene.enemyBullets.length, 1007, 'native PRE1674 live fixed-slot count');
  assert.equal(scene.runtime.bulletPoolCursor, 340, 'rejected volley does not advance the allocator cursor');
  assert.equal(
    scene.enemyBullets.some((bullet) => bullet.ownerId === owner.id && bullet.spawnFrame === 1674),
    false,
    'the whole 5x2 volley is rejected despite ten currently free slots'
  );
});
