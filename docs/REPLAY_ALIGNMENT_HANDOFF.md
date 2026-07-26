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

**Wine works in this container and the game runs, renders and takes input. The
native trace is nevertheless blocked — on the BINARY, not the tooling.** Read the
"wrong build" subsection before spending any time here; everything else in this
section is a solved, reusable recipe.

### The blocker: `reference/Th07.exe` is v1.00, the replays are v1.00b

Every one of the six replays — the five local-evidence files AND the committed
fixture `tests/replays/th7_udFe25.rpy` — records the recording executable's
fingerprint in its decompressed image:

| field | offset in image | value in all six replays |
|---|---|---|
| build tag (ASCII, 5 chars + NUL) | `+0xE0` | `"0100b"` |
| exe size | `+0xD8` | `650752` |
| exe checksum | `+0xDC` | `0xAEC5445C` |

The binary extracted from the download this session self-identifies as **v1.00**,
not v1.00b:

- build tag at `.rdata` VMA `0x48D230` is `"0100_"` (raw `30 31 30 30 5f 00`)
- the only window/title version string in the whole file is `… ver 1.00` (no `b`)
- file size 607744, `SizeOfCode` 530432 — neither is the recorded 650752
- sha256 `1251458d0564c565610b28bc94a434f5d4e8aee5d0882fa278b19277c7ac4cf7`

`FUN_004402d0` (the replay loader) ends with two gates past the checksum:
`if (image[0x95] != 0) reject;` then `FUN_00437ab4(this=0x56b930, image+0xE0,
image[0xD8], image[0xDC])`, nonzero = reject. Our files pass magic (`T7RP`),
the version word (`0x1100` at `+0x4`), the additive checksum
(`0x3F000318 + Σ bytes[0x0D,EOF)` == `u32 @+0x08`, verified byte-exact in Python)
and `image[0x95] == 0` — and then die on the build-fingerprint gate. The gate is
live, not compiled out: reading the running process shows `[0x56bbfc]`
(`this+0x2CC`) `= 36445856`, and `FUN_00437ab4` returns 0 (accept) only when that
field is zero.

Symptom to recognise: the Replay screen comes up with its title and the
`No. Name Date Player Rank` header and **zero rows**. That is not a rendering
problem and not a path problem. `FUN_00452660` builds the list by loading each
candidate and keeping only those `FUN_004402d0` accepts (`[ebp-0x18]` is the kept
count); a rejected file contributes no row at all. The
`No.%.2d -------- --/--  -------          0` placeholder belongs to the OTHER
branch of the shared row widget (`[ebx+8] == 0xe`), so its absence is expected
here and is not evidence about your file.

**What is needed: a Th07.exe of exactly 650752 bytes whose build tag is `"0100b"`.**
That is a precise acquisition target — check size first, it is a one-command
screen.

**Do not patch the gate out.** A v1.00 trace would measure a build that is neither
the one that produced the replays nor the one the port targets, so every number it
yields would be unattributable — strictly worse than no trace. (The layout is
close: `FUN_0043a820`, `FUN_0043a290`, `FUN_0044aa20`, `FUN_004402d0`,
`FUN_0043e890`, `FUN_0043eb00` are all exact `push ebp; mov ebp,esp` prologues in
this v1.00 binary, so decompile addresses cited across this repo do resolve here
and static reads against it stay usable. "Close" is not "identical", and only
static work gets that latitude.)

Worth holding as a live hypothesis for the residual drift: if the reference
decompile is v1.00 while every replay was recorded on v1.00b, then anything ZUN
changed between the two builds presents exactly as the observed signature —
thousands of frame-exact events, then a lone shifted event that no constant or
arithmetic audit explains. It cannot be the whole story (Lunatic 6/6, Extra,
Easy st1-3 and Normal st1 are exact, which a materially different engine would not
allow), but it is unfalsifiable from v1.00 alone and it is where a v1.00b binary
would pay off twice.

### Environment recipe (all of this is verified working, 2026-07-26, Ubuntu noble)

