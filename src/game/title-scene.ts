import { Anm, AnmRunner, type AnmFrame, type AnmSprite } from '../formats/anm';
import { SCREEN_W, SCREEN_H, type Renderer } from '../gfx/renderer';
import type { InputFrame, Button } from '../core/input';
import type { GameAssets } from './assets';
import type { AudioBus } from '../audio/audio';
import type { CharacterId } from './player';
import type { Rpy } from '../formats/rpy';

// Title -> difficulty -> character/shot-type menu flow, built entirely from
// the original title01.anm menu script data (see assets.anms.title01) plus
// the title00.jpg / select00.jpg backdrops. Disassembled with thanm -l7
// (reference/th07-original/title01.anm) to recover layout/animation timing;
// see the per-section comments below for which script/sprite ids feed each
// element and which parts are original-behavior approximations.
//
// IMPORTANT DATA QUIRK (worked around here, not in formats/anm.ts's public
// behavior): title01.anm packs 10 independent ANM "entries" (one texture
// each: title02/title01/select01/sl_pl00/sl_pl01/sl_pl02/sl_pltx/sl_text/
// replay00/select02) into one file, and several entries independently reuse
// small/overlapping on-disk script ids (id 0 alone names five different
// scripts across five different entries). Anm's flat scriptRef(id) lookup
// can only ever see whichever entry parsed last for a colliding id, so every
// AnmRunner constructed below passes `entryIndex` (and the matching
// `spriteIndexOffset`, since sprite ids embedded in a script's ins_3 are
// entry-local too) to Anm's new entry-scoped scriptRefInEntry lookup.

const ENTRY = {
  logo: 0, // title02.png (東方妖々夢 Perfect Cherry Blossom logo)
  mainMenu: 1, // title01.png (8 title items + unused option/keyconfig glyphs)
  difficulty: 2, // select01.png (Easy/Normal/Hard/Lunatic/Extra banners)
  reimu: 3, // sl_pl00.png
  marisa: 4, // sl_pl01.png
  sakuya: 5, // sl_pl02.png
  nameplate: 6, // sl_pltx.png (character name + secondary caption)
  header: 7, // sl_text.png ("Choose Level" / "Choose Girl" / "Choose Spell Card")
  replay: 8 // replay00.png (replay-select title and field labels)
} as const;

const PORTRAIT_ENTRY = [ENTRY.reimu, ENTRY.marisa, ENTRY.sakuya] as const;
// On-disk script ids within each character's entry: [portrait, shotA desc, shotB desc].
const PORTRAIT_IDS: readonly [number, number, number][] = [
  [-35, -34, -33], // Reimu
  [-37, -36, -35], // Marisa
  [-39, -38, -37] // Sakuya
];
const NAME_IDS = [-41, -40, -39] as const; // entry6 (sl_pltx), one per character
const FAMILY_NAMES = ['reimu', 'marisa', 'sakuya'] as const;
const DIFFICULTY_IDS = [-28, -27, -26, -25] as const; // entry2 (select01): Easy, Normal, Hard, Lunatic
const DIFFICULTY_NAMES = ['Easy', 'Normal', 'Hard', 'Lunatic'] as const;

// Main-menu items, top to bottom (script on-disk ids 0-7 within entry1,
// screen y 200..396 step 28, all left-aligned at x=432). Confirmed against
// the extracted title01.png atlas: each item's "colored" sprite spells out
// its label in stylized Latin text (Start / ExtraStart / Practice Start /
// Replay / Result / MusicRoom / Option / Quit). Game Start and Extra Start
// are wired in this reimplementation (Replay opens a browser-local .rpy;
// score data and the other persistent submenus do not exist yet); the rest
// are fully navigable and visible like the original,
// but confirming one just plays the cancel buzz.
const MAIN_MENU_ITEMS = [
  { name: 'Game Start', enabled: true },
  { name: 'Extra Start', enabled: true },
  { name: 'Practice Start', enabled: true },
  { name: 'Replay', enabled: true },
  { name: 'Score', enabled: false },
  { name: 'Music Room', enabled: false },
  { name: 'Option', enabled: false },
  { name: 'Quit', enabled: false }
] as const;

const REPEAT_DELAY = 20; // frames held before cursor auto-repeat kicks in
const REPEAT_RATE = 6; // frames between repeats thereafter (approximates the original menus' hold-to-scroll feel; exact values undocumented)

// Tap-based nav with delayed auto-repeat: fires once on the physical keydown
// edge, then not again until the key has been held past REPEAT_DELAY frames,
// after which it re-fires every REPEAT_RATE frames. A fresh instance per
// screen means a direction held across a screen transition needs to clear
// the same delay again rather than instantly repeating on the new screen.
class KeyRepeater {
  private counters = new Map<Button, number>();

