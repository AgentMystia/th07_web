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
//   (§4). Grazes feed cherryMax/cherry only, never cherryPlus. Ordinary
//   power/star item cases 0/2 are score/combo-only with no cherry effect.
// - Cherry drops on death (§3d, selected SHT header rate, CONFIRMED), boss
//   timeout (§3e, exactly 25%), and progressively while a bomb is active
//   (FUN_00407740 + FUN_0043d9a0). Bomb drain touches cherry only, never
//   cherryPlus.
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
//   readout), so every
//   `score +=` below is already in the port's `this.score` units.
export const CHERRY_PLUS_MAX = 50000;
export const BORDER_DURATION = 540;

// Supernatural Border background-dim envelope (Player.cpp:1975-1995, integer
// math preserved): while the border is up the stage background is
// multiply-darkened by a grey factor that ramps 128 -> 48 over the first 30
// frames, holds 48 (~x0.375), and ramps back over the last 30. 128 = neutral.
export function borderDimRequest(timer: number): number {
  if (timer >= 510) return 128 - Math.trunc((BORDER_DURATION - timer) * 80 / 30);
  if (timer < 30) return 128 - Math.trunc(timer * 80 / 30);
  return 48;
}

// Stage::SmoothBlendColor (Stage.cpp:512-532): the first feed of a frame
// replaces the blend state outright; later feeds average into it. The stage
// applies the state once per frame and resets it to (a=0, rgb=128), and the
// player feeds it twice (update + draw), so the applied value tracks the
// average of two consecutive requests and one dimmed frame trails the end.
export function smoothBlendColor(state: { a: number; rgb: number }, v: number): void {
  if (state.a === 0) {
    state.rgb = v;
    state.a = 128;
  } else {
    state.rgb = (state.rgb + v) >> 1;
    state.a = (state.a + 128) >> 1;
  }
}
// Th07.exe run-init FUN_0042cf2f @ 0x42cf2f (all.c:19765-19796): cherryMax
// starts per difficulty — Easy/Normal 200000, Hard 250000, Lunatic 300000
// Extra/Phantasm start at 400000 with cherry pre-loaded to 200000/300000.
// cherryPlus starts at 0 (base-collapsed, spec §1a).
// The previous INITIAL_CHERRY_MAX = 50000 conflated the cherryPlus border
// trigger with the cherry cap; the vanilla HUD gauge reads
// cherry/cherryMax (e.g. 86120/310000 on Lunatic after one border's
// +10000), not cherryPlus/50000.
// Indices 4/5 = Extra/Phantasm: cherryMax 400000 (FUN_0042cf2f's upper
// tier); their initial cherry values are applied in the constructor below.
export const INITIAL_CHERRY_MAX_BY_DIFFICULTY = [200000, 200000, 250000, 300000, 400000, 400000];

// Floors a non-negative integer to the nearest multiple of 10 — the exe's
// recurring `v = v - v % 10` idiom (point items §3c, death §3d, boss
// timeout §3e, case-7 cherry item §3b).
function floor10(v: number): number {
  return v - (v % 10);
}

export type BorderEnd = 'none' | 'survived' | 'broken';
export type BorderStartAction = 'start' | 'defer' | 'cancel';

export interface CherryEvents {
  borderStartAction?(): BorderStartAction;
  onBorderStart?(): void;
  onBorderCancel?(): void;
  onBorderEnd?(result: 'survived' | 'broken', bonus: number): void;
}

export class CherrySystem {
  cherry = 0;
  cherryMax = INITIAL_CHERRY_MAX_BY_DIFFICULTY[1];
  cherryPlus = 0;
  // Player+0x16a08/+0x16a04: the Border retreat clock is an integer current
  // plus an f32 fraction, advanced by FUN_00436a06.  Keeping the halves
  // separate matters under op121 slow motion: the HUD reads only the integer
  // current, and the first 1/3-rate wall tick borrows immediately from zero.
  borderTimer = 0; // integer frames remaining while the border is active
  borderTimerFrac = 0;
  borderPending = false;
  // The exe's *(stats+0x1c) per-run counter driving the case-7 "big
  // Cherry" item amount (spec §3b). CONFIRMED = spell-capture count: the
  // op-91 award path increments it on a valid capture (all.c:6689).
  spellsCaptured = 0;

  constructor(private events: CherryEvents = {}, difficultyIndex = 1) {
    this.cherryMax =
      INITIAL_CHERRY_MAX_BY_DIFFICULTY[difficultyIndex] ??
      INITIAL_CHERRY_MAX_BY_DIFFICULTY[1];
    // Th07.exe (v1.00b) FUN_0042cf2f @ 0x42cf2f (all.c:19775-19781).
    if (difficultyIndex === 4) this.cherry = 200000;
    else if (difficultyIndex === 5) this.cherry = 300000;
  }

