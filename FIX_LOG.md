# FIX_LOG — ECL / bullet-pattern fidelity

Running log of ECL and bullet/nonspell/spell-card fidelity fixes, one entry per
commit, so **Fable 5** can review the reasoning and RE evidence later. Authority
is always Th07.exe v1.00b (decompile in `reference/re-specs/tools/all.c`) and the
stage-1 ECL dump (`reference/re-specs/stage1-ecl-dump.txt`). Newest first.

---

## 2026-07-10 — GLM-PLAN-2 follow-up: full BGM, boss UI, multi-slot boss presence, op10, stage-clear probes

### Symptom
- Stages 2-8 fell back to stage-1 BGM themes (only tracks 01-03 shipped).
- No boss X-position marker; Spell Card Bonus was a single gold line; failure
  still printed "Bonus failed..." (exe draws nothing on failure).
- Stage 4 Prismriver manager registered as boss then lost `bossActive` when
  helper slots 1-3 registered / released (multi-slot `setBossPresent` race).
- Timeline life=1 overwrote t=0 op110 HP after the initial ECL run, so a boss
  could be death-callback'd on frame 1 by the first player shot.
- Stage 3 logged `unhandled ECL op 10` (Alice dolls).

### Root cause / fix
1. **BGM**: `thbgmogg.dat` supplied; `TRACK_WHITELIST` opened; `npm run
   generate-bgm` produced th07_01..19 + 13b under `assets/audio/th07/`.
2. **Boss marker** (GLM-PLAN-2 §3 / spec-ui-stageclear.md §3): fallback
   "Enemy" label at playfield bottom, x = clamp(boss.x), ~60% alpha — exact
   sprite not recovered from front.anm.
3. **Spell Card Bonus** (spec §4 / all.c:17171-17193): red label at y=80 +
   2× light-salmon value, 280 frames; failure arms nothing.
4. **`syncBossPresence`**: recompute from all bossSlots; prefer slot 0 for
   UI/damageBoss; helper release no longer blanks the main boss.
