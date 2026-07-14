import { Ecl, type EclInstr, type TimelineEvent } from '../formats/ecl';
import { Anm, AnmRunner } from '../formats/anm';
import { Std } from '../formats/std';
import { Msg } from '../formats/msg';
import { normalizeAngle, clamp, TAU } from '../core/util';
import type { Rng } from '../core/rng';
import type { GameHost, Enemy, EnemyBullet, EclState, EclContext, BulletProps, BulletExSlot, ItemType, EnemyLaser } from './types';

// TH07 ECL virtual machine. Opcode semantics were derived by aligning thtk's
// th07 signature table against the TH06 instruction set (implemented in the
// TH06 Web runtime this project is based on), then validated instruction by
// instruction against the thecl disassembly of the original stage scripts.
// Approximations and open questions are marked with `TH07-TODO`.

// Th07.exe bullet pool is 0x400 = 1024 slots (FUN_00421e90 / FUN_00423480 both
// gate on `< 0x400`; audit-bullet-motion.md D4). Was 640 (an empirical probe
// ceiling), which starved the densest Lunatic patterns ~384 bullets early.
const ENEMY_BULLET_CAP = 1024;
const ENEMY_LASER_CAP = 64;
const NATIVE_PI_F32 = 3.1415927410125732;
const NATIVE_TAU_F32 = 6.2831854820251465;
const NATIVE_HALF_PI_F32 = 1.5707963705062866;
const NATIVE_QUARTER_PI_F32 = 0.7853981852531433;
const NATIVE_SIXTH_PI_F32 = 0.5235987901687622;
const NATIVE_THIRD_PI_F32 = 1.0471975803375244;
const NATIVE_THREE_HALF_PI_F32 = 4.71238899230957;
const NATIVE_ONE_POINT_FIVE_F32 = 1.5;
const NATIVE_ONE_TENTH_F32 = 0.10000000149011612;
const EFFECT8_EASY_RANDOM_SCALE_F32 = 0.30000001192092896; // Th07.exe @ 0x48ead8
const EFFECT8_EASY_BASE_F32 = 0.699999988079071; // Th07.exe @ 0x48eb7c
const EFFECT8_HARD_RANDOM_SCALE_F32 = 0.4000000059604645; // Th07.exe @ 0x48ec74
const EFFECT8_HARD_BASE_F32 = 0.800000011920929; // Th07.exe @ 0x48eb78

// Th07.exe FUN_0042fff0 @ 0x42fff0 stores both operands through float32
// parameters before adding/wrapping them. The distinction is observable in
// effect-12/21 child trajectories after hundreds of frames.
function normalizeNativeAngleF32(angle: number, delta = 0): number {
  let value = Math.fround(Math.fround(angle) + Math.fround(delta));
  for (let i = 0; i < 18 && value > NATIVE_PI_F32; i++) {
    value = Math.fround(value - NATIVE_TAU_F32);
  }
  for (let i = 0; i < 18 && value < -NATIVE_PI_F32; i++) {
    value = Math.fround(value + NATIVE_TAU_F32);
  }
  return value;
}

// Advance one fired bullet's copied op-79 queue exactly as FUN_004229f0
// @ 0x4229f0. Construction calls it once; FUN_004241c0 calls it on every
// normal-state bullet-manager tick, including the spawn-ANM transition tick.
// Unselected slots and 0x2000 grace slots can be skipped in one invocation,
// but at most ONE movement behavior is promoted before returning.
export function advanceBulletExBehavior(bullet: EnemyBullet, activationRate = 1): void {
  if (!bullet.exSlots) return;
  let idx = bullet.exBehaviorIndex ?? 0;
  while (idx < 5) {
    const slot = bullet.exSlots[idx];
    if (!slot || slot.opcode === 0) return;
    // cond==0 waits at this slot while ANY earlier behavior flag is active.
    if (slot.cond === 0 && bullet.exFlags !== 0) return;
    idx++;
    bullet.exBehaviorIndex = idx;
    if ((bullet.exFireFlags & slot.opcode) === 0) continue;
    if (slot.opcode === 0x2000) {
      // +0xbf0 grace does not set +0xbf4 and does not consume the one-slot
      // movement budget; native immediately examines the next queue entry.
      bullet.graceFrames = Math.max(bullet.graceFrames ?? 0, slot.arg3 | 0);
      continue;
    }
    switch (slot.opcode) {
      case 1:
        bullet.exFlags |= 1;
        bullet.exRampElapsed = 0;
        bullet.exRampFrac = 0;
        break;
      case 0x10:
        bullet.exFlags |= 0x10;
        bullet.exAccel = {
          // Th07.exe FUN_004229f0 @ 0x422be9-0x422c0f bakes the CURRENT
          // global slow-rate into the acceleration vector when the queue
          // slot is promoted. FUN_00423910 multiplies that retained vector
          // by the current rate again on every tick. Stage-6 Sub28 promotes
          // this slot while rate=1/2, so retaining the nominal magnitude
          // made its three bullet layers accelerate exactly 2x too fast and
          // produced the first false graze at PRE25254.
          mag: Math.fround(slot.f0 * activationRate),
          angle: slot.f1 <= -990 ? bullet.angle : slot.f1,
          limit: slot.arg3
        };
        bullet.exAccelElapsed = 0;
        bullet.exAccelFrac = 0;
        break;
      case 0x20:
        bullet.exFlags |= 0x20;
        bullet.exAngle = { speedDelta: slot.f0, angleDelta: slot.f1, limit: slot.arg3 };
        bullet.exAngleElapsed = 0;
        bullet.exAngleFrac = 0;
        break;
      case 0x40:
      case 0x80:
      case 0x100:
        bullet.exFlags |= slot.opcode;
        bullet.exDir = {
          angle: slot.f0,
          newSpeed: slot.f1 <= -999 ? bullet.speed : slot.f1,
          interval: slot.arg3,
          maxTimes: slot.arg4
        };
        bullet.exDirElapsed = 0;
        bullet.exDirFrac = 0;
        bullet.dirTimes = 0;
        break;
      case 0x400:
      case 0x800:
        bullet.exFlags |= slot.opcode;
        bullet.exBounce = {
          speed: slot.f0 <= -999 ? bullet.speed : slot.f0,
          maxTimes: slot.arg3
        };
        bullet.exBounceTimes = 0;
        break;
      default:
        warnOnce(`ex${slot.opcode}`, `op-79 opcode 0x${slot.opcode.toString(16)} has no behavior mapping`);
        break;
    }
    return;
  }
}

// Item ids as used by ECL drop fields, confirmed against Th07.exe (v1.00b)
// collection switch FUN_00430c10 @ 0x430c10 (case 0..9 award behavior): the
// ECL id is passed unchanged as the spawn type -- there is no lookup table.
// 0 power, 1 point, 2 bigPower, 3 bomb, 4 fullPower, 5 life/1up, 6 cherry,
// 7 bigCherry, 8 border petal, 9 Stage-6+ cancel cherry.
const ITEM_TABLE: (ItemType | null)[] = [
  'power', 'point', 'bigPower', 'bomb', 'fullPower', 'life', 'cherry', 'bigCherry',
  'pointBullet', 'case9Cherry'
];

// Th07.exe (v1.00b) @ 0x494f90 -- the default-drop random table (32 bytes),
// fetched directly from the executable, not invented. Indexed by DAT_009545ba
// (wraps mod 32) on every 3rd default-drop enemy (DAT_009545b8 % 3 == 0).
// Values are item types: 0 power, 1 point, 2 bigPower, 7 bigCherry.
const RANDOM_ITEMS: ItemType[] = [
  'power', 'power', 'point', 'power', 'point', 'power', 'power', 'bigCherry',
  'point', 'point', 'power', 'power', 'bigCherry', 'point', 'point', 'power',
  'point', 'power', 'point', 'power', 'point', 'power', 'point', 'power',
  'point', 'power', 'bigCherry', 'point', 'point', 'point', 'power', 'bigPower'
];

// Th07.exe FUN_004256d0 @ 0x4256d0 builds 11 bullet templates; the kill AND
// graze hitbox share one per-shape FULL width, classified by primary sprite
// width (thresholds 8/16/32 @ 0x48eacc/d0/d4) then special-cased by anm
// script id: w<=8 -> 4; 8<w<=16 -> ids 0x202/204/205/206 (rice/kunai/
// crystal/knife) 4, default 6; 16<w<=32 -> 0x208 (ring) 5, 0x209 (amulet) 8,
// default 10; w>32 -> 24. Index is the ECL sprite/shape id 0-10 (type 3's
// primary script is 0x203 -> the 6.0 default branch, previously wrong here
// as 4). Graze adds a flat +20 pad (DAT_0048ebf4) at the test site, not in
// this table. Out-of-table ids fall back to the sprite-fraction
// approximation at point of use (flagged per AGENTS.md §7).
const BULLET_HITBOX_BY_SPRITE = [4, 6, 4, 6, 4, 4, 4, 10, 5, 8, 24];

// Special variable ids (reads resolved from game state). Writable general
// variables live in the enemy's 26-slot block (EclState.vars). Th07.exe has
// NO call-window shift of any kind: 10000-10015 are fixed per-enemy locals
// shared by every sub the enemy runs, 10029-10036/10072-10073 are more fixed
// per-enemy slots, 10037-10044 are eight RUN-GLOBALS shared across all
// enemies, and everything else is a computed special. See varRead.
const VAR_BASE = 10000;


