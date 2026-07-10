# FIX_LOG — ECL / bullet-pattern fidelity

Running log of ECL and bullet/nonspell/spell-card fidelity fixes, one entry per
commit, so **Fable 5** can review the reasoning and RE evidence later. Authority
is always Th07.exe v1.00b (decompile in `reference/re-specs/tools/all.c`) and the
stage-1 ECL dump (`reference/re-specs/stage1-ecl-dump.txt`). Newest first.

---

## 2026-07-10 — exe-faithful damage pipeline (fixes "spell card HP melts too fast" for Cirno + Letty)

**Symptom reported:** Cirno's spell card (and Letty's) die far too fast vs
vanilla; user asked for exe-exact per-phase HP and player shot damage.

**Per-phase HP was already exe-correct** (Cirno 10000 nonspell → 1200 spell
via the op-148 life threshold; Letty 15000/1700/15000/2000). The real gap
was the DAMAGE side: Th07.exe applies several reductions our engine lacked.
Decoded from FUN_0041ed50 @ 0x41ed50 (+ disassembly for the register-arg
sites) and FUN_0043a980 @ 0x43a980:

1. **Spell card active → shot damage /7** (raw < 8 → 1). Gate global is
   DAT_012f40a8, set by op 90 declare (FUN_0040ee30), cleared by op 91.
   With the per-frame cap this bounds spells to ≤10 HP/frame from shots.
2. **Per-enemy per-frame damage cap 70** — now TH07-CONFIRMED
   (`0x46` @ all.c:14226), no longer TH06 lore. Applied to the frame SUM,
   after cherry accrual (cherry uses the pre-cap sum).
3. **op 142 = N-frame damage shield** (enemy+0x4f40, case 0x8d; countdown
   FUN_00436a06(1) @ all.c:14440): boss damage /9, non-boss 0. Every
   stage-1 spell arms it at declare: Cirno 60f, Ringing Cold 300f, finals
   360/240/240f. Resolves exe-misc-ecl-ops.md §5's UNRESOLVED decrement.
4. **While the player's bomb is active, shots do table/3 (min 1)**
   (FUN_0043a980, player+0x16a20 gate).
5. **Bomb damage during a spell = 0** unless a bomb was triggered during
   that spell (DAT_012f40bc latch @ 0x41faeb); then /2.5 min 1
   (DAT_0048eda8 = 2.5, read from the exe binary).
6. **Score/cherry accrue even on invulnerable bosses** — the canTakeDamage
   bit only guards the HP subtraction in the exe; shots absorbed during
   declare still feed score + cherry.
7. **Boss timer-callback timeout costs 25% cherry** (FUN_0041e6b0 path,
   all.c:13820-13840, gated on the op-135 flag) — applies to nonspell
   timeouts too. cherry.onBossTimeout existed but was never wired; now is.
8. **Real spell capture bonus**: base table @ 0x4951a8 (stage-1 ids 0-9:
   2.0M/2.0M/2.2M/2.2M/2.4M×6), decays base/(timerSec+10) per second while
   capture valid, +2500+floor(cherry/1500)·20 per graze (all.c:27969);
   banner shows the full value, score += value/10 (all.c:6644). Replaces
   the fabricated `100000 + spellId*10000`. Sanity check vs the user's
   vanilla screenshot: Ringing Cold -Lunatic- base 2.4M, timer 3000f →
   decay 40000/s → +1766840 banner ≈ capture at ~15.8s. ✓

**Implementation:** damage is now accumulated per enemy per frame
(`Enemy.pendingShotDmg/pendingBombDmg`) and settled once per frame through
the exe pipeline (`StageScene#settlePendingDamage`), replacing the per-hit
`frameDamage` ledger. Cherry's onShotHit moves to the settled pre-cap sum
(exe order), fixing per-hit-vs-per-frame divisor rounding drift.

### Verification (Lunatic, ReimuA power 128, constant fire, no cheats)
Phase durations: Cirno nonspell 27.9s, **Frost Columns 17.8s** (was ~2s),
Letty nonspell-1 18.2s, Ringing Cold 21.9s, nonspell-2 16.2s, Table Turning
31.8s. Full fight, 0 page errors; tsc clean; 24/24 tests.

### Known approximations (flagged)
- Bonus decay rounding: exe writes floor10(ftol(<hidden float expr>)) per
  frame; we compute floor10(base − decay·elapsed/60). Sub-10-point drift.
- Bomb damage cadence itself is still the flat 8/frame 128px approximation
  (AGENTS.md §7); only its interaction rules (/3 shots, spell-zero latch,
  /2.5) are exe-derived.

---

## 2026-07-10 — op 104 = player-shot collision gate (fixes Letty nonspell 2 "spawns no bullets", emitter survival everywhere)

**Symptom reported:** Letty's 2nd nonspell spawns no bullets in real play.

**Root cause:** op 104 was decoded as `HIT_SOUND` (TH07-TODO, stored and
ignored). Th07.exe dispatcher `case 0x67` actually writes **bit4 of the
enemy flag byte `+0x2e29`**, and the master enemy loop `FUN_0041ed50`
(all.c:14174-14176) runs the player-shot/bomb hit test `FUN_0043a980` only
when `bit0 && bit4`. Default is bit4=1 (`FUN_0041d190 @ 0x41d190`). Stage 1
sets `op104 = 0` in subs **36/41/43/50/54/57** — every boss *emitter child*
(Letty nonspell-1 sweep children, nonspell-2 orbiting orbs, Ringing Cold
emitters, all three final-spell snowflake/orb spawners). In the exe these
are **shot-transparent**: player shots pass straight through (no damage, no
shot absorption, no homing eligibility — the homing-target repopulate at
all.c:14258 is *inside* the bit4-gated block).

Our engine ignored the flag, so every 1-HP (`life=1`) emitter died to the
player's shot stream the frame it spawned — patterns only appeared if the
player stopped firing. Measured (Lunatic, power 128, holding shoot):
nonspell-2 bullets 0 → **413 peak** after the fix; ring-sweep children now
reach 20 concurrent; final spell reaches 386 bullets with 5 snowflakes.

**Also corrected:** the player-bullet loop previously gated shot collision
on `collisionEnabled` (bit1, op 102) — the exe uses bit1 only for the
enemy-body-vs-player check; shots use bit4. Bomb damage and homing/aim
target selection now respect the same gate (both sit inside the gated block
in the exe).

### Files
- `types.ts`/`eclvm.ts`: `EclState.hitSound` → `shotCollision` (default
  true); op 104 sets it.
- `stage-scene.ts`: shot loop gates on `shotCollision` (not
  `collisionEnabled`); homing cache, `findAimTarget`, and bomb damage add
  the gate.
- `main.ts`: test-only `setInvuln` hook (same spirit as `setLives`) so
  probes can watch full patterns without death-wipes clearing bullets.

### Verification
`npm run check` clean, 24/24 tests, full Lunatic probe to Letty phases 1-4
with no page errors; nonspell-2 peak screenshot matches the user's vanilla
reference (dense blue-ball spray from three orbiting emitters).

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
