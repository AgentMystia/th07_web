# GLM-PLAN.md Execution Log

Append-only. Each step: name, what changed, verify numbers, commit hash (or SKIPPED + why).

## STEP 0 — baseline sanity
- git status --short -> `?? "bug report.txt"` only (clean).
- npm run check -> tsc silent (no errors).
- npm run build -> dist/th07.js 426.7kb, OK.
- npm test -> tests 18, pass 18, fail 0.
- node scripts/dev-shot.mjs /tmp/glm/s0.png 120 "difficulty=1"
  -> `{"frame":132,"enemies":1,"bullets":0,"playerBullets":0,"score":0,"boss":false,"spell":""}`
  -> enemies>=1 OK, NO `PAGE ERRORS` line. PASS.
- No commit (measurement/baseline only).

## STEP 1 — build boss-probe tool
- Copied scripts/dev-shot.mjs -> scripts/tmp-boss-probe.mjs (temporary; never committed; to be deleted in step 12).
- Adapted: argv now `<difficulty 0-3> <mode gentle|lump>`; replaced the fixed
  frame loop with the 900x30 boss/spell event probe loop. Adapted snapshot
  field names to the real ones in src/main.ts stageSnapshot():
  `snap.boss`->`snap.bossActive`, `snap.spell`->`snap.spellName`
  (bossHp and stageClear exist as-is).
- VERIFY `node scripts/tmp-boss-probe.mjs 1 gentle`: ran to a `clear` event
  (frame 19809) without exceptions; printed >=1 spell event; no PAGE ERRORS.
- Pre-fix n-gentle spell sequence (baseline for STEP 2): 寒符「リンガリングコールド」
  (f10620) -> 冬符「フラワーウィザラウェイ」 (f16023). boss-gone deltas: 75 (midboss), 0 (final).
- No commit.

## STEP 2 — eclvm.ts op148 HP-threshold callback (bug 3)
- 2a: replaced lifeCallbackThreshold/lifeCallbackSub/scheduledTimerSubs (types.ts
  + eclvm ctor) with lifeThresholds[4]={threshold,sub}[] (init 4x {-1,-1}).
- 2b: case112 -> lifeThresholds[0].threshold; case113 -> lifeThresholds[0].sub;
  case114 now also zeroes bossTimer (case 0x71); case148 -> op148(slot,thr,sub)
  into lifeThresholds[slot] (FUN_0040f6c0 case 0x93).
- ARG-ORDER CHECK (stage1-ecl-dump.txt): op148 decodes slot=0 atFrame=1200 sub=29
  and slot=0 atFrame=1700 sub=42 — matches. Current arg order (a=slot,a+4=thr,
  a+8=sub) already yields those triples.
- 2c: checkCallbacks rewritten to exe scan (FUN_0041e4a0 life slots 0..3 first
  fire, clamp up, cancel timer; FUN_0041e6b0 timer-cb clamps to largest armed).
  phaseTransition: deleted scheduledTimerSubs.length=0 (does not reset thresholds).
- 2d: killEnemy death-callback path disarms all 4 slots (array equiv). ALSO a
  forced compile-fix in src/game/stage-scene.ts timerThreshold(): scheduledTimerSubs
  fallback removed (op148 is HP-based now) -> returns timerCallbackThreshold or 6000.
  (STEP 2 names eclvm.ts+types.ts only; this stage-scene.ts touch is a direct
  consequence of removing the field and is required to keep `npm run check` green.)
- VERIFY: npm run check silent; build OK; test 18 pass 0 fail; dev-shot s2
  enemies=1 no PAGE ERRORS. Probes:
  - n-gentle: 寒符(f11345)->冬符(f14742), clear f18528; boss-gone deltas 75/0.
  - n-lump:   寒符(f8491)->冬符(f8644), clear f11396 (BOTH spells; regression fixed).
  - l-lump:   霜符「フロストコラムス -Lunatic-」(f2769)->寒符-Lunatic-(f8496)->怪符「テーブルターニング」(f8647), clear f11399.
- COMMIT 9225999 (files: src/game/eclvm.ts, src/game/types.ts, src/game/stage-scene.ts).

