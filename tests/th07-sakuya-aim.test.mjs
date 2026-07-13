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

function aim(scene, enemies) {
  // The native cache is accumulated inside FUN_0041ed50's per-enemy loop.
  // Exercise the same seam in ascending fixed-pool order instead of calling
  // the removed whole-array cache helper.
  scene.clearPlayerAimCaches();
  for (const e of enemies) scene.accumulatePlayerAimCaches(e);
  return scene.sakuyaAim;
}

test('Sakuya only aims at enemies within ±30° of straight up', () => {
  const scene = aimScene('sakuyaA');
  const above = enemy(200, 120);   // ~ -88°: inside the cone
  const beside = enemy(330, 390);  // ~ -4°: outside
  const diagonal = enemy(330, 260); // ~ -45°: outside (cone edge is -60°)
  assert.equal(aim(scene, [beside, diagonal]), null, 'nothing inside the cone');
  assert.deepEqual(aim(scene, [beside, diagonal, above]), { x: 200, y: 120 },
    'only the in-cone enemy qualifies');
});

test('first cone-qualified non-boss in pool order wins, not the nearest', () => {
  const scene = aimScene('sakuyaA');
  const far = enemy(180, 60);   // in cone, far from the player
  const near = enemy(200, 320); // in cone, much closer
  assert.deepEqual(aim(scene, [far, near]), { x: 180, y: 60 }, 'pool order, not distance');
  assert.deepEqual(aim(scene, [near, far]), { x: 200, y: 320 }, 'swapping order swaps the pick');
});

test('a cone-qualified boss locks the cache with min |dx|', () => {
  const scene = aimScene('sakuyaA');
  const mob = enemy(192, 300);
  const bossFar = enemy(120, 100, true);  // |dx| = 72
  const bossNear = enemy(230, 100, true); // |dx| = 38
  assert.deepEqual(aim(scene, [mob, bossFar, bossNear]), { x: 230, y: 100 },
    'boss beats the earlier mob; min |dx| among bosses');
});

test('non-Sakuya characters produce no knife-aim snapshot', () => {
  const scene = aimScene('reimuA');
  assert.equal(aim(scene, [enemy(192, 100)]), null);
});

test('SakuyaA spawn aim preserves the native staged float32 pipeline', () => {
  const scene = aimScene('sakuyaA');
  scene.sakuyaAim = { x: 247.86310958862305, y: 204.88897781372071 };
  const bullet = {
    x: 325.2265319824219,
    y: 333.8155212402344,
    angle: -1.5707963705062866,
    speed: 12,
    vx: 0,
    vy: -12
  };

  scene.aimBulletAtSpawn(bullet);

  // FUN_00439070 @ 0x4390c6-0x43913f stores dx, dy, atan2, the
  // angle+pi/2 operand, normalized angle, boosted speed, and final vector
  // through float32 fields in this order. These are the exact results for
  // the Stage-2 processing-9297 slot-32 setup on the WT-side target cache.
  assert.equal(bullet.angle, -2.1112585067749023);
  assert.equal(bullet.speed, 18);
  assert.equal(bullet.vx, -9.261582374572754);
  assert.equal(bullet.vy, -15.434477806091309);
});