  get borderActive(): boolean {
    return this.borderTimer > 0;
  }

  get borderEngaged(): boolean {
    return this.borderActive || this.borderPending;
  }

  // Th07.exe FUN_0042dc6f (spec §2): cherry += amount (capped at
  // cherryMax); cherryPlus += amount (capped at 50000, -> startBorder when
  // reached). The exe's actual cherryPlus gate (`DAT_004b5ec5`) is a
  // write-site-less dead flag, permanently open in retail. `borderEngaged`
  // models player marker +0x240d: state 1 active or state 2 pending; the
  // accumulator stays capped while either marker is set.
  private gain(amount: number): void {
    if (amount <= 0) return;
    this.cherry = Math.min(this.cherryMax, this.cherry + amount);
    if (!this.borderEngaged) {
      this.cherryPlus = Math.min(CHERRY_PLUS_MAX, this.cherryPlus + amount);
      if (this.cherryPlus >= CHERRY_PLUS_MAX) this.requestBorder();
    }
  }

  // Th07.exe FUN_0042de03/FUN_0042dd6c (spec §2): cherry-only add, capped
  // at cherryMax, cherryPlus untouched.
  private gainCherryOnly(amount: number): void {
    if (amount <= 0) return;
    this.cherry = Math.min(this.cherryMax, this.cherry + amount);
  }

  private requestBorder(): void {
    const action = this.events.borderStartAction?.() ?? 'start';
    if (action === 'defer') {
      this.borderPending = true;
      return;
    }
    if (action === 'cancel') {
      this.borderPending = false;
      this.cherryPlus = 0;
      this.events.onBorderCancel?.();
      return;
    }
    this.startBorder();
  }

  private startBorder(): void {
    this.borderPending = false;
    this.borderTimer = BORDER_DURATION;
    this.borderTimerFrac = 0;
    // The live cherryPlus storage is repurposed as the border meter while
    // state 4 is active. FUN_0043e890 leaves it pinned at 50000 on entry;
    // FUN_0043e2e0 overwrites it with the countdown percentage each later
    // player tick (Th07.exe v1.00b @ 0x43e890 / all.c:28735-28739).
    this.cherryPlus = CHERRY_PLUS_MAX;
    this.events.onBorderStart?.();
  }

  // Th07.exe FUN_0043d9a0 retries marker state 2 once per player update,
  // before the lifecycle timer advances. StageScene calls this at that point.
  retryBorderStart(): void {
    if (this.borderPending) this.requestBorder();
  }

  // Advances the border timer; returns the score bonus when it completes.
  tick(rate = 1): number {
    if (!this.borderActive) return 0;
    // Border countdown ticks at the global slow-motion rate
    // (exe FUN_0043e2e0 via FUN_00436a06; spec-slowmo.md §3.2). The HUD
    // value is written BEFORE the split timer advances, so the first active
    // tick still exposes 50000 even though borderTimer becomes 539.
    this.cherryPlus = Math.max(0,
      Math.trunc((this.borderTimer * CHERRY_PLUS_MAX) / BORDER_DURATION));
    // Th07.exe v1.00b FUN_00436a06 @ 0x436a06.  At normal rate the fast
    // branch decrements the integer directly.  At <=0.99 it stores the
    // rate/fraction as f32, subtracts first, then borrows an integer tick
    // whenever the fraction is negative.  A scalar JS countdown instead
    // smoothed the HUD and expired Stage 5's slow-motion Border two wall
    // frames late, changing one graze and all later point-item scores.
    const rateF32 = Math.fround(rate);
    if (rateF32 <= Math.fround(0.99)) {
      this.borderTimerFrac = Math.fround(this.borderTimerFrac - rateF32);
      while (this.borderTimerFrac < 0) {
        this.borderTimer--;
        this.borderTimerFrac = Math.fround(this.borderTimerFrac + 1);
      }
    } else {
      this.borderTimer--;
    }
    if (this.borderTimer < 1) {
      this.borderTimer = 0;
      this.borderTimerFrac = 0;
      return this.finishBorderSurvival();
    }
    return 0;
  }

  // FUN_00428392 calls FUN_0043e620 directly while its message/stage mini-VM
  // is active and the Border marker is set (all.c:17791-17793). This also
  // completes a just-deferred marker-2 request without ever exposing a
  // 540-frame active ring. Stage 1's post-boss dialogue reaches 50000 on
  // processing frame 10255 and the native PRE10256 already contains the
  // +10000 max/cherry award with cherryPlus reset to zero.
  forceBorderSurvival(): number {
    if (!this.borderEngaged) return 0;
    this.borderPending = false;
    this.borderTimer = 0;
    this.borderTimerFrac = 0;
    return this.finishBorderSurvival();
  }

