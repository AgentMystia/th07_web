import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// PLAN.md §6.3: lock the per-difficulty spell selection (rankMask paths)
// so behavior fixes can't silently move cards between difficulties.
// ADJ-001 adjudication: 操符「乙女文楽」 belongs to Hard as spell 26 and to
// Lunatic as spell 27 (-Lunatic-) — the tester's "should not be in L" was
// checked against the original ECL and rejected.
// The selection runs through the REAL declare path (rank-gated op90s and
// their JMP stitching), so these fixtures spawn the actual boss subs per
// difficulty and record what op90 declares.

const outDir = 'tests/.build/spell-selection';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/eclvm.ts src/data/th07-data.ts src/formats/anm.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { StageRuntime } = await import(`../${outDir}/game/eclvm.mjs`);
const { TH07_DATA } = await import(`../${outDir}/data/th07-data.mjs`);
const { Anm } = await import(`../${outDir}/formats/anm.mjs`);

const etama = new Anm(TH07_DATA.anm.etama, 'etama');
const noAnm = { hasScript: () => false };

function declaredSpells(stage, subId, difficulty, frames = 900, damageToAtFrame = null) {
  const runtime = new StageRuntime(TH07_DATA.stages[stage], { etama, enemy: noAnm, effect: noAnm });
  const declared = [];
  const game = {
    rng: { range: () => 0, u32: () => 0, f: () => 0, u32InRange: () => 0, u16: () => 0, u16InRange: () => 0 },
    difficulty,
    rank: 0,
    frame: 0,
    id: 1,
    player: { x: 192, y: 384 },
    enemies: [],
    enemyBullets: [],
    enemyLasers: [],
    items: [],
    power: 128,
    score: 0,
    addScore() {},
    spawnItem() {},
    spawnEffectParticles() {},
    playSfx() {},
    cancelBulletsToItems() {},
    cancelLasers() {},
    sweepBulletsToItems: () => 0,
    unpauseStd() {},
    startBossSpell(id) { declared.push(id); }
  };
  const e = runtime.spawnEclEnemy(game, { subId, x: 192, y: 128, life: 5000 });
  for (let k = 0; k < frames && !e.dead; k++) {
    // Cards behind an HP-threshold callback (op148) need damage to declare.
    if (damageToAtFrame && k === damageToAtFrame[1]) e.hp = damageToAtFrame[0];
    runtime.updateEnemy(game, e);
  }
  return declared;
}

test('ADJ-001 lock: 乙女文楽 declares 26 on Hard and 27 on Lunatic (stage-3 midboss sub 22)', () => {
  // The card sits behind sub22's op148 HP threshold — drive HP below it.
  assert.deepEqual(declaredSpells(3, 22, 2, 900, [100, 60]), [26], 'Hard midboss card');
  assert.deepEqual(declaredSpells(3, 22, 3, 900, [100, 60]), [27], 'Lunatic midboss card');
  assert.deepEqual(declaredSpells(3, 22, 0, 900, [100, 60]), [], 'Easy midboss casts no card');
  assert.deepEqual(declaredSpells(3, 22, 1, 900, [100, 60]), [], 'Normal midboss casts no card');
});

test('stage-2 晴明 pair: sub 58 declares 16 on Hard and 17 on Lunatic', () => {
  assert.deepEqual(declaredSpells(2, 58, 2, 300), [16]);
  assert.deepEqual(declaredSpells(2, 58, 3, 300), [17]);
});

test('stage-6 rematch: sub 23 declares 88/89/90/91 by difficulty', () => {
  assert.deepEqual(declaredSpells(6, 23, 0, 600), [88]);
  assert.deepEqual(declaredSpells(6, 23, 1, 600), [89]);
  assert.deepEqual(declaredSpells(6, 23, 2, 600), [90]);
  assert.deepEqual(declaredSpells(6, 23, 3, 600), [91]);
});