  poll(input: InputFrame, button: Button): boolean {
    if (input.pressed.has(button)) {
      this.counters.set(button, 0);
      return true;
    }
    if (input.held.has(button)) {
      const n = (this.counters.get(button) ?? 0) + 1;
      this.counters.set(button, n);
      return n >= REPEAT_DELAY && (n - REPEAT_DELAY) % REPEAT_RATE === 0;
    }
    this.counters.delete(button);
    return false;
  }
}

// Returns a copy of `frame` sampling a different sprite rect (same atlas
// image), keeping position/alpha/anchor/etc. Used to swap in the paired
// "gray" (unfocused) sprite that sits 1 id after each main-menu item's
// colored one in title01.png — present in the data but never referenced by
// any script, so the original executable must swap to it directly; the
// scripts here only ever drive the colored variant.
function withRect(frame: AnmFrame, s: AnmSprite): AnmFrame {
  return { ...frame, x: s.x, y: s.y, w: s.w, h: s.h, imageKey: s.imageKey };
}

// Small triangular cursor marker drawn just left of the focused item's text,
// pulsing gently. Not part of the original ANM data (its actual cursor
// mechanism wasn't recoverable from static script analysis alone, see the
// module comment) but keeps the highlighted item unambiguous at a glance.
function drawCursorArrow(r: Renderer, x: number, y: number, frame: number): void {
  const ctx = r.ctx;
  const bob = Math.sin(frame * 0.2) * 3;
  ctx.save();
  ctx.fillStyle = '#fff6a0';
  ctx.strokeStyle = 'rgba(80, 40, 0, 0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + bob, y - 7);
  ctx.lineTo(x + bob, y + 7);
  ctx.lineTo(x + bob + 11, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// Mirror image of drawCursorArrow, pointing left (used on the right side of
// the character-select carousel).
function drawCursorArrowLeft(r: Renderer, x: number, y: number, frame: number): void {
  const ctx = r.ctx;
  const bob = Math.sin(frame * 0.2) * 3;
  ctx.save();
  ctx.fillStyle = '#fff6a0';
  ctx.strokeStyle = 'rgba(80, 40, 0, 0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - bob, y - 7);
  ctx.lineTo(x - bob, y + 7);
  ctx.lineTo(x - bob - 11, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function hint(r: Renderer, text: string): void {
  // Plain-text control hint (not part of the original menu art, which relies
  // on player familiarity / a manual): a small, low-risk usability affordance
  // in the same spirit as StageScene's HUD text overlays.
  r.text(text, SCREEN_W / 2, SCREEN_H - 22, { size: 12, color: '#cde', align: 'center' });
}

// -- Title screen ------------------------------------------------------------

class TitleMenu {
  cursor = 0;
  private repeat = new KeyRepeater();
  private logo: AnmRunner;
  private items: AnmRunner[];

  constructor(private anm: Anm) {
    this.logo = new AnmRunner(anm, 0, { entryIndex: ENTRY.logo, spriteIndexOffset: anm.entries[ENTRY.logo].spriteIds[0] });
    const base = anm.entries[ENTRY.mainMenu].spriteIds[0];
    this.items = MAIN_MENU_ITEMS.map((_, i) => new AnmRunner(anm, i, { entryIndex: ENTRY.mainMenu, spriteIndexOffset: base }));
  }

  update(input: InputFrame, audio: AudioBus):
    'confirm' | 'confirm-extra' | 'confirm-practice' | 'confirm-replay' | null {
    this.logo.update();
    for (const it of this.items) it.update();
    const n = MAIN_MENU_ITEMS.length;
    if (this.repeat.poll(input, 'down')) {
      this.cursor = (this.cursor + 1) % n;
      audio.sfx('se_select00', 0.141, 12);
    } else if (this.repeat.poll(input, 'up')) {
      this.cursor = (this.cursor - 1 + n) % n;
      audio.sfx('se_select00', 0.141, 12);
    }
    if (input.pressed.has('confirm')) {
      if (MAIN_MENU_ITEMS[this.cursor].enabled) {
        audio.sfx('se_ok00', 0.316, 10);
        return this.cursor === 1
          ? 'confirm-extra'
          : this.cursor === 2
            ? 'confirm-practice'
            : this.cursor === 3
              ? 'confirm-replay'
              : 'confirm';
      }
      audio.sfx('se_cancel00', 0.316, 11);
    }
    return null;
  }

  draw(r: Renderer, frameCounter: number): void {
    r.drawImage('title00', 0, 0);
    r.drawAnmFrame(this.logo.spriteFrame(), 0, 0);
    this.items.forEach((runner, i) => {
      const frame = runner.spriteFrame();
      if (!frame) return;
      const focused = i === this.cursor;
      if (focused) {
        r.drawAnmFrame(frame, 0, 0);
        drawCursorArrow(r, frame.vmX - 14, frame.vmY + frame.h / 2, frameCounter);
      } else {
        // Swap to the paired "gray" sprite: local sprite index (2i+1), one
        // past the colored (2i) sprite the script itself displays.
        const gray = this.anm.sprites.get(this.anm.entries[ENTRY.mainMenu].spriteIds[2 * i + 1]);
        r.drawAnmFrame(gray ? withRect(frame, gray) : frame, 0, 0, gray ? {} : { alpha: 0.5 });
      }
    });
    hint(r, 'Up/Down Move    Z Decide');
  }
}

// -- Difficulty select --------------------------------------------------------

class DifficultyMenu {
  cursor = 1; // Normal by default
  private repeat = new KeyRepeater();
  private items: AnmRunner[];
  private header: AnmRunner;
  private readonly count: number;

  // extraMode: entered from "Extra Start" — offers Extra (stage 7) and
  // Phantasm (stage 8) instead of the four main difficulties. The Extra
  // banner is select01's script after Lunatic (-24); if absent the text
  // labels below still identify the rows.
  constructor(private anm: Anm, readonly extraMode = false) {
    const base = anm.entries[ENTRY.difficulty].spriteIds[0];
    const ids = extraMode ? [-24, -24] : [...DIFFICULTY_IDS];
    this.items = [];
    for (const id of ids) {
      try {
        const runner = new AnmRunner(anm, id, { entryIndex: ENTRY.difficulty, spriteIndexOffset: base });
        runner.interrupt(7); // "show/cascade in" (per-item stagger is baked into each script's own timing)
        this.items.push(runner);
      } catch {
        // Missing banner script (defensive for extraMode) — text-only row.
      }
    }
    this.count = ids.length;
    if (extraMode) this.cursor = 0;
    this.header = makeHeader(anm, 0);
  }

  // The run difficulty index this menu's cursor stands for (Extra=4,
  // Phantasm=5 in extraMode).
  resultDifficulty(): number {
    return this.extraMode ? 4 + this.cursor : this.cursor;
  }

  update(input: InputFrame, audio: AudioBus): 'confirm' | 'back' | null {
    for (const it of this.items) it.update();
    this.header.update();
    const n = this.count;
    if (this.repeat.poll(input, 'down')) {
      this.cursor = (this.cursor + 1) % n;
      audio.sfx('se_select00', 0.141, 12);
    } else if (this.repeat.poll(input, 'up')) {
      this.cursor = (this.cursor - 1 + n) % n;
      audio.sfx('se_select00', 0.141, 12);
    }
    if (input.pressed.has('confirm')) {
      audio.sfx('se_ok00', 0.316, 10);
      return 'confirm';
    }
    if (input.pressed.has('back')) {
      audio.sfx('se_cancel00', 0.316, 11);
      return 'back';
    }
    return null;
  }

  draw(r: Renderer, frameCounter: number): void {
    r.drawImage('select00', 0, 0);
    r.drawAnmFrame(this.header.spriteFrame(), 0, 0);
    if (this.extraMode) {
      const labels = ['Extra', 'Phantasm'];
      labels.forEach((label, i) => {
        const focused = i === this.cursor;
        const y = 200 + i * 56;
        const frame = this.items[i]?.spriteFrame();
        if (frame) {
          r.drawAnmFrame(frame, 0, y - frame.vmY, focused ? { scaleMultiplier: 1.08 } : { alpha: 0.6 });
        }
        r.text(label, 260, y + (i === 1 ? 4 : 0), {
          size: 22,
          color: focused ? '#ffe0f0' : 'rgba(220,190,220,0.55)'
        });
        if (focused) drawCursorArrow(r, 236, y + 10, frameCounter);
      });
      hint(r, 'Up/Down Move    Z Decide    X Back');
      return;
    }
    this.items.forEach((runner, i) => {
      const frame = runner.spriteFrame();
      if (!frame) return;
      const focused = i === this.cursor;
      // The original scripts never swap sprite or color for the focused
      // item (confirmed by disassembly: each only ever calls ins_3 once),
      // so the exact highlight treatment couldn't be recovered statically;
      // approximated here as a scale/alpha emphasis on the focused banner.
      r.drawAnmFrame(frame, 0, 0, focused ? { scaleMultiplier: 1.08 } : { alpha: 0.6 });
      if (focused) drawCursorArrow(r, frame.vmX - 18, frame.vmY + frame.h / 2, frameCounter);
    });
    hint(r, 'Up/Down Move    Z Decide    X Back');
  }
}

// -- Character + shot-type select ---------------------------------------------

function makeHeader(anm: Anm, which: 0 | 1 | 2): AnmRunner {
  const base = anm.entries[ENTRY.header].spriteIds[0];
  const runner = new AnmRunner(anm, which, { entryIndex: ENTRY.header, spriteIndexOffset: base });
  // Labels per the disassembly: 7 shows "Choose Level", 8 shows "Choose
  // Girl" (also the event that hides "Choose Level"), 10 shows "Choose
  // Spell Card" (also hides "Choose Girl") — title01.anm treats difficulty
  // -> character -> shot-type as one continuous flow with a single
  // progressively-updating header caption, not three separate screens.
  runner.interrupt(which === 0 ? 7 : which === 1 ? 8 : 10);
  return runner;
}

class PlayerSelectMenu {
  charCursor = 0;
  shotCursor: 0 | 1 = 0;
  step: 'character' | 'shotType' = 'character';
  private repeat = new KeyRepeater();
  private portrait!: AnmRunner;
  private nameplate!: AnmRunner;
  private shotDesc!: AnmRunner;
  private header: AnmRunner;

  constructor(private anm: Anm) {
    this.header = makeHeader(anm, 1);
    this.enterCharacter(0);
  }

  private enterCharacter(family: number): void {
    const entryIdx = PORTRAIT_ENTRY[family];
    const base = this.anm.entries[entryIdx].spriteIds[0];
    const [portraitId] = PORTRAIT_IDS[family];
    this.portrait = new AnmRunner(this.anm, portraitId, { entryIndex: entryIdx, spriteIndexOffset: base });
    this.portrait.interrupt(9); // "become the active/centered portrait"
    const nameBase = this.anm.entries[ENTRY.nameplate].spriteIds[0];
    this.nameplate = new AnmRunner(this.anm, NAME_IDS[family], { entryIndex: ENTRY.nameplate, spriteIndexOffset: nameBase });
    this.nameplate.interrupt(9);
    this.showShotDesc();
  }

  private showShotDesc(): void {
    const entryIdx = PORTRAIT_ENTRY[this.charCursor];
    const base = this.anm.entries[entryIdx].spriteIds[0];
    const id = PORTRAIT_IDS[this.charCursor][this.shotCursor === 0 ? 1 : 2];
    this.shotDesc = new AnmRunner(this.anm, id, { entryIndex: entryIdx, spriteIndexOffset: base });
    this.shotDesc.interrupt(10); // "confirmed character, focus shot-type" (also used as this block's own show trigger)
  }

  result(): CharacterId {
    return `${FAMILY_NAMES[this.charCursor]}${this.shotCursor === 0 ? 'A' : 'B'}` as CharacterId;
  }

  update(input: InputFrame, audio: AudioBus): 'confirm' | 'back-to-difficulty' | null {
    this.portrait.update();
    this.nameplate.update();
    this.shotDesc.update();
    this.header.update();
    if (this.step === 'character') {
      const n = FAMILY_NAMES.length;
      if (this.repeat.poll(input, 'right')) {
        this.charCursor = (this.charCursor + 1) % n;
        audio.sfx('se_select00', 0.141, 12);
        this.enterCharacter(this.charCursor);
      } else if (this.repeat.poll(input, 'left')) {
        this.charCursor = (this.charCursor - 1 + n) % n;
        audio.sfx('se_select00', 0.141, 12);
        this.enterCharacter(this.charCursor);
      }
      if (input.pressed.has('confirm')) {
        audio.sfx('se_ok00', 0.316, 10);
        this.step = 'shotType';
        this.header = makeHeader(this.anm, 2);
        // Script label 10 = "character confirmed": dims the portrait to
        // half-alpha so the shot-type descriptions read on top of it.
        this.portrait.interrupt(10);
        this.showShotDesc();
        return null;
      }
      if (input.pressed.has('back')) {
        audio.sfx('se_cancel00', 0.316, 11);
        return 'back-to-difficulty';
      }
    } else {
      if (input.pressed.has('up') || input.pressed.has('down') || input.pressed.has('left') || input.pressed.has('right')) {
        this.shotCursor = this.shotCursor === 0 ? 1 : 0;
        audio.sfx('se_select00', 0.141, 12);
        this.showShotDesc();
      }
      if (input.pressed.has('confirm')) {
        audio.sfx('se_ok00', 0.316, 10);
        return 'confirm';
      }
      if (input.pressed.has('back')) {
        audio.sfx('se_cancel00', 0.316, 11);
        this.step = 'character';
        this.header = makeHeader(this.anm, 1);
        // Re-enter the character step: rebuild the portrait/nameplate in
        // their bright "active" state (interrupt 9).
        this.enterCharacter(this.charCursor);
        return null;
      }
    }
    return null;
  }

  draw(r: Renderer, frameCounter: number): void {
    r.drawImage('select00', 0, 0);
    r.drawAnmFrame(this.header.spriteFrame(), 0, 0);
    r.drawAnmFrame(this.portrait.spriteFrame(), 0, 0);
    r.drawAnmFrame(this.nameplate.spriteFrame(), 0, 0);
    const shotFrame = this.shotDesc.spriteFrame();
    const shotFocused = this.step === 'shotType';
    r.drawAnmFrame(shotFrame, 0, 0, shotFocused ? {} : { alpha: 0.75 });
    if (this.step === 'character') {
      // Left/right carousel arrows flanking the portrait's rest position.
      drawCursorArrow(r, 448 - 150, 240, frameCounter);
      drawCursorArrowLeft(r, 448 + 150, 240, frameCounter + 30);
      hint(r, 'Left/Right Character    Z Decide    X Back');
    } else if (shotFrame) {
      drawCursorArrow(r, shotFrame.vmX - shotFrame.w / 2 - 16, shotFrame.vmY, frameCounter);
      hint(r, 'Up/Down Shot Type    Z Decide    X Back');
    }
  }
}

// -- Top-level orchestrator ---------------------------------------------------

// -- Practice stage select -----------------------------------------------------

// Vanilla practice flow: difficulty → character → shot → STAGE (exe
// FUN_00451d22, all.c:39732-39833). The original gates the list by cleared
// stages persisted in score.dat ("CLRD" chunks, default = stage 1 only);
// this port has no save data, so all six stages are selectable — a flagged
// modernization serving stage-by-stage testing. Rows are plain text (the
// original renders them with its ascii font + per-stage practice scores).
class StageSelectMenu {
  cursor = 0;
  private repeat = new KeyRepeater();

  update(input: InputFrame, audio: AudioBus): 'confirm' | 'back' | null {
    if (this.repeat.poll(input, 'down')) {
      this.cursor = (this.cursor + 1) % 6;
      audio.sfx('se_select00', 0.141, 12);
    } else if (this.repeat.poll(input, 'up')) {
      this.cursor = (this.cursor + 5) % 6;
      audio.sfx('se_select00', 0.141, 12);
    }
    if (input.pressed.has('confirm')) {
      audio.sfx('se_ok00', 0.316, 10);
      return 'confirm';
    }
    if (input.pressed.has('back')) {
      audio.sfx('se_cancel00', 0.316, 11);
      return 'back';
    }
    return null;
  }

  draw(r: Renderer): void {
    r.drawImage('select00', 0, 0);
    r.text('Stage Select', SCREEN_W / 2, 96, { size: 22, color: '#fce', align: 'center' });
    for (let i = 0; i < 6; i++) {
      const focused = i === this.cursor;
      r.text(`Stage ${i + 1}`, SCREEN_W / 2, 160 + i * 36, {
        size: 18,
        color: focused ? '#fff6a0' : '#8a7f9a',
        align: 'center'
      });
    }
    hint(r, 'Up/Down Move    Z Decide    X Back');
  }
}

// -- Replay stage select ------------------------------------------------------

const REPLAY_DIFFICULTY_NAMES = ['Easy', 'Normal', 'Hard', 'Lunatic', 'Extra', 'Phantasm'] as const;

function replayStageLabel(replay: Rpy, stageNumber: number): string {
  if (stageNumber === 7) return replay.difficulty >= 5 ? 'Phantasm' : 'Extra';
  return `Stage ${stageNumber}`;
}

class ReplaySelectMenu {
  cursor = 0;
  private repeat = new KeyRepeater();
  private header: AnmRunner;

  constructor(
    private anm: Anm,
    readonly replay: Rpy | null,
    readonly fileName: string,
    readonly error: string | null = null
  ) {
    const entry = anm.entries[ENTRY.replay];
    this.header = new AnmRunner(anm, 0, {
      entryIndex: ENTRY.replay,
      spriteIndexOffset: entry.spriteBase
    });
    // replay00 script 0 labels 13/14/15/19 all enter through the authored
    // 30-frame header slide. The executable uses label 15 for the stage-list
    // branch (FUN_0045207e); preserving the ANM keeps its original artwork.
    this.header.interrupt(15);
  }

  update(input: InputFrame, audio: AudioBus): 'confirm' | 'back' | null {
    this.header.update();
    const n = this.replay?.stages.length ?? 0;
    if (n > 0 && this.repeat.poll(input, 'down')) {
      this.cursor = (this.cursor + 1) % n;
      audio.sfx('se_select00', 0.141, 12);
    } else if (n > 0 && this.repeat.poll(input, 'up')) {
      this.cursor = (this.cursor - 1 + n) % n;
      audio.sfx('se_select00', 0.141, 12);
    }
    if (input.pressed.has('confirm') && n > 0) {
      audio.sfx('se_ok00', 0.316, 10);
      return 'confirm';
    }
    if (input.pressed.has('back')) {
      audio.sfx('se_cancel00', 0.316, 11);
      return 'back';
    }
    return null;
  }

  draw(r: Renderer, frameCounter: number): void {
    r.drawImage('select00', 0, 0);
    r.drawAnmFrame(this.header.spriteFrame(), 0, 0);
    if (!this.replay) {
      r.text(this.fileName || 'Replay Load Error', SCREEN_W / 2, 190, {
        size: 16,
        color: '#f0dce8',
        align: 'center'
      });
      r.text(this.error ?? 'Unable to load replay.', SCREEN_W / 2, 226, {
        size: 14,
        color: '#ff9ca8',
        align: 'center'
      });
      hint(r, 'X Back');
      return;
    }

    const replay = this.replay;
    const entry = this.anm.entries[ENTRY.replay];
    const stageLabel = this.anm.sprites.get(entry.spriteIds[1]);
    if (stageLabel) r.drawSprite(stageLabel.imageKey, stageLabel.x, stageLabel.y, stageLabel.w, stageLabel.h, 92, 154);
    const scoreLabel = this.anm.sprites.get(entry.spriteIds[8]);
    if (scoreLabel) r.drawSprite(scoreLabel.imageKey, scoreLabel.x, scoreLabel.y, scoreLabel.w, scoreLabel.h, 286, 154);
    const difficultySprite = this.anm.sprites.get(entry.spriteIds[Math.min(6, replay.difficulty + 2)]);
    if (difficultySprite) {
      r.drawSprite(
        difficultySprite.imageKey,
        difficultySprite.x,
        difficultySprite.y,
        difficultySprite.w,
        difficultySprite.h,
        364,
        154
      );
    }

    r.text(this.fileName, 320, 126, { size: 12, color: '#d9cce8', align: 'center' });
    replay.stages.forEach((stage, i) => {
      const focused = i === this.cursor;
      const y = 184 + i * 31;
      r.text(replayStageLabel(replay, stage.stage), 112, y, {
        size: 16,
        color: focused ? '#fff6a0' : '#9e91ae',
        align: 'center'
      });
      r.text((stage.scoreAtEnd * 10).toLocaleString('en-US'), 236, y, {
        size: 14,
        color: focused ? '#f8e8b0' : '#aaa0b4'
      });
      if (focused) drawCursorArrow(r, 50, y - 5, frameCounter);
    });

    const difficulty = REPLAY_DIFFICULTY_NAMES[replay.difficulty] ?? `Difficulty ${replay.difficulty}`;
    const lines = [
      `Name   ${replay.name || '-'}`,
      `Date   ${replay.date || '-'}`,
      `Player ${replay.character}`,
      `Rank   ${difficulty}`,
      `Final  ${(replay.score * 10).toLocaleString('en-US')}`
    ];
    lines.forEach((line, i) => {
      r.text(line, 430, 190 + i * 31, { size: 14, color: '#f0e8f5', align: 'center' });
    });
    hint(r, 'Up/Down Stage    Z Playback    X Back');
  }
}

export type ReplayPlaybackMode = 0 | 1 | 2;

class ReplayConfirmMenu {
  cursor: ReplayPlaybackMode = 0;
  private repeat = new KeyRepeater();
  private header: AnmRunner;
  private panels: AnmRunner[];

  constructor(private anm: Anm, readonly replay: Rpy, readonly stageIndex: number) {
    const entry = anm.entries[ENTRY.replay];
    this.header = new AnmRunner(anm, 0, {
      entryIndex: ENTRY.replay,
      spriteIndexOffset: entry.spriteBase
    });
    this.header.interrupt(19);
    this.panels = [26, 27, 28].map((id) => {
      const runner = new AnmRunner(anm, id, {
        entryIndex: ENTRY.replay,
        spriteIndexOffset: entry.spriteBase
      });
      runner.interrupt(19);
      return runner;
    });
    this.syncHighlight();
  }

  private syncHighlight(): void {
    this.panels.forEach((runner, i) => runner.interrupt(i === this.cursor ? 20 : 21));
  }

  update(input: InputFrame, audio: AudioBus): 'confirm' | 'back' | null {
    this.header.update();
    for (const panel of this.panels) panel.update();
    if (this.repeat.poll(input, 'down')) {
      this.cursor = ((this.cursor + 1) % 3) as ReplayPlaybackMode;
      this.syncHighlight();
      audio.sfx('se_select00', 0.141, 12);
    } else if (this.repeat.poll(input, 'up')) {
      this.cursor = ((this.cursor + 2) % 3) as ReplayPlaybackMode;
      this.syncHighlight();
      audio.sfx('se_select00', 0.141, 12);
    }
    if (input.pressed.has('confirm')) {
      audio.sfx('se_ok00', 0.316, 10);
      return 'confirm';
    }
    if (input.pressed.has('back')) {
      audio.sfx('se_cancel00', 0.316, 11);
      return 'back';
    }
    return null;
  }

  draw(r: Renderer): void {
    r.drawImage('select00', 0, 0);
    r.drawAnmFrame(this.header.spriteFrame(), 0, 0);
    for (const panel of this.panels) r.drawAnmFrame(panel.spriteFrame(), 0, 0);
    const stage = this.replay.stages[this.stageIndex];
    r.text(replayStageLabel(this.replay, stage.stage), SCREEN_W / 2, 118, {
      size: 18,
      color: '#f6eaf7',
      align: 'center'
    });
    hint(r, 'Up/Down Playback Mode    Z Decide    X Back');
  }
}

export type MenuSceneKind = 'title' | 'difficulty' | 'select' | 'stage' | 'replay' | 'replay-confirm';

export interface MenuStartOptions {
  practice?: boolean;
  stage?: number;
}

export interface MenuSnapshot {
  scene: MenuSceneKind;
  cursor: number;
  [key: string]: unknown;
}

const STAGE_TRANSITION_FRAMES = 30;

export class MenuFlow {
  private phase: MenuSceneKind = 'title';
  private title: TitleMenu;
  private difficulty: DifficultyMenu | null = null;
  private select: PlayerSelectMenu | null = null;
  private stageSelect: StageSelectMenu | null = null;
  private replaySelect: ReplaySelectMenu | null = null;
  private replayConfirm: ReplayConfirmMenu | null = null;
  private chosenDifficulty = 1;
  private practiceMode = false;
  private chosenStage = 1;
  private transitionOut = 0;
  private pendingCharacter: CharacterId | null = null;
  private pendingReplayStageIndex: number | null = null;
  private pendingReplayMode: ReplayPlaybackMode = 0;
  private frame = 0;

  constructor(
    private assets: GameAssets,
    private audio: AudioBus,
    private onStart: (difficulty: number, character: CharacterId, opts?: MenuStartOptions) => void,
    initialTitleCursor = 0,
    private onStartReplay?: (
      replay: Rpy,
      stageIndex: number,
      fileName: string,
      mode: ReplayPlaybackMode
    ) => void
  ) {
    this.title = new TitleMenu(this.anm);
    // Th07.exe FUN_00452e91 (all.c:40457-40459): returning from a practice
    // run parks the title cursor back on Practice Start.
    this.title.cursor = initialTitleCursor;
  }

  private get anm(): Anm {
    return this.assets.anms.title01;
  }

  // The browser host owns file I/O. Once it has parsed a local T7RP, this
  // method enters the authored replay selector without making the menu layer
  // depend on File/Blob APIs (and remains directly testable in Node bundles).
  showReplay(replay: Rpy, fileName: string, initialStageIndex = 0): void {
    this.phase = 'replay';
    this.replaySelect = new ReplaySelectMenu(this.anm, replay, fileName);
    this.replaySelect.cursor = Math.max(0, Math.min(replay.stages.length - 1, initialStageIndex));
    this.transitionOut = 0;
    this.pendingReplayStageIndex = null;
  }

  showReplayError(fileName: string, message: string): void {
    this.phase = 'replay';
    this.replaySelect = new ReplaySelectMenu(this.anm, null, fileName, message);
    this.transitionOut = 0;
    this.pendingReplayStageIndex = null;
  }

  // File inputs must be opened synchronously from the physical key event;
  // main.ts queries this before requestAnimationFrame consumes the edge.
  replayFileHotkeyActive(): boolean {
    return this.phase === 'title' && this.title.cursor === 3 && this.transitionOut === 0;
  }

  update(input: InputFrame): void {
    this.frame++;
    if (this.transitionOut > 0) {
      this.transitionOut--;
      if (this.transitionOut === 0) {
        if (this.pendingReplayStageIndex != null && this.replaySelect?.replay && this.onStartReplay) {
          this.onStartReplay(
            this.replaySelect.replay,
            this.pendingReplayStageIndex,
            this.replaySelect.fileName,
            this.pendingReplayMode
          );
        } else if (this.pendingCharacter) {
          this.onStart(
            this.chosenDifficulty,
            this.pendingCharacter,
            this.practiceMode ? { practice: true, stage: this.chosenStage } : undefined
          );
        }
      }
      return; // freeze the underlying screen while fading to the stage
    }
    switch (this.phase) {
      case 'title': {
        const result = this.title.update(input, this.audio);
        if (result === 'confirm' || result === 'confirm-extra' || result === 'confirm-practice') {
          // Practice detours through the same difficulty/character flow and
          // adds a stage-select step after shot select (exe submenu id 8 →
          // FUN_004515c6 → StageSelect 0xb, all.c:38487-39798).
          this.practiceMode = result === 'confirm-practice';
          this.phase = 'difficulty';
          this.difficulty = new DifficultyMenu(this.anm, result === 'confirm-extra');
        }
        // `confirm-replay` intentionally stays on title until the browser's
        // native file picker resolves; main.ts calls showReplay/showReplayError.
        break;
      }
      case 'difficulty': {
        const result = this.difficulty!.update(input, this.audio);
        if (result === 'confirm') {
          this.chosenDifficulty = this.difficulty!.resultDifficulty();
          this.phase = 'select';
          this.select = new PlayerSelectMenu(this.anm);
        } else if (result === 'back') {
          this.phase = 'title';
          this.difficulty = null;
          this.title = new TitleMenu(this.anm);
          if (this.practiceMode) this.title.cursor = 2;
        }
        break;
      }
      case 'select': {
        const result = this.select!.update(input, this.audio);
        if (result === 'confirm') {
          this.pendingCharacter = this.select!.result();
          if (this.practiceMode) {
            this.phase = 'stage';
            this.stageSelect = new StageSelectMenu();
          } else {
            this.transitionOut = STAGE_TRANSITION_FRAMES;
          }
        } else if (result === 'back-to-difficulty') {
          this.phase = 'difficulty';
          this.select = null;
          const wasExtra = this.chosenDifficulty >= 4;
          this.difficulty = new DifficultyMenu(this.anm, wasExtra);
          this.difficulty.cursor = wasExtra ? this.chosenDifficulty - 4 : this.chosenDifficulty;
        }
        break;
      }
      case 'stage': {
        const result = this.stageSelect!.update(input, this.audio);
        if (result === 'confirm') {
          this.chosenStage = this.stageSelect!.cursor + 1;
          this.transitionOut = STAGE_TRANSITION_FRAMES;
        } else if (result === 'back') {
          this.phase = 'select';
          this.stageSelect = null;
          this.select = new PlayerSelectMenu(this.anm);
        }
        break;
      }
      case 'replay': {
        const result = this.replaySelect!.update(input, this.audio);
        if (result === 'confirm' && this.replaySelect!.replay) {
          this.pendingReplayStageIndex = this.replaySelect!.cursor;
          this.phase = 'replay-confirm';
          this.replayConfirm = new ReplayConfirmMenu(
            this.anm,
            this.replaySelect!.replay,
            this.pendingReplayStageIndex
          );
        } else if (result === 'back') {
          this.phase = 'title';
          this.replaySelect = null;
          this.title = new TitleMenu(this.anm);
          this.title.cursor = 3;
        }
        break;
      }
      case 'replay-confirm': {
        const result = this.replayConfirm!.update(input, this.audio);
        if (result === 'confirm') {
          this.pendingReplayMode = this.replayConfirm!.cursor;
          this.transitionOut = STAGE_TRANSITION_FRAMES;
        } else if (result === 'back') {
          this.phase = 'replay';
          this.replayConfirm = null;
        }
        break;
      }
    }
  }

  draw(r: Renderer): void {
    switch (this.phase) {
      case 'title':
        this.title.draw(r, this.frame);
        break;
      case 'difficulty':
        this.difficulty!.draw(r, this.frame);
        break;
      case 'select':
        this.select!.draw(r, this.frame);
        break;
      case 'stage':
        this.stageSelect!.draw(r);
        break;
      case 'replay':
        this.replaySelect!.draw(r, this.frame);
        break;
      case 'replay-confirm':
        this.replayConfirm!.draw(r);
        break;
    }
    if (this.transitionOut > 0) {
      const alpha = 1 - this.transitionOut / STAGE_TRANSITION_FRAMES;
      const ctx = r.ctx;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
      ctx.restore();
    }
  }

  snapshot(): MenuSnapshot {
    const transitioning = this.transitionOut > 0;
    switch (this.phase) {
      case 'title':
        return { scene: 'title', cursor: this.title.cursor, locked: !MAIN_MENU_ITEMS[this.title.cursor].enabled, transitioning };
      case 'difficulty':
        return {
          scene: 'difficulty',
          cursor: this.difficulty!.cursor,
          difficultyName: DIFFICULTY_NAMES[this.difficulty!.cursor],
          transitioning
        };
      case 'select': {
        const s = this.select!;
        return {
          scene: 'select',
          cursor: s.step === 'character' ? s.charCursor : s.shotCursor,
          step: s.step,
          character: FAMILY_NAMES[s.charCursor],
          shotType: s.shotCursor === 0 ? 'A' : 'B',
          practice: this.practiceMode,
          transitioning
        };
      }
      case 'stage':
        return {
          scene: 'stage',
          cursor: this.stageSelect!.cursor,
          stage: this.stageSelect!.cursor + 1,
          practice: true,
          transitioning
        };
      case 'replay': {
        const menu = this.replaySelect!;
        const stage = menu.replay?.stages[menu.cursor];
        return {
          scene: 'replay',
          cursor: menu.cursor,
          fileName: menu.fileName,
          replayName: menu.replay?.name ?? null,
          difficulty: menu.replay?.difficulty ?? null,
          character: menu.replay?.character ?? null,
          stage: stage?.stage ?? null,
          frames: stage?.inputs.length ?? null,
          error: menu.error,
          transitioning
        };
      }
      case 'replay-confirm':
        return {
          scene: 'replay-confirm',
          cursor: this.replayConfirm!.cursor,
          stage: this.replaySelect!.replay?.stages[this.pendingReplayStageIndex ?? 0]?.stage ?? null,
          playbackMode: this.replayConfirm!.cursor,
          transitioning
        };
    }
  }
}
