import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/popups-cancel';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/stage-scene.ts --bundle --format=esm --outfile=${outDir}/stage-scene.mjs --log-level=silent`);
const { StageScene } = await import('../tests/.build/popups-cancel/stage-scene.mjs');

function popupScene() {
  const scene = Object.create(StageScene.prototype);
  scene.slowRate = 1;
  scene.playerObj = { x: -1000, y: -1000 };
  scene.popupsLarge = Array.from({ length: 720 }, () => ({
    digits: [0], color: 0, x: 0, y: 0, timer: 0, timerFrac: 0, active: false
  }));
  scene.popupsSmall = Array.from({ length: 3 }, () => ({
    digits: [0], color: 0, x: 0, y: 0, timer: 0, timerFrac: 0, active: false
  }));
  scene.popupCursorLarge = 0;
  scene.popupCursorSmall = 0;
  return scene;
}

function cancelScene() {
  const scene = Object.create(StageScene.prototype);
  scene.id = 1;
  scene.playerObj = { power: 0 };
  scene.items = [];
  scene.enemyBullets = [];
  scene.enemyBulletSlots = new Array(1024).fill(null);
  scene.enemyBulletOffscreenCounters = new Uint16Array(1024);
  scene.enemyLasers = [];
  scene.postBombLaserCounter = 0;
  scene.cancelItemType = 'cherry';
  scene.bombClearRegions = [];
  return scene;
}

function laser(overrides = {}) {
  return {
    inUse: true,
    flags: 0,
    state: 1,
    phaseFrame: 20,
    width: 12,
    displayWidth: 7,
    shrinkCutoff: 30,
    x: 10,
    y: 20,
    angle: 0,
    nearDist: 32,
    farDist: 97,
    ...overrides
  };
}

test('score popups rise 0.5px/tick, use the authored glyph banks, and retire after tick 60', () => {
  const scene = popupScene();
  scene.spawnScorePopup(10, 100, 200, 0xffffffff);
  const pop = scene.popupsLarge[0];
  const draws = [];
  const renderer = {
    ctx: { save() {}, restore() {} },
    drawSpriteInBatch: (...args) => draws.push(args)
  };

  scene.drawPopups(renderer, 0, 0);
  assert.deepEqual(draws.map((d) => d.slice(1, 5)), [[8, 0, 8, 8], [0, 0, 8, 8]]);

  for (let i = 0; i < 52; i++) scene.updatePopups();
  draws.length = 0;
  scene.drawPopups(renderer, 0, 0);
  assert.deepEqual(draws.map((d) => d.slice(1, 5)), [[136, 0, 8, 8], [128, 0, 8, 8]]);

  for (let i = 52; i < 56; i++) scene.updatePopups();
  draws.length = 0;
  scene.drawPopups(renderer, 0, 0);
  assert.deepEqual(draws.map((d) => d.slice(1, 5)), [[136, 8, 8, 8], [128, 8, 8, 8]]);

  for (let i = 56; i < 60; i++) scene.updatePopups();
  assert.equal(pop.active, true);
  assert.equal(pop.y, 170);
  scene.updatePopups();
  assert.equal(pop.active, false);
});

test('PowerUp popup uses ascii.anm sprite 10 rather than the HUD digit strip', () => {
  const scene = popupScene();
  scene.spawnScorePopup(-1, 100, 200, 0xffffc0a0);
  const draws = [];
  scene.drawPopups({
    ctx: { save() {}, restore() {} },
    drawSpriteInBatch: (...args) => draws.push(args)
  }, 0, 0);
  assert.deepEqual(draws[0].slice(1, 5), [80, 0, 48, 8]);
});

test('FUN_00422ea0(1) converts live bullets and samples non-immune lasers every 32px', () => {
  const scene = cancelScene();
  scene.enemyBullets.push({ x: 1, y: 2 }, { x: 3, y: 4, dead: true });
  const normal = laser();
  const immune = laser({ x: 200, flags: 4 });
  scene.enemyLasers.push(normal, immune);
  scene.enemyBulletOffscreenCounters[519] = 38;

  scene.cancelBulletsToItems();

  assert.deepEqual(scene.items.map((it) => [it.type, it.x, it.y, it.state]), [
    ['cherry', 1, 2, 1],
    ['cherry', 42, 20, 1],
    ['cherry', 74, 20, 1],
    ['cherry', 106, 20, 1]
  ]);
  assert.equal(scene.enemyBullets.length, 0);
  assert.equal(scene.enemyBulletOffscreenCounters[519], 0,
    'FUN_00422ea0 item conversion zeroes the complete fixed bullet slot');
  assert.equal(normal.state, 2);
  assert.equal(normal.width, 7);
  assert.equal(normal.shrinkCutoff, 0);
  assert.equal(immune.state, 1);
  assert.equal(scene.postBombLaserCounter, 10);
});

