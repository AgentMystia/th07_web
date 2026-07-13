# TH07 Stage 1-6 Fidelity Handoff

## Checkpoint

- Branch: `main`
- Engine convergence commit: `5b34713`
- Behavior scope proven here: SakuyaA, Lunatic, Stage 1-6.
- Extra/Phantasm and Easy/Normal/Hard are not implied by this checkpoint.

The committed fixture `tests/replays/th7_udFe25.rpy` passes all six stages
without ghosting. Exact event totals are:

| Stage | kills | collects | player hits |
|---|---:|---:|---:|
| 1 | 684 | 382 | 0 |
| 2 | 396 | 494 | 0 |
| 3 | 410 | 635 | 0 |
| 4 | 1050 | 1056 | 0 |
| 5 | 412 | 545 | 1 (also present in the original AUX stream) |
| 6 | 279 | 1095 | 0 |

Stage 1-5 RNG residues and all available end fields are exact. Stage 6's RPY
metadata stores score 116283035, while the native live field and the web
engine both finish at 116283036; `replay:verify` reports the native-proven
one-point discrepancy as an advisory.

The independent local replay `th7_ud8141.rpy` also passes Stage 1-6, has zero
player hits in all stages, and has exact kill/collect/RNG streams. It is local
evidence only and must never be committed.

## Reproduce the checkpoint

```sh
npm run check
npm run build
npm test
npm run replay:verify
npm run replay:verify -- --replay th7_ud8141.rpy
node scripts/dev-shot.mjs /tmp/th07-boot.png 300
npm run replay:browser -- tests/replays/th7_udFe25.rpy 1 300 /tmp/th07-replay.png 0
```

For the standard visual loop, run Stage 1 at frames 120, 800, 2500 with
`shoot`, and 5600+, then use `scripts/pixel-report.mjs` and the thresholds in
`AGENTS.md` §5. The final checkpoint also exercised Stage 4 frame 23651:
six live lasers, 641 bullets, and reflected bullets resolved to template 5
rects on atlas row y=96 with no page errors. Stage 5 frame 4881 shows Youmu's
portrait and the dialogue text `あなた、人間ね`.

## If a new replay diverges

1. Preserve the current working tree and run `git status`, `npm run check`,
   and the committed fixture verifier before changing gameplay.
2. Capture/compare PRE rows. A first mismatch at PRE frame N was caused while
   processing N-1.
3. At the earliest mismatch, trace the native and web fixed slots: enemies
   (480), player shots (96), attack slots (112), effects (400), enemy bullets
   (1024), and lasers (64). Record the exact caller and event order.
4. Fix the upstream deterministic engine root. Never add compensating RNG
   draws, particle counts, coordinate epsilons, or replay-specific gameplay
   branches. Golden files are detectors, not original-game authority.
5. Add an executable/data-proven regression and immediately rerun every replay
   already known to converge. Ghost mode may inspect later phases but cannot
   establish acceptance.
6. Before committing, repeat check/build/tests, replay verification, clean
   browser boot, replay playback, and pixel reports.

The next high-value campaign is one native replay per Easy/Normal/Hard rank,
because lower ranks execute different ECL instructions and pool-pressure
paths. Do not perturb the converged Lunatic streams merely to improve an
aggregate metric on a new replay.

## Hygiene

Never commit `reference/`, original binaries/data, native traces, screenshots,
local replays, `tmp/`, `issues/`, or `output/`. Preserve unrelated user state,
including the existing `FIX-REPORT.md` deletion, unless the user explicitly
asks to change it. Never force-push.
