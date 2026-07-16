import type { PlayerEffects, PlayerEffectHandle } from './player-effects';
import type { Player } from './player';
import type { Rng } from '../core/rng';
import type { Enemy, EnemyBullet } from './types';
import type { AnmRunner } from '../formats/anm';
import type { Renderer } from '../gfx/renderer';
import {
  normalizeNativeAngleF32, NATIVE_PI_F32, NATIVE_TAU_F32, NATIVE_HALF_PI_F32
} from '../core/util';

// Player bomb attack-slot engine + the twelve decoded per-form state
// machines (Th07.exe bomb tick functions 0x407840-0x40cbf0; specs:
// reference/re-specs/spec-bombs-{shared,reimu,marisa,sakuya}.md).
//
// Damage delivery: the exe writes moving attack hitboxes into the
// player+0x9dc array (stride 0x20: pos, radiusX/Y as FULL widths halved at
// test, damage, hitTally), consumed by FUN_0043a980 every frame per enemy —
// an overlapping slot applies its damage value EVERY frame it overlaps.
// Bullet cancellation is the same spatial touch, gated on bomb-active.

export interface AttackSlot {
  poolSlot: number;
  x: number;
  y: number;
  radiusX: number; // FULL widths — halved at the point of test
  radiusY: number;
  damage: number;
  hitTally: number;
  active: boolean;
  source: 'shot' | 'bomb';
}

export interface BombContext {
  player: Player;
  fx: PlayerEffects;
  rng: Rng;
  frame: number; // integer bomb-local frame (exe 16a38)
  elapsed: number; // integer + split fraction (exe 16a38 + 16a34)
  duration: number;
  focused: boolean; // latched at cast (exe 16a24)
  rate: number; // global slow-motion rate
  // ZunTimer::HasTicked equivalent for the shared bomb timer (native
  // BombData gates each form's per-tick writes on bombTimer.HasTicked() —
  // during slow-motion the integer current advances only on carried frames).
  // Optional so bare unit-test contexts default to the rate-1 semantics.
  hasTicked?: boolean;
  enemies: Enemy[];
  enemyBullets: EnemyBullet[];
  playSfx(id: number): void;
  spawnParticles(effectId: number, x: number, y: number, count: number, color: number): void;
  startScreenShake(duration: number, from: number, to: number): void;
  addBulletClearRegion(x: number, y: number, radius: number, growth: number, frames: number): void;
  createBombAnmRunner(scriptId: number): AnmRunner;
}

const MAX_SLOTS = 112; // exe pool size (0x70)
const TAU = Math.PI * 2;

export class BombEngine {
  slots: AttackSlot[] = Array.from({ length: MAX_SLOTS }, (_, poolSlot) => ({
    poolSlot,
    x: 0, y: 0, radiusX: 0, radiusY: 0, damage: 0, hitTally: 0, active: false,
    source: 'bomb'
  }));

  // FUN_0043d8f0 clears only dims.x for all 112 entries at the head of each
  // player tick. Other fields persist until an owner rewrites them.
  beginFrame(): void {
    for (const s of this.slots) {
      s.active = false;
      s.radiusX = 0;
    }
  }

  reset(): void {
    for (const s of this.slots) {
      s.active = false;
      s.radiusX = s.radiusY = s.damage = s.hitTally = 0;
      s.source = 'bomb';
    }
  }

  set(
    i: number,
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    damage: number,
    source: 'shot' | 'bomb' = 'bomb'
  ): AttackSlot {
    const s = this.slots[i];
    s.x = x;
    s.y = y;
    s.radiusX = radiusX;
    s.radiusY = radiusY;
    s.damage = damage;
    s.active = true;
    s.source = source;
    return s;
  }

  clear(i: number): void {
    const s = this.slots[i];
    s.active = false;
    s.radiusX = s.radiusY = s.damage = 0;
  }

  *activeSlots(): IterableIterator<AttackSlot> {
    for (const s of this.slots) if (s.active && s.radiusX > 0) yield s;
  }
}

// Per-entity simulation state shared by the burst-style forms.
interface BombActor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  speed: number;
  accel: number;
  turnRate: number;
  state: number;
  age: number;
}

