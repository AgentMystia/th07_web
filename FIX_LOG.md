# FIX_LOG — ECL / bullet-pattern fidelity

Running log of ECL and bullet/nonspell/spell-card fidelity fixes, one entry per
commit, so **Fable 5** can review the reasoning and RE evidence later. Authority
is always Th07.exe v1.00b (decompile in `reference/re-specs/tools/all.c`) and the
stage-1 ECL dump (`reference/re-specs/stage1-ecl-dump.txt`). Newest first.

---

## 2026-07-10 — op-79 ex-behaviors: per-slot params + cond gate (fixes Cirno "frozen/supersonic", Letty "supersonic")

**Symptoms reported:** Cirno's nonspell froze (or went supersonic); Letty's
nonspells + spell cards acted "supersonic" (bullets far too fast).

**These were regressions from commit `5fd3d47`.** That commit fixed the behavior
*index* bugs (D1) and made the speed/angle behaviors independent `if`s (D3), but
left two deeper exe-model gaps unimplemented, which the D1/D3 fixes then exposed.

### Root cause 1 — single ex-prop slot (audit gap D2)  → Cirno frozen/supersonic
The engine stored ONE `bulletExInts/Floats` per enemy, overwritten by each op-79.
Cirno's spiral (Sub 25, FIRE `flags=0x65`) issues **three** op-79 slots before the
fire: slot0 speed-ramp, slot1 angle-change `[speedDelta=0, angleDelta=0.0524, lim=60]`,
slot2 dir-change `[angle=2.7489, newSpeed=keep, interval=60, maxTimes=1]`. With one
stored slot, only slot2 survived, so the **concurrent angle-change (0x20) read the
dir-change slot's floats**: `speedDelta=exFloats[0]=2.7489` → speed `2.5 + 2.7489·13 ≈ 36`
(measured 36.6, "supersonic"); a later fire (`flags=0x64`) left slot2 =
angle-change `[0,0.0262]`, so dir-change read `newSpeed=exFloats[1]=0.0262` → speed
`≈0.03` ("frozen"). Both measured exactly.
**Fix:** store all 5 op-79 template slots per enemy (`bulletExSlots`, indexed by
arg0), snapshot them into `BulletProps.exSlots` at FIRE, and resolve each into its
OWN per-behavior param object on the bullet at spawn (`exAccel/exAngle/exDir/exBounce`).

### Root cause 2 — missing cond gate  → Letty supersonic
Th07.exe's ex-instruction dispatcher `FUN_004229f0 @ 0x4229f0` activates **one slot
per frame** and STOPS at `if (cond==0 && behaviorFlags!=0)`. Letty's Lingering-Cold
emitter (Sub 35) is slot0 speed-ramp (`cond=0`) + slot1 accel (`cond=0`, mag 0.0083,
`limit=120`), FIRE `flags=0x215`. Speed-ramp activates first and sets a behavior
flag, so the accel slot (`cond=0`) hits the gate and **never activates** in the real
game — Letty's bullets are speed-ramp-only (settle to constant speed, no accel).
The old engine ignored the gate and *ran* the accel; combined with a fabricated
`b.speed = Math.hypot(vx,vy)` in the accel branch (the exe's `FUN_00423910` never
writes the speed scalar), the speed-ramp re-read the inflated speed each frame →
exponential blowup = "supersonic."
**Fix:** `resolveExBehaviors()` replays the cond gate in one pass at spawn (the
behavior-flag set only grows, so one pass = same activation set). Accel no longer
writes the speed scalar. Speed-ramp clear no longer resets velocity (exe just
clears the bit — `FUN_00423840` else branch).

### Files
- `types.ts`: `BulletExSlot` iface; `EclState.bulletExSlots`; `BulletProps.exSlots`;
  `EnemyBullet.exFlags/exAccel/exAngle/exDir/exBounce` (replace `exInts/exFloats`).
- `eclvm.ts`: `resolveExBehaviors()` (cond-gate replay); op-79 writes one slot;
  readBulletProps/spawnBullets carry slots + resolve per bullet.
- `stage-scene.ts`: `updateBulletMotion/dirChangeBullet/bounceBullet` read
  `b.exFlags` + resolved params; accel drops the `hypot` speed write.

### Verification (Lunatic, the target difficulty)
- Cirno nonspell max bullet speed **36.6 → 6.4** px/frame; the 0.03 "frozen" wave gone.
- Letty full fight overall max **7.5** px/frame (= speed-ramp `base+5` peak, correct);
  no accel, no supersonic.
- Lingering Cold renders the blue expanding ring + cyan aimed cone (matches ref
  `屏幕截图_20260710_001940.png`); Cirno nonspell renders coherent expanding rings.
- Full Lunatic Stage 1 clear, 0 page errors; `tsc` clean; 24/24 unit tests.

### For Fable 5 to review / known minor deviations
1. **Activation timing collapsed to spawn.** The exe activates one slot per frame
   (slot k at frame ~k) with per-behavior age counters; we activate the whole
   (gated) set at spawn and share one post-spawn `age`. Effect: ≤ (#slots) frames
   of offset on staggered behaviors (e.g. Cirno angle-change/dir-change start ~1–2f
   early). Sub-perceptible; revisit if a pattern needs bit-exact phase.
2. **Bounce speed sentinel** uses `<= -999` (exe uses `DAT_0048ea9c`, value not
   pinned). Stage 1 fires no bounce bullets, so untested in practice.
3. **Cull grace** still uses the fat-margin approximation (audit D5), gated on the
   FIRE flags (`b.flags & 0xdc0`), not the live `exFlags`; unchanged this commit.
4. **"Cirno spell too-low HP" — investigated, NOT a bug (no code change).** The
   user reported Frost Columns felt too low-HP. Traced: Cirno Sub 20 does
   `SET_HP=10000` (nonspell) + op 148 `slot0 {threshold:1200, sub:29}` +
   `TIMER_CALLBACK 1680 -> sub 29`. The spell (Sub 29) has no SET_HP; its 1200 HP
   comes from op 148's threshold (the life callback clamps HP to 1200 on entry, or
   the timer callback clamps to the largest armed threshold = 1200). The ECL dump
   mislabels op 148 as `SCHEDULE_TIMER_SUB atFrame=1200`, but disassembly settles
   it: `case 0x93` stores arg1 at `+0x2ebc` and it is compared against the boss HP
   `+0x2bb8` (all.c:13743-13744; the timer-clamp at 13809-13817 writes `+0x2bb8 =
   max threshold`, matching eclvm checkCallbacks). So **1200 is exe-correct**; the
   "too low HP" feel was a side effect of the broken nonspell (frozen bullets ->
   trivially dodgeable -> Cirno damaged past 1200 in seconds). With the nonspell
   fixed the fight is properly paced. Verified Frost Columns renders the blue/white
   frost-column fan at sane speeds; Letty's first nonspell renders crystal arcs +
   green aimed fans (max 4 px/frame), no supersonic.
