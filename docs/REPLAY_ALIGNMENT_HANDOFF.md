# Stage 1-6 replay alignment handoff

Updated: 2026-07-13. This is the restart procedure for a fresh session
continuing original-grade Stage 1-6 replay/RNG alignment. Read `AGENTS.md`
completely before using it. The checkpoint is for the committed
`tests/replays/th7_udFe25.rpy` fixture: SakuyaA, Lunatic.

## Goal and authority

The goal is original behavior, not a passing digest. Compare against, in
order: the current user request; approved modernizations in `AGENTS.md`;
original data and `reference/Th07.exe` v1.00b; then the current port. Existing
web behavior and tests are not behavioral authority.

`tests/th07-replay-golden.test.mjs` is a sparse regression alarm. Never run
`UPDATE_REPLAY_GOLDEN=1 npm test` merely to make an alignment change green.
Regenerate it only after direct native evidence proves the new behavior and
the complete replay verification criteria pass. Otherwise regeneration hides
the first wrong frame by recording it as a new baseline.

The exact acceptance target for every Stage 1-6 replay is:

- every replay input word matches the original frame;
- every PRE-frame RNG seed and raw draw counter matches;
- fixed-slot state and event order match at every investigated boundary;
- kill, collect, and player-hit event streams match exactly;
- no unexpected death, input exhaustion, or incomplete stage;
- next-stage snapshot/end fields and RNG residue match.

Do not enable replay ghosting for acceptance runs. Ghost mode is diagnostic
only and changes survival/timing consequences.

## Current checkpoint

`PRE N` means the state immediately before processing replay input frame N.
A first mismatch at PRE N belongs to processing frame N-1.

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
npm run replay:verify
node scripts/dev-shot.mjs /tmp/th07-preview-boot.png 300
```

For browser Replay, also drive the actual browser file-selection/playback path
and record machine-readable scene, replay metadata, selected stage, frame, and
error state. Run `node scripts/pixel-report.mjs` on representative stage frames
used for visual acceptance. Static `index.html` must remain functional without
a development server or runtime ESM imports.

For the user-requested 2026-07-13 preview checkpoint, `npm test` is expected to
fail only at the stale replay-golden digest: 205/206 tests pass, and the frame-0
digest changed because the native-proven seed/bootstrap and manager behavior
changed. Report that exact exception and do not regenerate the digest yet.
This is a one-checkpoint user-authorized exception to the normal `AGENTS.md`
commit invariant, not a standing policy for future commits. Never describe the
preview as fully converged.

Before committing:

- review `git diff --check` and the complete staged diff;
- stage only intended engine/tests/docs/browser Replay files;
- do not stage `reference/`, `tmp/`, `/tmp` traces, screenshots, `dist/`,
  `output/`, `issues/`, or the unrelated `FIX-REPORT.md` deletion;
- keep logical commits and never force-push;
- fetch before push and confirm `origin/main` has not diverged.

The final convergence commit comes only after all six complete native traces,
exact event/end-state verification, zero unexpected deaths, clean build/tests,
headless boot, and rendering probes. Only then regenerate and review the replay
golden, commit it with the proven alignment change, and push `main`.
