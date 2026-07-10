// PCB's signature Cherry Point (桜点) system and the Supernatural Border
// (森羅結界), reverse-engineered against Th07.exe v1.00b — see
// reference/re-specs/exe-cherry-border.md for the full trace (all values
// below cite it by section).
//
// - The cherry manager (exe: fixed addr 0x61c250) tracks three counters:
//   cherry (current, capped at cherryMax), cherryMax (the rising cap), and
//   cherryPlus (progress toward the border; reaching 50000 triggers it).
//   `base`, the exe's per-run memory-scramble offset added to every raw
//   stored value, is implemented as 0 here (spec §1a) — a browser port has
//   no memory-editing threat model, and every exe read site subtracts
//   `base` back off before use, so this is a zero-behavior-difference
//   simplification.
// - Cherry rises from shot-hits on enemies (§3a, damage/divisor formula,
//   boss-aware), cherry items (§3b, a 4-case table), and border-survive
//   (§4); it never touches cherryPlus during grazes (§3, graze feeds
//   cherryMax/cherry only) nor during star/cancel items (§3 — those have
//   NO cherry effect at all, score-only).
// - Cherry drops on death (§3d, rate UNRESOLVED, flagged PROBABLE) and on
//   boss timeout (§3e, CONFIRMED exactly 25%). Bombing has NO cherry
//   penalty (§3 — it only ends an active border).
// - Cherry+ rises only via the same add-helper as cherry (dc6f); at 50,000
//   the Supernatural Border activates: 540 frames of invincibility with
//   full-value auto-collection everywhere. Grazing during the border still
//   adds +30 (focused) / +80 (unfocused) to CherryMax (border-agnostic).
//   Surviving the full border awards CherryMax +10,000, cherry +10,000,
//   and a score bonus of `cherry` (§4 CONFIRMED ×1, NOT ×10 — the exe's
//   `bonus*10` immediately followed by `/10` is a compiler no-op); getting
//   hit or bombing breaks it (the hit is absorbed, no bonus).
// - Point items (§3c) and the case-7 "large Cherry" item (§3b) share a
//   height-based score formula with a "cherry headroom" bonus once cherry
//   exceeds 50000. The exe's internal score field is added-to at the same
//   scale it is displayed at (no ×10 anywhere in the HUD digit path —
//   confirmed via the raw "%.8d"/"%.9d" format strings backing the score
//   readout; see EXECUTION-LOG.md's score-unit adjudication), so every
//   `score +=` below is already in the port's `this.score` units.
export const CHERRY_PLUS_MAX = 50000;
export const BORDER_DURATION = 540;
// Th07.exe run-init FUN_0042cf2f @ 0x42cf2f (all.c:19765-19796): cherryMax
// starts per difficulty — Easy/Normal 200000, Hard 250000, Lunatic 300000
// (Extra/Phantasm 400000 with cherry pre-loaded — outside this port's
// range). cherry and cherryPlus start at 0 (base-collapsed, spec §1a).
// The previous INITIAL_CHERRY_MAX = 50000 conflated the cherryPlus border
// trigger with the cherry cap; the vanilla HUD gauge reads
// cherry/cherryMax (e.g. 86120/310000 on Lunatic after one border's
// +10000), not cherryPlus/50000.
// Indices 4/5 = Extra/Phantasm: cherryMax 400000 (FUN_0042cf2f's upper
// tier; those runs also pre-load some cherry — handled by the run-init
// carry, not here).
export const INITIAL_CHERRY_MAX_BY_DIFFICULTY = [200000, 200000, 250000, 300000, 400000, 400000];

// Floors a non-negative integer to the nearest multiple of 10 — the exe's
// recurring `v = v - v % 10` idiom (point items §3c, death §3d, boss
// timeout §3e, case-7 cherry item §3b).
function floor10(v: number): number {
  return v - (v % 10);
}

export type BorderEnd = 'none' | 'survived' | 'broken';

export interface CherryEvents {
  onBorderStart?(): void;
  onBorderEnd?(result: 'survived' | 'broken', bonus: number): void;
}

export class CherrySystem {
  cherry = 0;
  cherryMax = INITIAL_CHERRY_MAX_BY_DIFFICULTY[1];
  cherryPlus = 0;
  borderTimer = 0; // frames remaining while the border is active
  // The exe's *(stats+0x1c) per-run counter driving the case-7 "big
  // Cherry" item amount (spec §3b). CONFIRMED = spell-capture count: the
  // op-91 award path increments it on a valid capture (all.c:6689).
  spellsCaptured = 0;

