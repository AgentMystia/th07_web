import { Sht, type ShtShot } from '../formats/sht';
import { Anm, AnmRunner } from '../formats/anm';
import { TH07_DATA } from '../data/th07-data';
import { clamp } from '../core/util';
import type { InputFrame } from '../core/input';

// Player implementation driven by the original ply*.sht data files: movement
// speeds, hitbox, item radii, PoC line, and the per-power shooter tables all
// come from the game data. Bomb behavior is a functionally-accurate first
// pass (damage/duration/invulnerability), visuals to be refined.

export type CharacterId = 'reimuA' | 'reimuB' | 'marisaA' | 'marisaB' | 'sakuyaA' | 'sakuyaB';

export const CHARACTERS: Record<CharacterId, { family: 0 | 1 | 2; name: string; shtBase: string; anmKey: 'player00' | 'player01' | 'player02' }> = {
  // The deathbomb window (frames you may still bomb after being hit before
  // actually dying) is read from each character's .sht data (deathbombWindow,
  // int32 at header offset 8) rather than hardcoded here: it's 15 for Reimu,
  // 8 for Marisa, 6 for Sakuya, matching independently-documented PCB values.
  reimuA: { family: 0, name: 'Reimu A', shtBase: 'ply00a', anmKey: 'player00' },
  reimuB: { family: 0, name: 'Reimu B', shtBase: 'ply00b', anmKey: 'player00' },
  marisaA: { family: 1, name: 'Marisa A', shtBase: 'ply01a', anmKey: 'player01' },
  marisaB: { family: 1, name: 'Marisa B', shtBase: 'ply01b', anmKey: 'player01' },
  sakuyaA: { family: 2, name: 'Sakuya A', shtBase: 'ply02a', anmKey: 'player02' },
  sakuyaB: { family: 2, name: 'Sakuya B', shtBase: 'ply02b', anmKey: 'player02' }
};

// Th07.exe per-character bomb functions (exe-bombs.md §2, addresses
// 0x407840-0x40cbf0): [duration, invulnTotal, speedMult] keyed by
// character and focus-state AT CAST. invulnTotal = the exe's invuln
// seed (already includes the grace beyond the bomb's own duration).
const BOMB_PARAMS: Record<CharacterId, { unfocused: [number, number, number]; focused: [number, number, number] }> = {
  reimuA:  { unfocused: [140, 200, 1.0], focused: [300, 360, 0.6] },
  reimuB:  { unfocused: [140, 200, 1.0], focused: [190, 250, 0.4] },
  marisaA: { unfocused: [200, 250, 1.0], focused: [260, 310, 0.4] },
  marisaB: { unfocused: [300, 300, 0.2], focused: [340, 390, 0.2] },
  sakuyaA: { unfocused: [160, 210, 1.0], focused: [250, 290, 0.3] },
  sakuyaB: { unfocused: [160, 260, 2.0], focused: [300, 420, 1.5] }
};

// The game assigns the player ANM a sprite-id base of 1024; SHT sprite
// fields are global ids (1088+ = local sprite 64+).
export const PLAYER_SPRITE_BASE = 1024;

