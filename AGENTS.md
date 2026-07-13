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
| `ground-left/center/right` | texture ≥10% all three (13–60%) | any side flat at fog color (≈`#8080c0`, texture ≤3%) = missing geometry / corner-vs-center bug |
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
z height with **negative z = up**. **Quads extend from their position
corner by width/height** — position is NOT a center. (Center semantics
leaves the road's right half ungeometried wherever rows have single
instances — most of the stage and the whole boss loop.) Script ops:
5 camera-position keyframe (args are float bit-patterns even when the
disassembly prints ints), 6 interpolate camera to next keyframe
(duration, easing mode — same formula table as ANM), 7 facing as a
camera-relative direction vector, 8 facing interp, 1 fog (packed ARGB int,
near, far), 2 fog interp duration, 4 jump (loops the script clock;
stage 1 loops frames 5510→6022, a one-tile-exact seamless dolly),
11 FOV (30°). The sky IS the current fog color; cells ≥98% fogged are
skipped (the slack-expanded texture edges otherwise peek past the fog
overlay as streaks). Trees are ZUN sprite-stacking: flat stacked layers,
never billboards.

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

### Native replay alignment checkpoint (2026-07-13 preview)

This is an evidence boundary, not a declaration that replay alignment is
finished. It applies only to the committed `th7_udFe25.rpy` fixture
(SakuyaA, Lunatic). A PRE row compares the original and web engine at the
beginning of a replay frame: stage, input word, RNG seed, and cumulative raw
RNG draw counter. Therefore a first mismatch at PRE frame N was caused while
processing frame N-1.

| stage | native PRE evidence | current exact boundary | remaining gap |
|---|---:|---:|---|
| 1 | 0..10475 | all captured PRE rows exact; full-stage RNG residue and stage completion exact | behavior is not finished: kills 689 vs original 684 and score 2159705 vs 2446935 |
| 2 | 0..12000 | every captured PRE row exact | acquire and compare the untraced 12001..13705 tail |
| 3 | 0..12000 | every captured PRE row exact | acquire and compare the untraced 12001..15678 tail |
| 4 | 0..19000 | every captured PRE row exact | acquire and compare the untraced 19001..24445 tail |
| 5 | 0..12000 | through 10990 | first mismatch PRE 10991 (transient; first sustained range starts 11197) |
| 6 | 0..26433 | through 17343 | first mismatch PRE 17344 (transient; first sustained range starts 24423) |

The current worktree contains broadly shared engine corrections, including
fixed-slot allocation/iteration (480 enemies, 96 player shots, 112 attack
slots, 1024 enemy bullets, and the fixed effect pool), per-enemy immediate
player-shot collision/death ordering, spawn-frame shot timing, ECL variable
typing/call/return/periodic-sub clocks, progressive bullet EX behavior
promotion, replay RNG bootstrap/counting, native float staging, split clocks,
rank/cherry/dialogue scheduling, and stronger replay event/RNG verification.
These roots are engine-wide and are expected to improve every difficulty,
but Lunatic convergence does **not** prove Easy/Normal/Hard convergence.
Lower ranks select different ECL instructions, formulas, bullet counts, and
pool-pressure paths; each difficulty still requires its own native replay
PRE trace and end-state/event verification.

