// Item sprite indexing: items live in etama.anm entry 1 (etama2.png) and are
// addressed by embedded id + entries[1].spriteBase. A regression shipped with
// hardcoded "global ids 64+", which land inside entry 0's bullet sprites —
// power/point/cherry drops rendered as bullets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/items';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/formats/anm.ts --bundle --format=esm --outfile=${outDir}/anm.mjs --log-level=silent`);
execSync(`npx esbuild src/data/th07-data.ts --bundle --format=esm --outfile=${outDir}/th07-data.mjs --log-level=silent`);
const { Anm } = await import('../tests/.build/items/anm.mjs');
const { TH07_DATA } = await import('../tests/.build/items/th07-data.mjs');

const etama = new Anm(TH07_DATA.anm.etama, 'etama');

test('etama entry sprite bases', () => {
  assert.deepEqual(etama.entries.map((e) => e.spriteBase), [0, 168, 218, 219]);
});

test('item sprites resolve to 16x16 etama2 rects in the item row', () => {
  const base = etama.entries[1].spriteBase;
  // Embedded id → expected texture rect (crop-verified against etama2.png).
  const expected = {
    4: [0, 64], // power (red P box)
    5: [16, 64], // point (blue box)
    6: [32, 64], // bigPower
    7: [48, 64], // bomb (green B)
    8: [64, 64], // fullPower (yellow F)
    9: [80, 64], // life (1up)
    10: [96, 64], // cherry / type-6 cancel item (grey box)
    11: [112, 64], // bigCherry / type 7 (boxed petal)
    12: [0, 80] // pointBullet / type 8 (Border-break unboxed petal)
  };
  for (const [emb, [x, y]] of Object.entries(expected)) {
    const s = etama.sprites.get(base + Number(emb));
    assert.ok(s, `sprite emb${emb}`);
    assert.equal(s.imageKey, 'etama2', `emb${emb} sheet`);
    assert.deepEqual([s.x, s.y, s.w, s.h], [x, y, 16, 16], `emb${emb} rect`);
  }
});

test('offscreen arrow variants sit +10 embedded ids after each item', () => {
  const base = etama.entries[1].spriteBase;
  for (const emb of [4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const arrow = etama.sprites.get(base + emb + 10);
    assert.ok(arrow, `arrow for emb${emb}`);
    assert.equal(arrow.imageKey, 'etama2');
    assert.deepEqual([arrow.w, arrow.h], [16, 16]);
    assert.equal(arrow.y, 64);
  }
});
