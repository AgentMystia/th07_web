# Fable 5 implementation handoff (2026-07-10)

This is the only coordination document that should be read before the
remaining technical reverse-engineering notes. It describes the working tree
that was committed after the July 10 fidelity pass. Historical plans, logs,
duplicate audits, and the old handoff were removed because they described
superseded behavior.

## 1. Scope and authority

The user wants original-grade TH07 Stage 1-6 behavior and presentation. They
explicitly waived a full manual six-stage clear for this handoff. Fable 5
should perform a focused QA audit after implementing the remaining items.

Authority remains:

1. `AGENTS.md` and the current user request.
2. Original files under `reference/th07-original/` and `reference/Th07.exe`
   v1.00b.
3. `reference/re-specs/tools/all.c` and the retained `exe-*` / `spec-*`
   reverse-engineering notes.
4. Existing browser implementation.

Do not commit or serve anything under `reference/`. Do not commit the
user-supplied PNG screenshots in the repository root.

## 2. Implemented in this commit

### Boss BGM routing (confirmed)

Files: `src/game/bgm.ts`, `src/main.ts`, `src/game/stage-scene.ts`,
`tests/th07-bgm.test.mjs`, `scripts/dev-shot.mjs`.

MSG opcode 7 is a stage-local slot, not a global track number. Slot 0 selects
the stage theme and slot 1 selects the boss theme. The mapping is stages 1-6
`2n / 2n+1`, Extra `16/17`, Phantasm `18/19`. This was checked against all raw
MSG files and `FUN_00428392`, case 7 at `0x4288ae`. Browser probes selected
`th07_03/05/07/09/11/13` for Stage 1-6 bosses.

### Supernatural Border and Cherry (confirmed)

Files: `src/game/cherry.ts`, `src/game/stage-scene.ts`, `src/core/loop.ts`,
`src/main.ts`, `tests/th07-cherry.test.mjs`,
`scripts/border-probe.mjs`.

Implemented behavior:

- Border requests at 50,000 Cherry+ and defers while player state blocks it.
- A hit or bomb breaks the Border without losing a life/bomb, grants 40
  invulnerability frames, starts the executable's fixed-center cancel wave,
  and invalidates spell capture.
- The wave starts at radius 32, expands by 16 per update for 50 updates,
  ignores bullets carrying flag `0x1000`, and converts swept bullets to
  auto-collecting power items. The direct collision source is removed without
  an item. Lasers and enemies are not part of this wave.
- Bombing during Border is the free Border-break branch. It collects existing
  items but does not start a character bomb.
- Natural expiry gives 40 invulnerability frames, `cherryMax += 10000`,
  `cherry += 10000`, then awards the post-add Cherry value as score.
- Natural expiry displays the executable format `Border Bonus %7d`.
- Border time pauses during dialogue.
- Death Cherry loss uses the selected SHT header float: Reimu/Marisa 0.5,
  Sakuya 0.330000013, with the original character-specific loss cap.

Last probe result:

```json
{"hit":{"lives":8,"invuln":40,"remainingFixtureIds":[784]},"bomb":{"bombsBefore":3,"bombsAfter":3,"invuln":39},"natural":{"scoreDelta":60000,"cherry":60000,"cherryMax":310000,"invuln":40,"message":{"type":4,"value":600000,"timer":180}}}
```

### ECL fidelity (confirmed)

Files: `src/game/eclvm.ts`, `src/game/types.ts`,
`tests/th07-ecl-fidelity.test.mjs`, `tests/th07-op45.test.mjs`,
`tests/th07-op145.test.mjs`, `tests/th07-effects-core.test.mjs`.

Implemented behavior:

- Opcode 45 is a per-ECL-context wait. ECL time waits while movement continues;
  CALL and death callbacks preserve/reset the correct context state.
- Opcode 145 sends an interrupt-table index, resolved through opcode 108's
  32-entry table. Unset entries default to sub 0. This fixes Stage 4 sister
  control semantics.
- Opcodes 10/11 use integer/float random-sign behavior.
- Movement interpolation advances on its first tick, opcode 54 uses
  speed-times-duration with mirrored X delta, and opcode 59 uses the shared
  bounded movement timer while preserving final velocity.
- Death modes 0-3 now follow executable lifecycle/scoring/callback rules.
- Enemy updates run ECL before movement.
- Enemy bullets and lasers have stable executable-style pool slots (1024 and
  64) and bullets carry the shared effect state corresponding to `+0xc08`.
- Effect 0 permanently suppresses local movement while copying the tracked
  actor.
- Effects 7/8 implement the exact laser rectangle, pool-slot selection,
  difficulty-dependent reflection, shared-state, and RNG rules.
