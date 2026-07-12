import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';

// T7RP replay parser fixtures (Replay Golden workflow, M1).
//
// tests/replays/th7_udFe25.rpy is a committed user-recorded SakuyaA Lunatic
// full clear (6 stages, no miss). The three official demo replays live in
// the local-only reference/ tree and are skipped when absent (CI has no
// reference data). Expected values were cross-validated against the exe's
// loader FUN_004402d0/FUN_00440480 semantics — see
// reference/re-specs/exe-replay.md.

const outDir = 'tests/.build/rpy-format';
mkdirSync(outDir, { recursive: true });
execSync(
  `npx esbuild src/formats/rpy.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`
);
const { Rpy, lzssDecompress, RPY_BITS } = await import(`../${outDir}/rpy.mjs`);

const USER_RPY = 'tests/replays/th7_udFe25.rpy';

test('user replay: global header decodes', () => {
  const rpy = new Rpy(readFileSync(USER_RPY));
  assert.equal(rpy.character, 'sakuyaA');
  assert.equal(rpy.difficulty, 3); // Lunatic
  assert.equal(rpy.date, '08/13');
  assert.equal(rpy.name, 'GHOST');
  assert.equal(rpy.score, 116283035); // raw units; display ×10
  assert.equal(rpy.stages.length, 6);
});

test('user replay: per-stage sub-headers decode', () => {
  const rpy = new Rpy(readFileSync(USER_RPY));
  const frames = rpy.stages.map((s) => s.inputs.length);
  assert.deepEqual(frames, [10477, 13706, 15679, 24446, 19378, 26436]);
  const seeds = rpy.stages.map((s) => s.rngSeed);
  assert.deepEqual(seeds, [0x44c7, 0xe1aa, 0x0913, 0xaf77, 0x8ede, 0x20a4]);

  const s1 = rpy.stages[0];
  assert.equal(s1.power, 0); // fresh run starts at power 0
  assert.equal(s1.lives, 2); // starting spare lives
  assert.equal(s1.bombs, 4); // recorded value is authoritative (player option)
  assert.equal(s1.cherry, 0);
  assert.equal(s1.cherryMax, 300000); // Lunatic INITIAL_CHERRY_MAX
  assert.equal(s1.cherryPlus, 0);
  assert.equal(s1.rankByte, 16); // rank starts at 16, NOT 0
  assert.equal(rpy.stages[1].rankByte, 32); // and climbs to the cap within stage 1 on Lunatic
  for (const s of rpy.stages) {
    assert.ok(s.cherryPlus <= 50000, `stage ${s.stage} cherryPlus cap`);
    assert.ok(s.cherry <= s.cherryMax, `stage ${s.stage} cherry within max`);
  }

  // Stage block +0x00 = score at that stage's end; the last one must equal
  // the file's global score, and the sequence must be monotonic.
  const ends = rpy.stages.map((s) => s.scoreAtEnd);
  assert.equal(ends[5], rpy.score);
  for (let i = 1; i < ends.length; i++) assert.ok(ends[i] > ends[i - 1]);

  // Point-item extend ladder (50/125/200/300/450/800+200n) must be
  // self-consistent: recorded level/threshold vs recorded point-item count.
  const ladder = [50, 125, 200, 300, 450, 800, 1000, 1200];
  for (const s of rpy.stages) {
    assert.equal(s.extendThreshold, ladder[s.extendLevel], `stage ${s.stage} extend threshold`);
    if (s.extendLevel > 0) {
      assert.ok(s.pointItems >= ladder[s.extendLevel - 1], `stage ${s.stage} point items vs level`);
    }
    assert.ok(s.pointItems < s.extendThreshold, `stage ${s.stage} point items below next threshold`);
  }
});

test('user replay: input words use only known bits', () => {
  const rpy = new Rpy(readFileSync(USER_RPY));
  const known =
    RPY_BITS.shoot | RPY_BITS.bomb | RPY_BITS.focus | RPY_BITS.up | RPY_BITS.down | RPY_BITS.left | RPY_BITS.right | RPY_BITS.skip;
  for (const s of rpy.stages) {
    for (const w of s.inputs) {
      assert.equal(w & ~known, 0, `stage ${s.stage} unknown input bit in 0x${w.toString(16)}`);
    }
  }
});

test('corrupted byte fails the checksum', () => {
  const bytes = new Uint8Array(readFileSync(USER_RPY));
  bytes[0x100] ^= 0xff;
  assert.throws(() => new Rpy(bytes), /checksum/);
});

test('lzss: literals and window matches round-trip', () => {
  // Hand-packed stream: 3 literals 'aba' then a match at window pos 1 len 3
  // ("aba" again — window cursor starts at 1) then EOS (pos 0).
  const bits = [];
  const push = (v, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
  };
  for (const c of [0x61, 0x62, 0x61]) {
    push(1, 1);
    push(c, 8);
  }
  push(0, 1);
  push(1, 13);
  push(0, 4); // len 3
  push(0, 1);
  push(0, 13); // EOS
  const src = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    src[i >> 3] |= b << (7 - (i & 7));
  });
  const dst = new Uint8Array(6);
  const n = lzssDecompress(src, dst);
  assert.equal(n, 6);
  assert.equal(Buffer.from(dst).toString('latin1'), 'abaaba');
});

test('demo replays decode when reference data is present', (t) => {
  const demo2 = 'reference/th07-original/demorpy2.rpy';
  if (!existsSync(demo2)) return t.skip('reference data not present');
  const rpy = new Rpy(readFileSync(demo2));
  assert.equal(rpy.name, 'ZUN');
  assert.equal(rpy.character, 'marisaA');
  assert.equal(rpy.difficulty, 3);
  assert.equal(rpy.stages.length, 1);
  assert.equal(rpy.stages[0].stage, 3);
  assert.equal(rpy.stages[0].rngSeed, 0x492f);
  assert.equal(rpy.stages[0].scoreAtEnd, rpy.score);
});