export interface PlayerBullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  speed: number;
  damage: number;
  shotType: number;
  // ShtShot.funcs[0], the spawn-time behavior selector: 4 = aim at an enemy
  // at spawn (SakuyaA focused); 5 = SakuyaB orbit-angle bank.
  behaviorFunc: number;
  hitboxW: number;
  hitboxH: number;
  sfxId: number; // from ShtShot.sfxId; playback not wired up (stage-scene.ts uses a fixed fire sound instead)
  age: number;
  state: 'fired' | 'collided';
  hitAge: number;
  // Per-shot ANM VM (Th07.exe: SHT `sprite` is a global ANM script id at
  // player base 1024; FUN_0043a290 ticks the embedded VM each frame and the
  // bullet dies when its script ends). Scripts carry the vanilla alpha/
  // scale/spin/auto-rotate; the impact switch re-arms the VM with script
  // sprite+0x20 (FUN_0043a980 @ 0x43aa8c: slot+0x1d8 += 0x20).
  runner: AnmRunner;
  impactScript: number;
  rect: { x: number; y: number; w: number; h: number; imageKey: string };
  dead?: boolean;
  // Which option fired this shot (0 = player) and the record's own x offset —
  // MarisaB's persistent lasers (types 4/5) re-anchor to these every frame.
  orb: number;
  anchorX: number;
  // Per-frame vertical sprite stretch for the beam types (exe writes the VM
  // scaleY directly: optionY/14 resp. (playerY+64)/14 — sprite 70 is 14px).
  scaleYOverride?: number;
  // Type 5 beam-history ring (up to 16 previous beam centers); each sample
  // is a damage-1 helper box and an alpha-faded ghost draw.
  history?: { x: number; y: number }[];
  // Beam release-fade request (exe slot+0x1c6): the ANM VM only consumes the
  // interrupt while parked at its waitInt checkpoint, so the request re-tries
  // each frame until delivered (spec-marisab-beams.md §0.4).
  fadePending?: boolean;
}

// Option (orb) offsets relative to the player; fire origins for orb shots.
// Th07.exe FUN_0043be00 option state machine (per-state constants re-read
// 2026-07: settled unfocused = (∓24, 0), settled focused = (∓8, −32);
// cross-validated vs the MarisaB laser gates (state 1 vs 3) and SakuyaB's
// orbit rest point. Overturns the earlier 0x43cb30 (∓32,+8) misread —
// see reference/re-specs/exe-player-shot.md §4. Tween stays 8f, x linear,
// y quadratic.
const ORB_OFFSETS = {
  unfocused: { 1: { x: -24, y: 0 }, 2: { x: 24, y: 0 } },
  focused: { 1: { x: -8, y: -32 }, 2: { x: 8, y: -32 } }
} as const;

// Frames to glide between the unfocused/focused layouts on a focus-state
// change, and the interpolation formula, both CONFIRMED directly from the
// exe's tween state machine (fcn.0043be00 @ 0x43ca0b-0x43ca56): x eases
// LINEARLY in t while y eases QUADRATICALLY in t*t -- the two axes use
// different easing. t = frame / GLIDE_FRAMES, with an internal frame
// counter compared against 8 @ 0x43ca61 (fdiv by 0x48eacc = 8.0 @
// 0x43ca1d). The live instance decoded had fromY=24/toY=8, producing
// exactly y = 24 - 16*t*t (fmul 0x48ead4=32.0 @ 0x43ca2f, fadd
// 0x48ed44=-32.0 @ 0x43ca35 for x; fmul 0x48ed68=-16.0 @ 0x43ca4d, fadd
// 0x48ec78=24.0 @ 0x43ca50 for y) -- i.e. lerp(fromX,toX,t) and
// lerp(fromY,toY,t*t) in general.
const GLIDE_FRAMES = 8;

// Th07.exe FUN_0043a820 @ 0x43a820: the shot-cadence counter is hard-
// capped at 30 (CMP 0x1e @ 0x43a8d5) and re-armed to 0 while shoot is
// held — a 30-frame cycle. (Priw8's external doc said 60; direct exe
// disassembly outranks it per AGENTS.md §2. Max data delay is 20.)
const SHOT_CYCLE = 30;

