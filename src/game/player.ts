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

// Th07.exe FUN_0043a820 @ 0x43a850-0x43a86b gates FUN_0043a100 only when
// all three predicates hold: bomb-active, character family == Marisa, and
// shot type == B. DAT_00625625/26 are the family/type bytes, so every other
// shot continues allocating normally during a bomb (Phantasm native slot 50
// at PRE10433 is a ReimuA shot born 26 ticks into the active bomb).
export function playerShotAllocationAllowed(character: CharacterId, bombActive: boolean): boolean {
  return !bombActive || character !== 'marisaB';
}

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
  // Th07.exe (v1.00b) FUN_0040a910 @ 0x40acb2 writes 0.4f for Master
  // Spark. The focused Final Spark remains 0.2f (FUN_0040af70).
  marisaB: { unfocused: [300, 300, 0.4], focused: [340, 390, 0.2] },
  sakuyaA: { unfocused: [160, 210, 1.0], focused: [250, 290, 0.3] },
  sakuyaB: { unfocused: [160, 260, 2.0], focused: [300, 420, 1.5] }
};

// Th07.exe FUN_00407740 @ 0x407740. Each bomb form supplies one float32
// percentage and an EDX minimum-total Cherry loss; the helper difficulty-
// scales the cast-time Cherry, divides both candidates by the form duration,
// floors them to tens, and stores the larger per-frame drain at +0x16a2c.
// The EDX immediates below were read directly at all twelve call sites:
// 0x4079ab, 0x408458, 0x40910c, 0x409668, 0x409adc, 0x40a19f,
// 0x40aade, 0x40b107, 0x40b5a7, 0x40bd11, 0x40c781, 0x40cece.
const BOMB_CHERRY_DRAIN: Record<CharacterId, {
  unfocused: [number, number]; focused: [number, number]
}> = {
  reimuA:  { unfocused: [0.20, 4000], focused: [0.22, 5000] },
  reimuB:  { unfocused: [0.17, 3000], focused: [0.17, 3000] },
  marisaA: { unfocused: [0.30, 8000], focused: [0.33, 9000] },
  marisaB: { unfocused: [0.35, 8000], focused: [0.41, 10000] },
  sakuyaA: { unfocused: [0.28, 6000], focused: [0.29, 6500] },
  sakuyaB: { unfocused: [0.26, 5500], focused: [0.29, 6000] }
};

export function bombCherryDrainPerFrame(
  character: CharacterId,
  focused: boolean,
  difficulty: number,
  cherry: number,
  duration: number
): number {
  const [percent, minimumTotal] = BOMB_CHERRY_DRAIN[character][focused ? 'focused' : 'unfocused'];
  let scaled = Math.round(cherry * Math.fround(percent));
  if (difficulty === 2) scaled = Math.trunc(scaled / 2);
  else if (difficulty === 3) scaled = Math.trunc(scaled / 4);
  else if (difficulty === 4 || difficulty === 5) scaled = Math.trunc(scaled / 3);
  const byCherry = Math.trunc(scaled / duration);
  const byMinimum = Math.trunc(minimumTotal / duration);
  return Math.max(byCherry - byCherry % 10, byMinimum - byMinimum % 10);
}

// The game assigns the player ANM a sprite-id base of 1024; SHT sprite
// fields are global ids (1088+ = local sprite 64+).
export const PLAYER_SPRITE_BASE = 1024;