  constructor(private events: CherryEvents = {}, difficultyIndex = 1) {
    this.cherryMax =
      INITIAL_CHERRY_MAX_BY_DIFFICULTY[difficultyIndex] ??
      INITIAL_CHERRY_MAX_BY_DIFFICULTY[1];
  }

  get borderActive(): boolean {
    return this.borderTimer > 0;
  }

  // Th07.exe FUN_0042dc6f (spec §2): cherry += amount (capped at
  // cherryMax); cherryPlus += amount (capped at 50000, -> startBorder when
  // reached). The exe's actual cherryPlus gate (`DAT_004b5ec5`) is a
  // write-site-less dead flag, permanently open in retail — this port's
  // `!borderActive` gate is a different mechanism that happens to be
  // behaviorally equivalent given the cap/reset mechanics (spec §2: once
  // cherryPlus hits 50000 the only path past it is startBorder, which
  // resets it, so gating further gain on "border not active" changes
  // nothing observable) — kept for that reason, not because it mirrors
  // the exe's (nonexistent) real gate.
  private gain(amount: number): void {
    if (amount <= 0) return;
    this.cherry = Math.min(this.cherryMax, this.cherry + amount);
    if (!this.borderActive) {
      this.cherryPlus = Math.min(CHERRY_PLUS_MAX, this.cherryPlus + amount);
      if (this.cherryPlus >= CHERRY_PLUS_MAX) this.startBorder();
    }
  }

  // Th07.exe FUN_0042de03/FUN_0042dd6c (spec §2): cherry-only add, capped
  // at cherryMax, cherryPlus untouched.
  private gainCherryOnly(amount: number): void {
    if (amount <= 0) return;
    this.cherry = Math.min(this.cherryMax, this.cherry + amount);
  }

  private startBorder(): void {
    this.borderTimer = BORDER_DURATION;
    this.cherryPlus = 0;
    this.events.onBorderStart?.();
  }

  // Advances the border timer; returns the score bonus when it completes.
  tick(): number {
    if (!this.borderActive) return 0;
    this.borderTimer--;
    if (this.borderTimer === 0) {
      // Th07.exe FUN_0043e620 (spec §4, CONFIRMED instruction-by-instruction
      // @ 0x43e64e-0x43e680): +10000 to both cherryMax (de56) and cherry
      // (de03); score += cherry (the exe's `(cherry*10)/10` is a lossless
      // compiler no-op, NOT a ×10 bonus — corrects this file's prior claim).
      const bonus = this.cherry;
      this.cherryMax += 10000;
      this.cherry = Math.min(this.cherryMax, this.cherry + 10000);
      this.events.onBorderEnd?.('survived', bonus);
      return bonus;
    }
    return 0;
  }

  // Breaks the border (player hit or bomb). Returns true if a hit was
  // absorbed by the border.
  breakBorder(): boolean {
    if (!this.borderActive) return false;
    this.borderTimer = 0;
    this.cherryPlus = 0;
    this.events.onBorderEnd?.('broken', 0);
    return true;
  }

  // Th07.exe FUN_0041ed50 (spec §3a, all.c 14181-14220), retail-simplified
  // (DAT_004b5ec3/DAT_004ca4d8 are confirmed-dead gates, spec §2/§3a — the
  // "alternate/reduced cherry" branch they'd gate is unreachable, omitted).
  // The DAT_0062583c>4 damage-halving branch (spec §3a raw source) never
  // fires in this port either: it requires an Extra/Phantasm difficulty
  // tier this port doesn't have (difficultyIndex is 0..3), so it's omitted
  // too — not a fidelity gap, just dead code under this port's difficulty
  // range.
  //   divisor = isBoss ? 10 - floor(min(difficulty*2,10)/3)
  //                     : 30 - min(difficulty*2,10)
  //   gain = min(70, floor(damage/divisor) * 10)
  //   if gain == 0 and bossTimerOdd: gain = 10
  //   if (difficulty==0 and shotTypeBit==0) and gain in {20,30} and
  //      bossTimerOdd: gain -= 10
  // `bossTimerOdd` is bit0 of the enemy's own boss-phase timer field
  // (`enemyFlags_2bcc`, PROBABLE identity — spec §3a/§5 item 3); this port
  // exposes the same counter as `Enemy.ecl.bossTimer`, which is 0 (hence
  // always even) for every non-boss enemy, matching the exe's
  // boss-only-observed behavior for this quirk.
  onShotHit(
    damage: number,
    isBoss: boolean,
    difficultyIndex: number,
    shotTypeBit: number,
    bossTimerOdd: boolean
  ): void {
    const local14 = Math.min(difficultyIndex * 2, 10);
    const divisor = isBoss ? 10 - Math.floor(local14 / 3) : 30 - local14;
    let g = Math.min(70, Math.floor(damage / divisor) * 10);
    if (g === 0 && bossTimerOdd) g = 10;
    const difficultyByte = difficultyIndex * 2 + shotTypeBit;
    if (difficultyByte === 0 && (g === 20 || g === 30) && bossTimerOdd) g -= 10;
    this.gain(g);
  }

