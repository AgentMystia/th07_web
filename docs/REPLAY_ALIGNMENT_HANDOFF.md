# Replay alignment handoff (all difficulties)

Updated: 2026-07-26. This is the restart procedure for a fresh session
continuing original-grade replay/RNG alignment. Read `AGENTS.md` completely
before using it. Stage 1-6 Lunatic (`tests/replays/th7_udFe25.rpy`, SakuyaA)
and Extra (`replay/th7_udHm54.rpy`, MarisaB) are converged; the open work is
Hard, Normal, Easy and the last 10% of Phantasm.

## Where things stand (2026-07-26)

`node scripts/replay-verify.mjs --all` prints this matrix. Cells are the
earliest frame at which any of the seven AUX event streams disagrees.

| replay | char | difficulty | st1 | st2 | st3 | st4 | st5 | st6 | st7 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| th7_udFe25 | sakuyaA | Lunatic | PASS | PASS | PASS | PASS | PASS | PASS | — |
| th7_udHm54 | marisaB | Extra | — | — | — | — | — | — | PASS |
| th7_udSg10 | reimuA | Phantasm | — | — | — | — | — | — | 51989 |
| th7_udMt01 | sakuyaB | Easy | PASS | PASS | PASS | 4536 | 7290 | 1628 | — |
| th7_udYo01 | sakuyaA | Normal | PASS | 9104 | 11863 | 18596 | 2320 | 2727 | — |
| th7_udFi03 | reimuB | Hard | 5440 | 7624 | 3087 | 2360 | 2090 | 1727 | — |

Two engine fixes landed on 2026-07-26; both are original-behavior corrections,
not golden-only adjustments, and neither moved a converged cell.

1. **A player-shot slot frees when its ANM script ENDS, not only on op1
   `remove`.** ReimuB's orb impacts (player00 98-101) and MarisaA's missile
   impacts (player01 97-104) close on op2 `static` at 20-45f, right where their
   fade reaches alpha 0. Honoring only `remove` left those invisible slots
   holding the fixed 96-slot pool — measured full at 96/96 across the dry
   windows of a scripted x=40 descent in Hard st3 — and `firePlayerBullets`
   drops new spawns when the pool is full, so ReimuB's kills landed late.
   Effect: Hard st2 2165→7624, st3 537→3087, st5 617→2090, st6 1330→1727.
2. **The post-miss control lock is 55 ticks, not 60** (30 squish + a
   materialize handing off at 25 while its ramp keeps the cited 30.0 divisor).
   Replay-validated against th7_udYo01's two respawns; see AGENTS.md §7.
   Effect: Normal st2 8747→9104, st5 2280→2320.

Three hypotheses were measured and refuted; AGENTS.md's baseline section lists
them with their disproving measurements (ReimuB bomb double-slot damage,
pre-move grab corners for the item collect test, and the mid-pass `this.items`
splice as the cause of the Easy/Normal collect bursts). Do not re-derive them
without new evidence.

## The cheapest triage available (do this first)

Two facts make the remaining cells much easier to sort than the old
frame-by-frame grind, and neither needs a simulation run:

- Every stage that PASSes records **zero** oracle misses, so the whole
  death/respawn path is unvalidated by the converged replays. Changes there
  cannot regress them.
- `mod.auxEventFrames(stage, mod.RPY_AUX_BITS.playerMiss, 1)` on a parsed `Rpy`
  lists the original's death frames directly from the recording. Compare each to
  the cell's divergence frame:

| cell | divergence | oracle miss before it | family |
|---|---:|---|---|
| Normal st2 | 9104 | 8578 | post-respawn, lock resolved; now 3f late (oracle 9104, ours 9107) |
| Normal st5 | 2320 | 2205 | post-respawn, lock resolved; now 4f EARLY on a kill (oracle 2324, ours 2320) |
| Normal st6 | 2727 | 2507 | post-respawn, unresolved (3f late collect) |
| Easy st5 | 7290 | 7119 | post-respawn, unresolved (39f late — second cause) |
| Easy st4 | 4536 | none | no-death family (1f late collect) |
| Easy st6 | 1628 | none | no-death family (contact mismatch) |
| Hard st1/st2 | 5440 / 7624 | none | no-death family |
| Normal st3/st4 | 11863 / 18596 | none | no-death family |
| Hard st3/st4/st5/st6 | 3087 / 2360 / 2090 / 1727 | none before the frame | no-death family |
| Phantasm st7 | 51989 | none | boss-spell damage excess |

