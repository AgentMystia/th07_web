import type { Rng } from '../core/rng';
import type { AnmRunner } from '../formats/anm';

export type ItemType =
  | 'power' | 'point' | 'bigPower' | 'bomb' | 'fullPower' | 'life'
  | 'cherry' | 'bigCherry' | 'pointBullet';

export interface EnemyBullet {
  id: number;
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

export interface EnemyLaser {
  id: number;
  ownerId: number;
  inUse: boolean;
  sprite: number;
  color: number;
  x: number;
  y: number;
  angle: number;
  speed: number;
  startOffset: number;
  endOffset: number;
  startLength: number;
  width: number;
  startTime: number;
  duration: number;
  despawnDuration: number;
  hitboxStartTime: number;
  hitboxEndDelay: number;
  flags: number;
  state: number;
  timer: number;
}

export interface ItemEntity {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  type: ItemType;
  age: number;
  state: number;
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
  addScore(v: number): void;
  spawnItem(type: ItemType, x: number, y: number, options?: { state?: number; vx?: number; vy?: number }): void;
  spawnEffectParticles(effectId: number, x: number, y: number, count: number, color: number): void;
  playSfx(id: number): void;
  startDialogue?(index: number): void;
  isDialogueBlocking?(): boolean;
  consumeDialogueResume?(): boolean;
  startBossSpell?(spellId: number, arg0: number, name: string): void;
  endBossSpell?(opts?: { fromBossDeath?: boolean }): void;
  voidSpellCapture?(): void;
  setBossPresent?(present: boolean, enemy: Enemy | null): void;
  setBossLifeCount?(count: number): void;
  dropPointItems?(e: Enemy, count: number): void;
  awardSpellValue?(value: number): void;
  spawnEnemyDeathEffect?(e: Enemy): void;
  turnBulletsIntoPointItems(): void;
  configureAmbience?(op: number, args: number[]): void;
  // Boss timer-callback fired with the ECL "timeout is normal" flag unset
  // (exe flags +0x2e2a bit6 == 0): cherry -25% (FUN_0041e6b0's
  // floor10(cherry*0.25) penalty) — applies to nonspell timeouts too.
  onBossPhaseTimeout?(): void;
  unpauseStd(): void;
}

export interface EclContext {
  subId: number;
  index: number; // instruction index within sub
  time: number;
  windowBase: number; // register-window offset into EclState.vars
}

export interface EclState {
  ctx: EclContext;
  stack: EclContext[];
  subId: number;
  mirrored: boolean;
  itemDrop: number;
  vars: Float64Array;
  axisSpeed: { x: number; y: number; z: number };
  angle: number;
  angularVelocity: number;
  speed: number;
  acceleration: number;
  shootOffset: { x: number; y: number; z: number };
  moveMode: number;
  interpKind: number;
  interp: { start: { x: number; y: number; z: number }; delta: { x: number; y: number; z: number }; duration: number; left: number } | null;
  // mode-3 orbit group (exe +0x2b5c/60/6c/70/8c-94/a0/a4), see
  // reference/re-specs/exe-enemy-move-fields.md §3 Group B / §5.1.
  orbitAngle: number;
  orbitAngularVelocity: number;
  orbitSpeed: number;
  orbitAcceleration: number;
  orbitTarget: { x: number; y: number; z: number };
  orbitDuration: number; // 0 = never auto-stop (exe +0x2ba4)
  orbitLeft: number; // countdown (exe +0x2ba0)
  // "active" countdown (exe +0x76c, op 45 SetActiveTimer): while > 0, gates
  // ECL timeline advance + movement modes 1/2/3 (not mode 0's axisSpeed) --
  // see spec §2 / §5.4. Defaults to Infinity so enemies that never call op45
  // (the overwhelming majority) are unaffected.
  activeTimer: number;
  bulletProps: BulletProps | null;
  bulletSfx: number;
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
  bossLifeCount: number;
  lasers: (EnemyLaser | null)[];
  laserStore: number;
  interrupts: number[];
  runInterrupt: number;
  disableCallStack: boolean;
  invisible: boolean;
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
  // Op 136 (exe case 0x87 @ 0x413.. -> `+0x2e29` bit5, arg&1): enables the
  // enemy body's periodic re-graze (exe-collision.md §6, ~every 6 frames
  // while touching) and gates op94/killNonBossEnemies' cherry drop on
  // sweep (exe-ecl-boss.md op94 section) -- same bit, both consumers.
  // Default false: no confirmed default-on case in stage 1's own data.
  bodyRegrazeFlag: boolean;
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
  score: number;
  frame: number;
  dead?: boolean;
  ecl: EclState;
}
