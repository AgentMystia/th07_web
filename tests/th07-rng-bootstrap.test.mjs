import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadEngine,
  makeStubAssets,
  makeStubAudio
} from '../scripts/lib/replay-harness.mjs';

const mod = await loadEngine();
const assets = makeStubAssets(mod);
const audio = makeStubAudio();
const rpy = new mod.Rpy(readFileSync('tests/replays/th7_udFe25.rpy'));

function sceneFor(stageIndex = 0) {
  const stage = rpy.stages[stageIndex];
  return new mod.StageScene(
    assets, audio, rpy.difficulty, rpy.character,
    stage.stage, null, stage.rngSeed
  );
}

function countDraws(scene) {
  let draws = 0;
  const original = scene.rng.u16.bind(scene.rng);
  scene.rng.u16 = () => {
    draws++;
    return original();
  };
  return () => draws;
}

test('replay stage seeds initialize the native death/item global counters', () => {
  const expected = [
    [0, 2], [2, 5], [1, 4], [2, 1], [1, 7], [2, 1]
  ];
  for (let i = 0; i < expected.length; i++) {
    const scene = sceneFor(i);
    assert.deepEqual(
      [scene.runtime.randomSpawnIndex, scene.runtime.randomItemIndex],
      expected[i],
      `stage ${i + 1}`
    );
  }
});

test('focus-in runs authored etama effect 24; focus-out only interrupts it', () => {
  const scene = sceneFor(0);
  scene.stageClear = true;
  scene.runtime.timelineCursors = scene.runtime.ecl.timelines.map((timeline) => ({
    index: timeline.length,
    frame: 0
  }));
  const draws = countDraws(scene);
  const input = new mod.ReplayInputSource();

  scene.update(input.frame(0x4));
  assert.equal(draws(), 2, 'focus-in time-0 op60 consumes one u32');
  assert.equal(scene.focusEffectRunner?.scriptId, 26);

  scene.update(input.frame(0));
  assert.equal(draws(), 2, 'focus-out writes interrupt label 1 without RNG');

  scene.update(input.frame(0x4));
  assert.equal(draws(), 4, 'reversing back into focus constructs a fresh effect');
});

test('power-item HUD refreshes preserve FUN_00401700 RNG costs', () => {
  const scene = sceneFor(0);
  const draws = countDraws(scene);
  const item = (type) => ({ type, x: 100, y: 100, state: 0, dead: false });

  scene.playerObj.power = 0;
  scene.collectItem(item('power'));
  assert.equal(draws(), 4, 'ordinary power gain calls FUN_00401700 once');
  assert.equal(scene.score, 1, 'below-cap power pickup credits one live score unit');

  scene.playerObj.power = 127;
  scene.collectItem(item('power'));
  assert.equal(draws(), 12, 'crossing full power calls FUN_00401700 twice');
  assert.equal(scene.score, 2, 'the crossing pickup still credits its one score unit');

  scene.playerObj.power = 64;
  scene.collectItem(item('fullPower'));
  assert.equal(draws(), 16, 'full-power item calls FUN_00401700 once');
  assert.equal(scene.score, 102, 'full-power item adds its separate 100-point award');
});

test('successful extend awards preserve FUN_00401700 RNG costs', () => {
  const scene = sceneFor(0);
  const draws = countDraws(scene);
  const item = (type) => ({ type, x: 100, y: 100, state: 0, dead: false });

  scene.playerObj.lives = 2;
  scene.playerObj.bombs = 3;
  scene.collectItem(item('life'));
  assert.equal(draws(), 4, 'life award calls FUN_00401700 once');

  scene.playerObj.lives = 8;
  scene.playerObj.bombs = 7;
  scene.collectItem(item('life'));
  assert.equal(draws(), 8, 'bomb fallback calls FUN_00401700 once');

  scene.playerObj.lives = 8;
  scene.playerObj.bombs = 8;
  scene.collectItem(item('life'));
  assert.equal(draws(), 8, 'capped award consumes no RNG');
});

test('bomb-item stock gain preserves FUN_0042bd01 HUD refresh RNG', () => {
  const scene = sceneFor(0);
  const draws = countDraws(scene);
  const bomb = () => ({ type: 'bomb', x: 100, y: 100, state: 0, dead: false });

  scene.playerObj.bombs = 7;
  scene.collectItem(bomb());
  assert.equal(scene.playerObj.bombs, 8);
  assert.equal(draws(), 4, 'successful bomb gain calls FUN_00401700 once');

  scene.collectItem(bomb());
  assert.equal(draws(), 4, 'capped bomb pickup skips the HUD refresh');
});