test('Stage-6 pre-boss cancel type promotes subsequent clears from 6 to 9', () => {
  const scene = cancelScene();
  scene.cancelItemType = 'case9Cherry';
  scene.enemyBullets.push({ x: 1, y: 2 });

  scene.cancelBulletsToItems();

  assert.deepEqual(scene.items.map((it) => [it.type, it.state]), [['case9Cherry', 1]]);
});

test('FUN_00423100 sweep converts immune lasers but excludes laser items from score total', () => {
  const scene = cancelScene();
  scene.enemyBullets.push({ x: 1, y: 2 }, { x: 3, y: 4, dead: true });
  scene.enemyLasers.push(laser({ flags: 4, nearDist: 0, farDist: 33 }));
  scene.enemyBulletOffscreenCounters[519] = 38;
  const popups = [];
  scene.spawnScorePopup = (...args) => popups.push(args);

  assert.equal(scene.sweepBulletsToItems(), 2000);
  assert.deepEqual(popups, [[2000, 1, 2, 0xffffffff]]);
  // Bullet + laser origin + d=0 + d=32. The duplicate origin is native.
  assert.equal(scene.items.length, 4);
  assert.equal(scene.enemyLasers[0].state, 2);
  assert.equal(scene.enemyBulletOffscreenCounters[519], 38,
    'FUN_00423100 state-5 sweep preserves the slot-local off-screen counter');
});

test('type-9 cancel Cherry shares case-6 score but awards +100 cherryPlus', () => {
  const scene = cancelScene();
  scene.graze = 400;
  scene.score = 0;
  scene.playerObj.sht = { pocLineY: 128 };
  scene.playSfx = () => {};
  scene.addScore = (value) => { scene.score += value; };
  const popups = [];
  scene.spawnScorePopup = (...args) => popups.push(args);
  let case9Awards = 0;
  scene.cherry = {
    grazeScaledItemScore: () => 40,
    onCase9CherryItem: () => { case9Awards++; }
  };
  const item = { type: 'case9Cherry', x: 12, y: 34, dead: false };

  scene.collectItem(item);

  assert.equal(item.dead, true);
  assert.equal(scene.score, 40);
  assert.equal(case9Awards, 1);
  assert.deepEqual(popups, [[400, 12, 34, 0xffffffff, true]]);
});

test('bomb attack slots convert bullets to small cherry even at full power', () => {
  const scene = cancelScene();
  scene.playerObj.power = 128;
  scene.playerObj.character = 'sakuyaA';
  scene.slowRate = 1;
  scene.bombFrame = 0;
  scene.enemies = [];
  scene.enemyBullets.push(
    { x: 12, y: 34, flags: 0, dead: false },
    { x: 12, y: 34, flags: 0x1000, dead: false }
  );
  scene.tickBombChoreography = () => {};
  scene.activeBombSlots = [];
  let slotScans = 0;
  scene.bombEngine = {
    beginFrame() {},
    activeSlots: () => {
      slotScans++;
      return [{ x: 12, y: 34, radiusX: 16, radiusY: 16, damage: 1, hitTally: 0 }];
    }
  };

  scene.applyBombEffects();

  assert.equal(scene.enemyBullets[0].dead, false);
  assert.equal(scene.enemyBullets[0].clearFadeFrames, 12,
    'FUN_004241c0 state 5 retains the occupied fixed slot for its removal ANM');
  assert.equal(scene.enemyBullets[1].dead, false);
  assert.equal(slotScans, 1, 'the fixed attack-slot pool is scanned once per bomb frame');
  assert.deepEqual(scene.items.map((it) => [it.type, it.state]), [['cherry', 1]]);
});