```sh
# 7z, to unpack a game archive (pip is blocked by the tooling classifier; apt is not)
apt-get install -y p7zip-full

# 32-bit Wine. Order matters: wine32:i386 pulls libgphoto2-6t64:i386, whose
# libgd3:i386 dependency apt refuses to auto-resolve, so install that FIRST.
dpkg --add-architecture i386 && apt-get update
apt-get install -y --no-install-recommends libgd3:i386
apt-get install -y --no-install-recommends wine32:i386
# NB installing wine32:i386 REMOVES the amd64 wine package, so /usr/bin/wine
# disappears. The loader you want afterwards is /usr/lib/wine/wine.
/usr/lib/wine/wine --version          # -> wine-9.0

# THE ONE THAT COSTS A SESSION IF MISSED: the game is 32-bit, so wined3d needs the
# i386 GL stack. The amd64 packages do NOT satisfy it, and Xvfb alone has no GL.
apt-get install -y libgl1-mesa-dri libglx-mesa0            # + llvmpipe for Xvfb
apt-get install -y libgl1:i386 libglx-mesa0:i386 libgl1-mesa-dri:i386
apt-get install -y xdotool x11-apps x11-utils              # keys, xwd, xprop

Xvfb :99 -screen 0 640x480x24 &                            # 640x480 = PCB's mode
export DISPLAY=:99 WINEPREFIX=/tmp/wine-th07 WINEDEBUG=-all
/usr/lib/wine/wine wineboot -i
cd <dir with Th07.exe + Th07.dat> && /usr/lib/wine/wine Th07.exe &
```

Without the i386 GL packages `Direct3DCreate8` returns NULL, the game puts up a
Shift-JIS message box titled `log` (`Direct3D オブジェクトは何故か作成出来なかった`)
and sits at **0.0% CPU forever**. Zero accumulated CPU time on the Th07.exe task is
the fastest way to tell "never started" from "running but not responding to keys" —
check it before anything else. With GL present the title screen runs at a steady
60.00 fps under llvmpipe.

### Reading native state: use `/proc/<pid>/mem`, not winedbg

Wine maps the PE at its preferred base, so the Linux process image is the Windows
address space: `pread(/proc/<pid>/mem, 4, 0x400000)` returns `MZ`. A ~30-line
Python `os.pread` helper reads any global instantly, needs no debugger, no attach,
and does not slow the game down — strictly better than the winedbg route this
document previously recommended, which only ever managed the same reads more
slowly. Snapshotting `0x492000..0x700000` (2.5 MB, the whole data region) takes
well under a second, which makes classic value-scanning practical: snapshot,
inject input, snapshot, and intersect on the expected values to locate an unknown
variable.

Find the pid by **`comm`**, never by cmdline: `[ -f /proc/$p/comm ] &&
[ "$(cat /proc/$p/comm)" = Th07.exe ]`. A cmdline match self-matches the helper
shell whose command line contains the string — `pkill -f Th07.exe` kills your own
tool call (observed: exit 144 mid-script).

`0x62583c` is NOT confirmed to be the stage variable. It read `4` while the game
was demonstrably still on the title screen and did not track the menu cursor; the
earlier identification in this document was never validated against a running
game. Re-derive it by value-scan before relying on it.

### Driving the menus

- **No window manager runs, so X focus is `PointerRoot`** (`xdotool getwindowfocus`
  errors with `BadWindow` on `0x1`). Move the pointer over the game window and set
  focus explicitly: `xdotool mousemove 320 240; xdotool windowfocus $(xdotool search
  --name 'Perfect Cherry Blossom' | head -1)`.
- **`xdotool key` does not work — the press must be HELD.** `xdotool key` presses and
  releases in ~12 ms, which falls entirely between two 60 fps DirectInput polls, so
  the game never sees it. This looks exactly like "keys are not reaching the app"
  and sent the previous attempt down a blind alley. Use:
  `xdotool keydown Down; sleep 0.10; xdotool keyup Down; sleep 0.18`.
- **Locked menu entries are SKIPPED by the cursor.** With no `score.dat`, Extra Start
  and Practice Start are dimmed and stepped over, so **Replay is 2 Downs from Start,
  not 3**. Verify visually rather than counting — see below.
- Screenshots: `xwd -root -silent > s.xwd`, then convert with a ~30-line pure-Python
  xwd→PNG writer (big-endian header, `ZPixmap`, pixel data at
  `header_size + ncolors*12`, BGRX rows of `bytes_per_line`). No ImageMagick, ffmpeg
  or PIL is installed and none is needed. Reading the cropped menu region is by far
  the cheapest way to confirm cursor position.
- The Replay list is built from BOTH the numbered slots `./replay/th7_01.rpy` …
  `th7_15.rpy` (loop 1) and a `FindFirstFile` glob of `th7_ud????.rpy` (loop 2), so
  third-party filenames like `th7_udMt01.rpy` DO get enumerated. The earlier claim in
  this document that PCB "only lists replays in its numbered slots", and the
  workaround of copying to `replay/th7_01.rpy`, were both wrong — harmless, but do
  not repeat them.