test('ECL op119 reads the live player power field', () => {
  const scene = sceneFor(2);
  const enemy = { x: 192, y: 96 };

  scene.playerObj.power = 127;
  scene.runtime.dropPowerItems(scene, enemy, 3);
  assert.deepEqual(scene.items.map((it) => it.type), ['bigPower', 'power', 'power']);

  scene.items.length = 0;
  scene.playerObj.power = 128;
  assert.equal(scene.power, 128, 'GameHost view follows the replay-restored player field');
  scene.runtime.dropPowerItems(scene, enemy, 3);
  assert.deepEqual(scene.items.map((it) => it.type), ['point', 'point', 'point']);
});

test('generic effect costs include authored ANM time-0 RNG and veto RNG', () => {
  const scene = sceneFor(0);
  const draws = countDraws(scene);

  scene.spawnEffectParticles(17, 0, 0, 1, 0xffffffff);
  assert.equal(draws(), 6, 'id17 = ANM 4 + veto 2');

  scene.spawnEffectParticles(22, 0, 0, 1, 0xffffffff, { x: 1, y: 0, z: 0 });
  assert.equal(draws(), 12, 'id22 ordinary positive launch = ANM 4 + veto 2');

  scene.spawnEffectParticles(22, 0, 0, 1, 0xffffffff, { x: -1, y: 0, z: 0 });
  assert.equal(draws(), 18, 'id22 ordinary negative launch follows the deterministic path');

  scene.spawnEffectParticles(22, 0, 0, 1, 0xffffffff, { x: -999, y: 0, z: 0 });
  assert.equal(draws(), 26, 'id22 -999 sentinel = ANM 4 + random-angle veto 4');

  scene.spawnEffectParticles(30, 0, 0, 1, 0xffffffff);
  assert.equal(draws(), 42, 'id30 = 16 raw draws per particle');

  scene.spawnEffectParticles(26, 0, 0, 1, 0xffffffff, { x: 1, y: 0, z: 0 });
  assert.equal(draws(), 56, 'id26 = 14 raw draws per particle');

  scene.spawnEffectParticles(27, 0, 0, 1, 0xffffffff, { x: 1, y: 0, z: 0 });
  assert.equal(draws(), 68, 'id27 = 12 raw draws per particle');

  scene.spawnEffectParticles(31, 0, 0, 1, 0xffffffff);
  assert.equal(draws(), 84, 'id31 = 16 raw draws per particle');
});

test('world ambient families share FUN_0041a050 slot release', () => {
  const scene = sceneFor(4);
  for (const effectId of [20, 26, 27, 30, 31]) {
    scene.spawnEffectParticles(effectId, 0, 0, 1, 0xffffffff, { x: 1, y: 0, z: 0 });
    const particle = scene.particles.at(-1);
    assert.ok(particle?.world, `id${effectId} owns native world-motion state`);
    particle.world.z = 10;
  }

  scene.updateParticles();

  assert.equal(scene.particles.length, 0,
    'all five DAT_00494fb0 families free their 400-pool slot when the shared gate rejects them');
  assert.equal(scene.effectSlots.filter(Boolean).length, 0);
});

test('world ambient ids 26/27 use the native 100-unit Z spread', () => {
  for (const effectId of [26, 27]) {
    const scene = sceneFor(3);
    const camera = scene.runtime.std.camera();
    const facing = scene.runtime.std.facing();
    const values = [0.25, 0.75, 0.5, 0.5, 0.5, 0.5];
    scene.rng.f = () => values.shift() ?? 0.5;

    scene.spawnEffectParticles(effectId, 0, 0, 1, 0xffffffff, { x: 1, y: 0, z: 0 });
    const particle = scene.particles.at(-1);
    assert.ok(particle?.world);
    assert.equal(particle.world.z, Math.fround(camera.z + facing.z / 2),
      `id${effectId} frand=0.5 centers Z at camera+facing/2`);
  }
});

test('spell declaration does not synthesize a generic RNG-consuming burst', () => {
  const scene = sceneFor(0);
  const draws = countDraws(scene);
  scene.bossActive = {
    x: 192,
    y: 96,
    ecl: { timerCallbackThreshold: 3000 }
  };

  scene.startBossSpell(0, 0, 'test');

  assert.equal(draws(), 0, 'FUN_0040ee30 allocates its dedicated presentation object without gameplay RNG');
  assert.equal(scene.particles.length, 0, 'spell declaration is not a generic id-3 particle request');
});

test('nonspell op91 cleanup does not run the spell-end helper sweep', () => {
  const scene = sceneFor(0);
  assert.equal(scene.spellcard, null);
  assert.equal(scene.endBossSpell(), false,
    'FUN_0040f340 is a no-op while DAT_012f40a8 is zero');
});

