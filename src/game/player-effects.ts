import { AnmRunner, type Anm } from '../formats/anm';
import type { Renderer } from '../gfx/renderer';

// Script-driven player effect layer (bomb visuals). Each entry runs one
// script from the character's playerXX.anm at a playfield-space anchor the
// host may drift (vx/vy); the scripts themselves carry the real animation
// (scale/fade/blend/offset wander) — see the bomb choreography notes in
// stage-scene.ts. Entries die when their runner removes itself or their ttl
// lapses (several bomb scripts end in `static` and never self-remove).

export interface PlayerEffectSpawn {
  scriptId: number;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  // Frames to wait before the script starts running.
  delay?: number;
  // Hard cull age in frames (counted from the script start), for scripts
  // that end in `static` instead of removing themselves.
  ttl?: number;
  // Fixed draw rotation (e.g. knives oriented along their drift vector).
  rotation?: number;
  // Track a live bomb actor: the entry follows its position (and, with
  // followRotate, its heading) every frame, and culls when the actor's
  // state clears — the exe attaches each attack slot's ANM to the slot
  // itself and draws it at the slot position (FUN_00403f50/FUN_0044aa20).
  follow?: { x: number; y: number; angle: number; state: number };
  followRotate?: boolean;
}

export interface PlayerEffectHandle {
  // Swap the running script (exe FUN_00403f50 re-arm — e.g. SakuyaA's
  // knives switch to the impact animation on their first hit).
  setScript(id: number): void;
  release(): void;
}

interface Entry {
  runner: AnmRunner | null;
  scriptId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  delay: number;
  ttl: number;
  rotation: number | undefined;
  age: number;
  follow?: { x: number; y: number; angle: number; state: number };
  followRotate?: boolean;
}

export class PlayerEffects {
  private entries: Entry[] = [];

  constructor(private anm: Anm) {}

  spawn(s: PlayerEffectSpawn): void {
    this.entries.push({
      runner: null,
      scriptId: s.scriptId,
      x: s.x,
      y: s.y,
      vx: s.vx ?? 0,
      vy: s.vy ?? 0,
      delay: s.delay ?? 0,
      ttl: s.ttl ?? Infinity,
      rotation: s.rotation,
      age: 0,
      follow: s.follow,
      followRotate: s.followRotate
    });
  }

  // Spawn returning a handle for entries whose script the bomb code needs
  // to re-arm later (SakuyaA impact swap).
  spawnHandle(s: PlayerEffectSpawn): PlayerEffectHandle {
    this.spawn(s);
    const entry = this.entries[this.entries.length - 1];
    return {
      setScript: (id: number) => {
        entry.scriptId = id;
        entry.runner = null; // re-arms on the next update
      },
      release: () => {
        entry.age = entry.ttl = 0;
      }
    };
  }

  update(rate = 1): void {
    for (const e of this.entries) {
      if (e.follow) {
        if (e.follow.state === 0) {
          e.age = e.ttl = 0;
          continue;
        }
        e.x = e.follow.x;
        e.y = e.follow.y;
        if (e.followRotate) e.rotation = e.follow.angle + Math.PI / 2;
      }
      if (e.delay > 0) {
        e.delay -= rate;
        continue;
      }
      if (!e.runner) {
        // The AnmRunner constructor executes the script's time-0
        // instructions; the first update comes next frame.
        if (this.anm.hasScript(e.scriptId)) e.runner = new AnmRunner(this.anm, e.scriptId);
        else e.age = e.ttl = 0; // unknown script: cull quietly
        continue;
      }
      e.runner.update(rate);
      e.x += e.vx * rate;
      e.y += e.vy * rate;
      e.age += rate;
    }
    let w = 0;
    for (const e of this.entries) {
      const dead = (e.runner && e.runner.removed) || e.age >= e.ttl;
      if (!dead) this.entries[w++] = e;
    }
    this.entries.length = w;
  }

  // Fires an ANM interrupt on every running entry (bomb-end fade-outs use
  // interrupt label 1 in the player bomb scripts).
  interruptAll(label: number): void {
    for (const e of this.entries) e.runner?.interrupt(label);
  }

  clear(): void {
    this.entries.length = 0;
  }

  get active(): boolean {
    return this.entries.length > 0;
  }

  draw(r: Renderer, ox: number, oy: number): void {
    for (const e of this.entries) {
      if (!e.runner) continue;
      const frame = e.runner.spriteFrame();
      if (!frame) continue;
      r.drawAnmFrame(frame, ox + e.x, oy + e.y, e.rotation != null ? { rotation: e.rotation } : {});
    }
  }
}