// Player spawn / lifecycle, decoded from Th07.exe (v1.00b). The exe drives
// the player through a state byte at player+0x2408 (dispatcher fcn.0043eef0):
//   0 normal       controllable, vulnerable.
//   1 materialize  30-frame respawn-in (fcn.0043e170): scaleX 0->1, scaleY
//                  3->1, alpha 0->255, input locked; exits to state 3.
//   2 dying        deathbomb window + 30-frame death clock (fcn.0043dca0).
//   3 invuln       countdown (fcn.0043e2e0); sprite dark-tinted 0x404040 on
//                  frames where (timer & 7) < 2.
// Player::Init (fcn.0043f320 @ 0x43f320) spawns directly at the spawn point
// and preloads the materialize timer past its 0x1d threshold, so stage start
// SKIPS the materialize and enters a 240-frame (0xf0) invulnerability window.
// There is NO entrance fly-in in the original: the player is simply present,
// invulnerable. Respawn after death (die()) DOES run the materialize in place.
export const SPAWN_X = 192;
// y = fieldH - 64 (Init: DAT_00625850 - 64.0 @ 0x43f38a, 64.0 = rdata
// 0x48eb68); fieldH = 448 -> 384.
export const SPAWN_Y = 384;
// fcn.0043e170: materialize ramps over 30 frames (threshold 0x1d, divisor
// 30.0 = rdata 0x48eb60); at frame 30 it hands off to a 240-frame (0xf0)
// invuln window (fcn.0043e2e0).
const MATERIALIZE_FRAMES = 30;
const SPAWN_INVULN_FRAMES = 240;
// fcn.0043dca0 (+0x23f8==0 branch): after the deathbomb window lapses, a
// 30-frame in-place death squish (scaleX 1->0, scaleY 1->4) plays BEFORE the
// respawn teleport + materialize.
const DEATH_SQUISH_FRAMES = 30;

export class Player {
  x = SPAWN_X;
  y = SPAWN_Y;
  readonly character: CharacterId;
  readonly unfocused: Sht;
  readonly focused: Sht;
  readonly anm: Anm;
  focusHeld = false;
  // Frames elapsed since the last focus-state toggle, saturating at
  // GLIDE_FRAMES once the orb glide has settled; see orbOffset().
  private focusGlideFrame = GLIDE_FRAMES;
  // Th07.exe SakuyaB-only option orbit (exe-player-shot.md §7): accumulator
  // at player+0xb7e58; rest = -PI/2; strafe steers by vx*PI/200 per frame;
  // idle returns at 2*PI/100 per frame with snap inside PI/100; clamped to
  // [-7*PI/10, -3*PI/10] (±36° around straight up).
  orbitAngle = -Math.PI / 2;
  // This frame's horizontal displacement (dx*speed from move()); 0 when not
  // strafing. Feeds the SakuyaB orbit steer.
  private lastVx = 0;
  shooting = false;
  // -1 while not shooting so that the first held frame lands on fireFrame 0
  // (see update()): a shot with delay 0 must fire on the very press frame,
  // not "interval" frames later.
  fireFrame = -1;
  private fireFrameFrac = 0;
  bullets: PlayerBullet[] = [];
  // MarisaB persistent-laser slot tracker (exe player+0x169c4/+0x169d0
  // 3-entry array, exe-player-shot.md §2.2): at most one live laser bullet
  // per record slot id (the record's `delay` field). timer counts down each
  // frame; release/bomb/dialogue clamp it; <71 arms the ANM fade.
  laserSlots: ({ bullet: PlayerBullet; timer: number; fading: boolean } | null)[] = [null, null, null];
  lives = 2;
  bombs = 3;
  power = 0;
  invulnFrames = 0;
  deathTimer = -1; // counts down the deathbomb window when hit
  // -1 when idle; 0..DEATH_SQUISH_FRAMES during the post-death squish (exe
  // state 2, fcn.0043dca0): scaleX=1-t, scaleY=1+3t, in place at the death loc.
  dyingFrame = -1;
  // -1 when idle; 0..MATERIALIZE_FRAMES during the respawn materialize (exe
  // state 1, fcn.0043e170): scaleX=t, scaleY=3-2t, alpha=t, t=frame/30.
  materializeFrame = -1;
  bombTimer = 0;
  bombInvuln = 0;
  // Latched from BOMB_PARAMS at cast; multiplies move speed while bombTimer>0.
  // SakuyaB legitimately exceeds 1.0. Reset to 1.0 when the bomb ends.
  bombSpeedMult = 1.0;
  // Focus state latched at cast (exe player+0x16a24) — selects which of the
  // two per-character bomb forms runs for the WHOLE bomb; toggling focus
  // mid-bomb must not change it.
  bombFocused = false;
  runner: AnmRunner;
  private poseState: 'idle' | 'left' | 'right' = 'idle';