Do not attribute a no-death cell to respawn timing, and do not attribute a
post-respawn cell to the item pipeline before checking the player's position
track against the recorded input words — the Normal st5 case looked exactly
like an item bug and was not one.

The five non-fixture replays are third-party recordings kept as local
evidence in the git-ignored `replay/` directory. Never commit them.

**`wine`/`winedbg` is not installed in the current environment**, so the
native PRE-trace acquisition below cannot be run here. Until it can, the
replay's own AUX event streams are the oracle: dense, frame-exact, and free.
Their limit is coverage, not accuracy — an RNG or position divergence that
produces no AUX event stays invisible until it changes one, so read a clean
prefix as "no observed event differs", not as "state is identical".

## Open leads

- **Hard / ReimuB (st3 @ 3087, st4 @ 2360, st5 @ 2090, st6 @ 1727, st2 @ 7624,
  st1 @ 5440).** The pool-starvation half of this lead is FIXED (see above): the
  st3 worked example that used to sit at 537 — enemy pool slot 1, a scripted
  straight descent at x=40.0 exactly, killed at 546 against the recording's 537
  — now converges, and every Hard stage moved out except st1 and st4, which did
  not budge at all and are therefore independent defects. What remains at st3 is
  a *different* mismatch: the oracle kills on two consecutive frames 3086 AND
  3087 while we kill at 3086 then not until 3096, after which our next five kills
  run 1-2 frames EARLY (oracle 3099/3100/3109/3113/3117 vs ours
  3098/3100/3108/3112/3115). A ReimuB bomb is live from 3086 through 3100+, but
  its damage model is not the cause (refuted, see AGENTS.md). At 3087 no live
  enemy sits inside either bomb strip in our sim, so work out what the original
  killed there: an enemy we killed a frame early, one we left with leftover hp,
  one we never spawned, or a slot-vacate (the AUX kill bit is also written when a
  slot is released, and several enemies hover at y slightly negative right at
  the top-edge cull boundary in that window, where the live ANM sprite rect —
  not the spawn template — decides the exact cull frame).
  Note that the Hard st1 case (midboss spell captured 20f late) sits behind
  an RNG-positioned boss: ECL stage-1 Sub29 picks its move angle with
  `ins_52([10004], -π, π)`, so that boss's parked X is not a fixed target
  and cannot by itself prove or disprove a shot-side bug.
- **Easy/Normal collect bursts.** The framing that these are all item-pipeline
  bugs is now known to be wrong for at least the post-respawn half: Normal st5
  looked exactly like a ±1-frame auto-collect bug and was really the respawn
  control lock, and the fix needed nothing in `updateItems` (its predicted
  player track reproduced all three oracle collects AND the three non-events
  immediately before them). Sort each remaining cell by the miss table above
  before assuming anything.
  Still open in this family: **Normal st6 @2727** (collect 3 frames late, 220
  frames after the miss at 2507 — the 55-tick lock did not move it, so measure
  the player's position track against the recorded inputs the way Normal st5 was
  measured), **Easy st5 @7290** (measured insensitive to the lock length — its
  first collect mismatch stays at index 191 and ~38 frames late for locks of 60,
  57 and 36, so it is an independent defect and not respawn timing at all), and
  **Easy st6 @1628**, which is a *contact*
  mismatch — a bullet reaching the player at the wrong frame, not an item
  problem.