test('MarisaB shot helper slots never act as enemy-bullet clear regions', () => {
  const scene = cancelScene();
  scene.playerObj.character = 'marisaB';
  scene.slowRate = 1;
  scene.bombFrame = 0;
  scene.enemies = [];
  const bullet = { x: 260, y: 130, flags: 0, dead: false };
  scene.enemyBullets.push(bullet);
  scene.tickBombChoreography = () => {};
  scene.activeBombSlots = [];
  scene.bombEngine = {
    beginFrame() {},
    activeSlots: () => [{
      poolSlot: 96,
      x: 260,
      y: 35,
      radiusX: 10,
      radiusY: 210,
      damage: 1,
      hitTally: 0,
      active: true,
      source: 'shot'
    }]
  };

  scene.applyBombEffects();

  assert.equal(bullet.clearFadeFrames, undefined);
  assert.equal(bullet.dead, false);
  assert.equal(scene.items.length, 0);
});

test('an unfocused MarisaB beam owner outlives its removed ANM until countdown zero', () => {
  const scene = Object.create(StageScene.prototype);
  const bullet = {
    dead: true,
    behaviorFunc: 2,
    fadePending: false,
    runner: { removed: true }
  };
  scene.slowRate = 1;
  scene.playerObj = {
    laserSlots: [{ bullet, timer: 2, fading: false, shot: {} }, null, null],
    focusHeld: false,
    shooting: true,
    bombTimer: 0
  };
  scene.isDialogueBlocking = () => false;

  scene.tickLaserSlots();
  assert.equal(scene.playerObj.laserSlots[0]?.timer, 1);
  scene.tickLaserSlots();
  assert.equal(scene.playerObj.laserSlots[0], null);
});

test('MarisaB release clamp waits for the armed 30-frame shot cycle to finish', () => {
  const scene = Object.create(StageScene.prototype);
  const bullet = { dead: false, behaviorFunc: 2, fadePending: false, runner: { removed: false } };
  scene.slowRate = 1;
  scene.playerObj = {
    laserSlots: [{ bullet, timer: 100, fading: false, shot: {} }, null, null],
    focusHeld: false,
    shooting: false,
    fireFrame: 5,
    bombTimer: 0
  };
  scene.isDialogueBlocking = () => false;

  scene.tickLaserSlots();
  assert.equal(scene.playerObj.laserSlots[0]?.timer, 99, 'released key alone does not clamp an armed cycle');
  scene.playerObj.fireFrame = -1;
  scene.tickLaserSlots();
  assert.equal(scene.playerObj.laserSlots[0]?.timer, 50);
});

test('focused MarisaB beam keeps the native 999 infinite-countdown sentinel', () => {
  const scene = Object.create(StageScene.prototype);
  const bullet = {
    dead: false,
    behaviorFunc: 3,
    fadePending: false,
    runner: { removed: false }
  };
  scene.slowRate = 1;
  scene.playerObj = {
    laserSlots: [null, null, { bullet, timer: 999, fading: false, shot: {} }],
    focusHeld: true,
    fireFrame: 4,
    bombTimer: 0
  };
  scene.isDialogueBlocking = () => false;

  for (let i = 0; i < 930; i++) scene.tickLaserSlots();

  assert.equal(scene.playerObj.laserSlots[2]?.timer, 999);
  assert.equal(bullet.fadePending, false);
  assert.equal(bullet.dead, false);
});

test('focus transition restarts an already-running unfocused MarisaB release fade', () => {
  const scene = Object.create(StageScene.prototype);
  const interrupts = [];
  const bullet = {
    dead: false,
    behaviorFunc: 2,
    fadePending: true,
    runner: {
      waiting: false,
      removed: false,
      interrupt(label) { interrupts.push(label); return true; }
    }
  };
  scene.slowRate = 1;
  scene.playerObj = {
    laserSlots: [{ bullet, timer: 48, fading: false, shot: {} }, null, null],
    focusHeld: true,
    fireFrame: -1,
    bombTimer: 0
  };
  scene.isDialogueBlocking = () => false;

  scene.tickLaserSlots();

  assert.deepEqual(interrupts, [1], 'focus teardown requests label 1 even away from waitInt');
  assert.equal(bullet.fadePending, false);
  assert.equal(scene.playerObj.laserSlots[0], null);
});