export class BombRunner {
  private actors: BombActor[] = [];
  private castX = 0;
  private castY = 0;
  private sweepSign = 1;
  private spawnedCount = 0;
  private marisaBBeamVms: AnmRunner[] = [];
  private marisaBBeamAngles: number[] = [];
  private marisaBBeamOriginX = 0;
  private marisaBBeamOriginY = 0;
  // SakuyaA focused: per-knife visual handles for the on-hit script swap.
  private knifeFx: (PlayerEffectHandle | null)[] = [];

  constructor(private engine: BombEngine, private character: string, private focused: boolean) {}

  start(ctx: BombContext): void {
    this.castX = ctx.player.x;
    this.castY = ctx.player.y;
    this.knifeFx.length = 0;
    this.engine.reset();
    // MarisaB unfocused: the sweep direction sign is locked at cast from
    // which half of the playfield the player stood on (spec-bombs-marisa §3).
    this.sweepSign = this.castX >= 192 ? -1 : 1;
    if (this.character === 'marisaB' && !this.focused) {
      this.marisaBBeamVms = [12, 13, 14].map((id) => ctx.createBombAnmRunner(id));
      this.marisaBBeamAngles = [0, 1, 2].map((i) =>
        Math.fround((i * NATIVE_TAU_F32) / 3 - NATIVE_HALF_PI_F32));
      this.marisaBBeamOriginX = ctx.player.x;
      this.marisaBBeamOriginY = ctx.player.y;
    }
    // ReimuB both casts open with the building 2->6 shake (spec-bombs-reimu §5/6).
    if (this.character === 'reimuB') ctx.startScreenShake(60, 2, 6);
  }

  tick(ctx: BombContext): void {
    switch (this.character) {
      case 'reimuA': this.focused ? this.reimuAFocused(ctx) : this.reimuAUnfocused(ctx); break;
      case 'reimuB': this.focused ? this.reimuBFocused(ctx) : this.reimuBUnfocused(ctx); break;
      case 'marisaA': this.focused ? this.marisaAFocused(ctx) : this.marisaAUnfocused(ctx); break;
      case 'marisaB': this.focused ? this.marisaBFocused(ctx) : this.marisaBUnfocused(ctx); break;
      case 'sakuyaA': this.focused ? this.sakuyaAFocused(ctx) : this.sakuyaAUnfocused(ctx); break;
      case 'sakuyaB': this.focused ? this.sakuyaBFocused(ctx) : this.sakuyaBUnfocused(ctx); break;
    }
  }

  draw(r: Renderer, ox: number, oy: number): void {
    if (this.character !== 'marisaB' || this.focused) return;
    for (let i = 0; i < this.marisaBBeamVms.length; i++) {
      r.drawAnmFrame(
        this.marisaBBeamVms[i].spriteFrame(),
        ox + this.marisaBBeamOriginX,
        oy + this.marisaBBeamOriginY,
        { rotation: normalizeNativeAngleF32(this.marisaBBeamAngles[i], NATIVE_HALF_PI_F32) }
      );
    }
  }