Once a v1.00b binary exists, the PRE-trace procedure further down this document is
executable here rather than deferred, which is what the remaining cells need — see
the upstream-drift family, whose members are provably NOT closable from event
streams.

Until a trace is actually acquired, the replay's own AUX event streams remain the
working oracle: dense, frame-exact, and free. Their limit is coverage, not
accuracy — an RNG or position divergence that produces no AUX event stays
invisible until it changes one, so read a clean prefix as "no observed event
differs", not as "state is identical".

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
  **Hard st4 @2360 is NOT pool starvation** — do not spend time there. Measured
  across 2335-2365: the pool peaks at 82/96 and the whole stage drops only 4
  spawns, so nothing is being starved. It is spent-dominated (70-80 post-impact
  slots, `fired` falling to 0-2) simply because almost every needle reaches the
  boss immediately and then holds its slot for its impact script's 20 ticks,
  which is the correct post-fix behavior. The oracle kills at 2360 and takes a
  contact at 2362 (dying at 2375, i.e. 13 frames into ReimuB's 15-frame deathbomb
  window); we kill at 2362 and never take that contact at all. So what is left is
  a 2-frame damage-cadence question with the settlement well under the 70 cap —
  look at arrival cadence and the per-frame settlement, not at the pool.
- **Easy/Normal collect bursts.** The framing that these are all item-pipeline
  bugs is now known to be wrong for at least the post-respawn half: Normal st5
  looked exactly like a ±1-frame auto-collect bug and was really the respawn
  control lock, and the fix needed nothing in `updateItems` (its predicted
  player track reproduced all three oracle collects AND the three non-events
  immediately before them). Sort each remaining cell by the miss table above
  before assuming anything.
  Still open in this family: **Normal st6 @2727 — read the stream by INDEX, not
  by frame.** Index-aligned, the oracle runs `… 2727, 2730, 2765 …` and we run
  `… 2730, 2765, 3140 …`, so our 2730 and 2765 land on the oracle's own frame
  values and what we actually lack is one collect EVENT at 2727. This is not
  "our collects are three frames late" — that reading is wrong and was corrected
  after measuring the index alignment.
  The window belongs to the six death drops from the 2507 miss (bigPower + 5×
  power, slots 839-844, all past their 60-frame tween and falling at terminal
  vy=3). The oracle collects two of them across 2727-2730; we collect exactly one
  (slot 841 at 2730, x 328.095, when |Δy| finally reaches 21.95 against the 22 px
  half-extent). Our other five never come close — at 2727 the player is at
  (321.85, 381.00) while slot 840 sits at x 285.78 (|Δx| 36) and slots 839/842/843
  are 200-250 px away — and they fall off the bottom uncollected past y≥464.
  So one drop's TWEEN TARGET differs enough that the original collected it and we
  never do. Targets come from consecutive `rng.f()` pairs in `spawnDeathDrop`
  (`x = rand*288+48`, `y = rand*192-64`), so the targets are a pure function of
  the RNG position when the drops spawn.
  **A draw-accounting error at the death frame was tested and is NOT supported.**
  Adding k raw draws per drop (k = 0..10, i.e. per-drop stride 4..14 raw, probing
  the idea that the exe spends draws per drop that we do not) produced a collect
  at 2727 only at k=3 and k=10 — and both immediately broke at 2730 instead —
  while k=9 broke *earlier*, at 2703. Two isolated hits scattered across eleven
  values, neither carrying further, is what re-rolling twelve random targets looks
  like by chance, not a real offset. Do not read either k as a lead.
  What that leaves is the harder possibility: the RNG position at the drops is
  wrong because of drift accumulated somewhere upstream in the preceding ~2500
  frames, which stayed invisible precisely because it produced no AUX event until
  it moved an item target. That is the same shape as Easy st4, and like Easy st4 it
  needs a position/RNG-level native trace rather than more event-stream bisection.
  (Worth ruling out cheaply first, though: whether the exe spawns anything else at
  the miss commit that we omit, since the hit frame already spends 16 raw draws on
  RerollRng plus 4 on RegenerateGameIntegrityCsum plus two effect bursts, and all
  of those sit upstream of the six target pairs.)
  Measured and refuted here: completing the lerp at elapsed 60 so an item lands
  on its exact target (instead of stopping at t=59/60) does not move the cell.
  Note tween items are ONLY death drops, so anything changed in that branch is
  unreachable for every currently-passing replay.
  Also still open: **Easy st5 @7290** (measured insensitive to the lock length — its
  first collect mismatch stays at index 191 and ~38 frames late for locks of 60,
  57 and 36, so it is an independent defect and not respawn timing at all), and
  **Easy st6 @1628**, which is a *contact*
  mismatch — a bullet reaching the player at the wrong frame, not an item
  problem. First measurements (2026-07-26): the oracle registers a contact at
  1628; ours does not arrive until 1710, 82 frames later. Through that whole
  window the player is motionless at (171.51, 56.00) — up at the top of the
  field in the auto-collect zone — with `hitboxHalf` 1.1, no invuln and no
  border, while the live enemy-bullet count keeps climbing (126 → 148). Our
  closest bullet at 1628 is 5.54 px away on the binding axis, so nothing is
  marginal: whatever touched the original is somewhere else entirely in our run.
  The most suspicious object in the window is bullet slot 197, which approaches
  the player at speed 1.4316 on angle −3.0091 and then has its speed drop to
  **exactly 0** at frame 1629, freezing at (177.05, 54.04) permanently. Check its
  bullet-EX deceleration ramp (`exAccel`/`exAccelElapsed`, and the
  one-promotion-per-tick rule in FUN_004229f0) before anything else — a ramp that
  clamps to zero when native's keeps it moving would both explain the frozen
  bullet and put a real bullet near the player at 1628.
  A dialogue freeze was suspected and is REFUTED: no MSG runner is active
  anywhere in 1600-1720 (`dialogue.idx` null every frame), and the player is
  motionless simply because the recorded input word is 1 (shoot, no direction)
  from 1620 to 1709 — the position track is exactly input-determined. What the
  window really is: a dense pattern where the live bullet count climbs 125 → 342
  while the player holds still, so any small upstream position error decides
  whether a contact lands. Treat this cell as a member of the upstream-drift
  family below rather than as a hitbox or scheduling bug.

