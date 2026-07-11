import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// ITEM-001: the Point-of-Collection trigger must LATCH (Th07.exe
// FUN_00430c10 @ 0x430eb2-0x430f1e writes item+0x27f=1 permanently the first
// frame the trigger holds). Trigger: (round(power)>=128 OR shot is Sakuya)
// AND player.y < pocLine (strict). Leaving the trigger zone afterwards must
// not stop the item from homing.

const outDir = 'tests/.build/poc-latch';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/stage-scene.ts --bundle --format=esm --outfile=${outDir}/stage-scene.mjs --log-level=silent`);
const { StageScene } = await import('../tests/.build/poc-latch/stage-scene.mjs');

function itemScene({ power = 128, character = 'reimuA', x = 192, y = 100 } = {}) {
  const scene = Object.create(StageScene.prototype);
  scene.slowRate = 1;
  scene.items = [];
  scene.cherry = { borderActive: false };
  scene.playerObj = {
    x, y, power, character,
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

test('below full power the POC needs a Sakuya shot; Reimu/Marisa do not trigger', () => {
  const reimu = itemScene({ power: 127, y: 100, character: 'reimuA' });
  const it1 = addItem(reimu);
  reimu.updateItems();
  assert.equal(it1.state, 0, 'ReimuA below 128 power never latches');

  // Th07.exe 0x430ee7: shotType>=4 (SakuyaA/B) skips the power>=128 gate.
  const sakuya = itemScene({ power: 0, y: 100, character: 'sakuyaA' });
  const it2 = addItem(sakuya);
  sakuya.updateItems();
  assert.equal(it2.state, 1, 'Sakuya latches at any power');
});

test('border force-collect still latches every item', () => {
  const scene = itemScene({ power: 0, y: 400 });
  scene.cherry.borderActive = true;
  const it = addItem(scene);
  scene.updateItems();
  assert.equal(it.state, 1);
});

test('unlatched items keep ordinary gravity fall', () => {
  const scene = itemScene({ power: 0, y: 400 });
  const it = addItem(scene, { x: 50, y: 50 });
  scene.updateItems();
  assert.equal(it.state, 0);
  assert.ok(Math.abs(it.vy - -2.17) < 1e-9, 'gravity accel applied');
  assert.equal(it.x, 50, 'no horizontal drift');
});
