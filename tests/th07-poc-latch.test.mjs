import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// ITEM-001: the Point-of-Collection trigger must LATCH (Th07.exe
// FUN_00430c10 @ 0x430eb2-0x430f1e writes item+0x27f=1 permanently the first
// frame the trigger holds). Trigger: (round(power)>=128 OR difficulty>3)
// AND player.y < pocLine (strict). DAT_0061c260 is the difficulty byte, not
// the character selector. Leaving the trigger zone afterwards must not stop
// the item from homing.

const outDir = 'tests/.build/poc-latch';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/stage-scene.ts --bundle --format=esm --outfile=${outDir}/stage-scene.mjs --log-level=silent`);
const { StageScene } = await import('../tests/.build/poc-latch/stage-scene.mjs');

function itemScene({ power = 128, character = 'reimuA', difficulty = 3, x = 192, y = 100 } = {}) {
  const scene = Object.create(StageScene.prototype);
  scene.id = 1;
  scene.slowRate = 1;
  scene.difficulty = difficulty;
  scene.items = [];
  scene.cherry = { borderActive: false };
  scene.playerObj = {
    x, y, power, character, materializeFrame: -1,
    alive: true,
    sht: { pocLineY: 128, autocollectSpeed: 8, itemRadius: 24 }
  };
  scene.playSfx = () => {};
  scene.collected = [];
  scene.collectItem = (it) => {
    it.dead = true;
    scene.collected.push(it.type);
  };
  return scene;
}

function addItem(scene, overrides = {}) {
  const it = { id: 1, x: 300, y: 300, vx: 0, vy: -2.2, type: 'point', age: 0, state: 0, ...overrides };
  scene.items.push(it);
  return it;
}

const dist = (scene, it) => Math.hypot(it.x - scene.playerObj.x, it.y - scene.playerObj.y);

test('POC crossing latches state 1 and the item keeps homing after the player drops below the line', () => {
  const scene = itemScene({ power: 128, y: 100 }); // above pocLine 128
  const it = addItem(scene);
  scene.updateItems();
  assert.equal(it.state, 1, 'state latched on the crossing frame');
  // Player retreats below the line; the latch must persist and the distance
  // must converge monotonically (PLAN.md ITEM-001 acceptance).
  scene.playerObj.y = 400;
  let prev = dist(scene, it);
  for (let i = 0; i < 30 && !it.dead; i++) {
    scene.updateItems();
    assert.equal(it.state, 1, `state stays latched (frame ${i})`);
    const d = dist(scene, it);
    assert.ok(d < prev, `distance converges (frame ${i}: ${d} < ${prev})`);
    prev = d;
  }
  assert.ok(it.dead, 'item is eventually collected');
  assert.deepEqual(scene.collected, ['point']);
});

test('POC boundary is strict: y == pocLine does not trigger, y just above does', () => {
  const onLine = itemScene({ power: 128, y: 128 });
  const it1 = addItem(onLine);
  onLine.updateItems();
  assert.equal(it1.state, 0, 'y == pocLineY must NOT trigger (exe FCOMP strict <)');

  const above = itemScene({ power: 128, y: 127.9 });
  const it2 = addItem(above);
  above.updateItems();
  assert.equal(it2.state, 1);
});

test('below full power no character triggers POC on Lunatic; Extra bypasses the power gate', () => {
  const reimu = itemScene({ power: 127, y: 100, character: 'reimuA' });
  const it1 = addItem(reimu);
  reimu.updateItems();
  assert.equal(it1.state, 0, 'ReimuA below 128 power never latches');

  // Th07.exe 0x430ee7 reads difficulty, so Sakuya has no character-specific
  // bypass on Lunatic.
  const sakuya = itemScene({ power: 0, y: 100, character: 'sakuyaA' });
  const it2 = addItem(sakuya);
  sakuya.updateItems();
  assert.equal(it2.state, 0, 'low-power Sakuya does not latch on Lunatic');

  const extra = itemScene({ power: 0, y: 100, character: 'reimuA', difficulty: 4 });
  const it3 = addItem(extra);
  extra.updateItems();
  assert.equal(it3.state, 1, 'Extra/Phantasm difficulty bypasses the power gate');
});

test('border force-collect still latches every item', () => {
  const scene = itemScene({ power: 0, y: 400 });
  scene.cherry.borderActive = true;
  const it = addItem(scene);
  scene.updateItems();
  assert.equal(it.state, 1);
  assert.equal(it.guaranteedMax, true, 'Border also latches native +0x280 max-value flag');
});

test('state-1 homing stores the native float32 velocity then runs the common gravity tail', () => {
  const scene = itemScene({ power: 128, x: 192, y: 100 });
  const it = addItem(scene, { x: 300, y: 300 });
  const dx = Math.fround(scene.playerObj.x - it.x);
  const dy = Math.fround(scene.playerObj.y - it.y);
  const angle = Math.fround(Math.atan2(dy, dx));
  const vx = Math.fround(Math.cos(angle) * scene.playerObj.sht.autocollectSpeed);
  const vy = Math.fround(Math.sin(angle) * scene.playerObj.sht.autocollectSpeed);

  scene.updateItems();

  assert.equal(it.vx, vx, 'FUN_004074e0 writes vx to item+0x258');
  assert.equal(it.x, Math.fround(300 + Math.fround(vx)), 'common integration consumes stored vx');
  assert.equal(it.y, Math.fround(300 + Math.fround(vy)), 'gravity is after position integration');
  assert.equal(it.vy, Math.fround(vy + Math.fround(0.03)),
    'the common gravity tail also executes for state-1 homing');
});

test('respawn materialize clears homing but retains vx for its transition tick', () => {
  const scene = itemScene({ power: 0, x: 192, y: 400 });
  scene.playerObj.materializeFrame = 0;
  const it = addItem(scene, { x: 50, y: 50, vx: 2, vy: 7, state: 1 });

  scene.updateItems();

  assert.equal(it.state, 0);
  assert.equal(it.x, 52, '0x430f73 writes only vy; the previous vx survives this tick');
  assert.equal(it.y, 49.5);
  assert.equal(it.vy, Math.fround(-0.5 + Math.fround(0.03)));
});

test('unlatched items keep ordinary gravity fall', () => {
  const scene = itemScene({ power: 0, y: 400 });
  const it = addItem(scene, { x: 50, y: 50 });
  scene.updateItems();
  assert.equal(it.state, 0);
  assert.equal(it.vy, Math.fround(Math.fround(-2.2) + 0.03), 'gravity writes back as float32');
  assert.equal(it.x, 50, 'no horizontal drift');
});

test('item allocation is rotating next-fit and manager iteration is fixed-slot order', () => {
  const scene = itemScene({ power: 0, x: 192, y: 400 });
  scene.playerObj.alive = false;
  scene.spawnItem('power', 50, 50);
  scene.spawnItem('point', 60, 50);
  scene.spawnItem('cherry', 70, 50);
  assert.deepEqual(scene.items.map((it) => it.poolSlot), [0, 1, 2]);

  scene.items[1].dead = true;
  scene.updateItems();
  scene.itemPoolCursor = 1;
  scene.spawnItem('bomb', 80, 50);
  assert.deepEqual(scene.items.map((it) => it.poolSlot), [0, 1, 2],
    'a freed physical slot is reused and the dense view remains slot-sorted');

  const order = [];
  scene.playerObj.alive = true;
  for (const it of scene.items) {
    it.x = scene.playerObj.x;
    it.y = scene.playerObj.y;
    it.state = 1;
  }
  scene.collectItem = (it) => {
    order.push(it.poolSlot);
    it.dead = true;
  };
  scene.updateItems();
  assert.deepEqual(order, [0, 1, 2], 'FUN_00430c10 scans slots 0..1099');
});
