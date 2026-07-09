import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/.build', { recursive: true });
execSync('npx esbuild src/game/cherry.ts --bundle --format=esm --outfile=tests/.build/cherry.mjs --log-level=silent');
const { CherrySystem, BORDER_DURATION, CHERRY_PLUS_MAX } = await import('../tests/.build/cherry.mjs');

// Fodder-enemy shot hit at difficulty 1 (Normal), shot type A, bosstimer
// even: divisor = 30 - min(1*2,10) = 28; gain = min(70, floor(dmg/28)*10).
// exe-cherry-border.md §3a.
function fodderHit(c, damage) {
  c.onShotHit(damage, false, 1, 0, false);
}

test('border triggers at 50000 cherry+ and survives with bonus (§4)', () => {
  const events = [];
  const c = new CherrySystem({
    onBorderStart: () => events.push('start'),
    onBorderEnd: (r) => events.push(r)
  });
  // 28-damage fodder hits give 10 cherry each (floor(28/28)*10=10); 5000 of
  // them reach the 50000 cherryPlus trigger deterministically.
  for (let i = 0; i < CHERRY_PLUS_MAX / 10; i++) fodderHit(c, 28);
  assert.equal(c.borderActive, true);
  assert.equal(c.cherryPlus, 0);
  assert.equal(c.cherry, 50000);
  let bonus = 0;
  for (let i = 0; i < BORDER_DURATION; i++) bonus += c.tick();
  assert.equal(c.borderActive, false);
  assert.equal(c.cherryMax, 60000);
  // §4 CONFIRMED: survive bonus = cherry (×1, not ×10 -- the exe's
  // `bonus*10` immediately `/10` is a lossless compiler no-op).
  assert.equal(bonus, 50000);
  assert.deepEqual(events, ['start', 'survived']);
});

test('border break absorbs hit, no bonus, cherry+ resets', () => {
  const c = new CherrySystem();
  for (let i = 0; i < CHERRY_PLUS_MAX / 10; i++) fodderHit(c, 28);
  assert.equal(c.borderActive, true);
  assert.equal(c.breakBorder(), true);
  assert.equal(c.borderActive, false);
  assert.equal(c.cherryMax, 50000);
  assert.equal(c.cherryPlus, 0);
  assert.equal(c.breakBorder(), false);
});

test('border grazes raise cherry max by 30/80', () => {
  const c = new CherrySystem();
  for (let i = 0; i < CHERRY_PLUS_MAX / 10; i++) fodderHit(c, 28);
  c.onGraze(true);
  c.onGraze(false);
  assert.equal(c.cherryMax, 50110);
});

// exe-cherry-border.md §3a (all.c 14181-14220), retail-simplified formula:
//   divisor = isBoss ? 10 - floor(min(diff*2,10)/3) : 30 - min(diff*2,10)
//   gain = min(70, floor(damage/divisor) * 10)
test('shot-hit cherry gain follows the boss/difficulty divisor table (§3a)', () => {
  const c = new CherrySystem();
  // Normal (diff=1), fodder: divisor = 30-2 = 28.
  c.onShotHit(28, false, 1, 0, false);
  assert.equal(c.cherry, 10); // floor(28/28)*10
  c.onShotHit(56, false, 1, 0, false);
  assert.equal(c.cherry, 30); // +floor(56/28)*10 = +20
  // Boss hit, Normal: divisor = 10 - floor(2/3) = 10.
  const c2 = new CherrySystem();
  c2.onShotHit(50, true, 1, 0, false);
  assert.equal(c2.cherry, 50); // floor(50/10)*10 = 50
  // 70 cap: huge boss damage still caps at +70.
  const c3 = new CherrySystem();
  c3.onShotHit(1000, true, 1, 0, false);
  assert.equal(c3.cherry, 70);
});

test('shot-hit zero-gain floors to 10 on an odd boss timer, else stays 0', () => {
  const c = new CherrySystem();
  // Normal, fodder, divisor 28: 1 damage -> floor(1/28)*10 = 0.
  c.onShotHit(1, false, 1, 0, false);
  assert.equal(c.cherry, 0);
  const c2 = new CherrySystem();
  c2.onShotHit(1, false, 1, 0, true); // bossTimerOdd floors 0 -> 10
  assert.equal(c2.cherry, 10);
});