  constructor(character: CharacterId, anms: Record<string, Anm>) {
    this.character = character;
    const spec = CHARACTERS[character];
    const sht = TH07_DATA.sht as Record<string, string>;
    this.unfocused = new Sht(sht[spec.shtBase]);
    this.focused = new Sht(sht[`${spec.shtBase}s`]);
    this.anm = anms[spec.anmKey];
    this.bombs = Math.trunc(this.unfocused.bombs);
    this.runner = new AnmRunner(this.anm, 0);
    // Stage start skips materialize (Init preloads its timer past threshold)
    // and enters the 240-frame spawn invulnerability directly
    // (fcn.0043f320 -> fcn.0043e2e0). The player is simply present, not flying in.
    this.invulnFrames = SPAWN_INVULN_FRAMES;
  }

  get sht(): Sht {
    return this.focusHeld ? this.focused : this.unfocused;
  }

  get hitboxHalf(): number {
    // sht hitbox/grazebox are FULL widths; the exe halves them at point of use
    // (rdata 2.0 @ 0x48eac0). Reimu hitbox 1.65 full => 0.825 half.
    return this.sht.hitbox / 2;
  }

  get grazeboxHalf(): number {
    return this.sht.grazebox / 2;
  }

  get alive(): boolean {
    // Not hittable/firable during the deathbomb window, the death squish, or
    // the respawn materialize (exe states 2/1); the invuln window (state 3) IS
    // alive.
    return this.deathTimer < 0 && this.dyingFrame < 0 && this.materializeFrame < 0;
  }

  get controllable(): boolean {
    // Input is locked during the deathbomb window, the death squish, and the
    // respawn materialize; the spawn/respawn invuln window itself is
    // controllable.
    return this.deathTimer < 0 && this.dyingFrame < 0 && this.materializeFrame < 0;
  }

  // Render transform for the death squish (exe state 2). null when not dying;
  // otherwise scaleX=1-t, scaleY=1+3t (fcn.0043dca0), t=frame/30.
  dyingTransform(): { scaleX: number; scaleY: number } | null {
    if (this.dyingFrame < 0) return null;
    const t = this.dyingFrame / DEATH_SQUISH_FRAMES;
    return { scaleX: 1 - t, scaleY: 1 + 3 * t };
  }

  // Render transform for the respawn materialize (exe state 1). null when not
  // materializing; otherwise the exe's ramps (fcn.0043e170: t=frame/30,
  // scaleX=t, scaleY=3-2t, alpha=t).
  materializeTransform(): { scaleX: number; scaleY: number; alpha: number } | null {
    if (this.materializeFrame < 0) return null;
    const t = this.materializeFrame / MATERIALIZE_FRAMES;
    return { scaleX: t, scaleY: 3 - 2 * t, alpha: t };
  }

