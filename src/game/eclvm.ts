import { Ecl, type EclInstr, type TimelineEvent } from '../formats/ecl';
import { Anm, AnmRunner } from '../formats/anm';
import { Std } from '../formats/std';
import { Msg } from '../formats/msg';
import { normalizeAngle, clamp, TAU } from '../core/util';
import type { GameHost, Enemy, EclState, EclContext, BulletProps, BulletExSlot, ItemType, EnemyLaser } from './types';

// TH07 ECL virtual machine. Opcode semantics were derived by aligning thtk's
// th07 signature table against the TH06 instruction set (implemented in the
// TH06 Web runtime this project is based on), then validated instruction by
// instruction against the thecl disassembly of the original stage scripts.
// Approximations and open questions are marked with `TH07-TODO`.

// Th07.exe bullet pool is 0x400 = 1024 slots (FUN_00421e90 / FUN_00423480 both
// gate on `< 0x400`; audit-bullet-motion.md D4). Was 640 (an empirical probe
// ceiling), which starved the densest Lunatic patterns ~384 bullets early.
const ENEMY_BULLET_CAP = 1024;

// Resolve a fired bullet's ex-behaviors from the enemy's op-79 slots, exactly
// mirroring the exe's per-frame queue processor FUN_004229f0 @ 0x4229f0 (but
// collapsed to one pass at spawn). Each frame the exe advances one slot: it
// STOPS at the first opcode==0 slot, STOPS at a cond==0 slot once any behavior
// is already active (the cond gate), otherwise activates the slot iff its
// opcode bit is in the fire flags. Because the behavior-flag set only grows,
// a single pass yields the same activation set. The cond gate is why Letty's
// accel slot (cond 0, after speed-ramp) never activates in the real game.
// Sentinels: accel angle f1<=-990 -> keep bullet angle (DAT_0048eba4);
// dir/bounce speed f1/f0<=-999 -> keep bullet speed (DAT_0048eba0).
function resolveExBehaviors(
  slots: (BulletExSlot | null)[],
  fireFlags: number,
  spawnAngle: number,
  spawnSpeed: number
): Pick<import('./types').EnemyBullet, 'exFlags' | 'exAccel' | 'exAngle' | 'exDir' | 'exBounce'> {
  let exFlags = 0;
  let exAccel: { mag: number; angle: number; limit: number } | null = null;
  let exAngle: { speedDelta: number; angleDelta: number; limit: number } | null = null;
  let exDir: { angle: number; newSpeed: number; interval: number; maxTimes: number } | null = null;
  let exBounce: { speed: number; maxTimes: number } | null = null;
  for (let idx = 0; idx < 5; idx++) {
    const slot = slots[idx];
    if (!slot || slot.opcode === 0) break; // end of queue (exe: pfVar1[4]==0 -> return)
    if (slot.cond === 0 && exFlags !== 0) break; // cond gate (exe: cond==0 && flags!=0 -> return)
    if ((fireFlags & slot.opcode) === 0) continue; // opcode not enabled by this FIRE
    exFlags |= slot.opcode;
    switch (slot.opcode) {
      case 0x10:
        exAccel = { mag: slot.f0, angle: slot.f1 <= -990 ? spawnAngle : slot.f1, limit: slot.arg3 };
        break;
      case 0x20:
        exAngle = { speedDelta: slot.f0, angleDelta: slot.f1, limit: slot.arg3 };
        break;
      case 0x40:
      case 0x80:
      case 0x100:
        exDir = { angle: slot.f0, newSpeed: slot.f1 <= -999 ? spawnSpeed : slot.f1, interval: slot.arg3, maxTimes: slot.arg4 };
        break;
      case 0x400:
      case 0x800:
        exBounce = { speed: slot.f0 <= -999 ? spawnSpeed : slot.f0, maxTimes: slot.arg3 };
        break;
      // opcode 1 (speed-ramp): flag only, no params
    }
  }
  return { exFlags, exAccel, exAngle, exDir, exBounce };
}

