import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// UI-001: explicit boss ownership — spellId -> cutin face global sprite id,
// and (stage, boss root sub) -> ename.png nameplate row. Ground truth from
// per-stage ECL op90/op99 phase families, MSG op8 boss-intro text and a
// pixel read of ename.png's 16 rows (recon ui-owner-table.md).

const outDir = 'tests/.build/boss-owner';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/stage-scene.ts --bundle --format=esm --outfile=${outDir}/stage-scene.mjs --log-level=silent`);
const { cutinFaceForSpell, enameRowForBoss } = await import(`../${outDir}/stage-scene.mjs`);

test('the three PLAN-named encounters resolve to their own portraits', () => {
  // Stage 1 midboss: Cirno (existing decode, face 3).
  assert.equal(cutinFaceForSpell(0), 3);
  assert.equal(cutinFaceForSpell(1), 3);
  // Stage 6 Youmu rematch: 六道剣「一念無量劫」 ids 88-91 -> HER sheet
  // (face_06_00 entry 0 = reused st05 sheet, global 0).
  assert.equal(cutinFaceForSpell(91), 0);
  // Yuyuko's cards (92-115, incl. 墨染の桜 111 and 反魂蝶 115) -> her
  // entry-1 sheet at global 2 — the old ternary returned 0 (Youmu) here.
  for (const id of [92, 111, 115]) assert.equal(cutinFaceForSpell(id), 2, `spell ${id}`);
});

test('every spell id 0-140 has an owner and faces are entry-consistent per stage', () => {
  for (let id = 0; id <= 140; id++) {
    const face = cutinFaceForSpell(id);
    assert.ok(Number.isInteger(face) && face >= 0, `spell ${id}`);
  }
  // Prismriver sisters resolve per-sister; the trio spells use Lunasa's.
  assert.equal(cutinFaceForSpell(48), 0, 'Lunasa');
  assert.equal(cutinFaceForSpell(52), 4, 'Merlin');
  assert.equal(cutinFaceForSpell(56), 8, 'Lyrica');
  assert.equal(cutinFaceForSpell(44), 0, 'trio shared');
  // Extra/Phantasm finals.
  assert.equal(cutinFaceForSpell(118), 4, 'Ran');
  assert.equal(cutinFaceForSpell(130), 2, 'Yukari');
});

test('nameplate rows follow the CURRENT boss root sub, not dialogue history', () => {
  // Stage 6: Youmu's rematch root is sub 18 -> row 10 (her third plate);
  // Yuyuko's root is sub 28 -> row 11. The old dialogueSeen latch showed
  // row 11 during Youmu's own fight.
  assert.equal(enameRowForBoss(6, 18), 10);
  assert.equal(enameRowForBoss(6, 28), 11);
  // Stage 1: Cirno midboss root 20 -> row 0; Letty root 31 -> row 1.
  assert.equal(enameRowForBoss(1, 20), 0);
  assert.equal(enameRowForBoss(1, 31), 1);
  // Stage 4: Lily White (root 35) -> row 6; the trio conductor (42) and
  // each sister (53/71/88) -> the generic "Sister Prismriver" row 7.
  assert.equal(enameRowForBoss(4, 35), 6);
  for (const sub of [42, 53, 71, 88]) assert.equal(enameRowForBoss(4, sub), 7, `sub ${sub}`);
  // Stage 3: both pre-dialogue Alice roots share row 4.
  assert.equal(enameRowForBoss(3, 13), 4);
  assert.equal(enameRowForBoss(3, 22), 4);
  assert.equal(enameRowForBoss(3, 31), 5);
});