## STEP 3 — eclvm.ts drop timeline spawns while a boss is registered (bug 1)
- 3a: added `private bossRegistered = false` to StageRuntime; reset in reset().
- 3b: op99 sets `this.bossRegistered = slot >= 0` (DAT_00495bf4).
- 3c: releaseEnemy clears `this.bossRegistered = false` when `s.isBoss`
  (FUN_0041ea00: culling a registered boss clears the flag).
- 3d: runTimelineEvent spawn case (ops 0/2/4/6) returns null if bossRegistered
  (FUN_0041de20 gate); moved spawnLog push into the spawn case after the gate
  (so suppressed spawns are not logged); gave runTimelineEvent a `t` param to
  preserve the timeline index in the log entry; deleted the push from update().
- 3e: deleted the disproven "No boss-active suppression here..." comment.
- VERIFY: check/build/test green; dev-shot s3 enemies=19 bullets=24 no PAGE ERRORS.
  - n2 (Normal gentle): boss-gone deltas [0,0]; spells 寒符/冬符; CLEAR.
  - l2 (Lunatic gentle): boss-gone deltas [2,0]; spells 霜符/寒符/怪符; CLEAR.
- IMPORTANT — the l2 [2] is a 30-frame probe SAMPLING ARTIFACT, not a bug:
  a 1f-resolution probe matching the boss-probe's damage schedule shows Cirno
  deregisters at f5073 (boss+reg flip false TOGETHER) and the 2 spawns fire at
  f5084+ AFTER she is gone, inside the post-death sampling gap. REAL
  spawns-while-bossRegistered = 0. Normal's [0,0] is a timing coincidence (its
  first post-boss spawn lands in a later 30f sample). Code is correct; NOT
  reverted (rule-5 revert is for failing code; underlying behavior verified
  correct at 1f granularity). See commit f9ce69d body for the full evidence.
- COMMIT f9ce69d (file: src/game/eclvm.ts).

## STEP 4 — eclvm.ts exe bullet hitbox table + op92/93 split
- 4a: added `const BULLET_HITBOX_BY_SPRITE = [4,6,4,4,4,4,4,10,5,8,24]` (FUN_004256d0
  per-shape full widths); grazeW/grazeH now use `BULLET_HITBOX_BY_SPRITE[p.sprite] ??
  Math.max(3, rect.{w,h}*0.4)` fallback.
- 4b: split case 92 (absolute: x:gf(4),y:gf(8),z:gf(12), case 0x5b) from case 93
  (relative: e.x+gf(4) etc.). Stage 1 never uses op92.
- VERIFY: check/build/test green; dev-shot s4 enemies=19 bullets=24 no PAGE ERRORS.
- COMMIT 53aead8 (file: src/game/eclvm.ts).

## STEP 5 — stage-scene.ts hit-SFX per-frame dedup (bug 2)
- 5a: added `private sfxPlayedThisFrame = new Set<number>()`.
- 5b: `this.sfxPlayedThisFrame.clear()` at top of update() (after frameDamage.clear).
- 5c: playSfx(id) early-returns if id already in the set, else adds it (FUN_00446970).
- VERIFY: check/build/test green; dev-shot s5 800 difficulty=3 + shoot: playerBullets=11
  score=7800 no PAGE ERRORS. (Audio not audible; correctness = code+compile+boot per plan.)
- COMMIT b9cbddb (file: src/game/stage-scene.ts).

## STEP 6 — player hitbox halving + collision formulas
- 6a: player.hitboxHalf/grazeboxHalf now `sht.{hitbox,grazebox} / 2` (exe halves
  full widths at point of use; was 2x too big).
- 6b: sht.ts header comment fixed (hitbox/grazebox are FULL widths, not halves).
- 6c: checkPlayerCollision reworked — graze runs during invuln/bomb (only
  gameOver/!alive early-return); graze region = bulletFull/2+grazeboxHalf+20
  (FUN_0043b350), age>15 min; kill from spawn no age gate (FUN_004241c0); body
  ram hitbox/3 (FUN_0041ebc0); body graze hitbox/1.4 every 6f (both branches);
  graze score +200 (FUN_0043bb30, was +500). Added bodyGrazeCooldown Map.
