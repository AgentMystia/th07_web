import type { Rng } from '../core/rng';
import type { AnmRunner } from '../formats/anm';

export type ItemType =
  | 'power' | 'point' | 'bigPower' | 'bomb' | 'fullPower' | 'life'
  | 'cherry' | 'bigCherry' | 'pointBullet';

export interface EnemyBullet {
  id: number;
  // Stable slot in Th07.exe's fixed 0x400-entry bullet pool. Effects scan
  // this identity in slot order, independently of the browser-side array.
  poolSlot: number;
  // op-79 opcode 0x2000 grace (exe bullet+0xbf0): while it counts down the
  // off-screen cull is skipped entirely and collision keeps running — how
  // patterns park bullets outside the field before they sweep in.
  graceFrames?: number;
  // Frames spent continuously off-screen (exe bullet+0xbfe): dir-change/
  // bounce bullets (mask 0xdc0) survive up to 128 before dying; others die
  // immediately, draining any leftover count first.
  offscreenFrames?: number;
  // Shared special-effect state (bullet +0xc08). Different op121/122 effect
  // callbacks deliberately reuse it as a state, countdown, or laser id.
  effectState: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  angle: number;
  age: number;
  flags: number;
  sprite: number;
  spriteOffset: number;
  rect: { x: number; y: number; w: number; h: number; imageKey: string };
  grazeW: number;
  grazeH: number;
  grazed: boolean;
  spawnDuration: number;
  spawnMoveScale: number;
  // Activated ex-behavior flags (exe bullet+0xbf4), built at spawn from the
  // op-79 slots whose opcode bit is in the fire flags AND which pass the
  // cond gate (FUN_004229f0). Behaviors clear their own bit when they finish.
  exFlags: number;
  // Per-behavior params resolved once at spawn from the matching op-79 slot.
  // null => that behavior did not activate (bit absent from exFlags). Each
  // maps to the exe's dedicated per-behavior parameter block.
  exAccel: { mag: number; angle: number; limit: number } | null; // 0x10
  exAngle: { speedDelta: number; angleDelta: number; limit: number } | null; // 0x20
  exDir: { angle: number; newSpeed: number; interval: number; maxTimes: number } | null; // 0x40/0x80/0x100
  exBounce: { speed: number; maxTimes: number } | null; // 0x400/0x800
  dirTimes?: number;
  dead?: boolean;
}

// One BULLET_EX (op 79) template slot on the firing enemy. op 79 writes slot
// `index` (arg0); up to 5 persist on the enemy and are snapshotted at each
// FIRE. Fields mirror the exe's queue entry pfVar1[0..5] (audit-bullet-motion
// §op79): opcode=arg1, cond=arg2, arg3=duration, arg4=maxTimes, f0/f1=floats.
export interface BulletExSlot {
  opcode: number; // 1 ramp / 0x10 accel / 0x20 angle / 0x40|0x80|0x100 dir / 0x400|0x800 bounce
  cond: number; // arg2: cond gate — a cond==0 slot activates only before any other behavior
  arg3: number; // duration / interval / limit / bounce-maxTimes
  arg4: number; // dir-change maxTimes
  f0: number; // angle / accel-mag / angle-change speedDelta / bounce-speed
  f1: number; // accel-angle / angle-change angleDelta / dir-change new-speed
}

// Th07.exe enemy laser (pool object 0x4ec bytes @ gamestate+0x366628; see
// scratchpad spec-lasers.md / re-specs exe-enemy-lasers.md). Field mapping:
// nearDist/farDist = +0x4a8/+0x4ac (live, auto-grown by speed), maxLength =
// +0x4b0, width = +0x4b4 (full), displayWidth = +0x4b8 (current on-screen),
// growDuration/holdDuration/shrinkDuration = +0x4c0/c8/cc, telegraphDelay =
// +0x4c4 (no hit test in grow before this), shrinkCutoff = +0x4d0 (no draw/
// hit in shrink after this), flags = +0x4e4 (bit0 manual width, bit2
// bomb-immune), state +0x4e8 (0 grow / 1 hold / 2 shrink), phaseFrame
// +0x4e0.
export interface EnemyLaser {
  id: number;
  // Stable slot in Th07.exe's fixed 64-entry enemy-laser pool.
  poolSlot: number;
  ownerId: number;
  inUse: boolean;
  sprite: number;
  color: number;
  x: number;
  y: number;
  angle: number;
  speed: number;
  nearDist: number;
  farDist: number;
  maxLength: number;
  width: number;
  displayWidth: number;
  growDuration: number;
  holdDuration: number;
  shrinkDuration: number;
  telegraphDelay: number;
  shrinkCutoff: number;
  flags: number;
  state: number;
  phaseFrame: number;
  // Fractional accumulator for phaseFrame under global slow motion.
  phaseFrac?: number;
  hideTipDuringGrow: boolean;
}

