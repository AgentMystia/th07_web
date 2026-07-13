import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssets, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

const mod = await loadEngine();
const replay = new mod.Rpy(readFileSync('tests/replays/th7_udFe25.rpy'));
const recorded = replay.stages[5];

function makeScene() {
  return new mod.StageScene(
    makeStubAssets(mod), makeStubAudio(), replay.difficulty,
    replay.character, recorded.stage, null, recorded.rngSeed
  );
}

function spell(bonus = 1000) {
  return {
    name: 'test', id: 0, capturing: true,
    bonus, bonusBase: 1000, decayPerSec: 1,
    grazeBonus: 0, elapsed: 1, elapsedFrac: 0,
    declAge: 0, portraitSprite: 0
  };
}

test('spell decay truncates the complete native x87 expression', () => {
  const scene = makeScene();
  scene.spellcard = spell();
  scene.tickSpellBonusDecay({ ecl: {
    isBoss: true, bossSlot: 0, spellTimeoutFlag: false
  } });

  // ftol(1000 - 1/60) = 999, then floor-to-10 = 990. Truncating 1/60
  // before subtracting would incorrectly retain 1000.
  assert.equal(scene.spellcard.bonus, 990);
  assert.equal(scene.spellcard.elapsed, 2);
});

test('op135 freezes spell base bonus but not its elapsed clock', () => {
  const scene = makeScene();
  scene.spellcard = spell(777);
  scene.tickSpellBonusDecay({ ecl: {
    isBoss: true, bossSlot: 0, spellTimeoutFlag: true
  } });

  assert.equal(scene.spellcard.bonus, 777);
  assert.equal(scene.spellcard.elapsed, 2);
});

test('spell graze bonus samples Cherry before the graze gain', () => {
  const scene = makeScene();
  scene.spellcard = spell();
  scene.cherry.borderTimer = 10;
  scene.cherry.cherry = 1490;
  scene.cherry.cherryMax = 2000;
  scene.playerObj.focusHeld = true;
  scene.focusHeld = true;

  scene.onGrazeAward();

  assert.equal(scene.spellcard.grazeBonus, 2500);
  assert.equal(scene.cherry.cherry, 1520);
});