test('attack-slot contacts still tally against an op103-invulnerable enemy', () => {
  const scene = Object.create(StageScene.prototype);
  const enemy = {
    x: 64,
    y: 128,
    ecl: {
      hitbox: { x: 96, y: 96, z: 96 },
      canTakeDamage: false,
      interactable: true,
      shotCollision: true
    }
  };
  scene.activeBombSlots = Array.from({ length: 16 }, (_, i) => ({
    poolSlot: 96 + i,
    x: 58,
    y: 84 + i,
    radiusX: 10,
    radiusY: 304,
    damage: 1,
    hitTally: 0,
    source: 'shot'
  }));
  scene.playerObj = { bombTimer: 0 };
  scene.playerHitTally = 47;
  const damage = [];
  const effects = [];
  scene.damageEnemy = (_enemy, amount, kind) => damage.push({ amount, kind });
  scene.spawnEffectParticles = (id) => effects.push(id);

  scene.collideBombSlots(enemy);

  assert.equal(damage.length, 16);
  assert.deepEqual(damage[0], { amount: 1, kind: 'shot' });
  assert.equal(scene.playerHitTally, 63);
  assert.deepEqual(effects, [5, 5, 5, 5]);
});

test('focused-beam teardown skips its same-frame history-helper callback', () => {
  const scene = Object.create(StageScene.prototype);
  const bullet = {
    dead: false,
    behaviorFunc: 3,
    shotType: 5,
    runner: { removed: false }
  };
  scene.slowRate = 1;
  scene.playerObj = {
    laserSlots: [null, null, { bullet, timer: 999, fading: false, shot: {} }],
    focusHeld: false,
    shooting: true,
    bombTimer: 0
  };
  scene.playerBulletSlots = new Array(96).fill(null);
  scene.playerBulletSlots[1] = bullet;
  scene.playerBullets = [bullet];
  scene.bombEngine = { beginFrame() {} };
  scene.syncPlayerBulletSlots = () => {};
  scene.isDialogueBlocking = () => false;
  scene.compactLive = () => {};
  scene.refreshActiveAttackSlots = () => {};
  let anchors = 0;
  scene.anchorBeamBullet = () => { anchors++; };

  scene.updatePlayerBullets();

  assert.equal(bullet.dead, true);
  assert.equal(scene.playerBulletSlots[1], null);
  assert.equal(scene.playerObj.laserSlots[2], null);
  assert.equal(anchors, 0);
});

test('bomb clear regions consume young bullets and state 5 releases after 12 half-speed ticks', () => {
  const scene = cancelScene();
  scene.playerObj = { power: 0, character: 'reimuA' };
  scene.slowRate = 1;
  scene.bombFrame = 0;
  scene.enemies = [];
  scene.activeBombSlots = [];
  scene.bombClearRegions = [{ x: 100, y: 100, radius: 128, growth: 0, framesLeft: 1 }];
  scene.bombEngine = {
    beginFrame() {},
    activeSlots: () => []
  };
  scene.tickBombChoreography = () => {};
  const bullet = {
    poolSlot: 666,
    x: 120,
    y: 100,
    vx: 4,
    vy: 2,
    age: 2,
    flags: 0,
    grazed: false,
    dead: false
  };
  scene.enemyBullets.push(bullet);
  scene.enemyBulletSlots[666] = bullet;

  scene.applyBombEffects();
  assert.equal(bullet.clearFadeFrames, 12, 'the 16-frame gate applies to graze, not clear regions');
  assert.equal(scene.enemyBulletSlots[666], bullet);

  for (let i = 0; i < 11; i++) scene.updateBullets();
  assert.equal(scene.enemyBulletSlots[666], bullet);
  assert.equal(bullet.x, 142);
  assert.equal(bullet.y, 111);
  scene.updateBullets();
  assert.equal(scene.enemyBulletSlots[666], null);
  assert.equal(bullet.dead, true);
  assert.equal(bullet.x, 144);
  assert.equal(bullet.y, 112);
});