  private finishBorderSurvival(): number {
    // Th07.exe FUN_0043e620 (spec §4, CONFIRMED instruction-by-instruction
    // @ 0x43e62b-0x43e68e): +10000 to both cherryMax (de56) and cherry
    // (de03), then score += the POST-add cherry. The popup receives that
    // same value ×10; only the score division is a lossless compiler no-op.
    this.cherryMax += 10000;
    this.cherry = Math.min(this.cherryMax, this.cherry + 10000);
    this.cherryPlus = 0;
    const bonus = this.cherry;
    this.events.onBorderEnd?.('survived', bonus);
    return bonus;
  }

  // Breaks the border. A hit is only absorbed by an ACTIVE border (exe
  // marker +0x240d == 1); a PENDING border (marker 2) does not shield and
  // survives the hit — it retries after the respawn. Bombs pass
  // includePending: FUN_0043d9a0's bomb branch consumes marker 1 AND 2
  // through the same FUN_0043eb00 free break (exe-bombs.md §1/delta 6).
  breakBorder(includePending = false): boolean {
    if (this.borderActive) {
      this.borderTimer = 0;
      this.borderTimerFrac = 0;
      this.borderPending = false;
      this.cherryPlus = 0; // FUN_0043eb00 resets DAT_00625870 (all.c:28983)
      this.events.onBorderEnd?.('broken', 0);
      return true;
    }
    if (includePending && this.borderPending) {
      this.borderPending = false;
      this.cherryPlus = 0;
      this.events.onBorderEnd?.('broken', 0);
      return true;
    }
    return false;
  }

  // Th07.exe FUN_0041ed50 (spec §3a, all.c 14181-14220), retail-simplified
  // (DAT_004b5ec3/DAT_004ca4d8 are confirmed-dead gates, spec §2/§3a — the
  // "alternate/reduced cherry" branch they'd gate is unreachable, omitted).
  // The DAT_0062583c>4 damage-halving branch (spec §3a raw source) never
  // fires in this port either: it requires an Extra/Phantasm difficulty
  // tier this port doesn't have (difficultyIndex is 0..3), so it's omitted
  // too — not a fidelity gap, just dead code under this port's difficulty
  // range.
  //   local14 = stage < 5 ? stage*2 : 10          (all.c:13997-14003 —
  //     DAT_0062583c is the STAGE NUMBER, not a difficulty tier;
  //     spec-extra-phantasm.md §0 corrected the old reading)
  //   focused = player+0x240b != 0
  //   focused non-boss hits award no cherry at all
  //   divisor = isBoss && !focused
  //     ? 10 - floor(local14/3)
  //     : 30 - local14
  //   gain = min(70, floor(damage/divisor) * 10)
  //   if gain == 0 and (!focused || bossTimerOdd): gain = 10
  //   if shotIndex==0 (ReimuA, DAT_00625627=='\0') and gain in
  //      {20,30} and bossTimerOdd: gain -= 10      (all.c:14198-14202)
  // `bossTimerOdd` is bit0 of the enemy's own boss-phase timer field
  // (`enemyFlags_2bcc`, PROBABLE identity — spec §3a/§5 item 3); this port
  // exposes the same counter as `Enemy.ecl.bossTimer`, which is 0 (hence
  // always even) for every non-boss enemy, matching the exe's
  // boss-only-observed behavior for this quirk.
  onShotHit(
    damage: number,
    isBoss: boolean,
    stageNumber: number,
    shotIndex: number,
    bossTimerOdd: boolean,
    focused = false
  ): void {
    // Th07.exe FUN_0041ed50 @ 0x41f8c7-0x41f8ed gates this whole economy
    // branch on boss || !focused. DAT_004b5ec3 is player+0x240b, the focus
    // byte written by FUN_0043be00, not a spell/boss global.
    if (!isBoss && focused) return;
    const local14 = stageNumber < 5 ? stageNumber * 2 : 10;
    const divisor = isBoss && !focused
      ? 10 - Math.floor(local14 / 3)
      : 30 - local14;
    let g = Math.min(70, Math.floor(damage / divisor) * 10);
    if (g === 0 && (!focused || bossTimerOdd)) g = 10;
    if (shotIndex === 0 && (g === 20 || g === 30) && bossTimerOdd) g -= 10;
    this.gain(g);
  }

  // Th07.exe FUN_00430c10 case 6 (all.c:22191-22204). Outside a bomb this
  // awards +20 through dc6f. While DAT_004ca4d8 (bomb-active) is set, even
  // fixed slots award +10 through dc6f and odd slots award +10 through the
  // cherry-only dd6c helper.
  onSmallCherryItem(bombActive = false, evenSlot = true): void {
    if (!bombActive) this.gain(20);
    else if (evenSlot) this.gain(10);
    else this.gainCherryOnly(10);
  }