- VERIFY: check/build/test green. dev-shot s6 f120 enemies=1 no PAGE ERRORS
  (player alive — FAILURE CLAUSE not triggered); s6b f2500+shoot score=69170.
  pixel-report: f120 hud-labels 37% (>=30%); f800 Lunatic sky 2% flat,
  ground 60/32/12% all textured, player-zone bright 168 texture 65%.
- COMMIT ee171d1 (files: src/game/player.ts, src/formats/sht.ts, src/game/stage-scene.ts).

## STEP 7 — regression test for bug 4 (etama bullet sprites)
- Appended test iterating the 14 OBSERVED (sprite,offset) combos from full
  Normal+Lunatic playthroughs; each must resolve to a real etama.png sprite
  within the 256x256 sheet. Pattern matches the existing AnmRunner usage.
- VERIFY: npm test -> # tests 19 (was 18), # fail 0.
- COMMIT dc56e75 (file: tests/th07-etama.test.mjs).

## STEP 8 — player shots pierce/SakuyaA aim/fire SFX
- 8a: updatePlayerBullets collision — lasers (4/5) full damage on even age only,
  no collided/sfx/decay (FUN_0043a980); others damage+collided+sfx, velocity/8
  except shotType 3 (MarisaA missile); damage+cherry moved into branches; deleted
  the b.damage/=2 halving.
- 8b: aimBulletAtSpawn `b.speed *= 1.5` (FUN_00439070) before vx/vy recompute.
- 8c: playSfx(0) when volley has a shot with sfxId>=0 (FUN_00438b70), replacing
  frame%8; kept the aimBulletAtSpawn call inside the push loop. sfxId already on
  PlayerBullet — no player.ts edit needed.
- VERIFY: check/build/test green; dev-shot f800 d3+shoot playerBullets=11 score=7800,
  f2500 d1+shoot score=69260, no PAGE ERRORS.
- COMMIT 8f45654 (file: src/game/stage-scene.ts).

## STEP 9 — SakuyaB orbit + corrected option offsets + 30f cycle
- 9a: ORB_OFFSETS -> unfocused (∓24,0), focused (∓8,−32); comment rewritten
  (FUN_0043be00; overturns the (∓32,+8) misread).
- 9b: added orbitAngle (public, rest −π/2) + lastVx fields; lastVx=dx*speed in
  move() (zeroed when !controllable); orbit steer/return/clamp at end of update().
- 9c: orbOffset() sakuyaB branch (orbit positions, 8f linear glide; other chars
  unchanged).
- 9d: stage-scene behaviorFunc===5 banks knife fan to orbitAngle+spread
  (FUN_00439160); at rest == table angle.
- 9e: SHOT_CYCLE 60->30 (FUN_0043a820). AGENTS.md §6 updated (cycle + orb consts).
- VERIFY: check/build/test green. dev-shot 400 +shoot +power=64: sakuyaB
  playerBullets=49, sakuyaA=37, reimuA=25, all no PAGE ERRORS. sakuyaB at-rest
  bullet angles = −1.571 (== table angles), spread −1.222, NaN count 0
  (throwaway scripts/dbg-angles.mjs, removed after).
- COMMIT 00692d3 (files: src/game/player.ts, src/game/stage-scene.ts, AGENTS.md).

## STEP 10 — bombs per-character exe params
- 10a: BOMB_PARAMS table [duration, invulnTotal, speedMult] by (character, focus).
- 10b: tryBomb selects from BOMB_PARAMS (bombInvuln=invulnTotal not duration+60);
  bombSpeedMult latched, reset to 1.0 when bombTimer hits 0.
- 10c: move() speed *= (bombTimer>0 ? bombSpeedMult : 1), uncapped.
- 10d: onBombUsed flags every live item to state=1 autocollect (FUN_00431d10).
- 10e: applyBombEffects localized to player-centered 128px (8 dmg/frame, cancel
  + point-item conversion per frame); Marisa star-bursts kept.
- VERIFY: check/build/test green. dev-shot f900 d3 shoot,bomb clean (held bomb
  yields no press-edge → plan fallback). Bomb path exercised via press-edge probe:
  reimuA 3->2 bombTimer 18 (dur 140), sakuyaB 4->3 bombTimer 39 (dur 160),
  per-character params confirmed, no PAGE ERRORS (throwaway dbg-bomb.mjs removed).