  // 霊符「夢想封印」 unfocused — FUN_00407840 (spec-bombs-reimu §3).
  // 8 orbs, frames 12..54 step 6, fanning 45° apart from straight up,
  // mirrored by which half the player cast from. Each decelerates 0.4/f
  // from 15, freezes when speed < -10 (having flown out and swung back),
  // then leaves a 30-frame r256/d2 aftermath that stays as a frozen
  // "landmine" slot. The r256/d400 finisher write is overwritten the same
  // frame in the exe and never lands (§3.4) — reproduced by simply not
  // writing it.
  private reimuAUnfocused(ctx: BombContext): void {
    const f = ctx.frame;
    if (f >= 12 && f <= 54 && f % 6 === 0 && this.actors.length < 8) {
      const i = this.actors.length;
      const mirror = this.castX >= 192 ? -i : i;
      // FUN_00407840 @ all.c:3639-3641 stores the launch heading as float32:
      //   local_8 = ((float)iVar5 * 2π_f32) / 8_f32 − π/2_f32   (stored float)
      //   local_18[4] = (float) FUN_0042fff0(local_8)           (wrap + store)
      // The previous double-precision form (TAU / Math.PI) left orb.angle off
      // by sub-ULP. Math.fround over the float32 constants matches the single
      // x87→float32 store; normalizeNativeAngleF32 is FUN_0042fff0. This is a
      // fidelity correction, but it does not by itself close the later
      // Phantasm replay divergence.
      const angle = normalizeNativeAngleF32(
        Math.fround(mirror * NATIVE_TAU_F32 / 8 - NATIVE_HALF_PI_F32));
      this.actors.push({
        x: ctx.player.x, y: ctx.player.y, vx: 0, vy: 0,
        angle, speed: 15, accel: 0, turnRate: 0, state: 1, age: 0
      });
      // The orb sprite rides its slot (same slot-attached ANM architecture
      // as SakuyaA's knives) — it flies out and swings back with the actor.
      ctx.fx.spawn({ scriptId: 133 + (i & 3), x: ctx.player.x, y: ctx.player.y, follow: this.actors[i] });
      ctx.playSfx(13);
    }
    this.actors.forEach((orb, i) => {
      if (orb.state === 1) {
        // Orb motion is float32 in the exe (FUN_00407840 @ all.c:3656-3706):
        //   speed = (float)(speed - 0.4f*rate)
        //   vx/vy = (float)(cos/sin(angle)*speed)   via FUN_004074e0 (recomputed each frame)
        //   x     = (float)(rate*vx + x)
        // Match the float32 storage so sub-pixel orb positions don't drift — the r=128
        // clear-circle / graze-box boundary otherwise flips a bullet clear-vs-graze.
        // The decrement constant _DAT_0048ec74 is a float32 0.4 (0.40000000596…),
        // not the double literal — the 6e-9 gap flips the f32 speed store at
        // specific points of the decel curve (observed at orb-age 38-39).
        orb.speed = Math.fround(orb.speed - Math.fround(0.4) * ctx.rate);
        orb.vx = Math.fround(Math.cos(orb.angle) * orb.speed);
        orb.vy = Math.fround(Math.sin(orb.angle) * orb.speed);
        if (orb.speed < -10) {
          orb.state = 2;
          orb.vx = orb.vy = 0;
          ctx.playSfx(15);
          ctx.startScreenShake(16, 8, 0);
          // Th07.exe FUN_00407840 orb detonation: FUN_0041b320(6, orb, 8, ...) — the
          // swing-back burst is 8 particles (32 draws), not 12.
          ctx.spawnParticles(6, orb.x, orb.y, 8, 0xffffffff);
          // FUN_0043e7e0(pos, 64, 4.2666669f, 30, 6) allocates an
          // expanding clear circle that survives 31 bullet-manager passes.
          // It is collision-relevant: Phantasm slot 754 is consumed by orb
          // 7's radius ~149 circle before its otherwise-valid graze at
          // update 10541.
          ctx.addBulletClearRegion(orb.x, orb.y, 64, Math.fround(64 / 15), 30);
        }
        if (ctx.hasTicked ?? true) {
          // Native BombData.cpp:231-239: the state-1 damage-row refresh and
          // the r128 clear circle are gated on bombTimer.HasTicked() — during
          // slow-motion they publish only on frames whose timer increment
          // carried. (The speed decrement and the speed<-10 detonation above
          // are NOT gated; they run every frame, rate-scaled.)
          this.engine.set(i, orb.x, orb.y, 48, 48, 8);
          // FUN_0043e7e0 writes a circle into player+0x17dc after the attack
          // slot write on every state-1 tick. With life=0, FUN_0043d8f0
          // retires it at the head of the next player tick: it is a one-frame
          // r128 bullet-clear zone, including the state-1 -> state-2 tick.
          ctx.addBulletClearRegion(orb.x, orb.y, 128, 0, 0);
        }
      } else if (orb.state === 2 && (ctx.hasTicked ?? true)) {
        // Native BombData.cpp:241-251: the state-2 box refresh and counter
        // advance sit in the same HasTicked gate (`else if (state != 0 &&
        // bombTimer.HasTicked())`).
        this.engine.set(i, orb.x, orb.y, 256, 256, 2);
        if (++orb.age > 29) orb.state = 0; // slot stays frozen (exe quirk)
      }
      if (orb.state !== 0) {
        orb.x = Math.fround(ctx.rate * orb.vx + orb.x);
        orb.y = Math.fround(ctx.rate * orb.vy + orb.y);
      }
    });
  }