### The upstream-drift family (three cells, and why events cannot close them)

Easy st4, Easy st6 and Normal st6 have all now been measured to the same
conclusion: the divergence is the first *observable* symptom of a position or RNG
error that accumulated earlier and produced no AUX event until it moved one. The
evidence differs in each case and is independent:

- Easy st4 — an offline pursuit simulator reproduces all 181 engine collect frames
  exactly, and matching the oracle demands mixed-direction offsets (two items
  farther, one closer), so no uniform engine change can produce it; the spawn
  positions themselves differ.
- Normal st6 — the drops' tween targets are a pure function of RNG position, and a
  per-drop stride probe across k=0..10 yielded only scattered chance hits.
- Easy st6 — nothing is marginal (nearest bullet 5.54 px against a 1.1 px player
  half-box) amid 137+ live bullets.

This is the limit of the event-stream oracle, exactly as the top of this document
warns. Closing these needs per-frame native state — the Wine/winedbg PRE trace
procedure below — not further bisection of kill/collect frames. A static read of
`Th07.exe` alone will not do it either: these are accumulated-state questions, not
constant-verification questions.
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
- **Boss-spell kills are dominated by divisor truncation — read any spell-kill
  divergence in RAW damage, not HP.** `settlePendingDamage` applies the spell
  divisor once per enemy per frame as `dmg >= 8 ? trunc(dmg/7) : dmg > 0 ? 1 : 0`,
  so the fractional part is discarded every settlement. Measured on the Hard st1
  midboss spell (enemy slot 2, hp 203, 58 settlements over frames 5153-5460):
  raw damage sums to **1629** while only **207** lands — 87% discarded — with
  **zero** settlements hitting the 70 cap and a median raw of 24
  (`trunc(24/7) = 3`, losing 0.43 per settle). We also damage on only 58 of the
  spell's 307 frames, with six gaps longer than 4 frames and one of 118.
  Two consequences worth carrying:
  - A spell-kill that lands N frames late is a *small* raw-damage deficit
    amplified by the divisor, so hunt for a missing or late-arriving shot, not for
    a damage-formula error. Concretely, **Phantasm's "~2 HP excess" is about 14
    raw damage — roughly ONE extra shot arriving somewhere across the spell.**
  - Truncation makes arrival *distribution* matter, not just totals: several small
    settlements lose far more than one large one (4 separate hits of 12 give
    4×trunc(12/7)=4, the same four clumped into one frame give trunc(48/7)=6).
    Any change to shot cadence or pool lifetime therefore moves spell kills much
    more than its effect on total damage suggests.