Stage 2's former PRE10930 split was the op52 right-wall branch's original
bug: Th07.exe reads the previous live movement heading at enemy+0x2b54,
whereas the port read its separate mode-1 polar angle. That displaced the
boss enough to create an early SakuyaA knife collision/id5 draw. Reading
`heading` (and publishing op54's duration-zero heading immediately) makes all
12001 captured native PRE rows through frame 12000 exact. The untraced tail is
still required before declaring the whole stage converged.

Stage 3's former PRE7450/8393 splits were both shared engine roots. Bullet
effect id6 (`FUN_00417440`) constructs three real enemy-bullet rings with
zero RNG rather than generic particles. Then `FUN_004173d0` revealed that
effect id5 writes the tracked boss's current +0x2b0c/10/14 position into the
helper's +0x2b8c/90/94 orbit center; copying the boss's own `orbitTarget`
left the helper ring offset by (-4.04,+12.29), making fixed bullet slot 990
graze four frames early. Correcting both makes every captured PRE row through
12000 exact. Ops54/55 also publish their current mode-2 origin into the same
shared +0x2b8c/90/94 fields, per FUN_0040e850/FUN_0040ea90.

Stage 4 advanced from PRE15289 through the entire captured frame-19000 window
through three independent native corrections. Op47 writes Cartesian vx/vy/vz
directly; it is not
an angle/speed operation. Laser grow->hold and hold->shrink transitions test
collision in both the ending and entering state in one manager pass before
the common phase-counter tail. Finally, FUN_0041a600/FUN_0041a8d0 stage ids
26/27 world-particle Z as `frand*100-50`; the old `-frand-50` collapsed the
particles into a one-unit slab and exposed 24 false free effect slots. At
processing frame 17526 the corrected 400-slot pressure accepts exactly 58
id17 particles, rejects all three later id5 requests, consumes the native 348
raw draws, and removes the former PRE17527 split.

Stage 5 spell 75, 獄神剣「業風神閃斬」, has its missing slash barrage fixed.
Bullet effects 12/21 are not generic visual-particle bursts: FUN_00418260 /
FUN_00418bc0 build FIRE templates and call the real enemy-bullet constructor
FUN_00423480. On Lunatic, each cut 大玉 emits 25 (id12) or 15 (id21) real,
collidable small bullets; every child consumes nine raw RNG draws and carries
the authored 100-tick opcode-0x20 acceleration. Browser spell-75 probing now
shows 42 large bullets becoming 717 same-frame surviving children with no
page errors. This fixes the pattern itself but does not move Stage 5's earlier
PRE boundary by itself.

Stage 5's former PRE8198 split was an op138 fixed-slot lifetime error.
FUN_0041d190 initializes all 96 template history X fields at enemy+0x2f78 to
-999.0; Y/Z remain zero, and the validity gate is X>=-990. Zero-filling those
entries made an unwritten trail tail look on-screen, retaining enemy slot 2
past PRE8168 and displacing the next actor to slot 7. That changed SakuyaA's
target/player-shot slots and removed one native id5 at processing 8197.
Restoring the sentinel moves the first mismatch to transient PRE10991-10992;
another transient occurs at 10997-10998, and the first sustained range starts
at PRE11197. That sustained split is the spell-75 slash at processing 11196:
the web constructs 730 children and native consumes exactly 45 more raw draws,
equivalent to five more children at the proven nine-draw cost. The child
constructor/order is exact; continue by tracing which additional large parent
bullet survives or lies inside the native cut band. Both native handlers gate
on sprite descriptor HEIGHT (+0x2c)>48, not max(width,height); this semantic is
already corrected but all parents at the current boundary are 64x64, so it
does not explain the remaining five-child difference.

Stage 6's former PRE8167 split was stale FIRE/op79 state crossing a retained
boss callback. HP thresholds, timeouts, and retained death callbacks all copy
the 0x35-dword `DAT_009a26bc` template over enemy+0x2bd4 and clear +0x2ca8
(FUN_0041e4a0/FUN_0041e6b0/FUN_0041ed50). Resetting bulletProps, all five
op79 slots, op81 sound state, and auto-fire interval makes PRE0..12000 exact;
the split counter at +0x2cac..+0x2cb4 is outside the copied block and remains
live. Native capture now reaches PRE26433. Exactness continues through 17343;
PRE17344 is a one-frame +4 id5 caused by player-shot slot 6 reaching a collision
boundary about one frame early (roughly 1e-3 velocity / 1e-2 position drift),
then resynchronizes at 17345. PRE17345..24422 are exact. The first sustained
mismatch begins at PRE24423: processing 24422 is native +12 versus web +4,
and the web sees one id8 graze. Trace whether native performs three separate
grazes or one count-3 branch; do not infer the cause from the end-stage
aggregate.

### Next-session replay convergence startup

1. Preserve unrelated worktree state (`FIX-REPORT.md`, `issues/`, `output/`,
   local replays/traces). Run `git status`, `npm run check`, then confirm the
   checkpoint table with no-ghost PRE comparison before changing gameplay.
2. Resume from the earliest unresolved events: Stage 5 processing 10990/10996
   (transient id5 differences) then 11196 (sustained); Stage 6 processing
   17343 (transient) then 24422 (sustained). In parallel, acquire the untraced
   Stage 2/3/4 tails.
3. At each boundary trace native and web fixed enemy/player-shot/effect/bullet
   slots plus per-draw caller labels. Fix the deterministic state/order root;
   never add a compensating draw or tune a particle count to match residue.
4. Add a focused exe-proven regression, re-run every already-captured stage
   window immediately, and only then advance to the next mismatch. Ghost may
   inspect later phases but never establishes a PRE acceptance boundary.
5. Regenerate replay golden only after the original behavior change is proven.
   Before the next checkpoint commit run §4/§5's full test, clean boot,
   browser replay, Stage-5 spell-75 probe, and pixel-report loop.

An independent SakuyaA Lunatic LNNN replay (`th7_ud8141.rpy`, local-only)
now matches native Stage 1 at every captured PRE row 0..10798: input, RNG
seed, and cumulative raw draw count are exact through the native stage exit;
the replay has zero unexpected hits, exact RNG residue, and exact collect
events. Kill/score behavior remains non-exact (707 vs 695 kills; 1818860 vs
2124762 score), so this is a survival/RNG convergence checkpoint rather than
full behavior completion. Three shared roots produced the fix: enemy SET_ANM
retains the wrapper's current sprite pointer, ECL op132 invisibility gates
off-screen culling, and both directions of the 8-frame option-glide reversal
advance the old split counter before complementing/advancing the new state.

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
Stage 1 frame 300 and Stage 5's frame-4820 Youmu dialogue
were observed through this path without page errors, and all three modes plus
pause cursor ownership were exercised.

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
- Spell declaration presentation: the eff01.anm background script is
  open-coded (its op-4 loop defeats AnmRunner's frame-keyed fades); the
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
  (effect 10 = 1/param + retroactive bullet-vector rescale, effect 11 =
  inverse + reset; split-counter timers accumulate fractionally); see
  spec-slowmo.md.
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
- Supernatural Border ring remains procedural (no ANM source recovered);
  it now closes fully at expiry and the playfield carries the exe's
  30/480/30 tint envelope (FUN_0043e2e0 state 4).
- Decorative ambient particles (ECL op117/118 → `spawnEffectParticles`): the
  VISUAL is approximate but the per-particle **RNG draw count is exe-exact**
  for the types stage 1 uses, because all effects share the one gameplay RNG
  stream (state 0x495e00) so a wrong draw count desyncs bullet/fire timing.
  Costs are the `DAT_00494fb0` spawnVetoFn (binary-read; paired perFrameGateFn
  draws 0): effectId 17→2, 20→22, 22→2-or-4 (4 only for the ≤−990
  random-angle sentinel; ordinary signed launch-x uses 2 — FUN_0041b020's
  threshold is the f64 −990.0 at 0x48ec28, not the low-dword float 0.0).
  `EFFECT_DRAW_COST`
  in stage-scene.ts. The full effect-family veto costs (binary, effect table @
  file 0x933b0): ids 0/1/2 NULL=0; id3=FUN_00419700=4; id4/5/6=FUN_004194d0=4.
  **Draw-model DERIVED + VERIFIED; death-model wiring remains blocked on exact
  event order** (2026-07-13):
  - **Enemy death** (`spawnEnemyDeathEffect`, legacy id3×12=72). Exe FUN_0041ed50
    per-enemy death switch (all.c 14324-14370) BRANCHES ON `0x2e10` = **itemDrop**
    (ECL var 10070, NOT a death-script — this corrects the earlier note):
    itemDrop==−1 (random; 160 of 208 st1 deaths) → 1-in-3 GLOBAL-counter id4×6 +
    id0×1 + id4×4 = 16 ⅔ / 40 ⅓; itemDrop≥0 (specific; 47) → id4×3 + id0×1 + id4×4
    = **28** (= iter-4's "28", which was right for these); itemDrop==−2 (none; 1) →
    16. id0=0, id4=4 draws; items NOT rand-scattered (`FUN_00430970` mode-2
    unreachable from death). Fire is exact already: op67 aimMode-3 deterministic
    (0 draws); op74 draws u32InRange ONCE at arm (2), autofire re-arm to 0.
    ⚠ EXHAUSTIVELY TESTED (this session, all WITH the restructure): every death
    model — 16, 28, the correct itemDrop-branched one — gives kill-match ~102, ALL
    worse than the legacy id3×12's 131. Death draws can't be fixed in isolation:
    the item→power→DPS→kill-timing ripple means the UPSTREAM stream must be exact
    first. Do not re-attempt the death model without the full-exact stream.
  - **id5 impact spark**: exe spawns it in the player-shot-vs-enemy collision
    `FUN_0043a980` (all.c:14176) — one id5/id3 (both 4 draws) per bullet's first
    enemy hit + every 4th hit (global `&3` counter, id3 if slot<96 else id5). Our
    first-hit spark (stage-scene 2067) matches per-bullet; laser/missile cadences
    (%8, %6) are Sakuya-irrelevant.
  - **Collision/order restructure LANDED.** `FUN_0043a980` runs inside the enemy
    manager, per enemy in slot order: fire → player-shot/attack collision with
    immediate damage (id5) → death (id0/id4). Commit 0be941c moved the port to
    that enemy-outer, same-frame-death shape; the current worktree also uses
    sparse fixed-slot allocation/ascending iteration for enemies, player shots,
    attack slots, bullets, and effects. Freshly fired player shots skip their
    spawn-frame move (3a1d0bf), matching the native player-subsystem order.
    These deterministic changes produced durable alignment gains. Do not undo
    them because an aggregate kill or death metric temporarily looks worse.
    The remaining Stage 4/5 first divergences are now isolated much later
    and mostly involve individual id5/id8 event differences; trace the exact
    native fixed slot/caller at those frames before changing any draw model.
  - ★ THE PRODUCTIVE LEVER = PRINCIPLED DETERMINISTIC ORDERING FIXES (not RNG-draw
    tweaks). Two landed this session: 0be941c (same-frame death) and 3a1d0bf
    (freshly-fired bullets skip their spawn-frame move — exe fires AFTER
    integrating existing bullets, both before the enemy-mgr collision, so a new
    bullet is at spawn pos when first collided). The latter moved st1 first
    kill-divergence 622→718 and first-death 1786→1946. To find more: the exe
    sequences per-frame subsystems via priority-ordered manager lists
    (FUN_0042e290 registers, FUN_0042e800 runs `&DAT_012f41f0`; enemy mgr
    FUN_0041ed50 = priority 10) — trace that full order and match ours
    (updatePlayerBullets→updateEnemies→updateBullets→updateLasers→
    checkPlayerCollision→updateItems). Player MOVEMENT order is NOT an issue
    (recorded input applies once to the same end position).
  - CAUTION: the ghost full-stage budget (163,385) is CONFOUNDED — a post-boss
    dialogue freezes our sim ~3400f, starving snow the exe also freezes. Judge
    pre-1800 by the non-ghost first-death frame, not the aggregate. Decompose
    pre-1800 draws with a spawnEffectParticles hook (see tmp/nonsnow-1800.mjs
    pattern): @1800 = snow 33704 (faithful) + death 1640 + id5 + gameplay 140.
  - **Current scope:** the shared manager-order/fixed-slot work is implemented,
    not pending. Continue from the native PRE boundaries in the checkpoint
    table above. Stage 1 has exact full-stage RNG residue but still-wrong kill
    and score streams; Stage 2/3/6 are exact only through their captured PRE
    windows; Stage 4/5 split on a small number of fixed-slot effect/collision
    events. The next work is focused native event/slot tracing at those
    boundaries and tail capture, not another wholesale collision rewrite and
    not an RNG-budget adjustment.

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
