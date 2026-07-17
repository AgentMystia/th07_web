# AGENTS.md

Operating manual for AI agents and contributors. It encodes the working
rules, the verification loop, the file-format facts, and the orchestration
protocol that produced the current codebase. Follow it exactly; nearly
every rule in it was earned by a real defect.

## 1. Mission

Reimplement **Touhou Youyoumu ~ Perfect Cherry Blossom (TH07)** in
TypeScript for the browser, driven by the original game data. Stages 1-8
are data-driven and playable; the current fidelity target is original-grade
Stage 1-6 behavior and presentation. Extra/Phantasm remain lower-confidence.

**Default rule: reproduce the original game exactly.** Do not simplify,
rebalance, redesign, modernize, or approximate original behavior unless it
is explicitly approved here or requested by the user. The engine is
*data-driven*: original `.ecl/.std/.anm/.msg/.sht` binaries are embedded
(`src/data/th07-data.ts`) and executed by our parsers and VMs. Hand-written
behavior is a last resort and must carry a comment flagging it.

## 2. Authority order

When sources conflict, higher wins:

1. Current user instruction.
2. Approved modernizations (§3).
3. Original data and executable in `reference/`: readable disassemblies in
   `reference/ECL7|DSTD7|MSG7|ANM7`, raw unpacked files in
   `reference/th07-original/`, `reference/Th07.exe` (v1.00b) for Ghidra.