const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[eclvm] ${message}`);
}

// Th07.exe FUN_0040f6c0 @ 0x415b91-0x415c05. ECL movement/interpolation
// uses conventional polynomial ease-out curves for modes 4-6; this is
// deliberately separate from ANM's formula table, whose modes 5/6 differ.
function applyEclEase(t: number, mode: number): number {
  switch (mode) {
    case 1: return t * t;
    case 2: return t * t * t;
    case 3: return t * t * t * t;
    case 4: return 1 - (1 - t) * (1 - t);
    case 5: return 1 - (1 - t) ** 3;
    case 6: return 1 - (1 - t) ** 4;
    default: return t;
  }
}

// FUN_0040f6c0's mode-2 controller stores the normalized progress and every
// formula result through float locals before constructing the Cartesian
// target (Th07.exe v1.00b @ 0x415b7d-0x415d01).  The generic helper above is
// also used by higher-level data paths where retaining a JS double is useful;
// movement must use the executable's staged single-precision variant.
function applyEclEaseNativeF32(t: number, mode: number): number {
  const v = Math.fround(t);
  switch (mode) {
    case 1: return Math.fround(v * v);
    case 2: return Math.fround(v * v * v);
    case 3: return Math.fround(v * v * v * v);
    case 4: {
      const inv = Math.fround(1 - v);
      return Math.fround(1 - Math.fround(inv * inv));
    }
    case 5: {
      const inv = Math.fround(1 - v);
      return Math.fround(1 - Math.fround(inv * inv * inv));
    }
    case 6: {
      const inv = Math.fround(1 - v);
      return Math.fround(1 - Math.fround(inv * inv * inv * inv));
    }
    default: return v;
  }
}

export interface StageData {
  ecl: string;
  std: string;
  msg: string;
  enemyAnm: string;
  bgAnm: string;
  // Stage 4 swaps between additional background ANM banks mid-stage.
  extraBgAnms?: readonly string[];
  effectAnm: string;
  stdTxtAnm: string;
  faceAnm: string;
}

interface SpawnEclEnemyOptions {
  subId: number;
  x: number;
  y: number;
  z?: number;
  life?: number;
  item?: number;
  score?: number;
  mirrored?: boolean;
  parent?: Enemy | null;
  // FUN_0041db60 installs inherited scratch variables before the child's
  // first synchronous ECL dispatch.
  initialVars?: ArrayLike<number>;
}

export class StageRuntime {
  readonly ecl: Ecl;
  readonly std: Std;
  readonly msg: Msg;
  readonly enemyAnm: Anm;
  readonly bulletAnm: Anm;
  readonly effectAnm: Anm;
  // TH07 runs several timelines in parallel (stage 1: main waves + ambience).
  timelineCursors: { index: number; frame: number }[] = [];
  // Trace of fired timeline spawn events (see update()); for timing audits.
  spawnLog: { t: number; time: number; sub: number }[] = [];
  // Test-only entity-lifecycle trace (PLAN.md Phase 0 / LIFE-001): spawn,
  // kill, release, boss-slot and visibility transitions, ring-capped.
  // Gameplay never reads it; the ?test=1 snapshot exposes it.
  lifecycleLog: { f: number; ev: string; id: number; sub: number; a?: number }[] = [];
  private randomItemIndex = 0;
  private randomSpawnIndex = 0;
  // FUN_00421e90 starts at a retained cursor and scans the 0x400-slot pool
  // circularly for the next free bullet.
  private bulletPoolCursor = 0;
  // Rebuilt from the live bullet list for each independent volley. A fixed
  // byte table preserves the exe's 0x400-slot scan order without allocating
  // and hashing a Set for every ECL fire instruction.
  private readonly bulletPoolOccupied = new Uint8Array(ENEMY_BULLET_CAP);
  private readonly bulletRectCache = new Map<string, { x: number; y: number; w: number; h: number; imageKey: string }>();
  bossSlots: (Enemy | null)[] = [];
  // Th07.exe DAT_00495bf4: true while any boss entity is registered.
  private bossRegistered = false;
  // Th07.exe DAT_012f40a8: GLOBAL spell-card-active state (op90 sets 1,
  // op91 clears). Every enemy's FIRE — boss AND op92/93 helpers — skips the
  // non-spell rank count/speed scaling while it is set. This was previously
  // a per-enemy flag, so helpers spawned during a spell fired rank-scaled
  // bullets (e.g. Letty final-spell 1.8 -> 1.3 at rank 0; CADENCE-001).
  spellActive = false;
  // ECL run-globals, vars 10037-10044 (Th07.exe DAT_0133da80..9c): four int
  // and four float slots shared by every enemy — boss controllers write
  // pattern parameters here and child emitters read them back.
  globalsInt = new Int32Array(4);
  globalsFloat = new Float64Array(4);
  // Every native ANM VM consumes the same gameplay RNG at 0x495e00.
  // Enemy runners are created from ECL dispatch, so retain the host stream
  // for constructors reached indirectly by pose changes and auxiliary slots.
  private anmRng: Rng | undefined;

  constructor(stage: StageData, anms: { etama: Anm; enemy: Anm; effect: Anm }) {
    this.ecl = new Ecl(stage.ecl);
    this.std = new Std(stage.std);
    this.msg = new Msg(stage.msg);
    this.enemyAnm = anms.enemy;
    this.bulletAnm = anms.etama;
    this.effectAnm = anms.effect;
  }

  private logLifecycle(game: GameHost, ev: string, e: Enemy, a?: number): void {
    if (this.lifecycleLog.length >= 4096) this.lifecycleLog.splice(0, 1024);
    this.lifecycleLog.push({ f: game.frame, ev, id: e.id, sub: e.ecl.subId, ...(a !== undefined ? { a } : {}) });
  }

  reset(): void {
    this.timelineCursors = this.ecl.timelines.map(() => ({ index: 0, frame: 0 }));
    this.bulletPoolCursor = 0;
    this.bossSlots = [];
    this.bossRegistered = false;
    this.spellActive = false;
    this.lifecycleLog = [];
    this.globalsInt.fill(0);
    this.globalsFloat.fill(0);
    this.std.reset();
  }

  initializeRandomCounters(rng: Rng): void {
    // Th07.exe (v1.00b) FUN_00421410 @ 0x42148c / 0x4214c4 seeds the
    // process-global enemy-death phase and RANDOM_ITEMS cursor from the live
    // gameplay stream when the stage managers are initialized. Replay setup
    // restores the recorded stage seed before these two calls.
    this.randomSpawnIndex = rng.u16InRange(3);
    this.randomItemIndex = rng.u16InRange(8);
  }

  isTimelineComplete(): boolean {
    return this.timelineCursors.every((c, t) => c.index >= this.ecl.timelines[t].length);
  }

  get mainTimeline(): { index: number; frame: number } {
    return this.timelineCursors[0] ?? { index: 0, frame: 0 };
  }

  private isEnemyActive(game: GameHost, enemy: Enemy | null): boolean {
    return !!enemy && !enemy.dead && game.enemies.includes(enemy);
  }

  update(game: GameHost): void {
    const rate = game.slowRate ?? 1;
    if (!game.timeStopped) this.std.advance(rate);
    if (this.timelineCursors.length === 0) this.reset();
    for (let t = 0; t < this.ecl.timelines.length; t++) {
      const timeline = this.ecl.timelines[t];
      const cursor = this.timelineCursors[t];
      let held = false;
      while (cursor.index < timeline.length && timeline[cursor.index].time <= cursor.frame) {
        const evt = timeline[cursor.index];
        // Negative-time events never fire in the original engine.
        if (evt.time < 0) {
          cursor.index++;
          continue;
        }
        const action = this.runTimelineEvent(game, evt, t);
        if (action === 'hold') {
          held = true;
          break;
        }
        cursor.index++;
      }
      // Timeline clock advances at the global rate (spec-slowmo.md §3.2).
      // Th07.exe (v1.00b) FUN_0041de20 @ all.c:13533-13720 has no
      // manager-wide dialogue gate here.  Timeline op 9 implements the
      // authored wait locally by cancelling this tail increment while the
      // message manager is active; op 8 starting a message must not freeze
      // the clock on its own.
      if (!held) cursor.frame += rate;
    }
  }

  private runTimelineEvent(game: GameHost, evt: TimelineEvent, t: number): 'hold' | null {
    switch (evt.op) {
      case 0:
      case 2:
      case 4:
      case 6: {
        // Th07.exe FUN_0041de20 ops 0-7: all timeline spawns are dropped while
        // DAT_00495bf4 (any boss registered) is set — consumed, not deferred.
        if (this.bossRegistered) return null;
        this.spawnLog.push({ t, time: evt.time, sub: evt.arg0 });
        // Timeline op 2 passes the mirror flag into FUN_0041da10, so its
        // synchronous allocator core already sees it. Op 6 is subtly
        // different: the exe sets enemy+0x2e28 bit 6 only AFTER that core
        // returns (all.c:13581-13587 / 13643-13665).
        let { x = 0, y = 0, z = 0 } = evt;
        if (x <= -990) x = game.rng.range(384);
        if (y <= -990) y = game.rng.range(448);
        if (z <= -990) z = game.rng.range(800);
        const enemy = this.spawnEclEnemy(game, {
          subId: evt.arg0,
          x, y, z,
          life: evt.life ?? -1,
          item: evt.item ?? -1,
          score: evt.score ?? -1,
          mirrored: evt.op === 2
        });
        if (evt.op === 6) enemy.ecl.mirrored = true;
        return null;
      }
      case 8:
        game.startDialogue?.(evt.arg0);
        return null;
      case 9:
        if (game.consumeDialogueResume?.()) return null;
        // FUN_00429446 polls the MSG manager's active message index (unless
        // op 6 left a one-frame resume ticket). This is deliberately NOT the
        // gameplay-freeze predicate: timestamp-only message tracks remain
        // active and hold their authored timeline while gameplay continues.
        return game.isDialogueActive?.() ? 'hold' : null;
      case 10: {
        const boss = this.bossSlots[evt.i0 ?? 0];
        if (this.isEnemyActive(game, boss)) boss!.ecl.pendingInterrupt = evt.i1 ?? 0;
        return null;
      }
      case 12: {
        const boss = this.bossSlots[evt.arg0 ?? 0];
        return this.isEnemyActive(game, boss) ? 'hold' : null;
      }
      default:
        warnOnce(`tl${evt.op}`, `unhandled timeline op ${evt.op}`);
        return null;
    }
  }

  spawnEclEnemy(game: GameHost, opts: SpawnEclEnemyOptions): Enemy {
    const {
      subId, x, y, z = 0, life = -1, item = -1, score = -1,
      mirrored = false, parent = null, initialVars
    } = opts;
    const hasLife = life >= 0;
    const hasScore = score >= 0;
    // The native template still carries its default random-drop marker during
    // the synchronous t0 core. Both allocators write itemDrop and score only
    // after FUN_0040f6c0 returns (all.c:13395-13412/13448-13474).
    const ecl = this.makeEnemyState(subId, mirrored, -1, parent);
    if (initialVars) {
      const count = Math.min(ecl.vars.length, initialVars.length);
      for (let i = 0; i < count; i++) ecl.vars[i] = Number(initialVars[i]);
    }
    const e: Enemy = {
      id: game.id++,
      poolSlot: -1,
      x, y, z,
      hp: hasLife ? life | 0 : 1,
      maxHp: hasLife ? life | 0 : 1,
      pendingShotDmg: 0,
      pendingBombDmg: 0,
      score: 100,
      frame: 0,
      ecl
    };
    if (game.addEnemy) {
      if (!game.addEnemy(e)) e.dead = true;
    } else {
      game.enemies.push(e);
    }
    this.logLifecycle(game, 'spawn', e, parent?.id);
    // Apply the timeline life/score BEFORE the initial ECL run so a t=0
    // op110 (set HP) is not clobbered by the spawn-event life afterwards.
    // Bosses ship with life=1 as a placeholder; their real HP comes from
    // op110 inside the entry sub. The old post-run overwrite reset every
    // stage-4+ multi-slot boss back to 1 and let the first player shot
    // fire its death-callback (op99(-1)) on frame 1.
    if (hasLife) e.hp = e.maxHp = life | 0;
    // Both native allocators execute one complete FUN_0040f6c0 core tick
    // synchronously, including the movement controller, but do not run the
    // enemy manager's position integrator, regular ANM update,
    // collision/death pass, or tail timers. A timeline-spawned actor whose
    // slot has not yet been scanned can therefore run the core twice before
    // its first integration: once here and once in the manager pass.
    this.tickEnemyCore(game, e, true);
    if (e.dead) {
      // Th07.exe (v1.00b) FUN_0041da10/FUN_0041db60 @ all.c:13402-13408 /
      // 13461-13467: when the synchronous FUN_0040f6c0 returns -1, the
      // allocator clears enemy+0x2e28 bit7 immediately. It does NOT call
      // FUN_0041ea00, so no replay AUX-0x20 slot-vacate event is emitted.
      // Stage 2 Sub28/29 are common t=0 fire wrappers that take this path.
      if (game.discardAllocatedEnemy) game.discardAllocatedEnemy(e);
      else {
        const dense = game.enemies.indexOf(e);
        if (dense >= 0) game.enemies.splice(dense, 1);
      }
      return e;
    }
    // FUN_0041db60 (child allocator) reapplies an explicit HP after t0;
    // timeline FUN_0041da10 deliberately keeps a t0 op110 result.
    if (parent && hasLife) e.hp = life | 0;
    e.ecl.itemDrop = item;
    if (hasScore) e.score = score | 0;
    e.maxHp = Math.max(1, e.hp);
    return e;
  }

  private makeEnemyState(subId: number, mirrored: boolean, itemDrop: number, parent: Enemy | null): EclState {
    return {
      ctx: { subId, index: 0, time: 0, timeFrac: 0, waitTimer: 0 },
      stack: [],
      subId,
      mirrored,
      itemDrop,
      // Children inherit the parent's whole 26-dword variable block —
      // Th07.exe FUN_0041db60 copies 0x1a dwords from parent+0x6fc (locals,
      // extra floats, both rand configs) into every op92/93 spawn.
      vars: parent ? parent.ecl.vars.slice() : new Float64Array(26),
      axisSpeed: { x: 0, y: 0, z: 0 },
      angle: 0,
      angularVelocity: 0,
      speed: 0,
      acceleration: 0,
      shootOffset: { x: 0, y: 0, z: 0 },
      laserSlots: new Array(32).fill(null),
      laserSlotIndex: 0,
      interpSlots: new Array(8).fill(null),
      effectArm: null,
      movementSuppressedByEffect0: false,
      periodicSub: null,
      periodicExportArmed: false,
      pendingInterrupt: -1,
      hitbox2: null,
      moveMode: 0,
      interpKind: 0,
      interp: null,
      heading: 0,
      orbitAngle: 0,
      orbitAngularVelocity: 0,
      orbitSpeed: 0,
      orbitAcceleration: 0,
      orbitTarget: { x: 0, y: 0, z: 0 },
      orbitDuration: 0,
      orbitLeft: 0,
      bulletProps: null,
      bulletSfx: 0,
      bulletSfxInterval: 0,
      bulletExSlots: [null, null, null, null, null],
      shootDisabled: false,
      shootInterval: 0,
      shootTimer: 0,
      shootTimerFrac: 0,
      hitbox: { x: 28, y: 28, z: 32 },
      isBoss: false,
      bossSlot: null,
      canTakeDamage: true,
      collisionEnabled: true,
      interactable: true,
      shotCollision: true, // default bit4=1, Th07.exe FUN_0041d190 @ 0x41d190

      deathMode: 0,
      deathCallbackSub: -1,
      lifeThresholds: [{threshold:-1,sub:-1},{threshold:-1,sub:-1},{threshold:-1,sub:-1},{threshold:-1,sub:-1}],
      timerCallbackThreshold: -1,
      timerCallbackSub: -1,
      bossTimer: 0,
      bossTimerPrevious: -999,
      currentAnm: -1,
      anmRunner: null,
      anmSlots: [],
      anmExDefaults: -1,
      anmExFarLeft: -1,
      anmExFarRight: -1,
      anmExLeft: -1,
      anmExRight: -1,
      anmExFlags: 0xff,
      deathAnm1: 0,
      deathAnm2: 0,
      deathAnm3: 0,
      integratorPreviousPosition: { x: 0, y: 0, z: 0 },
      frameVx: 0,
      frameVy: 0,
      frameVz: 0,
      anmRotateWithAngle: false,
      bossLifeCount: 0,
      lasers: [],
      laserStore: 0,
      // Th07.exe FUN_0041d190 zero-fills the 32-entry +0x2a88 interrupt
      // table. An unset interrupt therefore targets global sub 0.
      interrupts: new Array(32).fill(0),
      disableCallStack: false,
      invisible: false,
      spellTimeoutFlag: false,
      // Enemy-manager template defaults, Th07.exe FUN_0041d190
      // @ 0x41d51f-0x41d52f: the allocator copies -0.15/+0.15 into every
      // fresh enemy. The wider -0.5/+0.5 pair belongs only to phase-entry
      // resets (FUN_0041e4a0/phaseTransition), handled separately below.
      bulletRankSpeedLow: -0.15000000596046448,
      bulletRankSpeedHigh: 0.15000000596046448,
      bulletRankAmount1Low: 0,
      bulletRankAmount1High: 0,
      bulletRankAmount2Low: 0,
      bulletRankAmount2High: 0,
      lowerMoveLimit: { x: 0, y: 0 },
      upperMoveLimit: { x: 384, y: 448 },
      shouldClamp: false,
      spellName: '',
      seen: false,
      sweepItemFlag: false,
      offscreenCullExempt: false,
      // FUN_0041d6a0 reserves 96 entries at enemy+0x2f78, initially zeroed
      // by the allocator template. Op138 changes only the four config fields;
      // it deliberately does not clear an already-running history.
      trailFlags: 0,
      trailCount: 0,
      trailStart: 0,
      trailStride: 0,
      // Th07.exe FUN_0041d190 initializes the X dword of all 96 template
      // history entries to -999.0 (manager+0x2f80, i.e. enemy+0x2f78),
      // leaving Y/Z zero. The cull/render validity gate is x >= -990. A
      // zero-filled tail therefore looks like an on-screen point and keeps a
      // freshly armed op138 actor's fixed slot alive long after its real
      // head has exited.
      trailHistory: Array.from({ length: 96 }, () => ({ x: -999, y: 0, z: 0 })),
      damageShield: 0,
      damageShieldFrac: 0
    };
  }



  // ---- variables -----------------------------------------------------------

  // Variable model, decoded verbatim from Th07.exe's four resolvers
  // (FUN_0040d750 int-value / FUN_0040df90 float-value / FUN_0040dda0
  // int-address / FUN_0040e560 float-address, all.c:5583-6268). There is NO
  // register window anywhere in the executable — an earlier port model
  // shifted ids ≥10029 by +8 per CALL, which silently privatized what are
  // actually fixed per-enemy fields and run-globals and broke every script
  // that passes parameters between enemies (Alice's whole stage-3 boss fight
  // ran on zeroed configs). The real model:
  //   10000-10015  fixed per-enemy locals (vars[0..15]); ints at 10000-10003/
  //                10012-10015, floats at 10004-10011.
  //   10016/10017  difficulty / rank globals.
  //   10018-10023  own position / player position.
  //   10024-10028  aim-to-player, bossTimer, player distance, HP, shot index.
  //   10029-10032  per-enemy rand-int config  (vars[18..21], +0x744..+0x750).
  //   10033-10036  per-enemy rand-float config (vars[22..25], +0x754..+0x760).
  //   10037-10044  RUN-GLOBALS shared by every enemy: 4 int + 4 float
  //                (DAT_0133da80..9c) — the cross-enemy parameter bus.
  //   10045-10054  live movement state (named fields).
  //   10055        rng draw (int: raw u16; float: [0,1)).
  //   10056        configured random (int: base+rng%range from 10029/10030;
  //                float: base+rng01()*range from 10033/10034).
  //   10060        random angle in [-π, π)  (rng01()*2π − π).
  //   10061-10071  damage-this-frame, boss slot, frame move deltas, op148
  //                thresholds, item drop, death score.
  //   10072/10073  two extra per-enemy float slots (vars[16..17]).
  // An id with no mapping resolves to its own literal value (the exe
  // resolvers' default leaves the raw argument untouched).

  private varRead(game: GameHost, e: Enemy, id: number, asFloat = false): number {
    const s = e.ecl;
    switch (id) {
      case 10016: return game.difficulty;
      case 10017: return game.rank;
      // Th07.exe var resolver FUN_0040d750/FUN_0040dda0 (disasm confirmed):
      // 10018/19/20 = the ENEMY's OWN position (*(enemy+0x2b0c/0x2b10/0x2b14)),
      // 10021/22/23 = the PLAYER position (DAT_004b43e8/ec/f0). These were
      // previously swapped (10018/19/20 wrongly returned the player), which
      // made Letty's Table-Turning snowflakes (sub 57: op56 orbit target =
      // var10018/19/20) and the ring emitters in sub 30 (`cos*160 + var10018`)
      // center on the player instead of on the boss/emitter — they stranded
      // where the player stood. 10024 (aim-to-player) is a distinct computed
      // case and is unaffected.
      case 10018: return e.x;
      case 10019: return e.y;
      case 10020: return e.z;
      case 10021: return game.player.x;
      case 10022: return game.player.y;
      case 10023: return 0; // player z
      // Angle from the enemy TOWARD the player — the exe routes var 10024
      // through the same shared FUN_0043f2b0 the FIRE aim uses (recon
      // vm-stage4-opener.md; exe-items.md independently decoded that
      // function as atan2(player - pos)). Was reversed (enemy - player):
      // every snapshot-then-absolute-fan idiom fired 180° away from the
      // player (stage-4 opener subs 9/10/13/14 and dozens of sites across
      // stages 1-8; VM-001).
      case 10024: return Math.atan2(game.player.y - e.y, game.player.x - e.x);
      // Th07.exe FUN_0040d750/FUN_0040df90: 10025 = bossTimer (+0x2bcc),
      // 10026 = player-enemy 3D distance (FUN_00403d50). Previously swapped.
      case 10025: return s.bossTimer;
      case 10026: return Math.hypot(game.player.x - e.x, game.player.y - e.y, -e.z);
      case 10027: return e.hp;
      case 10028: return game.shotIndex ?? 0; // DAT_00625627: character*2 + shotType
      // Per-enemy random config (see the vars block comment in types.ts) and
      // the eight run-globals (Th07.exe DAT_0133da80..9c) — the cross-enemy
      // parameter bus boss controllers use to configure child emitters.
      case 10029: case 10030: case 10031: case 10032:
        return s.vars[18 + (id - 10029)];
      case 10033: case 10034: case 10035: case 10036:
        return s.vars[22 + (id - 10033)];
      case 10037: case 10038: case 10039: case 10040:
        return this.globalsInt[id - 10037];
      case 10041: case 10042: case 10043: case 10044:
        return this.globalsFloat[id - 10041];
      // Th07.exe exposes the enemy's LIVE movement state through the var system
      // (FUN_0040df90 value-resolver, audit-letty-phases.md §0). The engine
      // keeps these in named fields, so alias the var ids to them — otherwise
      // ECL that reads/writes them via vars (Letty 二非 sub41, 终符 sub57) hits a
      // dead slot and the pattern degrades (orbs collapse to the boss, rings
      // fire at a fixed angle instead of swirling with the orbit).
      case 10045: return s.heading; // +0x2b54 live heading (stored; a stationary enemy retains the last value)
      case 10046: return s.angularVelocity;                // +0x2b58 mode-1
      case 10047: return s.speed;                           // +0x2b64 mode-1
      case 10048: return s.acceleration;                    // +0x2b68 mode-1
      case 10049: return s.orbitSpeed;                      // +0x2b6c mode-3 orbit
      case 10053: return s.orbitAngle;                      // +0x2b5c mode-3 orbit
      case 10054: return s.orbitAngularVelocity;            // +0x2b60 mode-3 orbit
      // Random draws (FUN_0040d750/FUN_0040df90 cases 0x2747/0x2748/0x274c):
      // the int and float readers return DIFFERENT things for the same id.
      case 10055: return asFloat ? game.rng.f() : game.rng.u16();
      case 10056: return asFloat
        ? s.vars[23] + game.rng.f() * s.vars[22]
        : s.vars[19] + game.rng.u16InRange(Math.abs(Math.trunc(s.vars[18])));
      case 10060: return game.rng.f() * (Math.PI * 2) - Math.PI; // rand angle [-π, π), consts @ 0x48eab0/b4
      case 10061: return e.damageThisFrame ?? 0; // +0x2e4c, zeroed per frame at all.c:14173
      case 10062: return s.bossSlot ?? 0;        // +0x2e17, written by op99
      // +0x2b30/34/38 = this frame's movement delta (all.c:13120-13122).
      case 10063: return s.frameVx;
      case 10064: return s.frameVy;
      case 10065: return s.frameVz;
      // op148 HP-threshold slots (+0x2ebc..+0x2ec8); unarmed reads as 0.
      case 10066: case 10067: case 10068: case 10069: {
        const t = s.lifeThresholds[id - 10066].threshold;
        return t < 0 ? 0 : t;
      }
      case 10070: return s.itemDrop; // +0x2e10
      case 10071: return e.score;    // +0x2bc0 death score
      case 10072: return s.vars[16]; // +0x73c
      case 10073: return s.vars[17]; // +0x740
    }
    const rel = id - VAR_BASE;
    if (rel >= 0 && rel <= 15) return s.vars[rel];
    // Exe resolvers' default: an unmapped id resolves to its own literal
    // value. Warn once anyway — it usually means a special worth decoding.
    if (rel >= 0 && rel < 100) warnOnce(`r${id}`, `read of unmapped variable ${id}`);
    return id;
  }

  // FUN_0040dda0 is the integer-address resolver. It deliberately maps only
  // integer-backed variables; an id for a float local (for example 10004)
  // falls through and the exe writes into the instruction argument itself,
  // not the enemy variable block. Retail Stage-3 Sub8 relies on this exact
  // mismatch: op10(10004, 0) consumes its sign draw but leaves the emitter's
  // saved X coordinate intact, and FIRE later uses that value as its ring
  // angle stride. Treat unsupported typed destinations as no-ops here rather
  // than corrupting the opposite-typed game variable.
  private varWriteInt(game: GameHost, e: Enemy, id: number, value: number): void {
    const s = e.ecl;
    const integer = Math.trunc(value);
    switch (id) {
      case 10000: case 10001: case 10002: case 10003:
        s.vars[id - 10000] = integer; return;
      case 10012: case 10013: case 10014: case 10015:
        s.vars[id - 10000] = integer; return;
      case 10016: game.difficulty = integer; return;
      case 10017: game.rank = integer; return;
      case 10025: s.bossTimer = integer; return;
      case 10027: e.hp = integer; return;
      case 10029: case 10030: case 10031: case 10032:
        s.vars[18 + (id - 10029)] = integer; return;
      case 10037: case 10038: case 10039: case 10040:
        this.globalsInt[id - 10037] = integer; return;
      case 10070: s.itemDrop = integer; return;
      case 10071: e.score = integer; return;
      default: return;
    }
  }

  private varWrite(game: GameHost, e: Enemy, id: number, value: number): void {
    const s = e.ecl;
    // FUN_0040e560 writes every float-backed destination through a 32-bit
    // slot. Keep the cast at the resolver boundary so arithmetic opcodes,
    // call parameters, and special movement aliases cannot retain JS-double
    // residue between instructions.
    const f32 = Math.fround(value);
    switch (id) {
      // Th07.exe FUN_0040e560: own position is writable through the float
      // var system; the player-position slots (10021-10023) are technically
      // writable too but no retail script does — refuse defensively.
      case 10018: e.x = f32; return;
      case 10019: e.y = f32; return;
      case 10020: e.z = f32; return;
      case 10021: case 10022: case 10023:
        warnOnce(`w${id}`, `ignored write to player position var ${id}`);
        return;
      // FUN_0040dda0: bossTimer write is 10025, hp is 10027.
      case 10025: s.bossTimer = value; return;
      case 10027: e.hp = value; return;
      case 10029: case 10030: case 10031: case 10032:
        s.vars[18 + (id - 10029)] = value; return;
      case 10033: case 10034: case 10035: case 10036:
        s.vars[22 + (id - 10033)] = f32; return;
      case 10037: case 10038: case 10039: case 10040:
        this.globalsInt[id - 10037] = Math.trunc(value); return;
      case 10041: case 10042: case 10043: case 10044:
        this.globalsFloat[id - 10041] = f32; return;
      // Movement-state vars (see varRead): writable ones alias to the named
      // movement fields so ECL writes reach the integrator. 10045 is the
      // stored heading (+0x2b54, FUN_0040e560 case 0x273d) — mode-1 motion
      // reads it back as the travel angle.
      case 10045: s.heading = f32; s.angle = f32; return;
      case 10046: s.angularVelocity = f32; return;
      case 10047: s.speed = f32; return;
      case 10048: s.acceleration = f32; return;
      case 10049: s.orbitSpeed = f32; return;
      case 10053: s.orbitAngle = f32; return;
      // Th07.exe FUN_0040e560 stores special float var 10054 directly into
      // enemy+0x2b60. Stage-4 Sub135 op19 increments this orbit angular
      // velocity every frame and feeds it to op85; retaining JS-double
      // precision shifts the rotating laser rectangles enough to change
      // effect-8 bullet contacts at PRE24123/24151/24154. The native f32
      // store makes the complete Stage-4 PRE stream exact through 24444.
      case 10054: s.orbitAngularVelocity = f32; return;
      case 10070: s.itemDrop = Math.trunc(value); return;
      case 10071: e.score = Math.trunc(value); return;
      case 10072: s.vars[16] = f32; return;
      case 10073: s.vars[17] = f32; return;
    }
    const rel = id - VAR_BASE;
    if (rel >= 0 && rel <= 15) {
      s.vars[rel] = f32;
      return;
    }
    warnOnce(`w${id}`, `ignored write to unmapped variable ${id}`);
  }

  private getInt(game: GameHost, e: Enemy, off: number): number {
    const raw = this.ecl.view.i32(off);
    // Th07.exe (v1.00b) FUN_0040d750 -> FUN_00481260: the latter is MSVC's
    // x87 `_ftol` helper. Despite Ghidra rendering its initial FISTP as
    // ROUND(), the correction tail implements a C cast (truncate toward
    // zero). Stage-3 Sub29 supplies 15.8464 through var10006 to op54 and the
    // native controller duration is 15, not 16.
    if (raw >= VAR_BASE && raw < VAR_BASE + 100) return Math.trunc(this.varRead(game, e, raw, false));
    return raw;
  }

  private getShort(game: GameHost, e: Enemy, off: number): number {
    const raw = this.ecl.view.i16(off);
    if (raw >= VAR_BASE && raw < VAR_BASE + 100) return Math.trunc(this.varRead(game, e, raw, false));
    return raw;
  }

  private getFloat(game: GameHost, e: Enemy, off: number): number {
    const value = this.ecl.view.f32(off);
    const asInt = Math.trunc(value);
    if (Math.abs(value - asInt) < 0.00001 && asInt >= VAR_BASE && asInt < VAR_BASE + 100) {
      return Number(this.varRead(game, e, asInt, true));
    }
    return value;
  }

  // ---- per-frame enemy processing -----------------------------------------

  updateEnemy(game: GameHost, e: Enemy): void {
    // Compatibility/full-manager wrapper used by focused VM tests. The live
    // StageScene calls the same phases around its native cull/collision/death
    // work so their ordering remains visible there.
    do {
      this.tickEnemyCore(game, e);
      if (e.dead) return;
      this.integrateEnemyPosition(e, game.slowRate ?? 1);
    } while (this.processEnemyCallbacks(game, e));
    this.updateEnemyAnm(e, game.slowRate ?? 1);
    this.tickEnemyManagerTail(game, e);
  }

  // FUN_0040f6c0: the reusable enemy core. Both allocators call this once
  // synchronously, and the manager calls it again when it reaches the slot.
  // Position integration, regular ANM ticking, collision/death, bossTimer,
  // and the damage-shield countdown are deliberately manager-only.
  tickEnemyCore(game: GameHost, e: Enemy, allocatorCore = false): void {
    this.anmRng = game.rng;
    const s = e.ecl;
    // dispatchEcl owns LAB_0040f6d1's interrupt/periodic preamble. Native
    // CALL and RETURN both jump back to that label, so the op144 timer may
    // advance multiple times inside one enemy-core invocation.
    // Dispatch precedes movement and auto-fire. The clock increments only at
    // the very tail, after op122/op27 (all.c:7105-7329).
    const advanceClock = this.dispatchEcl(game, e);
    if (e.dead) return;
    // op121 may change DAT_0056baa8 inside dispatch. Native tail helpers read
    // the global after dispatch, so movement and the ECL split clock use the
    // newly written rate on that same core tick (FUN_00436acc call sites),
    // while the periodic pre-dispatch timer above used the entry rate.
    const tailRate = game.slowRate ?? 1;
    // Th07.exe (v1.00b): both FUN_0041da10 and FUN_0041db60 call the complete
    // FUN_0040f6c0 core synchronously. The controller is inside that core;
    // only FUN_0041d050 position integration is manager-only. Consequently a
    // newly spawned, not-yet-scanned slot advances the controller here and
    // again when the manager reaches it later in the same pass.
    this.updateMovementController(e, tailRate);
    this.updateAutoShoot(game, e);
    this.updateAnmPose(e);
    // Armed op122 and op27 slots are HP-gated and run after dispatch, so an
    // instruction armed at t0 takes effect during this same allocation core.
    if (e.hp > 0) {
      if (s.effectArm) this.runBulletEffect(game, e, s.effectArm.id, this.getInt(game, e, s.effectArm.paramOff));
      this.tickInterpSlots(game, e);
    }
    if (advanceClock) this.advanceEclClock(s, tailRate);
  }

  private tickPeriodicSub(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    if (!s.periodicSub || s.periodicSub.subId < 0) return;
    // Th07.exe FUN_0040f6c0 @ all.c:7074-7082 stores the op144 clock as
    // integer +0x2f64 and fraction +0x2f60 and advances it with
    // FUN_00436acc. The old single-double accumulation reaches only
    // 5.999999999999998 after 18 additions of 1/3, delaying every period-6
    // callback by one wall frame. Stage-5 spell 75 repeats that callback
    // five times during bullet-time, displacing its sword-cut parents by
    // exactly five slowed velocity vectors.
    const periodic = s.periodicSub;
    periodic.elapsedFrac ??= 0;
    const rate = game.slowRate ?? 1;
    if (rate > 0.99) {
      periodic.elapsed++;
    } else {
      periodic.elapsedFrac += rate;
      if (periodic.elapsedFrac >= 1) {
        periodic.elapsed++;
        periodic.elapsedFrac -= 1;
      }
    }
    if (periodic.elapsed < periodic.period) return;
    periodic.elapsed = 0;
    periodic.elapsedFrac = 0;
    // all.c:7081-7102: periodic entry pushes the current 0x218-byte frame,
    // loads the sub's persistent variable stash, and arms the first RETURN
    // to export that stash through enemy+0x8f4.
    this.pushFrame(s);
    s.vars.set(s.periodicSub.savedVars);
    s.periodicExportArmed = true;
    this.enterSub(s, s.periodicSub.subId);
  }

  private updateMovementController(e: Enemy, rate: number): void {
    const s = e.ecl;
    if (s.moveMode === 2 && s.interp) {
      const m = s.interp;
      m.left = Math.max(0, m.left - rate);
      // Th07.exe FUN_0040f6c0 @ 0x415b7d-0x415ed8 stages progress,
      // eased displacement, absolute target, per-axis delta, and heading
      // through float32 locals/fields.  Keeping the tiny intermediate target
      // residue in double precision is not benign: Stage-4 Sub133's nominal
      // vertical move left the top Prismriver at x=191.9997406 instead of
      // native x=192.  SakuyaA then broke a strict closest-|dx| tie and aimed
      // a whole volley at the wrong sister.
      const progress = Math.fround(clamp(
        1 - m.left / Math.max(1, m.duration),
        0,
        1
      ));
      const t = applyEclEaseNativeF32(progress, s.interpKind);
      const tx = Math.fround(Math.fround(t * Math.fround(m.delta.x)) + Math.fround(m.start.x));
      const ty = Math.fround(Math.fround(t * Math.fround(m.delta.y)) + Math.fround(m.start.y));
      const tz = Math.fround(Math.fround(t * Math.fround(m.delta.z)) + Math.fround(m.start.z));
      let vx = Math.fround(tx - Math.fround(e.x));
      const vy = Math.fround(ty - Math.fround(e.y));
      const vz = Math.fround(tz - Math.fround(e.z));
      // FUN_0040f6c0 flips the computed X delta for mirrored actors; the
      // manager integrator flips it back when applying it (all.c:7161/13126).
      if (s.mirrored) vx = Math.fround(-vx);
      s.axisSpeed = { x: vx, y: vy, z: vz };
      // FUN_0048166a consumes the controller vector after the internal
      // mirror flip, before FUN_0041d050 applies the second flip on screen
      // (all.c:7152-7165). Keep this separate from vars 10063..10065.
      if (vx !== 0 || vy !== 0) s.heading = Math.fround(Math.atan2(vy, vx));
      if (m.left <= 0) {
        // Mode-2 completion snaps inside the core even on an allocation-only
        // tick, then clears the velocity before the manager integrator.
        e.x = Math.fround(Math.fround(m.start.x) + Math.fround(m.delta.x));
        e.y = Math.fround(Math.fround(m.start.y) + Math.fround(m.delta.y));
        e.z = Math.fround(Math.fround(m.start.z) + Math.fround(m.delta.z));
        s.axisSpeed = { x: 0, y: 0, z: 0 };
        s.moveMode = 0;
        s.interp = null;
      }
    } else if (s.moveMode === 3) {
      // Th07.exe (v1.00b) FUN_0040f6c0 @ all.c:7168-7191 stores every
      // mode-3 controller result back through 32-bit fields: normalized
      // angle, radial speed, FUN_004074e0's orbit vector, and the final
      // Cartesian delta. Retaining doubles moves long-lived Stage-4 laser
      // owners by ~1e-3px and changes effect-8 edge membership.
      const rateF32 = Math.fround(rate);
      const angleDelta = Math.fround(Math.fround(s.orbitAngularVelocity) * rateF32);
      s.orbitAngle = normalizeNativeAngleF32(s.orbitAngle, angleDelta);
      s.orbitSpeed = Math.fround(
        Math.fround(s.orbitAcceleration) * rateF32 + Math.fround(s.orbitSpeed)
      );
      const orbitX = Math.fround(Math.cos(s.orbitAngle) * s.orbitSpeed);
      const orbitY = Math.fround(Math.sin(s.orbitAngle) * s.orbitSpeed);
      s.axisSpeed.x = Math.fround(orbitX + Math.fround(s.orbitTarget.x) - Math.fround(e.x));
      s.axisSpeed.y = Math.fround(orbitY + Math.fround(s.orbitTarget.y) - Math.fround(e.y));
      if (s.axisSpeed.x !== 0 || s.axisSpeed.y !== 0) {
        s.heading = Math.fround(Math.atan2(s.axisSpeed.y, s.axisSpeed.x));
      }
      if (s.orbitDuration > 0 && (s.orbitLeft -= rate) < 1) s.moveMode = 0;
    } else if (s.moveMode === 1) {
      s.angle = normalizeAngle(s.angle + s.angularVelocity * rate);
      s.speed += s.acceleration * rate;
      s.axisSpeed = { x: Math.cos(s.angle) * s.speed, y: Math.sin(s.angle) * s.speed, z: 0 };
      s.heading = s.angle;
      if (s.orbitDuration > 0 && (s.orbitLeft -= rate) < 1) s.moveMode = 0;
    }
  }

  integrateEnemyPosition(e: Enemy, rate = 1): void {
    const s = e.ecl;
    // FUN_0041eae0 clamps immediately before and after FUN_0041d050.
    if (s.movementSuppressedByEffect0) return;
    this.clampEnemyPosition(e);
    // FUN_0041d050 snapshots the displacement that ALREADY happened since
    // the previous manager pass, then latches the pre-integration position.
    // ECL dispatch therefore reads these values one manager tick later than
    // the controller velocity used below (all.c:13120-13125).
    const prev = s.integratorPreviousPosition;
    s.frameVx = e.x - prev.x;
    s.frameVy = e.y - prev.y;
    s.frameVz = e.z - prev.z;
    prev.x = e.x;
    prev.y = e.y;
    prev.z = e.z;
    // Th07.exe (v1.00b) FUN_0041d050 @ all.c:13115-13118 performs each
    // multiply/add in x87, then fstp writes the result back to the enemy's
    // 32-bit x/y/z fields. Preserving JS-double positions accumulates a
    // sub-pixel drift; in Stage 3 it moved bullet slot 109 just outside the
    // graze box on frame 12024 and delayed its id8 RNG event by one frame.
    const rateF32 = Math.fround(rate);
    e.x = Math.fround(e.x + (s.mirrored ? -s.axisSpeed.x : s.axisSpeed.x) * rateF32);
    e.y = Math.fround(e.y + s.axisSpeed.y * rateF32);
    e.z = Math.fround(e.z + s.axisSpeed.z * rateF32);
    this.clampEnemyPosition(e);
  }

  private clampEnemyPosition(e: Enemy): void {
    const s = e.ecl;
    if (!s.shouldClamp) return;
    e.x = clamp(e.x, s.lowerMoveLimit.x, s.upperMoveLimit.x);
    e.y = clamp(e.y, s.lowerMoveLimit.y, s.upperMoveLimit.y);
  }

  processEnemyCallbacks(game: GameHost, e: Enemy): boolean {
    return this.checkCallbacks(game, e);
  }

  updateEnemyAnm(e: Enemy, rate = 1): void {
    const s = e.ecl;
    s.anmRunner?.update(rate);
    for (const slot of s.anmSlots) slot?.runner?.update(rate);
  }

  tickEnemyManagerTail(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    // Enemy+0x2bcc is a per-enemy split counter, despite the historical
    // bossTimer name. FUN_0041ed50 snapshots it to +0x2bc4 and advances it
    // for every occupied slot (all.c:14436-14439); body graze uses both.
    // DAT_0061c25c gates only this tail clock during a true global freeze.
    if (!game.timeStopped && !game.isDialogueBlocking?.()) {
      s.bossTimerPrevious = s.bossTimer;
      const rate = game.slowRate ?? 1;
      s.bossTimerFrac = (s.bossTimerFrac ?? 0) + rate;
      if (s.bossTimerFrac >= 1) {
        s.bossTimer++;
        s.bossTimerFrac -= 1;
      }
    }
    // op142's countdown is manager-tail only, so the allocation core cannot
    // consume shield time. Th07.exe FUN_0041ed50 @ all.c:14440 calls
    // FUN_00436a06(1), not a flat decrement: the {current,frac} pair at
    // +0x4f40/+0x4f3c retreats on the global slowmo split clock. A wall-
    // clock `--` expired Youmu's 240-tick shield during her rate-1/3 spell
    // 192 damage too early (Stage 5 native HP 205 vs WT 13 at PRE7732).
    if (s.damageShield > 0) {
      const rate = Math.fround(game.slowRate ?? 1);
      if (rate > 0.99) {
        s.damageShield--;
      } else {
        // FUN_00436a06 is a retreat clock: subtract first, then borrow one
        // integer tick whenever the f32 fraction crosses below zero. The old
        // forward accumulator delayed the first shield decrement until the
        // third 1/3-rate wall tick, leaving Stage-5 spell 87 one HP too high
        // at its native lethal hit (processing 18748).
        s.damageShieldFrac = Math.fround(s.damageShieldFrac - rate);
        while (s.damageShieldFrac < 0) {
          s.damageShield--;
          s.damageShieldFrac = Math.fround(s.damageShieldFrac + 1);
        }
      }
      if (s.damageShield <= 0) {
        s.damageShield = 0;
        s.damageShieldFrac = 0;
      }
    }
  }

  // Boss phase callbacks, matching the original engine's behavior: the timer
  // callback target is re-chained to the death callback whenever a callback
  // fires, life callbacks fire on hp < threshold (strict) and clamp hp up.
  private checkCallbacks(game: GameHost, e: Enemy): boolean {
    const s = e.ecl;
    // Life callbacks: exe FUN_0041e4a0 scans slots 0..3 in order, fires the
    // FIRST armed slot with hp < threshold, clamps hp UP to it, and also
    // cancels any pending timer callback.
    for (let i = 0; i < 4; i++) {
      const t = s.lifeThresholds[i];
      if (t.threshold >= 0 && t.sub >= 0 && e.hp < t.threshold) {
        e.hp = t.threshold;
        t.threshold = -1;
        s.timerCallbackThreshold = -1; // exe: cleared on every life-cb fire
        s.timerCallbackSub = s.deathCallbackSub;
        this.phaseTransition(game, e, t.sub);
        return true;
      }
    }
    if (s.timerCallbackThreshold >= 0 && s.timerCallbackSub >= 0 && s.bossTimer >= s.timerCallbackThreshold) {
      const sub = s.timerCallbackSub;
      // exe FUN_0041e6b0: clamp hp to the LARGEST still-armed life threshold
      let best = -1, bestIdx = -1;
      for (let i = 0; i < 4; i++) {
        if (s.lifeThresholds[i].threshold > best) { best = s.lifeThresholds[i].threshold; bestIdx = i; }
      }
      if (best > 0 && bestIdx >= 0) { e.hp = best; s.lifeThresholds[bestIdx].threshold = -1; }
      s.timerCallbackThreshold = -1;
      s.timerCallbackSub = s.deathCallbackSub;
      s.bossTimer = 0;
      s.bossTimerPrevious = -999;
      // Timing out voids the spell capture unless the ECL flagged otherwise.
      if (s.spellName && !s.spellTimeoutFlag) game.voidSpellCapture?.();
      // Exe timer-callback path (all.c:13820-13840, gated on the same
      // +0x2e2a bit6 flag): cherry -25% penalty — fires on nonspell
      // timeouts as well, not just spell cards.
      if (!s.spellTimeoutFlag) game.onBossPhaseTimeout?.();
      this.phaseTransition(game, e, sub);
      return true;
    }
    return false;
  }

  private phaseTransition(game: GameHost, e: Enemy, sub: number): void {
    const s = e.ecl;
    s.bulletRankSpeedLow = -0.5;
    s.bulletRankSpeedHigh = 0.5;
    s.bulletRankAmount1Low = 0;
    s.bulletRankAmount1High = 0;
    s.bulletRankAmount2Low = 0;
    s.bulletRankAmount2High = 0;
    this.resetFireTemplateState(s);
    s.stack.length = 0;
    s.periodicExportArmed = false;
    // The exe disarms the op144 periodic sub (+0x2ee4 = -1) on EVERY phase
    // entry — HP-threshold dispatch all.c:13754, timeout sweep all.c:13845.
    // Leaving it armed leaked the previous phase's emitter across spell
    // boundaries (Yuyuko 幽曲 sub38's period-8 rice into 桜符 sub58 for its
    // first ~1020 frames — the 米弹 leak, LIFE-001/STG6-001).
    s.periodicSub = null;
    if (s.isBoss) this.clearNonBossEnemies(game, e);
    this.enterSub(s, sub);
  }

  private resetFireTemplateState(s: EclState): void {
    // Native HP/timeout phase transitions and retained death-callback entry
    // all restore the 0x35-dword FIRE template at enemy+0x2bd4 from
    // DAT_009a26bc, then clear the auto-fire interval at +0x2ca8 (Th07.exe
    // v1.00b FUN_0041e4a0 @ 0x41e5ad, FUN_0041e6b0 @ 0x41e8bb, and
    // FUN_0041ed50 @ 0x4203de). This includes every op79 EX slot and the
    // op81 sound fields. The split counter at +0x2cac..+0x2cb4 is outside
    // that block and deliberately survives while the zero interval keeps it
    // dormant. Retaining the old template leaked a previous Stage-6 phase's
    // third/fourth EX behaviours into the next phase's bullets.
    s.bulletProps = null;
    s.bulletExSlots.fill(null);
    s.bulletSfx = 0;
    s.bulletSfxInterval = 0;
    s.shootInterval = 0;
  }

  private enterSub(s: EclState, subId: number): void {
    s.ctx = {
      subId,
      index: 0,
      time: 0,
      timeFrac: 0,
      waitTimer: 0
    };
  }

  // Th07.exe frame push (op41 all.c:10045-10052, interrupt entry 7058-7065,
  // periodic entry 7081-7088): the saved 0x218-byte block spans the cursor,
  // all 26 variable dwords, the wait timer, the op27 interp slots, and the
  // op144 export flag at enemy+0x8f4.
  private pushFrame(s: EclState): void {
    s.stack.push({
      ctx: { ...s.ctx },
      vars: s.vars.slice(),
      interps: s.interpSlots.map((slot) => (slot ? { ...slot } : null)),
      periodicExportArmed: s.periodicExportArmed
    });
  }

  // Th07.exe FUN_0040f6c0 @ all.c:7055-7072: +0x2b08 stores an interrupt
  // INDEX, not a global sub id. Save the current resume cursor, then enter
  // the sub registered by op108 in +0x2a88[index]. op109 jumps back to the
  // same dispatcher label immediately, while timeline op10/op145 requests
  // arrive through the next target-enemy frame's preamble.
  private runPendingInterrupt(s: EclState): void {
    if (s.pendingInterrupt < 0) return;
    const interruptIndex = s.pendingInterrupt;
    s.pendingInterrupt = -1;
    const sub = s.interrupts[interruptIndex];
    if (sub == null || sub < 0) return;
    const next = this.ecl.sub(s.ctx.subId)[s.ctx.index];
    if (!s.disableCallStack && next) this.pushFrame(s);
    this.enterSub(s, sub);
  }

  // op27 per-frame tick (exe all.c:7271-7324 + FUN_0040ecd0/FUN_0040ed30):
  // modes 0-6 = 2-point LERP of f0..f1, mode 7 = cubic Hermite with f2/f3
  // as start/end tangents; ease curves per spec-op27-effects.md §1.3. The
  // final-frame write still happens before the slot frees.
  private tickInterpSlots(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    // FUN_0040f6c0 @ all.c:7266-7324 snapshots position before the eight
    // op27 slots run. Own-X/Y/Z targets are temporary writes: after all
    // slots produce their values, the executable captures the combined
    // displacement into +0x2b18/1c/20, rolls position back, and lets the
    // manager's later FUN_0041d050 integration apply that delta once. The
    // final delta deliberately remains after the interpolation slot frees.
    const oldX = e.x;
    const oldY = e.y;
    const oldZ = e.z;
    let positionTargetTouched = false;
    for (let i = 0; i < s.interpSlots.length; i++) {
      const slot = s.interpSlots[i];
      if (!slot) continue;
      slot.elapsed += game.slowRate ?? 1;
      const done = slot.elapsed >= slot.duration;
      const t = applyEclEase(done ? 1 : slot.elapsed / Math.max(1, slot.duration), slot.ease);
      let value: number;
      if (slot.mode === 7) {
        const h00 = (1 + 2 * t) * (1 - t) * (1 - t);
        const h10 = t * (1 - t) * (1 - t);
        const h01 = t * t * (3 - 2 * t);
        const h11 = t * t * (t - 1);
        value = h00 * slot.f0 + h10 * slot.f2 + h01 * slot.f1 + h11 * slot.f3;
      } else {
        value = (slot.f1 - slot.f0) * t + slot.f0;
      }
      this.interpWrite(game, e, slot.target, value);
      if (slot.target === 10018 || slot.target === 10019 || slot.target === 10020) {
        positionTargetTouched = true;
      }
      if (done) s.interpSlots[i] = null;
    }
    if (positionTargetTouched) {
      const dx = e.x - oldX;
      const dy = e.y - oldY;
      const dz = e.z - oldZ;
      if (dx !== 0 || dy !== 0) s.heading = Math.atan2(dy, dx);
      e.x = oldX;
      e.y = oldY;
      e.z = oldZ;
      s.axisSpeed = { x: dx, y: dy, z: dz };
    }
  }

  // op27 writes go through the exe's FLOAT write path (FUN_0040e560),
  // which CAN write own-position (unlike the int path our varWrite
  // models). Position writes are temporary; tickInterpSlots rolls them back
  // and transfers their combined displacement to axisSpeed after all slots.
  private interpWrite(game: GameHost, e: Enemy, id: number, value: number): void {
    switch (id) {
      case 10018: e.x = value; return;
      case 10019: e.y = value; return;
      case 10020: e.z = value; return;
      case 10045: e.ecl.heading = value; e.ecl.angle = value; return;
      default: this.varWrite(game, e, id, value);
    }
  }

  private bulletsInPoolOrder(game: GameHost): EnemyBullet[] {
    return game.enemyBullets
      .filter((bullet) => !bullet.dead)
      .slice()
      .sort((a, b) => a.poolSlot - b.poolSlot);
  }

  private lasersInPoolOrder(game: GameHost): EnemyLaser[] {
    return game.enemyLasers
      .filter((laser) => laser.inUse)
      .slice()
      .sort((a, b) => a.poolSlot - b.poolSlot);
  }

  private occupiedBulletPoolSlots(game: GameHost): Uint8Array {
    const occupied = this.bulletPoolOccupied;
    occupied.fill(0);
    for (const bullet of game.enemyBullets) {
      if (!bullet.dead && bullet.poolSlot >= 0 && bullet.poolSlot < ENEMY_BULLET_CAP) {
        occupied[bullet.poolSlot] = 1;
      }
    }
    return occupied;
  }

  private allocateBulletPoolSlot(occupied: Uint8Array): number {
    for (let i = 0; i < ENEMY_BULLET_CAP; i++) {
      const slot = (this.bulletPoolCursor + i) % ENEMY_BULLET_CAP;
      if (occupied[slot]) continue;
      occupied[slot] = 1;
      this.bulletPoolCursor = (slot + 1) % ENEMY_BULLET_CAP;
      return slot;
    }
    return -1;
  }

  private allocateLaserPoolSlot(game: GameHost): number {
    const occupied = new Set<number>();
    for (const laser of game.enemyLasers) {
      if (laser.inUse && laser.poolSlot >= 0 && laser.poolSlot < ENEMY_LASER_CAP) {
        occupied.add(laser.poolSlot);
      }
    }
    for (let slot = 0; slot < ENEMY_LASER_CAP; slot++) {
      if (!occupied.has(slot)) return slot;
    }
    return -1;
  }

  private bulletInsideLaser(bullet: EnemyBullet, laser: EnemyLaser, widthScale = 1): boolean {
    // Th07.exe (v1.00b) FUN_00417cb0 @ 0x417d32-0x417e5c stages
    // every rectangle input and both transformed coordinates through f32
    // locals before FUN_00417740 performs its inclusive AABB test.  Keeping
    // the algebra in relative double precision is observably different at
    // rotating-laser edges: native Stage-4 PRE23639 accepts fixed bullet
    // slot 1011 with 0.00067px remaining, while the unstaged port rejects it
    // by 0.00168px and shifts every later effect-8 RNG draw.
    const lx = Math.fround(laser.x);
    const ly = Math.fround(laser.y);
    const angle = Math.fround(laser.angle);
    const cos = Math.fround(Math.cos(angle));
    const sin = Math.fround(Math.sin(angle));
    const dx = Math.fround(Math.fround(bullet.x) - lx);
    const dy = Math.fround(Math.fround(bullet.y) - ly);
    const nearDist = Math.fround(laser.nearDist);
    const farDist = Math.fround(laser.farDist);
    const length = Math.fround(farDist - nearDist);
    const width = Math.fround(Math.fround(laser.width) * Math.fround(widthScale));
    // The center expression remains in x87 until this final f32 store; it
    // recomputes far-near instead of consuming the stored length local.
    const centerX = Math.fround((farDist - nearDist) / 2 + nearDist + lx);
    const rotatedX = Math.fround(Math.fround(dx * cos + dy * sin) + lx);
    const rotatedY = Math.fround(Math.fround(dy * cos - dx * sin) + ly);
    const halfLength = Math.fround(length / 2);
    const halfWidth = Math.fround(width / 2);
    const minX = Math.fround(centerX - halfLength);
    const maxX = Math.fround(centerX + halfLength);
    const minY = Math.fround(ly - halfWidth);
    const maxY = Math.fround(ly + halfWidth);
    // FUN_00417740 rejects only strict separation, so all four edges count.
    return rotatedX >= minX && rotatedX <= maxX && rotatedY >= minY && rotatedY <= maxY;
  }

  private isType8Seed(bullet: EnemyBullet): boolean {
    // etama entry 0 script 8 starts at global sprite 0x278; its eight color
    // offsets therefore cover exactly the exe's [0x278, 0x280) seed range.
    return bullet.sprite === 8 && bullet.spriteOffset >= 0 && bullet.spriteOffset < 8;
  }

  private resetDeflectedBulletTemplate(bullet: EnemyBullet): void {
    const stillSpawning = (bullet.spawnAge ?? bullet.spawnDuration) < bullet.spawnDuration;
    // Both laser-deflection callbacks copy template 5's first 0xb8c bytes
    // over the live bullet, preserving the FIRE color offset at +0xbf8.
    // Th07.exe v1.00b FUN_004179f0 @ 0x417bd1 and FUN_00417cb0 @ 0x417e70;
    // DAT_006292f4 = template base 0x625938 + 5*0xb8c.
    bullet.sprite = 5;
    bullet.rect = this.bulletRect(5, bullet.spriteOffset);
    bullet.grazeW = BULLET_HITBOX_BY_SPRITE[5];
    bullet.grazeH = BULLET_HITBOX_BY_SPRITE[5];
    if (stillSpawning) {
      // The copied block contains all five embedded ANM VMs. State 2/3/4
      // itself lives after +0xb8c and is retained, so a deflection during a
      // spawn intro restarts template 5's corresponding authored VM clock.
      bullet.spawnAge = 0;
      bullet.spawnAgeFrac = 0;
      bullet.spawnDuration = bullet.flags & 2 ? 10 : bullet.flags & 4 ? 16 : 32;
    }
  }

  // op121/122 bullet-effect table (24 entries @ Th07.exe .data 0x495148).
  // Id 3 is a true executable no-op; other missing ids remain explicit below.
  private runBulletEffect(game: GameHost, e: Enemy, id: number, param: number): void {
    switch (id) {
      case 0: { // FUN_00416d00: permanently attach movement to a tracked enemy
        const t = this.bossSlots[param];
        if (t) {
          e.x = t.x;
          e.y = t.y;
          e.z = t.z;
          e.ecl.axisSpeed = { ...t.ecl.axisSpeed };
          e.ecl.angle = t.ecl.angle;
          e.ecl.movementSuppressedByEffect0 = true;
        }
        return;
      }
      case 5: { // FUN_004173d0: track the selected boss's live position
        const t = this.bossSlots[param];
        if (t) {
          // Destination +0x2b8c/90/94 receives the source enemy's CURRENT
          // +0x2b0c/10/14 position, not its own orbit target. Stage-3's
          // Alice helpers arm this every frame so their ring follows the
          // moving boss while retaining the copied radius/angular rate.
          e.ecl.orbitTarget = { x: t.x, y: t.y, z: t.z };
          e.ecl.orbitSpeed = t.ecl.orbitSpeed;
          e.ecl.orbitAngularVelocity = t.ecl.orbitAngularVelocity;
        }
        return;
      }
      case 7: { // FUN_004179f0: bullets rebound from alternating global laser slots
        const selectedSlot = Math.trunc(e.ecl.bossTimer) % 2;
        const bullets = this.bulletsInPoolOrder(game);
        for (const laser of this.lasersInPoolOrder(game)) {
          if (laser.poolSlot !== selectedSlot || laser.state >= 2) continue;
          const laserAngle = Math.fround(laser.angle);
          const sin = Math.fround(Math.sin(laserAngle));
          const cos = Math.fround(Math.cos(laserAngle));
          for (const bullet of bullets) {
            if (bullet.dead || !this.bulletInsideLaser(bullet, laser)) continue;
            if (bullet.effectState > 0) bullet.effectState--;
            if (bullet.effectState !== 0) continue;
            if (bullet.speed > 0.5) bullet.speed = Math.fround(bullet.speed - NATIVE_ONE_TENTH_F32);
            const side = Math.fround(
              sin * Math.fround(bullet.vx) + cos * Math.fround(bullet.vy)
            );
            bullet.angle = normalizeNativeAngleF32(
              laserAngle,
              side < 0 ? -NATIVE_HALF_PI_F32 : NATIVE_HALF_PI_F32
            );
            const scaledSpeed = Math.fround(Math.fround(game.slowRate ?? 1) * bullet.speed);
            bullet.vx = Math.fround(Math.cos(bullet.angle) * scaledSpeed);
            bullet.vy = Math.fround(Math.sin(bullet.angle) * scaledSpeed);
            bullet.effectState = 10;
            this.resetDeflectedBulletTemplate(bullet);
          }
        }
        return;
      }
      case 8: { // FUN_00417cb0: one-use/cross-laser normal deflection
        const selectedModulo = Math.trunc(e.ecl.bossTimer) % 3;
        const bullets = this.bulletsInPoolOrder(game);
        for (const laser of this.lasersInPoolOrder(game)) {
          if (laser.poolSlot % 3 !== selectedModulo || laser.state >= 2) continue;
          const laserAngle = Math.fround(laser.angle);
          const sin = Math.fround(Math.sin(laserAngle));
          const cos = Math.fround(Math.cos(laserAngle));
          const nx = Math.fround(-sin);
          const ny = cos;
          for (const bullet of bullets) {
            // local_24[0x79] is the live ANM sprite pointer. Every drawable
            // bullet in this port has a resolved rect, so `dead` is the
            // corresponding allocation/live gate.
            if (bullet.dead || bullet.effectState < 0 || bullet.effectState === laser.poolSlot + 1) continue;
            if (!this.bulletInsideLaser(bullet, laser, NATIVE_ONE_POINT_FIVE_F32)) continue;
            // FUN_0042ffc0 is consumed only after every filter and the rectangle test.
            const random = game.rng.u32() / 0x100000000;
            const scale = game.difficulty < 2
              ? EFFECT8_EASY_RANDOM_SCALE_F32
              : EFFECT8_HARD_RANDOM_SCALE_F32;
            const base = game.difficulty < 2 ? EFFECT8_EASY_BASE_F32 : EFFECT8_HARD_BASE_F32;
            // The random multiply/add and old-speed multiply stay in x87;
            // only the completed nominal speed is stored to bullet+0xbb0.
            bullet.speed = Math.fround((random * scale + base) * Math.fround(bullet.speed));
            const normalDot = Math.fround(nx * Math.fround(bullet.vx) + ny * Math.fround(bullet.vy));
            const chosenX = normalDot < 0 ? Math.fround(-nx) : nx;
            const chosenY = normalDot < 0 ? Math.fround(-ny) : ny;
            // The selected unit normal is first stored to vx/vy, converted
            // to a stored f32 angle by atan2, then FUN_004074e0 overwrites
            // vx/vy with f32 FSINCOS products at the new nominal speed.
            bullet.vx = chosenX;
            bullet.vy = chosenY;
            this.resetDeflectedBulletTemplate(bullet);
            bullet.angle = Math.fround(Math.atan2(bullet.vy, bullet.vx));
            bullet.vx = Math.fround(Math.cos(bullet.angle) * bullet.speed);
            bullet.vy = Math.fround(Math.sin(bullet.angle) * bullet.speed);
            bullet.effectState = game.difficulty < 2 ? -1 : laser.poolSlot + 1;
          }
        }
        return;
      }
      case 10: { // FUN_00418020: enter bullet-time. Sets the GLOBAL rate to
        // 1/param and retroactively rescales every live bullet's velocity
        // vector (never the nominal speed field) — the per-frame bullet
        // integrator is unscaled, so this one-time edit IS the slowdown
        // (spec-slowmo.md §1). Repeated enters compound, like the exe.
        const f = param > 0 ? 1 / param : 1;
        for (const b of game.enemyBullets) {
          if (!b.dead) {
            b.vx *= f;
            b.vy *= f;
            // Th07.exe (v1.00b) FUN_00418020 @ 0x418020: +0x1d6 always
            // snapshots the live shape. Global shapes 0x260..0x26f are the
            // etama template-6 color row and are rebound to fixed 0x26f.
            b.slowmoShapeBackupRect = b.rect;
            if (b.sprite === 6) {
              b.rect = this.bulletRect(6, 15);
              b.grazeW = BULLET_HITBOX_BY_SPRITE[6];
              b.grazeH = BULLET_HITBOX_BY_SPRITE[6];
            }
          }
        }
        game.setBulletTimeVisual?.(true);
        game.setSlowRate?.(f);
        return;
      }
      case 11: { // FUN_00418130: exit bullet-time — exact algebraic inverse
        // of whatever rate is CURRENTLY active, then rate = 1.
        const f = 1 / (game.slowRate ?? 1);
        for (const b of game.enemyBullets) {
          if (!b.dead) {
            b.vx *= f;
            b.vy *= f;
            // FUN_00418130 @ 0x418130 only restores bullets whose CURRENT
            // shape is still in the 0x260..0x26f family. Deflection effects
            // may have rebound the bullet to template 5 in the meantime.
            if (b.sprite === 6 && b.slowmoShapeBackupRect) {
              b.rect = b.slowmoShapeBackupRect;
              b.grazeW = BULLET_HITBOX_BY_SPRITE[6];
              b.grazeH = BULLET_HITBOX_BY_SPRITE[6];
            }
          }
        }
        game.setBulletTimeVisual?.(false);
        game.setSlowRate?.(1);
        return;
      }
      case 16: { // FUN_00418880: emit a five-way wave from every live seed
        const speed = Number(this.varRead(game, e, 10005));
        const occupied = this.occupiedBulletPoolSlots(game);
        const props: BulletProps = {
          sprite: 0,
          offset: 6,
          count1: 5,
          count2: 1,
          speed1: speed,
          speed2: speed,
          angle1: 0,
          angle2: Math.PI / 8,
          flags: 2,
          sfx: -1,
          exSlots: [null, null, null, null, null],
          aimMode: 1
        };
        for (const seed of this.bulletsInPoolOrder(game)) {
          if (seed.effectState !== 0 || !this.isType8Seed(seed)) continue;
          props.angle1 = normalizeAngle(seed.angle + Math.PI);
          this.spawnBullets(game, e, props, { x: seed.x, y: seed.y }, occupied);
        }
        return;
      }
      case 17: { // FUN_004189f0: detonate seeds into current-sub+1 helpers
        const inheritedVars = Array.from(e.ecl.vars.slice(0, 26));
        let fanAngle = -Math.PI;
        for (const seed of this.bulletsInPoolOrder(game)) {
          if (!this.isType8Seed(seed)) continue;
          if (seed.spriteOffset === 4 && seed.effectState === 0) {
            const initialVars = inheritedVars.slice();
            initialVars[4] = seed.angle;
            initialVars[11] = fanAngle;
            fanAngle += Math.PI / 4;
            this.spawnEclEnemy(game, {
              subId: e.ecl.ctx.subId + 1,
              x: seed.x,
              y: seed.y,
              life: 1,
              item: -2,
              score: 10,
              initialVars
            });
          }
          seed.dead = true;
        }
        return;
      }
      case 18: { // FUN_00418b30: expose the number of pending offset-4 seeds
        let count = 0;
        for (const seed of this.bulletsInPoolOrder(game)) {
          if (seed.sprite === 8 && seed.spriteOffset === 4 && seed.effectState === 0) count++;
        }
        e.ecl.vars[0] = count;
        return;
      }
      case 20: game.playBgmTrack?.('th07_13b'); return; // Yuyuko phase-2 cue
      case 1: { // FUN_00416da0 @ 0x416da0: "declaw" + slow-turn. The filter
        // field is the FIRE instruction's second i16 — spriteOffset, exe
        // bullet+0xbf8 (param 1 restricts to offset 8, param 2 to offset 4,
        // any other param applies no offset gate). Each first-time match:
        // nominal speed = 0.3 (.text imm 0x3e99999a), the whole 5-slot
        // behavior queue is wiped and a fresh opcode-0x20 slow-turn is
        // installed with its own elapsed counter: E/N/H 60 ticks at
        // +0.01666666753590107/tick (0x3c888889), Lunatic/Extra 240 ticks
        // at +0.005263158120214939 (0x3bac7692); turn rate ±π/(rng01*60+180)
        // per tick, + for offsets 6/8, − for 2/4, one RNG draw per matched
        // bullet in pool-slot order. The same bullet-manager tick recomputes
        // the velocity from 0.3+delta. Marked processed (+0xc08=1) so a
        // repeat call skips it. Plus a 12->0 shake over 30f and a 3x4f pale
        // flash (raw asm 0x416db4-0x416ddc).
        game.startScreenShake?.(30, 12, 0);
        game.startScreenFlash?.(4, 3, 0x80ffcfcf);
        // Exe leaves the wobble stack slot stale for offsets outside
        // {2,4,6,8} (retail data never fires those); carry the last value.
        let wobble = 0;
        const lunatic = game.difficulty >= 3;
        for (const b of this.bulletsInPoolOrder(game)) {
          if (b.dead || b.effectState !== 0) continue;
          if (param === 1 && b.spriteOffset !== 8) continue;
          if (param === 2 && b.spriteOffset !== 4) continue;
          const k = b.spriteOffset;
          if (k === 2 || k === 4) wobble = -Math.PI / (game.rng.f() * 60 + 180);
          else if (k === 6 || k === 8) wobble = Math.PI / (game.rng.f() * 60 + 180);
          b.speed = 0.3;
          // Queue wipe + fresh slot-0 install (rep stos @ 0x416f4d then
          // FUN_004260d0). The port folds queue and live registers into the
          // ex* fields; retail bullets here carry no live motion behavior.
          const speedDelta = lunatic ? 0.005263158120214939 : 0.01666666753590107;
          const limit = lunatic ? 240 : 60;
          b.exFlags = 0;
          b.exSlots = [
            { opcode: 0x20, cond: 1, arg3: limit, arg4: 0, f0: speedDelta, f1: wobble },
            null, null, null, null
          ];
          b.exFireFlags |= 0x20;
          b.exBehaviorIndex = 0;
          b.exAccel = null;
          b.exDir = null;
          b.exBounce = null;
          b.exAngle = null;
          b.exRampElapsed = 0;
          b.exRampFrac = 0;
          b.exAccelElapsed = 0;
          b.exAccelFrac = 0;
          b.exAngleElapsed = 0;
          b.exAngleFrac = 0;
          b.exDirElapsed = 0;
          b.exDirFrac = 0;
          b.dirTimes = 0;
          b.exBounceTimes = 0;
          b.effectState = 1;
        }
        return;
      }
      case 2: { // FUN_00416fc0 @ 0x416fc0: convert nearby OFFSET-2 bullets
        // into a pair of real accelerating bullets, then delete the parent.
        // FUN_00423480 is the enemy-bullet constructor, not the similarly
        // named general visual-effect allocator FUN_0041b320.
        const thresholds = [128, 192, 256, 999];
        const thr = thresholds[param] ?? 999;
        if (param === 0) {
          game.startScreenShake?.(32, 12, 0);
          game.startScreenFlash?.(4, 1, 0x80cfcfff);
        }
        const occupied = this.occupiedBulletPoolSlots(game);
        for (const b of this.bulletsInPoolOrder(game)) {
          if (b.dead || b.spriteOffset !== 2) continue;
          if (Math.hypot(e.x - b.x, e.y - b.y) >= thr) continue;
          // Native order is one frand for the shared acceleration magnitude,
          // followed by one aimMode-6 frand for each of the two children.
          const accel = Math.fround(game.rng.f() * Math.fround(0.005) + Math.fround(0.013));
          this.spawnBullets(game, e, {
            sprite: 0,
            offset: 6,
            count1: 2,
            count2: 1,
            speed1: Math.fround(0.7),
            speed2: 0,
            angle1: 0,
            angle2: -NATIVE_PI_F32,
            flags: 0x12,
            sfx: -1,
            exSlots: [
              { opcode: 0x10, cond: 0, arg3: 0xb4, arg4: 0, f0: accel, f1: NATIVE_HALF_PI_F32 },
              null, null, null, null
            ],
            aimMode: 6
          }, { x: b.x, y: b.y }, occupied);
          if (game.removeEnemyBullet) game.removeEnemyBullet(b);
          else b.dead = true;
          if (b.poolSlot >= 0 && b.poolSlot < occupied.length) occupied[b.poolSlot] = 0;
        }
        return;
      }
      case 4: { // FUN_00417290: find the FIRST live big-sprite bullet
        // (descriptor size > 60), remember its position in locals 10004/5,
        // burst + delete it. Sentinel -999 when none found. Param unused.
        this.varWrite(game, e, 10004, -999);
        for (const b of this.bulletsInPoolOrder(game)) {
          if (b.dead || Math.max(b.rect.w, b.rect.h) <= 60) continue;
          this.varWrite(game, e, 10004, b.x);
          this.varWrite(game, e, 10005, b.y);
          game.spawnEffectParticles(2, b.x, b.y, 1, 0xffffffff);
          b.dead = true;
          break;
        }
        return;
      }
      case 6: { // FUN_00417440 @ 0x417440: convert one OFFSET family into
        // three real enemy-bullet rings, then delete each parent. The old
        // implementation used generic effect particles, which both removed
        // the collidable rings and consumed four bogus RNG draws per ring.
        const off = param === 0 ? 6 : param === 1 ? 15 : param === 2 ? 2 : -1;
        if (off < 0) return;
        const childOffset = param === 0 ? 15 : param === 1 ? 2 : 10;
        const useGrace = param === 0 || (param === 1 && game.difficulty === 3);
        const occupied = this.occupiedBulletPoolSlots(game);
        const graceSlot: BulletExSlot = {
          opcode: 0x2000, cond: 0, arg3: 0x82, arg4: 0, f0: 0, f1: 0
        };
        for (const b of this.bulletsInPoolOrder(game)) {
          if (b.dead || b.spriteOffset !== off) continue;
          const angle = normalizeNativeAngleF32(b.angle, NATIVE_PI_F32);
          const fireRing = (count1: number, speedScale: number, angle2: number, flags: number): void => {
            this.spawnBullets(game, e, {
              sprite: 6,
              offset: childOffset,
              count1,
              count2: 1,
              speed1: Math.fround(b.speed * Math.fround(speedScale)),
              speed2: 0,
              angle1: angle,
              angle2,
              flags,
              sfx: -1,
              exSlots: [{ ...graceSlot }, null, null, null, null],
              aimMode: 1
            }, { x: b.x, y: b.y }, occupied);
          };
          fireRing(
            game.difficulty < 3 ? 4 : 2,
            1.1,
            game.difficulty < 3 ? NATIVE_SIXTH_PI_F32 : NATIVE_HALF_PI_F32,
            (useGrace ? 0x2000 : 0) | 2
          );
          fireRing(2, 0.7, NATIVE_THIRD_PI_F32, useGrace ? 0x2000 : 0);
          fireRing(1, 0.85, NATIVE_THIRD_PI_F32, useGrace ? 0x2000 : 0);
          if (game.removeEnemyBullet) game.removeEnemyBullet(b);
          else b.dead = true;
          if (b.poolSlot >= 0 && b.poolSlot < occupied.length) occupied[b.poolSlot] = 0;
        }
        return;
      }
      case 9: // FUN_00417ff0: strong 80-frame screen shake, 8->0 (§6).
        game.startScreenShake?.(80, 8, 0);
        return;
      case 12: case 21: { // FUN_00418260 @ 0x418260 / FUN_00418bc0 @ 0x418bc0
        // These are the Stage-5 sword-cut effects. They do NOT create visual
        // particles: every matching big bullet is replaced by a dense volley
        // of real, collidable enemy bullets through FUN_00423480, then the
        // big bullet is deleted. Misclassifying these as effect particles was
        // why 獄神剣「業風神閃斬」 visibly cut the 大玉 without releasing its
        // small-bullet barrage, and also skipped thousands of gameplay RNG
        // draws at each slash.
        game.startScreenFlash?.(8, 1, 0x50cfcfff);
        const hard = game.difficulty >= 2;
        const band = id === 12 ? (hard ? 48 : 64) : (game.difficulty === 2 ? 128 : 180);
        const count = id === 12 ? [10, 18, 22, 25][Math.min(3, game.difficulty)] : 15;
        const occupied = this.occupiedBulletPoolSlots(game);
        const variants = id === 12
          ? [[0, 2], [3, 2], [7, 1]] as const
          : [[0, 4], [3, 4], [7, 2]] as const;
        for (const b of this.bulletsInPoolOrder(game)) {
          // Both handlers compare the sprite descriptor's +0x2c field,
          // which is the frame HEIGHT, against 48. Width does not qualify a
          // wide-but-short bullet (FUN_00418260 @ 0x41834d and
          // FUN_00418bc0 @ 0x418c6b).
          if (b.dead || b.rect.h <= 48) continue;
          if (Math.abs(b.y - e.y) >= band) continue;
          for (let i = 0; i < count; i++) {
            // Exact per-child RNG order: x frand, y frand, kind u16, angle
            // frand, EX speed-delta frand = nine raw u16 draws. All five are
            // consumed before FUN_00423480 attempts fixed-pool allocation, so
            // a full bullet pool still advances the stream.
            const x = Math.fround(b.x + (game.rng.f() * 32 - 16));
            const y = Math.fround(b.y + (game.rng.f() * 32 - 16));
            const [sprite, offset] = variants[game.rng.u16() % 3];
            const randomAngle = game.rng.f();
            const angle = param === 0
              ? Math.fround(randomAngle * NATIVE_THREE_HALF_PI_F32 - NATIVE_HALF_PI_F32)
              : normalizeNativeAngleF32(
                  Math.fround(randomAngle * NATIVE_THREE_HALF_PI_F32),
                  NATIVE_QUARTER_PI_F32
                );
            const speedDelta = Math.fround(game.rng.f() * Math.fround(0.008) + Math.fround(0.01));
            const flags = 0x20 | (id === 12 && (i & 1) ? 2 : 0);
            this.spawnBullets(game, e, {
              sprite,
              offset,
              count1: 1,
              count2: 1,
              speed1: Math.fround(0.1),
              speed2: 0,
              angle1: angle,
              angle2: 0,
              flags,
              sfx: -1,
              exSlots: [
                { opcode: 0x20, cond: 0, arg3: 100, arg4: 0, f0: speedDelta, f1: 0 },
                null, null, null, null
              ],
              aimMode: 1
            }, { x, y }, occupied);
          }
          // Native deletion happens only after every child template has
          // consumed its RNG and attempted allocation. The now-free parent
          // slot is reusable by children from later big bullets in this same
          // fixed-slot scan.
          if (game.removeEnemyBullet) game.removeEnemyBullet(b);
          else b.dead = true;
          if (b.poolSlot >= 0 && b.poolSlot < occupied.length) occupied[b.poolSlot] = 0;
        }
        return;
      }
      case 13: { // FUN_00418650 (armed, per-frame): bullets drifting into
        // the narrow strip directly below the enemy (|dx|<16, y<352) get a
        // real opcode-0x20 motion record in slot 0. Despite the old
        // "cosmetic overlay" reading, a native fixed-slot trace proves the
        // record changes the bullet trajectory immediately: Stage-5 slot
        // 878 at processing 14055 loses speed/180 and turns -pi/60 on the
        // same manager pass (Th07.exe v1.00b @ 0x418650 / 0x4260d0).
        for (const b of this.bulletsInPoolOrder(game)) {
          if (b.dead || b.effectState !== 0) continue;
          if (b.y <= e.y || b.y >= 352 || Math.abs(b.x - e.x) >= 16) continue;
          const turn = Math.fround((b.poolSlot & 1) === 0 ? -Math.PI / 60 : Math.PI / 60);
          const speedDelta = Math.fround(-Math.fround(b.speed) / 180);
          b.exSlots ??= [null, null, null, null, null];
          b.exSlots[0] = { opcode: 0x20, cond: 0, arg3: 0xa0, arg4: 0, f0: speedDelta, f1: turn };
          b.exFireFlags |= 0x20;
          // FUN_00426020 resets bullet+0xc10 so the normal bullet-manager
          // queue pass reconsiders slot 0; it does not clear active flags.
          b.exBehaviorIndex = 0;
          b.effectState = 1;
        }
        return;
      }
      case 14: { // FUN_00418780: sweep every id13-tagged bullet (processed
        // ==1) and queue a real opcode-0x10 acceleration toward the player's
        // current position: 90 ticks at f32 0.0266666673. FUN_00426110 uses
        // the same bullet movement queue as op79, not a separate cosmetic
        // overlay (Th07.exe v1.00b @ 0x418780 / 0x426110).
        game.startScreenFlash?.(16, 1, 0x50cfcfff);
        for (const b of this.bulletsInPoolOrder(game)) {
          if (b.dead || b.effectState !== 1) continue;
          const dx = game.player.x - b.x;
          const dy = game.player.y - b.y;
          const angle = dx === 0 && dy === 0
            ? NATIVE_HALF_PI_F32
            : Math.fround(Math.atan2(dy, dx));
          b.exSlots ??= [null, null, null, null, null];
          b.exSlots[0] = {
            opcode: 0x10, cond: 0, arg3: 0x5a, arg4: 0,
            f0: Math.fround(0.02666666731238365), f1: angle
          };
          // Native explicitly clears bullet+0xc3c, the opcode field of the
          // following queue record, after FUN_00426110 installs slot 0.
          b.exSlots[1] = null;
          b.exFireFlags |= 0x10;
          b.exBehaviorIndex = 0;
          b.effectState = 2;
        }
        return;
      }
      case 15: // FUN_00418850: single pale flash, duration = the op's own
        // param (live-read; §10). Color 0xd0cfcfff.
        game.startScreenFlash?.(Math.max(1, param), 1, 0xd0cfcfff);
        return;
      case 19: // FUN_00418ee0: fade the current BGM out over 3.0 seconds.
        game.fadeBgm?.(3);
        return;
      case 22: case 23: { // FUN_00418f20 @ 0x418f20 / FUN_00419150 @ 0x419150
        // Extra/Phantasm arm these handlers continuously with op122. Despite
        // their aura-like presentation, each qualifying large parent calls
        // the real enemy-bullet constructor (FUN_00423480), so omitting them
        // removes collidable bullets, their fixed-pool pressure, and one
        // frand from the shared RNG stream per parent.
        const group = e.ecl.bossTimer % 3;
        if ((id === 22 && group === 0) || (id === 23 && group === 2)) return;
        const occupied = this.occupiedBulletPoolSlots(game);
        for (const b of this.bulletsInPoolOrder(game)) {
          // Native filters bullet+0xbf4 bit 6 (the active EX mask), Y<320,
          // and the sprite descriptor's +0x2c HEIGHT strictly above 60.
          if ((b.exFlags & 0x40) !== 0 || b.y >= 320 || b.rect.h <= 60) continue;
          const variant = id === 22 ? (e.ecl.bossTimer & 1) : group;
          const angle = Math.fround(game.rng.f() * NATIVE_TAU_F32 - NATIVE_PI_F32);
          // The odd group (variant !== 0) attaches a real delayed-release
          // record via FUN_00426190 BEFORE the constructor (all.c:11197 op22 /
          // 11276 op23). FUN_00426190 -> FUN_00426080 ORs 0x80 into the fire
          // template's flags (0x208 -> 0x288) and seeds the template's +0x20
          // op-79 scratch slot 0 with a type-0x80 record. FUN_00421e90 then
          // memcpy's that +0x20 block into the newborn bullet's own +0xc14
          // queue (all.c:15374-15381), and the per-frame dispatch
          // FUN_004229f0 -> FUN_00423e70 (all.c:15936-15972) decays the
          // bullet's speed toward 0 over `interval` frames, then snaps it to
          // `newSpeed` and re-aims at the player. This is what makes the aura
          // bullets pause then shoot off fast; omitting it left them drifting
          // at ~1.0 and missed the Phantasm frame-5850 graze. (Web's 0x80
          // exSlot -> dirChangeBullet('aimed') already models FUN_00423e70.)
          const oddGroup = variant !== 0;
          this.spawnBullets(game, e, {
            sprite: variant === 0 ? 3 : 1,
            offset: id === 22
              ? (b.spriteOffset === 1 ? 6 : 2)
              : (b.spriteOffset === 2 ? 10 : 13),
            count1: id === 22 && variant === 0 ? 2 : 1,
            count2: 1,
            speed1: variant === 0 ? Math.fround(0.8) : Math.fround(1.2),
            speed2: 0,
            angle1: angle,
            angle2: -NATIVE_PI_F32,
            // Odd group carries the 0x80 EX-record activation bit (native
            // template flags +0xc4 |= 0x80 -> bullet +0xbf6 = 0x288).
            flags: oddGroup ? 0x288 : 0x208,
            sfx: 0x19,
            exSlots: oddGroup
              ? [
                  {
                    // FUN_00426190(&tmpl, 0, interval, 1, 0, newSpeed):
                    // op22 -> 60 frames / 3.1; op23 -> 40 frames / 2.9.
                    opcode: 0x80,
                    cond: 1,
                    arg3: id === 22 ? 0x3c : 0x28,
                    arg4: 1,
                    f0: 0,
                    f1: id === 22 ? Math.fround(3.1) : Math.fround(2.9)
                  },
                  null, null, null, null
                ]
              : [null, null, null, null, null],
            aimMode: 3
          }, { x: b.x, y: b.y }, occupied);
        }
        return;
      }
      case 3: return; // exe stub (confirmed empty; unused by real data)
      default:
        // Retail data uses exactly ids 0-23, all handled above — an id here
        // means new/modded data or a decode bug worth surfacing.
        warnOnce(`fx${id}`, `bullet-effect id ${id} out of the 24-entry table`);
        return;
    }
  }

  private updateAutoShoot(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    // Exe auto-shoot tick (all.c:7194-7208) fires purely on interval>0 &&
    // hp>0 — it does NOT consult the op75/76 bit (that bit only suppresses
    // the immediate fire inside FIRE ops 64-72). Checking shootDisabled here
    // silenced every op75-then-op73 pattern. The hp>0 gate freezes the timer
    // AND the fire while dead/dying — no death-frame extra volley
    // (CADENCE-001).
    if (!s.shootInterval || !s.bulletProps || e.hp <= 0) return;
    // Th07.exe FUN_0040f6c0 @ all.c:7195-7207 advances the integer field
    // +0x2cb4 and fractional field +0x2cb0 through FUN_00436acc, then
    // compares only the integer half with +0x2ca8. Keeping this as one JS
    // double made 1/3 accumulate to 4.999999999999999 for interval 5, so
    // every slowmo volley fired one wall frame late. Stage-5 spell 75's
    // large bullets accumulated five such late ticks before the sword cut.
    const rate = game.slowRate ?? 1;
    if (rate > 0.99) {
      s.shootTimer++;
    } else {
      s.shootTimerFrac += rate;
      if (s.shootTimerFrac >= 1) {
        s.shootTimer++;
        s.shootTimerFrac -= 1;
      }
    }
    if (s.shootTimer >= s.shootInterval) {
      s.shootTimer = 0;
      s.shootTimerFrac = 0;
      this.spawnBullets(game, e, s.bulletProps);
    }
  }

  setCurrentAnm(e: Enemy, script: number): void {
    const s = e.ecl;
    if (script < 0 || s.currentAnm === script) return;
    s.currentAnm = script;
    s.anmRunner = this.makeEnemyAnmRunner(script, s.anmRunner ?? undefined);
  }

  private makeEnemyAnmRunner(script: number, inheritSpriteFrom?: AnmRunner): AnmRunner | null {
    // Enemy ECL uses the executable loader's concatenated script ids. ANM
    // entries store local ids independently; stg6enm global 147..155 are
    // stg6enm2 local 0..8. Keep the flat fallback for the small test mocks
    // and any single-entry data lacking the additive resolver.
    const resolved = typeof this.enemyAnm.resolveGlobalScript === 'function'
      ? this.enemyAnm.resolveGlobalScript(script)
      : null;
    if (resolved) {
      return new AnmRunner(this.enemyAnm, resolved.localId, {
        entryIndex: resolved.entryIndex,
        spriteIndexOffset: resolved.spriteBase,
        rng: this.anmRng,
        // Th07.exe FUN_004486e0 @ 0x4486e0 resets the embedded ANM VM but
        // leaves enemy+0x1e4's current sprite pointer intact. Stage-1
        // Sub35 script 11's fourth random branch sets no sprite and must
        // retain script 0's 32x32 rect so FUN_0042bdc7 can cull it.
        inheritSpriteFrom
      });
    }
    return this.enemyAnm.hasScript(script)
      ? new AnmRunner(this.enemyAnm, script, { rng: this.anmRng, inheritSpriteFrom })
      : null;
  }

  private updateAnmPose(e: Enemy): void {
    const s = e.ecl;
    if (s.anmExLeft < 0) return;
    // Pose selection runs inside FUN_0040f6c0 before the manager integrator
    // and reads +0x2b18 directly. Mirrored actors invert its interpretation
    // in the branch table (all.c:7210-7229); slowRate is not multiplied here.
    const screenVx = s.mirrored ? -s.axisSpeed.x : s.axisSpeed.x;
    const vx = Math.abs(screenVx) < 0.0001 ? 0 : screenVx;
    const pose = vx < 0 ? 1 : vx > 0 ? 2 : 0;
    if (s.anmExFlags === pose) return;
    if (pose === 0) {
      if (s.anmExFlags === 0xff) this.setCurrentAnm(e, s.anmExDefaults);
      else if (s.anmExFlags === 1) this.setCurrentAnm(e, s.anmExFarLeft);
      else this.setCurrentAnm(e, s.anmExFarRight);
    } else if (pose === 1) this.setCurrentAnm(e, s.anmExLeft);
    else this.setCurrentAnm(e, s.anmExRight);
    s.anmExFlags = pose;
  }

  // ---- the interpreter -----------------------------------------------------

  private dispatchEcl(game: GameHost, e: Enemy): boolean {
    const s = e.ecl;
    let restartPreamble = true;
    for (let guard = 0; guard < 512; guard++) {
      if (restartPreamble) {
        // Th07.exe FUN_0040f6c0 @ LAB_0040f6d1 (all.c:7055-7104).
        // case 0x28 CALL and case 0x29 RETURN both goto this label. Stage 6
        // Sub44 calls Sub47 from its periodic body, so a firing tick resets
        // the timer and then advances it three times before the next PRE:
        // nested CALL, inner RETURN, outer RETURN (native PRE6080 = 3).
        this.runPendingInterrupt(s);
        this.tickPeriodicSub(game, e);
        restartPreamble = false;
      }
      const ctx = s.ctx;
      // op45 is a per-context WAIT, not an active-lifetime gate. At normal
      // speed the exe decrements both +0x76c and the ECL clock here, then the
      // frame-tail clock increment cancels out (0x40f83a-0x40f872). Checking
      // on every dispatcher pass also handles RETURN restoring a waiting
      // caller after an op144 periodic gosub.
      if (ctx.waitTimer > 0) {
        ctx.waitTimer -= game.slowRate ?? 1;
        return false;
      }
      const instrs = this.ecl.sub(ctx.subId);
      const instr = instrs[ctx.index];
      if (!instr) return false;
      if (ctx.time !== instr.time) break;
      if (instr.rankMask & (1 << game.difficulty)) {
        const prevExecuting = this.executingEnemy;
        this.executingEnemy = e;
        const action = this.execute(game, e, instr);
        this.executingEnemy = prevExecuting;
        if (action === 'delete') {
          e.dead = true;
          return false;
        }
        if (action === 'restart') {
          restartPreamble = true;
          continue;
        }
        if (action === 'flow') continue;
      }
      ctx.index++;
    }
    return true;
  }

  private advanceEclClock(s: EclState, rate: number): void {
    // FUN_00436acc at the core tail (all.c:7327-7329). Integer semantics are
    // load-bearing because instruction dispatch compares time with ===.
    if (rate > 0.99) {
      s.ctx.time++;
    } else {
      // Both the global rate and enemy+0x6ec are float32 fields. Native
      // FUN_00436acc loads, adds, and stores that fraction every call. A JS
      // double retained 0.9999999999999991 across Stage-5 Sub1's t18->t14
      // loop and delayed each id31 flake burst by one wall frame at PRE17165.
      s.ctx.timeFrac = Math.fround(s.ctx.timeFrac + Math.fround(rate));
      if (s.ctx.timeFrac >= 1) {
        s.ctx.time++;
        s.ctx.timeFrac = Math.fround(s.ctx.timeFrac - 1);
      }
    }
  }

  private jumpTo(s: EclState, targetOffset: number, newTime: number): void {
    const instrs = this.ecl.sub(s.ctx.subId);
    // Binary offsets are relative to the current instruction.
    const absolute = instrs[s.ctx.index].offset + targetOffset;
    const idx = instrs.findIndex((i) => i.offset === absolute);
    if (idx < 0) throw new Error(`ECL jump to unknown offset ${absolute} in sub ${s.ctx.subId}`);
    s.ctx.index = idx;
    s.ctx.time = newTime;
  }

  private execute(game: GameHost, e: Enemy, instr: EclInstr): 'delete' | 'flow' | 'restart' | null {
    const s = e.ecl;
    const ctx = s.ctx;
    const v = this.ecl.view;
    const a = instr.args;
    const op = instr.id;
    const gi = (o: number) => this.getInt(game, e, a + o);
    const gf = (o: number) => this.getFloat(game, e, a + o);
    const gs = (o: number) => this.getShort(game, e, a + o);
    const setIntVar = (id: number, val: number) => this.varWriteInt(game, e, id, val);
    const setFloatVar = (id: number, val: number) => this.varWrite(game, e, id, val);

    switch (op) {
      case 0: return null; // nop
      case 1: return 'delete';
      case 2: { // jump(time, offset)
        this.jumpTo(s, v.i32(a + 4), v.i32(a));
        return 'flow';
      }
      case 3: { // loop: decrement var, jump while > 0
        const varId = v.i32(a + 8);
        const left = Math.trunc(this.varRead(game, e, varId)) - 1;
        setIntVar(varId, left);
        if (left <= 0) return null;
        this.jumpTo(s, v.i32(a + 4), v.i32(a));
        return 'flow';
      }
      case 4: setIntVar(v.i32(a), gi(4)); return null;
      case 5: setFloatVar(Math.trunc(v.f32(a)), gf(4)); return null;
      // Th07.exe FUN_0040f6c0 cases 6/7 call FUN_0042ff90 (u32) before
      // modulo; the float forms below call FUN_0042ffc0 (frand/u32).
      case 6: setIntVar(v.i32(a), game.rng.u32InRange(Math.max(1, gi(4)))); return null;
      case 7: setIntVar(v.i32(a), game.rng.u32InRange(Math.max(1, gi(4))) + gi(8)); return null;
      case 8: setFloatVar(Math.trunc(v.f32(a)), game.rng.range(gf(4))); return null;
      case 9: setFloatVar(Math.trunc(v.f32(a)), game.rng.range(gf(4)) + gf(8)); return null;
      // Ops 10/11 are the int/float forms of random-sign assignment.
      // Th07.exe FUN_0040f6c0 @ 0x410bde-0x410ca7 calls FUN_0042ff30
      // directly: one raw u16 draw, unlike the u32 random-value ops 6-9.
      case 10: {
        const sign = (game.rng.u16() & 1) === 0 ? -1 : 1;
        setIntVar(v.i32(a), sign * gi(4));
        return null;
      }
      case 11: {
        const sign = (game.rng.u16() & 1) === 0 ? -1 : 1;
        setFloatVar(Math.trunc(v.f32(a)), sign * gf(4));
        return null;
      }
      case 12: case 13: case 14: case 15: case 16: { // int math
        const lhs = gi(4);
        const rhs = gi(8);
        const r = op === 12 ? lhs + rhs : op === 13 ? lhs - rhs : op === 14 ? lhs * rhs
          : op === 15 ? (rhs ? lhs / rhs : 0) : (rhs ? lhs % rhs : 0);
        setIntVar(v.i32(a), Math.trunc(r));
        return null;
      }
      case 17: setIntVar(v.i32(a), Math.trunc(this.varRead(game, e, v.i32(a))) + 1); return null;
      case 18: setIntVar(v.i32(a), Math.trunc(this.varRead(game, e, v.i32(a))) - 1); return null;
      case 19: case 20: case 21: case 22: case 23: { // float math
        const lhs = gf(4);
        const rhs = gf(8);
        const r = op === 19 ? lhs + rhs : op === 20 ? lhs - rhs : op === 21 ? lhs * rhs
          : op === 22 ? (rhs ? lhs / rhs : 0) : (rhs ? lhs % rhs : 0);
        setFloatVar(Math.trunc(v.f32(a)), r);
        return null;
      }
      case 24: setFloatVar(Math.trunc(v.f32(a)), Math.sin(gf(4))); return null;
      case 25: setFloatVar(Math.trunc(v.f32(a)), Math.cos(gf(4))); return null;
      case 26: setFloatVar(Math.trunc(v.f32(a)), Math.atan2(gf(16) - gf(8), gf(12) - gf(4))); return null;
      case 27: { // timed float interp into a special-var target (8 slots,
        // exe enemy+0x770 stride 0x30; spec-op27-effects.md §1). target
        // (arg0) is a literal f32-encoded var-id tag, NEVER var-resolved;
        // duration/mode/ease and f0-f3 are var-resolvable. Same-target
        // calls override their slot; all-full drops the call silently.
        const target = Math.trunc(v.f32(a));
        const slot = {
          target,
          duration: gi(4),
          mode: gi(8),
          ease: gi(12),
          f0: gf(16),
          f1: gf(20),
          f2: gf(24),
          f3: gf(28),
          elapsed: 0
        };
        for (let i = 0; i < s.interpSlots.length; i++) {
          if (!s.interpSlots[i] || s.interpSlots[i]!.target === target) {
            s.interpSlots[i] = slot;
            break;
          }
        }
        return null;
      }
      case 43: case 44: { // cross-enemy variable read (exe cases 0x2a/0x2b,
        // objdump-confirmed): when arg1 is a var ref, it is read off the
        // TRACKED enemy DAT_012f4078[arg2] (our boss slots), not this one;
        // the result lands in arg0 on THIS enemy. 43 = int path, 44 = float.
        const destId = op === 43 ? v.i32(a) : Math.trunc(v.f32(a));
        const rawVal = op === 43 ? v.i32(a + 4) : v.f32(a + 4);
        const isRef = rawVal >= VAR_BASE && rawVal < VAR_BASE + 100;
        let value: number;
        if (isRef) {
          const idx = gi(8);
          const ref = this.bossSlots[idx] ?? e;
          value = this.varRead(game, ref, Math.trunc(rawVal));
          if (op === 43) value = Math.trunc(value);
        } else {
          value = rawVal;
        }
        if (op === 43) setIntVar(destId, value);
        else setFloatVar(destId, value);
        return null;
      }
      case 28: case 29: case 30: case 31: case 32: case 33:
      case 34: case 35: case 36: case 37: case 38: case 39: { // compare-and-jump
        const isFloat = (op & 1) === 1;
        const lhs = isFloat ? gf(0) : gi(0);
        const rhs = isFloat ? gf(4) : gi(4);
        const mode = (op - 28) >> 1; // 0 ==, 1 !=, 2 <, 3 <=, 4 >, 5 >=
        const pass = mode === 0 ? lhs === rhs : mode === 1 ? lhs !== rhs
          : mode === 2 ? lhs < rhs : mode === 3 ? lhs <= rhs
            : mode === 4 ? lhs > rhs : lhs >= rhs;
        if (pass) {
          this.jumpTo(s, v.i32(a + 12), v.i32(a + 8));
          return 'flow';
        }
        return null;
      }
      case 40: { // normalize one float variable in place
        // Th07.exe (v1.00b) FUN_0040f6c0 case 0x27 @ all.c:7972:
        // resolve the operand through FUN_0040df90, wrap it with
        // FUN_0042fff0(value, 0) into [-pi, pi], then write the result back
        // through FUN_0040e560. This is a numeric variable operation, not a
        // movement-mode setter. Stage 6 Sub24 relies on the write-back before
        // copying angles into Sub25's shoot offsets; omitting it shifts bullet
        // origins by exactly 2*pi while leaving RNG totals unchanged.
        const target = Math.trunc(v.f32(a));
        setFloatVar(target, Math.fround(normalizeAngle(gf(0))));
        return null;
      }
      case 41: { // call sub — Th07.exe case 0x28 (all.c:10042-10065)
        if (!s.disableCallStack) {
          this.pushFrame(s);
          s.stack[s.stack.length - 1].ctx.index = ctx.index + 1;
        }
        // The ECL calling convention: the caller writes the run-globals
        // (10037-10044) and CALL copies all eight into this enemy's param
        // slots, where the callee reads them as 10029-10036 (and where
        // var 10056's random range/base come from).
        for (let i = 0; i < 4; i++) {
          s.vars[18 + i] = this.globalsInt[i];
          s.vars[22 + i] = this.globalsFloat[i];
        }
        this.enterSub(s, v.i32(a));
        return 'restart';
      }
      case 42: { // return — restores cursor + vars + interp slots (all.c:10019-10041)
        const ret = s.stack.pop();
        if (s.periodicExportArmed && s.periodicSub) {
          // +0x8f4: the periodic sub's state persists in its own stash.
          s.periodicSub.savedVars.set(s.vars);
          s.periodicExportArmed = false;
        }
        if (ret) {
          s.ctx = ret.ctx;
          s.vars.set(ret.vars);
          s.interpSlots = ret.interps;
          s.periodicExportArmed = ret.periodicExportArmed;
        }
        return 'restart';
      }
      case 45: // Wait(nFrames): Th07.exe 0x40f8e9-0x40f94f, timer at +0x76c.
        // The normal index advance returns to runEcl's loop-top gate, so a
        // positive wait consumes its first tick immediately and yields before
        // any following same-time instruction.
        s.ctx.waitTimer = gi(0);
        return null;
      case 46: e.x = gf(0); e.y = gf(4); e.z = gf(8); return null;
      case 47: { // Cartesian velocity (exe case 0x2e @ all.c:8054-8090)
        // The three operands write enemy+0x2b18/1c/20 directly. This is not
        // an angle/speed pair: treating it as polar sent Stage-4 familiars
        // across the player and created three false body-graze RNG events.
        const x = gf(0);
        const y = gf(4);
        const z = gf(8);
        s.axisSpeed = { x, y, z };
        const heading = Math.fround(Math.atan2(y, x));
        s.heading = heading;
        // Native mode 0 and mode 1 share +0x2b54. Keep the port's mode-1
        // alias synchronized for a later op48/49/50 transition.
        s.angle = heading;
        s.moveMode = 0;
        return null;
      }
      case 48: s.angularVelocity = gf(0); s.moveMode = 1; return null;
      case 49: s.speed = gf(0); s.moveMode = 1; return null;
      case 50: s.acceleration = gf(0); s.moveMode = 1; return null;
      case 51: { // random float in [min, max) into var
        // Th07.exe FUN_0040f6c0 dispatcher case 0x32 @ 0x4136b3-0x413792.
        // FUN_0042ffc0 divides one u32 by 2^32, then the result is stored
        // through the float-variable resolver (single-precision write).
        const min = gf(4);
        const max = gf(8);
        const random = game.rng.u32() / 0x100000000;
        setFloatVar(Math.trunc(v.f32(a)), Math.fround(random * (max - min) + min));
        return null;
      }
      case 52: { // random movement heading, reflected away from the move bounds
        // Th07.exe FUN_0040f6c0 dispatcher case 0x33 @ 0x413799-0x41394f.
        // Despite thecl's `(dest, -pi, pi)` signature, the two range args are
        // ignored. The exe first chooses a 90-degree horizontal cone pointing
        // toward the player's side, then reflects it away from the op62 bounds.
        // The positive-angle right-wall arm intentionally uses the PREVIOUS
        // movement heading (+0x2b54), an original-game bug at 0x413886-0x413895.
        const PI = 3.1415927410125732;
        const NEG_PI = -3.1415927410125732;
        const HALF_PI = 1.5707963705062866;
        const NEG_HALF_PI = -1.5707963705062866;
        const QUARTER_PI = 0.7853981852531433;
        const THREE_QUARTER_PI = 2.356194496154785;
        const TAU_F32 = 6.2831854820251465;
        const random = game.rng.u32() / 0x100000000;
        let angle: number;
        if (e.x <= game.player.x) {
          angle = Math.fround(random * HALF_PI - QUARTER_PI);
        } else {
          angle = Math.fround(random * HALF_PI + THREE_QUARTER_PI);
          if (angle > PI) angle = Math.fround(angle - TAU_F32);
        }

        const lo = s.lowerMoveLimit;
        const hi = s.upperMoveLimit;
        if (e.x < lo.x + 96) {
          if (angle > HALF_PI) angle = Math.fround(PI - angle);
          else if (angle < NEG_HALF_PI) angle = Math.fround(NEG_PI - angle);
        }
        if (hi.x - 96 < e.x) {
          if (angle >= 0 && angle < HALF_PI) {
            angle = Math.fround(PI - s.heading); // exe bug: old heading, not `angle`
          } else if (angle > NEG_HALF_PI && angle < 0) {
            angle = Math.fround(NEG_PI - angle);
          }
        }
        if (e.y < lo.y + 48 && angle < 0) angle = Math.fround(-angle);
        if (hi.y - 48 < e.y && angle > 0) angle = Math.fround(-angle);
        setFloatVar(Math.trunc(v.f32(a)), angle);
        return null;
      }
      case 54: { // timed move by angle/speed: (duration, mode, angle, speed)
        const duration = gi(0);
        const mode = gi(4);
        const angle = gf(8);
        const speed = gf(12);
        if (duration <= 0) {
          // Th07.exe case 0x35 @ all.c:8218 writes enemy+0x2b54, the live
          // heading read by vars/op52, before arming mode 1. Keep the mode-1
          // polar alias in sync, but do not wait for the controller tail to
          // publish the heading: later same-timestamp ECL instructions can
          // read it immediately.
          s.heading = angle;
          s.angle = angle;
          s.speed = speed;
          // FUN_0040f6c0's op54 duration<=0 branch writes heading, speed,
          // mode, and the duration counter only. Existing angular velocity
          // and acceleration remain live (all.c:8212-8240).
          s.moveMode = 1;
          s.orbitDuration = duration;
          s.orbitLeft = duration;
        } else {
          // FUN_0040e850 stores the mode-2 interpolation origin in
          // enemy+0x2b8c/90/94. Mode 3 reuses those exact dwords as its
          // orbit target, and op122 can copy them while mode 2 is active.
          // Keeping only the higher-level interp.start left the shared
          // native fields stale (usually 0,0,0).
          s.orbitTarget = { x: e.x, y: e.y, z: e.z };
          s.interp = {
            start: { x: e.x, y: e.y, z: e.z },
            // FUN_0040e850: encoded speed is per frame, so the complete
            // displacement is speed * duration (there is no /2).
            delta: {
              // FUN_0040e850 @ 0x40e8ea-0x40e96d stores the complete
              // cos/sin * speed * integer-duration vectors as f32 fields.
              x: Math.fround(Math.cos(Math.fround(angle)) * Math.fround(speed) * duration) *
                (s.mirrored ? -1 : 1),
              y: Math.fround(Math.sin(Math.fround(angle)) * Math.fround(speed) * duration),
              z: 0
            },
            duration,
            left: duration
          };
          s.interpKind = mode;
          s.moveMode = 2;
          s.axisSpeed = { x: 0, y: 0, z: 0 };
        }
        return null;
      }
      case 55: { // timed move to position: (duration, mode, x, y, z)
        const duration = gi(0);
        const mode = gi(4);
        const tx = gf(8);
        const ty = gf(12);
        const tz = gf(16);
        if (duration <= 0) {
          e.x = tx;
          e.y = ty;
          e.z = tz;
        } else {
          // FUN_0040ea90 writes the current position, not the destination,
          // into the shared +0x2b8c/90/94 origin/orbit-target fields.
          s.orbitTarget = { x: e.x, y: e.y, z: e.z };
          s.interp = {
            start: { x: e.x, y: e.y, z: e.z },
            // FUN_0040ea90 flips the X delta, not the absolute target, for
            // mirrored timeline spawns.
            delta: {
              x: Math.fround(Math.fround(tx) - Math.fround(e.x)) * (s.mirrored ? -1 : 1),
              y: Math.fround(Math.fround(ty) - Math.fround(e.y)),
              z: Math.fround(Math.fround(tz) - Math.fround(e.z))
            },
            duration,
            left: duration
          };
          s.interpKind = mode;
          s.moveMode = 2;
          s.axisSpeed = { x: 0, y: 0, z: 0 };
        }
        return null;
      }
      case 56: { // orbit activator: configure+start mode-3 orbit (exe case 0x37,
        // FUN_0040f6c0 @0x4159a2-0x4159d8); duration=arg0 (0=never auto-stop),
        // target=(arg1,arg2,arg3), angle/angvel=arg4/5, speed/accel=arg6/7 --
        // see spec §3 Group B / §5.2. Previously approximated as a linear
        // move-to-target, which stranded snow helpers whose literal speed=0.
        s.orbitDuration = gi(0);
        s.orbitLeft = s.orbitDuration;
        s.orbitTarget = { x: gf(4), y: gf(8), z: gf(12) };
        s.orbitAngle = gf(16);
        s.orbitAngularVelocity = gf(20);
        s.orbitSpeed = gf(24);
        s.orbitAcceleration = gf(28);
        s.moveMode = 3;
        return null;
      }
      case 57: // adjust orbit speed/accel of an already-running mode-3 orbit
        // (exe case 0x38, +0x2b6c/+0x2b70) without resetting target/angle/duration.
        s.orbitSpeed = gf(0);
        s.orbitAcceleration = gf(4);
        return null;
      case 58: // adjust orbit angle/angvel of an already-running mode-3 orbit
        // (exe case 0x39, +0x2b5c/+0x2b60).
        s.orbitAngle = gf(0);
        s.orbitAngularVelocity = gf(4);
        return null;
      case 59: // Start mode-1 movement for N frames (exe case 0x3a).
        s.moveMode = 1;
        s.orbitDuration = gi(0);
        s.orbitLeft = gi(0);
        return null;
      case 62: {
        s.lowerMoveLimit = { x: gf(0), y: gf(4) };
        s.upperMoveLimit = { x: gf(8), y: gf(12) };
        s.shouldClamp = true;
        return null;
      }
      case 63: s.shouldClamp = false; return null;
      case 64: case 65: case 66: case 67: case 68:
      case 69: case 70: case 71: case 72: { // fire bullets, aim modes 0-8
        // Th07.exe (v1.00b) FIRE cases 0x3f-0x47 gate the complete template
        // decode and immediate fire on enemy HP > 0 (all.c:8440). A helper
        // swept to zero earlier in the fixed-slot pass still executes ECL,
        // but its same-tick FIRE is a no-op and does not resolve random args.
        if (e.hp <= 0) return null;
        const props = this.readBulletProps(game, e, op - 64, a);
        s.bulletProps = props;
        if (!s.shootDisabled) this.spawnBullets(game, e, props);
        return null;
      }
      case 73: case 74: { // auto-fire interval (74 randomizes phase)
        // Exe cases 0x48/0x49: the interval is rank-scaled at set time:
        // iv' = iv + trunc(iv/5) + trunc(-2*trunc(iv/5)*rank / 32)
        // (the exe's `+ (v>>31 & 31) >> 5` idiom is truncation toward zero).
        // Identity at rank 16; x1.2 at rank 0 — the retail value, since
        // DAT_00625884 is BSS (defaults 0), no gameplay event moves it, and
        // no stage ECL ever writes its var (10017).
        let iv = gi(0);
        if (iv !== 0) {
          const fifth = Math.trunc(iv / 5);
          iv = iv + fifth + Math.trunc((-2 * fifth * game.rank) / 32);
        }
        s.shootInterval = iv;
        s.shootTimer = op === 74 && iv > 0 ? game.rng.u32InRange(iv) : 0;
        s.shootTimerFrac = 0;
        return null;
      }
      // Ops 75/76 (exe 0x4a/0x4b) set/clear enemy flag bit 0x20, which gates
      // ONLY the immediate fire inside FIRE ops 64-72 (all.c:8545). The
      // auto-shoot interval tick (all.c:7194-7208) never consults it — see
      // updateAutoShoot.
      case 75: s.shootDisabled = true; return null;
      case 76: s.shootDisabled = false; return null;
      case 77: { // re-fire (exe case 0x4c): refresh shoot pos, fire the
        // current template again without re-reading FIRE args.
        if (s.bulletProps) this.spawnBullets(game, e, s.bulletProps);
        return null;
      }
      case 78: s.shootOffset = { x: gf(0), y: gf(4), z: gf(8) }; return null;
      case 79: { // BULLET_EX: write one op-79 template slot (arg0 = slot index)
        // exe FUN_0040f6c0 case 0x4e: arg0 selects one of 5 per-enemy slots;
        // args map opcode=arg1, cond=arg2, arg3, arg4(maxTimes), f0=arg5,
        // f1=arg6. Slots persist, are copied at FIRE, and then advance through
        // FUN_004229f0's one-movement-slot-per-manager-tick queue.
        const slot = gi(0);
        if (slot >= 0 && slot < 5) {
          s.bulletExSlots[slot] = { opcode: gi(4), cond: gi(8), arg3: gi(12), arg4: gi(16), f0: gf(20), f1: gf(24) };
        }
        if (s.bulletProps) s.bulletProps.exSlots = s.bulletExSlots.slice();
        return null;
      }
      case 80: // bullet cancel (exe case 0x4f = FUN_00422ea0(1)): every live
        // enemy bullet becomes an auto-collecting small cherry item (type 6,
        // the constructor-set cancel type at +0x37a160), no score popups.
        // Previously mislabeled as a re-fire — that is op 77.
        game.cancelBulletsToItems();
        return null;
      case 82: case 83: { // FIRE_LASER (exe cases 0x51/0x52, all.c:8715-8785).
        // 83 aims the angle at the player once at spawn; unused by any
        // retail stage but implemented for completeness. Sprite+color pack
        // the first arg slot as two i16s; width/durations/flags are
        // literal-only per the dispatcher's paramMask handling.
        // Post-bomb gate (all.c:15737): no new laser for 10 frames after a
        // field clear unless flags bit 2 (bomb-immune) is set.
        const flags = v.i32(a + 48);
        if ((game.postBombLaserCounter ?? 0) > 0 && !(flags & 4)) return null;
        // FUN_00423570 @ 0x423570 scans the fixed 64-entry global pool from
        // slot zero on every spawn. Owner-local op84 handles are independent.
        const poolSlot = this.allocateLaserPoolSlot(game);
        if (poolSlot < 0) return null;
        const angleRaw = gf(4);
        const x = e.x + s.shootOffset.x;
        const y = e.y + s.shootOffset.y;
        const angle = op === 83 ? angleRaw + Math.atan2(game.player.y - y, game.player.x - x) : angleRaw;
        const laser: EnemyLaser = {
          id: game.id++,
          poolSlot,
          ownerId: e.id,
          inUse: true,
          sprite: v.i16(a),
          color: v.i16(a + 2),
          x, y,
          angle,
          speed: gf(8),
          nearDist: gf(12),
          farDist: gf(16),
          maxLength: gf(20),
          width: v.f32(a + 24),
          displayWidth: 1.2,
          growDuration: v.i32(a + 28),
          holdDuration: v.i32(a + 32),
          shrinkDuration: v.i32(a + 36),
          telegraphDelay: v.i32(a + 40),
          shrinkCutoff: v.i32(a + 44),
          flags,
          state: 0,
          phaseFrame: 0,
          hideTipDuringGrow: false
        };
        game.enemyLasers.push(laser);
        s.laserSlots[Math.min(31, Math.max(0, s.laserSlotIndex))] = laser;
        return null;
      }
      case 84: s.laserSlotIndex = gi(0); return null; // SELECT_LASER_SLOT
      case 85: { // ADD_LASER_ANGLE (exe FUN_0042fff0: plain add + wrap to ±π)
        const l = s.laserSlots[gi(0)];
        if (l) l.angle = normalizeNativeAngleF32(l.angle, gf(4));
        return null;
      }
      case 86: { // AIM_LASER_AT_PLAYER + offset (absolute set; retail-unused)
        const l = s.laserSlots[gi(0)];
        if (l) l.angle = Math.atan2(game.player.y - l.y, game.player.x - l.x) + gf(4);
        return null;
      }
      case 87: { // REPOSITION_LASER: re-base to the enemy's CURRENT pos + offset
        const l = s.laserSlots[gi(0)];
        // Th07.exe (v1.00b) op87 @ 0x41294b-0x412a8b fstp-writes each
        // owner+offset sum directly into the laser's f32 position fields.
        if (l) {
          l.x = Math.fround(Math.fround(e.x) + Math.fround(gf(4)));
          l.y = Math.fround(Math.fround(e.y) + Math.fround(gf(8)));
        }
        return null;
      }
      case 88: return null; // IS_LASER_ALIVE writes enemy+0x8f0 — write-only/vestigial in the exe, no-op
      case 89: { // CANCEL_LASER: graceful shrink from the current display width
        const l = s.laserSlots[gi(0)];
        if (l && l.inUse && l.state < 2) {
          l.state = 2;
          l.phaseFrame = 0;
          l.width = l.displayWidth;
        }
        return null;
      }
      case 81: { // Configure the current FIRE template's sound flag/index.
        const sfx = gi(0);
        if (s.bulletProps) {
          if (sfx < 0) s.bulletProps.flags &= ~0x200;
          else {
            s.bulletProps.sfx = sfx;
            s.bulletProps.flags |= 0x200;
          }
        }
        // Th07.exe case 0x50 @ 0x414df1-0x414ea4 (all.c:8688-8714): a
        // negative arg0 clears only template bit 0x200 and preserves the
        // last index; non-negative arg0 writes enemy+0x2c9c and sets it.
        if (sfx >= 0) s.bulletSfx = sfx;
        s.bulletSfxInterval = gi(4);
        return null;
      }
      case 90: { // spell card start: (variant s16, spellId u16, XOR-0xAA shift-jis name)
        const spellId = v.u16(a + 2);
        const bytes = v.bytes;
        const start = a + 4;
        let end = start;
        while (end < bytes.length && bytes[end] !== 0xaa && end - start < 64) end++;
        const decoded = new Uint8Array(end - start);
        for (let i = 0; i < decoded.length; i++) decoded[i] = bytes[start + i] ^ 0xaa;
        s.spellName = new TextDecoder('shift_jis').decode(decoded);
        this.spellActive = true; // Th07.exe DAT_012f40a8 = 1 (all.c:6520) — GLOBAL
        game.startBossSpell?.(spellId, v.i16(a), s.spellName);
        // The declare handler cancels the field's bullets into cherry items
        // with NO score sweep (all.c:6511 = FUN_00422ea0(1)); the scored
        // 2000+20i sweep belongs to spell END / boss death only.
        game.cancelBulletsToItems();
        return null;
      }
      case 91: {
        s.spellName = '';
        this.spellActive = false; // Th07.exe DAT_012f40a8 = 0 (all.c:6692) — GLOBAL
        // Exe FUN_0040f340: only a spell that is still "live" (DAT_012f40a8
        // == 1 — i.e. it did not time out; a timeout bumps it to 2 and fades
        // the bullets itemlessly at all.c:13831) gets the phase-end sweep:
        // bullets -> cherry items with escalating 2000/+20 popups, then the
        // helper-enemy sweep (FUN_004217c0, 2000/+30), score += total/10.
        // The capture bonus (if any) is awarded on top. endBossSpell returns
        // whether the sweep applies.
        // Ending a spell also shatters the spell's helper enemies (Letty's
        // ice orbs, snowflake spinners). Evidence in ecldata1: hp-interrupt
        // transitions clean helpers with an explicit ins_94 at the next
        // phase's start (Sub42/48/52/55), but end-of-life callbacks rely on
        // ins_91 itself — Letty's death sub (Sub51) has no ins_94, yet her
        // Sub50 orbs die with the boss in the original. Cirno's Sub27 pairs
        // ins_91 with a redundant ins_94, so this stays a no-op there.
        const sweep = game.endBossSpell?.() ?? true;
        if (sweep) {
          let total = game.sweepBulletsToItems();
          total = this.killNonBossEnemies(game, this.executingEnemy, total);
          if (total > 0) game.addScore(Math.trunc(total / 10));
        } else {
          this.killNonBossEnemies(game);
        }
        return null;
      }
      case 93: { // spawn child enemy relative to parent: (sub, x, y, z, life, item, score)
        // Th07.exe (v1.00b) ECL case 0x5c @ all.c:8973 gates the entire
        // allocator (including operand resolution) on parent HP > 0. A
        // helper swept to zero earlier in the fixed-slot pass may still run
        // its current ECL instructions, but cannot spawn another generation.
        if (e.hp <= 0) return null;
        // life/item/score are variable-resolved like every other arg (exe
        // case 0x5c, all.c:8972-9027: paramMask bits 0x10/0x20/0x40 route
        // through FUN_0040d750). Stage 5's wrapper->child relay passes the
        // timeline HP via var 10027 — reading the raw word gave every child
        // 10027 HP, the tester's near-unkillable mobs (COMBAT-001).
        this.spawnEclEnemy(game, {
          subId: v.i32(a),
          x: e.x + gf(4), y: e.y + gf(8), z: e.z + gf(12),
          life: gi(16),
          item: gi(20),
          score: gi(24),
          mirrored: false,
          parent: e
        });
        return null;
      }
      case 92: { // Th07.exe case 0x5b: op92 spawns at ABSOLUTE position (op93 = relative)
        // Same HP gate as op93 (all.c:8919), before any var-resolved args.
        if (e.hp <= 0) return null;
        // Same variable resolution as op93 (all.c:8918-8981) — dormant in
        // shipped data (no op92 passes var refs here) but exe-correct.
        this.spawnEclEnemy(game, {
          subId: v.i32(a),
          x: gf(4), y: gf(8), z: gf(12),
          life: gi(16),
          item: gi(20),
          score: gi(24),
          mirrored: false,
          parent: e
        });
        return null;
      }
      // Op 94 (exe case 0x5d = FUN_004217c0(8000,0), return DISCARDED):
      // sweep helpers with cherry drops but no score bank.
      case 94: this.killNonBossEnemies(game, this.executingEnemy, 0); return null;
      case 95: this.setCurrentAnm(e, v.i32(a)); return null;
      case 96: { // directional pose scripts
        s.anmExDefaults = v.i16(a);
        s.anmExFarLeft = v.i16(a + 2);
        s.anmExFarRight = v.i16(a + 4);
        s.anmExLeft = v.i16(a + 6);
        s.anmExRight = v.i16(a + 8);
        s.anmExFlags = 0xff;
        return null;
      }
      case 97: { // aux ANM slot
        const slot = v.i32(a) | 0;
        if (slot >= 0 && slot < 8) {
          const script = v.i32(a + 4);
          s.anmSlots[slot] = {
            script,
            runner: this.makeEnemyAnmRunner(script)
          };
        }
        return null;
      }
      case 98:
        s.deathAnm1 = v.i8(a);
        s.deathAnm2 = v.i8(a + 1);
        s.deathAnm3 = v.i8(a + 2);
        return null;
      case 99: { // boss slot registration (multi-slot: stage 4+ helpers
        // register slots 1..N alongside the main boss in slot 0).
        const slot = v.i32(a) | 0;
        if (s.bossSlot != null && this.bossSlots[s.bossSlot] === e) this.bossSlots[s.bossSlot] = null;
        s.bossSlot = slot >= 0 ? slot : null;
        s.isBoss = slot >= 0;
        if (s.isBoss) this.bossSlots[slot] = e;
        this.logLifecycle(game, 'bossSlot', e, slot);
        // Th07.exe DAT_00495bf4: true while ANY boss slot is occupied.
        // setBossPresent prefers slot 0 (main) so helper registration does
        // not steal the UI/damageBoss pointer from the primary boss, and
        // so a helper's later release cannot blank the marker while the
        // main boss still lives (stage-4 Prismriver-style multi-slot).
        this.syncBossPresence(game);
        return null;
      }
      case 100:
        // Th07.exe dispatcher case 99 @ 0x413043: this is the six-slot boss
        // aura allocator, always particle type 13 at the enemy's own current
        // position. Args 1..3 seed the aura VM and arg4 is its distance;
        // those are visual state, not a position offset. All stage 1-6 data
        // uses color index 6, whose live table value is 0xffffe0ff.
        game.spawnEffectParticles(13, e.x, e.y, 1,
          v.i32(a) === 6 ? 0xffffe0ff : 0xffffffff, undefined, e.id);
        return null;
      case 101: s.hitbox = { x: gf(0), y: gf(4), z: gf(8) }; return null;
      case 102: s.collisionEnabled = !!v.i32(a); return null;
      case 103: s.canTakeDamage = !!v.i32(a); return null;
      // Player-shot collision enable — Th07.exe dispatcher case 0x67 writes
      // bit4 of enemy+0x2e29; FUN_0041ed50 (all.c:14174) runs the player
      // shot/bomb hit test only when bit0 && bit4. Stage 1 subs 36/41/43/
      // 50/54/57 (boss emitter children) set 0 = shot-transparent.
      case 104: s.shotCollision = (v.i32(a) & 1) !== 0; return null;
      // Op 105 (exe case 0x68 @ 0x413bf6, FUN_00446970): IMMEDIATE PlaySE --
      // requests SFX playback of the (possibly variable-resolved) arg the
      // instant this instruction runs, deduped against up to 5 pending IDs.
      // No enemy field is written (exe-misc-ecl-ops.md §1). This makes
      // death-callback-sub SE cues (the common pattern -- the sub only runs
      // at actual death, so timing matches for free) AND spawn-time SE cues
      // (e.g. stage-1 sub 36's op105 at t=0 of its own init) both correct.
      case 105: game.playSfx(v.i32(a)); return null;
      case 106: s.deathMode = v.i32(a); return null; // FUN_0041ed50 @ 0x41ed50
      case 107: s.deathCallbackSub = v.i32(a); return null;
      case 108: s.interrupts[v.i32(a + 4)] = v.i32(a); return null;
      case 109: s.pendingInterrupt = v.i32(a); return null;
      case 110: e.hp = e.maxHp = v.i32(a); return null;
      case 111:
        s.bossTimer = v.i32(a);
        s.bossTimerFrac = 0;
        s.bossTimerPrevious = -999;
        return null;
      case 112: s.lifeThresholds[0].threshold = v.i32(a); return null;
      case 113: s.lifeThresholds[0].sub = v.i32(a); return null;
      case 114:
        s.timerCallbackThreshold = v.i32(a);
        // Th07.exe case 0x71: arming a timer threshold also zeroes the timer.
        s.bossTimer = 0;
        s.bossTimerFrac = 0;
        s.bossTimerPrevious = -999;
        return null;
      case 115: s.timerCallbackSub = v.i32(a); return null;
      case 116: s.interactable = !!v.i32(a); return null;
      // op117/118 (exe ECL cases 0x74/0x75, all.c:9292-9346): the effectId
      // (local_c[3]) and count (local_c[4]) are variable-resolvable operands —
      // the exe routes each through FUN_0040d750 when its param-mask bit is set
      // (bit1 effectId, bit2 count). Reading them raw made a dynamic-count site
      // `ins_117(17,[10030],…)` request a literal 10030 particles (var slot
      // 10030 = vars[19]) — 260 such calls, capped to 64 each, burned ~99.8k
      // RNG draws (62% of the whole stage), scrambling the shared stream. The
      // color is NOT var-resolved (exe reads it via FUN_0040dda0) — keep it raw.
      case 117: game.spawnEffectParticles(gi(0), e.x, e.y, gi(4), v.u32(a + 8) >>> 0); return null;
      // op118's 3 floats (local_c[6..8]) are a velocity/direction SEED written
      // to the particle's +0x96/97/98 field (exe FUN_0041b560, all.c:12184),
      // NOT a spawn-position offset — position is the raw enemy xyz. Some effect
      // types (id22) branch their RNG draw count only for the <= -990
      // random-angle sentinel (FUN_0041b020 @ 0x41b020), not by x sign.
      case 118: game.spawnEffectParticles(gi(0), e.x, e.y, gi(4), v.u32(a + 8) >>> 0, { x: gf(12), y: gf(16), z: gf(20) }); return null;
      case 119: this.dropPowerItems(game, e, Math.trunc(this.varRead(game, e, v.i32(a)))); return null;
      case 120: s.anmRotateWithAngle = !!v.i32(a); return null;
      case 121: // immediate bullet-effect call (table @ 0x495148)
        this.runBulletEffect(game, e, v.i32(a), gi(4));
        return null;
      case 122: { // arm (id>=0) / disarm (id<0) the per-frame effect; the
        // param is re-resolved from the instruction every frame.
        const id = v.i32(a);
        s.effectArm = id < 0 ? null : { id, paramOff: a + 4 };
        return null;
      }
      case 123: ctx.time += gi(0); return null;
      case 124: {
        // Th07.exe ECL case 0x7b @ all.c:9418-9425 resolves a masked operand
        // through FUN_0040d750 before passing the resulting item id to
        // FUN_00430970. Stage-6 Sub70/71 stores ids 8/0/1 in local 10000;
        // reading the literal 10000 suppressed the whole authored item ring,
        // including the full-power type-0 -> type-7 drops that arm the final
        // Border at PRE24341.
        const type = ITEM_TABLE[gi(0)];
        if (type) game.spawnItem(type, e.x, e.y);
        return null;
      }
      case 125: game.unpauseStd(gi(0)); return null;
      case 126:
        s.bossLifeCount = v.i32(a);
        game.setBossLifeCount?.(s.bossLifeCount);
        return null;
      case 127: return null;
      case 128: s.anmRunner?.interrupt(v.i32(a)); return null;
      case 129: {
        const slot = v.i32(a) | 0;
        s.anmSlots[slot]?.runner?.interrupt(v.i32(a + 4));
        return null;
      }
      case 130: s.disableCallStack = !!v.i32(a); return null;
      case 131:
        s.bulletRankSpeedLow = v.f32(a);
        s.bulletRankSpeedHigh = v.f32(a + 4);
        s.bulletRankAmount1Low = v.i32(a + 8);
        s.bulletRankAmount1High = v.i32(a + 12);
        s.bulletRankAmount2Low = v.i32(a + 16);
        s.bulletRankAmount2High = v.i32(a + 20);
        return null;
      case 132: {
        const vis = !!v.i32(a);
        if (vis !== s.invisible) this.logLifecycle(game, 'invisible', e, vis ? 1 : 0);
        s.invisible = vis;
        return null;
      }
      case 133:
        s.timerCallbackSub = s.deathCallbackSub;
        s.bossTimer = 0;
        s.bossTimerFrac = 0;
        s.bossTimerPrevious = -999;
        return null;
      case 134:
        // CLEAR_LASER_HANDLES (exe case 0x85, all.c:9518): zeroes only this
        // enemy's own 32-slot handle table; the global pool and live lasers
        // are untouched. (Previously wiped every laser on screen.)
        s.laserSlots.fill(null);
        return null;
      case 135: s.spellTimeoutFlag = !!v.i32(a); return null;
      // Op 136 (exe case 0x87 -> `+0x2e29` bit5 = arg&1): gates the
      // FUN_004217c0 sweep's cherry drop (all.c:14884) AND periodic
      // body-graze re-eligibility (exe-collision.md §6, ~every 6 frames
      // while touching) — one bit, both consumers (exe-misc-ecl-ops.md §3).
      // `+0x2e2f=2` (draw-order bucket, no scoring/collision effect) is
      // not modeled.
      case 136: s.sweepItemFlag = !!(v.i32(a) & 1); return null;
      // Op 137 (exe case 0x88 -> `+0x2e2a` bit7 = arg&1): exempts this
      // enemy from updateEnemies()'s offscreen auto-cull (exe-misc-ecl-ops.md §4).
      case 137: s.offscreenCullExempt = !!(v.i32(a) & 1); return null;
      // Op 138 (exe case 0x89, thtk format SSSS): position-trail config.
      // Th07.exe @ all.c:9535-9562 writes arg0 raw to +0x4f30 and resolves
      // args1-3 through the int resolver into +0x4f32/34/36. FUN_0041ed50
      // shifts `count` history entries every enemy-manager tick and uses the
      // oldest one in its off-screen cull contract (0x41f363-0x41f45f).
      case 138:
        s.trailFlags = v.i32(a) & 0xff;
        s.trailCount = clamp(gi(4), 0, 96);
        s.trailStart = gi(8);
        s.trailStride = gi(12);
        return null;
      // Op 139 (exe case 0x8a, thtk format SSSC): writes a GLOBAL per-ID
      // effect/behavior parameter table (DAT_00495c24/c04/c44) -- not
      // per-enemy, not per-laser. Still stubbed pending its own RE pass;
      // stage 1 never calls the real laser ops (82-89/134)
      // (exe-enemy-lasers.md §0).
      case 139:
        game.configureAmbience?.(op, [v.i32(a), v.i32(a + 4), v.i32(a + 8), v.i32(a + 12)]);
        return null;
      // Op 140 (exe case 0x8b, thtk format ffff): genuine ambience config --
      // 4 global float args (palette/fade animation; matches
      // original Letty-fight AMBIENCE_CONFIG(140) calls). The
      // op number and arg shape are correct; only the renderer-side
      // consumer remains unimplemented (exe-enemy-lasers.md §0).
      case 140:
        // thtk format ffff: read the 4 args as FLOATS (palette/fade), not the
        // raw i32 bit patterns, so a future configureAmbience consumer gets
        // 1.0 rather than 1065353216.
        game.configureAmbience?.(op, [gf(0), gf(4), gf(8), gf(12)]);
        return null;
      // Op 141 (exe case 0x8c): dead jump-table entry in v1.00b -- the
      // exe's own dispatcher routes index 0x8c to the identical
      // default-fallthrough target used by the generic no-op case
      // (confirmed by direct jump-table dump; exe-enemy-lasers.md §0).
      // Not a laser op, not a stub for a real effect -- genuinely a no-op.
      case 141: return null;
      // Op 142 (exe case 0x8d -> `+0x4f40/+0x4f3c/+0x4f38`): PROBABLE
      // boss-phase damage-reduction/grace timer -- while active, player
      // bullet damage against the (boss) enemy is confirmed reduced to
      // dmg/9 (or zeroed if not the registered boss); the decrement/
      // countdown mechanism that would retire the window was not located
      // in the exe (exe-misc-ecl-ops.md §5, UNRESOLVED). Stored only --
      // wiring the damage gate without a confirmed decay path would be
      // invented behavior, not a transcription.
      // op 142: N-frame damage shield (exe case 0x8d writes enemy+0x4f40;
      // gate at FUN_0041ed50 all.c:14245: boss dmg/9, non-boss dmg=0).
      case 142:
        s.damageShield = v.i32(a);
        // Exe case 0x8d @ all.c:9628-9638 also clears +0x4f3c and seeds
        // the unused previous-value word +0x4f38 to -999.
        s.damageShieldFrac = 0;
        return null;
      case 143: { // CancelBulletsInRadius (exe case 0x8e = FUN_00423360):
        // deletes bullets within radius of the enemy, each spawning a
        // small cherry item (FUN_00430970 type 6, mode 1).
        const radius = gf(0);
        const bullets = game.enemyBullets;
        const survivors: EnemyBullet[] = [];
        for (const b of bullets) {
          if (b.dead) continue;
          const dx = b.x - e.x;
          const dy = b.y - e.y;
          if (dx * dx + dy * dy <= radius * radius) {
            game.spawnItem('cherry', b.x, b.y, { state: 1 });
            if (game.removeEnemyBullet) game.removeEnemyBullet(b);
            else b.dead = true;
          } else {
            survivors.push(b);
          }
        }
        bullets.length = 0;
        bullets.push(...survivors);
        return null;
      }
      case 144: { // ArmPeriodicSub(period, subId) (exe case 0x8f): every
        // `period` frames, nested gosub subId; -1 disarms. NOT death-tied.
        const period = gi(0);
        const subId = v.i32(a + 4);
        s.periodicSub = subId < 0 ? null : {
          period: Math.max(1, period),
          subId,
          elapsed: 0,
          elapsedFrac: 0,
          // Th07.exe (v1.00b) FUN_0040f6c0 case 0x8f @ all.c:9668-9676:
          // arming op144 copies the CURRENT 26-dword local/parameter block
          // from enemy+0x6fc into the persistent enemy+0x2ee8 stash. Starting
          // from zero loses caller-seeded angles (Stage 6 Sub43 -> Sub44) and
          // turns the whole periodic pattern into a different trajectory.
          savedVars: s.vars.slice()
        };
        return null;
      }
      case 145: { // SendInterruptToTrackedEnemy(idx, interruptIndex) (case 0x90)
        // Th07.exe all.c:9677-9698 writes the index into target +0x2b08;
        // its next frame resolves that index through the target's op108 table.
        const target = this.bossSlots[gi(0)];
        if (target) target.ecl.pendingInterrupt = v.i32(a + 4);
        return null;
      }
      case 146: // CancelAllBullets (exe case 0x91 = FUN_00422ea0(0)):
        // plain state-5 fade, NO items; non-immune lasers reset too.
        if (game.clearEnemyBullets) game.clearEnemyBullets();
        else game.enemyBullets.length = 0;
        game.cancelLasers?.(false);
        return null;
      case 148: { // Th07.exe FUN_0040f6c0 case 0x93: HP-threshold callback slot
        const slot = Math.max(0, Math.min(3, v.i32(a)));
        s.lifeThresholds[slot] = { threshold: v.i32(a + 4), sub: v.i32(a + 8) };
        return null;
      }
      case 149: // SetSpellPresentationOrigin(followBoss, x, y, z) — moves/
        // freezes the spell-card presentation entity created at op90
        // (spec-effects-misc.md §15). The port draws that presentation as a
        // flat overlay with no world entity, so there is nothing to move;
        // no-op with corrected semantics (1 use: stage 4 freeze mode).
        return null;
      case 150: // exe case 0x95: absolute Z rotation into the enemy's own
        // embedded ANM VM (+8), radians (spec-effects-misc.md §16).
        s.anmRotZ = gf(0);
        return null;
      case 151: { // PolarToXY (exe case 0x96): arg0 = cos, arg1 = sin.
        // Th07.exe (v1.00b) @ 0x4156d9-0x4157b3: FUN_00481500 is fsin
        // and writes through instr+0x10 (the second destination); then
        // FUN_004815b0 is fcos and writes through instr+0x0c (the first).
        // Reversing these coordinates rotates every authored offset across
        // y=x; Stage 6 Sub30's slot 715 was displaced from birth by
        // (+22.78,-22.78), enough to miss the native graze 135 ticks later.
        const angle = gf(8);
        const mag = gf(12);
        this.varWrite(game, e, Math.trunc(v.f32(a + 4)), Math.sin(angle) * mag);
        this.varWrite(game, e, Math.trunc(v.f32(a)), Math.cos(angle) * mag);
        return null;
      }
      case 153: // secondary shot-collision extent triple (exe +0x2b48/4c/50)
        s.hitbox2 = { x: gf(0), y: gf(4), z: gf(8) };
        return null;
      case 155: { // random horizontal shot angle away from the near wall
        // (exe case 0x9a, constants read from the binary: 96/288/pi/2/
        // 3pi/4/pi/4): enemy on the right/past x=288 -> angle in
        // [3pi/4, 5pi/4) (leftward); else [-pi/4, pi/4) (rightward).
        const x = e.x;
        const leftward = (x > game.player.x && x > 96) || x > 288;
        const r = game.rng.range(Math.PI / 2);
        const angle = leftward ? normalizeAngle(r + (3 * Math.PI) / 4) : r - Math.PI / 4;
        this.varWrite(game, e, Math.trunc(v.f32(a)), angle);
        return null;
      }
      case 159: { // one-shot lerp: dest = (to - from) * t + from (exe 0x9e)
        const to = gf(4);
        const from = gf(8);
        const t = gf(12);
        this.varWrite(game, e, Math.trunc(v.f32(a)), (to - from) * t + from);
        return null;
      }
      case 161: return null; // SetScriptPausesDuringSlowmo — slowmo clock not modeled
      case 152: { // SET_LASER_ANGLE (exe case 0x97, all.c:9813): absolute
        // store, no wrap — scripts track/wrap their own angle vars and
        // blind-write them every frame (stage 6 pentagram spinner).
        const l = s.laserSlots[gi(0)];
        if (l) l.angle = gf(4);
        return null;
      }
      case 154:
        // op 154 drops N POINT items (Th07.exe ECL VM case 0x99 @ 0x4148f5:
        // FUN_00430970(pos, 1, 0) -- type 1 = point, NOT cherry), scattered ±64.
        game.dropPointItems?.(e, Math.trunc(this.varRead(game, e, v.i32(a))));
        return null;
      case 156: { // SET_LASER_FLAG_E9 (exe case 0x9b): suppress the tip-glow
        // spark during the grow/telegraph phase (cosmetic).
        const l = s.laserSlots[gi(0)];
        if (l) l.hideTipDuringGrow = !!gi(4);
        return null;
      }
      case 157: { // SET_LASER_MAXLENGTH (exe case 0x9c)
        const l = s.laserSlots[gi(0)];
        if (l) l.maxLength = gf(4);
        return null;
      }
      case 158: { // SET_LASER_NEARFAR (exe case 0x9d): both set together
        const l = s.laserSlots[gi(0)];
        if (l) { l.nearDist = gf(4); l.farDist = gf(8); }
        return null;
      }
      // op 160 (exe case 0x9f) calls FUN_0042dc6f(arg) — the cherry +
      // cherryPlus accumulator, NOT a spell-value award (spec-lasers.md
      // §4.13 corrected the old TH07-TODO guess).
      case 160: game.awardCherry?.(v.i32(a)); return null;
      default:
        warnOnce(`op${op}`, `unhandled ECL op ${op} (sub ${ctx.subId})`);
        return null;
    }
  }

  // ---- bullets, items, misc -----------------------------------------------

  private readBulletProps(game: GameHost, e: Enemy, aimMode: number, a: number): BulletProps {
    const s = e.ecl;
    const speed1 = this.getFloat(game, e, a + 12);
    const speed2 = this.getFloat(game, e, a + 16);
    // Th07.exe FUN_0040f6c0 fire body (all.c:8503): the whole rank/count/speed
    // scaling + min-1-count + 0.3-speed floors are gated behind
    // `if (DAT_012f40a8 == 0)` — the GLOBAL spell-active state, so during a
    // spell EVERY emitter (boss and helpers alike) uses the raw ECL
    // count/speed args verbatim (audit-fire-aimmode.md D1; CADENCE-001).
    if (this.spellActive) {
      return {
        sprite: this.getShort(game, e, a),
        offset: this.getShort(game, e, a + 2),
        count1: this.getInt(game, e, a + 4),
        count2: this.getInt(game, e, a + 8),
        speed1,
        speed2,
        // FUN_0040f6c0 copies the raw f32 endpoint into the FIRE template;
        // FUN_00421e90 normalizes only the final constructed angle. This is
        // load-bearing for random modes 6/8 when an authored interval crosses
        // +pi: pre-wrapping one endpoint turns the intended short interval
        // into an almost-full-circle spread (8141 Stage 3 PRE5936).
        angle1: this.getFloat(game, e, a + 20),
        angle2: this.getFloat(game, e, a + 24),
        flags: this.ecl.view.i32(a + 28),
        sfx: s.bulletSfx,
        exSlots: s.bulletExSlots.slice(),
        aimMode
      };
    }
    const rankSpeed = game.rank * (s.bulletRankSpeedHigh - s.bulletRankSpeedLow) / 32 + s.bulletRankSpeedLow;
    // Exe (0x411c76/0x4120d2): idiv truncates the (hi-lo)*rank product BEFORE
    // adding the Lo base — trunc of the sum differs by 1 when Lo < 0 and the
    // product lands on a half-step (e.g. hi-lo=1 at rank 16).
    const add1 = Math.trunc(game.rank * (s.bulletRankAmount1High - s.bulletRankAmount1Low) / 32) + s.bulletRankAmount1Low;
    const add2 = Math.trunc(game.rank * (s.bulletRankAmount2High - s.bulletRankAmount2Low) / 32) + s.bulletRankAmount2Low;
    return {
      sprite: this.getShort(game, e, a),
      offset: this.getShort(game, e, a + 2),
      count1: Math.max(1, this.getInt(game, e, a + 4) + add1),
      count2: Math.max(1, this.getInt(game, e, a + 8) + add2),
      speed1: speed1 ? Math.max(0.3, speed1 + rankSpeed) : 0,
      speed2: Math.max(0.3, speed2 + rankSpeed / 2),
      angle1: this.getFloat(game, e, a + 20),
      angle2: this.getFloat(game, e, a + 24),
      flags: this.ecl.view.i32(a + 28),
      sfx: s.bulletSfx,
      exSlots: s.bulletExSlots.slice(),
      aimMode
    };
  }

  // Th07.exe builds exactly 11 bullet templates at startup (FUN_004256d0,
  // loop bound 0xb; script table int[11][5] @ 0x48b160) and the FIRE sprite
  // arg is a raw unclamped index into them (FUN_00423480: 0x625938 +
  // sprite*0xb8c, no remap). Primary scripts: templates 0-9 -> ANM global
  // ids 0x200-0x209 = etama.anm ENTRY 0 on-disk scripts 0-9; template 10 ->
  // global 0x2a8 = ENTRY 1 (etama2.png) on-disk script 0, the 64x64 大玉 —
  // the exe's entry-1 base 0x2a8 equals 0x200 + entry0's 168-id span,
  // matching Anm.parse()'s own spriteBase 168 (recon bullet-type-map.md).
  // The FIRE offset shifts the resolved base sprite in GLOBAL id space
  // (FUN_00421e90: template[+0x1d4] + offset), so entry-1 offsets must add
  // the entry's spriteBase. Sprites >= 11 are out-of-table in the exe too
  // (undefined behavior); stages 1-6 data only ever fires 0-10.
  private static readonly BULLET_TEMPLATE_ENTRY: { entryIndex: number; script: number }[] = [
    { entryIndex: 0, script: 0 }, { entryIndex: 0, script: 1 },
    { entryIndex: 0, script: 2 }, { entryIndex: 0, script: 3 },
    { entryIndex: 0, script: 4 }, { entryIndex: 0, script: 5 },
    { entryIndex: 0, script: 6 }, { entryIndex: 0, script: 7 },
    { entryIndex: 0, script: 8 }, { entryIndex: 0, script: 9 },
    { entryIndex: 1, script: 0 }
  ];
  private badBulletWarned = new Set<string>();

  bulletRect(sprite: number, offset: number): { x: number; y: number; w: number; h: number; imageKey: string } {
    const key = `${sprite}:${offset}`;
    const cached = this.bulletRectCache.get(key);
    if (cached) return cached;
    try {
      const tpl = StageRuntime.BULLET_TEMPLATE_ENTRY[sprite];
      if (!tpl) throw new Error(`FIRE sprite ${sprite} is outside the exe's 11-template table`);
      const rect = this.bulletRectInEntry(tpl.entryIndex, tpl.script, offset);
      this.bulletRectCache.set(key, rect);
      return rect;
    } catch (err) {
      // Degrade to the plain pellet instead of throwing: an uncaught throw
      // here escapes StageRuntime.update and halts the rAF loop (frozen
      // game). A loud structured error once per combo — retail stage data
      // must never reach this path (sweep-verified sprites 0-10 only).
      if (!this.badBulletWarned.has(key)) {
        this.badBulletWarned.add(key);
        console.error(`bulletRect: UNMAPPED bullet type sprite=${sprite} offset=${offset}: ${err}`);
      }
      const rect = this.bulletRectInEntry(0, 0, 0);
      this.bulletRectCache.set(key, rect);
      return rect;
    }
  }

  private bulletRectInEntry(entryIndex: number, script: number, offset: number): { x: number; y: number; w: number; h: number; imageKey: string } {
    const ref = this.bulletAnm.scriptRefInEntry(entryIndex, script);
    // The script's own op3 uses entry-LOCAL sprite ids; the flat sprite map
    // is keyed by global id, so shift by the entry's spriteBase (0 for
    // entry 0) plus the FIRE offset — the exe's global-space base+offset.
    const spriteBase = this.bulletAnm.entries[entryIndex]?.spriteBase ?? 0;
    const runner = new AnmRunner(this.bulletAnm, script, { spriteIndexOffset: spriteBase + offset, entryIndex });
    const frame = runner.spriteFrame();
    if (!frame) throw new Error(`missing bullet ANM frame for entry ${entryIndex} script ${script} offset ${offset}`);
    return { x: frame.x, y: frame.y, w: frame.w, h: frame.h, imageKey: frame.imageKey || ref.imageKey || 'etama' };
  }

  spawnBullets(
    game: GameHost,
    e: Enemy,
    p: BulletProps,
    origin: { x: number; y: number } | null = null,
    occupiedPoolSlots: Uint8Array | null = null
  ): void {
    // FUN_00423480 @ 0x42348b gates the WHOLE volley on DAT_0099fa60,
    // which is the previous FUN_004241c0 manager-entry census. It is not the
    // current number of occupied slots: bullets culled later in that manager
    // pass leave holes, but enemy FIRE in the next priority-10 pass still
    // refuses the volley when the latched count was 1024. The allocator below
    // independently enforces the physical fixed-pool limit for other cases.
    if ((game.enemyBulletManagerEntryCount ?? 0) >= ENEMY_BULLET_CAP) return;
    // FUN_0040f6c0 stages enemy position + FIRE offset through f32 template
    // fields (+0x2bd8/+0x2bdc), and FUN_00421e90 copies those bits verbatim
    // into bullet+0xb8c/+0xb90.  These are gameplay coordinates before the
    // first same-frame bullet-manager move, not merely render precision.
    const shootX = Math.fround(origin?.x ?? e.x + e.ecl.shootOffset.x);
    const shootY = Math.fround(origin?.y ?? e.y + e.ecl.shootOffset.y);
    // Test-only observability (PLAN.md Phase 0 / LIFE-001): last frame this
    // enemy emitted bullets. Gameplay never reads it.
    e.ecl.lastFireFrame = game.frame;
    // FUN_0043f2b0 stores both deltas as f32 before FPATAN; FUN_00423480 then
    // stores the returned aim once more as f32 before passing it by value.
    const aimDx = Math.fround(game.player.x - shootX);
    const aimDy = Math.fround(game.player.y - shootY);
    const aim = aimDx === 0 && aimDy === 0
      ? NATIVE_HALF_PI_F32
      : Math.fround(Math.atan2(aimDy, aimDx));
    // The FIRE template endpoints are raw f32 values.  Do not pre-wrap angle
    // endpoints: random modes 6/8 interpolate the authored interval first,
    // then FUN_0042fff0 wraps only the completed per-bullet angle.
    const speed1 = Math.fround(p.speed1);
    const speed2 = Math.fround(p.speed2);
    const angle1 = Math.fround(p.angle1);
    const angle2 = Math.fround(p.angle2);
    const rate = Math.fround(game.slowRate ?? 1);
    const occupied = occupiedPoolSlots ?? this.occupiedBulletPoolSlots(game);
    let rect: { x: number; y: number; w: number; h: number; imageKey: string } | null = null;
    for (let j = 0; j < p.count2; j++) {
      const speed = p.count2 < 2
        ? speed1
        : Math.fround(speed1 - ((speed1 - speed2) * j) / p.count2);
      for (let i = 0; i < p.count1; i++) {
        const poolSlot = this.allocateBulletPoolSlot(occupied);
        if (poolSlot < 0) return;
        let angle = 0;
        if (p.aimMode <= 1) {
          angle = Math.fround(
            ((p.count1 & 1) ? Math.floor((i + 1) / 2) : Math.floor(i / 2) + 0.5) * angle2
          );
          if (i & 1) angle = Math.fround(-angle);
          if (p.aimMode === 0) angle = Math.fround(angle + aim);
          angle = Math.fround(angle + angle1);
        } else if (p.aimMode === 2 || p.aimMode === 3) {
          if (p.aimMode === 2) angle = aim;
          angle = Math.fround(angle + (i * NATIVE_TAU_F32) / p.count1);
          angle = Math.fround(j * angle2 + angle1 + angle);
        } else if (p.aimMode === 4 || p.aimMode === 5) {
          if (p.aimMode === 4) angle = aim;
          angle = Math.fround(angle + NATIVE_PI_F32 / p.count1);
          angle = Math.fround(angle + (i * NATIVE_TAU_F32) / p.count1);
          angle = Math.fround(angle + angle1);
        } else if (p.aimMode === 6) {
          const span = Math.fround(angle1 - angle2);
          angle = Math.fround(game.rng.range(span) + angle2);
        } else if (p.aimMode === 7) {
          angle = Math.fround((i * NATIVE_TAU_F32) / p.count1);
          angle = Math.fround(j * angle2 + angle1 + angle);
        } else {
          const span = Math.fround(angle1 - angle2);
          angle = Math.fround(game.rng.range(span) + angle2);
        }
        angle = normalizeNativeAngleF32(angle);
        const spd = p.aimMode === 7 || p.aimMode === 8
          ? Math.fround(game.rng.range(Math.fround(speed1 - speed2)) + speed2)
          : speed;
        // FUN_00421e90 stores nominal speed/angle as f32, stages
        // speed*DAT_0056baa8 through a temporary f32 argument, then
        // FUN_004074e0 writes each FSINCOS product to f32 vx/vy fields.
        const scaledSpeed = Math.fround(spd * rate);
        const vx = Math.fround(Math.cos(angle) * scaledSpeed);
        const vy = Math.fround(Math.sin(angle) * scaledSpeed);
        if (!rect) rect = this.bulletRect(p.sprite, p.offset);
        const flags = p.flags | 0;
        // Flags select authored etama spawn states 2/3/4. State lifetime is
        // the copied template ANM's lifetime, not a property of the flag
        // alone. Th07.exe's int[11][5] table @ 0x48b160 maps templates 0-6
        // to entry-0 scripts 18/21 (10 ticks), 19/22 (16), 20/23 (32);
        // templates 7-9 map ALL three spawn states to script 24 (32); and
        // template 10 maps all three to entry-1 script 2 (24). Direct native
        // Stage-6 slot 767 confirms template 7 + state 3 remains in spawn for
        // 32 ticks: treating it as the generic 16-tick state moves it 9.6
        // velocity vectors too far and creates a false graze at PRE4947.
        // Th07.exe
        // FUN_00421e90 @ 0x4226ec-0x42279c also backs the initial position
        // up by four velocity vectors before the reduced-speed intro begins.
        const hasSpawnState = (flags & 0xe) !== 0;
        const spawnDuration = !hasSpawnState ? 0
          : p.sprite === 10 ? 24
            : p.sprite >= 7 ? 32
              : flags & 2 ? 10 : flags & 4 ? 16 : 32;
        const spawnMoveScale = flags & 2 ? 1 / 2 : flags & 4 ? 1 / 2.5 : flags & 8 ? 1 / 3 : 1;
        // Spawn-time rate bake-in (exe FUN_00421e90/FUN_004229f0:
        // FUN_004074e0(angle, speed * DAT_0056baa8); spec-slowmo.md §3.4) —
        // the nominal speed field stays unscaled.
        const bullet: EnemyBullet = {
          id: game.id++,
          poolSlot,
          ownerId: e.id,
          ownerSub: e.ecl.subId,
          spawnFrame: game.frame,
          effectState: 0,
          // Spawn states 2/3/4 back the copied f32 origin up by four stored
          // velocity vectors.  Each multiply and subtract is separately
          // fstp'd to f32 in FUN_00421e90 @ 0x4225cf..0x422900.
          x: spawnDuration
            ? Math.fround(shootX - Math.fround(vx * 4))
            : shootX,
          y: spawnDuration
            ? Math.fround(shootY - Math.fround(vy * 4))
            : shootY,
          vx,
          vy,
          speed: spd,
          angle,
          age: 0,
          flags,
          sprite: p.sprite,
          spriteOffset: p.offset,
          rect,
          // FUN_004256d0 initializes template +0x1d6 from its offset-0
          // +0x1d4 shape. FUN_00421e90 changes the live shape for FIRE's
          // color offset without changing this backup, which matters for a
          // template-6 bullet spawned after slowmo has already begun.
          slowmoShapeBackupRect: this.bulletRect(p.sprite, 0),
          grazeW: BULLET_HITBOX_BY_SPRITE[p.sprite] ?? Math.max(3, rect.w * 0.4),
          grazeH: BULLET_HITBOX_BY_SPRITE[p.sprite] ?? Math.max(3, rect.h * 0.4),
          grazed: false,
          spawnAge: 0,
          spawnAgeFrac: 0,
          spawnDuration,
          spawnMoveScale,
          exFlags: 0,
          exSlots: p.exSlots.map((slot) => slot ? { ...slot } : null),
          exFireFlags: flags,
          exBehaviorIndex: 0,
          exRampElapsed: 0,
          exRampFrac: 0,
          exAccel: null,
          exAccelElapsed: 0,
          exAccelFrac: 0,
          exAngle: null,
          exAngleElapsed: 0,
          exAngleFrac: 0,
          exDir: null,
          exDirElapsed: 0,
          exDirFrac: 0,
          exBounce: null,
          dirTimes: 0,
          exBounceTimes: 0,
          graceFrames: 0,
          offscreenFrames: 0
        };
        // FUN_00421e90 calls FUN_004229f0 once after copying the queue into
        // the allocated fixed slot. Spawn-state bullets wait until their ANM
        // transition before the bullet manager promotes another slot.
        advanceBulletExBehavior(bullet, game.slowRate ?? 1);
        if (game.addEnemyBullet) {
          if (!game.addEnemyBullet(bullet)) return;
        } else {
          game.enemyBullets.push(bullet);
        }
      }
    }
    // Th07.exe FUN_00423480 @ 0x423530-0x423553: template bit 0x200 is
    // the sole gate; the sound index comes from template+0xc8 and defaults
    // to zero with the enemy struct's zero-fill.
    if (p.flags & 0x200) game.playSfx(p.sfx);
  }

  // Mark a trash mob for the normal manager death path. FUN_004217c0 runs
  // inside one enemy slot's ECL dispatch, so later slots still execute their
  // core once before FUN_0041ed50 observes hp <= 0 and enters the callback.
  // Eagerly entering the callback here skipped those later-slot instructions
  // (Stage 1 PRE8061 lost three op9 draws after Letty's op91 sweep).
  private clearNonBossEnemy(
    game: GameHost,
    enemy: Enemy,
    sweepItems: boolean
  ): Array<{ x: number; y: number; z: number }> {
    enemy.hp = 0;
    const s = enemy.ecl;
    const drops: Array<{ x: number; y: number; z: number }> = [];
    if (sweepItems && s.sweepItemFlag) {
      drops.push({ x: enemy.x, y: enemy.y, z: enemy.z });
      // Th07.exe (v1.00b) FUN_004217c0 @ 0x421863-0x42196d walks an
      // op138 actor's stored trail at indices 0,6,12,... < trailCount and
      // creates another type-6/mode-1 item at every sampled position. The
      // popup/score ramp advances once per trail item too. Stage 1's three
      // Sub41 helpers each contribute six such samples at the pre-dialogue
      // sweep; omitting them left the run 18 Cherry items short and delayed
      // the final Border by about 545 frames despite an exact RNG stream.
      if (s.trailFlags !== 0) {
        const limit = Math.min(96, s.trailCount, s.trailHistory.length);
        for (let i = 0; i < limit; i += 6) {
          const point = s.trailHistory[i];
          drops.push({ x: point.x, y: point.y, z: point.z });
        }
      }
      for (const drop of drops) game.spawnItem('cherry', drop.x, drop.y, { state: 1 });
    }
    // Th07.exe (v1.00b) FUN_004217c0 @ 0x421925-0x42195f: the normal
    // manager death switch handles interactable enemies after hp becomes 0,
    // but an op116-disabled helper cannot enter that switch. The sweep enters
    // its death callback directly and consumes the callback handle here.
    // This is only a raw FUN_0040d6d0 cursor entry: unlike killEnemy's retained
    // death path it does not reset rank/fire templates or the periodic slot.
    if (!s.interactable && s.deathCallbackSub >= 0) {
      const callback = s.deathCallbackSub;
      s.deathCallbackSub = -1;
      this.enterSub(s, callback);
    }
    return drops;
  }

  // Th07.exe FUN_004217c0 (op94's handler, also called at op91/spell-end
  // and boss nonspell death): sweeps every live non-boss enemy — hp = 0
  // always; enemies flagged by op136 (`+0x2e29` bit5) additionally drop an
  // auto-collecting cherry item (type 6, mode 1) with an escalating value
  // popup: 2000 + 30 per drop, capped at 8000, all summed into a running
  // total the CALLER may (op91/boss death: score += total/10, all.c:6632/
  // 14343) or may not (op94: return discarded, all.c:9029) bank as score.
  // Pass startTotal to run the item sweep and continue that accumulator;
  // omit it for an itemless clear (spell-timeout op91, phase transitions —
  // the exe has no engine-side helper sweep on those paths).
  killNonBossEnemies(game: GameHost, owner: Enemy | null = this.executingEnemy, startTotal?: number): number {
    const sweepItems = startTotal !== undefined;
    let total = startTotal ?? 0;
    let value = 2000;
    for (const enemy of game.enemies) {
      if (enemy === owner || enemy.ecl.isBoss) continue;
      const drops = this.clearNonBossEnemy(game, enemy, sweepItems);
      for (const drop of drops) {
        // FUN_004217c0: escalating popup per swept drop — white while
        // ramping, yellow at the cap (spec-popups.md §4.2).
        game.spawnScorePopup?.(value, drop.x, drop.y, value < 8000 ? 0xffffffff : 0xffffff00);
        total += value;
        value = Math.min(8000, value + 30);
      }
    }
    return total;
  }

  private clearNonBossEnemies(game: GameHost, owner: Enemy): void {
    for (const enemy of game.enemies) {
      if (enemy === owner || enemy.ecl.isBoss) continue;
      this.clearNonBossEnemy(game, enemy, false);
    }
  }

  private executingEnemy: Enemy | null = null;

  // Recompute bossRegistered + setBossPresent from the live bossSlots table.
  // Slot 0 is the primary (UI marker / damageBoss target); if empty, fall
  // through to the lowest occupied slot. No occupied slots → clear.
  private syncBossPresence(game: GameHost): void {
    let primary: Enemy | null = null;
    let any = false;
    for (let i = 0; i < this.bossSlots.length; i++) {
      const b = this.bossSlots[i];
      if (!b || b.dead) continue;
      any = true;
      if (primary == null || i === 0) primary = b;
      if (i === 0) break;
    }
    this.bossRegistered = any;
    game.setBossPresent?.(any, primary);
  }

  // FUN_0041ed50 writes DAT_00495bf4 directly on boss death transitions;
  // the registered slot remains live so callback ECL and remote interrupts
  // can still address the actor during its transition.
  private clearBossPresence(game: GameHost): void {
    this.bossRegistered = false;
    game.setBossPresent?.(false, null);
  }

  // Must be called whenever an enemy is removed from the game for any reason,
  // so boss slots and presence flags don't go stale.
  releaseEnemy(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    this.logLifecycle(game, 'release', e);
    game.releaseEnemyEffects?.(e.id);
    if (s.bossSlot != null && this.bossSlots[s.bossSlot] === e) {
      this.bossSlots[s.bossSlot] = null;
    }
    // Only clear presence if no other slot still holds a live boss — a
    // helper in slot 1/2/3 dying must not blank the main boss in slot 0.
    if (s.isBoss) this.syncBossPresence(game);
  }

  killEnemy(game: GameHost, e: Enemy): boolean {
    const s = e.ecl;
    // FUN_0041ed50 @ 0x420005 gates death only on hp <= 0 and op116's
    // interactable bit. op132 invisibility has no bearing on lifecycle.
    if (!s.interactable) return true;
    this.logLifecycle(game, 'kill', e, s.deathMode & 7);

    for (const threshold of s.lifeThresholds) threshold.threshold = -1;
    s.timerCallbackThreshold = -1;
    s.timerCallbackSub = -1;
    // Death dispatch preamble clears the op144 periodic slot too
    // (all.c:14309; the callback-entry tail repeats it at 14384).
    s.periodicSub = null;

    const mode = s.deathMode & 7;
    // all.c:14318-14323 clears presence for boss modes 0/1; case 3 clears it
    // unconditionally at all.c:14367. Mode 2 deliberately leaves it set.
    if (((mode === 0 || mode === 1) && s.isBoss) || mode === 3) {
      this.clearBossPresence(game);
    }
    if (mode === 0 || mode === 1) {
      // The ECL spawn score is stored at enemy+0x2bc0 in display*10 units;
      // FUN_0041ed50 adds that value / 10 for modes 0 and 1 only.
      game.addScore(Math.trunc((e.score || 0) / 10));
    }
    if (mode === 1) s.interactable = false;
    if (mode === 3) {
      // Special boss-death transition: retain the actor at 1 HP, disable
      // damage, and make its next scripted zero-HP death a mode-0 removal.
      e.hp = 1;
      s.canTakeDamage = false;
      s.deathMode = 0;
    } else {
      // FUN_0041ed50's preburst and item constructor are interleaved before
      // the boss field sweep and before the common death effects. This order
      // is load-bearing because every effect veto shares the gameplay RNG.
      this.spawnDeathDropAndPreburst(game, e);
      if (s.isBoss) {
        if (!this.spellActive) {
          let total = game.sweepBulletsToItems();
          total = this.killNonBossEnemies(game, e, total);
          if (total > 0) game.addScore(Math.trunc(total / 10));
        }
        // During an active spell the death switch deliberately leaves the
        // bullet field alone. Mode-1 bosses retain their slot and enter the
        // authored death-callback sub; its op91 runs on the following enemy
        // tick and performs FUN_00423100's scored bullets-to-items sweep.
        // Clearing here one frame early discarded the entire field before
        // op91 could convert it (Th07.exe v1.00b all.c:14318-14398, then
        // FUN_0040f340 @ 0x40f340).
      }
    }
    // Op 105 is an immediate PlaySE. A callback's own op105 plays separately
    // when that sub runs; this is the generic enemy-death request.
    // Exe death SE (disasm @ 0x420379): slot 2 + (counter & 1) — plain
    // kills alternate se_enep00's two volume slots (-1200/-1500 mB).
    game.playSfx(2 + (e.id & 1));
    if (mode === 3 && s.deathAnm1 >= 0) {
      game.spawnEffectParticles(s.deathAnm1, e.x, e.y, 3, 0xffffffff);
    }
    if (s.deathAnm1 >= 0) {
      game.spawnEffectParticles(s.deathAnm1, e.x, e.y, 1, 0xffffffff);
      game.spawnEffectParticles(s.deathAnm2 + 4, e.x, e.y, 4, 0xffffffff);
    }
    game.spawnEnemyDeathEffect?.(e, mode);

    const callback = s.deathCallbackSub;
    s.deathCallbackSub = -1;
    // Mode 0 clears the enemy slot's active bit (+0x2e28 bit7, all.c:14313)
    // BEFORE the common tail enters the callback sub (FUN_0040d6d0 @
    // all.c:14393) — and the master loop skips inactive slots outright
    // (`if (-1 < *(char*)(enemy+0x2e28)) goto end` @ all.c:14039), so the
    // entered callback never executes for mode 0. Adjudicated twice
    // (2026-07-11): the dispatch IS reached, the sub does NOT run.
    if (mode === 0) return false;
    if (callback >= 0) {
      // FUN_0041ed50 death-callback entry, Th07.exe v1.00b
      // @ 0x4203de-0x420411 (all.c:14373-14379): every retained callback
      // actor receives the same rank-template reset as a boss phase entry
      // before its callback ECL runs. This also applies to ordinary mode-1
      // enemies; Stage-4 Sub17's death callback immediately fires bullets
      // whose native rank-32 speed is raw+0.5, not the fresh-enemy +0.15.
      s.bulletRankSpeedLow = -0.5;
      s.bulletRankSpeedHigh = 0.5;
      s.bulletRankAmount1Low = 0;
      s.bulletRankAmount1High = 0;
      s.bulletRankAmount2Low = 0;
      s.bulletRankAmount2High = 0;
      this.resetFireTemplateState(s);
      s.stack.length = 0;
      s.periodicExportArmed = false;
      this.enterSub(s, callback);
    }
    // Modes 1-3 retain the actor for their scripted death/phase transition.
    return true;
  }

  private dropPowerItems(game: GameHost, e: Enemy, count: number): void {
    const total = Math.max(0, count | 0);
    for (let i = 0; i < total; i++) {
      // Th07.exe op 119 (ECL VM 0x76 @ 0x414630): scatter ±64 (rand·128 − 64).
      const x = e.x + game.rng.range(128) - 64;
      const y = e.y + game.rng.range(128) - 64;
      const type: ItemType = game.power < 128 ? (i === 0 ? 'bigPower' : 'power') : 'point';
      game.spawnItem(type, x, y);
    }
  }

  private spawnDeathDropAndPreburst(game: GameHost, e: Enemy): void {
    const itemDrop = e.ecl.itemDrop;
    if (itemDrop === -1 || itemDrop === 0xffff) {
      if (this.randomSpawnIndex % 3 === 0) {
        game.spawnEffectParticles(e.ecl.deathAnm2 + 4, e.x, e.y, 6, 0xffffffff);
        const type = RANDOM_ITEMS[this.randomItemIndex++ % RANDOM_ITEMS.length];
        game.spawnItem(type, e.x, e.y);
      }
      this.randomSpawnIndex++;
      return;
    }
    if (itemDrop === -2 || itemDrop === 0xfffe) return;
    game.spawnEffectParticles(e.ecl.deathAnm2 + 4, e.x, e.y, 3, 0xffffffff);
    const type = ITEM_TABLE[itemDrop];
    if (type) game.spawnItem(type, e.x, e.y);
  }

}