  // Th07.exe FUN_00430c10 case 6 (spec §3b): small "Cherry" item, +20
  // cherry (+cherryPlus via dc6f), unconditional. This port's 'cherry'
  // ItemType maps to this case (see stage-scene.ts collectItem).
  onSmallCherryItem(): void {
    this.gain(20);
  }

  // Th07.exe FUN_00430c10 case 7 (spec §3b): big "Cherry" item, amount =
  // 1000 + 100 * spellsCaptured, to cherry AND cherryPlus (dc6f). This is
  // the drop-table type 7 AND what power drops convert to at power>=128 —
  // the main cherryPlus economy ('bigCherry' ItemType maps here).
  largeCherryItemGain(): number {
    return 1000 + 100 * this.spellsCaptured;
  }

  onLargeCherryItem(): void {
    this.gain(this.largeCherryItemGain());
  }

  // Th07.exe FUN_00430c10 case 8 (spec §3b): the bullet-cancel star item —
  // +30 cherry+cherryPlus (dc6f) AND +70 cherry-only (dd6c), for +100
  // total cherry / +30 cherryPlus. No score effect. (Previously mislabeled
  // "Big Cherry" and wired to the 'bigCherry' ItemType — that item is exe
  // case 7 above; the mixup starved the border trigger.)
  onBigCherryItem(): void {
    this.gain(30);
    this.gainCherryOnly(70);
  }

  // Th07.exe FUN_00430c10 case 9 (spec §3b): flat +100 cherry
  // (+cherryPlus via dc6f). UNSPAWNED in this port (no ItemType maps to
  // case 9), kept for completeness per §7.
  onCase9CherryItem(): void {
    this.gain(100);
  }

  // Th07.exe FUN_00430c10 score term shared by cases 6 and 9 (spec §3b):
  // `score += grazeScaledValue/10` where `grazeScaledValue =
  // max(10, floor(graze/40)*10 + 300)` (or a min of 100 instead of 10 when
  // `DAT_004b5e94 != 0` — PROBABLE dead, matching the DAT_004b5eXX/
  // DAT_004ca4d8 confirmed-dead-flag cluster elsewhere in this pass, spec
  // §2/§3a, but NOT independently confirmed for this specific address, so
  // only the min=10 branch is implemented here). Already an exact multiple
  // of 10, so `/10` is lossless integer division.
  grazeScaledItemScore(graze: number): number {
    const v = Math.max(10, Math.floor(graze / 40) * 10 + 300);
    return Math.trunc(v / 10);
  }

  // Star / cancel ("P-bullet") items: Th07.exe cases 0/2 of the same
  // item-collect switch never call any cherry accumulator function (spec
  // §3/§6, closes the prior "+10 guess" as flatly wrong) — pure
  // score/graze-combo bookkeeping, zero cherry interaction. No method
  // here on purpose; stage-scene.ts's 'pointBullet' case no longer calls
  // into CherrySystem at all.

  onGraze(focused: boolean): void {
    // Th07.exe FUN_0043bb30: graze raises BOTH cherryMax (FUN_0042de56) and
    // cherry (FUN_0042de03) by 30 focused / 80 unfocused, unconditionally —
    // NOT border-gated, and it never touches cherryPlus (graze does not
    // progress the border; only shot-hits / cherry items via
    // FUN_0042dc6f do).
    const amt = focused ? 30 : 80;
    this.cherryMax += amt;
    this.cherry = Math.min(this.cherryMax, this.cherry + amt);
  }

  onSpellCapture(): void {
    this.spellsCaptured++;
  }

  onBomb(): void {
    // Th07.exe: bombing ends an active border (exe-bombs.md §1, "cancel
    // border" path) but applies NO cherry/CherryPlus penalty — none of the 24
    // per-character bomb functions nor the trigger sequence write anything to
    // the cherry accumulators (exe-bombs.md §1c). The previous
    // trunc(12000*scale) deduction was fabricated; removed.
    this.breakBorder();
  }

