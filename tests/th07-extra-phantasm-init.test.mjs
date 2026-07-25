import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, makeStubAssets, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// Extra/Phantasm run-init (Th07.exe FUN_0042cf2f @ all.c:19661-19934).
//
// Native provenance for the expected values:
//   lives      forced to 2 for difficulty > 3 (all.c:19715-19717, CONFIRMED)
//   power      untouched -> Player::Init's 0. The old port forced 128 from the
//              community "Extra starts maxed" convention; the stage-7 entry
//              snapshots of two native replays (T7RP sub-header +0x22, written
//              by the original engine) both record power=0:
//                th7_udHm54 marisaB Extra    power=0 lives=2 bombs=2
//                th7_udSg10 reimuA  Phantasm power=0 lives=2 bombs=3
//   bombs      the character's SHT bomb_per_life, same as every other route
//              (+0x24 above matches ply01b=2 / ply00b=3 exactly)
//   cherry     Extra 200000/400000, Phantasm 300000/400000 (all.c:19775-19781)
//   extend     the Extra/Phantasm point-item ladder starts at 200 (all.c:22101)
const mod = await loadEngine();
const assets = makeStubAssets(mod);
const audio = makeStubAudio();

function freshRun(difficulty, character) {
  return new mod.StageScene(
    assets,
    audio,
    difficulty,
    character,
    difficulty === 5 ? 8 : 7,
    null,
    0x1234
  );
}

for (const [difficulty, name, character, bombs, cherry] of [
  [4, 'Extra', 'marisaB', 2, 200000],
  [5, 'Phantasm', 'reimuA', 3, 300000]
]) {
  test(`${name} run-init: 0 power, 2 lives, SHT bombs, pre-loaded cherry`, () => {
    const scene = freshRun(difficulty, character);
    assert.equal(scene.playerObj.power, 0, 'Extra/Phantasm do NOT start at full power');
    assert.equal(scene.playerObj.lives, 2);
    assert.equal(scene.playerObj.bombs, bombs);
    assert.equal(scene.playerObj.bombs, Math.trunc(scene.playerObj.unfocused.bombs));
    assert.equal(scene.cherry.cherry, cherry);
    assert.equal(scene.cherry.cherryMax, 400000);
    assert.equal(scene.cherry.cherryPlus, 0);
    assert.equal(scene.extendLevel, 0);
    assert.equal(scene.extendThreshold, 200);
  });
}

test('the point-of-collection line is difficulty-gated, so 0 power still auto-collects', () => {
  // ItemManager.cpp:195 / FUN_00430c10 @ all.c:21958-21961: the PoC predicate
  // is (power >= 128 || difficulty > 3) && y < pocLineY. Starting Extra at 0
  // power therefore does not cost the route its top-of-screen auto-collect.
  const scene = freshRun(4, 'marisaB');
  scene.playerObj.y = scene.playerObj.sht.pocLineY - 1;
  const item = { id: 1, x: 200, y: 40, vx: 0, vy: 0, type: 'point', age: 0, state: 0, dead: false };
  scene.items.push(item);
  scene.updateItems();
  assert.equal(item.state, 1, 'item latched to the PoC homing state at 0 power');
});

test('a fresh Stage 1 run is unaffected: 0 power, no cherry pre-load', () => {
  const scene = new mod.StageScene(assets, audio, 3, 'sakuyaA', 1, null, 0x44c7);
  assert.equal(scene.playerObj.power, 0);
  assert.equal(scene.cherry.cherry, 0);
  assert.equal(scene.cherry.cherryMax, 300000);
  assert.equal(scene.extendThreshold, 50);
});