export interface ItemEntity {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  type: ItemType;
  age: number;
  // Th07.exe item+0x27f: 0 = falling, 1 = homing toward the player (a
  // permanent latch), 2 = spawn-mode-2 positional tween (death drops).
  state: number;
  // Mode-2 tween block (exe item+0x258..+0x26c while state==2): origin and
  // target of the 60-frame lerp plus the split elapsed/frac counter
  // (+0x278/+0x274, advanced fractionally under slowmo via FUN_00436acc).
  tween?: { sx: number; sy: number; tx: number; ty: number; elapsed: number; frac: number };
  dead?: boolean;
}

export interface EffectParticle {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  color: number;
  size: number;
  kind: 'spark' | 'snow' | 'burst';
}

// Interface the ECL VM uses to talk to the game — mirrors the TH06 Web seam
// between Th06StageRuntime and Game.
export interface GameHost {
  rng: Rng;
  difficulty: number; // 0 E, 1 N, 2 H, 3 L
  rank: number;
  // ECL var 10028 (Th07.exe DAT_00625627): character*2 + shotType (0=ReimuA
  // … 5=SakuyaB).
  shotIndex?: number;
  frame: number;
  id: number;
  player: { x: number; y: number };
  enemies: Enemy[];
  enemyBullets: EnemyBullet[];
  enemyLasers: EnemyLaser[];
  items: ItemEntity[];
  power: number;
  score: number;
  timeStopped?: boolean;
  // Global slow-motion rate (exe DAT_0056baa8, spec-slowmo.md): 1.0 normal;
  // bullet-effect 10 writes 1/param, effect 11 restores 1.0. Continuous
  // motion multiplies by it per frame; discrete timers accumulate it
  // fractionally; collision always runs at wall clock.
  slowRate?: number;
  setSlowRate?(rate: number): void;
  addScore(v: number): void;
  spawnItem(type: ItemType, x: number, y: number, options?: { state?: number; vx?: number; vy?: number; tweenTarget?: { tx: number; ty: number } }): void;
  spawnEffectParticles(effectId: number, x: number, y: number, count: number, color: number): void;
  playSfx(id: number): void;
  startDialogue?(index: number): void;
  isDialogueBlocking?(): boolean;
  consumeDialogueResume?(): boolean;
  startBossSpell?(spellId: number, arg0: number, name: string): void;
  // Returns whether the phase-end field sweep applies — Th07.exe
  // FUN_0040f340 runs it only when the spell did NOT time out
  // (DAT_012f40a8 == 1; timeouts bump it to 2 and fade the field
  // itemlessly at all.c:13831).
  endBossSpell?(opts?: { fromBossDeath?: boolean }): boolean;
  voidSpellCapture?(): void;
  setBossPresent?(present: boolean, enemy: Enemy | null): void;
  setBossLifeCount?(count: number): void;
  dropPointItems?(e: Enemy, count: number): void;
  awardSpellValue?(value: number): void;
  spawnEnemyDeathEffect?(e: Enemy): void;
  // FUN_00422ea0(1): every live enemy bullet, plus samples along each
  // non-immune live laser, becomes an auto-collecting small cherry item
  // (type 6 — the constructor-set cancel type at +0x37a160,
  // FUN_00421a40) with no immediate score popup. Runs at op80, spell
  // declare (op90) and the full-power crossing.
  cancelBulletsToItems(): void;
  // Floating score/cherry number popup (spec-popups.md): value < 0 draws
  // the single sentinel glyph; color is D3D ARGB. The shared popup updater
  // moves entries upward and retires them after 60 rate-scaled frames.
  spawnScorePopup?(value: number, x: number, y: number, color: number): void;
  // Frames remaining of the exe's post-field-clear laser-spawn suppression
  // (gamestate+0x37a12c, set to 10 by every FUN_00422ea0 call; op-82/83
  // fires are gated on it unless the laser is bomb-immune, all.c:15737).
  postBombLaserCounter?: number;
  // ECL op 160 = FUN_0042dc6f(arg): cherry + cherryPlus gain.
  awardCherry?(v: number): void;
  // Bullet-effect id 20: hardcoded BGM cue (Yuyuko phase 2, th07_13b).
  playBgmTrack?(name: string): void;
  // Bullet-effect id 19 (FUN_00418ee0): three-second BGM fade-out.
  fadeBgm?(seconds: number): void;
  // Screen FX scheduler (exe FUN_004459c0): type-1 shake (magnitude ramps
  // from->to over duration) and type-3 repeating full-screen tint flash.
  startScreenShake?(duration: number, from: number, to: number): void;
  startScreenFlash?(duration: number, repeats: number, argb: number): void;
  // FUN_00422ea0's laser half: graceful-cancel non-bomb-immune lasers
  // (unconditional = the bombType-10 spell-timeout variant).
  cancelLasers?(unconditional: boolean): void;
  // FUN_00423100(8000,1): like cancelBulletsToItems but each bullet also
  // pops an escalating score value (2000, +20 per bullet, capped 8000);
  // returns the summed total for the caller to bank as score/10 (op91
  // spell end, boss nonspell death).
  sweepBulletsToItems(): number;
  configureAmbience?(op: number, args: number[]): void;
  // Boss timer-callback fired with the ECL "timeout is normal" flag unset
  // (exe flags +0x2e2a bit6 == 0): cherry -25% (FUN_0041e6b0's
  // floor10(cherry*0.25) penalty) — applies to nonspell timeouts too.
  onBossPhaseTimeout?(): void;
  unpauseStd(label: number): void;
}

