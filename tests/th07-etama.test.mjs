// etama.anm indexing regression tests: the file's four entries (etama.png,
// etama2-4.png) reuse on-disk script ids, and entry sprite ids concatenate
// into one global id space. Bullets must resolve entry-scoped to entry 0;
// items live in entry 1 (global base 168). See AGENTS.md §6 (multi-entry
// ANM rule) — both stage-1 item and bullet rendering regressed on this.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/.build', { recursive: true });
execSync('npx esbuild src/formats/anm.ts --bundle --format=esm --outfile=tests/.build/anm.mjs --log-level=silent');
execSync('npx esbuild src/data/th07-data.ts --bundle --format=esm --outfile=tests/.build/th07-data.mjs --log-level=silent');
const { Anm, AnmRunner } = await import('../tests/.build/anm.mjs');
const { TH07_DATA } = await import('../tests/.build/th07-data.mjs');

const etama = new Anm(TH07_DATA.anm.etama, 'etama');

test('etama has four entries with the expected global sprite ranges', () => {
  assert.equal(etama.entries.length, 4);
  assert.deepEqual(etama.entries.map((e) => e.imageKey), ['etama', 'etama2', 'etama3', 'etama4']);
  // entry0 embeds ids 0..167, so entry1 starts at 168, then 218/219.
  assert.deepEqual(etama.entries.map((e) => Math.min(...e.spriteIds)), [0, 168, 218, 219]);
});

test('entry 0 owns the bullet scripts 0-24', () => {
  assert.deepEqual(etama.entries[0].scriptIds, Array.from({ length: 25 }, (_, i) => i));
  for (let id = 0; id <= 24; id++) assert.ok(etama.hasScriptInEntry(0, id), `script ${id}`);
});

test('stage-1 bullet scripts resolve entry-scoped to etama.png sprites', () => {
  // ecldata1 fires bullet types {0,1,2,3,5,6,7} (ops 64-72) with color
  // offsets; through the flat map these land on etama2/etama4 scripts and
  // two combos hit missing sprites (the pre-fix freeze).
  for (const id of [0, 1, 2, 3, 5, 6, 7]) {
    for (let offset = 0; offset < 8; offset++) {
      const runner = new AnmRunner(etama, id, { entryIndex: 0, spriteIndexOffset: offset });
      const frame = runner.spriteFrame();
      assert.ok(frame, `script ${id} offset ${offset} has a frame`);
      assert.equal(frame.imageKey, 'etama', `script ${id} offset ${offset} sheet`);
      assert.ok(frame.w > 0 && frame.w <= 64 && frame.h > 0 && frame.h <= 64, `script ${id} offset ${offset} rect ${frame.w}x${frame.h}`);
      assert.ok(frame.x >= 0 && frame.x + frame.w <= 256 && frame.y >= 0 && frame.y + frame.h <= 256, `script ${id} offset ${offset} within sheet`);
    }
  }
});