- **Easy st4 @4536 is proven NOT to be an item-pipeline bug.** At frame 4513 a
  SakuyaB bomb's full-screen clear (region `{x:226.774, y:195.009, radius:800}`)
  converts 181 live enemy bullets into `cherry` items, all born `state:1`; from
  there each item is an independent pure-pursuit curve (recompute
  `vx,vy = cos/sin(atan2(dy,dx))*8`, step 8 px/frame) whose collect frame is a
  pure function of its spawn position and the player path. All 181 are collected
  in 4521..4546. The player path was verified input-synchronous — input 0x0025
  first appears at 4531 and y steps +2.2 that same frame, 0x0085 at 4545 and x
  steps that same frame — so there is no off-by-one on the player side.
  An offline pursuit simulator fed the captured spawn positions and player path
  reproduces all 181 engine collect frames with zero mismatches, which makes the
  arithmetic decisive: against a box half-extent of 22 (12 grab + itemRadius/2),
  reproducing the oracle's pattern requires item #6999 to be ~2.3 px FARTHER,
  #7000 ~0.13 px farther, and some 4537-group item ~0.9-1.7 px CLOSER. The
  directions are mixed, so **no uniform change to autocollect speed, box size,
  item radius, or player offset can produce it** — the individual spawn
  positions must differ, i.e. our enemy bullets were not exactly where the
  original's were when the bomb cancelled them.
  That makes this cell an upstream enemy-bullet position divergence that emitted
  no AUX event until it moved one collect — precisely the "exact prefix is not
  identical state" case AGENTS.md warns about. It needs a position-level oracle
  (a native trace of the bullet pool at 4513), not more event-stream bisection.
  Two further candidates were measured and refuted while establishing this: the
  mid-pass `this.items` splice (zero mid-pass spawns and zero double visits in
  4515-4550) and the f32 narrowing of the homing angle (dropping it leaves the
  fixture passing and this cell unchanged, so the exe-cited narrowing stays).