  drainBomb(amount: number): void {
    if (amount <= 0) return;
    this.cherry = Math.max(0, this.cherry - amount);
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

  // Th07.exe FUN_00430c10 case 8 (spec §3b): the unboxed Cherry item used
  // by the Border-break circle —
  // +30 cherry+cherryPlus (dc6f) AND +70 cherry-only (dd6c), for +100
  // total cherry / +30 cherryPlus. No score effect. (Previously mislabeled
  // "Big Cherry" and wired to the 'bigCherry' ItemType — that item is exe
  // case 7 above.)
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

  // Th07.exe FUN_00430c10 case 6 @ 0x4317d7: player+0x23dc
  // (DAT_004b5e94) is set on the bomb trigger in FUN_0043d9a0 and remains
  // set through the active bomb. In that state a small Cherry is flat 100/10
  // = 10 score; otherwise it uses floor(graze/40)*10+300, divided by 10.
  // Case 9 uses the graze formula unconditionally, so callers leave
  // bombActive false for that item type.
  grazeScaledItemScore(graze: number, bombActive = false): number {
    if (bombActive) return 10;
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
    // Th07.exe FUN_0043bb30 tail (all.c:27972-27981): the +30 focused /
    // +80 unfocused cherryMax+cherry award sits INSIDE
    // `if (player+0x240d == 1)` — it only flows while a border is ACTIVE.
    // Grazing outside a border earns no cherry at all (the graze counter,
    // +200 score, and spell-bonus increments before that gate are
    // unconditional), and it never touches cherryPlus either way. The port
    // used to award it on every graze, inflating cherry/cherryMax ~10x.
    if (!this.borderActive) return;
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
  // round(cherry*RATE))); cherry -= penalty. DAT_0056b928 is the currently
  // selected 52-byte SHT header, so +0x1c is exactly Sht.cherryLossOnDeath
  // (FUN_0043a820 reads the same pointer's +8 deathbomb window, +0xc hitbox,
  // +0x10 grazebox, and +0x20 PoC line). The twelve original SHT files carry
  // 0.5 for Reimu/Marisa and 0.33 for Sakuya. `cap` = 60000 when
  // DAT_00625625 == 2 (Sakuya), otherwise 100000.
  onDeath(lossRatio: number, isSakuya: boolean): void {
    const cap = isSakuya ? 60000 : 100000;
    const penalty = Math.min(cap, Math.round(this.cherry * lossRatio));
    this.cherry = Math.max(0, this.cherry - floor10(penalty));
    // A miss does NOT touch cherryPlus or a pending border: the miss body
    // (FUN_0043dca0) contains no DAT_00625870 write — the global's complete
    // write-site list is the HUD countdown (all.c:28735-28739), survive
    // reset (28796), break reset (28983), the defer pin (29274), and the
    // replay round-trip (29736-29738). A pending border simply retries
    // once the respawn invulnerability window clears. (An earlier port
    // zeroed cherryPlus here — fabricated.)
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
  //   v = (guaranteedMax || y < pocLineY) ? 50000
  //       : 50000 - 100*ftol(y - pocLineY)
  //   if v < 50000 and cherry > 50000: v += floor((cherry-50000)/5)
  //   else if v >= 50000 and cherry > 50000: v = cherry
  //   v = floor10(v)
  //   score += v/10
  pointItemScore(y: number, pocLineY: number, guaranteedMax = false): number {
    // FUN_00430c10 case 1 tests only the item's live Y position here. The
    // auto-collect byte is +0x27f, while the separate +0x280 guaranteed-max
    // byte is the one that can override this calculation. DAT_004b5ec5 is
    // the live Border force-collect flag: Border attraction sets +0x280,
    // while ordinary PoC attraction and pre-latched clear items do not.
    // FUN_00481260 is MSVC's x87 float-to-int helper: despite Ghidra's
    // `ROUND` label it corrects FISTP back to truncation toward zero. Native
    // Stage-1 item y=184.765747 therefore uses 56, not Math.round(...)=57.
    let v = guaranteedMax || y < pocLineY ? 50000 : 50000 - 100 * Math.trunc(y - pocLineY);
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
  largeCherryItemScore(y: number, pocLineY: number, guaranteedMax = false): number {
    if (this.cherry < this.cherryMax) return 0;
    // Case 7 has the same +0x280 guaranteed-max override as point items,
    // not an auto-collect override. Native Stage-3 processing 704 collects
    // an attracted type-7 item below the line for 4890, while the old port
    // incorrectly credited the flat 5000.
    const bonus = guaranteedMax || y < pocLineY ? 50000 : 50000 - 100 * Math.trunc(y - pocLineY);
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