  // 霊符「夢想封印」 focused — FUN_004082e0 (spec-bombs-reimu §4).
  // 7 homing orbs at frames 80..176 step 16 (the frame-64 slot is skipped
  // by the exe itself); uniform-random launch heading, vector-seek steering
  // capped at 10 px/f toward the live player position; detonates at
  // hitTally > 99 or in the bomb's final 30 frames, leaving a PERSISTENT
  // r256/d400 hitbox while the orb sprite coasts on.
  private reimuAFocused(ctx: BombContext): void {
    const f = ctx.frame;
    if (f >= 80 && f <= 176 && f % 16 === 0 && this.actors.length < 7) {
      // Th07.exe (v1.00b) FUN_004082e0 @ 0x4084d7 passes the random angle
      // and turnParam=8.0 to FUN_004074e0, which stores the full
      // cos/sin(angle)*8 velocity pair as float32. The old unit vector made
      // every homing orb follow a different path. Native wave indices are
      // 1..7 because the frame-64 index 0 branch is explicitly skipped.
      const launch = Math.fround(ctx.rng.range(TAU) - Math.PI);
      this.actors.push({
        x: Math.fround(ctx.player.x), y: Math.fround(ctx.player.y),
        vx: Math.fround(Math.cos(launch) * 8),
        vy: Math.fround(Math.sin(launch) * 8),
        angle: launch, speed: 8 /* turnParam seed */, accel: 0, turnRate: 0, state: 1, age: 0
      });
      ctx.fx.spawn({
        scriptId: 133 + (this.actors.length & 3),
        x: ctx.player.x,
        y: ctx.player.y,
        follow: this.actors[this.actors.length - 1]
      });
      ctx.playSfx(13);
    }
    this.actors.forEach((orb, i) => {
      const slotId = i + 1;
      // Native BombData.cpp:388-446: the focused form's ENTIRE state-1 block
      // — target selection, steering, the 48x48 damage row, the r128 clear
      // circle, and the detonation test — sits inside
      // `if (bombTimer.HasTicked())`; only the rate-scaled position add and
      // the ANM tick run every frame. State 2's counter is gated too.
      if (orb.state === 1 && (ctx.hasTicked ?? true)) {
        const dx = ctx.player.x - orb.x;
        const dy = ctx.player.y - orb.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        let div = Math.fround(dist / (orb.speed / 8));
        if (div < 1) div = 1;
        const rawVx = dx / div + orb.vx;
        const rawVy = dy / div + orb.vy;
        const rawSpeed = Math.fround(Math.sqrt(rawVx * rawVx + rawVy * rawVy)) || 1;
        orb.speed = Math.fround(Math.max(1, Math.min(10, rawSpeed)));
        orb.vx = Math.fround((rawVx * orb.speed) / rawSpeed);
        orb.vy = Math.fround((rawVy * orb.speed) / rawSpeed);
        const slot = this.engine.set(slotId, orb.x, orb.y, 48, 48, 8);
        // Th07.exe (v1.00b) FUN_004082e0 @ 0x40875b: this clear-zone
        // allocation precedes the hit-tally/final-30-frame detonation test,
        // so the transition tick still clears at r128. State 2 does not.
        ctx.addBulletClearRegion(orb.x, orb.y, 128, 0, 0);
        if (slot.hitTally > 99 || ctx.frame >= ctx.duration - 30) {
          orb.state = 2;
          // Persistent detonation landmine (exe §4.4) — set once, then the
          // slot is never revisited; the orb keeps coasting visually.
          this.engine.set(slotId, orb.x, orb.y, 256, 256, 400);
          // Native BombData.cpp:444 SpawnBombEffect(.., 32.0f, 6.6666665f, 15, ..)
          // — detonation clear-circle grows at 20/3 per frame (was 10/3, half-rate).
          ctx.addBulletClearRegion(orb.x, orb.y, 32, Math.fround(20 / 3), 15);
          ctx.playSfx(15);
          ctx.startScreenShake(16, 8, 0);
          ctx.spawnParticles(6, orb.x, orb.y, 12, 0xffffffff);
        }
      }
      if (orb.state !== 0) {
        orb.x = Math.fround(orb.vx * ctx.rate + orb.x);
        orb.y = Math.fround(orb.vy * ctx.rate + orb.y);
        if (orb.state === 2 && (ctx.hasTicked ?? true) && ++orb.age > 29) orb.state = 0;
      }
    });
  }

