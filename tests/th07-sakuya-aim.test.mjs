import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// Sakuya's aimed knives (SHT funcs[0] == 4, the whole ply02as focused set)
// use a target cache with a maximum firing angle: an enemy qualifies only
// while the angle from the PLAYER to it lies in [-120°, -60°) — ±30° around
// straight up (Th07.exe FUN_0041ed50 @ all.c:14267-14278, character gate
// DAT_00625625 == 2, cone floats @ 0x48edc4/0x48edc0 = -2π/3 / -π/3).

const outDir = 'tests/.build/sakuya-aim';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/stage-scene.ts --bundle --format=esm --outfile=${outDir}/stage-scene.mjs --log-level=silent`);
const { StageScene } = await import('../tests/.build/sakuya-aim/stage-scene.mjs');

function aimScene(character) {
  const scene = Object.create(StageScene.prototype);
  scene.playerObj = { x: 192, y: 400, character };
  scene.enemies = [];
  return scene;
}

function enemy(x, y) {
  return {
    x, y, dead: false,
    ecl: { interactable: true, invisible: false, canTakeDamage: true, shotCollision: true }
  };
}

test('Sakuya only aims at enemies within ±30° of straight up', () => {
  const scene = aimScene('sakuyaA');
  const above = enemy(200, 120);   // ~ -88°: inside the cone
  const beside = enemy(330, 390);  // ~ -4°: outside
  const diagonal = enemy(330, 260); // ~ -45°: outside (cone edge is -60°)
  scene.enemies = [beside, diagonal];
  assert.equal(scene.findAimTarget(192, 392), null, 'nothing inside the cone');
  scene.enemies = [beside, diagonal, above];
  assert.equal(scene.findAimTarget(192, 392), above, 'only the in-cone enemy qualifies');
});

test('the cone is measured from the player, not the bullet', () => {
  const scene = aimScene('sakuyaB');
  const above = enemy(192, 100);
  scene.enemies = [above];
  // Bullet far to the side: still aims, because the PLAYER->enemy angle is
  // what the exe cache tests.
  assert.equal(scene.findAimTarget(40, 200), above);
});

test('other characters keep the unrestricted nearest search', () => {
  const scene = aimScene('reimuA');
  const beside = enemy(330, 390);
  scene.enemies = [beside];
  assert.equal(scene.findAimTarget(192, 392), beside);
});