  // Th07.exe FUN_0043dca0 (spec §3d): penalty = floor10(min(cap,
  // round(cherry*RATE))); cherry -= penalty. `RATE` is
  // `*(DAT_0056b928+0x1c)`, a per-stage/difficulty config float whose
  // write site wasn't traced (spec §5 item 1) — 0.5 is a flagged PROBABLE
  // placeholder ("dying costs about half your cherry"), not
  // disassembly-confirmed. `cap` = 60000 when `DAT_00625625 == 2` else
  // 100000. `DAT_00625625` was previously PROBABLE-flagged as the
  // difficulty index; the homing second-target code settles it as the
  // CHARACTER index instead — its `== 2` branch selects the Sakuya-only
  // upward-cone target using the -π/3..-2π/3 window (rdata floats @
  // 0x48edc0/0x48edc4, read from the exe binary), which only makes sense
  // for character==Sakuya. So the death cap is Sakuya-specific.
  //
  // The previous per-character `lossRatio` arg (SHT `cherryLossOnDeath`,
  // src/formats/sht.ts) is dropped: the exe's traced rate source is the
  // per-stage config float above, not a per-character SHT field. The SHT
  // field is real data (still parsed) but nothing here confirms it's the
  // same knob — see EXECUTION-LOG.md for the discrepancy note.
  onDeath(isSakuya: boolean): void {
    const cap = isSakuya ? 60000 : 100000;
    const rate = 0.5; // PROBABLE, spec §5 item 1 — see doc comment above
    const penalty = Math.min(cap, Math.round(this.cherry * rate));
    this.cherry = Math.max(0, this.cherry - floor10(penalty));
    // Border progress reset on death is not itself in the decompiled §3d
    // snippet, but matches well-established PCB behavior (dying zeroes the
    // Cherry+ meter) and was already this file's behavior; kept.
    this.cherryPlus = 0;
  }

  // Th07.exe FUN_0041e6b0 (spec §3e, CONFIRMED — DAT_0048ed1c == 0.25 via
  // getFloat): penalty = floor10(round(cherry*0.25)); cherry -= penalty.
  // No cap (unlike death's 60000/100000 cap). Corrects the previous
  // "halve cherry" approximation, which was 2x too harsh.
  onBossTimeout(): void {
    const penalty = floor10(Math.round(this.cherry * 0.25));
    this.cherry -= penalty;
  }

  // Th07.exe FUN_00430c10 case 1 ("P" point item), spec §3c, base=0
  // collapse (§1a):
  //   v = (autoCollected || y <= pocLineY) ? 50000
  //       : 50000 - 100*round(y - pocLineY)
  //   if v < 50000 and cherry > 50000: v += floor((cherry-50000)/5)
  //   else if v >= 50000 and cherry > 50000: v = cherry
  //   v = floor10(v)
  //   score += v/10
  // The `item.flag_0x280` "guaranteed max" override is dead code in
  // retail (its only setter is gated on the always-0 `DAT_004b5ec5` dead
  // flag, spec §3c) — omitted with zero behavioral difference.
  pointItemScore(y: number, pocLineY: number, autoCollected: boolean): number {
    let v = autoCollected || y <= pocLineY ? 50000 : 50000 - 100 * Math.round(y - pocLineY);
    if (v < 50000) {
      if (this.cherry > 50000) v += Math.trunc((this.cherry - 50000) / 5);
    } else if (this.cherry > 50000) {
      v = this.cherry;
    }
    return Math.trunc(floor10(v) / 10);
  }

  // Th07.exe FUN_00430c10 case 7 score bonus (spec §3b): only fires once
  // cherry is saturated at cherryMax; same height falloff shape as the
  // point-item formula but no cherry-headroom bonus term; fires with the
  // 'bigCherry' ItemType (exe type 7) once cherry is saturated.
  largeCherryItemScore(y: number, pocLineY: number, autoCollected: boolean): number {
    if (this.cherry < this.cherryMax) return 0;
    const bonus = autoCollected || y <= pocLineY ? 50000 : 50000 - 100 * Math.round(y - pocLineY);
    return Math.trunc(floor10(bonus) / 10);
  }

  // Test/debug-only: adds cherry directly through the same capped/
  // border-triggering path as a real gain, bypassing the shot-hit formula.
  // Used by main.ts's __TH07_TEST__.addCherry hook so probes can reach a
  // target cherry magnitude deterministically; not an exe-derived path.
  debugAddCherry(amount: number): void {
    this.gain(amount);
  }
}