- COMMIT f49784a (files: src/game/player.ts, src/game/stage-scene.ts).

## STEP 11 — BGM post-fix measurement (finishes committed bug-5 fix)
- Ran `node reference/re-specs/tools/bgm-audit/measure-latency2.mjs` (unthrottled).
  Script's absolute paths (/th07_web/node_modules/playwright-core, root='/th07_web/')
  are correct for this repo location — no /tmp-scratchpad paths present, no
  adaptation needed.
- Metrics (performance.now ms): msPerFrame 16.57; frame0T_estimated=2431.9.
  - fetchStart(th07_02) = 44.7ms (fired at boot right after th07_01=44.1ms, the
    eager preloadBgm at AudioBus construction) — BEFORE menu navigation ends. PASS.
  - th07_02 decodeEnd = 215.7ms (decoded during boot, buf len 3874816 dur 87.9s).
  - sourceStart(th07_02) (stage-start playback, loop bufDur 87.9) = 2423.7ms <=
    frame0T 2431.9ms — AT/BEFORE stage frame 0 (delta -8.2ms). PASS.
    (The 222.5ms sourceStart is the title theme th07_01 played at boot, not th07_02.)
- Conclusion: the committed bug-5 fix (fe1fce0) works — th07_02 is fetched AND
  decoded at boot, so the buffer is ready at stage start; sourceStart lands at/before
  frame 0 (no 138.9ms gap, no multi-second throttle gap). No code change; no commit.

## STEP 12 — cleanup + final sweep
1. rm scripts/tmp-boss-probe.mjs (was never committed).
2. git status --short -> `?? "bug report.txt"` only (clean; EXECUTION-LOG.md is
   under the git-ignored reference/ tree).
3. Final verification:
   - triad: tsc silent, build OK, npm test 19 pass / 0 fail.
   - dev-shot f120 d1: enemies=1, no PAGE ERRORS.
   - dev-shot f800 d3: enemies=19 bullets=24, no PAGE ERRORS.
   - pixel-report f800: sky texture 1% (flat), ground-left/center/right 59/30/12%
     (all textured), hud-labels 37%/139 colors, player-zone bright 168/texture 65%,
     frame #400e20 — all within §5 tolerance.
   - dev-shot f2500 d1 shoot: score=68160, no PAGE ERRORS.
   - dev-shot f6000 d3 shoot: boss=true, spell 霜符「フロストコラムス -Lunatic-」,
     score=670550, no PAGE ERRORS.
   - Zero PAGE ERRORS across every shot/probe.
4. Final summary below.

## FINAL SUMMARY — GLM-PLAN.md execution complete

All 12 steps executed in order on branch `claude/player-stage-intro`. 9 commits
landed on top of the already-committed bug-5 fix (fe1fce0):

| step | commit | one-line status |
|---|---|---|
| 0  | (none)   | baseline green: tsc silent, build OK, 18 tests, dev-shot enemies=1 |
| 1  | (none)   | tmp-boss-probe.mjs built + verified (temp; deleted in step 12) |
| 2  | 9225999  | op148 HP-threshold callback + exe callback side-effects (bug 3) — n-gentle/n-lump/l-lump spell sequences correct |
| 3  | f9ce69d  | drop timeline spawns while a boss is registered (bug 1) — Normal delta 0/0; Lunatic delta 2/0 is a PROVEN 30f probe sampling artifact (1f probe: REAL spawns-while-registered = 0); code NOT reverted |
| 4  | 53aead8  | exe per-shape bullet hitbox table; split op92 (absolute) / op93 (relative) |
| 5  | b9cbddb  | per-frame SE-id dedup like the exe 5-slot queue (bug 2) |
| 6  | ee171d1  | player halves sht hitbox/grazebox; exe graze pad 20/+200, body graze, kill-from-spawn |
| 7  | dc56e75  | regression test locking stage-1 bullet sprite resolution (bug 4); 19 tests |
| 8  | 8f45654  | exe laser pierce (even-age full damage), MarisaA missile vel exemption, SakuyaA aim x1.5, per-spawn fire SE |
| 9  | 00692d3  | SakuyaB orbit-banked knives + orbit options; corrected option offsets; 30f shot cycle; AGENTS.md §6 |
| 10 | f49784a  | per-character bomb duration/invuln/speed table; localized 128px damage+cancel; item autocollect |
| 11 | (none)   | BGM measurement confirms bug-5 fix: th07_02 fetched+decoded at boot, sourceStart at/before frame 0 |
| 12 | (none)   | cleanup + final sweep green |

