import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// Sakuya's aimed knives (SHT funcs[0] == 4, the whole ply02as focused set)
// consume a per-frame shared target snapshot with a maximum firing angle:
// an enemy qualifies only while the angle from the PLAYER to it lies in
// [-120°, -60°) — ±30° around straight up (Th07.exe FUN_0041ed50 @
// all.c:14258-14300, character gate DAT_00625625 == 2, cone floats @
// 0x48edc4/0x48edc0 = -2π/3 / -π/3). Selection among qualifiers is NOT
// nearest-first: the cache (DAT_004b5eec/f0, sentinel y=-900 @ 0x48eb6c)
// takes the FIRST cone-qualified non-boss in pool order, and a
// cone-qualified BOSS takes it with min |e.x - player.x| and locks it
// (DAT_004b5ef8) against non-bosses.

const outDir = 'tests/.build/sakuya-aim';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/stage-scene.ts --bundle --format=esm --outfile=${outDir}/stage-scene.mjs --log-level=silent`);
const { StageScene } = await import('../tests/.build/sakuya-aim/stage-scene.mjs');

function aimScene(character) {
  const scene = Object.create(StageScene.prototype);
  scene.playerObj = { x: 192, y: 400, character };
  scene.enemies = [];
  scene.sakuyaAim = null;
  return scene;
}

function enemy(x, y, isBoss = false) {
  return {
    x, y, dead: false,
    ecl: { interactable: true, invisible: false, canTakeDamage: true, shotCollision: true, isBoss }
  };
}

function aim(scene) {
  scene.updateSakuyaAimCache();
  return scene.sakuyaAim;
}

test('Sakuya only aims at enemies within ±30° of straight up', () => {
  const scene = aimScene('sakuyaA');
  const above = enemy(200, 120);   // ~ -88°: inside the cone
  const beside = enemy(330, 390);  // ~ -4°: outside
  const diagonal = enemy(330, 260); // ~ -45°: outside (cone edge is -60°)
  scene.enemies = [beside, diagonal];
  assert.equal(aim(scene), null, 'nothing inside the cone');
  scene.enemies = [beside, diagonal, above];
  assert.deepEqual(aim(scene), { x: 200, y: 120 }, 'only the in-cone enemy qualifies');
});

test('first cone-qualified non-boss in pool order wins, not the nearest', () => {
  const scene = aimScene('sakuyaA');
  const far = enemy(180, 60);   // in cone, far from the player
  const near = enemy(200, 320); // in cone, much closer
  scene.enemies = [far, near];
  assert.deepEqual(aim(scene), { x: 180, y: 60 }, 'pool order, not distance');
  scene.enemies = [near, far];
  assert.deepEqual(aim(scene), { x: 200, y: 320 }, 'swapping order swaps the pick');
});

test('a cone-qualified boss locks the cache with min |dx|', () => {
  const scene = aimScene('sakuyaA');
  const mob = enemy(192, 300);
  const bossFar = enemy(120, 100, true);  // |dx| = 72
  const bossNear = enemy(230, 100, true); // |dx| = 38
  scene.enemies = [mob, bossFar, bossNear];
  assert.deepEqual(aim(scene), { x: 230, y: 100 }, 'boss beats the earlier mob; min |dx| among bosses');
});

test('non-Sakuya characters produce no knife-aim snapshot', () => {
  const scene = aimScene('reimuA');
  scene.enemies = [enemy(192, 100)];
  assert.equal(aim(scene), null);
});