test('active-spell boss death preserves bullets for the following op91 sweep', () => {
  const scene = sceneFor(0);
  const stage = rpy.stages[0];
  const input = new mod.ReplayInputSource();

  for (let f = 0; f < 4658; f++) scene.update(input.frame(stage.inputs[f] ?? 0));
  assert.ok(scene.spellcard, 'Cirno spell is active immediately before the killing hit');
  assert.ok(scene.enemyBullets.length > 300, 'spell field is populated before boss death');

  scene.update(input.frame(stage.inputs[4658] ?? 0));
  assert.ok(scene.enemyBullets.length > 300,
    'mode-1 death retains the field until the callback sub executes');

  scene.update(input.frame(stage.inputs[4659] ?? 0));
  assert.equal(scene.enemyBullets.length, 0, 'callback op91 consumes the field');
  assert.ok(scene.items.some((item) => item.type === 'cherry'),
    'op91 converts the retained bullets into auto-collecting cherry items');
});

test('generic effects allocate from the native rolling 400-slot pool before drawing RNG', () => {
  const scene = sceneFor(2);
  const draws = countDraws(scene);

  scene.spawnEffectParticles(13, 0, 0, 400, 0xffffffff);
  assert.equal(scene.particles.length, 400);
  assert.equal(draws(), 0, 'persistent aura allocation itself draws no gameplay RNG');

  // Reproduce the Stage-3 processing-frame-939 pressure shape: the cursor is
  // 200 and only slots 200/201 are free. A requested four-snow burst must
  // allocate two particles (2 * 22 raw draws), then stop after one pool scan.
  scene.effectSlots[200] = null;
  scene.effectSlots[201] = null;
  scene.particles = scene.particles.filter((p) => p.poolSlot !== 200 && p.poolSlot !== 201);
  scene.effectPoolCursor = 200;
  scene.spawnEffectParticles(20, 0, 0, 4, 0xffffffff);
  assert.equal(draws(), 44);
  assert.equal(scene.effectSlots[200]?.effectId, 20);
  assert.equal(scene.effectSlots[201]?.effectId, 20);
  assert.equal(scene.particles.length, 400);
});

test('enemy-owned op100 auras release over the native sixteen effect ticks', () => {
  const scene = sceneFor(0);
  scene.spawnEffectParticles(13, 20, 30, 1, 0xffffffff, undefined, 77);
  scene.releaseEnemyEffects(77);
  for (let i = 0; i < 15; i++) scene.updateParticles();
  assert.equal(scene.particles.length, 1);
  scene.updateParticles();
  assert.equal(scene.particles.length, 0);
});

test('enemy-bullet slots preserve the native stale offscreen counter across reuse', () => {
  const scene = sceneFor(0);
  const bullet = (slot) => ({
    id: 7000 + slot,
    poolSlot: slot,
    ownerId: 1,
    ownerSub: 1,
    spawnFrame: 0,
    effectState: 0,
    x: -100,
    y: 100,
    vx: 0,
    vy: 0,
    speed: 0,
    angle: 0,
    age: 20,
    flags: 0,
    sprite: 0,
    spriteOffset: 0,
    rect: { x: 0, y: 0, w: 8, h: 8, imageKey: 'etama' },
    grazeW: 4,
    grazeH: 4,
    grazed: false,
    spawnAge: 0,
    spawnDuration: 0,
    spawnMoveScale: 1,
    exFlags: 0,
    exAccel: null,
    exAngle: null,
    exDir: null,
    exBounce: null,
    graceFrames: 0,
    offscreenFrames: 0
  });

  scene.enemyBulletOffscreenCounters[7] = 2;
  assert.equal(scene.addEnemyBullet(bullet(7)), true);
  assert.equal(scene.enemyBulletSlots[7].offscreenFrames, 2, 'allocation inherits slot storage');
  scene.updateBullets();
  assert.equal(scene.enemyBulletSlots[7].offscreenFrames, 1);
  scene.updateBullets();
  assert.equal(scene.enemyBulletSlots[7].offscreenFrames, 0);
  scene.updateBullets();
  assert.equal(scene.enemyBulletSlots[7], null, 'ordinary bullet dies only after stale grace drains');

  scene.enemyBulletOffscreenCounters[7] = 128;
  assert.equal(scene.addEnemyBullet(bullet(7)), true);
  assert.equal(scene.enemyBulletSlots[7].offscreenFrames, 128);
  scene.clearEnemyBullets();
  assert.equal(scene.addEnemyBullet(bullet(7)), true);
  assert.equal(scene.enemyBulletSlots[7].offscreenFrames, 128, 'field clears do not zero +0xbfe');
});