SKIPPED steps: none. REVERTED changes: none (STEP 3's Lunatic delta=2 was
investigated at 1f granularity and confirmed a probe artifact, not a code defect;
the correct code was kept). DEVIATIONS from the plan: STEP 2 also touched
src/game/stage-scene.ts (timerThreshold) — a forced compile-fix from the removed
scheduledTimerSubs field (documented in the step-2 entry and commit 9225999).

All FORBIDDEN items (cherry.ts; ECL ops 45/57/138-141; homing 0.18 / accel 12/14;
var 10025/10026; reference/ & dist/ edits) were left untouched.

---
# FOLLOW-ON SESSION — continuing Fable 5's RE-gated work (IMPL-PLAN §5/§6)

Prompt: Fable 5 (the plan author)'s quota was not reset; continue its
unfinished work and document for audit. The GLM-PLAN's "WHAT YOU MUST NOT
ATTEMPT" items were now eligible because the gating RE material is present
in-repo (`tools/all.c` full decompile, `tools/query1-3-clean.txt` distilled
cherry outputs, the Ghidra project). Branch unchanged: `claude/player-stage-intro`.

## What I DID (committed)

### Cherry/Border — 3 exe-faithful fixes (commit a1f3fd0)
Decoded the cherry accumulators and add-helpers in Th07.exe (mgr 0x61c250:
+0x961c=cherry, +0x9618=cherryMax, +0x9620=cherryPlus; helpers FUN_0042dc6f /
FUN_0042de03 / FUN_0042dd6c / FUN_0042de56 from `tools/all.c`). Three
discrepancies had unambiguous disassembly backing:
- **onGraze**: exe FUN_0043bb30 calls de56(cherryMax)+de03(cherry) with 30 foc /
  80 unfoc UNCONDITIONALLY and never touches cherryPlus. Was: +cherryMax only
  during border, +5 cherry via gain() otherwise. Fixed.
- **tick (survive)**: exe FUN_0043e620 awards +10000 to BOTH cherryMax (de56)
  and cherry (de03). Added the cherry+=10000 (bonus stays cherry×10).
- **onBomb**: exe-bombs.md §1c exhaustively confirmed NO cherry/CherryPlus
  write at bomb trigger. Removed the fabricated `cherry -= trunc(12000*scale)`
  (breakBorder kept). Updated the call site (onBomb() takes no arg now).
- VERIFY: check/build/test green (19/19; the existing cherry tests still pass
  unchanged — graze still yields cherryMax 50110, survive bonus still 500000).
  dev-shot f2500 d1+shoot score 68160→70370 (graze now raises cherry → higher
  point-item values), f800 d3 unchanged, no PAGE ERRORS.

### New spec: `reference/re-specs/exe-cherry-border.md` (IMPL-PLAN §5a deliverable)
Distilled the full cherry/border RE: accumulator field map, the four add-helpers
with semantics, the per-event gain/penalty table (shot-hit/graze/item/star/
survive/bomb/death/timeout) with exe addresses, the border lifecycle, and the
six OPEN gaps each tagged with its disasm address. Zero-risk (doc only).

## What I FOUND but deliberately did NOT change (with evidence)

### ECL var system (IMPL-PLAN §2.7 / GLM-PLAN FORBID var 10025/10026)
Recovered the var resolver `FUN_0040dda0` from all.c. Its special cases:
10000-10003, 10012-10015, 10016, 10017, 10025→bossTimer(+0x2bcc), 10027→hp,
10029-10032, 10037-10040, 10102-10103. It does NOT list 10018-10024/10026.
BUT this table is **incomplete/misleading**: stage-1 reads `var10024` as the
aim angle (`var10004 = var10024 − π; FIRE angle1=var10004`) and NEVER writes
it — so var10024 must be resolved to "angle to player" by some path NOT in
FUN_0040dda0. Our TH06-style mapping (10024=atan2-to-player, 10021/22/23=
enemy x/y/z, etc.) therefore MATCHES observed stage-1 behavior (aimed fans
aim correctly), and stage-1 never reads/writes 10025 or 10026 at all. **Verdict:
do not rework the var system** — our mapping is behaviorally correct for
stage-1, the partial exe table would lead to a wrong "fix", and the real
read-path resolver is still unfound. Leaving as-is.

