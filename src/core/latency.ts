export interface LatencySample {
  sequence: number;
  code: string;
  edge: 'down' | 'up';
  eventTimestamp: number;
  handlerStart: number;
  handlerEnd: number;
  sampledAt?: number;
  logicAppliedAt?: number;
  drawEndAt?: number;
  logicalFrame?: number;
}

export interface InputEdgeTiming {
  code: string;
  edge: 'down' | 'up';
  eventTimestamp: number;
  handlerStart: number;
  handlerEnd: number;
}

export interface LatencyLogicState {
  x: number;
  y: number;
  focused: boolean;
  playerShotSerial: number;
  bombTimer: number;
}

const DIRECTION_CODES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

// Test-only fixed-capacity event observer. It sits outside InputFrame and the
// replay seam: retail input mapping and 60 Hz simulation remain untouched.
export class LatencyRecorder {
  private readonly ring: (LatencySample | null)[];
  private cursor = 0;
  private count = 0;
  private nextSequence = 1;

  constructor(private readonly capacity = 2048) {
    this.ring = new Array<LatencySample | null>(capacity).fill(null);
  }

  recordInput(timing: InputEdgeTiming): void {
    const sample: LatencySample = { sequence: this.nextSequence++, ...timing };
    this.ring[this.cursor] = sample;
    this.cursor = (this.cursor + 1) % this.ring.length;
    this.count = Math.min(this.ring.length, this.count + 1);
  }

  markSampled(now: number): void {
    for (const sample of this.orderedSamples()) {
      if (sample.sampledAt == null) sample.sampledAt = now;
    }
  }

  observeLogic(before: LatencyLogicState, after: LatencyLogicState, logicalFrame: number, now: number): void {
    for (const sample of this.orderedSamples()) {
      if (sample.sampledAt == null || sample.logicAppliedAt != null) continue;
      let applied = false;
      if (DIRECTION_CODES.has(sample.code)) {
        applied = before.x !== after.x || before.y !== after.y;
      } else if (sample.code === 'ShiftLeft' || sample.code === 'ShiftRight') {
        applied = before.focused !== after.focused && after.focused === (sample.edge === 'down');
      } else if (sample.code === 'KeyZ' || sample.code === 'Enter') {
        applied = sample.edge === 'down' && after.playerShotSerial > before.playerShotSerial;
      } else if (sample.code === 'KeyX') {
        applied = sample.edge === 'down' && before.bombTimer <= 0 && after.bombTimer > 0;
      }
      if (!applied) continue;
      sample.logicAppliedAt = now;
      sample.logicalFrame = logicalFrame;
    }
  }

  pendingDrawSamples(): LatencySample[] {
    return this.orderedSamples().filter((sample) => sample.logicAppliedAt != null && sample.drawEndAt == null);
  }

  markDrawEnd(samples: LatencySample[], now: number): void {
    for (const sample of samples) {
      sample.drawEndAt = now;
      performance.mark(`th07-latency-${sample.sequence}`, {
        detail: { sequence: sample.sequence, logicalFrame: sample.logicalFrame, drawEndAt: now }
      });
    }
  }

  samples(): LatencySample[] {
    return this.orderedSamples().map((sample) => ({ ...sample }));
  }

  clear(): void {
    for (const sample of this.orderedSamples()) performance.clearMarks(`th07-latency-${sample.sequence}`);
    this.ring.fill(null);
    this.cursor = 0;
    this.count = 0;
  }

  private orderedSamples(): LatencySample[] {
    const out = new Array<LatencySample>(this.count);
    const start = this.count === this.ring.length ? this.cursor : 0;
    for (let i = 0; i < this.count; i++) out[i] = this.ring[(start + i) % this.ring.length]!;
    return out;
  }
}