test('graze effect 8 uses the native Border/focus branch', () => {
  const scene = sceneFor(0);
  const draws = countDraws(scene);

  scene.onGrazeAward(200, 300);
  assert.equal(draws(), 4, 'outside a Border uses one white particle');

  scene.cherry.borderTimer = 100;
  scene.playerObj.focusHeld = false;
  scene.onGrazeAward(200, 300);
  assert.equal(draws(), 16, 'unfocused Border graze uses three red particles');

  scene.playerObj.focusHeld = true;
  scene.onGrazeAward(200, 300);
  assert.equal(draws(), 20, 'focused Border graze returns to one white particle');
});

test('enemy-body collision samples op138 trail history on the native six-slot stride', () => {
  const scene = sceneFor(0);
  const draws = countDraws(scene);
  const p = scene.playerObj;
  p.x = 100;
  p.y = 100;
  const history = Array.from({ length: 32 }, () => ({ x: 300, y: 300, z: 0 }));
  history[1] = { x: 100, y: 75, z: 0 };
  history[7] = { x: 100, y: 75, z: 0 };
  const enemy = {
    id: 999,
    x: 100,
    y: 75,
    dead: false,
    ecl: {
      collisionEnabled: true,
      interactable: true,
      invisible: false,
      sweepItemFlag: true,
      bossTimer: 6,
      bossTimerPrevious: 5,
      hitbox: { x: 8, y: 8, z: 32 },
      trailFlags: 25,
      trailStart: 16,
      trailHistory: history
    }
  };

  scene.collideEnemyBody(enemy);

  assert.equal(scene.graze, 3, 'head plus history slots 1 and 7 graze independently');
  assert.equal(draws(), 12, 'each graze allocates one native id8 particle');
});

test('player-shot impact release is visible to same-frame full-pool firing', () => {
  const scene = sceneFor(2);
  const stableRunner = () => ({
    removed: false,
    waiting: false,
    update() {},
    interrupt() { return false; }
  });
  const bullet = (poolSlot, expires = false) => ({
    poolSlot,
    x: 192,
    y: 224,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2,
    speed: 0,
    damage: 1,
    shotType: 0,
    behaviorFunc: 0,
    hitboxW: 12,
    hitboxH: 12,
    sfxId: -1,
    age: 0,
    state: expires ? 'collided' : 'fired',
    hitAge: 0,
    runner: expires
      ? {
          removed: false,
          waiting: false,
          update() { this.removed = true; },
          interrupt() { return false; }
        }
      : stableRunner(),
    impactScript: 96,
    orb: 0,
    anchorX: 0,
    rect: { x: 0, y: 0, w: 12, h: 12, imageKey: '' }
  });

  scene.playerBulletSlots.fill(null);
  scene.playerBullets = [];
  for (let slot = 0; slot < 96; slot++) {
    const b = bullet(slot, slot === 69);
    scene.playerBulletSlots[slot] = b;
    scene.playerBullets.push(b);
  }

  // Native player order is MOVE/ANM -> FIRE. The t20 impact in slot 69
  // releases during MOVE, and the immediately following full-power volley
  // must be able to reuse that one slot rather than dropping every record.
  scene.playerObj.power = 128;
  scene.playerObj.fireFrame = 0;
  scene.playerObj.prevFireFrame = -999;
  scene.updatePlayerBullets(false);
  assert.equal(scene.playerBulletSlots[69], null, 'impact frees before firing');
  scene.firePlayerBullets();
  assert.equal(scene.playerBullets.length, 96);
  assert.equal(scene.playerBulletSlots[69]?.state, 'fired', 'volley reuses the released slot');
});

test('late-stage non-boss damage reduction is ReimuA-only, not every A shot', () => {
  const makeEnemy = () => ({
    hp: 100,
    pendingShotDmg: 40,
    pendingBombDmg: 0,
    ecl: {
      isBoss: false,
      bossTimer: 0,
      canTakeDamage: true,
      damageShield: 0
    }
  });

  const sakuya = sceneFor(4);
  const sakuyaEnemy = makeEnemy();
  sakuya.settlePendingDamage(sakuyaEnemy);
  assert.equal(sakuyaEnemy.hp, 60, 'SakuyaA keeps full damage on stage 5');

  const stage = rpy.stages[4];
  const reimu = new mod.StageScene(
    assets, audio, rpy.difficulty, 'reimuA', stage.stage, null, stage.rngSeed
  );
  const reimuEnemy = makeEnemy();
  reimu.settlePendingDamage(reimuEnemy);
  assert.equal(reimuEnemy.hp, 80, 'ReimuA receives the stage 5 half-damage rule');
});
