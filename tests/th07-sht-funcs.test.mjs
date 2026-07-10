// SHT shooter behavior-func regression tests, locked to the values decoded
// from the embedded original .sht files (see the src/formats/sht.ts header
// table). funcs[0] === 4 is SakuyaA's focused spawn-aim — the data behind
// her auto-aim shot type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/sht-funcs';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/formats/sht.ts --bundle --format=esm --outfile=${outDir}/sht.mjs --log-level=silent`);
execSync(`npx esbuild src/data/th07-data.ts --bundle --format=esm --outfile=${outDir}/th07-data.mjs --log-level=silent`);
const { Sht } = await import('../tests/.build/sht-funcs/sht.mjs');
const { TH07_DATA } = await import('../tests/.build/sht-funcs/th07-data.mjs');

const load = (name) => new Sht(TH07_DATA.sht[name]);
const allShots = (sht) => sht.levels.flatMap((l) => l.shots);

test('SakuyaA focused: every shooter carries spawn-aim func 4', () => {
  for (const s of allShots(load('ply02as'))) assert.equal(s.funcs[0], 4);
});

test('SakuyaA unfocused fan: no behavior funcs', () => {
  for (const s of allShots(load('ply02a'))) assert.deepEqual(s.funcs, [0, 0, 0, 0]);
});

test('ReimuA orbs: homing tick func mirrors shotType 1', () => {
  const orbs = allShots(load('ply00a')).filter((s) => s.orb !== 0);
  assert.ok(orbs.length > 0);
  for (const s of orbs) {
    assert.equal(s.shotType, 1);
    assert.deepEqual(s.funcs, [0, 1, 0, 0]);
  }
});

test('MarisaB focused laser: shotType 5 with pierce flag funcs[2]=1', () => {
  const lasers = allShots(load('ply01bs')).filter((s) => s.shotType === 5);
  assert.ok(lasers.length > 0);
  for (const s of lasers) assert.deepEqual(s.funcs, [3, 5, 1, 2]);
});

test('SakuyaB: option shooters carry the unknown func 5', () => {
  const options = allShots(load('ply02bs')).filter((s) => s.orb !== 0);
  assert.ok(options.length > 0);
  for (const s of options) assert.equal(s.funcs[0], 5);
});