  // `rate` = global slow-motion rate: movement/orbit scale directly, the
  // player-side timers accumulate fractionally (spec-slowmo.md §3.1/§3.2).
  update(input: InputFrame, rate = 1): void {
    const focused = input.held.has('focus');
    if (focused !== this.focusHeld) {
      this.focusHeld = focused;
      this.focusGlideFrame = 0;
    } else if (this.focusGlideFrame < GLIDE_FRAMES) {
      this.focusGlideFrame += rate;
    }
    if (this.invulnFrames > 0) this.invulnFrames = Math.max(0, this.invulnFrames - rate);
    if (this.bombInvuln > 0) this.bombInvuln = Math.max(0, this.bombInvuln - rate);
    if (this.bombTimer > 0) {
      this.bombTimer = Math.max(0, this.bombTimer - rate);
      if (this.bombTimer === 0) this.bombSpeedMult = 1.0;
    }
    if (this.materializeFrame >= 0) {
      // Respawn materialize (fcn.0043e170): ramp scale/alpha IN PLACE over 30
      // frames, then enter the 240-frame invuln window. No movement/firing.
      if (++this.materializeFrame >= MATERIALIZE_FRAMES) {
        this.materializeFrame = -1;
        this.invulnFrames = SPAWN_INVULN_FRAMES;
      }
    }
    if (this.controllable) this.move(input, rate);
    else this.lastVx = 0;
    this.shooting = input.held.has('shoot') && this.controllable;
    if (this.shooting) {
      // Shot cadence is a split counter at the global rate (exe
      // FUN_0043a820 via FUN_00436acc). The press frame re-arms to 0
      // immediately (FUN_0043a930) so delay-0 shooters fire on it.
      if (this.fireFrame < 0) {
        this.fireFrame = 0;
        this.fireFrameFrac = 0;
      } else if (rate > 0.99) {
        this.fireFrame = (this.fireFrame + 1) % SHOT_CYCLE;
      } else {
        this.fireFrameFrac += rate;
        if (this.fireFrameFrac >= 1) {
          this.fireFrameFrac -= 1;
          this.fireFrame = (this.fireFrame + 1) % SHOT_CYCLE;
        }
      }
    } else {
      this.fireFrame = -1;
      this.fireFrameFrac = 0;
    }
    this.updatePose(input);
    this.runner.update(rate);
    const vx = this.lastVx;
    if (vx === 0) {
      if (Math.abs(this.orbitAngle - -Math.PI / 2) <= Math.PI / 100) this.orbitAngle = -Math.PI / 2;
      else this.orbitAngle += (this.orbitAngle < -Math.PI / 2 ? 1 : -1) * (2 * Math.PI / 100) * rate;
    } else {
      this.orbitAngle += vx * Math.PI / 200;
      this.orbitAngle = Math.min(-3 * Math.PI / 10, Math.max(-7 * Math.PI / 10, this.orbitAngle));
    }
  }

  private move(input: InputFrame, rate = 1): void {
    const sht = this.sht;
    let dx = 0;
    let dy = 0;
    if (input.held.has('left')) dx -= 1;
    if (input.held.has('right')) dx += 1;
    if (input.held.has('up')) dy -= 1;
    if (input.held.has('down')) dy += 1;
    const diagonal = dx !== 0 && dy !== 0;
    const baseSpeed = diagonal
      ? (this.focusHeld ? sht.diagFocusedSpeed : sht.diagSpeed)
      : (this.focusHeld ? sht.focusedSpeed : sht.speed);
    // Bombs latch a per-character speed multiplier (BOMB_PARAMS); SakuyaB
    // legitimately exceeds 1.0 — NOT clamped (exe-bombs.md §2).
    const speed = baseSpeed * (this.bombTimer > 0 ? this.bombSpeedMult : 1);
    // Th07.exe (v1.00b) Player::Update clamp @ 0x43c3cc / 0x43c430: field-local
    // x∈[0,384], y∈[0,448] (full playfield). Mins DAT_00625854/858 = 0; ranges
    // DAT_0062585c/860 = 384/448 (confirmed via FUN_0041de20 @ 0x41dfeb/0x41e016).
    // exe FUN_0043be00: velocity = inputDir * speed * DAT_0056baa8.
    this.x = clamp(this.x + dx * speed * rate, 0, 384);
    this.y = clamp(this.y + dy * speed * rate, 0, 448);
    this.lastVx = dx * speed * rate;
  }

  private updatePose(input: InputFrame): void {
    const movingLeft = input.held.has('left') && !input.held.has('right');
    const movingRight = input.held.has('right') && !input.held.has('left');
    const pose = movingLeft ? 'left' : movingRight ? 'right' : 'idle';
    if (pose === this.poseState) return;
    this.poseState = pose;
    // playerXX.anm scripts: 0 idle, 1 bank left, 2 bank right.
    const script = pose === 'left' ? 1 : pose === 'right' ? 2 : 0;
    if (this.anm.hasScript(script)) this.runner = new AnmRunner(this.anm, script);
  }