export interface EclContext {
  subId: number;
  index: number; // instruction index within sub
  time: number;
  // Fractional accumulator for the script clock under global slow motion
  // (exe: split (int, frac) counter at enemy+0x6f0/+0x6ec advanced by
  // FUN_00436acc at the DAT_0056baa8 rate; spec-slowmo.md §5).
  timeFrac: number;
  // op45 wait countdown (exe context +0x80 == enemy +0x764/+0x76c).
  // CALL saves/restores it with the rest of the 0x218-byte ECL context.
  waitTimer: number;
}

export interface EclInterpSlot {
  target: number;
  duration: number;
  elapsed: number;
  mode: number;
  ease: number;
  f0: number;
  f1: number;
  f2: number;
  f3: number;
}

// One saved call frame. Th07.exe pushes the whole 0x218-byte context block
// (+0x6e4..+0x8fb) on op41 CALL, interrupt entry, and op144 periodic entry —
// that block spans the instruction cursor, the 26 variable dwords, the op45
// wait timer, and the op27 interp slots. op42 RETURN restores all of it, so
// callee writes to locals/params/interps roll back at return.
export interface EclFrame {
  ctx: EclContext;
  vars: Float64Array;
  interps: (EclInterpSlot | null)[];
}

export interface EclState {
  ctx: EclContext;
  stack: EclFrame[];
  subId: number;
  mirrored: boolean;
  itemDrop: number;
  // The enemy's 26-dword ECL variable block, Th07.exe enemy+0x6fc..+0x763.
  // [0..15]  locals 10000-10015 (ints 10000-10003/10012-10015, floats
  //          10004-10011 — one shared block for every sub this enemy runs;
  //          there is NO call-window shift in the executable).
  // [16..17] extra float slots, vars 10072/10073 (+0x73c/+0x740).
  // [18..21] rand-int config, vars 10029-10032 (+0x744..+0x750): var 10056's
  //          int form reads base[19] + rng % range[18].
  // [22..25] rand-float config, vars 10033-10036 (+0x754..+0x760): var
  //          10056's float form reads base[23] + rng01()*range[22].
  // op92/93 child spawns copy the whole block from the parent (FUN_0041db60
  // copies 0x1a dwords from parent+0x6fc into the child).
  vars: Float64Array;
  axisSpeed: { x: number; y: number; z: number };
  angle: number;
  angularVelocity: number;
  speed: number;
  acceleration: number;
  shootOffset: { x: number; y: number; z: number };
  // Per-enemy laser handle table (exe enemy+0x2d8c, 32 slots) + the op-84
  // "current slot" register (+0x2e0c) that the NEXT op-82/83 fire writes
  // into. Ops 85-89/152/156-158 take their own index arg.
  laserSlots: (EnemyLaser | null)[];
  laserSlotIndex: number;
  // op27 timed float interpolators (exe enemy+0x770, 8 slots stride 0x30):
  // target = special-var-id tag, mode 0-6 = 2-point LERP, 7 = cubic Hermite
  // (f2/f3 = tangents), ease 0-6 per spec-op27-effects.md §1.3.
  interpSlots: (EclInterpSlot | null)[];
  // op122 armed per-frame bullet-effect (exe enemy+0x6f4): param re-resolved
  // live from the arming instruction each frame (paramOff = absolute byte
  // offset of arg1 in the ECL image).
  effectArm: { id: number; paramOff: number } | null;
  // FUN_00416d00 sets enemy +0x2e2b bit0 on the first effect-0 callback.
  // No instruction clears it: normal movement stays disabled for the rest
  // of this entity's lifetime, even after op122 disarms the callback.
  movementSuppressedByEffect0: boolean;
  // op144 periodic gosub (exe +0x2f58/+0x2f64/+0x2ee4): every `period`
  // frames, nested call into subId; -1 disarms.
  // op144 periodic gosub. The periodic sub runs on its own PERSISTENT
  // 26-dword variable block (exe stash at enemy+0x2ee8): loaded into the
  // live vars at each firing (all.c:7089-7095), exported back at that
  // firing's op42 return (+0x8f4 flag, all.c:10024-10032) — its state
  // carries across firings without disturbing the interrupted flow.
  periodicSub: { period: number; subId: number; elapsed: number; savedVars: Float64Array } | null;
  // The +0x8f4 flag: the next op42 exports the live vars to the stash.
  periodicExportArmed: boolean;
  // Pending interrupt-table index (exe +0x2b08), written by op109/timeline
  // op10/op145 and drained through the op108 table at frame/interpreter top.
  pendingInterrupt: number;
  // op153 secondary shot-collision extent triple (exe +0x2b48/4c/50).
  hitbox2: { x: number; y: number; z: number } | null;
  moveMode: number;
  interpKind: number;
  interp: { start: { x: number; y: number; z: number }; delta: { x: number; y: number; z: number }; duration: number; left: number } | null;
  // mode-3 orbit group (exe +0x2b5c/60/6c/70/8c-94), see
  // reference/re-specs/exe-enemy-move-fields.md §3 Group B / §5.1.
  orbitAngle: number;
  orbitAngularVelocity: number;
  orbitSpeed: number;
  orbitAcceleration: number;
  orbitTarget: { x: number; y: number; z: number };
  // Shared movement-mode timer (+0x2ba4/+0x2ba0). Ops 56/60 use it for
  // mode 3; op59 uses the same fields for a bounded mode-1 move.
  orbitDuration: number; // 0 = never auto-stop
  orbitLeft: number;
  bulletProps: BulletProps | null;
  bulletSfx: number;
  // Th07.exe enemy+0x2ca0, written by op81 arg1 (all.c:8714). No consumer
  // has been traced; retain the exact state without inventing behavior.
  bulletSfxInterval: number;
  // op-79 template slots, indexed by arg0 (0..4). Persist across FIREs (exe
  // enemy+0x2bf4 table); snapshotted into BulletProps.exSlots at each FIRE.
  bulletExSlots: (BulletExSlot | null)[];
  shootDisabled: boolean;
  shootInterval: number;
  shootTimer: number;
  hitbox: { x: number; y: number; z: number };
  isBoss: boolean;
  bossSlot: number | null;
  canTakeDamage: boolean;
  collisionEnabled: boolean;
  interactable: boolean;
  // Th07.exe enemy flags +0x2e29 bit4 (op 104, dispatcher case 0x67): gates
  // the entire player-shot/bomb hit test (FUN_0041ed50 @ all.c:14174-14176)
  // — a 0 makes the enemy shot-transparent (no damage, no shot absorption,
  // no homing eligibility). Distinct from collisionEnabled (bit1, op 102),
  // which gates only the enemy-body-vs-player check.
  shotCollision: boolean;
  deathMode: number;
  deathCallbackSub: number;
  lifeThresholds: { threshold: number; sub: number }[];
  timerCallbackThreshold: number;
  timerCallbackSub: number;
  bossTimer: number;
  // Fractional accumulator for bossTimer under global slow motion.
  bossTimerFrac?: number;
  currentAnm: number;
  anmRunner: AnmRunner | null;
  anmSlots: ({ script: number; runner: AnmRunner | null } | null)[];
  anmExDefaults: number;
  anmExFarLeft: number;
  anmExFarRight: number;
  anmExLeft: number;
  anmExRight: number;
  anmExFlags: number;
  deathAnm1: number;
  deathAnm2: number;
  deathAnm3: number;
  frameVx: number;
  frameVy: number;
  anmRotateWithAngle: boolean;
  // ECL op150 (exe case 0x95): absolute Z rotation written into the enemy's
  // embedded ANM VM (+8), consumed by the sprite draw (radians).
  anmRotZ?: number;
  bossLifeCount: number;
  lasers: (EnemyLaser | null)[];
  laserStore: number;
  interrupts: number[];
  disableCallStack: boolean;
  invisible: boolean;
  // Test-only: last game frame this enemy emitted bullets (LIFE-001 traces).
  lastFireFrame?: number;
  spellTimeoutFlag: boolean;
  // Th07.exe DAT_012f40a8: set while a boss spell card is active. Gates the
  // rank/count/speed bullet scaling off (spell bullets use raw ECL values).
  spellCardActive: boolean;
  bulletRankSpeedLow: number;
  bulletRankSpeedHigh: number;
  bulletRankAmount1Low: number;
  bulletRankAmount1High: number;
  bulletRankAmount2Low: number;
  bulletRankAmount2High: number;
  lowerMoveLimit: { x: number; y: number };
  upperMoveLimit: { x: number; y: number };
  shouldClamp: boolean;
  spellName: string;
  seen: boolean;
  // Op 136 (exe case 0x87 @ 0x413.. -> `+0x2e29` bit5, arg&1): gates the
  // FUN_004217c0 sweep's cherry-item drop (op94 / op91 spell-end / boss
  // death — verified directly at all.c:14884) and enables the enemy body's
  // periodic re-graze (exe-collision.md §6, ~every 6 frames while
  // touching) -- same bit, both consumers.
  // Default false: no confirmed default-on case in stage 1's own data.
  sweepItemFlag: boolean;
  // Op 137 (exe case 0x88 @ 0x413.. -> `+0x2e2a` bit7, arg&1): exempts the
  // enemy from the off-screen auto-cull (exe-misc-ecl-ops.md §4). Default
  // false -- ordinary enemies get culled once seen-then-offscreen.
  offscreenCullExempt: boolean;
  // Op 142 (exe case 0x8d @ 0x413.. -> `+0x4f40/+0x4f3c/+0x4f38`): PROBABLE
  // op 142 damage shield, frames remaining (exe enemy+0x4f40, case 0x8d):
  // while > 0, settled damage is /9 for bosses and 0 for non-bosses
  // (FUN_0041ed50 @ all.c:14245). Decrement located: the enemy loop ticks
  // the {+0x4f38,+0x4f3c,+0x4f40} countdown via FUN_00436a06(1) each frame
  // while > 0 (all.c:14440) — resolves exe-misc-ecl-ops.md §5's UNRESOLVED.
  // Every stage-1 spell card arms it at declare (Cirno 60f, Ringing Cold
  // 300f, finals 360/240/240f).
  damageShield: number;
}

export interface BulletProps {
  sprite: number;
  offset: number;
  count1: number;
  count2: number;
  speed1: number;
  speed2: number;
  angle1: number;
  angle2: number;
  flags: number;
  sfx: number;
  exSlots: (BulletExSlot | null)[];
  aimMode: number;
}

export interface Enemy {
  id: number;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  // Damage taken this frame, settled once per frame through the exe's
  // pipeline (Th07.exe FUN_0041ed50: cherry from the pre-cap sum, cap 70,
  // spell-card /7, op-142 shield /9) — see StageScene#settlePendingDamage.
  pendingShotDmg: number;
  pendingBombDmg: number;
  // HP actually removed by the most recent per-frame settle — exposed to ECL
  // as var 10061 (Th07.exe enemy+0x2e4c, zeroed each frame at all.c:14173;
  // the Prismrivers poll it cross-slot via op43 for damage sharing).
  damageThisFrame?: number;
  score: number;
  frame: number;
  dead?: boolean;
  ecl: EclState;
}