### op 45 (case 0x2c) / op 57 (case 0x38) — need struct-offset mapping
Decompiled both. op45: `*(+0x76c)=arg0; +0x768=0; +0x764=-999` (writes an
enemy field + a tween sentinel). op57: `*(+0x2b6c)=arg0; *(+0x2b70)=arg1`
(two adjacent enemy floats; op46=+0x2b0c, op58=+0x2b5c are the sibling
set-field ops). None of these offsets map to a field our EclState exposes or
our movement code consumes, so faithfully implementing them needs the enemy
struct layout (which fields are position/velocity/target) — unfound. The op57
"snow helpers strand at (192,384)" symptom likely comes from a movement field
we don't set. Left as TODO stubs; documented.

### Enemy lasers (ops 138-141) — substantial system, incomplete RE
Current handling `game.configureAmbience?.(op, [...])` is a guess. IMPL-PLAN
notes fields +0x4f30/+0x4f32 and consumer FUN_0041ed50 (~all.c:14154), 12
stage-1 uses incl. Letty final-spell orb helpers. `enemyLasers` scaffolding
exists but is never populated. Building this faithfully is a full feature
(type/spawn/update/render/collision/cancel) needing the laser struct — left
for a dedicated task.

### Homing (shotType 1/2) turn rate / MarisaA missile accel — funcs[1] table
Still needs the funcs[1] pointer-table decode; current 0.18 turn / +0.4 accel
caps stay as flagged approximations.

### Remaining cherry gaps (in exe-cherry-border.md §5)
cherry-item amounts (exe 10/20/30/70 vs our 1000+100×spells — the test locks
the wrong value), shot-hit damage→cherry rate, the cherryItemScore headroom
term, `DAT_0062586c` field identity, `base` (+0x88) value, `DAT_004b5ec5` flag.
Each needs one more targeted Ghidra pass.

## Commits this session
- `a1f3fd0` — cherry: exe-faithful graze/survive, drop fabricated bomb penalty.
- (exe-cherry-border.md is under the git-ignored reference/ tree — not committed.)

## Bottom line for audit
Net code change: `src/game/cherry.ts` + `src/game/stage-scene.ts` (1 commit,
triad green, 19/19 tests). The rest of Fable 5's unfinished RE items are
blocked on enemy-struct / laser-struct / var-read-path mapping that the
interrupted RE session did not complete; I decoded what was tractable, fixed
the three unambiguous cherry bugs, distilled a full cherry spec, and
documented every remaining item with its evidence and the reason it was not
touched, so the next session can resume precisely.


## STEP — ECL mode-3 orbit movement (ops 56/57/58) — snow helpers un-strand
Spec: `reference/re-specs/exe-enemy-move-fields.md` (CONFIRMED, Ghidra disasm
`FUN_0040f6c0` case 0x37/0x38/0x39, `FUN_0041d050` integrator).

- `src/game/types.ts` `EclState`: added `orbitAngle/orbitAngularVelocity/
  orbitSpeed/orbitAcceleration/orbitTarget{x,y,z}/orbitDuration/orbitLeft`
  (exe +0x2b5c/60/6c/70/8c-94/a0/a4) + `activeTimer` (exe +0x76c, op45).
