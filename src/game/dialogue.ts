import { Msg, type MsgInstr } from '../formats/msg';
import type { Anm, AnmSprite } from '../formats/anm';

// Stage dialogue runner. Ops (validated against the msg1 disassembly):
// 0 end, 1 portrait enter (side, face), 2 set face (side, face), 3 text line
// (side, lineIndex, text), 4 wait N frames, 5 portrait state (side,
// 1 enter / 3 active / 4 inactive), 6 ECL resume ticket, 7 music change,
// 8 boss intro line, 9/10 stage flow, 11 hide portraits, 12 BGM fadeout,
// 13 skippability flag.

export interface PortraitState {
  visible: boolean;
  face: number;
  active: boolean;
  slideIn: number;
}

export class DialogueRunner {
  private instrs: MsgInstr[];
  private idx = 0;
  private time = 0;
  private waitTimer = 0;
  private waitAge = 0;
  done = false;
  resumeTicket = false;
  lines: (string | null)[] = [null, null];
  speakerSide = 0;
  bossIntro: string[] = [];
  bossIntroTimer = 0;
  portraits: PortraitState[] = [
    { visible: false, face: 0, active: false, slideIn: 0 },
    { visible: false, face: 0, active: false, slideIn: 0 }
  ];
  skippable = true;

  constructor(
    msg: Msg,
    index: number,
    private hooks: { playBgm?(track: number): void; fadeBgm?(): void } = {}
  ) {
    this.instrs = msg.message(index) ?? [];
    if (!this.instrs.length) this.done = true;
  }

  get blocking(): boolean {
    // Direct Stage-1/6 runtime traces show DAT_0061c25c remains zero for
    // both op-4 story conversations and timestamp-only MSG tracks. Op 4
    // holds only the message interpreter; it is not the global gameplay
    // freeze flag. FUN_00429483 still treats MSG as active for input gates.
    return false;
  }

  // Th07.exe MSG interpreter FUN_00428392 @ 0x428392, case 4 (all.c:
  // 17849-17858): a wait ends on (a) timeout, (b) a Z press edge once the
  // wait is >= 12 frames old — NOT gated by op 13 — or (c) the CTRL
  // fast-forward (input bit 0x100), which IS gated by op 13 skippability
  // and at the interpreter top jumps the clock straight to the next
  // instruction's timestamp. The old runner gated the Z-advance on op 13,
  // which made the post-boss dialogue's 300/900/1200-frame tail waits
  // unskippable.
  // Th07.exe FUN_00428392 @ 0x428392 dispatches only while the current
  // instruction's authored u16 timestamp is <= the message split-clock.
  // The priority-13 manager increments that clock once at the tail of a
  // non-waiting tick.  Op 4 holds its own instruction pointer and suppresses
  // the tail increment; it is not a replacement for timestamp scheduling.
  update(confirmPressed: boolean, skipHeld = false): void {
    if (this.done) return;
    for (const p of this.portraits) {
      if (p.visible && p.slideIn < 1) p.slideIn = Math.min(1, p.slideIn + 0.1);
    }
    if (this.bossIntroTimer > 0) this.bossIntroTimer--;

    // CTRL fast-forward writes the clock to the CURRENT instruction's
    // timestamp before dispatch (all.c:17786-17789). Holding it therefore
    // reaches one future timestamp group per manager tick.
    const current = this.instrs[this.idx];
    if (this.skippable && skipHeld && current) {
      this.time = current.time;
    }

    for (let guard = 0; guard < 512 && !this.done; guard++) {
      const instr = this.instrs[this.idx];
      if (!instr) {
        this.done = true;
        return;
      }
      if (instr.time > this.time) break;

      if (instr.op === 4) {
        const duration = Math.max(0, instr.arg ?? 0);
        const ctrlCut = this.skippable && skipHeld;
        const zCut = confirmPressed && this.waitAge >= 12;
        if (!ctrlCut && !zCut && this.waitAge < duration) {
          // Native increments +0x1fbbc on the first encounter too, leaves
          // the pointer on op 4, and skips the message-clock tail tick.
          this.waitAge++;
          this.waitTimer = Math.max(0, duration - this.waitAge);
          return;
        }
        this.waitAge = 0;
        this.waitTimer = 0;
        this.idx++;
        continue;
      }

      this.idx++;
      switch (instr.op) {
        case 0:
          this.done = true;
          return;
        case 1: {
          const side = instr.portrait ?? 0;
          const p = this.portraits[side];
          if (p) {
            p.visible = true;
            p.face = instr.script ?? 0;
            p.slideIn = 0;
          }
          break;
        }
        case 2: {
          const p = this.portraits[instr.portrait ?? 0];
          if (p) p.face = instr.script ?? 0;
          break;
        }
        case 3: {
          this.speakerSide = instr.color ?? 0;
          const lineIdx = (instr.line ?? 0) & 1;
          if (lineIdx === 0) this.lines = [instr.text ?? '', null];
          else this.lines[1] = instr.text ?? '';
          this.waitAge = 0;
          break;
        }
        case 5: {
          const p = this.portraits[instr.portrait ?? 0];
          if (p) p.active = (instr.script ?? 0) !== 4;
          break;
        }
        case 6:
          this.resumeTicket = true;
          break;
        case 7:
          this.hooks.playBgm?.(instr.arg ?? 0);
          break;
        case 8:
          this.bossIntro.push(instr.text ?? '');
          this.bossIntroTimer = 180;
          this.waitAge = 0;
          break;
        case 11:
          for (const p of this.portraits) p.visible = false;
          break;
        case 12:
          this.hooks.fadeBgm?.();
          break;
        case 13:
          this.skippable = (instr.arg ?? 1) !== 0;
          break;
        case 9:
        case 10:
        default:
          break;
      }
    }
    // FUN_004011c0 at the interpreter tail advances the normal-rate message
    // split clock once. Op 0 and a held op 4 return before reaching it.
    if (!this.done) this.time++;
  }
}

// Portrait sprite for a side: side 0 = player (face_rm00/mr00/sk00 by
// family), side 1 = stage boss (face_XX_00).
export function portraitSprite(anm: Anm, face: number): AnmSprite | null {
  return anm.sprites.get(face) ?? anm.sprites.get(0) ?? null;
}