4. Existing project implementation.
5. External docs (thtk source, PyTouhou, priw8's sht-webedit docs, wikis) —
   cross-validation only, never sole authority. TH06 semantics are NOT
   TH07 semantics; several opcode tables differ (§6).

`reference/` is git-ignored, local-only, read-only. Never commit, ship, or
serve it. Browser runtime code must never read from it.

**Current implementation is not proof of correctness.** If the data says
otherwise, the implementation is wrong.

## 3. Approved modernizations

- Focus hitbox dot rendering while focused (collision identical).
- Dev/debug tooling (`?test=1` hook, `dev-shot`/`dev-menu` scripts) — must
  not change shipped gameplay behavior.
- Web Audio BGM looping via `loopStart/loopEnd` sample frames from
  `thbgm.fmt` instead of whole-file loops.
- Plain-text control hints on menu screens.
- Stage-start player fly-in: the original places the player in-residence at
  the spawn point with a 240-frame invuln window and no entrance animation
  (its init preloads the materialize timer past its threshold). On stage
  start we instead fly the player up from below the playfield over 60
  frames (input/firing locked, invulnerable), then hand off to that
  240-frame invuln. Respawn after death is unchanged. Player-only visual;
  no gameplay, timing, or collision semantics change once landed.
- Low-latency canvas presentation, ON by default: the display context is
  requested with `desynchronized: true` (+ `alpha: false`). Browsers that
  grant it (Chromium) skip 1–2 compositor vsyncs; the renderer then draws
  every frame to an offscreen backbuffer and `present()` copies it in one
  op — a granted context is never drawn incrementally (that incremental
  front-buffer drawing was the 8552afe Stage-5 spell-card flicker, before
  the backbuffer existed). Non-granting browsers feature-detect (context
  attribute readback, no UA sniffing) to the direct path, byte-identical
  to the old behavior. Output pixels are identical either way; sim/replay
  untouched. Kill switches: `?desync=0` (player-facing), `?backbuffer=1`
  (test-only, forces the present() path on engines that never grant).
  Note: headless Chromium GRANTS desynchronized, so every headless harness
  exercises the backbuffer path; readback/screenshots cannot prove scanout
  flicker absent — a manual Stage-5 spell-card eyeball on real desktop
  Chrome stays part of acceptance for presentation-layer changes.

Nothing else. In particular: **no invented visual content**. If the data
has no moon, there is no moon. Absence of data gets a flagged fallback and
a report, not fabrication.

## 4. Non-negotiable invariants

Every commit must satisfy ALL of:

1. `npm run check` — zero TypeScript errors.
2. `npm run build` — clean esbuild bundle.
3. `npm test` — all unit tests pass.
4. Clean headless boot: `node scripts/dev-shot.mjs /tmp/s.png 300` prints a
   snapshot with enemies spawning and **no `PAGE ERRORS` line**.
5. No isolation hacks in the tree: no debugging early-`return`, no
   commented-out subsystems, no hardcoded test state. A crashed agent once
   left `return;` at the top of `drawBackground()` — it made all code after
   it unreachable, which disables TypeScript control-flow narrowing and
   produced seven phantom "possibly null" errors. Treat unreachable code as
   a build breaker.
6. Nothing from `reference/` committed — no bytes, no long decompiled
   listings. Recovered *constants* with a provenance comment
   (`// Th07.exe (v1.00b) @ 0x43cb30`) are fine and encouraged.
7. `index.html` keeps working as a static page (esbuild IIFE bundle, no
   ESM imports at runtime, no dev-server-only paths).

## 5. The verification loop (how quality actually happens)

Code that typechecks is not done. **Done means observed working.** The
protocol below is designed for **text-only models**: every check yields
machine-readable text (state snapshots and pixel statistics), and no step
requires viewing an image. If your model does have vision, viewing the
screenshots is a bonus check on top — never a substitute for the numbers.

For any gameplay or visual change:

1. `npm run check && npm run build && npm test`.
   `npm test` includes the **replay-golden digest lock**
   (tests/th07-replay-golden.test.mjs): the committed real-play replay
   (tests/replays/th7_udFe25.rpy) is re-simulated headlessly and sparse
   per-frame state digests are compared — any simulation-behavior change
   fails it at the exact frame the change first manifests. If YOUR change
   intentionally alters gameplay (an alignment fix), regenerate with
   `UPDATE_REPLAY_GOLDEN=1 npm test` and commit the digest diff with the fix.
2. For bullet/timing/aim fidelity questions, run
   **`npm run replay:verify`** — it replays the fixture stage-by-stage in
   pure Node and compares our end-of-stage state against the NEXT stage's
   recorded snapshot (ground truth written by the original engine), reporting
   per-field diffs plus every unexpected player death with the killing
   bullet's provenance (owner enemy, ECL sub, spawn frame, angle/speed).
   `--trace A,B` dumps per-frame JSONL; `--dump-frame F` dumps a full
   snapshot. Format + workflow spec: reference/re-specs/exe-replay.md.
3. Drive the affected states headlessly and read the **snapshot JSON**
   (entity counts, positions, boss/spell state, cherry, player) printed by
   the tools. Assert the fields your change should have moved — and that
   the ones it shouldn't have moved didn't.
4. For anything rendered, run **`node scripts/pixel-report.mjs <shot.png>`**
   and compare against the baseline table below. The report samples named
   regions (in 640×480 game coordinates) and prints average color,
   brightness, texture % (pixels far from the region mean — detail
   present), distinct-color count, and the center pixel. Custom regions:
   append `x,y,w,h:label` args.
5. Iterate until snapshot + probes match the criteria. A change verified
   only by "it compiles" is assumed broken — this project's worst
   regressions all shipped in changes that compiled fine.

Baseline probe values (measured on a healthy build, frame 800, Lunatic;
tolerances ±12 on color channels, ±10 on texture % unless noted):

| region | healthy reading | failure signature |
|---|---|---|
| `sky` | lavender-grey avg (≈`#acaacd`), texture ≤3% | high texture = geometry leaking above fog |
| `ground-left/center/right` | texture ≥6% all three (7–60%; ground-right runs 7–8% under the upright-billboard tree renderer — `pixel-gate.mjs` enforces ≥6) | any side flat at fog color (≈`#8080c0`, texture ≤3%) = missing geometry / instance-culling void |
| `frame-left/right` | avg ≈`#400e20`, texture 0% | near-black = frame tiles not drawn; shifted avg = wrong tile rect |
| `hud-labels` | texture ≈30–45%, ≥100 colors | texture ≤5% = labels missing/misanchored |
| `hud-digits` | texture ≥20% | 0% = digit font not rendering |
| `logo` | texture ≥80%, ≥200 colors, green channel present | flat maroon = logo missing |
| `cherry-banner` | texture ≥15% | flat = banner/value missing |
| `player-zone` | bright ≥140, texture ≥50% (at spawn, alive) | flat ground reading = player not drawn (or moved/dead — cross-check snapshot `player`) |

If a reading is out of band, the *pair* of snapshot JSON + probe row
usually identifies the subsystem before any code reading (e.g. snapshot
says `enemies:19` but playfield probes are all flat → rendering, not
simulation).

Tools (they serve the repo over a local static server and drive headless
Chromium at `/opt/pw-browsers/chromium-*/chrome-linux/chrome`; run
`npm run build` first — they load `dist/th07.js`):

- `node scripts/dev-shot.mjs <out.png> [frames] [query] [heldKeys]`
  Boots `index.html?test=1&<query>`, advances N frames (keys held per
  30-frame batch), screenshots 1280×960, prints a JSON snapshot (enemies,
  bullets, playerBullets + dump, boss, spellName, cherry, player) plus any
  page errors. Useful query params: `difficulty=0..3`, `shot=reimuA|…`,
  `power=0..128`, `menu=1`.
- `node scripts/dev-menu.mjs <outdir> "<step>;<step>;…"`
  Edge-triggered menu navigation (holding a key ≠ pressing it; menus need
  press edges). Step = `key@shotName` or `N*key@shotName`; keys:
  `up down left right confirm back`, plus `wait`. Screenshots and snapshot
  JSON per named step.
- `node scripts/pixel-report.mjs <shot.png> [x,y,w,h:label ...]`
  Region statistics for text-mode visual verification (see step 3 above).
- `node scripts/audit-th07-player.mjs`
  Dumps all 12 `.sht` files through the real parser (header + every
  shooter record per power bracket) for regression diffing.
- `node scripts/desync-stage5-probe.mjs --require-desync`
  Presentation gate for the default-on desynchronized canvas (also run by
  `verify:full`). Reaches a real Stage-5 spell card, resumes the live rAF
  loop, and samples the PRESENTED canvas (`displayPixelAt`) for 3s plus
  first/last screenshots. Pass = exit 0 with `granted:true`,
  `blackPresents:0`, spell held all samples. Exit 3 = grant lost in this
  environment (investigate before trusting other headless results).
- `node scripts/browser-matrix-smoke.mjs --browser firefox|webkit|chromium`
  Cross-engine boot smoke (local-only; `npx playwright install firefox
  webkit` once). Pass 1 asserts shipped defaults (Firefox/WebKit must
  read back `granted:false, backBuffered:false` — the unchanged direct
  path); pass 2 forces `&backbuffer=1` to prove `present()` parity on
  non-Chromium rasterizers.
- `npm run latency:trace` — Chrome event-to-present latency proxy
  (headed). A/B the low-latency canvas with the default arm vs
  `-- --no-desync` (`?desync=0` control); read the grant from the
  report's `canvas.actual.desynchronized` / `desynchronizedGranted`
  fields, never from the CLI flags. `--chrome-major` pins the expected
  browser (148); `--allow-invalid-refresh` for non-144Hz rigs/Xvfb.
  `npm run perf:smoke -- desync=0` is the matching throughput control arm.

Standard stage checkpoints (dev-shot frame → machine-checkable criteria):

| frame | snapshot must show | probes must show |
|---|---|---|
| 120 | enemies ≥1, no errors | `hud-labels` texture ≥30% (cascade done) |
| 800 | enemies >0, bullets >0 (Lunatic) | all three `ground-*` textured; `sky` flat |
| 2500 | score >0 when `shoot` held | `cherry-banner` texture ≥15% |
| 3400 | — | `sky`/`ground-*` avgs visibly darker than at 800 (dark-purple fog section) |
| 5600–6200 | `boss:true`, `spell` non-empty at spell phases | `ground-*` all textured (boss-loop background — no fog-colored void). While a spellcard is ACTIVE the playfield reads the scrolling eff01 sheet instead (dark purple, texture ≥10%) |

Menus (`dev-menu.mjs`): each step's snapshot must report the expected
`scene`/`cursor`/`difficultyName`/`character`/`shotType`; after the final
confirm, `scene:"stage"` with the chosen difficulty and character. Probe
any menu screenshot with custom regions when art placement is in doubt
(e.g. the title logo occupies roughly `64,64,320,176` and should read
texture ≥60%).

## 6. Format facts (do not re-derive; do not assume TH06)

Established by disassembly of this game's own data and, where noted, the
executable. If an implementation fights these facts, the implementation is
wrong.

**Geometry.** Screen 640×480; playfield rect (32,16,384×448). Sprite ids in
multi-entry ANM files are entry-scoped on disk and offset by an entry base
at parse time.

**ANM v2** (`src/formats/anm.ts`): 64-byte entry headers; instruction
encoding `{u16 op, u16 totalLen, i16 time, u16 paramMask}`. Key ops: 3 set
sprite, 6 set position, **22 corner-relative anchor (top-left)**, 8/15
alpha/fade, 9 color, 16 blend, 17/18/19 interp moves, 20 wait-forever,
21 interrupt label (−1 = fallback), 23 hide+wait, 26/27 UV scroll,
30/31 render flags (safe no-ops), 32–36 formula interps (formula 0/7/255
linear, 1=x², 2=x³, 3=x⁴, 4=2x−x², 5=2x−x³, 6=2x−x⁴). `interrupt(id)`
jumps past the matching `ins_21(id)` and forces visible. **Multi-entry
files reuse on-disk script ids across entries** (title01.anm has five
different scripts named id 0) — always resolve scripts and sprites through
an entry-scoped lookup, never a flat id map.

**Anchors.** `Renderer#drawSprite`/`drawAnmFrame` center on (x,y) — entity
semantics. HUD/menu layout coordinates from ANM scripts are top-left
(`ins_22`). Convert at the call site (see `StageScene#blit`). Two separate
HUD reworks shipped half-a-sprite off before this was written down.

**STD** (`src/formats/std.ts`): world axes x lateral, y forward depth,
z height with **negative z = up**. **Quad anchoring is per-script
(AnmManager::Draw3 anchor bits):** op22/anchorTL scripts extend from
their position CORNER by width/height (stage ground tiles, the stage-5
staircase treads/risers); unanchored scripts are CENTERED on position
(stage-5 balustrades, the billboards). autoRotate=2 (ANM op25 arg 2)
scripts are camera-facing billboards (Stage.cpp:1032-1103 →
DrawFacingCamera), not flat slabs. Script ops:
5 camera-position keyframe (args are float bit-patterns even when the
disassembly prints ints), 6 interpolate camera to next keyframe
(duration, easing mode — same formula table as ANM), 7 facing as a
camera-relative direction vector, 8 facing interp, 1 fog (packed ARGB int,
near, far), 2 fog interp duration, 4 jump (loops the script clock;
stage 1 loops frames 5510→6022, a one-tile-exact seamless dolly),
11 FOV (30°). The sky IS the current fog color; cells ≥98% fogged are
skipped (the slack-expanded texture edges otherwise peek past the fog
overlay as streaks). Roadside trees (stage 1/2) and stage-5/7/8 scenery
are autoRotate=2 billboards (see the anchor note above) — drawn
camera-facing with manual euclidean-distance fog, matching the exe.
**Draw order is NOT center-depth sorting**: the exe z-buffers every
background pixel (both zLevel chains share one depth buffer), which
`orderBgJobsByVisibility` emulates by ray-casting through each
screen-overlapping pair's overlap center and drawing the farther plane
first (fallbacks: center depth, then zLevel-chain order for ties).
Center-depth-only sorting tore stage 5 apart — its -45° slope wall
spans the whole staircase run, so its CENTER often sorts nearer than
individual treads while lying behind them.

**ECL** (`src/game/eclvm.ts`, `src/formats/ecl.ts`): header
`{u16 subCount, u16 timelineCount, u32 offsets[16+subs]}`; sub instruction
`{u32 time, u16 id, u16 size, u16 rankMask, u16 paramMask}`. Variables:
there is **NO register window** (an earlier model was disproven against
FUN_0040d750/df90/dda0/e560 + the op41/42 dispatcher cases). Each enemy
carries one 26-dword block (+0x6fc): locals 10000–10015 (ints
10000–10003/10012–10015, floats 10004–10011), two extra floats
10072/10073, rand-int params 10029–10032, rand-float params 10033–10036.
Eight RUN-GLOBALS 10037–10044 (DAT_0133da80..9c) are shared by every
enemy and act as **argument registers**: op41 CALL pushes the whole
0x218-byte frame (cursor + vars + wait timer + op27 interps) and copies
the globals into the callee's param slots; op42 RETURN restores the frame
(callee writes roll back). Interrupt entry pushes the same frame without
the copy; the op144 periodic sub runs on its own persistent stash
(+0x2ee8, exported back at its return via +0x8f4). Var 10056 reads a
random derived from the params (int: base+rng%range from 10029/10030;
float: base+rng01()*range from 10033/10034); 10055 is a raw rng draw;
10060 is a random angle in [−π, π). op92/93 children inherit a copy of
the parent's whole block (FUN_0041db60). Rank masks gate spawns by
difficulty — verify changes on Lunatic (`difficulty=3`), which exercises
paths lower ranks never touch. FIRE copies the enemy's five op79 entries into
each bullet; `FUN_004229f0` promotes at most one movement behavior per normal
bullet-manager tick (construction promotes the first, spawn states pause the
queue, their transition tick resumes it). Unselected and opcode-0x2000 grace
entries may be skipped in the same pass without consuming that one-slot
budget. Spell names (op 90) are XOR-0xAA-obscured Shift-JIS, terminated by a
0xAA byte.

**MSG** (`src/game/dialogue.ts`): ops 0 end, 1 portrait enter, 2 face,
3 text line, 4 wait, 5 portrait state, 6 ECL resume ticket, 7 BGM, 8 boss
intro, 11 hide portraits, 12 BGM fade, 13 skippability.

**SHT** (`src/formats/sht.ts`) — layout verified against priw8's
sht-webedit struct_07 and all 12 real files: 52-byte header
`{i16 ?, i16 levelCount, f32 bombsPerLife, i32 deathbombWindow(15/8/6 for
Reimu/Marisa/Sakuya), f32×8 hitbox/graze/autocollect/itemRadius/cherryLoss/
pocLine/speed/focusedSpeed/diag×2}` then `{u32 offset, u32 powerThreshold}`
pairs (brackets 8/16/32/48/64/80/96/128/999). Shooter record 52 bytes:
`{u16 interval, u16 delay, f32 x,y,hitboxW,hitboxH,angle,speed, i16 damage,
u8 orb, u8 shotType, i16 sprite, i16 sfxId, i32×4 funcs}`. **PCB's shot
timer runs a 30-frame cycle** (Th07.exe FUN_0043a820, counter capped at
0x1e and re-armed while held; external docs claiming 60 were overruled by
disassembly); a delay-0 shooter fires on the press frame itself. Player
sprite ids are SHT sprite + 1024 base.
Bullet hitboxW/H are full widths; enemy-vs-player-bullet AABB is
`(enemyW + bulletW)/2`.

**Exe-recovered constants** (Ghidra, Th07.exe v1.00b — keep provenance
comments): unfocused orb offsets (∓24, 0), focused (∓8, −32); SakuyaB-only
option orbit fully decoded (rate vx·π/200, clamp ±36°, focused cluster
±π/14 at r=24); focus-toggle glide is 8 frames (x lerp, y eased); cherry
border trigger 50000 (0xC350) on **cherryPlus** (not the displayed gauge
cap!), border duration 540 frames (0x21C) with 30-frame fades; initial
**cherryMax** is per difficulty — 200000 E/N, 250000 H, 300000 L
(FUN_0042cf2f @ 0x42cf2f); the bottom-left gauge displays
`cherry/cherryMax` plus a small purple cherryPlus; border-survive score
bonus is `cherry` (×1, not ×10 — the
exe's `bonus*10` immediately `/10` is a lossless compiler no-op); point
item score (case 1 of the item-collect switch) is `v = 50000 − 100·round(y
− pocLine)` (or flat 50000 at/above the line), `+= floor((cherry−50000)/5)`
once cherry exceeds 50000 (or capped down to `cherry` itself if `v`
would've been the flat 50000), floored to tens, **then `score += v/10`**
— the live in-game score field is added-to (and displayed) at ×1 with no
further scaling anywhere in the HUD digit path (confirmed via the raw
"%.8d"/"%.9d" format strings backing the score readout, no appended
digit); see reference/re-specs/exe-cherry-border.md §3c/§4.

**HUD layout**: front.png sprite rects and resting coordinates are decoded
in `src/game/stage-scene.ts` (`FRONT`, `drawSidebar`, `drawFrame`) — labels
column x=432, digit font = ascii.png 8×12 glyphs at texture y=208 (digit d
at x=8d, pitch 8, no comma glyph), 東方妖々夢 logo at (480,208), caption at
(448,336), frame tiled from the 32×32 maroon tile + 128×16 strip (exact
integer fit), boss nameplates are ename.png rows (row 0 Cirno, row 1 Letty)
composited at (32,26), cherry banner at (32,448) showing `cherry/cherryMax`
(cherry right-aligned into the blank slot ending at in-sprite x≈84,
cherryMax after the slash) with the small purple cherryPlus above the
blank (exe draw @ all.c:1760-1870).

**RPY (T7RP replays)**: full spec in reference/re-specs/exe-replay.md;
parser `src/formats/rpy.ts`. Load pipeline (FUN_004402d0): decrypt from
+0x10 with key byte +0x0D (`b -= key; key += 7`), additive checksum
`0x3F000318 + sum(bytes[0x0D..])` == u32@+0x08, then TH06-era bitstream LZSS
from +0x54 (0x2000 window, cursor starts 1, 13-bit absolute pos/4-bit
len−3). Decompressed image: 7+7 stage offset tables @+0x1C/+0x38 (inputs /
slowdown trailers), shot byte (char*2+type) + difficulty + date + name +
final score at body start, then per stage a 0x2C snapshot (score-at-END,
pointItems, cherry, cherryMax, cherryPlus≤50000, graze, extendLevel,
threshold, **u16 RNG seed @+0x20**, power/lives/bombs/rank bytes) followed
by fixed 4-byte frame records (u16 input word + u16 aux, no RLE). Input
bits: 0x1 Z, 0x2 X, 0x4 Shift, 0x8 Esc, 0x10-0x80 directions (numpad
diagonals OR pairs), 0x100 Ctrl-skip, 0x1000 Enter. **Direction chords
resolve by priority — up beats down, right beats left (FUN_0043be00), NOT
vector cancellation**; real replays contain such chords. Rank
(DAT_00625884): recorded per stage; 16 at run start (= the neutral point of
every rank formula), 32 from stage 2 on; no per-frame increment exists in
the exe (machine-code scan) — constant within a stage.

### Native replay convergence checkpoint (2026-07-13)

Stage 1-6 now converge for two independent SakuyaA Lunatic replays. This is
an original-behavior checkpoint, not a golden-only assertion: both were run
without ghosting through the production replay harness, and PASS requires an
authored stage completion, exact next-stage/end fields, exact per-frame AUX
kill/collect/player-contact streams, and the original RNG draw residue. A PRE
row is still defined at the beginning of a replay frame; a mismatch at PRE N
was caused while processing N-1.

Committed fixture `tests/replays/th7_udFe25.rpy`:

| stage | frames run/available | kills | collects | player contacts | RNG |
|---|---:|---:|---:|---:|---|
| 1 | 10476/10477 | 684 exact | 382 exact | 0 exact | 163385, residue exact |
| 2 | 13705/13706 | 396 exact | 494 exact | 0 exact | 203224, residue exact |
| 3 | 15678/15679 | 410 exact | 635 exact | 0 exact | 258253, residue exact |
| 4 | 24445/24446 | 1050 exact | 1056 exact | 0 exact | 279512, residue exact |
| 5 | 19377/19378 | 412 exact | 545 exact | 1 exact | 379003, residue exact |
| 6 | 26434/26436 | 279 exact | 1095 exact | 0 exact | final-stage seed unavailable |

Stage 5's one contact is present in the original AUX stream and is not a
false death. Stage 6 has one recorder-metadata anomaly: the RPY stores score
116283035, while Th07.exe v1.00b's live field and the web engine both retain
116283036 (native PRE25779..26433, `DAT_0061c258+4`). `replay:verify`
reports this as an explicit advisory rather than treating the stale metadata
word as behavior truth.

Independent local LNNN replay `th7_ud8141.rpy` also passes all six stages:
kills are 695/390/351/919/397/279, collects are
408/490/493/491/372/1144, all six player-contact streams are zero, and every
available RNG residue is exact. The file is local evidence and must not be
committed.

The convergence came from shared engine roots, not replay-specific draw
tuning: fixed-capacity slot allocation and manager order; immediate
enemy-outer shot collision/death processing; native ECL variable typing and
call/return/periodic clocks; progressive bullet-EX promotion; raw FIRE
endpoints and float32 constructor staging; float32 enemy writes, mode-2/
mode-3 interpolation, op87 anchors, laser transitions and player-shot AABBs;
Border/invulnerability/slowmo split clocks; item/cancel/Cherry/clear-bonus
ordering; MSG op9/op11 settlement; and exact effect-pool pressure. The last
independent Stage-4 split was a mode-2 float64 residue at x=191.9997406 that
broke an original strict SakuyaA target tie; native f32 staging leaves both
targets at x=192 and retains the first fixed slot. Effects 7 and 8 also
perform the executable's template-5 ANM reset after a laser deflection.

These corrections are engine-wide, but two Lunatic replays do **not** prove
Easy/Normal/Hard convergence. Lower ranks select different ECL instructions,
formulas, bullet counts, and pool-pressure paths. Each difficulty still needs
its own native replay PRE trace plus full event/end-state verification.

### Next-session fidelity workflow

1. Preserve unrelated worktree state and all local evidence. Never commit
   `reference/`, native traces, screenshots, local replays, `tmp/`, `issues/`,
   or `output/`.
2. Re-establish this checkpoint with `npm run replay:verify`, then run the
   replay under investigation without ghosting. Ghost is diagnostic only.
3. At the earliest PRE mismatch, trace native and web fixed enemy,
   player-shot, attack, effect, laser, and enemy-bullet slots plus the exact
   caller/event order. Fix the deterministic upstream root; never compensate
   with an invented RNG draw, count, position epsilon, or replay special case.
4. Add an exe/data-proven focused regression, immediately rerun every already
   converged replay, and regenerate a replay golden only after the original
   behavior change is demonstrated independently.
5. Before a checkpoint commit, run §4/§5 in full: check, build, tests,
   `replay:verify`, clean boot, browser replay, standard Stage-1 snapshots,
   and pixel reports. See `HANDOFF.md` for the concise command list.

**Browser Replay preview status:** implemented and browser-verified. The title
Replay entry opens a browser-local `.rpy` picker (no upload), then uses the
authored `replay00.png` layer for replay metadata, present-stage selection,
and the original three-mode confirmation (normal, recorded-slowdown, and
boss-only). Playback uses the production `Rpy`/`ReplayInputSource`, restores
the native stage snapshot after seed/bootstrap initialization, continues only
through physically adjacent stage slots, and maps the shared seventh slot to
Extra or Phantasm as the difficulty requires. Live ESC owns the two-row replay
pause menu and never consumes a recorded frame. Slowdown trailers preserve
the native leading-byte offset and discrete cadence buckets; skippable-dialogue
and boss-only fast-forward repeat the manager chain to their native modulo
boundaries. Files and decompressed bodies are capped at 16 MiB. Verify the
real browser path with `npm run replay:browser -- <file.rpy> [stage] [frames] [shot.png] [mode]`;
Stage 1 frame 300 and Stage 5 frame 4881 (Youmu portrait plus
`あなた、人間ね`) were observed through this path without page errors, and
all three modes plus pause cursor ownership were exercised. CI runs
`npm run replay:verify` before the Pages build, so Stage 1-6 convergence is a
deployment gate rather than a manual-only checkpoint.

## 7. Approximations registry (known, flagged, improvable)

Each also has an inline comment at its code site. Do not silently "fix"
gameplay to taste — improve these only with better evidence (Ghidra, frame
comparisons against real play).

- Frame tiling positions (exact-fit math, engine placement not literal).
- HUD star icon x positions; spell-timer and fps exact placement.
- Cherry+ banner interrupt→state mapping (dim=charging, bright=border).
- Bomb mechanics: the twelve focus-latched forms now run decoded per-form
  state machines (`src/game/player-bombs.ts`) writing the exe's moving
  attack-slot pool (player+0x9dc, consumed by FUN_0043a980). Damage/cancel
  use the slot AABBs (no full-screen sweep). SakuyaB's time-stop freeze
  pulses (FUN_00425f10) are implemented. The shared 60-frame screen tint
  (FUN_00407520) and reserved-slot activation VM (FUN_00407620) are
  represented by the character bomb ANM scripts + the runner, not byte-
  exact VM spawns. Per-form spawn cadence/orb motion are from specs
  spec-bombs-{shared,reimu,marisa,sakuya}.md.
- Player shots run per-shot ANM VMs (SHT `sprite` = global script id; impact
  re-arms `sprite+0x20`; bullet dies when its script ends). MarisaB's two
  persistent-laser forms (3-slot tracker, beam-history ring, helper boxes)
  and MarisaA's repeat-hit missile explosion are implemented. See
  spec-marisab-beams.md / exe-player-funcs1.md.
- Floating score/Cherry popups implemented (spec-popups.md): two ring pools,
  distance-from-player alpha pulse, full color/value rules incl. the
  phase-end escalating sweeps and the red cherry-gain popups.
- Spell-bonus decay rounding: exe writes `floor10(ftol(<register-arg float
  expr>))` per frame (0x41f8a8 region); the port computes
  `floor10(base − decayPerSec·elapsed/60)`. Sub-10-point drift only.
  (The damage cap 70 and op 142 are no longer approximations: cap
  confirmed at all.c:14226; op 142 = N-frame damage shield, boss /9 /
  non-boss 0, countdown at all.c:14440.)
- `ins_30/31` render flags unknown (no-op everywhere, matches PyTouhou).
- Spell declaration presentation: the simple scrolling/static stage sheets
  remain open-coded where their op-4 loops defeat AnmRunner's frame-keyed
  fades. Stage 5 is data-driven through both real `eff05.anm` entry VMs:
  bullet-time effect 10 interrupts both with label 2 (base alpha 64/red;
  `eff05b` purple additive scale/rotation), and effect 11 restores label 1.
  This is the meaning of the writes to ANM VM `+0x1c6` at
  `0x0133e1ce/0x0133e41a`; the old `spec-slowmo.md` “dead write” conclusion
  is overruled by the VM layout and the original visual trace. The
  capture.anm flash draws as a flat teal tint (its runtime `'@'` texture is
  not extractable); the face_01_00 cutin sweep path/timing and the red
  name-banner gradient (text.anm textures not extractable) are hand-tuned;
  spell history is session-scoped (original persists in score.dat).
- Boss X-position marker: exact sprite not recovered from front.anm
  (spec-ui-stageclear.md §3); drawn as a small ~60% alpha "Enemy" label at
  the playfield bottom edge tracking boss.x.
- Bullet-effect ids 1/2/4/6/9/12-15/19/21-23 ported. Caution:
  `spec-effects-misc.md`'s old “sparkles” description for ids 12/21 is
  overruled by FUN_00423480/FUN_00421e90: these handlers replace qualifying
  big bullets with real enemy-bullet volleys before deleting the parents.
  Id12 emits 10/18/22/25 children by difficulty inside its ±64/±48 Y band;
  id21 emits 15 inside ±128(H)/±180(other) and is rank-gated by ECL. Each
  child performs x/y frand, kind u16, angle frand and EX-rate frand in that
  order (nine raw draws), starts at speed 0.1, and carries opcode-0x20 for
  100 ticks. Parent qualification uses sprite height >48, not width. Id2
  converts each nearby offset-2 parent into two real
  sprite0/offset6 accelerating bullets (six raw draws total per parent);
  id6 converts its selected offset family into 3 native rings (Lunatic
  param0 = 2+2+1 bullets, zero RNG). Both delete the parent only after child
  construction. Id4 alone remains a visual-particle replacement. Id1
  "declaws" matched bullets (filter =
  spriteOffset, the FIRE 2nd i16 / exe bullet+0xbf8 — same field ids 2/6
  filter on) to nominal 0.3 and installs a fresh opcode-0x20 slow-turn with
  its own elapsed counter (E/N/H 60 ticks @ +1/60, Lunatic/Extra 240 @
  +0.005263158, turn ±π/(rng01*60+180)/tick; FUN_00416da0 @ 0x416da0); ids
  9/15 are screen shake/flash, id 19 is the 3-second BGM fade. Ids 22/23
  (cosmetic auras) are intentional no-ops. ECL op149 (spell-presentation
  origin, 1 use) and op150 (enemy ANM Z-rotation) are handled.
- Slowmo clock (op121 ids 10/11): the executable scales STD, ANM, ECL,
  player, enemies, lasers, items, bombs, and timers while collision remains
  wall-clock. The port now drives all of these from one global `slowRate`
  (effect 10 = 1/param + retroactive bullet-vector rescale + shape
  0x260..0x26f -> 0x26f + spell-background interrupt 2; effect 11 = inverse
  + shape restore + background interrupt 1 + rate reset; split-counter
  timers accumulate fractionally). See `spec-slowmo.md`, with its old claim
  that the two background writes are dead explicitly overruled above.
- Extra/Phantasm starting bombs/power PROBABLE (community convention),
  not exe-verified.
- ESC pause menu: presentation is the authored ascii.anm entry-2
  (pause.png) scripts verbatim, but the exe's trigger/menu logic was not
  statically recoverable — BGM-keeps-playing and the confirm default
  (いいえ) are PROBABLE; the cursor highlight tints unselected rows (no
  authored variant exists). Pause-menu Retry restarts the run (story:
  stage 1; practice: the practiced stage) — label semantics, PROBABLE.
- Practice Start: flow/init are exe-cited (8 lives, full reset, stage
  select after shot select, clear→title with the cursor re-parked), but
  all six stages are selectable — the original gates by score.dat "CLRD"
  cleared-stage data this port doesn't persist (approved modernization:
  the stage list exists for testing). The stage list renders as plain
  text (original uses its ascii font + per-stage practice scores).
- Supernatural Border visuals are now native-faithful: the stage background
  is multiply-darkened through the exe's 128→48→128 grey envelope with
  SmoothBlendColor averaging (Player.cpp:1975-1995 + Stage.cpp:512-573),
  the ring is the real etama.anm script-219 magic circle (scale 1→0.25,
  spin negated on activation; break spawns the 0.0625→1.3 expanding copy
  fading out over 30f plus the 32 fixed-angle petal burst), the player
  sprite flashes red every 4 frames, and the HUD shows the pulsing gauge
  badge + recolored cherryPlus digits (AsciiManager.cpp:1256-1308).
- Decorative ambient particles (ECL op117/118 → `spawnEffectParticles`) keep
  approximate raster presentation, but their allocation, fixed 400-slot
  pressure, release clocks, and RNG consumption are executable-derived for
  every Stage-1..6 family exercised by the converged replays. Representative
  veto costs from `DAT_00494fb0`: effect 17→2 raw draws, 20→22, and 22→2 or
  4 (the four-draw branch is only the ≤−990 sentinel). World families 26/27
  use `frand*100-50` Z spread and share FUN_0041a050 release semantics.
- Enemy death/drop effects are no longer an aggregate approximation. The
  enemy manager performs fire → player-shot/attack collision → immediate
  damage → death in fixed slot order. FUN_0041ed50's itemDrop branch, global
  1-in-3 random-drop counter, preburst, item construction, boss sweep, common
  effects, and id5 impact cadence run in their executable order. Preserve this
  shape; changing a draw total in isolation will desynchronize item→power→DPS
  and later fixed slots even if an aggregate residue happens to match.
- Ghost runs remain diagnostic-only. Dialogue, death consequences and manager
  lifetime can change how long ambient generators run, so only a no-ghost
  original replay establishes acceptance. `replay:verify` enforces this.

## 8. Pitfall catalog (check these FIRST when something looks wrong)

- **Half the geometry missing / one-sided rendering** → anchor or extent
  convention (corner vs center). §6 Anchors/STD.
- **HUD/menu elements uniformly shifted** → top-left vs centered blit.
- **Streaks or blocks near the horizon** → fog metric or fully-fogged
  cells being drawn; sky must equal fog color.
- **Everything animates from wrong positions after a script change** →
  entry-scoped script/sprite id collision (multi-entry ANM).
- **Phantom TypeScript null errors in one function** → unreachable code
  above (leftover debug `return`), which kills narrowing.
- **Shots fire late / wrong cadence** → 30-frame cycle, delay-0 fires on
  press frame, focused/unfocused table switch.
- **Boss fight background/state weirdness** → the STD clock *loops* via
  op 4; anything keyed to raw stage frame instead of the STD clock drifts.
- **Menu navigation skipping steps** → held-vs-pressed key edges; menus
  are edge-triggered with 20-frame delay/6-frame repeat.
- **Draw cost ring suddenly ~10ms fatter (p50 1→6.6ms) with no code
  change** → the backbuffered (desync-granted) canvas. present()'s
  drawImage uses the backbuffer as a source, which forces the scene's
  batched raster to FLUSH synchronously inside the timed draw callback —
  work that on the direct path runs after the callback, invisible to the
  ring. Real frame delivery is unchanged (rAF cadence flat 16.7ms,
  measured). Do NOT "optimize" the number away: profile game-code cost on
  the `desync=0` arm (perf-probe does this; perf-smoke gates cadence on
  the default arm and cost on the control arm).
- **A magic constant "fixes" positioning** → your decode is wrong. Delete
  the constant, re-read the disassembly. Every compensating hack we ever
  added (scroll speed, camera lift, ground mirroring, procedural moon) was
  masking a misread and got replaced by the real semantics.
- **RNG-budget "matches" but bullets still desync** → the total can be right
  by cancellation. Profile per-effectId draws (`opts.profileRng` in
  replay-harness) and match each event's count, not just the sum. A single
  mis-resolved ECL operand (op117/118 count read raw instead of gi()) once
  hid a 100k-draw error that summed near budget.
- **Ambient effect / invisible controller vanishes mid-stage** → field sweeps
  (op94/op91/boss non-spell death) must only set HP=0, not delete;
  non-interactable enemies (op116(0)) are spared by the exe (removal is the
  interactable-gated death switch). Deleting them kills ambient emitters.
- **An exe-verified effect cost moves a proven PRE boundary earlier** → do not
  keep it in isolation merely because its aggregate draw count is plausible.
  Kill timing changes item/power/DPS and later event order, so false-death and
  full-stage budgets are hypersensitive, non-monotonic proxies. Identify the
  exact native caller, fixed slot, and stream position at the current earliest
  mismatch, then land all causally coupled cadence/order changes together.
- **A ghost full-stage RNG budget disagrees with a no-ghost PRE trace** → trust
  the no-ghost PRE trace. Ghosting changes death consequences and post-boss
  dialogue timing, which changes how long ambient generators run. Acceptance
  is the original replay without ghosting; use ghost only to inspect otherwise
  unreachable later state.
- **Probe reads flat where content belongs** → check the snapshot first:
  if the simulation state is right (entities exist), the defect is in
  rendering (anchor, entry-scoped ids, clip, alpha); if the state is wrong
  too, it's simulation (ECL/rank/timing) — don't debug the renderer.

## 9. Orchestration protocol (multi-agent work)

The pattern that works: a **strong orchestrator** (planning, review,
integration) drives **executor agents** (Sonnet-class) with precise briefs.
Executors are excellent when the brief removes ambiguity and mandates the
verification loop; they fail when asked to "make it good" without
acceptance criteria, or when two of them share a file.

### Brief template (give every executor ALL of this)

1. **Context**: repo path, branch (never switch), build/test commands, and
   the §6 facts relevant to the task — paste them, don't cite them.
2. **File ownership**: exact list of files the agent may modify. Everything
   else is read-only. Two agents must never own the same file
   concurrently; sequence them instead. (`stage-scene.ts` is the usual
   contention point — background, HUD, and gameplay all live there.)
3. **Steps**: concrete, ordered, with tool paths (thanm/thstd/thecl if
   needed) and disassembly locations.
4. **Acceptance criteria**: the exact dev-shot/dev-menu invocations, the
   checkpoint frames, and the snapshot fields + pixel-report readings each
   must produce (paste the §5 baseline rows that apply). Require the agent
   to run the probes and iterate until the numbers are in band — the
   numbers are the deliverable, and they work for text-only agents.
5. **Constraints**: no new dependencies, no commits (orchestrator commits),
   match code style, comment only approximations/provenance, keep the tree
   compiling at every stop point.
6. **Report format**: what changed (file:line), what was verified and how,
   approximations made, anything unresolved. Findings the orchestrator
   must act on go at the top.

### Orchestrator duties

- Gather the decisive facts *before* delegating (read the disassembly
  yourself; a mis-briefed executor produces confident garbage — the
  "camera never moves" hack chain came from briefing TH06 op semantics
  for TH07 data).
- Review the executor's evidence yourself: re-run its dev-shot/pixel-report
  invocations (or demand the raw outputs) and check the numbers against
  §5. Never accept an unquantified "it looks right". Viewing screenshots
  is an optional extra for vision-capable reviewers, not part of the
  contract.
- Commit in reviewed checkpoints, one concern per commit, so a crashed or
  runaway agent can be rolled back cleanly.
- Assume agents can die mid-edit (session limits). After any crash:
  `git status` + `npm run check` before anything else; hunt for leftover
  isolation hacks (§4.5); decide keep/revert per file.
- Have executors write large findings to files (specs, dumps) rather than
  only their final message — a crashed agent's message is lost, its files
  survive.
- RE analysis agents (Ghidra, format decoding) should be read-only on
  `src/` where possible: deliver a spec file; a separate implementation
  pass applies it. The hud-spec.md → HUD rebuild flow worked exactly this
  way.

### Ghidra RE workflow (repeatable)

1. `reference/Th07.exe` (PE32, v1.00b). Install headless Ghidra (JDK 17+,
   `analyzeHeadless <proj> th07 -import Th07.exe`), or radare2 as
   fallback.
2. Anchor by immediates (e.g. 0xC350=50000, 0x21C=540) or IEEE-754 float
   bit patterns in `.data`/`.rdata` for coordinate tables; xref into
   functions; decompile; record address + one-line pseudo-C + constant +
   confidence (confirmed/probable/weak) in a scratch notes file.
3. Only **confirmed** values land in code, each with an address comment.
   Probable/weak go to §7 as flagged approximations.

## 10. Repo hygiene

- Runtime surface: `index.html`, `dist/` (generated — never hand-edit),
  `src/`, `assets/th07-img|audio/th07|sfx/th07`. Browser code must not
  read `reference/`, `tests/`, `scripts/`, `docs/`, `node_modules/`.
- Never commit: `reference/`, secrets, screenshots, logs, scratch scripts,
  `test-results/`, `dist/`.
- Keep diffs focused; no drive-by refactors. New scripts/tests only as
  intentional project files.
- The legacy TH06 app never lived in this repository; it is preserved in
  full on the `legacy-vanilla` branch of
  [th6_web](https://github.com/AgentMystia/th6_web). Do not resurrect
  TH06 files here, and do not consult the TH06 implementation as
  behavioral authority for TH07 (§2, §6: several formats and constants
  genuinely differ).
- Commit messages: what + why, present tense; mention the evidence
  (disassembly, exe address, screenshot checkpoint) that justified the
  change.

## 11. Handoff format

Every task ends with: what changed (files), evidence basis (data/exe/doc),
exact-or-approximate status per §7, verification actually run (commands +
checkpoints + whether screenshots were reviewed), and remaining gaps. If
validation was skipped anywhere, say so explicitly — an unverified change
is reported as unverified, never as done.