- **Phantasm (st7 @ 51989).** Exact for 51989 of 57876 frames — 565 kills,
  2739 collects, 23 contacts, 7 bombs and every border event. Boss sub 127's
  HP reaches 0 two frames early, i.e. ~2 HP of accumulated excess over a long
  spellcard, not a rate error. Restate it in raw terms per the divisor entry
  above: 2 HP through `/7` is about **14 raw damage — roughly one extra shot
  landing** somewhere across the spell. That is the target to hunt.
  **`steerHomingBullet`'s float64 residues are REFUTED as the cause** (measured
  2026-07-26) — they were the standing prime suspect and they are not it. All
  three stagings leave the divergence at *exactly* 51989: `fround`ing the
  unrounded `dist`, comparing `>= maxSpeed` against the f32 `mag` instead of the
  float64 `magExact`, and both together. Note such experiments are risk-free for
  the converged rows, since shotTypes 1/2 are ReimuA-only — the fixture is sakuyaA
  and Extra is marisaB, so neither can be moved by editing that function.
  The kill mechanics are now fully measured, and they rule the AABB out too. Boss
  is enemy slot 1, sub 69 running spell sub 127; its hp falls
  36→26→25→17→13→12→11→10 and then to 0 at f51989. That final settlement is three
  shots — 30 + 30 + 28 = **88 raw**, which the 70 cap turns into exactly
  `trunc(70/7) = 10`, precisely killing a 10-hp boss. With one fewer shot (60 raw
  → 8 settled) it survives at 2 hp and dies later, which is the whole divergence.
  But **none of the three is marginal**: measured one frame earlier they are all
  ~0.7-2.4 px outside on Y while travelling at vy ≈ −12, so on the hit frame they
  are ~10 px inside the box. No rounding at the collision edge can remove one.
  Therefore the 2 hp was accumulated EARLIER in the spell, and the search is for
  two extra hp of settled damage, not for one mis-timed shot at the kill.
  That is a weaker signal than it sounds, because of the divisor's floor: for
  `raw < 8` the settlement is exactly 1, so **a single tiny hit is worth a whole
  hp** regardless of its raw value (our curve has several such 1-hp steps at
  f51981/51986/51987/51988, each from one 5-damage shot). Two extra small hits
  anywhere across the spell are enough to explain the entire cell. That makes this
  a member of the upstream-drift family in practice: it needs per-frame native
  state, not another local hypothesis. The RNG-residue oracle does not exist
  for single-stage replays (it needs a following stage's seed), so the damage trace
  is the only quantitative handle. The two extra player contacts (56038, 56993) and
  the death at 57037 are downstream of this; re-measure rather than treating them
  as separate defects.
- **Non-Lunatic ECL branches — mostly RESOLVED, and the method matters.**
  The old claim that these had "only ever executed under Lunatic" was wrong: a
  converged *stage* validates a branch just as well as a converged replay, and
  Easy st1-3 plus Normal st1 all PASS. Measured coverage (instrument the four
  gated effect sites and count firings per stage, 2026-07-26):

  | gate | fired in | verdict |
  |---|---|---|
  | effect 6, `difficulty < 3` arm | Easy st3, 32× — **stage PASSES** | validated at d0 |
  | effect 6, `>= 3` arm | Lunatic st3, 96× — stage PASSES | validated at d3 |
  | effect 1, `difficulty < 3` arm | Easy st2, 2× — **stage PASSES** | validated at d0 |
  | effect 8 | fired in none of the sampled stages | still unexercised |
  | effects 12/21 | fired in none of the sampled stages | still unexercised |

  So effect 6's `difficulty < 3 ? 4 : 2` with its π/6-vs-π/2 pair is correct as
  written, despite looking non-monotonic. That is confirmed twice over: a sweep of
  six candidate (count, spread) pairs against Normal st3 made every alternative
  worse — `(2, π/6)` → 8306, `(2, π/2)` → 8290, `(4, π/2)` → 7617, against the
  current `(4, π/6)` → 11863. Note such a sweep is free of risk to the converged
  rows: the fixture is d3 and Extra is d4, so both take the `>= 3` arm and cannot
  be moved by editing the `< 3` arm at all.
  Consequence for the open cells: **Normal st3 @11863 is not an ECL-gate problem.**
  Effect 6 is the only gated site that fires at all before that frame, and it is
  now validated. Don't re-chase the gates there.
  Effect 8 and effects 12/21 remain genuinely unexercised — if a divergence ever
  localizes to a window where one of them fires, that is worth pursuing; their
  child counts cost RNG draws, so a wrong count shifts every later draw.

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
