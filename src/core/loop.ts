import { pace } from './pacing';

export interface LoopClient {
  update(): void;
  draw(): void;
}

// Fixed 60 FPS timestep with bounded catch-up and a vsync snap — the
// pacing policy itself (step counts, accumulator, snap band) is the pure
// function in pacing.ts, unit-tested in tests/th07-pacing.test.mjs. The
// previous one-step-per-rAF loop silently ran the whole game slow on any
// sub-60Hz delivery (reported as "player feels too slow"). Draws are
// skipped on rAF ticks that ran no simulation step.

export class Loop {
  private last = 0;
  private acc = 0;
  private running = false;
  private static readonly COST_RING = 600;
  // Perf-only observability. Production and latency runs leave these null,
  // avoiding performance.now(), array writes, and ring maintenance entirely.
  private readonly updateCosts: Float64Array | null;
  private readonly drawCosts: Float64Array | null;
  private updateCostCursor = 0;
  private updateCostCount = 0;
  private drawCostCursor = 0;
  private drawCostCount = 0;

  constructor(
    private client: LoopClient,
    private readonly measureCosts = false,
    // ?pace=raw sets false: exact accumulator with no vsync snap, the
    // pre-snap behavior, kept as a player-facing kill switch.
    private readonly snap = true
  ) {
    this.updateCosts = measureCosts ? new Float64Array(Loop.COST_RING) : null;
    this.drawCosts = measureCosts ? new Float64Array(Loop.COST_RING) : null;
  }

  private recordCost(kind: 'update' | 'draw', ms: number): void {
    const ring = kind === 'update' ? this.updateCosts : this.drawCosts;
    if (!ring) return;
    if (kind === 'update') {
      ring[this.updateCostCursor] = ms;
      this.updateCostCursor = (this.updateCostCursor + 1) % ring.length;
      this.updateCostCount = Math.min(ring.length, this.updateCostCount + 1);
    } else {
      ring[this.drawCostCursor] = ms;
      this.drawCostCursor = (this.drawCostCursor + 1) % ring.length;
      this.drawCostCount = Math.min(ring.length, this.drawCostCount + 1);
    }
  }

  private readCosts(ring: Float64Array | null, cursor: number, count: number): number[] {
    if (!ring || count === 0) return [];
    const out = new Array<number>(count);
    const start = count === ring.length ? cursor : 0;
    for (let i = 0; i < count; i++) out[i] = ring[(start + i) % ring.length];
    return out;
  }

  private timedUpdate(): void {
    if (!this.measureCosts) {
      this.client.update();
      return;
    }
    const t0 = performance.now();
    this.client.update();
    this.recordCost('update', performance.now() - t0);
  }

  private timedDraw(): void {
    if (!this.measureCosts) {
      this.client.draw();
      return;
    }
    const t0 = performance.now();
    this.client.draw();
    this.recordCost('draw', performance.now() - t0);
  }

  frameCosts(): { update: number[]; draw: number[] } {
    return {
      update: this.readCosts(this.updateCosts, this.updateCostCursor, this.updateCostCount),
      draw: this.readCosts(this.drawCosts, this.drawCostCursor, this.drawCostCount)
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame((t) => this.tick(t));
  }

  // Test tooling can stop the real rAF driver before using advance(), making
  // frame-exact probes immune to an incidental browser tick between calls.
  stop(): void {
    this.running = false;
  }

  private tick(now: number): void {
    if (!this.running) return;
    const paced = pace(this.acc, now - this.last, this.snap);
    this.last = now;
    this.acc = paced.acc;
    for (let i = 0; i < paced.steps; i++) this.timedUpdate();
    if (paced.steps > 0) this.timedDraw();
    requestAnimationFrame((t) => this.tick(t));
  }

  // Test hook: run n synchronous update steps (and one draw).
  advance(n: number): void {
    for (let i = 0; i < n; i++) this.timedUpdate();
    this.timedDraw();
  }
}