export interface PlayerBullet {
  // Stable slot in Th07.exe's 96-entry player-shot pool. Each firing pass
  // scans from slot 0, so slots freed by movement are reusable immediately.
  poolSlot: number;
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
  // Type 5 beam-history ring: the physical ring is always 16 entries, while
  // historyDepth caches the spawning SHT record's interval and limits both
  // helper collision boxes and alpha-faded ghost draws.
  history?: { x: number; y: number }[];
  historyDepth?: number;
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
// see reference/re-specs/exe-player-shot.md §4.
const ORB_OFFSETS = {
  unfocused: { 1: { x: -24, y: 0 }, 2: { x: 24, y: 0 } },
  focused: { 1: { x: -8, y: -32 }, 2: { x: 8, y: -32 } }
} as const;

// Frames to glide between the unfocused/focused layouts on a focus-state
// change, and the interpolation formula, both CONFIRMED directly from the
// exe's tween state machine: the option X half-spread eases QUADRATICALLY,
// while Y eases LINEARLY. Th07.exe FUN_0043be00 (v1.00b), all.c:28343-28345
// and 28360-28362: focus-in is xHalf=24-16*t², y=-32*t; focus-out is
// xHalf=8+16*t², y=-32+32*t, where t=frame/8 after the frame's counter
// tick. Reversing these axes shifts the real shot spawn point because
// FUN_00438b70 fires from the live option position.
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
  // One-frame edge emitted by FUN_0043be00's option-layout state machine.
  // StageScene consumes it to manage the authored focus-in effect slot.
  focusTransition: 'in' | 'out' | null = null;
  // Frames elapsed since the last focus-state toggle, saturating at
  // GLIDE_FRAMES once the orb glide has settled; see orbOffset().
  private focusGlideFrame = GLIDE_FRAMES;
  // Th07.exe SakuyaB-only option orbit (exe-player-shot.md §7): accumulator
  // at player+0xb7e58; rest = -PI/2; strafe steers by vx*PI/200 per frame;
  // idle returns at 2*PI/100 per frame with snap inside PI/100; clamped to
  // [-7*PI/10, -3*PI/10] (±36° around straight up).
  orbitAngle = -Math.PI / 2;
  // Previous-frame snapshot of orbitAngle: the exe computes option render
  // positions (= orb-shot fire origins) BEFORE advancing the angle each
  // frame (FUN_0043be00 tail, 0x43d6d5-0x43d880) — same-tick consumers must
  // read this, not the freshly-mutated orbitAngle.
  renderOrbitAngle = -Math.PI / 2;
  // This frame's horizontal displacement (dx*speed from move()); 0 when not
  // strafing. Feeds the SakuyaB orbit steer.
  private lastVx = 0;
  shooting = false;
  // -1 while not shooting so that the first held frame lands on fireFrame 0
  // (see update()): a shot with delay 0 must fire on the very press frame,
  // not "interval" frames later.
  fireFrame = -1;
  private fireFrameFrac = 0;
  // FUN_0043a820 keeps the prior integer split-counter value separately and
  // only runs the shooter table when the integer phase changes.
  private prevFireFrame = -999;
  bullets: PlayerBullet[] = [];
  // MarisaB persistent-laser slot tracker (exe player+0x169c4/+0x169d0
  // 3-entry array, exe-player-shot.md §2.2): at most one live laser bullet
  // per record slot id (the record's `delay` field). timer counts down each
  // frame; release/bomb/dialogue clamp it; <71 arms the ANM fade.
  laserSlots: ({ bullet: PlayerBullet; timer: number; fading: boolean; shot: ShtShot } | null)[] = [null, null, null];
  lives = 2;
  bombs = 3;
  power = 0;
  invulnFrames = 0;
  // Player state-3's timer is the native {integer current, f32 fraction}
  // pair at +0x16a08/+0x16a04, retreated through FUN_00436a06. Keeping one
  // JS double made 1/3 slowmo retain a tiny positive tail for three extra
  // wall frames and shifted the player-shot collision gate in Stage 5.
  invulnFrac = 0;
  // Persistent deathbomb meter, exe player+0x23f8 (site enumeration in
  // recon exe-player-hit.md): seeded to SHT.deathbombWindow at spawn and at
  // the materialize->invuln handoff (0x43e2c7), zeroed while materializing
  // (0x43e237), decremented once per WALL-CLOCK frame while in the hit
  // state (0x43dcd9, no slow-rate term), and bumped min(N, meter+6) on
  // EVERY successful bomb (0x43dc4f-0x43dc7f). It doubles as the universal
  // bomb gate: the trigger fails outright while it reads 0 (0x43db08).
  deathbombMeter = 0;
  // Exe player state 2 while the meter is still nonzero: hit taken, the
  // deathbomb window is running. A hit never reloads the meter.
  hitState = false;
  // -1 when idle; 0..DEATH_SQUISH_FRAMES during the post-death squish (exe
  // state 2 with meter==0, fcn.0043dca0): scaleX=1-t, scaleY=1+3t, in place
  // at the death loc. Advances on the global split counter (FUN_00436acc).
  dyingFrame = -1;
  // -1 when idle; 0..MATERIALIZE_FRAMES during the respawn materialize (exe
  // state 1, fcn.0043e170): scaleX=t, scaleY=3-2t, alpha=t, t=frame/30.
  // Advances on the global split counter like the squish.
  materializeFrame = -1;
  bombTimer = 0;
  // Th07.exe player+0x23fc: shared 40-frame post-Border cooldown. Both
  // FUN_0043eb00 (break/cancel) and FUN_0043e620 (natural expiry) write 40;
  // FUN_0043d9a0 decrements it before accepting a normal held-X bomb.
  bombCooldown = 0;
  bombInvuln = 0;
  // Th07.exe player+0x16a2c: fixed Cherry drain applied on each frame that
  // begins with the bomb already active (the trigger frame itself is free).
  bombCherryDrain = 0;
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
    // Exe Player::Init (0x43f320) seeds the deathbomb meter from the SHT.
    this.deathbombMeter = Math.trunc(this.unfocused.deathbombWindow);
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
    return !this.hitState && this.dyingFrame < 0 && this.materializeFrame < 0;
  }

  get controllable(): boolean {
    // Input is locked during the deathbomb window, the death squish, and the
    // respawn materialize; the spawn/respawn invuln window itself is
    // controllable.
    return !this.hitState && this.dyingFrame < 0 && this.materializeFrame < 0;
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
  update(input: InputFrame, rate = 1, allowShotArm = true): void {
    // FUN_0043d9a0/bomb VM runs before FUN_0043be00 movement. On the tick
    // where the bomb clock reaches its duration, movement still observes the
    // multiplier that was active at frame entry; the reset applies to the
    // next player tick. Snapshot it before the local countdown retreats.
    const movementSpeedMult = this.bombTimer > 0 ? this.bombSpeedMult : 1;
    let bombEndedThisTick = false;
    this.updateFocusGlide(input.held.has('focus'), rate);
    if (this.invulnFrames > 0) {
      const rateF32 = Math.fround(rate);
      if (rateF32 > 0.99) {
        this.invulnFrames--;
      } else {
        this.invulnFrac = Math.fround(this.invulnFrac - rateF32);
        while (this.invulnFrac < 0) {
          this.invulnFrames--;
          this.invulnFrac = Math.fround(this.invulnFrac + 1);
        }
      }
      // FUN_0043e2e0 exits state 3 as soon as the integer current is < 1;
      // the remaining positive fraction is discarded with the state reset.
      if (this.invulnFrames < 1) {
        this.invulnFrames = 0;
        this.invulnFrac = 0;
      }
    }
    if (this.bombInvuln > 0) this.bombInvuln = Math.max(0, this.bombInvuln - rate);
    if (this.bombTimer > 0) {
      this.bombTimer = Math.max(0, this.bombTimer - rate);
      bombEndedThisTick = this.bombTimer === 0;
    }
    if (this.materializeFrame >= 0) {
      // Respawn materialize (fcn.0043e170): ramp scale/alpha IN PLACE over 30
      // simulation ticks (split counter), then enter the 240-tick invuln
      // window. No movement/firing. The exe zeroes the deathbomb meter every
      // state-1 frame (0x43e237) and reseeds it from the SHT at the
      // state-1 -> state-3 handoff (0x43e2c7).
      this.deathbombMeter = 0;
      this.materializeFrame += rate;
      if (this.materializeFrame >= MATERIALIZE_FRAMES) {
        this.materializeFrame = -1;
        this.invulnFrames = SPAWN_INVULN_FRAMES;
        this.invulnFrac = 0;
        this.deathbombMeter = Math.trunc(this.unfocused.deathbombWindow);
      }
    }
    // Th07.exe FUN_0043be00: the option render positions (player+0x9b4/0x9c0,
    // the fire origins for orb shots) are computed from the orbit angle
    // (player+0xb7e58) AS IT STOOD AT THE END OF THE PREVIOUS FRAME; the
    // angle-update block sits at the TAIL of the function (0x43d6d5-0x43d880),
    // advancing it with this frame's vx only for NEXT frame's layout. Reading
    // the freshly-mutated angle for this tick's spawns put SakuyaB's knife
    // origins one 3.6° step (1.5077px, simulation-exact) ahead of native and
    // flipped marginal kill frames (Mt01 st1 kill#86: 1982 vs native 1981).
    this.renderOrbitAngle = this.orbitAngle;
    if (this.controllable) this.move(input, rate, movementSpeedMult);
    else this.lastVx = 0;
    if (bombEndedThisTick) this.bombSpeedMult = 1.0;
    this.shooting = input.held.has('shoot') && this.controllable;
    // Shot-cycle ARM (exe FUN_0043a930): holding shoot re-arms the counter
    // to 0 only while it is DISARMED (< 0). A re-press mid-cycle does NOT
    // reset the grid, and releasing does NOT stop the cycle — the armed
    // counter free-runs to 29 firing its remaining record phases ("release
    // inertia"), then FUN_0043a820 disarms it (>0x1d, or player states 1/2:
    // materialize/dying). Ticking + disarm live in fire().
    // FUN_0043be00 gates FUN_0043a930 (the disarmed -> frame-0 re-arm)
    // on FUN_00429483()==0, the MSG-active predicate.  The surrounding
    // player callback still runs for timestamp-only messages: an already
    // armed 30-frame cycle keeps advancing in FUN_0043a820 and existing
    // shots keep moving, but once that cycle expires holding Z cannot start
    // another until the message ends.  Native Stage 6 trace, v1.00b:
    // FUN_0043eef0 / FUN_0043a290 / FUN_0043a820 all execute at PRE
    // 1915..2244 with DAT_0061c25c=0, while fireFrame reaches -1 and stays
    // there until entry 22 ends at PRE2245.
    if (allowShotArm && this.shooting && this.fireFrame < 0) {
      this.fireFrame = 0;
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

  private updateFocusGlide(focused: boolean, rate: number): void {
    this.focusTransition = null;
    let advancedOnReverse = false;
    if (focused !== this.focusHeld) {
      this.focusHeld = focused;
      this.focusTransition = focused ? 'in' : 'out';
      if (this.focusGlideFrame < GLIDE_FRAMES) {
        // FUN_0043be00 states 2 and 4 use the same reversal sequence: advance
        // the OLD split counter, complement its integer around 8, clear the
        // old fraction, then advance the NEW state once in the same callback
        // (all.c:28338-28372). Native th7_ud8141 processing 8631 pins this:
        // a 5-tick focus-in reversed at input 8615 yields focus-out ticks
        // 3,4,5, so the option-fired slot 50 starts at (xHalf=14.25,y=-12).
        const oldWhole = Math.floor(this.focusGlideFrame + rate);
        this.focusGlideFrame = Math.min(GLIDE_FRAMES, GLIDE_FRAMES - oldWhole + rate);
        advancedOnReverse = true;
      } else {
        // A settled toggle initializes the opposite state at zero; its case
        // body advances to `rate` on this same frame.
        this.focusGlideFrame = 0;
      }
    }
    if (!advancedOnReverse && this.focusGlideFrame < GLIDE_FRAMES) {
      this.focusGlideFrame = Math.min(GLIDE_FRAMES, this.focusGlideFrame + rate);
    }
  }

  private move(input: InputFrame, rate = 1, speedMult = 1): void {
    const sht = this.sht;
    // Th07.exe FUN_0043be00 @ all.c:28028-28055 resolves the four direction
    // bits into a direction enum via a PRIORITY chain, not vector addition:
    // up beats down (up+down moves UP), and right beats left (left+right
    // moves RIGHT — the right check overwrites the left result in every
    // branch). Real replays contain such chords (e.g. up+down+left held 53
    // frames in the stage-1 golden fixture), so cancelling them desyncs
    // playback and never matches live retail behavior.
    let dx = 0;
    let dy = 0;
    if (input.held.has('up')) dy = -1;
    else if (input.held.has('down')) dy = 1;
    if (input.held.has('left')) dx = -1;
    if (input.held.has('right')) dx = 1;
    const diagonal = dx !== 0 && dy !== 0;
    const baseSpeed = diagonal
      ? (this.focusHeld ? sht.diagFocusedSpeed : sht.diagSpeed)
      : (this.focusHeld ? sht.focusedSpeed : sht.speed);
    // Bombs latch a per-character speed multiplier (BOMB_PARAMS); SakuyaB
    // legitimately exceeds 1.0 — NOT clamped (exe-bombs.md §2).
    const speed = baseSpeed * speedMult;
    // Th07.exe (v1.00b) Player::Update clamp @ 0x43c3cc-0x43c47c reads
    // DAT_00625854/58/5c/60 = {8,16,368,416}: the player CENTER is limited
    // to x∈[8,376], y∈[16,432], inset from the 384×448 field edges.
    // exe FUN_0043be00: velocity = inputDir * speed * DAT_0056baa8.
    // FUN_0043be00 @ 0x43c32d-0x43c39f stores the rate-scaled velocity in
    // player+0x9cc/0x9d0 and then stores the position add back into the
    // float32 player+0x930/0x934 fields before clamping. Keeping these in JS
    // doubles accumulates sub-pixel drift across long replays: native Stage-2
    // PRE9297 is (317.226684570,373.816131592), while the old WT state was
    // (317.226537466,373.815521240), enough to move SakuyaA slot 32 just
    // outside a boss hitbox and lose its first-hit id5 event.
    const vx = Math.fround(dx * speed * rate);
    const vy = Math.fround(dy * speed * rate);
    this.x = clamp(Math.fround(this.x + vx), 8, 376);
    this.y = clamp(Math.fround(this.y + vy), 16, 432);
    this.lastVx = vx;
  }

  private updatePose(input: InputFrame): void {
    // Same right-beats-left priority as move() (exe FUN_0043be00 enum).
    const movingRight = input.held.has('right');
    const movingLeft = !movingRight && input.held.has('left');
    const pose = movingLeft ? 'left' : movingRight ? 'right' : 'idle';
    if (pose === this.poseState) return;
    this.poseState = pose;
    // playerXX.anm movement scripts (Th07.exe FUN_0043be00 @ all.c:28120-28143,
    // table at +0x29ef4..+0x29f00): 0 idle, 1 bank-left, 2 return-from-left,
    // 3 bank-right, 4 return-from-right. Scripts 3/4 are scripts 1/2 with the
    // sprite MIRRORED (scaleX<0) — that mirror is the only thing that makes
    // moving right lean right. The old mapping used script 2 (return-from-left,
    // unmirrored) for the right pose, so right movement showed a left lean
    // identical to the left pose. Right must use the mirrored bank script 3.
    const script = pose === 'left' ? 1 : pose === 'right' ? 3 : 0;
    if (this.anm.hasScript(script)) this.runner = new AnmRunner(this.anm, script);
  }

  // Fires shooter entries whose cadence matches this frame; called once per
  // frame while the shoot button is held.
  orbOffset(orb: 1 | 2): { x: number; y: number } {
    if (this.character === 'sakuyaB') {
      // exe: unfocused = diametric pair on r=24 at φ=orbitAngle+π/2;
      // focused = tight cluster at orbitAngle ∓ π/14; 8f linear glide between.
      // Uses the PREVIOUS frame's angle (see renderOrbitAngle).
      const a = this.renderOrbitAngle;
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
    const t = this.focusGlideFrame / GLIDE_FRAMES;
    const xHalf = this.focusHeld ? 24 - 16 * t * t : 8 + 16 * t * t;
    const y = this.focusHeld ? -32 * t : -32 + 32 * t;
    return { x: orb === 1 ? -xHalf : xHalf, y };
  }

  fire(rate = 1, allowSpawn = true): PlayerBullet[] {
    // exe FUN_0043a820: runs while the cycle is ARMED, independent of the
    // shoot key — released cycles still fire their remaining phases.
    if (this.fireFrame < 0) return [];
    if (this.dyingFrame >= 0 || this.materializeFrame >= 0) {
      this.fireFrame = -1;
      this.fireFrameFrac = 0;
      this.prevFireFrame = -999;
      return [];
    }
    const out: PlayerBullet[] = [];
    // FUN_0043a820 keeps advancing the armed 30-frame counter when its
    // caller suppresses allocation. Retail uses that suppression only for
    // MarisaB while a bomb is active; StageScene supplies the exact gate.
    if (allowSpawn && this.fireFrame !== this.prevFireFrame) {
      for (const shot of this.sht.shotsForPower(this.power)) {
        const isLaser = shot.funcs[0] === 2 || shot.funcs[0] === 3;
        if (isLaser) {
          // MarisaB persistent lasers (FUN_00438db0/FUN_00438ef0): the record's
          // delay field is a SLOT INDEX, not a cadence delay; a slot spawns at
          // most one live beam, only while the option glide is settled in the
          // record's own focus state (funcs0=2 ⇒ unfocused, 3 ⇒ focused).
          const slotId = shot.delay;
          if (slotId < 0 || slotId > 2) continue;
          const existing = this.laserSlots[slotId];
          if (existing) {
            // FUN_00438db0/FUN_00438ef0 cache the exact shooter-record
            // pointer at player+0x23e0[slotId]. A power-bracket change swaps
            // that pointer even when the new record describes the same beam;
            // native then requests interrupt 1 on the old owner, clears the
            // owner slot, and returns without spawning until the next table
            // pass. Keeping only "slot occupied" left Extra's pre-power-32
            // focused beam alive 86 frames too long (native PRE1184 age 21,
            // web age 107) and flipped its even-frame hit cadence.
            if (existing.shot !== shot) {
              existing.bullet.fadePending = true;
              this.laserSlots[slotId] = null;
            }
            continue;
          }
          const settled = this.focusGlideFrame >= GLIDE_FRAMES;
          const wantFocused = shot.funcs[0] === 3;
          if (!settled || this.focusHeld !== wantFocused) continue;
          const b = this.makeBullet(shot);
          if (!b) continue;
          if (shot.shotType === 5) {
            // Th07.exe FUN_00438ef0 @ 0x438ef0 initializes every history X
            // and the live bullet X to the exact -999.0 sentinel. The first
            // beam tick therefore records an empty sample before anchoring.
            b.history = Array.from({ length: 16 }, () => ({ x: -999, y: -999 }));
            b.historyDepth = Math.min(16, Math.max(0, shot.interval | 0));
            b.x = -999;
          }
          // funcs0=2 seeds the countdown from the record's interval field
          // (130-330 by power); funcs0=3 seeds 999 (held indefinitely).
          this.laserSlots[slotId] = {
            bullet: b,
            timer: wantFocused ? 999 : Math.max(1, shot.interval),
            fading: false,
            shot
          };
          out.push(b);
          continue;
        }
        const interval = Math.max(1, shot.interval);
        if (this.fireFrame % interval !== shot.delay % interval) continue;
        const b = this.makeBullet(shot);
        if (b) out.push(b);
      }
    }
    this.prevFireFrame = this.fireFrame;
    // Advance the split counter (FUN_00436acc) and expire the cycle past
    // frame 29 (exe compares > 0x1d) — the held key re-arms it to 0 on the
    // next update tick, giving the seamless 30-frame loop.
    if (rate > 0.99) {
      this.fireFrame++;
      this.fireFrameFrac = 0;
    } else {
      this.fireFrameFrac += rate;
      if (this.fireFrameFrac >= 1) {
        this.fireFrameFrac -= 1;
        this.fireFrame++;
      }
    }
    if (this.fireFrame > 29) {
      this.fireFrame = -1;
      this.fireFrameFrac = 0;
      this.prevFireFrame = -999;
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
      poolSlot: -1,
      // FUN_00438b70 writes spawn position and velocity into the player's
      // fixed shot slot as f32 fields. Keeping the constructor in double
      // precision lets long-lived shots cross enemy hitboxes on a different
      // wall frame even when their authored SHT values are identical.
      x: Math.fround(this.x + source.x + shot.x),
      y: Math.fround(this.y + source.y + shot.y),
      vx: Math.fround(Math.cos(shot.angle) * shot.speed),
      vy: Math.fround(Math.sin(shot.angle) * shot.speed),
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
    if (this.invulnFrames > 0 || this.bombInvuln > 0 || this.hitState) return 'invulnerable';
    // Exe FUN_0043bd60: entering state 2 does NOT reload the meter — the
    // window length is whatever the persistent meter currently holds (a
    // recent late deathbomb leaves a shortened window).
    this.hitState = true;
    return 'deathbomb-window';
  }

  // Death sequence (exe state 2, fcn.0043dca0). While in the hit state the
  // deathbomb meter decrements once per WALL-CLOCK call ('pending'); the
  // frame it reaches 0 the miss commits: returns 'effects' once and starts
  // the death squish. The squish advances on the split counter (rate);
  // when it finishes, returns 'respawn' once. 'none' when idle. A
  // successful bomb (tryBomb) leaves the hit state and cancels the miss.
  tickDeath(rate = 1): 'effects' | 'respawn' | 'pending' | 'none' {
    if (this.hitState) {
      this.deathbombMeter--;
      if (this.deathbombMeter <= 0) {
        this.deathbombMeter = 0;
        this.hitState = false;
        this.dyingFrame = 0; // begin the death squish
        return 'effects';
      }
      return 'pending';
    }
    if (this.dyingFrame >= 0) {
      this.dyingFrame += rate;
      if (this.dyingFrame >= DEATH_SQUISH_FRAMES) {
        this.dyingFrame = -1;
        return 'respawn';
      }
      return 'pending';
    }
    return 'none';
  }

  tryBomb(): boolean {
    // Exe trigger gates (FUN_0043d9a0 @ 0x43db08-0x43db2e): the deathbomb
    // meter must be nonzero — this single gate is what closes bombing during
    // the squish (meter 0), the materialize (zeroed each frame) and past the
    // end of the deathbomb window.
    if (this.bombs <= 0 || this.bombTimer > 0 || this.bombCooldown > 0 || this.deathbombMeter <= 0) return false;
    this.bombs--;
    this.hitState = false; // deathbomb rescue
    // Every successful bomb bumps the meter min(N, meter+6) — a no-op at
    // full meter, the shortened-next-window rule after a late deathbomb
    // (Th07.exe 0x43dc4f-0x43dc7f).
    this.deathbombMeter = Math.min(Math.trunc(this.unfocused.deathbombWindow), this.deathbombMeter + 6);
    // Th07.exe per-character bomb params selected by (character, focus-state) at cast.
    const [duration, invulnTotal, speedMult] = BOMB_PARAMS[this.character][this.focusHeld ? 'focused' : 'unfocused'];
    this.bombTimer = duration;
    this.bombInvuln = invulnTotal;
    this.bombCherryDrain = 0;
    this.bombSpeedMult = speedMult;
    this.bombFocused = this.focusHeld;
    return true;
  }

  die(): void {
    this.hitState = false;
    // Materialize holds the meter at 0 (0x43e237); it reloads at the
    // state-1 -> state-3 handoff in update().
    this.deathbombMeter = 0;
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
    this.invulnFrac = 0;
    this.bullets.length = 0;
  }
}