- **Phantasm (st7 @ 51989).** Exact for 51989 of 57876 frames — 565 kills,
  2739 collects, 23 contacts, 7 bombs and every border event. Boss sub 127's
  HP reaches 0 two frames early, i.e. ~2 HP of accumulated excess over a long
  spellcard, not a rate error. Use `--trace-damage` across the spell and look
  at ReimuA's homing target cache first. The RNG-residue oracle does not
  exist for single-stage replays (it needs a following stage's seed), so the
  damage trace is the only quantitative handle. The two extra player contacts
  (56038, 56993) and the death at 57037 are downstream of this; re-measure
  rather than treating them as separate defects.
- **Non-Lunatic ECL branches.** Every difficulty-gated branch in
  `src/game/eclvm.ts` has only ever executed under Lunatic in a converged
  replay: effect 8's `difficulty < 2` scale/base/state, the `difficulty >= 3`
  and `difficulty === 3` gates, `difficulty < 3 ? 4 : 2` with its π/6-vs-π/2
  pair, and effect 12/21's band plus `[10,18,22,25][difficulty]` child count.
  Each child costs RNG draws, so a wrong count shifts every later draw in the
  stage. Re-derive each from `all.c` / `spec-effects-misc.md` rather than
  assuming the Lunatic-validated code is right.

## Legacy Stage 1-6 Lunatic checkpoint

Everything below predates the all-difficulty baseline and describes the
now-complete Lunatic campaign. The native-acquisition and first-divergence
procedures still apply verbatim wherever `wine` is available.

## Goal and authority

The goal is original behavior, not a passing digest. Compare against, in
order: the current user request; approved modernizations in `AGENTS.md`;
original data and `reference/Th07.exe` v1.00b; then the current port. Existing
web behavior and tests are not behavioral authority.

`tests/th07-replay-golden.test.mjs` is a sparse regression alarm, not behavioral
authority. For every intentional, evidence-backed simulation change, regenerate
it with `UPDATE_REPLAY_GOLDEN=1 npm test`, review the digest diff, and commit it
with the change so normal `npm test` and CI remain green. A passing digest only
means the current implementation is stable; native traces and executable data
still decide whether that implementation is correct.

The exact acceptance target for every Stage 1-6 replay is:

- every replay input word matches the original frame;
- every PRE-frame RNG seed and raw draw counter matches;
- fixed-slot state and event order match at every investigated boundary;
- kill, collect, and player-hit event streams match exactly;
- no unexpected death, input exhaustion, or incomplete stage;
- next-stage snapshot/end fields and RNG residue match.

Do not enable replay ghosting for acceptance runs. Ghost mode is diagnostic
only and changes survival/timing consequences.

## Historical Lunatic checkpoint (superseded — all six stages now PASS)

`PRE N` means the state immediately before processing replay input frame N.
A first mismatch at PRE N belongs to processing frame N-1. The table below is
the 2026-07-13 state of the Lunatic campaign, kept only as a worked example of
how each split was classified; every row has since converged.

| stage | native coverage | exact PRE boundary | first work on restart |
|---|---:|---:|---|
| 1 | 0..10475 | every captured PRE row | full-replay RNG residue and stage completion are exact, but kill events (web 690, original 684) and score (web 2159704, original 2446935) are not; resolve event/score semantics |
| 2 | 0..12000 | 0..10929 | classify processing 10929; web spends four extra draws, currently an extra id5 impact effect after the snow draw |
| 3 | 0..12000 | 0..7449 | classify processing 7449; native spends four more draws, consistent with one missing id5 impact event |
| 4 | 0..19000 | 0..15288 | classify processing 15288; web spends 24 vs native 12 draws and currently emits two id5 plus three id8 effects |
| 5 | 0..12000 | 0..8197 | classify processing 8197; native spends four more draws, consistent with one missing id5 impact event |
| 6 | 0..7574 | every captured PRE row | acquire the remainder through frame 26435 before declaring divergence or convergence |

Stages 2, 3, and 5 still point at the common player-shot collision/id5 family,
but that is a classification hypothesis, not permission to tune draw counts.
Obtain native slot/call-order evidence for the exact processing frame first.
Stage 4's three extra id8 effects may be presentation/collision state fallout;
trace native callers before changing effect lifetime or cost.

The current fixes are mostly shared engine semantics: fixed pools and slot
order, per-enemy immediate collision/death, player-shot spawn/move timing,
ECL typed variables and CALL/RETURN/periodic state, bullet EX promotion,
native float writes/integration, slow-rate split clocks, rank and replay RNG
bootstrap, cherry/dialogue scheduling, and event-aware replay verification.
They should benefit every difficulty. They do not prove other difficulties:
rank masks and difficulty formulas take different code paths and create
different pool pressure. After Lunatic finishes, acquire direct Easy, Normal,
and Hard evidence rather than copying the Lunatic golden.

## Re-establish a clean measurement baseline

1. Run `git status --short`. Preserve unrelated user changes, especially the
   existing `FIX-REPORT.md` deletion and local `issues/`, `output/`, `tmp/`,
   `reference/`, screenshots, and native traces.
2. Run `npm run check`. If a previous agent stopped mid-edit, fix compilation
   and search for debug early returns or disabled subsystems before measuring.
3. Inspect the fixture without changing it:

   ```sh
   npm run replay:inspect -- tests/replays/th7_udFe25.rpy
   ```

4. Re-run the current PRE comparisons below. If a boundary moved, first check
   whether another agent changed shared files, the wrong native stage was
   selected, or a trace file was overwritten.

The comparison helpers are scratch files under `tmp/` and are deliberately
not committed. In this workspace the important ones are
`tmp/compare-native-wt.mjs`, `tmp/compare-native-matrix.mjs`,
`tmp/rng-frame-events.mjs`, and the stage-specific native `.gdb` probes. If a
fresh clone lacks them, reconstruct an equivalent read-only tool: parse
`PRE stage frame input seed draws`, initialize `StageScene` from the replay
snapshot without restoring RNG, compare before `scene.update(input)`, and
normalize native draws by the frame-0 counter.

## Native Wine/winedbg acquisition

The evidence source is the original executable running the real replay. Use
the local read-only original data under `reference/` only to prepare a separate
runtime directory such as `/tmp/th07-native`; never alter or serve
`reference/`. Existing runtime prefixes and traces under `/tmp` are evidence,
not Git inputs.

Use Xvfb, Wine, and `wine64 winedbg --gdb ./Th07.exe` in the same environment.
The reliable pattern is one foreground Wine/winedbg process; background Wine
pipelines have previously died silently. Use an isolated display and
`WINEPREFIX` for each simultaneous acquisition so agents cannot steer or kill
one another's game.

Each trace script should:

1. inject only the title/replay/stage-selection key edges needed for its stage;
2. break at `0x43ff67` and compute `frame = **(u32**)0x4afe28 - 1`;
3. print `PRE stage frame input seed draws` using stage `0x62583c`, input
   `0x4afe30`, RNG seed `0x495e00`, and raw counter `0x495e04`;
4. reject output whose printed stage is not the requested stage;
5. stop after the requested high frame; and
6. if needed for this local executable setup, use the proven integrity-return
   bypass at `0x43585b` without changing gameplay state.

Start from a proven stage-specific script such as `tmp/native-s4-pre19000.gdb`.
Do not improvise the menu schedule: different stage choices need different
edge sequences, and a valid trace of the wrong stage is worse than no trace.
Take a screenshot or inspect the printed stage number before accepting it.

Use unique, descriptive names and refuse to overwrite them. Include stage,
range, purpose, date, and a suffix, for example:

```sh
OUT=/tmp/th07-native-stage2/native-stage4-pre19000-24446-root-20260713a.log
test ! -e "$OUT" || { echo "refusing to overwrite $OUT" >&2; exit 1; }
```

Never reuse names like `native.log`, `trace.log`, or an earlier range name.
When extending a trace, write a new overlapping segment and let the comparator
merge rows by frame. The overlap proves navigation, frame numbering, seed, and
counter continuity. Do not concatenate blindly or discard original files.

A representative foreground launch is:

```sh
cd /tmp/th07-native-stage2
DISPLAY=:121 WINEPREFIX=/tmp/wine-th07-s4-long \
  wine64 winedbg --gdb ./Th07.exe \
  < /th07_web/tmp/native-s4-pre19000.gdb > "$OUT" 2>&1
```

The precise display, prefix, runtime directory, and script must be unique to
the acquisition. Keep long traces and screenshots under `/tmp`, never the repo.

## Compare commands for the current evidence

These commands compare native PRE rows against web PRE state and report the
first mismatch plus any later recovery. They are expected to reproduce the
checkpoint table with the current worktree:

```sh
node tmp/compare-native-wt.mjs \
  /tmp/th07-native-s1-long/native-stage1-pre-10000-merged.log,/tmp/th07-native-s1-long/native-stage1-pre-10500.log \
  10477 1

node tmp/compare-native-wt.mjs \
  /tmp/th07-native-stage2/native-stage2-pre-6000-integrity.log,/tmp/th07-native-stage2/native-stage2-pre-12000.log \
  12000 2

node tmp/compare-native-wt.mjs \
  /tmp/th07-native-stage2/native-stage3-pre-6000-integrity.log,/tmp/th07-native-stage2/native-stage3-pre-12000.log \
  12000 3

node tmp/compare-native-wt.mjs \
  /tmp/th07-native-stage2/native-stage4-pre-6000-integrity.log,/tmp/th07-native-stage2/native-stage4-pre5900-12000-root-20260713b.log,/tmp/th07-native-stage2/native-stage4-pre11900-19000-root-20260713c.log \
  19000 4

node tmp/compare-native-wt.mjs \
  /tmp/th07-native-stage2/native-stage5-pre-6000-integrity.log,/tmp/th07-native-stage2/native-stage5-pre-12000.log \
  12000 5

node tmp/compare-native-wt.mjs \
  /tmp/th07-native-s6-long/native-stage6-pre-6000.log,/tmp/s6-native-pre-5900-12000.log \
  7574 6
```

For the short six-stage regression matrix:

```sh
node tmp/compare-native-matrix.mjs \
  /tmp/th07-native-s1-long/native-stage1-pre-10000-merged.log \
  /tmp/th07-native-stage2/native-stage2-pre-6000-integrity.log \
  /tmp/th07-native-stage2/native-stage3-pre-6000-integrity.log \
  /tmp/th07-native-stage2/native-stage4-pre-6000-integrity.log \
  /tmp/th07-native-stage2/native-stage5-pre-6000-integrity.log \
  /tmp/th07-native-s6-long/native-stage6-pre-6000.log
```

## First-divergence method

Work on only the earliest native mismatch in each stage, preferring a common
root shared by several stages.

1. If PRE N differs, inspect processing frame N-1. Confirm input still matches;
   an input mismatch invalidates all later RNG analysis.
2. Compare the per-frame draw delta. On the web side, use for example:

   ```sh
   node tmp/rng-frame-events.mjs 2 10929
   ```

   This labels RNG calls and effect/kill/collect events. Add a focused native
   breakpoint at `0x42ff30` (raw RNG) or the suspected caller, recording return
   addresses/stack and the fixed slot involved.
3. If draw count and seed match but gameplay state differs, dump exact fixed
   slots rather than dense-array indices: enemy 0..479, player shot 0..95,
   attack 0..111, enemy bullet 0..1023, and effect pool entries. Compare
   position/velocity as stored f32, state/age, owner/sub/spawn frame, hitbox,
   movement/EX queue state, death/fire flags, and allocation cursor.
4. Preserve executable order. The known frame shape is player-shot move, fire,
   and homing; then the enemy manager processes enemies by slot, performing
   fire, player-shot/attack collision with immediate damage, and death. A
   same-frame allocation into an already-passed low slot waits until the next
   frame.
5. Fix the deterministic engine cause, not the aggregate RNG total. Never add
   dummy draws, alter an effect cost to move a death, or tune a float until the
   trace happens to match. A temporarily recovered seed can conceal wrong
   ordering.
6. Immediately rerun the affected long comparison and the six-stage short
   matrix. Revert or correct any change that moves an earlier proven boundary
   backward unless new native evidence proves the old boundary wrong.

When native and web draw counts match but state diverges, compare state before
adding more RNG tracing. When counts differ, identify every individual native
and web draw in that processing frame; totals can match by cancellation.

## Browser Replay preview status

Browser playback is implemented in `src/main.ts`, `src/game/title-scene.ts`,
`src/game/replay-playback.ts`, and `src/formats/rpy.ts`. The title Replay entry
opens a local `.rpy` file picker; bytes stay in the browser and are never
uploaded. The menu uses the authored replay ANM layer plus a plain-text fallback
for the local filename/metadata, lists only present physical stage slots, and
shows the original three playback modes. The host then:

- constructs `StageScene` with the recorded stage RNG seed so manager bootstrap
  consumes from the native state;
- restores score (only from a physically adjacent prior Stage 1-6 slot),
  point items, graze, lives, bombs, power, cherry state, spells, extend, and
  rank from the stage snapshot;
- routes the shared seventh slot to runtime Stage 7 (Extra) or Stage 8
  (Phantasm);
- feeds only `ReplayInputSource` to gameplay, while physical ESC exclusively
  owns the replay pause menu and never advances the recorded cursor;
- continues only to an immediately adjacent non-empty slot, otherwise returns
  to the loaded replay selector;
- reproduces the slowdown trailer's pointer+1 samples and native cadence
  buckets, and repeats skippable-dialogue/boss-only ticks to the executable's
  modulo boundaries; and
- rejects files or decompressed bodies larger than 16 MiB with an in-menu
  error rather than risking a browser allocation failure.

Run the real browser path with:

```sh
npm run replay:browser -- tests/replays/th7_udFe25.rpy 1 300 /tmp/replay-s1.png 0
npm run replay:browser -- tests/replays/th7_udFe25.rpy 5 4822 /tmp/replay-s5-dialogue.png 0
```

The preview checkpoint observed normal, slowdown-reproduction, and boss-only
playback without page errors. A live-pause probe held the recorded cursor
unchanged for 20 pause ticks and confirmed that only Resume/Return are
selectable. Stage 5 frame 4820 visibly creates Youmu's mid-stage dialogue.
Keep browser playback on the same production `Rpy`, snapshot helper,
direction-chord priority, seed/bootstrap order, and input timing as the Node
verifier; do not fork UI-only replay semantics.

## Verification and preview commit rules

At a convergence checkpoint run, in order:

```sh
npm run check
npm run build
npm test
npm run replay:verify                       # committed fixture, must stay 6/6
node scripts/replay-verify.mjs --all        # regression matrix, all difficulties
node scripts/dev-shot.mjs /tmp/th07-preview-boot.png 300
```

The matrix arm is not optional for a fidelity change. A fix that converges one
replay while moving another's exact prefix backward is a regression, not a fix,
and only the side-by-side table makes that visible.

For browser Replay, also drive the actual browser file-selection/playback path
and record machine-readable scene, replay metadata, selected stage, frame, and
error state. Run `node scripts/pixel-report.mjs` on representative stage frames
used for visual acceptance. Static `index.html` must remain functional without
a development server or runtime ESM imports.

The 2026-07-13 preview initially shipped with a stale replay golden and caused
the Pages CI build to fail at frame 0. That exception is closed: the digest was
regenerated and reviewed in the follow-up CI fix. Every future commit must keep
the full test suite green, including the golden lock. Do not describe a passing
golden as native convergence; the PRE boundaries above remain the authority for
unfinished alignment.

Before committing:

- review `git diff --check` and the complete staged diff;
- stage only intended engine/tests/docs/browser Replay files;
- do not stage `reference/`, `tmp/`, `/tmp` traces, screenshots, `dist/`,
  `output/`, `issues/`, or the unrelated `FIX-REPORT.md` deletion;
- keep logical commits and never force-push;
- fetch before push and confirm `origin/main` has not diverged.

The final convergence commit comes only after all six complete native traces,
exact event/end-state verification, zero unexpected deaths, clean build/tests,
headless boot, and rendering probes. Regenerate and review the replay golden
with the final behavior change as usual, then push `main`.
