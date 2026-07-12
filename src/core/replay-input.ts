import type { Button, InputFrame } from './input';
import { RPY_BITS } from '../formats/rpy';

// Decodes recorded T7RP input words into the InputFrame shape the scenes
// consume. The recorded word is the exe's per-frame DirectInput mask, so the
// mapping mirrors KEY_MAP's physical-key overlaps (Z = shoot+confirm,
// X = bomb+back) — feeding a replay must be indistinguishable from a human
// pressing those keys. Pressed edges are the rising edges of each bit,
// matching both the exe (prev-word compare in FUN_0043fe30's consumers) and
// Input's keydown edge tracking.
const BIT_BUTTONS: Array<[number, Button[]]> = [
  [RPY_BITS.shoot, ['shoot', 'confirm']],
  [RPY_BITS.bomb, ['bomb', 'back']],
  [RPY_BITS.focus, ['focus']],
  [RPY_BITS.up, ['up']],
  [RPY_BITS.down, ['down']],
  [RPY_BITS.left, ['left']],
  [RPY_BITS.right, ['right']],
  [RPY_BITS.skip, ['skip']]
];

export class ReplayInputSource {
  private prev = 0;
  private held = new Set<Button>();
  private pressed = new Set<Button>();
  private state: InputFrame = { held: this.held, pressed: this.pressed };

  // Builds the InputFrame for one recorded word. The returned object is
  // reused across frames (same contract as Input.frame()).
  frame(word: number): InputFrame {
    this.held.clear();
    this.pressed.clear();
    const rising = word & ~this.prev;
    for (const [bit, buttons] of BIT_BUTTONS) {
      if (word & bit) for (const b of buttons) this.held.add(b);
      if (rising & bit) for (const b of buttons) this.pressed.add(b);
    }
    this.prev = word;
    return this.state;
  }

  reset(): void {
    this.prev = 0;
  }
}