- Effects 16/17/18 implement Stage 6 seed fan emission, child spawn with
  variables visible before the child's t=0 ECL, seed deletion, and seed count.

### STD VM and cameras (confirmed)

Files: `src/formats/std.ts`, `src/game/stage-scene.ts`,
`src/game/types.ts`, `tests/th07-std-advanced.test.mjs`.

Implemented behavior:

- Runtime script cursor with opcodes 3 pause, 4 jump, and 31 label.
- ECL opcode 125 resumes the requested STD label.
- Background ANM uses an independent monotonic clock and continues across
  STD pause/jump.
- Camera position (14-18), facing (19-23), and up-vector (24-28) Hermite
  interpolation.
- Opcodes 29/30 drive the primary/secondary special background ANM VMs.
- Authored up vectors feed the camera basis.
- STD easing is its own table: modes 1/2/3 are OUT and 4/5/6 are IN.
- Stage 4 boss nameplate rows use the stage/dialogue row mapping.

### Arcade transition and test observability

Files: `src/main.ts`, `scripts/arcade-transition-probe.mjs`,
`scripts/dev-shot.mjs`.

`?test=1&arcade=1` runs the real arcade transition without menu automation.
The snapshot now reports stage, carry, BGM, STD, and detailed enemy state.
A Stage 1 to Stage 2 probe preserved score, lives, bombs, power, graze, point
items, Cherry, Cherry max/plus, and captured spell count.

## 3. Verification at handoff

The following passed on the final working tree:

```text
npm run check                         PASS
npm run build                         PASS
npm test                              PASS (52/52)
node scripts/border-probe.mjs         PASS
Stage 6 Lunatic frame-800 smoke       5 enemies, 90 bullets, no PAGE ERRORS
```

The prior browser BGM probe covered all six boss tracks. The prior arcade
probe reached Stage 2 and preserved all carry fields. Border break/natural
screenshots were visually inspected; the natural bonus text was visible.
No full Stage 1-6 manual clear was run, per the user's final instruction.

The final Stage 6 smoke screenshot was also visually inspected. Gameplay and
the stage background rendered, but the sidebar Power row still shows a large
yellow rectangle with `MAX` mispositioned over it. Treat this as an explicit
visual QA blocker; do not infer visual correctness from the green tests.

## 4. Highest-priority unfinished work

### A. Player Shot behavior and visuals

Status: reverse-engineered, not implemented in this commit.

Decisive findings from `Th07.exe` v1.00b, all 12 SHT files, and player ANMs:

- SHT `sprite` is a global ANM script ID. Every player bullet needs an
  `AnmRunner`; collision switches to script `sprite + 0x20`, and the bullet
  dies when that script ends. Current static rectangles plus invented fade
  are wrong.
- Reimu A types 1/2 share one target cache per frame, choose the eligible
  enemy minimizing horizontal distance to the player, and home for ages
  0-39 using a vector pull of `speed/4`. Type 1 max/accel is `10, 1/3`;
  type 2 is `18, 0.6`.
- Marisa A type 3 applies `vy -= random[0,0.1) + 0.27` every live frame.
  On collision it expands hitboxes by script, enters a random upward
  explosion velocity, damages again on even ages at one-third damage, slows
  by 0.88, and emits effect 5 every six frames.
- Sakuya A focused type 4 snap-aims while preserving spread and multiplies
  speed by 1.5 only with a valid target.
- Sakuya B type 5 banks the whole fan with the option orbit angle.
- Marisa B types 4/5 are persistent option/player lasers, not flying bullets.
  Type 4 uses settled-unfocused option positions and release/fade lifetime;
  type 5 keeps up to 16 beam-history samples, draws alpha history, and creates
  helper collisions. Both pierce and deal table damage on even ages.
- Types 0/1/2 divide velocity by 8 on collision; type 3 does not. Types 4/5
  never switch to impact ANM.
- Fire SFX 0 is requested only when a shooter record with `sfxId >= 0`
  actually spawns.

Implement in this order: per-shot ANM lifecycle, Marisa B beams, Marisa A
repeated explosion collision, then validate all six loadouts at power
8/64/128 focused and unfocused. Retained sources:
`exe-player-shot.md`, `exe-player-funcs1.md`.

### B. Player Bomb behavior and visuals

Status: reverse-engineered at high confidence, not implemented here.

The current single player-centered 128px damage box is structurally wrong.
The executable creates moving attack slots consumed by `FUN_0043a980` at
`0x43a980`. Focus is latched at cast time. All forms use the shared 60-frame
screen tint from `FUN_00407520` and shared activation presentation from
`FUN_00407620`; both are missing.

