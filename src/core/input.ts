export type Button =
  | 'up' | 'down' | 'left' | 'right'
  | 'shoot' | 'bomb' | 'focus' | 'pause' | 'confirm' | 'back' | 'skip';

const KEY_MAP = new Map<string, Button[]>([
  ['ArrowUp', ['up']],
  ['ArrowDown', ['down']],
  ['ArrowLeft', ['left']],
  ['ArrowRight', ['right']],
  ['KeyZ', ['shoot', 'confirm']],
  ['Enter', ['shoot', 'confirm']],
  ['KeyX', ['bomb', 'back']],
  ['ShiftLeft', ['focus']],
  ['ShiftRight', ['focus']],
  ['ControlLeft', ['skip']],
  ['ControlRight', ['skip']],
  ['Escape', ['pause', 'back']]
]);

export interface InputFrame {
  held: Set<Button>;
  pressed: Set<Button>;
}

export interface InputEdgeObserver {
  (timing: {
    code: string;
    edge: 'down' | 'up';
    eventTimestamp: number;
    handlerStart: number;
    handlerEnd: number;
  }): void;
}

export class Input {
  private held = new Set<Button>();
  private codes = new Set<string>();
  private downEdges = new Set<Button>();
  // Reused snapshots keep the 60 Hz input hot path allocation-free. Every
  // consumer reads InputFrame synchronously during the same update tick.
  private frameHeld = new Set<Button>();
  private framePressed = new Set<Button>();
  private frameState: InputFrame = { held: this.frameHeld, pressed: this.framePressed };

  constructor(private readonly edgeObserver?: InputEdgeObserver) {
    addEventListener('keydown', (e) => this.down(e), { passive: false });
    addEventListener('keyup', (e) => this.up(e), { passive: false });
    addEventListener('blur', () => {
      this.held.clear();
      this.codes.clear();
      this.downEdges.clear();
    });
  }

  private down(event: KeyboardEvent): void {
    const handlerStart = this.edgeObserver && !event.repeat ? performance.now() : 0;
    const buttons = KEY_MAP.get(event.code);
    if (!buttons) return;
    event.preventDefault();
    this.codes.add(event.code);
    for (const button of buttons) {
      if (!event.repeat && !this.held.has(button)) this.downEdges.add(button);
      this.held.add(button);
    }
    if (this.edgeObserver && !event.repeat) {
      this.edgeObserver({
        code: event.code,
        edge: 'down',
        eventTimestamp: event.timeStamp,
        handlerStart,
        handlerEnd: performance.now()
      });
    }
  }

  private up(event: KeyboardEvent): void {
    const handlerStart = this.edgeObserver ? performance.now() : 0;
    const buttons = KEY_MAP.get(event.code);
    if (!buttons) return;
    event.preventDefault();
    this.codes.delete(event.code);
    // Rebuild held from the remaining codes so overlapping bindings survive.
    this.held.clear();
    for (const code of this.codes) {
      for (const button of KEY_MAP.get(code) ?? []) this.held.add(button);
    }
    this.edgeObserver?.({
      code: event.code,
      edge: 'up',
      eventTimestamp: event.timeStamp,
      handlerStart,
      handlerEnd: performance.now()
    });
  }

  // Test hook: injects synthetic state for one frame.
  inject(held: Iterable<Button>, pressed: Iterable<Button>): void {
    for (const b of pressed) this.downEdges.add(b);
    for (const b of held) this.held.add(b);
  }

  clearInjected(): void {
    this.held.clear();
    this.codes.clear();
  }

  frame(): InputFrame {
    this.frameHeld.clear();
    for (const button of this.held) this.frameHeld.add(button);
    this.framePressed.clear();
    for (const button of this.downEdges) this.framePressed.add(button);
    this.downEdges.clear();
    return this.frameState;
  }
}