  // Fires shooter entries whose cadence matches this frame; called once per
  // frame while the shoot button is held.
  orbOffset(orb: 1 | 2): { x: number; y: number } {
    if (this.character === 'sakuyaB') {
      // exe: unfocused = diametric pair on r=24 at φ=orbitAngle+π/2;
      // focused = tight cluster at orbitAngle ∓ π/14; 8f linear glide between.
      const a = this.orbitAngle;
      const unf = orb === 1
        ? { x: -24 * Math.cos(a + Math.PI / 2), y: -24 * Math.sin(a + Math.PI / 2) }
        : { x: 24 * Math.cos(a + Math.PI / 2), y: 24 * Math.sin(a + Math.PI / 2) };
      const foc = {
        x: 24 * Math.cos(a + (orb === 1 ? -1 : 1) * Math.PI / 14),
        y: 24 * Math.sin(a + (orb === 1 ? -1 : 1) * Math.PI / 14)
      };
      const to = this.focusHeld ? foc : unf;
      if (this.focusGlideFrame >= GLIDE_FRAMES) return to;
      const from = this.focusHeld ? unf : foc;
      const t = this.focusGlideFrame / GLIDE_FRAMES;
      // simplified straight lerp, exe uses target-endpoint forms; visual nicety only
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    }
    const to = ORB_OFFSETS[this.focusHeld ? 'focused' : 'unfocused'][orb];
    if (this.focusGlideFrame >= GLIDE_FRAMES) return to;
    const from = ORB_OFFSETS[this.focusHeld ? 'unfocused' : 'focused'][orb];
    const t = this.focusGlideFrame / GLIDE_FRAMES;
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t * t };
  }

  fire(): PlayerBullet[] {
    if (!this.shooting || !this.alive) return [];
    const out: PlayerBullet[] = [];
    for (const shot of this.sht.shotsForPower(this.power)) {
      const isLaser = shot.funcs[0] === 2 || shot.funcs[0] === 3;
      if (isLaser) {
        // MarisaB persistent lasers (FUN_00438db0/FUN_00438ef0): the record's
        // delay field is a SLOT INDEX, not a cadence delay; a slot spawns at
        // most one live beam, only while the option glide is settled in the
        // record's own focus state (funcs0=2 ⇒ unfocused, 3 ⇒ focused).
        const slotId = shot.delay;
        if (slotId < 0 || slotId > 2 || this.laserSlots[slotId]) continue;
        const settled = this.focusGlideFrame >= GLIDE_FRAMES;
        const wantFocused = shot.funcs[0] === 3;
        if (!settled || this.focusHeld !== wantFocused) continue;
        const b = this.makeBullet(shot);
        if (!b) continue;
        if (shot.shotType === 5) b.history = [];
        // funcs0=2 seeds the countdown from the record's interval field
        // (130-330 by power); funcs0=3 seeds 999 (held indefinitely).
        this.laserSlots[slotId] = { bullet: b, timer: wantFocused ? 999 : Math.max(1, shot.interval), fading: false };
        out.push(b);
        continue;
      }
      const interval = Math.max(1, shot.interval);
      if (this.fireFrame % interval !== shot.delay % interval) continue;
      const b = this.makeBullet(shot);
      if (b) out.push(b);
    }
    return out;
  }

  private makeBullet(shot: ShtShot): PlayerBullet | null {
    // SHT sprite is a global ANM SCRIPT id (base 1024): playerXX.anm shot
    // scripts live at 64+, their impact variants at +0x20 (96+).
    const scriptId = shot.sprite - PLAYER_SPRITE_BASE;
    if (!this.anm.hasScript(scriptId)) return null;
    const runner = new AnmRunner(this.anm, scriptId);
    const rect = this.anm.sprites.get(scriptId) ?? this.anm.sprites.get(64);
    const source = shot.orb === 1 || shot.orb === 2 ? this.orbOffset(shot.orb) : { x: 0, y: 0 };
    return {
      x: this.x + source.x + shot.x,
      y: this.y + source.y + shot.y,
      vx: Math.cos(shot.angle) * shot.speed,
      vy: Math.sin(shot.angle) * shot.speed,
      angle: shot.angle,
      speed: shot.speed,
      damage: shot.damage,
      shotType: shot.shotType,
      behaviorFunc: shot.funcs[0],
      hitboxW: shot.hitboxW,
      hitboxH: shot.hitboxH,
      sfxId: shot.sfxId,
      age: 0,
      state: 'fired',
      hitAge: 0,
      runner,
      impactScript: scriptId + 0x20,
      orb: shot.orb,
      anchorX: shot.x,
      rect: rect
        ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h, imageKey: rect.imageKey }
        : { x: 0, y: 0, w: 0, h: 0, imageKey: '' }
    };
  }

  hit(): 'deathbomb-window' | 'invulnerable' {
    if (this.invulnFrames > 0 || this.bombInvuln > 0 || this.deathTimer >= 0) return 'invulnerable';
    this.deathTimer = Math.trunc(this.unfocused.deathbombWindow);
    return 'deathbomb-window';
  }

  // Death sequence (exe state 2, fcn.0043dca0). The deathbomb window counts
  // down first ('pending'); when it lapses, returns 'effects' once and starts
  // the 30-frame death squish; the squish then counts down ('pending'); when
  // it finishes, returns 'respawn' once. 'none' when no death is in progress.
  // Bombing during the deathbomb window (tryBomb) clears deathTimer and
  // cancels the whole sequence.
  tickDeath(): 'effects' | 'respawn' | 'pending' | 'none' {
    if (this.deathTimer >= 0) {
      this.deathTimer--;
      if (this.deathTimer < 0) {
        this.dyingFrame = 0; // begin the death squish
        return 'effects';
      }
      return 'pending';
    }
    if (this.dyingFrame >= 0) {
      if (++this.dyingFrame >= DEATH_SQUISH_FRAMES) {
        this.dyingFrame = -1;
        return 'respawn';
      }
      return 'pending';
    }
    return 'none';
  }

  tryBomb(): boolean {
    if (this.bombs <= 0 || this.bombTimer > 0) return false;
    this.bombs--;
    this.deathTimer = -1; // deathbomb rescue
    // Th07.exe per-character bomb params selected by (character, focus-state) at cast.
    const [duration, invulnTotal, speedMult] = BOMB_PARAMS[this.character][this.focusHeld ? 'focused' : 'unfocused'];
    this.bombTimer = duration;
    this.bombInvuln = invulnTotal;
    this.bombSpeedMult = speedMult;
    this.bombFocused = this.focusHeld;
    return true;
  }

  die(): void {
    this.deathTimer = -1;
    // Exe FUN_0043a290: player state 2 hard-frees all three laser slots.
    for (let i = 0; i < 3; i++) {
      const slot = this.laserSlots[i];
      if (slot) slot.bullet.dead = true;
      this.laserSlots[i] = null;
    }
    this.lives--;
    this.bombs = Math.trunc(this.unfocused.bombs);
    // Power loss happens at the MISS itself, before the drops spawn
    // (StageScene#onPlayerDeath, exe FUN_0043dca0) — not here.
    // Respawn (fcn.0043dca0 at the death-clock lapse): teleport to the spawn
    // point and enter the materialize state (fcn.0043e170) -- a 30-frame
    // in-place scale/alpha ramp, NOT a fly-in -- followed by 240f invuln
    // (set in update() when the materialize ends).
    this.x = SPAWN_X;
    this.y = SPAWN_Y;
    this.materializeFrame = 0;
    this.invulnFrames = 0;
    this.bullets.length = 0;
  }
}
