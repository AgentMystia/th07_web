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

  constructor(private client: LoopClient) {}

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
      this.client.update();
      steps++;
      this.acc -= STEP_MS;
    }
    // Never bank more than one step of debt — avoids a catch-up spiral
    // after long stalls (tab switch etc).
    if (this.acc > STEP_MS) this.acc = STEP_MS;
    if (steps > 0) this.client.draw();
    requestAnimationFrame((t) => this.tick(t));
  }

  // Test hook: run n synchronous update steps (and one draw).
  advance(n: number): void {
    for (let i = 0; i < n; i++) this.client.update();
    this.client.draw();
  }
}