- `src/game/eclvm.ts`:
  - `case 56` replaced the old linear move-to-target lerp (which produced
    zero displacement whenever the exe's literal `speed` arg was 0, exactly
    Sub41's snowflake-helper case — the reported "(192,384)" strand) with the
    real 8-arg orbit activator: duration/target/angle/angvel/speed/accel,
    `moveMode=3`.
  - added `case 57` (orbitSpeed=f(0), orbitAcceleration=f(4)) and `case 58`
    (orbitAngle=f(0), orbitAngularVelocity=f(4)) — adjust an already-running
    orbit without resetting target/duration.
  - `applyMovement` gained the `moveMode===3` branch: `vel = (target +
    polar(angle,speed)) - pos`, added to `pos` (mirror-aware, matching mode
    1's existing pattern and the exe's `FUN_0041d050` integrator structure);
    algebraically reduces to `pos = target + polar(angle,speed)` at dt=1.
  - `case 45` (SetActiveTimer) implemented per spec §5.4 (was a stub): while
    `s.activeTimer > 0`, both the ECL timeline advance (`runEcl`) and
    movement modes 1/2/3 run; mode 0's `axisSpeed` integration is outside
    that gate. Defaults to `Infinity` so the vast majority of enemies that
    never call op45 are unaffected. Verified via the full-run sanity check
    below before keeping it (not reverted to a stub).

Verify:
- `npm run check` silent, `npm run build` OK (433.7kb), `npm test` 19/19 pass
  (unchanged from before this step — no locked value needed rewriting).
- Unit-level probe (bundled `eclvm.ts`+`th07-data.ts`+`anm.ts` to ESM, drove
  `StageRuntime.spawnEclEnemy`/`updateEnemy` directly against a synthetic ECL
  sub replicating Sub41's real op56 args — `duration=0, target=(100,50,0),
  angle=0, angvel=0.1, speed=0(literal), accel=0.02`, then op57 at t=5 setting
  `speed=3, accel=0`, matching the real dump's t=120-frame dash-kick shape):
  - pre-fix (stashed baseline): enemy snaps to `(100,50)` on frame 0 and
    never moves again for 60 frames (`framesStranded` at target = 60,
    `moveMode` reverts to 0, console warns `unhandled ECL op 57`) — reproduces
    the exact reported bug.
  - post-fix: no NaN across 60 frames, `moveMode` stays 3 the whole time,
    every frame's position differs from the last (`allMovingAfterKick:true`,
    per-frame delta before op57 grows via `orbitAcceleration` ≈0.02/frame;
    after op57's speed=3 kick, delta locks to `2·3·sin(0.05)=0.29988`, the
    exact chord length for radius=3/step=0.1rad — confirms the polar-offset
    formula). `finalDistFromTarget=3.0` exactly == `orbitSpeed`. A second
    probe isolating op58 (angle/angvel-only adjust) confirmed `orbitAngle`
    delta jumps from 0 to the new 0.3 rad/frame the instruction after op58
    fires, target/duration untouched.
  - in-game stage-1 strand probe (`enemyDump` sampled every 5 frames,
    frame 0-8000, `difficulty=1` and `difficulty=3`): `STRAND_REPORT: []`
    (no enemy sits at a fixed point ≥120 frames) on both difficulties, no
    NaN, no PAGE ERRORS.
  - full-run sanity (scripted to stageClear, `difficulty=1`, 27000-frame
    budget): baseline (pre-change) `cleared:true frame:22376
    spawnLogLength:221`; post-fix (orbit+op45) `cleared:true frame:22370
    spawnLogLength:221` — spawnLog count identical, both clear, no PAGE
    ERRORS. (The 6-frame difference is expected: orbit-mode-3 enemies now
    move/despawn differently, shifting downstream RNG-consumption timing by
    a few frames; it does not affect the timeline spawn count.)
  - Note: the real Sub40/41 snowflake spellcard itself did not naturally
    trigger within the reachable probe window without dealing boss damage
    (its interrupt appears HP-threshold-gated, not time-gated, per stage1
    interrupt-handler subs 38/39) — the unit-level probe above exercises the
    identical op56/57 argument shape and dispatch/movement code path
    directly, which is the mechanism under test.
- Commit: see below.

## STEP — player homing steer + MarisaA missile accel (funcs[1])
Spec: `reference/re-specs/exe-player-funcs1.md` (CONFIRMED, Ghidra disasm
`FUN_0043edc0`/`FUN_0041ed50` target cache, `FUN_004391f0`/`FUN_00439420`
ReimuA homing, `FUN_00439650` MarisaA missile).

- `src/game/stage-scene.ts` `updatePlayerBullets()`: replaced the per-bullet
  `findAimTarget` nearest-2D-distance call inside `steerHomingBullet` with a
  single per-frame target computed once at the top of the function — the
  eligible enemy (`interactable && !invisible && !dead && canTakeDamage`,
  port's existing eligibility test) minimizing `|e.x - player.x|`, shared by
  every homing bullet that frame (spec §2, `FUN_0043edc0`/`FUN_0041ed50`).
- `steerHomingBullet(b, target)`: replaced the `b.angle` + `turn=0.18`
  hard-clamp guess with the exe's exact vector algorithm (spec §3): if not
  homing (`target===null || b.age>39`), accelerate `b.speed` toward
  `maxSpeed` (10/type1, 18/type2) by `accel` (1/3 / 0.6) per frame,
  renormalizing existing `vx,vy`; if homing, `pull = dx/denom + v` (denom =
  `max(1, dist/(speed/4))`), `newSpeed = clamp(|pull|, 1, maxSpeed)`,
  `v = pull * newSpeed/|pull|` — never touches `b.angle`. Added a
  `mag===0` early-return (degenerate on-target-with-zero-velocity case; not
  exe-modeled, prevents a 0/0 NaN the disassembly doesn't guard against
  either since it can't occur from real spawn velocities).
- MarisaA missile (`shotType===3`): replaced the `age>8` capped
  accel-toward-angle guess with the exe's uncapped per-frame vertical boost,
  `b.vy -= this.rng.range(0.1) + 0.27` every frame from spawn, `b.vx`
  untouched (spec §4, `FUN_00439650`). Used the scene's seeded `this.rng`
  (not `Math.random()`, which the spec allows as an "adequate substitute"
  but the task's determinism bar overrides) so replay/snapshots stay
  reproducible.
- `findAimTarget`/`aimBulletAtSpawn` (SakuyaA spawn-aim) untouched — confirmed
  different target-cache slot per spec §6.4. shotType 4/5 (MarisaB trail
  lasers) untouched — spec §5, PROBABLE/out-of-scope.

Verify:
- `npm run check` silent, `npm run build` OK (434.8kb), `npm test` 19/19 pass
  (no locked value needed rewriting — no existing test asserted the old
  angle-clamp/capped-accel numbers).
- Same-seed pre/post probes (`difficulty=3`, `power=8`, `shoot` held,
  `scripts/dev-shot.mjs`-style 30-frame-batch driver reading
  `playerBulletDump`/`score` every batch to frame ~620):
  - reimuA unfocused (shotType 1): score identical pre- and post-change,
    **520** at frame 617 both runs (kills unaffected). Post-change dump
    shows `vx,vy` on live homing bullets varying frame-to-frame in both
    sign and magnitude by frame 617 (e.g. `(8.61,-5.08)`, `(-0.53,-1.13)`,
    `(3.44,-9.39)`, `(1.67,-9.86)` — all four in-flight at once), confirming
    per-bullet curving vs. the old fixed-clamp turn; no NaN in any sampled
    frame (0-617, every 30f).
  - reimuA focused (shotType 2, extra check beyond the required probe):
    `vy` cycles between the non-homing accel ceiling (-18.2 = maxSpeed) and
    dips into the -5..-9 range as fresh homing pulls arrive, matching the
    accel/steer branch split; no NaN.
  - marisaA missile (shotType 3): baseline (unchanged code) capped at
    exactly `vy=-14` from frame ~465 onward (old `Math.min(14,...)` cap
    visible). Post-change: `vy` keeps decreasing past frame 465 with no
    plateau, reaching **-14.8** at frame 617 (vs. baseline's flat -14),
    `vx` stays exactly `0` throughout for every sampled bullet. Isolated
    spawn/+10/+30-frame trace on one bullet: `vy` -0.64 → -4.24 (+10f) →
    -10.95 (+30f), monotonically more negative, `vx=0` at every sample —
    matches "random ~0.32avg/frame, no cap, vx untouched" exactly. Score
    0→0 in both marisaA runs (main straight shot doesn't reach the single
    early enemy in this window; unaffected by this change either way).
  - No PAGE ERRORS in any of the four runs.
- Commit: see below.