5. **Spawn HP order**: apply timeline life/score *before* the initial ECL
   run so op110 sticks (all stages' bosses ship life=1 as placeholder).
6. **op10**: random-sign float assign (all.c:7486-7503).
7. **Probe tooling**: `scripts/stage-clear-probe.mjs` with dialogue skip +
   damageBoss pump; visual verification via pixel-report against the user's
   vanilla reference screenshots (stage-2 intro / stage-clear tally).

### Verification
- `npm run check && npm run build && npm test` → 25/25.
- Smoke f900 all 8 stages: enemies>0, no PAGE ERRORS.
- Stage 1 Lunatic clear ≈10680-18720f; stage 2 clear ≈16530f; stage 3 clear
  ≈18360f (16 lasers); stage 4 clear under damageBoss ≈16637f.
- Visual: stage-2 intro matches user ref (std2txt title/quote/BGM/cat icon);
  Cirno fight shows "Enemy" marker under playfield; spell capture shows red
  "Spell Card Bonus!" + salmon value; stage-clear tally layout intact.
- Pixel-report: hud-labels texture≈37%, logo≥91%, frame tiles #400e20.

### Still open (not blockers for this commit)
- Stages 5-8 long-clear: some death-callback subs stall at hp=1 (needs per-
  boss RE); stage-4 visible sisters (op145→sub0) incomplete.
- Effect ids 17/18, 7/8; STD op 29 bg bank; arcade stage-transition carry
  probe (test mode does not chain stages).

---

## 2026-07-10 — ALL 8 STAGES: data pipeline, progression, lasers, op27, effect ops, Extra/Phantasm (commits 763b50f + d52523b)

Two commits landing the "implement all stages" batch. RE was produced by a
4-agent Sonnet-5 ultracode pass, audited, and archived in the repo:
`reference/re-specs/spec-{ui-stageclear,op27-effects,lasers,extra-phantasm}.md`.
**Handover for the remaining steps: `reference/re-specs/GLM-PLAN-2.md`.**

Highlights (full details in the specs + commit messages):
- Stage data 1-8 embedded; STD quad script ids resolve through the exe's
  per-file virtual bases (0x300 + 16/file, all.c:2909-2943).
- Stage flow: exe-exact clear tally (internal = stage·100000 + graze·50 +
  point·5000 + cherry; ×{0.5,1,1.2,1.5,2,1}; All Clear + Player/Bomb rows
  on stage ≥6; display = internal×10) → Z → next stage with carry.
- Score HUD displays internal×10 (the exe's "%8d0" appended-zero trick) —
  supersedes the earlier "no ×10" adjudication in EXECUTION-LOG.md.
- `DAT_0062583c` is the STAGE NUMBER, not a difficulty tier: cherry
  divisor local14 = min(stage·2,10) (all.c:13997-14003) and the stage-4
  (×11/16) / stage-5-6 (×1/2) type-A non-boss shot-damage reductions
  (all.c:14200-14209) now implemented.
- Full laser system per spec-lasers.md: ops 82-89/134/152/156-158,
  grow-hold-shrink states, exe box collision (kill box spans the beam only
  during HOLD; width/2 extent halved again by the 0.5 factor; graze +48
  pad on 12-frame ticks = the exe's phaseFrame%12 flag), FUN_00422ea0
  laser-clear + 10-frame post-clear spawn suppression.
- op27 8-slot interp (LERP/Hermite, 7 eases) with float-path writes incl.
  own position; op121/122 effect table (ids 0/5/10/11/20 real; decorative
  no-ops); op144 periodic gosub (NOT death-spawn); op145 remote sub;
  op143/146 cancels; op151 polar→XY; op155 wall-aware random angle
  (constants 96/288/π-fractions read from the binary); op159 lerp;
  op160 = cherry gain (was a wrong awardSpellValue guess).
- SPELL_BONUS_BASE = full int32[141] @ 0x4951a8; Extra/Phantasm: menu
  entry, difficulty 4/5, lives 2 (all.c:19715), power 128 (PROBABLE),
  cherryMax 400000, BGM tracks 16-19 (14/15 are ending themes).

### Verification
25/25 tests; all 8 stages boot and run headlessly with live enemy/bullet
counts; stage-3 Alice doll spell fires 16 tracked lasers
(screenshot-verified); stage-2 intro matches the vanilla reference
screenshot (stdNtxt.anm scripts played verbatim). NOT yet verified: full
clears of stages 2-8 (GLM-PLAN-2 step 1), enemy marker, spell-bonus text
presentation, effect ids 7/8/17/18, stage-4 bg bank switch (STD op 29).

---

## 2026-07-10 — exe FIRE pipeline (rank 0), bullet cancel/sweep economy, hitbox type 3, border activation (fixes "border never activates" + universal-fidelity pass)

One batch commit (hunks inseparable in stage-scene.ts); concerns below.
Everything here is re-derived from the exe per the "fix from RE so fixes
are universal" directive; claims from the interim RE handoff doc
(`reference/re-specs/RE-2026-07-10.md`) were independently re-verified
against all.c / the binary before landing.

### 1. Rank is 0, not 16 — and op73/74 intervals are rank-scaled

`DAT_00625884` (rank) sits in `.data`'s zero-fill tail (offset 0x193884 >
rawSize 0x3800 — read from the PE headers), i.e. **BSS, default 0**; its
only writes are the replay-header round-trip (all.c:29606/29725), and no
stage ECL ever touches its var 10017 (grep over all 8 decompiled ECLs).
Retail therefore plays the whole game at rank 0. Our hardcoded 16 made
every non-spell pattern +0.5 px/f faster (rankSpd identity is at 16) and
fire 20% more often — because op73/74 (cases 0x48/0x49) scale the interval
at set time: `iv' = iv + trunc(iv/5) + trunc(-2·trunc(iv/5)·rank/32)`
(identity at 16, ×1.2 at 0). Both fixed: `rank = 0` + the interval formula
in the op73/74 handler.

### 2. op75/76 gate only the immediate FIRE; op77 = re-fire; op80 = cancel

- The auto-shoot tick (all.c:7194-7208) checks only `interval>0 && hp>0`
  — never the op75 bit (0x20 of +0x2e28); that bit gates just the
  immediate fire inside FIRE ops 64-72 (all.c:8545). Our `shootDisabled`
  early-out in updateAutoShoot silenced every op75-then-op73 pattern —
  removed.
- **op77** (case 0x4c) = refresh shoot pos + `FUN_00423480` re-fire of the
  current template. Was missing entirely.
- **op80** (case 0x4f) = `FUN_00422ea0(1)` bullet cancel — we had it as a
  re-fire. See §4 for what the cancel spawns.

### 3. Bullet hitbox table: type 3 is 6.0

`FUN_004256d0` classifies by primary-sprite width (thresholds 8/16/32 @
0x48eacc/d0/d4) then special-cases by anm script id; in the 8<w≤16
bracket only ids 0x202/204/205/206 (rice/kunai/crystal/knife) get 4.0,
the default is 6.0 — and type 3's primary script is 0x203 (id table @
0x48b160 read from the binary). Full table now
`[4,6,4,6,4,4,4,10,5,8,24]` (index 3 was 4). Kill and graze share the
value; graze adds the flat +20 pad (0x48ebf4) at the test site — both
already correct in checkPlayerCollision.

### 4. Cancel/sweep economy — what bullets turn into, exactly

- The cancel item type (+0x37a160) is baked to **6 = small cherry** by the
  bullet-manager constructor (`mov [eax+0x37a160], 6` @ va 0x421a76 in
  FUN_00421a40) and never changed. So `FUN_00422ea0(1)` — op80, the op90
  spell declare (all.c:6511), and the full-power crossing inside item
  collect — converts every live bullet into an auto-collecting small
  cherry item (+20 cherry/+20 cherryPlus each on pickup), no score sweep.
- **Phase-end scored sweep** (op91 spell end via FUN_0040f340, and boss
  death outside a spell @ all.c:14343): `FUN_00423100(8000,1)` pops an
  escalating 2000/+20-per-bullet value per converted bullet, then
  `FUN_004217c0(8000,·)` sweeps non-boss helpers (2000/+30, item gated on
  the op136 bit5 flag — verified at all.c:14884), `score += total/10`.
  op94 calls the same helper sweep but DISCARDS the total (all.c:9029).
  The sweep is skipped when the phase timed out — the timeout path
  (all.c:13831) instead fades bullets with NO items (`FUN_00422ea0(10)`)
  and bumps the spell state so op91 knows.
- **Bomb-touched bullets** spawn item type `DAT_004b5ebc` — BSS, no
  writes, so **0 = power** (bullet tick @ all.c:16160), which
  `FUN_00430970` converts to a **big cherry (+1000+100×captures)** at
  power ≥ 128. That conversion is the vanilla bomb-to-charge-border
  economy; our old 'pointBullet' spawn starved it.
- Our 'pointBullet' collect is rewired to its true exe semantics (type 8
  cancel star: +30 dc6f / +70 dd6c, no score — FUN_00430c10 case 8) and
  is now unspawned, matching retail (the only type-8 spawner,
  `FUN_00422ea0(3..8)`, has no caller).
- op136 renamed `bodyRegrazeFlag` → `sweepItemFlag` (bit5's two consumers:
  sweep drop + body re-graze).

### 5. Border activation (the actual "never activates" chain)

Two independent bugs starved it:
1. 'bigCherry' collect was wired to exe case 8 (+30 cherryPlus) instead
   of case 7 (+1000+100×captures) — fixed in this tree earlier.
2. `onPlayerHit()` called `cherry.breakBorder()` BEFORE the
   invulnerability check, so a contact during ANY invuln window (spawn,
   bomb, or the 30 frames granted by a previous border absorb) still
   destroyed a fresh border the frame it started. The exe's kill outcome
   never runs while invulnerable. Border-break now happens only for a
   genuinely hittable player.

### Verification

`tsc` clean, build clean, 25/25 unit tests. Border probe (Lunatic, max
power, PoC camping, 5400 frames): cherryPlus 0→50000 in ~40s of stage
play, **border #1 activates at frame 2407** and runs its full 540 frames
(vanilla economy estimate: 1-2 borders/stage). Full-fight pacing probe
completes all 6 boss phases with no page errors (Frost Columns 17.9s,
Lingering Cold 21.9s, Table Turning 31.9s — same band as the previously
verified vanilla pacing).

**Letty nonspell-1 "few aimed bullets": NOT a bug** — her main fans fire
aimMode 1 (absolute angles, no player aim); only the every-4th sub34 ring
is aimMode 2 (aimed). Confirmed against the FIRE dispatcher aimMode
semantics; no aim hack added, per the universal-fidelity directive.

---

## 2026-07-10 — SE system: exact exe slot table + restart-not-stack voices (fixes "too loud, like broken headphones")

**Symptom reported:** sound effects wrong and far too loud ("就像耳机坏掉
了").

**Root cause:** the port played every SE at full volume and stacked
overlapping copies of the same sound. Th07.exe's SE system
(FUN_00446970/FUN_00446c20): 38 slots @ 0x494a78, each `{wavIndex i16,
millibels i16, priority i16}` → amplitude `10^(mB/2000)` (e.g. slot 7
se_tan00 −1500 mB = 0.178, slot 20 se_damage00 −1400 = 0.200); one
DirectSound duplicated buffer per slot — retriggering RESTARTS the slot's
voice instead of layering a new one; ECL/engine sound ids index the SLOT
table, not the wav list.

**Fix:** `SFX_SLOTS` table (38 exact `[wav, amplitude]` entries read from
the exe rdata), `audio.ts` keeps one voice per slot key and stops it on
retrigger, and every call site remapped to its true slot id (death 2/3
alternating per exe disasm @ 0x420379, damage tick 20, graze 30, spell
declare 14, capture 33, border start 32 / survive 36, item 21, extend 28,
menu select/ok/cancel 12/10/11 in title-scene).

---

## 2026-07-10 — dialogue: exe MSG wait semantics + live player shots (fixes "bullets freeze in dialog" / "end dialog can't be skipped")

Th07.exe MSG interpreter FUN_00428392 @ 0x428392, case 4 (all.c:
17849-17858): a wait ends on (a) timeout, (b) a **Z press edge once the
wait is ≥12 frames old — NOT gated by op 13**, or (c) CTRL fast-forward
(input bit 0x100), which IS gated by op 13 and jumps the clock to the
next instruction's timestamp. The old runner gated Z on op 13, making the
post-boss tail waits (300/900/1200f) unskippable. Player shots also kept
flying during dialogue in the exe — the stage tick now updates player
bullets (collision off) while dialogue blocks, instead of freezing them
on screen.

---

## 2026-07-10 — core loop: bounded catch-up (fixes "Sakuya seems too slow")

Movement math was verified exe-exact (FUN_0043be00: four pre-baked SHT
header floats, diagonal = speed/√2 in DATA, Sakuya unfocused 4.0 = Reimu;
no runtime ×0.707). The real cause was the render loop: one sim step per
rAF tick, so any sub-60Hz rAF delivery (throttling, 48/50 Hz displays,
jitter) slowed the WHOLE game uniformly. The loop now runs up to 3 catch-up steps
per tick against a fixed 60Hz accumulator and banks at most one step of
debt (no post-stall spiral).

---

## 2026-07-10 — cherry gauge: per-difficulty cherryMax + vanilla HUD display (fixes "should be 300000 not 50000")

**Symptom reported:** the cherry gauge shows `N/50000`; vanilla shows
`N/300000`-scale values (user screenshot: `86120/310000` with purple
`+18880`, Lunatic).

**Root cause:** the port conflated two different constants. 50000 is the
**cherryPlus** border trigger (correct, unchanged). The displayed gauge is
`cherry/cherryMax`, and **initial cherryMax is per-difficulty** — Th07.exe
run-init `FUN_0042cf2f @ 0x42cf2f` (all.c:19765-19796): Easy/Normal
200000, Hard 250000, Lunatic 300000 (Extra 400000, Phantasm 400000 with
cherry pre-loaded; practice mode adds +50000·(startStage−1) — both outside
this port's scope). The user's 310000 = 300000 + one border-survive's
+10000 to cherryMax. ✓

**HUD:** bottom-left banner now draws `cherry/cherryMax` (cherry
right-aligned into the banner blank, cherryMax after the baked slash) with
the small purple `+cherryPlus` above (exe draw @ all.c:1760-1870; vertex
color B/G/R 0xb0/0x80/0xc0). Previously drew `cherryPlus/50000`.

**Also:** `CherrySystem.onDeath`'s 60000 penalty cap was gated on
`difficultyIndex === 2` ("Hard", flagged PROBABLE). The Sakuya-only
second-homing-target code (upward cone −π/3..−2π/3, rdata @
0x48edc0/0x48edc4) proves `DAT_00625625` is the CHARACTER index, so the
cap is Sakuya-specific — now `onDeath(isSakuya)`.

### Verification
25/25 unit tests (new per-difficulty init test); Lunatic dev-shot at
frame 900 shows `480/300480` + purple `+0` — base 300000 with 6 unfocused
grazes' +480 to both cherry and cherryMax, cherryPlus untouched by graze,
all matching the exe accumulator rules.

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
