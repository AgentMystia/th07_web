import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// RENDER-001: the FIRE sprite arg is a raw index into Th07.exe's fixed
// 11-template table (FUN_00423480: 0x625938 + sprite*0xb8c). Templates 0-9
// resolve to etama.anm ENTRY 0 scripts 0-9; template 10 to ENTRY 1
// (etama2.png) script 0 — the 64x64 大玉 (recon bullet-type-map.md, table @
// 0x48b160). Every literal (sprite, offset) pair actually fired by stage
// 1-6 ECL must resolve through StageRuntime.bulletRect without the
// unmapped-type fallback.

const outDir = 'tests/.build/bullet-map';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/eclvm.ts src/formats/ecl.ts src/formats/anm.ts src/data/th07-data.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { StageRuntime } = await import(`../${outDir}/game/eclvm.mjs`);
const { Ecl } = await import(`../${outDir}/formats/ecl.mjs`);
const { Anm } = await import(`../${outDir}/formats/anm.mjs`);
const { TH07_DATA } = await import(`../${outDir}/data/th07-data.mjs`);

const etama = new Anm(TH07_DATA.anm.etama, 'etama');
const noAnm = { hasScript: () => false };
const runtime = new StageRuntime(TH07_DATA.stages[1], { etama, enemy: noAnm, effect: noAnm });

// Sweep every literal FIRE (sprite, offset) pair across stages 1-6.
function sweepLiteralPairs() {
  const pairs = new Map();
  for (const stage of ['1', '2', '3', '4', '5', '6']) {
    const ecl = new Ecl(TH07_DATA.stages[stage].ecl);
    const v = ecl.view;
    for (let subId = 0; subId < ecl.subCount; subId++) {
      for (const instr of ecl.sub(subId)) {
        if (instr.id < 64 || instr.id > 72) continue;
        const sprite = v.i16(instr.args);
        const offset = v.i16(instr.args + 2);
        // [10000,10100) = variable reference, resolved at runtime.
        if (sprite >= 10000 || offset >= 10000) continue;
        pairs.set(`${sprite}:${offset}`, { sprite, offset, stage });
      }
    }
  }
  return [...pairs.values()];
}

test('every literal stage-1..6 (sprite,offset) resolves without the unmapped fallback', () => {
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const pairs = sweepLiteralPairs();
    // 105 per-stage pairs dedupe to ~54 distinct combos across stages 1-6.
    assert.ok(pairs.length >= 40, `sweep found a real population (${pairs.length} pairs)`);
    for (const { sprite, offset, stage } of pairs) {
      const rect = runtime.bulletRect(sprite, offset);
      assert.ok(rect.w > 0 && rect.h > 0, `s${stage} sprite=${sprite} offset=${offset} has a rect`);
      assert.ok(sprite <= 10, `s${stage} fires only template ids 0-10 (got ${sprite})`);
    }
  } finally {
    console.error = origError;
  }
  assert.deepEqual(errors, [], 'no unmapped-type errors during the sweep');
});

test('sprite 10 resolves to etama2 entry 1: the 64x64 大玉, not entry 0 script 10', () => {
  const rect = runtime.bulletRect(10, 0);
  assert.equal(rect.imageKey, 'etama2', 'template 10 lives on the etama2 sheet');
  assert.equal(rect.w, 64);
  assert.equal(rect.h, 64);
  // Offsets shift within entry 1's global sprite space (base 168).
  const shifted = runtime.bulletRect(10, 1);
  assert.equal(shifted.imageKey, 'etama2');
  assert.ok(shifted.x !== rect.x || shifted.y !== rect.y, 'offset selects a sibling sprite');
});

test('sprites 0-9 keep their entry-0 resolution (regression)', () => {
  for (let sprite = 0; sprite <= 9; sprite++) {
    const rect = runtime.bulletRect(sprite, 6);
    assert.equal(rect.imageKey, 'etama', `sprite ${sprite} stays on etama.png`);
    assert.ok(rect.w > 0 && rect.w <= 32, `sprite ${sprite} is an entry-0 shape`);
  }
});

test('an out-of-table sprite raises the structured error and degrades safely', () => {
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const rect = runtime.bulletRect(17, 0);
    assert.ok(rect.w > 0, 'still returns a drawable rect');
  } finally {
    console.error = origError;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /UNMAPPED bullet type sprite=17/);
});