// exe-cherry-border.md §3b case table: 6=+20, 7=1000+100*counter, 8=+100
// (30+70 split, cherry-only for the 70), 9=+100.
test('cherry-item amounts follow the exe 4-case table (§3b)', () => {
  const small = new CherrySystem();
  small.onSmallCherryItem();
  assert.equal(small.cherry, 20);
  assert.equal(small.cherryPlus, 20); // dc6f touches cherryPlus too

  const big = new CherrySystem();
  big.onBigCherryItem();
  assert.equal(big.cherry, 100); // 30 (dc6f) + 70 (dd6c, cherry-only)
  assert.equal(big.cherryPlus, 30); // only the dc6f half feeds cherryPlus

  const large = new CherrySystem();
  assert.equal(large.largeCherryItemGain(), 1000);
  large.onSpellCapture();
  large.onSpellCapture();
  assert.equal(large.largeCherryItemGain(), 1200);
  large.onLargeCherryItem();
  assert.equal(large.cherry, 1200);

  const nine = new CherrySystem();
  nine.onCase9CherryItem();
  assert.equal(nine.cherry, 100);
});

test('grazeScaledItemScore matches graze/40*10+300, min 10, /10 (§3b cases 6/9)', () => {
  const c = new CherrySystem();
  assert.equal(c.grazeScaledItemScore(0), 30); // max(10, 0+300)/10
  assert.equal(c.grazeScaledItemScore(400), 40); // floor(400/40)*10=100; (100+300)/10
});

test('large-cherry-item score bonus only fires once cherry is saturated (§3b case 7, unspawned)', () => {
  const c = new CherrySystem();
  assert.equal(c.largeCherryItemScore(100, 128, false), 0); // not at max
  c.cherry = c.cherryMax;
  assert.equal(c.largeCherryItemScore(100, 128, false), 5000); // 50000/10
});

// exe-cherry-border.md §3c, base=0 collapse. v = 50000-100*round(y-pocY)
// (or 50000 at/above the line); headroom bonus/cap once cherry>50000;
// floor10; score += v/10.
test('point item score decays 100/px below the PoC line, floored to 10, /10 (§3c)', () => {
  const c = new CherrySystem();
  assert.equal(c.pointItemScore(228, 128, false), 4000); // (50000-100*100)/10
  assert.equal(c.pointItemScore(130, 128, false), 4980); // (50000-100*2)/10
  assert.equal(c.pointItemScore(128, 128, false), 5000); // at the line: flat
  assert.equal(c.pointItemScore(100, 128, false), 5000); // above the line: flat
});

test('point item score gets a cherry-headroom bonus below 50000, capped down above it (§3c)', () => {
  const c = new CherrySystem();
  c.cherry = 75000; // 25000 above the 50000 headroom line
  // Below the line: v=40000 (< 50000) so += floor((75000-50000)/5) = 5000.
  assert.equal(c.pointItemScore(228, 128, false), 4500); // (40000+5000)/10
  // At/above the line: v=50000 (>= 50000) so v is capped DOWN to cherry.
  assert.equal(c.pointItemScore(100, 128, false), 7500); // 75000/10
});

test('death loses floor10(min(cap, round(cherry*0.5))); cherry never exceeds max (§3d, RATE PROBABLE)', () => {
  const c = new CherrySystem();
  for (let i = 0; i < CHERRY_PLUS_MAX / 10; i++) fodderHit(c, 28);
  assert.equal(c.cherry, 50000); // capped at max
  c.onDeath(1); // difficultyIndex=1 (Normal): cap=100000, not binding here
  assert.equal(c.cherry, 25000); // floor10(round(50000*0.5))
  assert.equal(c.cherryPlus, 0);
});

test('boss timeout costs exactly 25% of cherry, floored to 10, no cap (§3e CONFIRMED)', () => {
  const c = new CherrySystem();
  for (let i = 0; i < CHERRY_PLUS_MAX / 10; i++) fodderHit(c, 28);
  assert.equal(c.cherry, 50000);
  c.onBossTimeout();
  assert.equal(c.cherry, 37500); // 50000 - floor10(round(50000*0.25))
});