test('enemy-bullet offscreen cull runs before bomb clear-zone collision', () => {
  const scene = cancelScene();
  scene.playerObj = { power: 0, character: 'reimuA', alive: true };
  scene.slowRate = 1;
  scene.frame = 10470;
  scene.borderClearWave = null;
  scene.bombClearRegions = [{ x: 348.3785400390625, y: 335.63238525390625, radius: 128, growth: 0, framesLeft: 1 }];
  scene.compactLive = () => {};
  scene.syncEnemyBulletSlots = () => {};
  scene.checkEnemyBulletCollision = () => assert.fail('an offscreen-freed bullet must not reach collision');
  scene.updateBulletMotion = (b) => {
    b.x = Math.fround(b.x + b.vx);
    b.y = Math.fround(b.y + b.vy);
    return true;
  };
  const bullet = {
    poolSlot: 730,
    x: 391.91461181640625,
    y: 216.48721313476562,
    vx: 0.344669371843338,
    vy: 0.2243940234184265,
    age: 289,
    spawnAge: 24,
    spawnDuration: 24,
    graceFrames: 0,
    exFlags: 0,
    flags: 0,
    grazed: false,
    dead: false,
    rect: { w: 16, h: 16 }
  };
  scene.enemyBullets = [bullet];
  scene.enemyBulletSlots[730] = bullet;

  scene.updateBullets();

  assert.equal(bullet.dead, true);
  assert.equal(scene.enemyBulletSlots[730], null);
  assert.equal(bullet.clearFadeFrames, undefined);
  assert.equal(scene.items.length, 0, 'native cull does not spawn a bomb-clear Cherry');
});

test('Border direct-hit and expanding-wave clears retain bullet slots through state 5', () => {
  const scene = cancelScene();
  const direct = { poolSlot: 959, x: 263, y: 138, flags: 0x1000, dead: false };
  const swept = { poolSlot: 816, x: 240, y: 122, flags: 0, dead: false };

  assert.equal(scene.beginBulletClearFade(direct, undefined, true), true);
  assert.equal(direct.clearFadeFrames, 12);
  assert.equal(direct.dead, false);
  assert.equal(scene.items.length, 0, 'the touching bullet yields no item');

  assert.equal(scene.beginBulletClearFade(swept, 'pointBullet'), true);
  assert.equal(swept.clearFadeFrames, 12);
  assert.equal(swept.dead, false);
  assert.deepEqual(scene.items.map((item) => [item.type, item.state]), [['pointBullet', 1]]);
});

test('a mid-manager Border break is visible to every later bullet slot', () => {
  const scene = cancelScene();
  scene.slowRate = 1;
  scene.frame = 11715;
  scene.playerObj = { power: 0, character: 'reimuA', bombFocused: false };
  scene.borderClearWave = null;
  scene.syncEnemyBulletSlots = () => {};
  scene.compactLive = () => {};
  scene.updateBulletMotion = () => true;
  scene.cancelBulletWithBombSlots = () => false;
  const bullet = (poolSlot, x) => ({
    poolSlot, x, y: 100, vx: 0, vy: 0, age: 20,
    spawnAge: 0, spawnDuration: 0, graceFrames: 0,
    flags: 0, exFlags: 0, grazed: false, dead: false,
    rect: { w: 4, h: 4 }
  });
  const source = bullet(2, 100);
  const later = bullet(1, 110);
  scene.enemyBullets = [later, source];
  scene.enemyBulletSlots[1] = later;
  scene.enemyBulletSlots[2] = source;
  scene.checkEnemyBulletCollision = (b) => {
    assert.equal(b, source, 'the later slot must be intercepted before collision');
    scene.borderClearWave = { x: 100, y: 100, radius: 32, ticksLeft: 50, createdFrame: scene.frame };
  };

  scene.updateBullets();

  assert.equal(later.clearFadeFrames, 12);
  assert.deepEqual(scene.items.map((item) => [item.type, item.state]), [['pointBullet', 1]]);
});

test('bomb teardown leaves timed clear-region pool entries alive', () => {
  const scene = Object.create(StageScene.prototype);
  const region = { x: 259.8, y: 206.4, radius: 166.4, growth: Math.fround(64 / 15), framesLeft: 7 };
  scene.bombClearRegions = [region];
  scene.activeBombSlots = [{ active: true }];
  scene.bombRunner = {};
  let interrupted = 0;
  let reset = 0;
  scene.playerEffects = { interruptAll(label) { interrupted = label; } };
  scene.bombEngine = { reset() { reset++; } };

  scene.finishBombPresentation();

  assert.equal(interrupted, 1);
  assert.equal(reset, 1);
  assert.equal(scene.bombRunner, null);
  assert.deepEqual(scene.activeBombSlots, []);
  assert.deepEqual(scene.bombClearRegions, [region],
    'FUN_0043d8f0, not the bomb-active flag, owns clear-region retirement');
});