  // 霊符「封魔陣」 unfocused — FUN_00408f10 (spec-bombs-reimu §5): a cross
  // through the cast point. Four slots reduce to two unique geometries —
  // a 62×448 vertical strip through cast X and a 384×62 horizontal strip
  // through screen-center Y — continuously active at d16 (the exe's odd-
  // frame write gating only halves the cosmetic position refresh).
  private reimuBUnfocused(ctx: BombContext): void {
    this.engine.set(0, this.castX, 224, 62, 448, 16);
    this.engine.set(1, 192, this.castY, 384, 62, 16);
    this.engine.set(2, this.castX, 224, 62, 448, 16);
    this.engine.set(3, 192, this.castY, 384, 62, 16);
  }

  // 霊符「封魔陣」 focused — FUN_004094e0 (spec-bombs-reimu §6): one fixed
  // r256/d18 box at the cast point for the whole bomb; a second 20->0
  // shake fires at frame 60.
  private reimuBFocused(ctx: BombContext): void {
    if (ctx.frame === 60) ctx.startScreenShake(80, 20, 0);
    this.engine.set(0, this.castX, this.castY, 256, 256, 18);
  }

  // 魔符「スターダストレヴァリエ」 unfocused — FUN_00409900
  // (spec-bombs-marisa §3): 8 stars in a compass rose (i·45°) at speed 2
  // from the cast point, each an r128/d8 slot refreshed two of every
  // three frames.
  private marisaAUnfocused(ctx: BombContext): void {
    if (this.actors.length === 0) {
      for (let i = 0; i < 8; i++) {
        const angle = (i * TAU) / 8;
        this.actors.push({
          x: ctx.player.x, y: ctx.player.y,
          vx: Math.cos(angle) * 2, vy: Math.sin(angle) * 2,
          angle, speed: 2, accel: 0, turnRate: 0, state: 1, age: 0
        });
      }
    }
    this.actors.forEach((star, i) => {
      star.x += star.vx * ctx.rate;
      star.y += star.vy * ctx.rate;
      if (ctx.frame % 3 !== 0) this.engine.set(i, star.x, star.y, 128, 128, 8);
      else this.engine.clear(i);
    });
  }

  // 魔符「スターダストレヴァリエ」 focused — FUN_0040a050
  // (spec-bombs-marisa §4): one trail star every 6 frames up to 24, launched
  // in a narrow downward cone (90°±11.25°, speed 5) with an independent
  // upward-cone acceleration ≈0.24/f; r128/d12 until its own tally
  // reaches 80; despawns above y=-256.
  private marisaAFocused(ctx: BombContext): void {
    if (ctx.frame % 6 === 0 && this.actors.length < 24) {
      const down = Math.PI / 2 + (ctx.rng.range(Math.PI / 8) - Math.PI / 16);
      const up = -Math.PI / 2 + (ctx.rng.range(Math.PI / 8) - Math.PI / 16);
      this.actors.push({
        x: ctx.player.x, y: ctx.player.y,
        vx: Math.cos(down) * 5, vy: Math.sin(down) * 5,
        angle: up, speed: 0, accel: 0.24, turnRate: 0, state: 1, age: 0
      });
    }
    this.actors.forEach((star, i) => {
      if (star.state === 0) return;
      star.vx += Math.cos(star.angle) * star.accel * ctx.rate;
      star.vy += Math.sin(star.angle) * star.accel * ctx.rate;
      star.x += star.vx * ctx.rate;
      star.y += star.vy * ctx.rate;
      if (star.y < -256) {
        star.state = 0;
        this.engine.clear(i);
        return;
      }
      const slot = this.engine.slots[i];
      if (slot.hitTally < 80) this.engine.set(i, star.x, star.y, 128, 128, 12);
      else this.engine.clear(i);
    });
  }