// Item ids as used by ECL drop fields, confirmed against Th07.exe (v1.00b)
// collection switch FUN_00430c10 @ 0x430c10 (case 0..7 award behavior): the
// ECL id is passed unchanged as the spawn type -- there is no lookup table.
// 0 power, 1 point, 2 bigPower, 3 bomb, 4 fullPower, 5 life/1up, 6 cherry,
// 7 bigCherry.
const ITEM_TABLE: (ItemType | null)[] = [
  'power', 'point', 'bigPower', 'bomb', 'fullPower', 'life', 'cherry', 'bigCherry'
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
// variables live in EclState.vars. Th07.exe: 10000-10015 are FIXED per-enemy
// struct fields (shared across sub calls); 10029+ are window-relative params
// (the +8 CALL shift aliases caller args with callee params). See varRead.
const VAR_BASE = 10000;


const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[eclvm] ${message}`);
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
  private randomItemIndex = 0;
  private randomSpawnIndex = 0;
  bossSlots: (Enemy | null)[] = [];
  // Th07.exe DAT_00495bf4: true while any boss entity is registered.
  private bossRegistered = false;

  constructor(stage: StageData, anms: { etama: Anm; enemy: Anm; effect: Anm }) {
    this.ecl = new Ecl(stage.ecl);
    this.std = new Std(stage.std);
    this.msg = new Msg(stage.msg);
    this.enemyAnm = anms.enemy;
    this.bulletAnm = anms.etama;
    this.effectAnm = anms.effect;
  }

  reset(): void {
    this.timelineCursors = this.ecl.timelines.map(() => ({ index: 0, frame: 0 }));
    this.randomItemIndex = 0;
    this.randomSpawnIndex = 0;
    this.bossSlots = [];
    this.bossRegistered = false;
    this.std.reset();
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
    if (!game.timeStopped) this.std.advance();
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
      if (!held && !game.isDialogueBlocking?.()) cursor.frame++;
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
        // Spawn enemy. op bit 1 = mirrored (as in TH06's even/odd pairs).
        // TH07-TODO: semantics of bit 2 (ops 4/6) unverified; treated as plain.
        let { x = 0, y = 0, z = 0 } = evt;
        if (x <= -990) x = game.rng.range(384);
        if (y <= -990) y = game.rng.range(448);
        if (z <= -990) z = game.rng.range(800);
        this.spawnEclEnemy(game, {
          subId: evt.arg0,
          x, y, z,
          life: evt.life ?? -1,
          item: evt.item ?? -1,
          score: evt.score ?? -1,
          mirrored: (evt.op & 2) !== 0
        });
        return null;
      }
      case 8:
        game.startDialogue?.(evt.arg0);
        return null;
      case 9:
        if (game.consumeDialogueResume?.()) return null;
        return game.isDialogueBlocking?.() ? 'hold' : null;
      case 10: {
        const boss = this.bossSlots[evt.i0 ?? 0];
        if (this.isEnemyActive(game, boss)) boss!.ecl.runInterrupt = evt.i1 ?? 0;
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

  spawnEclEnemy(game: GameHost, opts: { subId: number; x: number; y: number; z?: number; life?: number; item?: number; score?: number; mirrored?: boolean; parent?: Enemy | null }): Enemy {
    const { subId, x, y, z = 0, life = -1, item = -1, score = -1, mirrored = false, parent = null } = opts;
    const hasLife = life >= 0;
    const hasScore = score >= 0;
    const e: Enemy = {
      id: game.id++,
      x, y, z,
      hp: hasLife ? life | 0 : 1,
      maxHp: hasLife ? life | 0 : 1,
      pendingShotDmg: 0,
      pendingBombDmg: 0,
      score: hasScore ? score | 0 : 100,
      frame: 0,
      ecl: this.makeEnemyState(subId, mirrored, item, parent)
    };
    game.enemies.push(e);
    // Apply the timeline life/score BEFORE the initial ECL run so a t=0
    // op110 (set HP) is not clobbered by the spawn-event life afterwards.
    // Bosses ship with life=1 as a placeholder; their real HP comes from
    // op110 inside the entry sub. The old post-run overwrite reset every
    // stage-4+ multi-slot boss back to 1 and let the first player shot
    // fire its death-callback (op99(-1)) on frame 1.
    if (hasLife) e.hp = e.maxHp = life | 0;
    if (hasScore) e.score = score | 0;
    this.runEcl(game, e);
    if (!hasLife) e.maxHp = Math.max(1, e.hp);
    else e.maxHp = Math.max(e.maxHp, e.hp);
    return e;
  }

  private makeEnemyState(subId: number, mirrored: boolean, itemDrop: number, parent: Enemy | null): EclState {
    return {
      ctx: { subId, index: 0, time: 0, windowBase: parent ? parent.ecl.ctx.windowBase : 0 },
      stack: [],
      subId,
      mirrored,
      itemDrop,
      vars: parent ? parent.ecl.vars.slice() : new Float64Array(160),
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
      periodicSub: null,
      pendingSub: -1,
      hitbox2: null,
      moveMode: 0,
      interpKind: 0,
      interp: null,
      orbitAngle: 0,
      orbitAngularVelocity: 0,
      orbitSpeed: 0,
      orbitAcceleration: 0,
      orbitTarget: { x: 0, y: 0, z: 0 },
      orbitDuration: 0,
      orbitLeft: 0,
      activeTimer: Infinity,
      bulletProps: null,
      bulletSfx: -1,
      bulletExSlots: [null, null, null, null, null],
      shootDisabled: false,
      shootInterval: 0,
      shootTimer: 0,
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
      frameVx: 0,
      frameVy: 0,
      anmRotateWithAngle: false,
      bossLifeCount: 0,
      lasers: [],
      laserStore: 0,
      interrupts: [],
      runInterrupt: -1,
      disableCallStack: false,
      invisible: false,
      spellTimeoutFlag: false,
      spellCardActive: false,
      bulletRankSpeedLow: -0.5,
      bulletRankSpeedHigh: 0.5,
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
      damageShield: 0
    };
  }



  // ---- variables -----------------------------------------------------------

  // Variable model derived from the stage data's dataflow: variables live in
  // a per-enemy array indexed through a register window that shifts by +8 on
  // every sub call (Sub48 writes 10041/10037 → called Sub49 reads them as
  // 10033/10029). Enemies spawned by another enemy inherit a copy of the
  // parent's array and window base, which is how bosses hand pattern
  // parameters (angle/rotation/speed) to child emitters. Engine-state
  // specials (10016-10027) resolve on the raw id regardless of the window.

  private varRead(game: GameHost, e: Enemy, id: number): number {
    const s = e.ecl;
    switch (id) {
      case 10016: return game.difficulty;
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
      case 10024: return Math.atan2(e.y - game.player.y, e.x - game.player.x);
      // Th07.exe FUN_0040d750/FUN_0040df90: 10025 = bossTimer (+0x2bcc),
      // 10026 = player-enemy 3D distance (FUN_00403d50). Previously swapped.
      case 10025: return s.bossTimer;
      case 10026: return Math.hypot(game.player.x - e.x, game.player.y - e.y, -e.z);
      case 10027: return e.hp;
      // Th07.exe exposes the enemy's LIVE movement state through the var system
      // (FUN_0040df90 value-resolver, audit-letty-phases.md §0). The engine
      // keeps these in named fields, so alias the var ids to them — otherwise
      // ECL that reads/writes them via vars (Letty 二非 sub41, 终符 sub57) hits a
      // dead slot and the pattern degrades (orbs collapse to the boss, rings
      // fire at a fixed angle instead of swirling with the orbit).
      case 10045: return Math.atan2(s.frameVy, s.frameVx); // +0x2b54 heading = atan2 of this frame's move delta
      case 10046: return s.angularVelocity;                // +0x2b58 mode-1
      case 10047: return s.speed;                           // +0x2b64 mode-1
      case 10048: return s.acceleration;                    // +0x2b68 mode-1
      case 10049: return s.orbitSpeed;                      // +0x2b6c mode-3 orbit
      case 10053: return s.orbitAngle;                      // +0x2b5c mode-3 orbit
      case 10054: return s.orbitAngularVelocity;            // +0x2b60 mode-3 orbit
    }
    // Th07.exe: vars 10000-10015 are FIXED per-enemy struct fields
    // (enemy+0x6fc..0x738) shared across every sub call on this enemy — NOT
    // shifted by the call window. Only the param/arg range (10029+) is
    // window-relative (the +8 CALL shift aliases a caller's var10037/10041
    // with a callee's var10029/10033). Windowing the locals too broke
    // cross-sub locals: e.g. the 终符 controller (sub 55) sets var10007
    // (the per-snowflake angular-velocity increment) and the spawner (sub 56)
    // reads it — with windowing sub 56 read a fresh per-call slot (0) instead,
    // so all snowflakes shared one angular velocity and clumped into a single
    // point instead of fanning into the spell's flower.
    const rel = id - VAR_BASE;
    const slot = rel <= 15 ? rel : s.ctx.windowBase + rel;
    if (slot >= 0 && slot < s.vars.length) return s.vars[slot];
    return id;
  }

  private varWrite(game: GameHost, e: Enemy, id: number, value: number): void {
    const s = e.ecl;
    switch (id) {
      // Th07.exe FUN_0040dda0: position (10018-10020) and distance (10026) are
      // read-only through the var system; bossTimer write is 10025, hp is 10027.
      case 10025: s.bossTimer = value; return;
      case 10027: e.hp = value; return;
      // Movement-state vars (see varRead): writable ones alias to the named
      // movement fields so ECL writes reach the integrator.
      case 10046: s.angularVelocity = value; return;
      case 10047: s.speed = value; return;
      case 10048: s.acceleration = value; return;
      case 10049: s.orbitSpeed = value; return;
      case 10053: s.orbitAngle = value; return;
      case 10054: s.orbitAngularVelocity = value; return;
    }
    const rel = id - VAR_BASE;
    const slot = rel <= 15 ? rel : s.ctx.windowBase + rel;
    if (slot >= 0 && slot < s.vars.length) {
      s.vars[slot] = value;
      return;
    }
    warnOnce(`w${id}`, `write to out-of-range variable ${id} (base ${s.ctx.windowBase})`);
  }

  private getInt(game: GameHost, e: Enemy, off: number): number {
    const raw = this.ecl.view.i32(off);
    if (raw >= VAR_BASE && raw < VAR_BASE + 100) return Math.trunc(this.varRead(game, e, raw));
    return raw;
  }

  private getShort(game: GameHost, e: Enemy, off: number): number {
    const raw = this.ecl.view.i16(off);
    if (raw >= VAR_BASE && raw < VAR_BASE + 100) return Math.trunc(this.varRead(game, e, raw));
    return raw;
  }

  private getFloat(game: GameHost, e: Enemy, off: number): number {
    const value = this.ecl.view.f32(off);
    const asInt = Math.trunc(value);
    if (Math.abs(value - asInt) < 0.00001 && asInt >= VAR_BASE && asInt < VAR_BASE + 100) {
      return Number(this.varRead(game, e, asInt));
    }
    return value;
  }

  // ---- per-frame enemy processing -----------------------------------------

  updateEnemy(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    const prevX = e.x;
    const prevY = e.y;
    // op 45 SetActiveTimer (exe +0x76c, FUN_00436a06): while active, both the
    // ECL timeline's own time-cursor advance and movement modes 1/2/3 run;
    // mode 0's axisSpeed lives outside that gate (spec §2). The decrement is
    // the gated block's own first statement, so it uses the pre-decrement
    // value for this frame's gate.
    const active = s.activeTimer > 0;
    if (active) s.activeTimer--;
    // op-142 damage shield counts down once per frame while armed (exe
    // FUN_00436a06(1) on the +0x4f38 struct, all.c:14440).
    if (s.damageShield > 0) s.damageShield--;
    this.applyMovement(e, active);
    s.frameVx = e.x - prevX;
    s.frameVy = e.y - prevY;
    this.checkCallbacks(game, e);
    // Exe frame preamble (all.c:7055-7104, 7266-7324), in order: drain the
    // op145 pending-sub request, run the op122 armed effect, tick the op27
    // interp slots, then the op144 periodic gosub — all before this frame's
    // bytecode dispatch.
    if (s.pendingSub >= 0) {
      const sub = s.pendingSub;
      s.pendingSub = -1;
      s.stack.length = 0;
      this.enterSub(s, sub);
    }
    if (s.effectArm) this.runBulletEffect(game, e, s.effectArm.id, this.getInt(game, e, s.effectArm.paramOff));
    this.tickInterpSlots(game, e);
    if (s.periodicSub && s.periodicSub.subId >= 0) {
      if (++s.periodicSub.elapsed >= s.periodicSub.period) {
        s.periodicSub.elapsed = 0;
        // Nested gosub: return resumes the interrupted flow (the exe also
        // snapshots/restores the FIRE template around it — approximated by
        // the plain call stack).
        s.stack.push({ ...s.ctx });
        this.enterSub(s, s.periodicSub.subId);
      }
    }
    if (active) this.runEcl(game, e);
    this.updateAutoShoot(game, e);
    if (s.isBoss && !game.timeStopped) s.bossTimer++;
    this.updateAnmPose(e);
    s.anmRunner?.update();
    for (const slot of s.anmSlots) slot?.runner?.update();
  }

  private applyMovement(e: Enemy, active = true): void {
    const s = e.ecl;
    if (!active) {
      // op45's timer ran out: modes 1/2/3 freeze in place; mode 0's axisSpeed
      // integration is outside the exe's `if (0<+0x76c)` gate and keeps running.
      if (s.moveMode === 0) {
        e.x += s.mirrored ? -s.axisSpeed.x : s.axisSpeed.x;
        e.y += s.axisSpeed.y;
        e.z += s.axisSpeed.z;
      }
      if (s.shouldClamp) {
        e.x = clamp(e.x, s.lowerMoveLimit.x, s.upperMoveLimit.x);
        e.y = clamp(e.y, s.lowerMoveLimit.y, s.upperMoveLimit.y);
      }
      return;
    }
    if (s.moveMode === 2 && s.interp) {
      const m = s.interp;
      const elapsed = m.duration - m.left;
      let t = clamp(elapsed / Math.max(1, m.duration), 0, 1);
      if (s.interpKind === 1) t = 1 - (1 - t) * (1 - t);
      else if (s.interpKind === 2) t = 1 - (1 - t) ** 4;
      else if (s.interpKind === 3) t = t * t;
      else if (s.interpKind === 4) t = t ** 4;
      e.x = m.start.x + m.delta.x * t;
      e.y = m.start.y + m.delta.y * t;
      e.z = m.start.z + m.delta.z * t;
      m.left--;
      if (m.left <= 0) {
        e.x = m.start.x + m.delta.x;
        e.y = m.start.y + m.delta.y;
        e.z = m.start.z + m.delta.z;
        s.moveMode = 0;
        s.interp = null;
      }
    } else if (s.moveMode === 3) {
      // orbit around a (possibly moving) target: exe FUN_0040f6c0 case bVar8==3
      // computes a polar offset in a scratch temp, then derives this frame's
      // velocity as (temp+target)-pos so FUN_0041d050's unconditional integrator
      // lands exactly on target+polar(angle,speed) — see spec §3 Group B / §5.3.
      s.orbitAngle = normalizeAngle(s.orbitAngle + s.orbitAngularVelocity);
      s.orbitSpeed += s.orbitAcceleration;
      const vx = (Math.cos(s.orbitAngle) * s.orbitSpeed + s.orbitTarget.x) - e.x;
      const vy = (Math.sin(s.orbitAngle) * s.orbitSpeed + s.orbitTarget.y) - e.y;
      e.x += s.mirrored ? -vx : vx;
      e.y += vy;
      if (s.orbitDuration > 0 && --s.orbitLeft < 1) s.moveMode = 0;
    } else if (s.moveMode === 1) {
      const vx = Math.cos(s.angle) * s.speed;
      const vy = Math.sin(s.angle) * s.speed;
      e.x += s.mirrored ? -vx : vx;
      e.y += vy;
      s.angle = normalizeAngle(s.angle + s.angularVelocity);
      s.speed += s.acceleration;
    } else {
      e.x += s.mirrored ? -s.axisSpeed.x : s.axisSpeed.x;
      e.y += s.axisSpeed.y;
      e.z += s.axisSpeed.z;
    }
    if (s.shouldClamp) {
      e.x = clamp(e.x, s.lowerMoveLimit.x, s.upperMoveLimit.x);
      e.y = clamp(e.y, s.lowerMoveLimit.y, s.upperMoveLimit.y);
    }
  }

  // Boss phase callbacks, matching the original engine's behavior: the timer
  // callback target is re-chained to the death callback whenever a callback
  // fires, life callbacks fire on hp < threshold (strict) and clamp hp up.
  private checkCallbacks(game: GameHost, e: Enemy): void {
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
        return;
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
      // Timing out voids the spell capture unless the ECL flagged otherwise.
      if (s.spellName && !s.spellTimeoutFlag) game.voidSpellCapture?.();
      // Exe timer-callback path (all.c:13820-13840, gated on the same
      // +0x2e2a bit6 flag): cherry -25% penalty — fires on nonspell
      // timeouts as well, not just spell cards.
      if (!s.spellTimeoutFlag) game.onBossPhaseTimeout?.();
      this.phaseTransition(game, e, sub);
      return;
    }
  }

  private phaseTransition(game: GameHost, e: Enemy, sub: number): void {
    const s = e.ecl;
    s.bulletRankSpeedLow = -0.5;
    s.bulletRankSpeedHigh = 0.5;
    s.bulletRankAmount1Low = 0;
    s.bulletRankAmount1High = 0;
    s.bulletRankAmount2Low = 0;
    s.bulletRankAmount2High = 0;
    s.stack.length = 0;
    s.ctx.windowBase = 0;
    if (s.isBoss) this.clearNonBossEnemies(game, e);
    this.enterSub(s, sub);
  }

  private enterSub(s: EclState, subId: number, windowShift = 0): void {
    s.ctx = { subId, index: 0, time: 0, windowBase: Math.max(0, s.ctx.windowBase + windowShift) };
  }

  // op27 per-frame tick (exe all.c:7271-7324 + FUN_0040ecd0/FUN_0040ed30):
  // modes 0-6 = 2-point LERP of f0..f1, mode 7 = cubic Hermite with f2/f3
  // as start/end tangents; ease curves per spec-op27-effects.md §1.3. The
  // final-frame write still happens before the slot frees.
  private tickInterpSlots(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    for (let i = 0; i < s.interpSlots.length; i++) {
      const slot = s.interpSlots[i];
      if (!slot) continue;
      slot.elapsed++;
      const done = slot.elapsed >= slot.duration;
      let t = done ? 1 : slot.elapsed / Math.max(1, slot.duration);
      switch (slot.ease) {
        case 1: t = t * t; break;
        case 2: t = t * t * t; break;
        case 3: t = t * t * t * t; break;
        case 4: t = 1 - (1 - t) * (1 - t); break;
        case 5: t = 1 - (1 - t) ** 3; break;
        case 6: t = 1 - (1 - t) ** 4; break;
      }
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
      if (done) s.interpSlots[i] = null;
    }
  }

  // op27 writes go through the exe's FLOAT write path (FUN_0040e560),
  // which CAN write own-position (unlike the int path our varWrite
  // models). Position writes also update the heading like the exe's
  // delta-capture does (all.c:7304-7324, simplified to a direct write per
  // the spec's port guidance).
  private interpWrite(game: GameHost, e: Enemy, id: number, value: number): void {
    switch (id) {
      case 10018: e.x = value; return;
      case 10019: e.y = value; return;
      case 10020: e.z = value; return;
      case 10045: e.ecl.angle = value; return;
      default: this.varWrite(game, e, id, value);
    }
  }

  // op121/122 bullet-effect table (exe 24 entries @ 0x495148). Gameplay-
  // relevant ids are implemented; decorative particle ids are no-ops (safe
  // per spec-op27-effects.md §2.2 port guidance). id 3 is a true no-op in
  // the exe.
  private runBulletEffect(game: GameHost, e: Enemy, id: number, param: number): void {
    switch (id) {
      case 0: { // attach to tracked enemy: copy its position onto self
        const t = this.bossSlots[param];
        if (t) { e.x = t.x; e.y = t.y; e.z = t.z; e.ecl.angle = t.ecl.angle; }
        return;
      }
      case 5: { // copy orbit params from the tracked enemy
        const t = this.bossSlots[param];
        if (t) {
          e.ecl.orbitTarget = { ...t.ecl.orbitTarget };
          e.ecl.orbitSpeed = t.ecl.orbitSpeed;
          e.ecl.orbitAngularVelocity = t.ecl.orbitAngularVelocity;
        }
        return;
      }
      case 10: { // enter bullet-time: slow all live bullets by 1/param
        const f = param > 0 ? 1 / param : 1;
        if (this.bulletTimeScale === 1 && f !== 1) {
          for (const b of game.enemyBullets) { b.vx *= f; b.vy *= f; b.speed *= f; }
          this.bulletTimeScale = f;
        }
        return;
      }
      case 11: { // exit bullet-time
        if (this.bulletTimeScale !== 1) {
          const f = 1 / this.bulletTimeScale;
          for (const b of game.enemyBullets) { b.vx *= f; b.vy *= f; b.speed *= f; }
          this.bulletTimeScale = 1;
        }
        return;
      }
      case 20: game.playBgmTrack?.('th07_13b'); return; // Yuyuko phase-2 cue
      case 3: return; // exe stub
      default: return; // decorative particle/telegraph effects — no-op
    }
  }

  private bulletTimeScale = 1;

  private updateAutoShoot(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    // Exe auto-shoot tick (all.c:7194-7208) fires purely on interval>0 &&
    // hp>0 — it does NOT consult the op75/76 bit (that bit only suppresses
    // the immediate fire inside FIRE ops 64-72). Checking shootDisabled here
    // silenced every op75-then-op73 pattern.
    if (!s.shootInterval || !s.bulletProps) return;
    s.shootTimer++;
    if (s.shootTimer >= s.shootInterval) {
      s.shootTimer = 0;
      this.spawnBullets(game, e, s.bulletProps);
    }
  }

  setCurrentAnm(e: Enemy, script: number): void {
    const s = e.ecl;
    if (script < 0 || s.currentAnm === script) return;
    s.currentAnm = script;
    s.anmRunner = this.enemyAnm.hasScript(script) ? new AnmRunner(this.enemyAnm, script) : null;
  }

  private updateAnmPose(e: Enemy): void {
    const s = e.ecl;
    if (s.anmExLeft < 0) return;
    const vx = Math.abs(s.frameVx) < 0.0001 ? 0 : s.frameVx;
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

  private runEcl(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    for (let guard = 0; guard < 512; guard++) {
      if (s.runInterrupt >= 0) {
        const sub = s.interrupts[s.runInterrupt];
        s.runInterrupt = -1;
        if (sub != null && sub >= 0) {
          const instrs = this.ecl.sub(s.ctx.subId);
          const next = instrs[s.ctx.index];
          if (!s.disableCallStack && next) {
            s.stack.push({ ...s.ctx });
          }
          this.enterSub(s, sub);
        }
      }
      const ctx = s.ctx;
      const instrs = this.ecl.sub(ctx.subId);
      const instr = instrs[ctx.index];
      if (!instr) return;
      if (ctx.time !== instr.time) break;
      if (instr.rankMask & (1 << game.difficulty)) {
        const prevExecuting = this.executingEnemy;
        this.executingEnemy = e;
        const action = this.execute(game, e, instr);
        this.executingEnemy = prevExecuting;
        if (action === 'delete') {
          e.dead = true;
          return;
        }
        if (action === 'flow') continue;
      }
      ctx.index++;
    }
    s.ctx.time++;
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

  private execute(game: GameHost, e: Enemy, instr: EclInstr): 'delete' | 'flow' | null {
    const s = e.ecl;
    const ctx = s.ctx;
    const v = this.ecl.view;
    const a = instr.args;
    const op = instr.id;
    const gi = (o: number) => this.getInt(game, e, a + o);
    const gf = (o: number) => this.getFloat(game, e, a + o);
    const gs = (o: number) => this.getShort(game, e, a + o);
    const setVar = (id: number, val: number) => this.varWrite(game, e, id, val);

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
        setVar(varId, left);
        if (left <= 0) return null;
        this.jumpTo(s, v.i32(a + 4), v.i32(a));
        return 'flow';
      }
      case 4: setVar(v.i32(a), gi(4)); return null;
      case 5: setVar(Math.trunc(v.f32(a)), gf(4)); return null;
      case 6: setVar(v.i32(a), game.rng.u32InRange(Math.max(1, gi(4)))); return null;
      case 7: setVar(v.i32(a), game.rng.u32InRange(Math.max(1, gi(4))) + gi(8)); return null;
      case 8: setVar(Math.trunc(v.f32(a)), game.rng.range(gf(4))); return null;
      case 9: setVar(Math.trunc(v.f32(a)), game.rng.range(gf(4)) + gf(8)); return null;
      // Op 10 (exe case 9 @ all.c:7486-7503): dest = ±src with a random
      // sign (FUN_0042ff30 bit0 → +1 / -1). paramMask bit1 selects
      // var-resolved src (standard gf path). Used by stage-3 Alice dolls.
      case 10: {
        const sign = (game.rng.u32() & 1) === 0 ? -1 : 1;
        setVar(Math.trunc(v.f32(a)), sign * gf(4));
        return null;
      }
      case 11: // TH07-TODO: single use in stage 1; treated as float assignment
        setVar(Math.trunc(v.f32(a)), gf(4));
        return null;
      case 12: case 13: case 14: case 15: case 16: { // int math
        const lhs = gi(4);
        const rhs = gi(8);
        const r = op === 12 ? lhs + rhs : op === 13 ? lhs - rhs : op === 14 ? lhs * rhs
          : op === 15 ? (rhs ? lhs / rhs : 0) : (rhs ? lhs % rhs : 0);
        setVar(v.i32(a), Math.trunc(r));
        return null;
      }
      case 17: setVar(v.i32(a), Math.trunc(this.varRead(game, e, v.i32(a))) + 1); return null;
      case 18: setVar(v.i32(a), Math.trunc(this.varRead(game, e, v.i32(a))) - 1); return null;
      case 19: case 20: case 21: case 22: case 23: { // float math
        const lhs = gf(4);
        const rhs = gf(8);
        const r = op === 19 ? lhs + rhs : op === 20 ? lhs - rhs : op === 21 ? lhs * rhs
          : op === 22 ? (rhs ? lhs / rhs : 0) : (rhs ? lhs % rhs : 0);
        setVar(Math.trunc(v.f32(a)), r);
        return null;
      }
      case 24: setVar(Math.trunc(v.f32(a)), Math.sin(gf(4))); return null;
      case 25: setVar(Math.trunc(v.f32(a)), Math.cos(gf(4))); return null;
      case 26: setVar(Math.trunc(v.f32(a)), Math.atan2(gf(16) - gf(8), gf(12) - gf(4))); return null;
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
        this.varWrite(game, e, destId, value);
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
      case 40: s.angle = gf(0); s.moveMode = 1; return null;
      case 41: { // call sub (register window shifts by +8)
        if (!s.disableCallStack) s.stack.push({ ...ctx, index: ctx.index + 1 });
        this.enterSub(s, v.i32(a), 8);
        return 'flow';
      }
      case 42: { // return
        const ret = s.stack.pop();
        if (ret) s.ctx = ret;
        return 'flow';
      }
      case 45: // SetActiveTimer(nFrames): exe +0x76c, case 0x2c -- see updateEnemy's
        // `active` gate / spec §2. Two stage-1 uses (Letty's snowflake-orb
        // helpers, Sub35/36), arg = the int var10029 (a random int in [100,120)).
        // Resolve the var like op154 does, not the raw id (audit-letty-phases.md D4).
        s.activeTimer = Math.trunc(this.varRead(game, e, v.i32(a)));
        return null;
      case 46: e.x = gf(0); e.y = gf(4); e.z = gf(8); return null;
      case 47: { // velocity by angle/speed (+ z speed)
        const angle = gf(0);
        const speed = gf(4);
        s.axisSpeed = { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed, z: gf(8) };
        s.moveMode = 0;
        return null;
      }
      case 48: s.angularVelocity = gf(0); s.moveMode = 1; return null;
      case 49: s.speed = gf(0); s.moveMode = 1; return null;
      case 50: s.acceleration = gf(0); s.moveMode = 1; return null;
      case 52: { // random float in [min, max) into var
        const min = gf(4);
        const max = gf(8);
        setVar(Math.trunc(v.f32(a)), game.rng.range(max - min) + min);
        return null;
      }
      case 54: { // timed move by angle/speed: (duration, mode, angle, speed)
        const duration = v.i32(a);
        const mode = v.i32(a + 4);
        const angle = gf(8);
        const speed = gf(12);
        if (duration <= 0) {
          s.angle = angle;
          s.speed = speed;
          s.acceleration = 0;
          s.angularVelocity = 0;
          s.moveMode = 1;
        } else {
          s.interp = {
            start: { x: e.x, y: e.y, z: e.z },
            delta: { x: Math.cos(angle) * speed * duration / 2, y: Math.sin(angle) * speed * duration / 2, z: 0 },
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
        const duration = v.i32(a);
        const mode = v.i32(a + 4);
        const tx = gf(8);
        const ty = gf(12);
        const tz = gf(16);
        if (duration <= 0) {
          e.x = tx;
          e.y = ty;
          e.z = tz;
        } else {
          s.interp = {
            start: { x: e.x, y: e.y, z: e.z },
            delta: { x: tx - e.x, y: ty - e.y, z: tz - e.z },
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
        s.orbitDuration = v.i32(a);
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
      case 59: // StartTimedMove(duration) (exe case 0x3a): re-arms the
        // currently-configured movement mode's countdown. Our movement
        // modes run continuously, so re-triggering the orbit/move window
        // is the closest equivalent.
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
        // f1=arg6. Slots persist and all activate at FIRE via the cond gate.
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
        const angleRaw = gf(4);
        const x = e.x + s.shootOffset.x;
        const y = e.y + s.shootOffset.y;
        const angle = op === 83 ? angleRaw + Math.atan2(game.player.y - y, game.player.x - x) : angleRaw;
        const laser: EnemyLaser = {
          id: game.id++,
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
        if (l) l.angle = normalizeAngle(l.angle + gf(4));
        return null;
      }
      case 86: { // AIM_LASER_AT_PLAYER + offset (absolute set; retail-unused)
        const l = s.laserSlots[gi(0)];
        if (l) l.angle = Math.atan2(game.player.y - l.y, game.player.x - l.x) + gf(4);
        return null;
      }
      case 87: { // REPOSITION_LASER: re-base to the enemy's CURRENT pos + offset
        const l = s.laserSlots[gi(0)];
        if (l) { l.x = e.x + gf(4); l.y = e.y + gf(8); }
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
      case 81: { // bullet fire SFX (id, unknown)
        const sfx = v.i32(a);
        s.bulletSfx = sfx;
        if (s.bulletProps) {
          s.bulletProps.sfx = sfx;
          if (sfx >= 0) s.bulletProps.flags |= 0x200;
          else s.bulletProps.flags &= ~0x200;
        }
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
        s.spellCardActive = true; // Th07.exe DAT_012f40a8 = 1 (all.c:6520)
        game.startBossSpell?.(spellId, v.i16(a), s.spellName);
        // The declare handler cancels the field's bullets into cherry items
        // with NO score sweep (all.c:6511 = FUN_00422ea0(1)); the scored
        // 2000+20i sweep belongs to spell END / boss death only.
        game.cancelBulletsToItems();
        return null;
      }
      case 91: {
        s.spellName = '';
        s.spellCardActive = false; // Th07.exe DAT_012f40a8 = 0 (all.c:6692)
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
        this.spawnEclEnemy(game, {
          subId: v.i32(a),
          x: e.x + gf(4), y: e.y + gf(8), z: e.z + gf(12),
          life: v.i32(a + 16),
          item: v.i32(a + 20),
          score: v.i32(a + 24),
          mirrored: false,
          parent: e
        });
        return null;
      }
      case 92: { // Th07.exe case 0x5b: op92 spawns at ABSOLUTE position (op93 = relative)
        this.spawnEclEnemy(game, {
          subId: v.i32(a),
          x: gf(4), y: gf(8), z: gf(12),
          life: v.i32(a + 16),
          item: v.i32(a + 20),
          score: v.i32(a + 24),
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
            runner: this.enemyAnm.hasScript(script) ? new AnmRunner(this.enemyAnm, script) : null
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
        // Th07.exe DAT_00495bf4: true while ANY boss slot is occupied.
        // setBossPresent prefers slot 0 (main) so helper registration does
        // not steal the UI/damageBoss pointer from the primary boss, and
        // so a helper's later release cannot blank the marker while the
        // main boss still lives (stage-4 Prismriver-style multi-slot).
        this.syncBossPresence(game);
        return null;
      }
      case 100: // boss aura effect: (colorId, x, y, z, distance) — approximated
        game.spawnEffectParticles(16, e.x + gf(4), e.y + gf(8), 1, 0xffffffff);
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
      case 106: s.deathMode = v.i32(a); return null; // TH07-TODO verify
      case 107: s.deathCallbackSub = v.i32(a); return null;
      case 108: s.interrupts[v.i32(a + 4)] = v.i32(a); return null;
      case 109: s.runInterrupt = v.i32(a); return null;
      case 110: e.hp = e.maxHp = v.i32(a); return null;
      case 111: s.bossTimer = v.i32(a); return null;
      case 112: s.lifeThresholds[0].threshold = v.i32(a); return null;
      case 113: s.lifeThresholds[0].sub = v.i32(a); return null;
      case 114:
        s.timerCallbackThreshold = v.i32(a);
        // Th07.exe case 0x71: arming a timer threshold also zeroes the timer.
        s.bossTimer = 0;
        return null;
      case 115: s.timerCallbackSub = v.i32(a); return null;
      case 116: s.interactable = !!v.i32(a); return null;
      case 117: game.spawnEffectParticles(v.i32(a), e.x, e.y, v.i32(a + 4), v.u32(a + 8) >>> 0); return null;
      case 118: game.spawnEffectParticles(v.i32(a), e.x + gf(12), e.y + gf(16), v.i32(a + 4), v.u32(a + 8) >>> 0); return null;
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
        const type = ITEM_TABLE[v.i32(a)];
        if (type) game.spawnItem(type, e.x, e.y);
        return null;
      }
      case 125: game.unpauseStd(); return null;
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
      case 132: s.invisible = !!v.i32(a); return null;
      case 133:
        s.timerCallbackSub = s.deathCallbackSub;
        s.bossTimer = 0;
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
      // Op 138 (exe case 0x89, thtk format SSSS): NOT laser-related --
      // writes enemy-local homing/tracking-shot parameter fields
      // (+0x4f30/32/34/36), a separate RE topic ("homing funcs[1]").
      // Op 139 (exe case 0x8a, thtk format SSSC): writes a GLOBAL per-ID
      // effect/behavior parameter table (DAT_00495c24/c04/c44) -- not
      // per-enemy, not per-laser. Both stubbed pending their own RE pass;
      // stage 1 never calls the real laser ops (82-89/134)
      // (exe-enemy-lasers.md §0).
      case 138: case 139:
        game.configureAmbience?.(op, [v.i32(a), v.i32(a + 4), v.i32(a + 8), v.i32(a + 12)]);
        return null;
      // Op 140 (exe case 0x8b, thtk format ffff): genuine ambience config --
      // 4 global float args (palette/fade animation; matches
      // stage1-ecl-dump.txt's Letty-fight AMBIENCE_CONFIG(140) calls). The
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
      case 142: s.damageShield = v.i32(a); return null;
      case 143: { // CancelBulletsInRadius (exe case 0x8e = FUN_00423360):
        // deletes bullets within radius of the enemy, each spawning a
        // small cherry item (FUN_00430970 type 6, mode 1).
        const radius = gf(0);
        const bullets = game.enemyBullets;
        let w = 0;
        for (const b of bullets) {
          const dx = b.x - e.x;
          const dy = b.y - e.y;
          if (dx * dx + dy * dy <= radius * radius) {
            game.spawnItem('cherry', b.x, b.y, { state: 1 });
          } else {
            bullets[w++] = b;
          }
        }
        bullets.length = w;
        return null;
      }
      case 144: { // ArmPeriodicSub(period, subId) (exe case 0x8f): every
        // `period` frames, nested gosub subId; -1 disarms. NOT death-tied.
        const period = gi(0);
        const subId = v.i32(a + 4);
        s.periodicSub = subId < 0 ? null : { period: Math.max(1, period), subId, elapsed: 0 };
        return null;
      }
      case 145: { // SendSubToTrackedEnemy(idx, subId) (exe case 0x90):
        // remote-command a tracked enemy to gosub subId next frame.
        const target = this.bossSlots[gi(0)];
        if (target) target.ecl.pendingSub = v.i32(a + 4);
        return null;
      }
      case 146: // CancelAllBullets (exe case 0x91 = FUN_00422ea0(0)):
        // plain state-5 fade, NO items; non-immune lasers reset too.
        game.enemyBullets.length = 0;
        game.cancelLasers?.(false);
        return null;
      case 148: { // Th07.exe FUN_0040f6c0 case 0x93: HP-threshold callback slot
        const slot = Math.max(0, Math.min(3, v.i32(a)));
        s.lifeThresholds[slot] = { threshold: v.i32(a + 4), sub: v.i32(a + 8) };
        return null;
      }
      case 149: case 150: // 149 = attached-laser origin follow/detach (the
        // +0x2eb0 boss-laser object — not modeled); 150 = write to enemy+8
        // (unidentified, 1 use). Store-and-ignore per spec.
        return null;
      case 151: { // PolarToXY (exe case 0x96): arg1-var = cos(angle)*mag,
        // arg0-var = sin(angle)*mag (angle arg2, magnitude arg3).
        const angle = gf(8);
        const mag = gf(12);
        this.varWrite(game, e, Math.trunc(v.f32(a + 4)), Math.cos(angle) * mag);
        this.varWrite(game, e, Math.trunc(v.f32(a)), Math.sin(angle) * mag);
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
    // `if (DAT_012f40a8 == 0)` — i.e. SKIPPED while a boss spell card is active.
    // During a spell the raw ECL count/speed args are used verbatim
    // (audit-fire-aimmode.md D1).
    if (s.spellCardActive) {
      return {
        sprite: this.getShort(game, e, a),
        offset: this.getShort(game, e, a + 2),
        count1: this.getInt(game, e, a + 4),
        count2: this.getInt(game, e, a + 8),
        speed1,
        speed2,
        angle1: normalizeAngle(this.getFloat(game, e, a + 20)),
        angle2: this.getFloat(game, e, a + 24),
        flags: this.ecl.view.i32(a + 28) | (s.bulletSfx >= 0 ? 0x200 : 0),
        sfx: s.bulletSfx,
        exSlots: s.bulletExSlots.slice(),
        aimMode
      };
    }
    const rankSpeed = game.rank * (s.bulletRankSpeedHigh - s.bulletRankSpeedLow) / 32 + s.bulletRankSpeedLow;
    const add1 = Math.trunc(game.rank * (s.bulletRankAmount1High - s.bulletRankAmount1Low) / 32 + s.bulletRankAmount1Low);
    const add2 = Math.trunc(game.rank * (s.bulletRankAmount2High - s.bulletRankAmount2Low) / 32 + s.bulletRankAmount2Low);
    return {
      sprite: this.getShort(game, e, a),
      offset: this.getShort(game, e, a + 2),
      count1: Math.max(1, this.getInt(game, e, a + 4) + add1),
      count2: Math.max(1, this.getInt(game, e, a + 8) + add2),
      speed1: speed1 ? Math.max(0.3, speed1 + rankSpeed) : 0,
      speed2: Math.max(0.3, speed2 + rankSpeed / 2),
      angle1: normalizeAngle(this.getFloat(game, e, a + 20)),
      angle2: this.getFloat(game, e, a + 24),
      flags: this.ecl.view.i32(a + 28) | (s.bulletSfx >= 0 ? 0x200 : 0),
      sfx: s.bulletSfx,
      exSlots: s.bulletExSlots.slice(),
      aimMode
    };
  }

  // Bullet type scripts live in etama.anm entry 0 (on-disk ids 0-24, the
  // etama.png sheet). Entries 1-3 (etama2-4) reuse overlapping on-disk script
  // ids (0-37 / 0 / 0) for item/big-bullet animations, so the flat scriptRef
  // map resolves every bullet id to the wrong sheet (last entry wins) — the
  // multi-entry id-collision rule of AGENTS.md §6. TH07-TODO: later stages
  // fire big-bullet types whose scripts live in etama2/3/4; those need a
  // type→entry mapping here instead of the fixed entry 0.
  private badBulletWarned = new Set<string>();

  bulletRect(sprite: number, offset: number): { x: number; y: number; w: number; h: number; imageKey: string } {
    try {
      return this.bulletRectInEntry0(sprite, offset);
    } catch (err) {
      // Degrade to the plain pellet instead of throwing: an uncaught throw
      // here escapes StageRuntime.update and halts the rAF loop (frozen
      // game). Warn once per combo so bad data stays visible in dev.
      const key = `${sprite}:${offset}`;
      if (!this.badBulletWarned.has(key)) {
        this.badBulletWarned.add(key);
        console.warn(`bulletRect: fallback for script ${sprite} offset ${offset}: ${err}`);
      }
      return this.bulletRectInEntry0(0, 0);
    }
  }

  private bulletRectInEntry0(sprite: number, offset: number): { x: number; y: number; w: number; h: number; imageKey: string } {
    const ref = this.bulletAnm.scriptRefInEntry(0, sprite);
    const runner = new AnmRunner(this.bulletAnm, sprite, { spriteIndexOffset: offset, entryIndex: 0 });
    const frame = runner.spriteFrame();
    if (!frame) throw new Error(`missing bullet ANM frame for script ${sprite} offset ${offset}`);
    return { x: frame.x, y: frame.y, w: frame.w, h: frame.h, imageKey: frame.imageKey || ref.imageKey || 'etama' };
  }

  spawnBullets(game: GameHost, e: Enemy, p: BulletProps, origin: { x: number; y: number } | null = null): void {
    const shootX = origin?.x ?? e.x + e.ecl.shootOffset.x;
    const shootY = origin?.y ?? e.y + e.ecl.shootOffset.y;
    const aim = Math.atan2(game.player.y - shootY, game.player.x - shootX);
    for (let j = 0; j < p.count2; j++) {
      const speed = p.speed1 - (p.speed1 - p.speed2) * j / p.count2;
      for (let i = 0; i < p.count1; i++) {
        if (game.enemyBullets.length >= ENEMY_BULLET_CAP) return;
        let angle = 0;
        if (p.aimMode <= 1) {
          angle = ((p.count1 & 1) ? Math.floor((i + 1) / 2) : Math.floor(i / 2) + 0.5) * p.angle2;
          if (i & 1) angle *= -1;
          if (p.aimMode === 0) angle += aim;
          angle += p.angle1;
        } else if (p.aimMode === 2 || p.aimMode === 3) {
          if (p.aimMode === 2) angle += aim;
          angle += i * TAU / p.count1 + j * p.angle2 + p.angle1;
        } else if (p.aimMode === 4 || p.aimMode === 5) {
          if (p.aimMode === 4) angle += aim;
          angle += Math.PI / p.count1 + i * TAU / p.count1 + p.angle1;
        } else if (p.aimMode === 6) {
          angle = game.rng.range(p.angle1 - p.angle2) + p.angle2;
        } else if (p.aimMode === 7) {
          angle = i * TAU / p.count1 + j * p.angle2 + p.angle1;
        } else {
          angle = game.rng.range(p.angle1 - p.angle2) + p.angle2;
        }
        angle = normalizeAngle(angle);
        const spd = p.aimMode === 7 || p.aimMode === 8 ? game.rng.range(p.speed1 - p.speed2) + p.speed2 : speed;
        const rect = this.bulletRect(p.sprite, p.offset);
        const flags = p.flags | 0;
        // Spawn-in effect: bullets ease in at reduced speed while flashing.
        const spawnDuration = flags & 2 ? 8 : flags & 4 ? 11 : flags & 8 ? 14 : 0;
        const spawnMoveScale = flags & 2 ? 1 / 2 : flags & 4 ? 1 / 2.5 : flags & 8 ? 1 / 3 : 1;
        const ex = resolveExBehaviors(p.exSlots, flags, angle, spd);
        game.enemyBullets.push({
          id: game.id++,
          x: shootX,
          y: shootY,
          vx: Math.cos(angle) * spd,
          vy: Math.sin(angle) * spd,
          speed: spd,
          angle,
          age: 0,
          flags,
          sprite: p.sprite,
          spriteOffset: p.offset,
          rect,
          grazeW: BULLET_HITBOX_BY_SPRITE[p.sprite] ?? Math.max(3, rect.w * 0.4),
          grazeH: BULLET_HITBOX_BY_SPRITE[p.sprite] ?? Math.max(3, rect.h * 0.4),
          grazed: false,
          spawnDuration,
          spawnMoveScale,
          exFlags: ex.exFlags,
          exAccel: ex.exAccel,
          exAngle: ex.exAngle,
          exDir: ex.exDir,
          exBounce: ex.exBounce
        });
      }
    }
    if (p.flags & 0x200 && p.sfx >= 0) game.playSfx(p.sfx);
  }

  // Clears trash mobs; each cleared enemy still runs its death callback (so
  // item-drop subs execute), matching the original.
  private clearNonBossEnemy(game: GameHost, enemy: Enemy, sweepItems: boolean): void {
    enemy.hp = 0;
    const s = enemy.ecl;
    if (sweepItems && s.sweepItemFlag) game.spawnItem('cherry', enemy.x, enemy.y, { state: 1 });
    if (s.deathCallbackSub >= 0) {
      const sub = s.deathCallbackSub;
      s.deathCallbackSub = -1;
      s.stack.length = 0;
      s.ctx.windowBase = 0;
      this.enterSub(s, sub);
    } else {
      enemy.dead = true;
    }
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
      const drops = sweepItems && enemy.ecl.sweepItemFlag;
      this.clearNonBossEnemy(game, enemy, sweepItems);
      if (drops) {
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

  // Must be called whenever an enemy is removed from the game for any reason,
  // so boss slots and presence flags don't go stale.
  releaseEnemy(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    if (s.bossSlot != null && this.bossSlots[s.bossSlot] === e) {
      this.bossSlots[s.bossSlot] = null;
    }
    // Only clear presence if no other slot still holds a live boss — a
    // helper in slot 1/2/3 dying must not blank the main boss in slot 0.
    if (s.isBoss) this.syncBossPresence(game);
  }

  killEnemy(game: GameHost, e: Enemy): boolean {
    const s = e.ecl;
    const usesNormalDeath = s.interactable && !s.invisible;
    if (!usesNormalDeath) {
      if (s.deathCallbackSub >= 0) {
        const sub = s.deathCallbackSub;
        s.deathCallbackSub = -1;
        s.stack.length = 0;
        s.ctx.windowBase = 0;
        this.enterSub(s, sub);
        return true;
      }
      return false;
    }
    if (s.deathCallbackSub >= 0) {
      // Boss phase / spell end: the big explosion SE. TH07-TODO: the exact
      // per-phase sound is not exe-verified; se_enep01 matches the audible
      // original boss-phase boom.
      game.playSfx(18);
      game.spawnEnemyDeathEffect?.(e);
      e.hp = 1;
      // Damage off the instant the death callback starts, or shots landing
      // during the transition/death animation would re-trigger death with no
      // callback left and hard-remove the enemy mid-sequence (Letty's Sub51
      // would lose its ins_91 wipe). Matches the original: bosses are
      // invulnerable between phases, and every live phase re-arms damage
      // itself via ins_103(1) (Sub38/39/42/48...).
      s.canTakeDamage = false;
      for (let i = 0; i < 4; i++) s.lifeThresholds[i] = { threshold: -1, sub: -1 };
      s.timerCallbackThreshold = -1;
      s.stack.length = 0;
      s.ctx.windowBase = 0;
      const sub = s.deathCallbackSub;
      s.deathCallbackSub = -1;
      this.enterSub(s, sub);
      return true;
    }
    game.addScore(e.score || 0);
    if (s.isBoss && s.bossSlot != null && this.bossSlots[s.bossSlot] === e) this.bossSlots[s.bossSlot] = null;
    if (s.isBoss) this.syncBossPresence(game);
    // Op 105 is an IMMEDIATE PlaySE (see its case above) -- the exe stores
    // no per-enemy value for automatic replay at death, so a scripted
    // death-callback sub's own op105 call already played its SE when that
    // sub ran. This is the fallback for the no-death-callback path only:
    // Exe death SE (disasm @ 0x420379): slot 2 + (counter & 1) — plain
    // kills alternate se_enep00's two volume slots (-1200/-1500 mB).
    game.playSfx(2 + (e.id & 1));
    game.spawnEnemyDeathEffect?.(e);
    for (const drop of this.dropTypes(s.itemDrop)) {
      game.spawnItem(drop, e.x, e.y);
    }
    if (s.isBoss) {
      if (!s.spellCardActive) {
        // Boss real death outside a spell (all.c:14343, gated on
        // DAT_012f40a8 == 0): the scored field sweep — bullets to cherry
        // items (2000/+20 popups) then flagged helpers (2000/+30), score
        // += total/10. A spell final phase instead sweeps at its op91.
        let total = game.sweepBulletsToItems();
        total = this.killNonBossEnemies(game, e, total);
        if (total > 0) game.addScore(Math.trunc(total / 10));
      } else {
        // Shouldn't happen (spells end via op91 before the death path),
        // kept as a safety net so no bullets leak past a boss kill.
        game.enemyBullets.length = 0;
      }
    }
    return false;
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

  private dropTypes(itemDrop: number): ItemType[] {
    if (itemDrop === -1 || itemDrop === 0xffff) {
      const out: ItemType[] = [];
      if (this.randomSpawnIndex++ % 3 === 0) out.push(RANDOM_ITEMS[this.randomItemIndex++ % RANDOM_ITEMS.length]);
      return out;
    }
    if (itemDrop === -2 || itemDrop === 0xfffe) return [];
    const type = ITEM_TABLE[itemDrop];
    return type ? [type] : [];
  }

}
