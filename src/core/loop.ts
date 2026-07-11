const STEP_MS = 1000 / 60;
const MAX_FRAME_DELTA_MS = 250;

export interface LoopClient {
  update(): void;
  draw(): void;
}

// Fixed 60 FPS timestep with bounded catch-up: when rAF ticks arrive slower
// than 60 Hz (throttling, 48/50 Hz displays, jitter), up to CATCHUP_STEPS
// sim steps run per tick so game speed stays 60 steps/second — the previous
// one-step-per-rAF loop silently ran the whole game slow on any sub-60Hz
// delivery (reported as "player feels too slow"). Draws are skipped on rAF
// ticks that ran no simulation step.
const CATCHUP_STEPS = 3;

export class Loop {
  private last = 0;
  private acc = 0;
  private running = false;
  // Test-only observability (PLAN.md Phase 0 / PERF-001): per-step update()
  // and per-tick draw() wall costs in ms, ring-buffered. Read via the
  // ?test=1 hook; never consulted by the game itself.
  private updateCosts: number[] = [];
  private drawCosts: number[] = [];
  private static readonly COST_RING = 600;

  constructor(private client: LoopClient) {}

  private recordCost(ring: number[], ms: number): void {
    ring.push(ms);
    if (ring.length > Loop.COST_RING) ring.splice(0, ring.length - Loop.COST_RING);
  }

  private timedUpdate(): void {
    const t0 = performance.now();
    this.client.update();
    this.recordCost(this.updateCosts, performance.now() - t0);
  }

  private timedDraw(): void {
    const t0 = performance.now();
    this.client.draw();
    this.recordCost(this.drawCosts, performance.now() - t0);
  }

  frameCosts(): { update: number[]; draw: number[] } {
    return { update: [...this.updateCosts], draw: [...this.drawCosts] };
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
    const delta = Math.min(MAX_FRAME_DELTA_MS, now - this.last);
    this.last = now;
    this.acc += delta;
    let steps = 0;
    while (this.acc >= STEP_MS && steps < CATCHUP_STEPS) {
      this.timedUpdate();
      steps++;
      this.acc -= STEP_MS;
    }
    // Never bank more than one step of debt — avoids a catch-up spiral
    // after long stalls (tab switch etc).
    if (this.acc > STEP_MS) this.acc = STEP_MS;
    if (steps > 0) this.timedDraw();
    requestAnimationFrame((t) => this.tick(t));
  }

  // Test hook: run n synchronous update steps (and one draw).
  advance(n: number): void {
    for (let i = 0; i < n; i++) this.timedUpdate();
    this.timedDraw();
  }
}