| Form | duration / invuln / speed | confirmed core |
|---|---:|---|
| Reimu A unfocused | 140 / 200 / 1.0 | scripts 133-136; moving r48/d8, detonation r256/d400, aftermath d2 |
| Reimu A focused | 300 / 360 / 0.6 | homing orbs; detonate after hit tally 99 or final 30 frames |
| Reimu B unfocused | 140 / 200 / 1.0 | scripts 137-140; four dynamic attack slots, d16 alternating frames |
| Reimu B focused | 190 / 250 / 0.4 | scripts 141-143 at cast position; r256/d18 each active frame |
| Marisa A unfocused | 200 / 250 / 1.0 | scripts 5-7; eight radial stars; r128/d8 two of three frames |
| Marisa A focused | 260 / 310 / 0.4 | scripts 5-7; up to 24 trail stars; r128/d12 until hit tally 80 |
| Marisa B unfocused | 300 / 300 / 0.2 | scripts 12-14; three beams, 18 simultaneous r128/d10 slots |
| Marisa B focused | 340 / 390 / 0.2 | scripts 8-11; vertical region, d23 three of four frames |
| Sakuya A unfocused | 160 / 210 / 1.0 | scripts 5/6; up to 96 knives; r24/d10 until tally 30 |
| Sakuya A focused | 250 / 290 / 0.3 | scripts 7/8; staged turn/re-aim; r24/d22 until first hit |
| Sakuya B unfocused | 160 / 260 / 2.0 | scripts 9-12; near-full-playfield rectangle d3 every fourth frame |
| Sakuya B focused | 300 / 420 / 1.5 | scripts 13/14; player-following trails; leading r160/d1 every frame |

Retained source: `exe-bombs.md`. `FUN_00425f10` used by Sakuya B still needs
a correct gameplay name before implementing that pool rewrite.

### C. Floating score/Cherry numbers

Status: partially reverse-engineered, not implemented.

The user's example is the original floating-number entity, not HUD text.
`FUN_00402260` creates entries in the large popup pool; `FUN_00402310` uses a
three-entry variant. Digits are stored reversed, drawn most-significant first
at 8px pitch, centered by `digitCount * 4`, and colored per event. Point-item
popups use the pre-`/10` value and are yellow above the collection line,
otherwise white. Cherry gains use red (`0xffff4040`). Phase-end bullet/helper
sweeps create escalating popups: 2000 +20 per bullet and 2000 +30 per helper,
both capped at 8000. Decode the popup timer update, vertical motion, alpha,
and exact glyph selection before implementing. Do not invent a graze popup
unless an executable call site proves one exists.

### D. Global slow motion

Status: current implementation is known wrong.

Effects 10/11 control global `DAT_0056baa8`, not only bullet velocity.
Effect 10 stores `1/rawParam`, rescales live bullet vectors but not nominal
speed, swaps bullet ANMs `0x260..0x26f`, and interrupts two effect VMs.
Effect 11 restores vectors/ANMs and the global rate. The global rate advances
STD, ANM, ECL, player, enemies, lasers, items, bombs, and timers while
collision still runs every wall-clock frame. Preserve callback ordering:
STD, player, enemy, then bullet/laser. A frame-skipping implementation is not
equivalent.

### E. Remaining late-stage effects and presentation

Still unimplemented: effect IDs 1/2/4/6/9/12-15/19/21-23. Effect 19 is a
three-second BGM fade, not screen shake. ECL op149 freezes spell presentation
origin (it is not an enemy laser); op150 writes enemy ANM VM rotation. Bullet
rendering still needs the etama multi-entry type-to-entry mapping. Several
spell declaration visuals, phase-end popup rendering, and HUD placements are
flagged approximations in `AGENTS.md`.

The most obvious current HUD defect is the Power/MAX row described in §3.
Recover its exact front/anime glyph path before changing coordinates; previous
HUD fixes repeatedly failed because they mixed centered entity anchors with
top-left layout anchors.

## 5. Recommended Fable 5 execution order

1. Audit this commit against the retained reverse specs and re-run all 52
   tests plus Border/BGM browser probes.
2. Implement floating numbers; this is bounded and visibly requested.
3. Implement per-shot ANM lifecycle, then Marisa B and Marisa A special shot
   collision behavior.
4. Replace the generic bomb box with the twelve focus-latched bomb forms and
   shared presentation layer.
5. Implement global slow motion before validating Stage 5/6 timing.
6. Reverse and implement only the remaining effect IDs actually used by
   Stage 1-6, then perform focused Stage 1-6 QA snapshots/pixel reports.

Keep every implementation evidence-backed. Anything not confirmed by the exe
or original data stays explicitly marked as an approximation.
