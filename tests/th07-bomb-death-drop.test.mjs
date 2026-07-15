import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEngine, makeStubAssets, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

const mod = await loadEngine();

function makeScene() {
  return new mod.StageScene(
    makeStubAssets(mod), makeStubAudio(), 4, 'marisaB', 7, null, 0x1234
  );
}

function makeDropEnemy(scene) {
  const ecl = scene.runtime.makeEnemyState(0, false, 0, null);
  ecl.itemDrop = 0; // native power item; full power converts it to big Cherry
  ecl.deathMode = 0;
  ecl.interactable = true;
  ecl.canTakeDamage = true;
  ecl.isBoss = false;
  return {
    id: 9001,
    poolSlot: 0,
    x: 120,
    y: 32,
    z: 0,
    hp: 5,
    maxHp: 5,
    pendingShotDmg: 0,
    pendingBombDmg: 0,
    score: 0,
    frame: 0,
    ecl
  };
}

// FUN_0043a980 sets FUN_0041ed50 local_18 when an attack slot overlaps
// during a bomb. The death switch passes that value to FUN_00430970 as
// spawnMode=1. Extra native item slot 75 is the concrete witness: a power
// drop converted to big Cherry at frame 10354 and collected homing at 10366.
test('bomb-contact enemy death drops start in native homing mode', () => {
  const bombScene = makeScene();
  bombScene.playerObj.power = 128;
  const bombEnemy = makeDropEnemy(bombScene);
  bombScene.damageEnemy(bombEnemy, 10, 'bomb');
  const bombContact = bombScene.settlePendingDamage(bombEnemy);
  assert.equal(bombContact, true, 'settlement preserves the attack-slot contact flag');
  assert.ok(bombEnemy.hp <= 0, 'bomb contact kills the fixture enemy');
  assert.equal(bombScene.runtime.killEnemy(bombScene, bombEnemy, bombContact), false);
  assert.equal(bombScene.items.length, 1);
  assert.equal(bombScene.items[0].type, 'bigCherry');
  assert.equal(bombScene.items[0].state, 1, 'bomb death drop is homing from birth');

  const shotScene = makeScene();
  shotScene.playerObj.power = 128;
  const shotEnemy = makeDropEnemy(shotScene);
  shotScene.damageEnemy(shotEnemy, 10, 'shot');
  const shotBombContact = shotScene.settlePendingDamage(shotEnemy);
  assert.equal(shotBombContact, false);
  assert.equal(shotScene.runtime.killEnemy(shotScene, shotEnemy, shotBombContact), false);
  assert.equal(shotScene.items[0].state, 0, 'ordinary shot death keeps the falling mode');
});
