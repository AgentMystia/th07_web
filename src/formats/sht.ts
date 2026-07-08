import { BinaryView } from './bin';

// TH07 SHT player-data format (one file per character/type/focus-state).
//
// Verified against the TH07 struct definition in Priw8's sht-webedit tool
// (js/struct/struct_07.js, https://github.com/Priw8/sht-webedit), which is
// the only public source with an exact byte-for-byte field list for this
// game's .sht layout, plus field semantics from that repo's README. This is
// NOT the same layout as TH06 (which has no .sht at all) or TH08+ (which
// inserts extra unknown i16 fields into the shooter record) - PyTouhou's
// sht.py documents TH06 only and was cross-checked but not trusted blindly.
// Every field offset below was additionally confirmed by dumping all 12
// ply*.sht files and matching values against community-documented PCB facts
// (movement speeds, hitbox widths, graze radii, deathbomb-window frame
// counts) - see scripts/audit-th07-player.mjs.
//
// 52-byte header: i16 unknown, i16 levelCount, f32 bombsPerLife,
// i32 deathbombWindow, then 8 floats: hitbox, grazebox, autocollectSpeed,
// itemRadius, cherryLossOnDeath, pocLineY, speed, focusedSpeed, diagSpeed,
// diagFocusedSpeed (hitbox/grazebox/speeds are half-widths and px/frame,
// confirmed e.g. Reimu hitbox 1.65 == wiki's "3.3px wide" hitbox halved).
// Then levelCount × {u32 offset, u32 powerThreshold}, each pointing at a
// 52-byte shooter record: u16 interval ("fire_rate"), u16 delay
// ("start_delay"), 6×f32 (x, y, hitboxW, hitboxH, angle, speed), i16 damage,
// u8 orb (0 = player, 1/2 = option), u8 "unknown_old_sht_1" (undocumented
// upstream; empirically it selects special player-bullet behavior - values
// observed in the real files line up exactly with Reimu A's homing option
// amulets (1), Marisa A's accelerating missiles (3), and Marisa B's
// piercing lasers (4/5), matching src/game/stage-scene.ts's shotType
// handling - kept under that name for that reason), i16 sprite ("anm"),
// i16 sfxId ("sfx_id"; -1 = no sound), then 4×i32 hardcoded behavior
// function indices (func_on_init/tick/draw/hit per sht-webedit), parsed
// into `funcs`. Full decode of all 12 files (funcs[1] always mirrors the
// shotType byte; funcs[0] is the spawn-time behavior selector):
//   ply00a  orbs st1 [0,1,0,0]  homing amulets
//   ply00as orbs st2 [0,2,0,0]  slow (speed 2) homing amulets
//   ply01a  orbs st3 [0,3,0,1]  accelerating missiles
//   ply01as orbs st3 [1,3,0,1]  missiles spawned at speed -2
//   ply01b  orbs st4 [2,4,0,2]  accelerating laser shots
//   ply01bs      st5 [3,5,1,2]  focused laser (funcs[2]=1: pierce)
//   ply02as all  st0 [4,0,0,0]  aim at an enemy at spawn (SakuyaA focus)
//   ply02b/bs    st0 [5,0,0,0]  unknown SakuyaB variant (flies straight)
// The engine routines the indices select live in Th07.exe and are not
// reimplemented 1:1; stage-scene.ts keys approximations off funcs[0] and
// shotType (see AGENTS.md §7). Shooter records run until an interval/delay
// sentinel of 0xffff/0xffff (4 bytes of 0xff).

export interface ShtShot {
  interval: number;
  delay: number;
  x: number;
  y: number;
  hitboxW: number;
  hitboxH: number;
  angle: number;
  speed: number;
  damage: number;
  orb: number; // 0 = player, 1 = left option, 2 = right option
  shotType: number;
  sprite: number; // ANM script id in the character's playerXX.anm
  sfxId: number; // sound effect id to play on fire, -1 = none (not yet wired to playback)
  funcs: [number, number, number, number]; // behavior function indices (see header comment)
}

export interface ShtLevel {
  power: number; // inclusive upper power bound for this table
  shots: ShtShot[];
}

export class Sht {
  readonly bombs: number;
  readonly deathbombWindow: number;
  readonly hitbox: number;
  readonly grazebox: number;
  readonly autocollectSpeed: number;
  readonly itemRadius: number;
  readonly cherryLossOnDeath: number;
  readonly pocLineY: number;
  readonly speed: number;
  readonly focusedSpeed: number;
  readonly diagSpeed: number;
  readonly diagFocusedSpeed: number;
  readonly levels: ShtLevel[] = [];

  constructor(source: string | Uint8Array) {
    const v = new BinaryView(source);
    const levelCount = v.i16(2);
    this.bombs = v.f32(4);
    this.deathbombWindow = v.i32(8);
    this.hitbox = v.f32(12);
    this.grazebox = v.f32(16);
    this.autocollectSpeed = v.f32(20);
    this.itemRadius = v.f32(24);
    this.cherryLossOnDeath = v.f32(28);
    this.pocLineY = v.f32(32);
    this.speed = v.f32(36);
    this.focusedSpeed = v.f32(40);
    this.diagSpeed = v.f32(44);
    this.diagFocusedSpeed = v.f32(48);
    for (let i = 0; i < levelCount; i++) {
      const offset = v.u32(52 + i * 8);
      const power = v.u32(52 + i * 8 + 4);
      const shots: ShtShot[] = [];
      for (let o = offset; o + 4 <= v.length;) {
        const interval = v.u16(o);
        const delay = v.u16(o + 2);
        if (interval === 0xffff && delay === 0xffff) break;
        shots.push({
          interval,
          delay,
          x: v.f32(o + 4),
          y: v.f32(o + 8),
          hitboxW: v.f32(o + 12),
          hitboxH: v.f32(o + 16),
          angle: v.f32(o + 20),
          speed: v.f32(o + 24),
          damage: v.i16(o + 28),
          orb: v.u8(o + 30),
          shotType: v.u8(o + 31),
          sprite: v.i16(o + 32),
          sfxId: v.i16(o + 34),
          funcs: [v.i32(o + 36), v.i32(o + 40), v.i32(o + 44), v.i32(o + 48)]
        });
        o += 52;
      }
      this.levels.push({ power, shots });
    }
  }

  // The shooter table active at a given power (0-128).
  shotsForPower(power: number): ShtShot[] {
    for (const level of this.levels) {
      if (power <= level.power) return level.shots;
    }
    return this.levels.length ? this.levels[this.levels.length - 1].shots : [];
  }
}