  // 恋符「マスタースパーク」 — FUN_0040a910 (spec-bombs-marisa §5): three
  // beams from the live player position at -90°/+30°/+150°, sweeping with
  // an accelerating per-frame delta sign·(elapsed·π)/9000. Six slots per
  // beam begin at d32 and then use the authored beam VM's live
  // spriteHeight*scaleY/5 spacing; r128/d10, no continuing-frame gate.
  private marisaBUnfocused(ctx: BombContext): void {
    // Frame 0 is the setup branch in FUN_0040a910: it loads scripts 12..14
    // but publishes no attack/clear slots and does not tick those VMs.
    if (ctx.frame === 0) return;
    // Th07.exe v1.00b direct fastcall trace at FUN_004459c0:
    //   local20 ECX kind=1, EDX duration=60, stack from=1,to=7
    //   local80 ECX kind=1, EDX duration=100, stack from=24,to=0
    if (ctx.frame === 20) ctx.startScreenShake(60, 1, 7);
    if (ctx.frame === 80) ctx.startScreenShake(100, 24, 0);
    this.marisaBBeamOriginX = ctx.player.x;
    this.marisaBBeamOriginY = ctx.player.y;
    for (let b = 0; b < 3; b++) {
      const delta = Math.fround(
        ((Math.fround(ctx.elapsed) * NATIVE_PI_F32) / 30 / ctx.duration) * this.sweepSign
      );
      const angle = normalizeNativeAngleF32(this.marisaBBeamAngles[b], delta);
      this.marisaBBeamAngles[b] = angle;
      const vm = this.marisaBBeamVms[b];
      const spriteHeight = vm.spriteHeight() ?? 0;
      const spacing = Math.fround((spriteHeight * vm.currentScaleY()) / 5);
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      let distance = 32;
      for (let k = 0; k < 6; k++) {
        const x = Math.fround(cosA * distance + ctx.player.x);
        const y = Math.fround(sinA * distance + ctx.player.y);
        this.engine.set(b * 6 + k, x, y, 128, 128, 10);
        // FUN_0043e7e0(point, 64, 0, 0, 6): the visual sparkle allocation
        // is also the native one-frame circular bullet-clear region.
        ctx.addBulletClearRegion(x, y, 64, 0, 0);
        distance = Math.fround(distance + spacing);
      }
      vm.update(ctx.rate);
    }
  }

  // 恋符「ファイナルスパーク」 — FUN_0040af70 (spec-bombs-marisa §6): one
  // vertical region above the player — pos (192, playerY/2), radius
  // (384, playerY), d23 on three of every four frames.
  private marisaBFocused(ctx: BombContext): void {
    if (ctx.frame === 20) ctx.startScreenShake(60, 7, 0);
    if (ctx.frame % 4 !== 0) {
      this.engine.set(0, 192, ctx.player.y / 2, 384, ctx.player.y, 23);
    } else {
      this.engine.clear(0);
    }
  }

  // 幻符「殺人ドール」 unfocused — FUN_0040b440 (spec-bombs-sakuya §2):
  // up to 5 knives/frame during frames 60-120 (96 cap), each launched from
  // the cast snapshot at a uniform-random angle, speed [5.5,11.5) with
  // uncapped accel [0.1,0.2) and a gentle random curve (±1.8°/f);
  // r24/d10 until its slot tallies 30 damage; culled 32px off-screen.
  private sakuyaAUnfocused(ctx: BombContext): void {
    const f = ctx.frame;
    // Fixed 96-slot pool (exe 0x60 slots, stride 0x1428). Knives that fly
    // off-screen FREE their slot, and while the spawn window is open the
    // 5-per-frame budget refills free slots (all.c:4847-4872) — the vanilla
    // look is a continuous knife hose replenishing for a full second, not
    // one 96-knife burst.
    if (this.actors.length === 0) {
      for (let i = 0; i < 96; i++) {
        this.actors.push({ x: 0, y: 0, vx: 0, vy: 0, angle: 0, speed: 0, accel: 0, turnRate: 0, state: 0, age: 0 });
      }
    }
    if (f >= 60 && f <= 120) {
      let budget = 5;
      for (let i = 0; i < 96 && budget > 0; i++) {
        const k = this.actors[i];
        if (k.state !== 0) continue;
        budget--;
        k.angle = ctx.rng.range(TAU) - Math.PI;
        k.speed = ctx.rng.range(6) + 5.5;
        k.accel = ctx.rng.range(0.1) + 0.1;
        k.turnRate = ctx.rng.range(0.0628) - 0.0314;
        k.x = this.castX + Math.cos(k.angle) * 24;
        k.y = this.castY + Math.sin(k.angle) * 24;
        k.vx = k.vy = 0;
        k.state = 1;
        this.engine.slots[i].hitTally = 0;
        this.knifeFx[i] = ctx.fx.spawnHandle({
          scriptId: 5 + (i & 1),
          x: k.x,
          y: k.y,
          follow: k,
          followRotate: true
        });
      }
    }
    this.actors.forEach((k, i) => {
      if (k.state === 0) return;
      const slot = this.engine.slots[i];
      k.angle += k.turnRate * ctx.rate;
      k.speed += k.accel * ctx.rate;
      if (slot.hitTally < 30) {
        k.vx = Math.cos(k.angle) * k.speed;
        k.vy = Math.sin(k.angle) * k.speed;
        k.x += k.vx * ctx.rate;
        k.y += k.vy * ctx.rate;
        this.engine.set(i, k.x, k.y, 24, 24, 10);
      } else if (this.knifeFx[i]) {
        // 30 damage banked: the knife freezes and its ANM swaps to the
        // impact script 0x460 (all.c:4897-4899), same as the focused form.
        this.knifeFx[i]!.setScript(96);
        this.knifeFx[i] = null;
      }
      if (k.x < -32 || k.x > 416 || k.y < -32 || k.y > 480) {
        k.state = 0; // frees the slot for the spawner (and culls the fx)
        this.knifeFx[i] = null;
        this.engine.clear(i);
      }
    });
  }

