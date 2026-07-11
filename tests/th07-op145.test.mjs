import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/op145';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/eclvm.ts src/data/th07-data.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { StageRuntime } = await import('../tests/.build/op145/game/eclvm.mjs');
const { TH07_DATA } = await import('../tests/.build/op145/data/th07-data.mjs');

function makeHost() {
  return {
    rng: {
      range: () => 0,
      u32: () => 0,
      u32InRange: () => 0
    },
    difficulty: 3,
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
    unpauseStd() {}
  };
}

test('stage-4 op145 dispatches each sister through her op108 interrupt table', () => {
  const stage = TH07_DATA.stages[4];
  const noAnm = { hasScript: () => false };
  const runtime = new StageRuntime(stage, { etama: noAnm, enemy: noAnm, effect: noAnm });
  const game = makeHost();

  runtime.spawnEclEnemy(game, {
    subId: 42,
    x: 0,
    y: 0,
    life: 22000,
    item: -2,
    score: 100000
  });

  const sisters = game.enemies.filter((enemy) => [1, 2, 3].includes(enemy.ecl.bossSlot));
  assert.deepEqual(sisters.map((enemy) => enemy.ecl.ctx.subId), [53, 71, 88]);
  assert.deepEqual(sisters.map((enemy) => enemy.ecl.pendingInterrupt), [0, 0, 0]);
  assert.deepEqual(sisters.map((enemy) => enemy.ecl.interrupts[0]), [54, 74, 93]);

  const resumeContexts = sisters.map((enemy) => ({ ...enemy.ecl.ctx }));
  sisters.forEach((enemy) => runtime.updateEnemy(game, enemy));

  assert.deepEqual(sisters.map((enemy) => enemy.ecl.ctx.subId), [54, 74, 93]);
  assert.deepEqual(sisters.map((enemy) => enemy.ecl.pendingInterrupt), [-1, -1, -1]);
  assert.ok(sisters.every((enemy) => !enemy.dead), 'remote interrupt must not enter deleting global Sub0');
  sisters.forEach((enemy, i) => {
    assert.equal(enemy.ecl.stack.length, 1);
    assert.deepEqual(enemy.ecl.stack[0].ctx, resumeContexts[i]);
  });
});