  // 幻符「殺人ドール」 focused — FUN_0040bbb0 (spec-bombs-sakuya §3):
  // 96 knives in a deterministic ring (pairs every 2 frames, frames
  // 20-114) anchored to the LIVE player at spawn; fly 30 frames, spin in
  // place -9°/f for exactly one revolution (ages 30-69), re-aim at the
  // nearest enemy at age 70 with speed reset to 14, then fly uncapped;
  // r24/d22 until the slot's first hit (the hitbox then stays, per exe).
  private sakuyaAFocused(ctx: BombContext): void {
    const f = ctx.frame;
    if (f >= 20 && f < 116 && f % 2 === 0 && this.actors.length < 96) {
      for (let n = 0; n < 2 && this.actors.length < 96; n++) {
        const i = this.actors.length;
        // Exe FUN_0040bbb0 @ all.c:5007/5016: slots i and i+48 arm on the
        // same frame ((i % 48)*2 + 20) and BOTH take the same ring angle
        // (i % 48)*2π/48 − π — the pair separates radially through its two
        // random speeds, not by sitting on opposite sides.
        const angle = ((i % 48) * TAU) / 48 - Math.PI;
        this.actors.push({
          x: ctx.player.x + Math.cos(angle) * 24,
          y: ctx.player.y + Math.sin(angle) * 24,
          vx: 0, vy: 0, angle,
          speed: ctx.rng.range(1) + 0.5,
          accel: ctx.rng.range(0.1) + 0.03,
          turnRate: -0.15707964,
          state: 1, age: 0
        });
        // Visual rides the slot (exe FUN_00403f50 attaches script
        // 0x407/0x408 to the slot; FUN_0044aa20 runs it there each frame).
        this.knifeFx[i] = ctx.fx.spawnHandle({
          scriptId: 7 + (i & 1),
          x: this.actors[i].x,
          y: this.actors[i].y,
          follow: this.actors[i],
          followRotate: true
        });
      }
    }
    // Shared nearest-enemy metric: horizontally closest to the player
    // (the exe reads the same player+0x2428 cache the homing shots use).
    let target: Enemy | null = null;
    let bestDx = Infinity;
    for (const e of ctx.enemies) {
      if (!e.ecl.interactable || e.ecl.invisible || e.dead || !e.ecl.canTakeDamage || !e.ecl.shotCollision) continue;
      const dx = Math.abs(e.x - ctx.player.x);
      if (dx < bestDx) {
        bestDx = dx;
        target = e;
      }
    }
    this.actors.forEach((k, i) => {
      if (k.state === 0) return;
      k.age++;
      if (k.age < 30 || k.age >= 70) {
        if (k.age === 70) {
          if (target) k.angle = Math.atan2(target.y - k.y, target.x - k.x);
          k.speed = 14;
        }
        k.speed += k.accel * ctx.rate;
        k.vx = Math.cos(k.angle) * k.speed;
        k.vy = Math.sin(k.angle) * k.speed;
      } else {
        // Spin phase: hold position, rotate -9°/frame (one full turn).
        k.angle += k.turnRate * ctx.rate;
        k.vx = k.vy = 0;
      }
      const slot = this.engine.slots[i];
      if (slot.hitTally === 0) {
        k.x += k.vx * ctx.rate;
        k.y += k.vy * ctx.rate;
        this.engine.set(i, k.x, k.y, 24, 24, 22);
      } else if (this.knifeFx[i]) {
        // First hit (exe all.c:5089-5092): the knife stops and its ANM
        // swaps to the impact script 0x460 (player-anm id 96, a sparse
        // declared id in player02.anm), with a pink burst particle.
        this.knifeFx[i]!.setScript(96);
        this.knifeFx[i] = null;
        ctx.spawnParticles(0, k.x, k.y, 4, 0xffff80ff);
      }
    });
  }

  // 時符「プライベートスクウェア」 unfocused — FUN_0040c620
  // (spec-bombs-sakuya §4): the whole-playfield time stop. Bullet-freeze
  // pulses at frames 0/60/120; one enormous static box at the playfield
  // center (352×416, d3) on every fourth frame from frame 32.
  private sakuyaBUnfocused(ctx: BombContext): void {
    if (ctx.frame === 0 || ctx.frame === 60 || ctx.frame === 120) this.freezeBullets(ctx);
    // FUN_0040c620 stamps damage row 0 only on %4 frames past 29, and
    // Player::UpdateBombProjectiles zeroes every damage row's size at the
    // head of EACH player tick — so the 352x416/d3 box really is live one
    // frame in four (spec-bombs-sakuya §4.2's "always-on" reading missed
    // the per-tick zeroing). The unfocused cast publishes NO bullet-clear
    // regions: its only bullet interaction is the three freezes above.
    if (ctx.frame >= 32 && ctx.frame % 4 === 0) this.engine.set(0, 192, 224, 352, 416, 3);
    else this.engine.clear(0);
  }

  // 時符「プライベートスクウェア」 focused — FUN_0040cbf0
  // (spec-bombs-sakuya §5): freeze pulses at frames 40/100; a single
  // 160×160 d1 box that chases the player on a spring
  // (accel = (player-head)/1700), refreshed every frame.
  private sakuyaBFocused(ctx: BombContext): void {
    if (ctx.frame === 40 || ctx.frame === 100) this.freezeBullets(ctx);
    if (this.actors.length === 0) {
      this.actors.push({
        x: ctx.player.x, y: ctx.player.y, vx: 0, vy: 0,
        angle: 0, speed: 0, accel: 0, turnRate: 0, state: 1, age: 0
      });
    }
    const head = this.actors[0];
    // FUN_0040cbf0 per-frame order (all.c:5382-5443): the hitbox block runs
    // FIRST with the trail head's PRE-step position — FUN_0043e7e0(head,
    // 96.0, 0, 0, 6) publishes a one-pass r96 bullet-clear circle into the
    // player+0x17dc pool, then damage row 0 gets the 160x160/d1 box at the
    // same point. Only afterwards does the spring integrate toward the
    // player. (FUN_0043e7e0 is the clear-region allocator, not a particle
    // spawner — the bullet cancel comes from THIS call, not the damage box.)
    ctx.addBulletClearRegion(head.x, head.y, 96, 0, 0);
    this.engine.set(0, head.x, head.y, 160, 160, 1);
    head.vx += ((ctx.player.x - head.x) / 1700) * ctx.rate * ctx.rate;
    head.vy += ((ctx.player.y - head.y) / 1700) * ctx.rate * ctx.rate;
    head.x += head.vx * ctx.rate;
    head.y += head.vy * ctx.rate;
  }

  // FUN_00425f10: SakuyaB's time-stop pulse — zero every live enemy
  // bullet's motion cluster outright (velocity, nominal speed, active
  // ex-behaviors). Not a cancel: the bullets stay alive and lethal.
  private freezeBullets(ctx: BombContext): void {
    for (const b of ctx.enemyBullets) {
      if (b.dead) continue;
      b.vx = 0;
      b.vy = 0;
      b.speed = 0;
      b.exFlags = 0;
    }
    ctx.playSfx(0x20); // se_border — the time-stop snap
  }
}
