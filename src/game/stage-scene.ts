import { advanceBulletExBehavior, StageRuntime, type StageData } from './eclvm';
import type { GameHost, Enemy, EnemyBullet, EnemyLaser, ItemEntity, ItemType, EffectParticle } from './types';
import { Rng } from '../core/rng';
import {
  normalizeAngle, normalizeNativeAngleF32, clamp, NATIVE_HALF_PI_F32
} from '../core/util';
import type { InputFrame } from '../core/input';
import { Renderer, PLAYFIELD, SCREEN_W } from '../gfx/renderer';
import type { GameAssets } from './assets';
import { Anm, AnmRunner, type AnmFrame } from '../formats/anm';
import { TH07_DATA } from '../data/th07-data';
import type { AudioBus } from '../audio/audio';
import {
  CHARACTERS, Player, bombCherryDrainPerFrame, playerShotAllocationAllowed,
  type CharacterId, type PlayerBullet
} from './player';
import { PlayerEffects } from './player-effects';
import { CherrySystem, BORDER_DURATION, CHERRY_PLUS_MAX } from './cherry';
import { BombEngine, BombRunner, type AttackSlot, type BombContext } from './player-bombs';
import { DialogueRunner, portraitSprite } from './dialogue';
import { stageBgmTrack } from './bgm';

// Stage host. Runs any of the 8 stage timelines (1-6 main game, 7 Extra,
// 8 Phantasm) with per-stage ECL/STD/MSG/ANM data resolved from TH07_DATA.

// Everything that survives a stage transition within one credit.
export interface RunCarry {
  score: number;
  hiScore: number;
  graze: number;
  pointItems: number;
  lives: number;
  bombs: number;
  power: number;
  cherry: number;
  cherryMax: number;
  cherryPlus: number;
  spellsCaptured: number;
  extendLevel: number;
  rank: number;
  rankAccumulator?: number;
}

// Item sprites live in etama.anm entry 1 (the etama2.png sheet), addressed
// here by their entry-embedded ids; add entries[1].spriteBase (168 — entry 0
// embeds ids 0..167) for the global id. The 16x16 boxed items sit in a row at
// texture y=64 (crop-verified: red P, blue 点, big red P, green B, yellow F,
// magenta 1up, grey star, pink petal box), matching the original item order.
const ITEM_SPRITES: Record<ItemType, number> = {
  power: 4,
  point: 5,
  bigPower: 6,
  bomb: 7,
  fullPower: 8,
  life: 9,
  cherry: 10, // type 6: grey cancel-item box (FUN_00421a40 writes type 6)
  bigCherry: 11, // type 7: boxed pink petal
  pointBullet: 12, // type 8: unboxed petal used by the Border-break circle
  case9Cherry: 13 // type 9: pink petal; shares type 7's authored sprite rect
};
// Per-type offscreen indicator arrows sit 10 embedded ids after their item
// (emb14-21, same order) — drawn while an item is still above the top edge.
const ITEM_ARROW_OFFSET = 10;
// exe-exact RNG draw cost (raw u16) per particle for the ambient effect types
// ECL op117/118 spawn, = the DAT_00494fb0 spawnVetoFn's draw count (binary-read
// confirmed; the paired perFrameGateFns draw ZERO). Only the effectIds stage 1
// actually uses are listed; id22's real cost branches only on the authored
// random-angle sentinel (handled at the call site). Effect draws share the
// gameplay RNG stream, so
// these counts are load-bearing for bullet/fire alignment, not cosmetic.
// Total per-particle raw-u16 costs combine two original paths:
//   1. the effect table's DAT_00494fb0 spawnVetoFn (file offset 0x933b0), and
//   2. the authored effect ANM's time-0 op59/op60 executed synchronously by
//      FUN_004486e0 during allocation.
// Ignoring (2) undercounted ambient families shared by stages 2-6 even when
// the veto function itself was modeled exactly.
const EFFECT_DRAW_COST: Record<number, number> = {
  // Th07.exe v1.00b effect table + etama.anm entry-scoped scripts.
  0: 0, 1: 0, 2: 0,
  3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 4, 11: 4,
  // Effect 12 (g_EffectMapping[12] = {0x2bb, NULL, NULL}) has no callbacks
  // and its ANM script contains no random ops: zero draws. The four raw
  // u16s observed on the death frame are Die()'s RegenerateGameIntegrityCsum,
  // not this effect (see onPlayerHit).
  12: 0, 13: 0, 14: 0, 15: 0,
  17: 6, 18: 6, 20: 22, 22: 6, 23: 0,
  26: 14, 27: 12, 29: 6, 30: 16, 31: 16, 32: 6, 33: 6
};
const ENEMY_POOL_CAP = 0x1e0;
const PLAYER_BULLET_POOL_CAP = 0x60;
const ENEMY_BULLET_POOL_CAP = 0x400;
const BOMB_CLEAR_REGION_CAP = 0x60;
const ITEM_POOL_CAP = 0x44c;
const EFFECT_POOL_CAP = 400;
// Th07.exe v1.00b _DAT_0048eb98 (file value 0x38d1b717), used by
// FUN_00423910 @ 0x4239e4/0x423a05 before recomputing an accel heading.
const NATIVE_VELOCITY_EPSILON_F32 = 9.999999747378752e-5;
// DAT_00494fb0 maps the small effect id to a master ANM script. These are
// the authored removal times of the corresponding etama scripts; Infinity
// denotes an interrupt/gate-owned persistent VM. The optional per-frame
// callbacks can still release a slot earlier (notably id20 below).
const EFFECT_SCRIPT_LIFE: Record<number, number> = {
  0: 20, 1: 20, 2: 40, 3: 40,
  4: 30, 5: 30, 6: 30, 7: 30, 8: 30, 9: 30, 10: 30, 11: 30,
  12: 40, 13: Infinity, 14: Infinity, 15: Infinity,
  17: 60, 18: 240, 19: 120, 20: 300, 21: 40, 22: 90,
  24: Infinity, 26: 300, 27: 300, 29: 30, 30: 300, 31: 300,
  32: 90, 33: 120
};
const CLEAR_LOADING_ANM = ['loading', 'loading2', 'loading3'] as const;

// SE slot table, Th07.exe @ 0x494a78 (38 entries × 8 bytes: {i32 wavIndex,
// i16 volume_millibels, i16 priority}), read from the exe binary. Sound ids
// in ECL data / SHT records / engine code index THIS table, not the 30-wav
// filename list @ 0x494ba8 — several slots share a wav at different
// volumes (e.g. 2/3 = se_enep00 at −1200/−1500 mB; enemy deaths alternate
// them, disasm @ 0x420379). Init loop @ 0x4468xx duplicates the source
// buffer per slot and calls IDirectSoundBuffer::SetVolume(mB) (vtable
// +0x3c), so amp = 10^(mB/2000). Playing a slot restarts its duplicated
// buffer — one voice per slot.
const SFX_SLOTS: [string, number][] = [
  ['se_plst00', 0.1], ['se_plst00', 0.056], ['se_enep00', 0.251], ['se_enep00', 0.178],
  ['se_pldead00', 0.316], ['se_power0', 0.631], ['se_power1', 0.631], ['se_tan00', 0.178],
  ['se_tan01', 0.141], ['se_tan02', 0.112], ['se_ok00', 0.316], ['se_cancel00', 0.316],
  ['se_select00', 0.141], ['se_gun00', 0.251], ['se_cat00', 0.355], ['se_tan00', 0.178],
  ['se_lazer00', 0.355], ['se_lazer01', 0.355], ['se_enep01', 0.355], ['se_nep00', 0.794],
  ['se_damage00', 0.2], ['se_item00', 0.224], ['se_tan00', 0.891], ['se_tan01', 0.126],
  ['se_tan02', 0.126], ['se_kira00', 0.398], ['se_kira01', 0.316], ['se_kira02', 0.224],
  ['se_extend', 0.708], ['se_timeout', 0.355], ['se_graze', 0.355], ['se_powerup', 0.562],
  ['se_border', 0.708], ['se_bonus', 0.708], ['se_graze', 0.708], ['se_kira00', 1],
  ['se_bonus2', 0.708], ['se_pause', 0.708]
];

// front.png sprite rects [x,y,w,h], recovered from front.anm's entry0 sprite
// table (see the HUD spec derived by thanm -l7 disassembly). The original
// HUD blits these directly rather than typesetting text, so we do the same.
const FRONT = {
  logo: [128, 0, 128, 256], // 東方妖々夢 vertical logo panel
  caption: [0, 0, 128, 80], // "Perfect Cherry Blossom"
  hiscore: [0, 80, 64, 16],
  score: [0, 96, 64, 16],
  player: [0, 112, 64, 16],
  bomb: [0, 128, 64, 16],
  power: [0, 144, 64, 16],
  graze: [0, 160, 64, 16],
  point: [0, 176, 64, 16],
  redStar: [64, 80, 16, 16], // life icon
  blueStar: [80, 80, 16, 16], // bomb icon
  tile32: [0, 224, 32, 32], // maroon frame-fill tile
  strip128: [0, 240, 128, 16] // maroon frame-fill strip
} as const;

// ascii.png HUD numeral font: 8x12 digit glyphs in a row at texture y=208,
// digit d at x=8*d (front.anm/ascii.anm spec §5.1). The sole HUD digit font.
const DIGIT_W = 8;
const DIGIT_H = 12;
const DIGIT_Y = 208;

interface ScorePopup {
  digits: number[];
  color: number;
  x: number;
  y: number;
  timer: number;
  timerFrac: number;
  active: boolean;
}

interface StageTransitionTile {
  runner: AnmRunner;
  row: number;
  column: number;
  delay: number;
  x: number;
  y: number;
  sourceX: number;
  sourceY: number;
}

const makeScorePopup = (): ScorePopup => ({
  digits: [0], color: 0, x: 0, y: 0, timer: 0, timerFrac: 0, active: false
});

// Per-quad cap on subdivided cells for perspective-correct-enough texture
// mapping (see drawBackground); not a shared budget — stage 1 only has ~31
// ground instances and 18 tree quads per tree instance, so every visible
// quad is drawn in full every frame with plenty of headroom to spare.
const BG_MAX_CELL_STEPS = 24;

// MarisaA missile explosion table, Th07.exe FUN_00439d80 switch on the
// bullet's script id (0x441-0x448 = script 65-72): [hitbox full width,
// burst speed]. Constants read as raw floats from the exe .rdata.
const MISSILE_EXPLOSION: Record<number, [number, number]> = {
  65: [32, 4], 66: [42, 4], 67: [48, 4], 68: [56, 4],
  69: [48, 6], 70: [64, 6], 71: [80, 6], 72: [96, 6]
};

// Th07.exe spell-card base-bonus table @ 0x4951a8, int32[141] (one entry
// per spell id 0-140), read directly from the binary — see
// spec-extra-phantasm.md §6c. Stage ranges: 0-9 s1, 10-25 s2, 26-43 s3,
// 44-67 s4, 68-87 s5, 88-115 s6 (112-115 = the secret 反魂蝶 set),
// 116-127 Extra, 128-140 Phantasm.
const SPELL_BONUS_BASE = [
  2000000, 2000000, 2200000, 2200000, 2400000, 2400000, 2400000, 2400000, 2400000, 2400000,
  2600000, 2600000, 2600000, 2600000, 2600000, 2600000, 2600000, 2600000, 2600000, 2600000,
  2600000, 2600000, 2600000, 2600000, 2600000, 2600000,
  3000000, 3000000, 3000000, 3000000, 3000000, 3000000, 3000000, 3000000, 3000000, 3000000,
  3000000, 3000000, 3000000, 3000000, 3000000, 3000000, 3000000, 3000000,
  3500000, 3500000, 3500000, 3500000, 3500000, 3500000, 3500000, 3500000, 3500000, 3500000,
  3500000, 3500000, 3500000, 3500000, 3500000, 3500000, 3500000, 3500000, 3500000, 3500000,
  3500000, 3500000, 3500000, 3500000,
  4000000, 4000000, 4000000, 4000000, 4000000, 4000000, 4000000, 4000000, 4000000, 4000000,
  4000000, 4000000, 4000000, 4000000, 4000000, 4000000, 4000000, 4000000, 4000000, 4000000,
  5000000, 5000000, 5000000, 5000000, 5000000, 5000000, 5000000, 5000000, 5000000, 5000000,
  5000000, 5000000, 5000000, 5000000, 5000000, 5000000, 5000000, 5000000, 5000000, 5000000,
  5000000, 5000000, 5000000, 5000000,
  3000000, 3000000, 3000000, 3000000,
  6000000, 6000000,
  7000000, 7000000, 7000000, 7000000, 7000000, 7000000, 7000000, 7000000,
  4000000,
  7000000, 7000000, 7000000,
  8000000, 8000000, 8000000, 8000000, 8000000, 8000000, 8000000, 8000000,
  4000000,
  8000000,
  4000000
];

// Boss ownership tables (UI-001), decoded from the original per-stage ECL
// (op90/op99 phase families BFS'd over HP/death/interrupt callbacks), MSG
// op8 boss-intro text and a pixel read of ename.png — recon
// ui-owner-table.md. Two independent consumers:
//
// 1. Spell cutin portrait: global face-ANM sprite id per spellId range. The
//    12/12 empirical rule across every dialogue-bearing encounter is "the
//    boss's dialogue opens on face 0 of her own entry"; the table stores
//    that entry-0 global id per encounter. Stage-4 sisters resolve
//    per-sister (Lunasa 0 / Merlin 4 / Lyrica 8 — order triangulated from
//    the MSG intro listing + instrument spell themes, flagged INFERENCE);
//    the shared trio spells use Lunasa's sheet.
export function cutinFaceForSpell(spellId: number): number {
  const OWNERS: [first: number, last: number, face: number][] = [
    [0, 1, 3],      // Cirno midboss (ecldata1; existing decode)
    [2, 9, 0],      // Letty
    [10, 13, 0],    // Chen midboss
    [14, 25, 0],    // Chen
    [26, 27, 0],    // Alice midboss
    [28, 43, 0],    // Alice
    [44, 47, 0],    // Prismriver trio shared (Lunasa's sheet)
    [48, 51, 0],    // Lunasa
    [52, 55, 4],    // Merlin
    [56, 59, 8],    // Lyrica
    [60, 67, 0],    // ensemble spells (declared via Lunasa's family)
    [68, 71, 0],    // Youmu midboss
    [72, 87, 0],    // Youmu
    [88, 91, 0],    // Youmu stage-6 rematch (face_06_00 entry 0 = her sheet)
    [92, 115, 2],   // Yuyuko (face_06_00 entry 1 -> global 2)
    [116, 117, 0],  // Chen (Extra midboss)
    [118, 127, 4],  // Ran
    [128, 129, 0],  // Ran (Phantasm midboss)
    [130, 140, 2]   // Yukari
  ];
  for (const [first, last, face] of OWNERS) {
    if (spellId >= first && spellId <= last) return face;
  }
  return 0;
}

// 2. Nameplate row: ename.png's 16 rows are exactly
//    2*(stage-1) + (0 = early/mid encounter, 1 = final encounter) for all 8
//    stages (pixel-read). The switch is keyed off which boss ROOT SUB is
//    currently registered — NOT off "has any dialogue played" (stage 6 has
//    two dialogue-bearing encounters, so the old dialogueSeen latch flipped
//    to Yuyuko's row 11 during Youmu's own rematch).
const FINAL_ENCOUNTER_ROOTS: Record<number, number[]> = {
  1: [31],
  2: [48],
  3: [31],
  4: [42, 53, 71, 88, 108, 115, 118], // conductor + sisters + prop slots
  5: [47],
  6: [28],
  7: [67, 111],
  8: [69, 115]
};

export function enameRowForBoss(stageNumber: number, rootSub: number): number {
  const final = FINAL_ENCOUNTER_ROOTS[stageNumber]?.includes(rootSub) ? 1 : 0;
  return 2 * (stageNumber - 1) + final;
}

export class StageScene implements GameHost {
  rng = new Rng();
  difficulty = 1;
  // T7RP snapshots store the integer rank at +0x25. The live accumulator is
  // separate: FUN_0042db77/FUN_0042dbf3 add/subtract event points and cross
  // one integer rank per 100, clamped by the difficulty table @ 0x4955a8.
  // Direct Stage-1 watchpoints show 16 -> 17 on a graze and ->18 on the
  // processing-frame-1920 survival award; rank is not stage-constant.
  rank = 16;
  rankAccumulator = 0;
  private rankSurvivalTicks = 0;
  private rankSurvivalFraction = 0;
  private rankSurvivalAdvanced = false;
  // ECL var 10028 (Th07.exe DAT_00625627): character*2 + shotType.
  get shotIndex(): number {
    const c = this.playerObj.character;
    const family = c.startsWith('reimu') ? 0 : c.startsWith('marisa') ? 1 : 2;
    return family * 2 + (c.endsWith('B') ? 1 : 0);
  }
  // Global slow-motion rate (exe DAT_0056baa8; spec-slowmo.md). Bullet-effect
  // 10 sets 1/param, 11 restores 1.0; reset at stage init by construction.
  slowRate = 1;
  frame = 0;
  id = 1;
  player = { x: 192, y: 384 };
  enemies: Enemy[] = [];
  private readonly enemySlots: (Enemy | null)[] = new Array(ENEMY_POOL_CAP).fill(null);
  enemyBullets: EnemyBullet[] = [];
  private readonly enemyBulletSlots: (EnemyBullet | null)[] = new Array(ENEMY_BULLET_POOL_CAP).fill(null);
  // Th07.exe DAT_0099fa60 (bullet manager +0x37a128) is a manager-entry
  // census, not a continuously maintained live count. It intentionally
  // remains stale after this pass culls bullets, and next frame's enemy FIRE
  // uses that snapshot as FUN_00423480's whole-volley capacity gate.
  enemyBulletManagerEntryCount = 0;
  // Th07.exe bullet+0xbfe is NOT initialized by FUN_00421e90 and NOT cleared
  // by FUN_00416c90. It is stale storage owned by the fixed slot: a special
  // bullet that dies after 128 off-screen ticks can lend that value to the
  // next ordinary bullet allocated in the same slot, delaying its cull.
  private readonly enemyBulletOffscreenCounters = new Uint16Array(ENEMY_BULLET_POOL_CAP);
  enemyLasers: EnemyLaser[] = [];
  postBombLaserCounter = 0;
  items: ItemEntity[] = [];
  private itemSlots: (ItemEntity | null)[] = new Array(ITEM_POOL_CAP).fill(null);
  private itemPoolCursor = 0;
  particles: EffectParticle[] = [];
  private readonly effectSlots: (EffectParticle | null)[] = new Array(EFFECT_POOL_CAP).fill(null);
  private effectPoolCursor = 0;
  // GameHost's power view must be the live run-global player field. Keeping a
  // second numeric copy here made ECL op119 see zero after replay snapshots,
  // so its full-power branch emitted power drops that spawnItem then converted
  // to bigCherry instead of the exe's point items (Stage 3, frame 2096).
  get power(): number {
    return this.playerObj?.power ?? 0;
  }
  score = 0;
  focusHeld = false;
  runtime: StageRuntime;
  playerObj: Player;
  playerBullets: PlayerBullet[] = [];
  private readonly playerBulletSlots: (PlayerBullet | null)[] = new Array(PLAYER_BULLET_POOL_CAP).fill(null);
  graze = 0;
  pointItems = 0;
  // The run-global counters persist across stages, but FUN_00427269 captures
  // stage-clear Point/Graze as per-stage deltas. Replay snapshots restore the
  // cumulative totals, so retain the entry baselines separately.
  private stageEntryGraze = 0;
  private stageEntryPointItems = 0;
  // Point-item extend ladder (exe stats +0x2c level / +0x30 threshold,
  // all.c:19744/22099-22125): main game 50/125/200/300/450/800+200n;
  // Extra+Phantasm 200/500/800+500n. Persists across stages in a credit.
  extendLevel = 0;
  // Th07.exe DAT_012f40bc: latched to the spell-active state at each bomb
  // trigger — bomb damage during a spell card is 0 until a bomb has been
  // triggered during that spell (anti pre-bomb rule, disasm @ 0x41faeb).
  private bombDuringSpell = false;
  // Th07.exe FUN_00446970: the 5-slot SE queue drops a request whose id is
  // already queued this service cycle — net effect, any SE id plays at most
  // once per frame no matter how many requests (bug 2: se_damage00 spam).
  private sfxPlayedThisFrame = new Set<number>();
  // Th07.exe FUN_0041ebc0: enemy-body graze re-arms every 6 frames while touched.
  // One cached AnmRunner per stg1bg script id, stepped forward to the
  // current STD frame; shared by every quad instance that references it
  // (see drawBackground / bgAnmFrame).
  private bgAnmCache = new Map<number, { runner: AnmRunner; frame: number }>();
  // STD ops 29/30 own two standalone ANM VMs, separate from the per-quad
  // runners and from each other (Th07.exe FUN_004046f0 @ 0x40516d-0x4051e8).
  private specialBgAnmCache: ({ script: number; runner: AnmRunner; age: number } | null)[] = [null, null];
  gameOver = false;
  // Arcade end-of-game flow. 'test' keeps the pre-existing headless-probe
  // semantics (no freeze, no scene exit); 'arcade' is the real game: PCB's
  // continue screen (3 credits, score reset to the continue count) and a
  // return to the title after game over or the stage-clear tally.
  // 'practice' = the vanilla Practice Start flavor: one stage, 8 lives, no
  // continues, straight back to the title on clear or game over. 'replay'
  // likewise has no continues and returns to the replay selector; unlike
  // practice it keeps the ordinary HUD and all state comes from T7RP.
  mode: 'arcade' | 'practice' | 'replay' | 'test' = 'arcade';
  onExitToTitle: (() => void) | null = null;
  // Fired (arcade mode, stages 1-5) when the player advances past the
  // stage-clear tally; the host tears this scene down and starts stage+1
  // with carryState(). Null/unset → fall back to exitToTitle.
  onStageComplete: ((carry: RunCarry) => void) | null = null;
  continueScreen: { cursor: number } | null = null;
  continuesUsed = 0;
  // Config starting-lives (run-state byte DAT_0061c254+0x1c, replay header
  // +0x38). FUN_00429446 scales every stage-clear bonus by the "Player
  // Penalty" tier: 3 -> x0.5, 4 -> x0.2 (results text @ all.c:17114-17123).
  // Default config records 2; replays carry the recorder's value.
  startingLives = 2;
  private gameOverTimer = 0;
  // Post-respawn continuous silent field clear (exe player+0x2400, 60f).
  private respawnClearFrames = 0;
  // ESC pause. Menu rows: 0 再開, 1 タイトルに戻る, 2 最初からやり直す;
  // the destructive rows detour through the 本当に？ はい/いいえ confirm.
  // The in-exe trigger logic is not statically recoverable (recon NOT
  // FOUND); behavior follows the shipped pause.png assets + vanilla
  // convention — BGM keeps playing (PROBABLE).
  pauseState: {
    cursor: number;
    confirm: boolean;
    confirmCursor: number;
    closing: number;
    action: 'resume' | 'title' | 'retry' | null;
    runners: AnmRunner[];
  } | null = null;
  // Set by main.ts: restart the run from its beginning (story: stage 1;
  // practice: the practiced stage).
  onRetryRun?: () => void;
  stageClearTimer = 0;
  private exitFired = false;
  private stageCompleteFired = false;
  cherry: CherrySystem;
  hiScore = 100000;
  dialogue: DialogueRunner | null = null;
  private dialogueResume = false;
  stageFrame = 0;
  stageClear = false;
  // MSG op9 exposes the results tally and snapshots/credits its values well
  // before op11 actually leaves the stage. Keep presentation distinct from
  // the final stage-transition latch so the post-boss MSG can keep ticking.
  stageResultsActive = false;
  private stageResultsPending = false;
  private clearTimer = 0;
  clearLoadingRunner: AnmRunner | null = null;
  clearCaptureRunner: AnmRunner | null = null;
  clearLoadingKey: string | null = null;
  private clearCaptureArmed = false;
  stageTransitionTimer = 0;
  stageTransitionTiles: StageTransitionTile[] = [];
  private stageTransitionCaptureArmed = false;
  readonly stageNumber: number;
  private stageIntroRunners: AnmRunner[] = [];
  private readonly bgScripts = new Map<number, { anm: Anm; entryIndex: number; localId: number; spriteBase: number }>();
  private readonly enemyAnm: Anm;
  private readonly bgAnm: Anm;
  private readonly effectAnm: Anm;
  private readonly stdTxtAnm: Anm;
  private readonly faceAnm: Anm;
  // Stage-clear bonus tally, computed once when the stage ends.
  clearBonus: {
    clear: number; point: number; graze: number; cherry: number;
    player: number; bomb: number; mult: number; total: number;
  } | null = null;
  spellcard: {
    name: string;
    id: number;
    capturing: boolean;
    // Live decaying capture bonus, Th07.exe FUN_0040ee30 @ 0x40ee30:
    // base from the per-spell table @ 0x4951a8; decays by
    // base/(timerSeconds+10) per second while the capture is valid;
    // grazes add 2500 + floor(cherry/1500)*20 (FUN_0043bb30, all.c:27969).
    bonus: number;
    bonusBase: number;
    decayPerSec: number;
    grazeBonus: number;
    elapsed: number;
    elapsedFrac: number;
    declAge: number;
    portraitSprite: number;
  } | null = null;
  // Stage 5 owns two spell-background VMs from eff05.anm. Unlike the
  // simpler scrolling sheets, both receive bullet-time interrupt 2/1 from
  // FUN_00418020/FUN_00418130 and must remain real ANM runners so their
  // authored tint, additive blend, scale and rotation transitions survive.
  private spellBackgroundRunners: AnmRunner[] = [];
  private spellBanner = 0;
  // Spell-card capture popup (spec-ui-stageclear.md §4): label + value on
  // success only. Failure draws nothing (exe skips FUN_004264e3 entirely).
  private bonusPopup: { bonus: number; timer: number } | null = null;
  // Shared UI slot at game-state +0x209f0. Type 2 announces border start;
  // type 4 shows the natural-end reward. Th07.exe FUN_0042645b @ 0x42645b.
  borderMessage: { type: 2 | 4; value: number; age: number; timer: number } | null = null;
  // FUN_0043eb00 @ 0x43eb00 creates a fixed-center cancel circle on a
  // border break: radius 32, +16/frame, 50 subsequent ticks.
  borderClearWave: { x: number; y: number; radius: number; ticksLeft: number; createdFrame: number } | null = null;
  // Mirrors Th07.exe DAT_012f40a8's 1 -> 2 "phase failed by timeout" bump:
  // set by the timer-callback path, consumed by endBossSpell to skip the
  // scored field sweep, cleared by the next declare.
  private phaseTimedOut = false;
  bossActive: Enemy | null = null;
  bossLifeCount = 0;
  spellName = '';
  // Session-scoped per-spell attempt/capture tally for the "History n/m"
  // line of the declaration banner. The original persists this in
  // score.dat across runs — out of scope here (AGENTS.md §7).
  private spellHistory = new Map<number, { seen: number; got: number }>();
  // Test-only observability (PLAN.md Phase 0): the ReimuA homing target
  // chosen this frame (enemy id, null when none eligible) and the total HP
  // actually removed from enemies this frame after all damage reductions.
  // Read by the ?test=1 snapshot; gameplay never consults them.
  homingTargetId: number | null = null;
  private homingAim: { id: number; x: number; y: number; z: number } | null = null;
  private aimBossLocked = false;
  settledDamageThisFrame = 0;
  // DAT_004ca4d8 as observed by the whole scheduler pass. Player.update()
  // may consume timer=1 before enemies/items run, but the native bomb flag
  // remains set through that final pass and is cleared at the next player
  // callback.
  private bombActiveThisFrame = false;
  // When the local remaining timer reaches zero, native player+0x16a20 is
  // still set until the next player callback enters the form at
  // counter==duration. That cleanup callback performs one final Cherry drain
  // before clearing the flag, but publishes no attack slots.
  private bombCleanupPending = false;
  // True only on the one player tick after bombTimer reaches 0. Native keeps
  // player+0x16a20 set for that cleanup callback; border start must defer.
  private bombCleanupDefersBorder = false;
  playerShotSerial = 0;
  private observePlayerShotSerial = false;
  // Test-only per-pass draw costs in ms (PERF-001 breakdown); rebuilt each
  // draw() and read via the ?test=1 hook. Gameplay never consults it.
  drawPassCosts: Record<string, number> = {};
  private passT0 = 0;
  private measureDrawPasses = false;

  private markPass(label: string): void {
    if (!this.measureDrawPasses) return;
    const now = performance.now();
    this.drawPassCosts[label] = (this.drawPassCosts[label] ?? 0) + (now - this.passT0);
    this.passT0 = now;
  }
  private eff01Pattern: CanvasPattern | null = null;

  // Global sprite id of etama entry 1's embedded sprite 0 (the etama2.png
  // item sheet); see ITEM_SPRITES above.
  private readonly etamaItemBase: number;
  // Script-driven bomb visuals (see spawnBombEffects).
  private readonly playerEffects: PlayerEffects;
  // Reserved generic-effect slot used by the player option state machine.
  // Focus-in creates authored etama.anm effect 24; focus-out interrupts it.
  private focusEffectRunner: AnmRunner | null = null;
  private prevBombTimer = 0;
  // Moving bomb attack hitboxes (exe player+0x9dc pool; see player-bombs.ts).
  private readonly bombEngine = new BombEngine();
  private readonly activeBombSlots: AttackSlot[] = [];
  // Th07.exe bomb bullet-CLEAR regions (exe player+0x17dc pool, 96 circle slots,
  // allocated by FUN_0043e7e0/FUN_0043e730 and scanned by FUN_0043b040 during the
  // per-bullet graze/hit check — BEFORE the graze box). The spec mislabeled this
  // pool "cosmetic"; it is the bomb's bullet cancellation. ReimuA activation writes
  // a fixed-center expanding-circle blast (r = 32 + 8·age, 17 frames).
  private readonly bombClearRegions: {
    x: number; y: number; radius: number; growth: number; framesLeft: number
  }[] = Array.from({ length: BOMB_CLEAR_REGION_CAP }, () => ({
    x: 0, y: 0, radius: 0, growth: 0, framesLeft: 0
  }));
  // The active bomb form's decoded state machine (12 forms, player-bombs.ts).
  private bombRunner: BombRunner | null = null;
  private bombContext!: BombContext;
  // Latched bomb duration (frames) for end-window checks (ReimuA focused's
  // final-30-frames detonation, etc.).
  private bombDuration = 0;
  // Bomb-local frame counter (exe 16a38): 0 on the first active tick.
  private bombFrame = 0;
  // Player-wide hit tally (exe player+0x240c): beams/attack slots pop a
  // spark on every 8th (lasers) / 4th (bomb slots) accumulated hit.
  private playerHitTally = 0;
  // Compatibility gate used by focused tests which tick the shot manager
  // without enabling collisions.
  private shotCollisionEnabled = true;
  // FUN_0043a980 @ all.c:27626 rejects the whole 96-shot/112-attack scan
  // when player+0x16a08 equals its previous integer value at +0x16a00.
  // In the normal player state FUN_0043e2e0 snapshots current->previous,
  // then advances the shared split counter with DAT_0056baa8. Consequently
  // enemy collision runs only on integer-advance frames during slow motion
  // (native Stage 5: rate 1/3, processing 6774/6775 skip, 6776 scans).
  // State 3 invulnerability and state 4 Border countdown retreat the same
  // split pair through FUN_00436a06. At normal speed its fast path leaves
  // +0x16a00 at the -999 sentinel, so collision remains wall-clock active;
  // under slow motion the helper publishes current->previous and collision
  // runs only on integer-retreat frames (Stage 5 processing 11415/11418).
  private playerShotCollisionClockFrac = 0;
  private playerShotCollisionClockSpecial = false;
  private playerShotCollisionClockAdvanced = true;
  // Committed player hits with the striking entity's provenance — the primary
  // localization signal for replay-golden divergences (a replayed player only
  // dies where our simulation disagrees with the original). Ring-capped at 64.
  hitLog: Array<{
    frame: number;
    stageFrame: number;
    kind: 'bullet' | 'laser' | 'body';
    playerX: number;
    playerY: number;
    bullet: {
      ownerId: number;
      ownerSub: number;
      spawnFrame: number;
      sprite: number;
      spriteOffset: number;
      x: number;
      y: number;
      angle: number;
      speed: number;
      age: number;
    } | null;
  }> = [];
  // Diagnostic seam for replay AUX-0x02: geometric contact before the
  // invulnerability/deathbomb/Border outcome gate. Production leaves it
  // unset and gameplay never reads it.
  onPlayerContact?: (kind: 'bullet' | 'laser' | 'body') => void;
  // Floating number popups: two contiguous ring pools in the exe (720 large,
  // 3 small — the latter serves small cherry pickups). FUN_00401ad0 updates
  // all 723 slots: rise 0.5 px per rate-scaled frame and retire after 60.
  private popupsLarge: ScorePopup[] = Array.from({ length: 720 }, makeScorePopup);
  private popupsSmall: ScorePopup[] = Array.from({ length: 3 }, makeScorePopup);
  private popupCursorLarge = 0;
  private popupCursorSmall = 0;
  // Th07.exe bullet manager +0x37a160 / DAT_0099fa98: initialized to item
  // type 6, promoted to type 9 after Stage 6-8's pre-boss dialogue setup.
  // FUN_0042819f performs its initial field clear first and writes 9 only
  // afterward, so this must be mutable state rather than a stage constant.
  private cancelItemType: 'cherry' | 'case9Cherry' = 'cherry';
  constructor(
    private assets: GameAssets,
    private audio: AudioBus,
    difficulty = 1,
    character: CharacterId = 'reimuA',
    stageNumber = 1,
    carry: RunCarry | null = null,
    initialRngSeed?: number
  ) {
    // The native game loads every SE buffer before play. Web Audio otherwise
    // drops the first request while fetching it; se_pldead00 is normally used
    // only on the first miss, so without this preload that miss is silent.
    this.audio.preloadSfx(SFX_SLOTS.map(([file]) => file));
    if (initialRngSeed != null) this.rng.seed = initialRngSeed & 0xffff;
    this.difficulty = difficulty;
    this.stageNumber = stageNumber;
    const stageData = (TH07_DATA.stages as unknown as Record<number, StageData>)[stageNumber];
    if (!stageData) throw new Error(`no data for stage ${stageNumber}`);
    const anms = assets.anms as Record<string, Anm>;
    this.enemyAnm = anms[stageData.enemyAnm];
    this.bgAnm = anms[stageData.bgAnm];
    this.effectAnm = anms[stageData.effectAnm];
    this.stdTxtAnm = anms[stageData.stdTxtAnm];
    this.faceAnm = anms[stageData.faceAnm];
    // STD quad script indices are virtual ids over the stage's bg ANM
    // files: Th07.exe loads them via FUN_00447c50 at bases 0x300 + 16 per
    // file (stg4bg=0x300, stg4bg2=0x310 ... stg4bg5=0x340, all.c:2909-2943)
    // and registers each file's scripts sequentially, so
    // vid = fileIndex*16 + positionInFile (stage 4's STD really references
    // 32=stg4bg3, 48..52=stg4bg4, 64=stg4bg5; stage 6's second entry gets
    // positions 5..9 despite its duplicate stored ids).
    const bgFiles = [this.bgAnm, ...((stageData.extraBgAnms ?? []).map((n) => anms[n]))];
    bgFiles.forEach((anm, fi) => {
      let pos = 0;
      anm.entries.forEach((entry, entryIndex) => {
        for (const localId of entry.scriptIds) {
          this.bgScripts.set(fi * 16 + pos, { anm, entryIndex, localId, spriteBase: entry.spriteBase });
          pos++;
        }
      });
    });
    // Stage-intro title: stdNtxt.anm scripts 0-4 are the full vanilla
    // presentation with positions/slides/fades baked in, in 640x480 SCREEN
    // coordinates (the playfield sits at +32,+16 like the original):
    // script0 = stage crest (128x128, add-blend), 1 = vertical JP title
    // (rotated pi/2, drifts right), 2 = "Stage N", 3 = subtitle strip,
    // 4 = vertical BGM label rising along the right edge. All finish and
    // self-remove by ~frame 460.
    const introEntry = this.stdTxtAnm.entries[0];
    this.stageIntroRunners = (introEntry?.scriptIds ?? []).map(
      (id) =>
        new AnmRunner(this.stdTxtAnm, id, { entryIndex: 0, spriteIndexOffset: introEntry.spriteBase })
    );
    this.cherry = new CherrySystem(
      {
        borderStartAction: () => {
          const p = this.playerObj;
          // FUN_0043e890 @ 0x43e890: state 1/3, an active bomb, or a
          // blocked dialogue/transition records marker 2 and retries later.
          // The stage-clear sequence defers too: a cherryPlus bar filled by
          // the boss-kill sweep stays pinned at 50000, carries into the
          // next stage via RunCarry, and the first positive gain there
          // re-requests the border (the exe's re-fire-on-next-dc6f model).
          // bombCleanupThisTick is stashed on the scene for the current
          // scheduler pass so the post-timer cleanup callback (native
          // +0x16a20 still set) continues to defer a pending border.
          if (this.stageClear || this.isDialogueActive() || this.bombActiveThisFrame ||
              this.bombCleanupDefersBorder || p.bombTimer > 0 || p.bombInvuln > 0 ||
              p.invulnFrames > 0 || p.materializeFrame >= 0 || p.dyingFrame >= 0) {
            return 'defer';
          }
          // State 2 with a live deathbomb meter consumes the pending border
          // through FUN_0043eb00: no miss, no border timer, 40f invulnerability.
          if (p.hitState) return 'cancel';
          return 'start';
        },
        onBorderStart: () => {
          // Th07.exe FUN_0043e890 @ 0x43eaba-0x43ead7.
          this.playSfx(32);
          this.playSfx(36);
          this.borderMessage = { type: 2, value: 0, age: 0, timer: 180 };
        },
        onBorderCancel: () => this.applyBorderBreakEffects(null, true),
        onBorderEnd: (result, bonus) => {
          if (result === 'survived') {
            // FUN_0043e620 @ 0x43e620: natural expiry enters state 3 for
            // 40 frames and reinitializes the shared +0x16a08/+0x16a04
            // split timer. The collision gate reads that same pair, so a
            // state-4 -> state-3 transition must discard the Border's
            // fractional residue even though both states are "special".
            // Keeping the old 0.5 residue skipped Extra's first post-Border
            // scan and changed the integer-bucketed damage score by one.
            this.resetPlayerShotCollisionSpecialClock();
            if (this.playerObj.invulnFrames < 40) {
              this.playerObj.invulnFrames = 40;
              this.playerObj.invulnFrac = 0;
            }
            this.playerObj.bombCooldown = 40;
            this.borderMessage = { type: 4, value: bonus * 10, age: 0, timer: 180 };
            this.playSfx(33);
          }
        }
      },
      difficulty
    );
    this.runtime = new StageRuntime(stageData, {
      etama: assets.anms.etama,
      enemy: this.enemyAnm,
      effect: this.effectAnm
    });
    this.runtime.reset();
    this.runtime.initializeRandomCounters(this.rng);
    this.etamaItemBase = assets.anms.etama.entries[1].spriteBase;
    this.playerObj = new Player(character, assets.anms);
    this.playerEffects = new PlayerEffects(this.playerObj.anm);
    this.bombContext = this.createBombContext();
    this.player = this.playerObj;
    // Extra/Phantasm run-init (FUN_0042cf2f @ all.c:19715-19717): lives
    // forced to 2 for difficulty >= 4. Power 128 at start is the
    // community-documented convention (PROBABLE — the exe-side write site
    // wasn't located; spec-extra-phantasm.md §2).
    if (!carry && this.difficulty >= 4) {
      this.playerObj.lives = 2;
      this.playerObj.power = 128;
    }
    // Mid-run stage entry: score/lives/power/graze/cherry persist across
    // stages within one credit (the exe keeps them in the run-global stats
    // block; only per-stage state — enemies, items, spell state — resets).
    if (carry) {
      this.score = carry.score;
      this.hiScore = carry.hiScore;
      this.graze = carry.graze;
      this.pointItems = carry.pointItems;
      this.playerObj.lives = carry.lives;
      this.playerObj.bombs = carry.bombs;
      this.playerObj.power = carry.power;
      this.cherry.cherry = carry.cherry;
      this.cherry.cherryMax = carry.cherryMax;
      this.cherry.cherryPlus = carry.cherryPlus;
      this.cherry.spellsCaptured = carry.spellsCaptured;
      this.extendLevel = carry.extendLevel;
      this.rank = carry.rank;
      this.rankAccumulator = carry.rankAccumulator ?? 0;
      this.startStageTransition();
    }
    this.captureStageEntryTotals();
  }

  // Called after a replay stage snapshot overwrites the constructor defaults.
  // Browser playback and the Node verifier share this seam so clear-bonus
  // deltas use the original stage-entry cumulative counters.
  captureStageEntryTotals(): void {
    this.stageEntryGraze = this.graze;
    this.stageEntryPointItems = this.pointItems;
  }

  // -- native fixed-slot pools ---------------------------------------------

  private insertByPoolSlot<T extends { poolSlot: number }>(dense: T[], value: T): void {
    let lo = 0;
    let hi = dense.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (dense[mid].poolSlot <= value.poolSlot) lo = mid + 1;
      else hi = mid;
    }
    dense.splice(lo, 0, value);
  }

  addEnemy(enemy: Enemy): boolean {
    let slot = enemy.poolSlot;
    if (slot < 0 || slot >= ENEMY_POOL_CAP || this.enemySlots[slot] !== null) {
      slot = this.enemySlots.indexOf(null);
    }
    if (slot < 0) return false;
    enemy.poolSlot = slot;
    this.enemySlots[slot] = enemy;
    this.insertByPoolSlot(this.enemies, enemy);
    return true;
  }

  discardAllocatedEnemy(enemy: Enemy): void {
    const slot = enemy.poolSlot;
    if (slot >= 0 && slot < ENEMY_POOL_CAP && this.enemySlots[slot] === enemy) {
      this.enemySlots[slot] = null;
    }
    const dense = this.enemies.indexOf(enemy);
    if (dense >= 0) this.enemies.splice(dense, 1);
  }

  addEnemyBullet(bullet: EnemyBullet): boolean {
    const slot = bullet.poolSlot;
    if (slot < 0 || slot >= ENEMY_BULLET_POOL_CAP) return false;
    if (this.enemyBulletSlots[slot]?.dead) this.enemyBulletSlots[slot] = null;
    if (this.enemyBulletSlots[slot] !== null) return false;
    bullet.offscreenFrames = this.enemyBulletOffscreenCounters[slot];
    this.enemyBulletSlots[slot] = bullet;
    this.insertByPoolSlot(this.enemyBullets, bullet);
    return true;
  }

  clearEnemyBullets(resetFixedSlotStorage = false): void {
    this.enemyBullets.length = 0;
    this.enemyBulletSlots?.fill(null);
    if (resetFixedSlotStorage) {
      // Th07.exe (v1.00b) FUN_00422ea0 @ 0x422f48: item-producing clear
      // modes 1..8 `rep stos` the whole 0xd68-byte bullet slot after the
      // item spawn. This clears the slot-local +0xbfe off-screen counter.
      // Silent mode 0/10 and FUN_00423100 only enter state 5 and preserve
      // that field, so callers must request the hard reset explicitly.
      this.enemyBulletOffscreenCounters?.fill(0);
    }
  }

  removeEnemyBullet(bullet: EnemyBullet): void {
    bullet.dead = true;
    const slot = bullet.poolSlot;
    if (this.enemyBulletSlots && slot >= 0 && slot < ENEMY_BULLET_POOL_CAP && this.enemyBulletSlots[slot] === bullet) {
      this.enemyBulletSlots[slot] = null;
    }
  }

  private addPlayerBullet(bullet: PlayerBullet): boolean {
    const slot = this.playerBulletSlots.indexOf(null);
    if (slot < 0) return false;
    bullet.poolSlot = slot;
    this.playerBulletSlots[slot] = bullet;
    this.insertByPoolSlot(this.playerBullets, bullet);
    if (this.observePlayerShotSerial) this.playerShotSerial++;
    return true;
  }

  private syncEnemySlots(): void {
    if (this.slotsConsistent(this.enemies, this.enemySlots, ENEMY_POOL_CAP, (e) => !e.dead)) return;
    this.enemySlots.fill(null);
    const live = this.enemies.filter((enemy) => enemy && !enemy.dead);
    const rebuilt: Enemy[] = [];
    for (const enemy of live) {
      let slot = Number.isInteger(enemy.poolSlot) ? enemy.poolSlot : -1;
      if (slot < 0 || slot >= ENEMY_POOL_CAP || this.enemySlots[slot] !== null) slot = this.enemySlots.indexOf(null);
      if (slot < 0) { enemy.dead = true; continue; }
      enemy.poolSlot = slot;
      this.enemySlots[slot] = enemy;
      rebuilt.push(enemy);
    }
    rebuilt.sort((a, b) => a.poolSlot - b.poolSlot);
    this.enemies = rebuilt;
  }

  private syncPlayerBulletSlots(): void {
    if (this.slotsConsistent(this.playerBullets, this.playerBulletSlots, PLAYER_BULLET_POOL_CAP, (e) => !e.dead)) return;
    this.playerBulletSlots.fill(null);
    const live = this.playerBullets.filter((bullet) => bullet && !bullet.dead);
    const rebuilt: PlayerBullet[] = [];
    for (const bullet of live) {
      let slot = Number.isInteger(bullet.poolSlot) ? bullet.poolSlot : -1;
      if (slot < 0 || slot >= PLAYER_BULLET_POOL_CAP || this.playerBulletSlots[slot] !== null) slot = this.playerBulletSlots.indexOf(null);
      if (slot < 0) { bullet.dead = true; continue; }
      bullet.poolSlot = slot;
      this.playerBulletSlots[slot] = bullet;
      rebuilt.push(bullet);
    }
    rebuilt.sort((a, b) => a.poolSlot - b.poolSlot);
    this.playerBullets = rebuilt;
  }

  private syncEnemyBulletSlots(): void {
    if (this.slotsConsistent(this.enemyBullets, this.enemyBulletSlots, ENEMY_BULLET_POOL_CAP, (e) => !e.dead)) return;
    this.enemyBulletSlots.fill(null);
    const live = this.enemyBullets.filter((bullet) => bullet && !bullet.dead);
    const rebuilt: EnemyBullet[] = [];
    for (const bullet of live) {
      let slot = Number.isInteger(bullet.poolSlot) ? bullet.poolSlot : -1;
      if (slot < 0 || slot >= ENEMY_BULLET_POOL_CAP || this.enemyBulletSlots[slot] !== null) slot = this.enemyBulletSlots.indexOf(null);
      if (slot < 0) { bullet.dead = true; continue; }
      bullet.poolSlot = slot;
      this.enemyBulletOffscreenCounters[slot] = bullet.offscreenFrames ?? this.enemyBulletOffscreenCounters[slot];
      bullet.offscreenFrames = this.enemyBulletOffscreenCounters[slot];
      this.enemyBulletSlots[slot] = bullet;
      rebuilt.push(bullet);
    }
    rebuilt.sort((a, b) => a.poolSlot - b.poolSlot);
    this.enemyBullets = rebuilt;
  }

  private syncItemSlots(): void {
    this.itemSlots ??= new Array(ITEM_POOL_CAP).fill(null);
    if (!Number.isInteger(this.itemPoolCursor)) this.itemPoolCursor = 0;
    if (this.slotsConsistent(this.items, this.itemSlots, ITEM_POOL_CAP, (e) => !e.dead)) return;
    this.itemSlots.fill(null);
    const live = this.items.filter((item) => item && !item.dead);
    const rebuilt: ItemEntity[] = [];
    for (const item of live) {
      let slot = Number.isInteger(item.poolSlot) ? item.poolSlot : -1;
      if (slot < 0 || slot >= ITEM_POOL_CAP || this.itemSlots[slot] !== null) {
        slot = this.itemSlots.indexOf(null);
      }
      if (slot < 0) { item.dead = true; continue; }
      item.poolSlot = slot;
      this.itemSlots[slot] = item;
      rebuilt.push(item);
    }
    rebuilt.sort((a, b) => a.poolSlot - b.poolSlot);
    this.items = rebuilt;
  }

  private syncFixedPools(): void {
    this.syncEnemySlots();
    this.syncPlayerBulletSlots();
    this.syncEnemyBulletSlots();
    this.syncItemSlots();
    this.syncEffectSlots();
  }

  // Allocation-free validity check shared by the five sync*Slots methods. Returns
  // true when the dense iteration array and the fixed-slot array are mutually
  // consistent (same live set, each live entity's poolSlot points back at it, and
  // the live count equals the non-null slot count), so the caller can skip the
  // (allocating) rebuild. The decision is byte-identical to the old
  // `.filter()` + `.reduce()` + back-pointer check — it just allocates nothing.
  // This removes 5 fresh arrays + 5 reduce closures from every 60 Hz tick.
  private slotsConsistent<T extends { poolSlot: number }>(
    dense: T[], slots: (T | null)[], cap: number, isLive: (e: T) => boolean
  ): boolean {
    let live = 0;
    for (let i = 0; i < dense.length; i++) {
      const e = dense[i];
      if (e && isLive(e)) {
        live++;
        const ps = e.poolSlot;
        if (ps < 0 || ps >= cap || slots[ps] !== e) return false;
      }
    }
    let slotCount = 0;
    for (let s = 0; s < cap; s++) if (slots[s]) slotCount++;
    return live === slotCount;
  }

  // Order-preserving in-place compaction — replaces `this.x = this.x.filter(e => !e.dead)`
  // at three mid-update sites. A stable partition on !dead keeps the poolSlot-sorted
  // dense order intact and allocates nothing (the .filter allocated a fresh array each
  // tick, the dominant steady-state GC pressure). Result is byte-identical to the filter.
  private compactLive<T extends { dead?: boolean }>(arr: T[]): void {
    let w = 0;
    for (let r = 0; r < arr.length; r++) {
      const e = arr[r];
      if (e && !e.dead) arr[w++] = e;
    }
    arr.length = w;
  }

  private syncEffectSlots(): void {
    if (this.slotsConsistent(this.particles, this.effectSlots, EFFECT_POOL_CAP, (e) => e.age < e.life)) return;
    this.effectSlots.fill(null);
    const live = this.particles.filter((particle) => particle && particle.age < particle.life);
    const rebuilt: EffectParticle[] = [];
    for (const particle of live) {
      let slot = Number.isInteger(particle.poolSlot) ? particle.poolSlot : -1;
      if (slot < 0 || slot >= EFFECT_POOL_CAP || this.effectSlots[slot] !== null) {
        slot = this.effectSlots.indexOf(null);
      }
      if (slot < 0) continue;
      particle.poolSlot = slot;
      this.effectSlots[slot] = particle;
      rebuilt.push(particle);
    }
    rebuilt.sort((a, b) => a.poolSlot - b.poolSlot);
    this.particles = rebuilt;
  }

  // Next point-item extend threshold for the current level (all.c:22101-22120).
  get extendThreshold(): number {
    const lvl = this.extendLevel;
    if (this.difficulty < 4) {
      if (lvl < 3) return lvl * 75 + 50; // 50, 125, 200
      if (lvl < 5) return (lvl - 3) * 150 + 300; // 300, 450
      return (lvl - 5) * 200 + 800;
    }
    if (lvl === 0) return 200;
    if (lvl === 1) return 500;
    return (lvl - 2) * 500 + 800;
  }

  // Power bracket index (SHT thresholds 8/16/32/48/64/80/96/128; AGENTS §6):
  // FUN_00430860 compares this before/after a power gain — crossing a
  // bracket fires the salmon "tier up" popup + chime instead of the white 10.
  private powerTier(power: number): number {
    const brackets = [8, 16, 32, 48, 64, 80, 96, 128];
    let tier = 0;
    for (const b of brackets) if (power >= b) tier++;
    return tier;
  }

  // Point-extend award, Th07.exe FUN_0042bf29 @ 0x42bf29: +1 life below 8
  // lives, else +1 bomb below 8 bombs, else nothing. Both successful paths
  // go through FUN_0042bcbc/FUN_0042bd01, which call FUN_00401700 and consume
  // two u32 values from the shared gameplay RNG before the rank/SFX work.
  private awardExtend(): void {
    const p = this.playerObj;
    if (p.lives < 8) p.lives++;
    else if (p.bombs < 8) p.bombs++;
    else return;
    this.refreshPowerHudRandomState();
    this.adjustRank(200);
    this.playSfx(28);
  }

  private adjustRank(delta: number): void {
    // Th07.exe FUN_0042db77/FUN_0042dbf3 @ 0x42db77/0x42dbf3.
    // Difficulty rows {start,min,max}: E 16/12/20; N/H/L 16/10/32;
    // Extra/Phantasm 16/15/16 (table @ 0x4955a8).
    const bounds = this.difficulty === 0 ? { min: 12, max: 20 }
      : this.difficulty <= 3 ? { min: 10, max: 32 }
        : { min: 15, max: 16 };
    this.rankAccumulator += Math.trunc(delta);
    while (this.rankAccumulator >= 100) {
      this.rank++;
      this.rankAccumulator -= 100;
    }
    while (this.rankAccumulator < 0) {
      this.rank--;
      this.rankAccumulator += 100;
    }
    this.rank = Math.min(bounds.max, Math.max(bounds.min, this.rank));
  }

  private tickRankSurvival(): void {
    // FUN_0041ed50 @ 0x41eda5-0x41ee20 checks the enemy-manager split
    // counter before its per-frame tail advances it. A newly reached integer
    // tick is rewarded when divisible by 2400-lives*240. The source operand
    // is run stats +0x5c (the same lives float read by FUN_0042bf29), not the
    // difficulty byte. Dialogue/time freeze skips updateEnemies entirely;
    // slowmo advances the fraction only.
    if (this.rankSurvivalAdvanced) {
      const interval = 2400 - Math.trunc(this.playerObj.lives) * 240;
      if (this.rankSurvivalTicks > 0 && this.rankSurvivalTicks % interval === 0) {
        this.adjustRank(100);
      }
    }
    this.rankSurvivalAdvanced = false;
    this.rankSurvivalFraction += this.slowRate;
    while (this.rankSurvivalFraction >= 1) {
      this.rankSurvivalFraction -= 1;
      this.rankSurvivalTicks++;
      this.rankSurvivalAdvanced = true;
    }
  }

  // Stage-clear bonus, exe-exact (FUN_00429446's credit block @
  // all.c:18308-18337, display strings @ all.c:17038-17120):
  //   internal = stage*100000 + stageGraze*50 + stagePointItems*5000 + cherryMax
  //   [+ lives*2,000,000 + bombs*400,000 on route-final clears (stage>5)]
  //   Easy /2, Hard *12/10, Lunatic *15/10, Extra <<1; Normal AND Phantasm
  //   have no arm (x1.0 — the Phantasm screen prints no Rank line at all).
  //   Continue penalty: x0.5 / x0.2 tiers.
  // The tally rows display internal*10 (the exe's "%8d0" appended-zero
  // trick); the score field gains the internal total via ten +=/10 ticks.
  private computeClearBonus(): void {
    const finalClear = this.stageNumber >= 6;
    const stageGraze = this.graze - this.stageEntryGraze;
    const stagePointItems = this.pointItems - this.stageEntryPointItems;
    let internal =
      this.stageNumber * 100000 + stageGraze * 50 + stagePointItems * 5000 + this.cherry.cherryMax;
    let playerBonus = 0;
    let bombBonus = 0;
    if (finalClear) {
      playerBonus = this.playerObj.lives * 2000000;
      bombBonus = this.playerObj.bombs * 400000;
      internal += playerBonus + bombBonus;
    }
    const MULT_BY_DIFFICULTY = [0.5, 1.0, 1.2, 1.5, 2.0, 1.0];
    const mult = MULT_BY_DIFFICULTY[this.difficulty] ?? 1.0;
    internal = Math.trunc(internal * mult);
    // Player Penalty (FUN_00429446 @ all.c:18329-18334): the run-state
    // starting-lives byte scales the whole bonus — 3 -> *5/10, 4 -> (x<<1)/10.
    // This replaced a continues-based guess; the exe reads only this byte.
    if (this.startingLives === 3) internal = Math.trunc((internal * 5) / 10);
    else if (this.startingLives === 4) internal = Math.trunc((internal * 2) / 10);
    this.clearBonus = {
      clear: this.stageNumber * 1000000,
      point: stagePointItems * 50000,
      graze: stageGraze * 500,
      // FUN_00427269 stores DAT_00625868 (cherryMax), not DAT_0062586c
      // (live cherry), into the results block. Stage 1 is the decisive
      // witness: native clear credit 915750 uses 320000 cherryMax; using its
      // 128770 live cherry produced only 628900.
      cherry: this.cherry.cherryMax * 10,
      player: playerBonus * 10,
      bomb: bombBonus * 10,
      mult,
      total: internal * 10
    };
    this.addScore(Math.trunc(internal / 10) * 10);
  }

  // Snapshot of everything that persists across a stage transition.
  carryState(): RunCarry {
    return {
      score: this.score,
      hiScore: Math.max(this.hiScore, this.score),
      graze: this.graze,
      pointItems: this.pointItems,
      lives: this.playerObj.lives,
      bombs: this.playerObj.bombs,
      power: this.playerObj.power,
      cherry: this.cherry.cherry,
      cherryMax: this.cherry.cherryMax,
      cherryPlus: this.cherry.cherryPlus,
      spellsCaptured: this.cherry.spellsCaptured,
      extendLevel: this.extendLevel,
      rank: this.rank,
      rankAccumulator: this.rankAccumulator
    };
  }

  // -- GameHost --------------------------------------------------------------

  addScore(v: number): void {
    this.score += v;
  }

  setLatencyObservationEnabled(enabled: boolean): void {
    this.observePlayerShotSerial = enabled;
  }

  resetBombForLatencyProbe(): void {
    if (!this.observePlayerShotSerial) return;
    this.playerObj.bombTimer = 0;
    this.playerObj.bombCooldown = 0;
    this.playerObj.bombInvuln = 0;
    this.playerObj.bombs = Math.max(1, this.playerObj.bombs);
    this.prevBombTimer = 0;
    this.bombActiveThisFrame = false;
    this.bombCleanupDefersBorder = false;
    this.bombCleanupPending = false;
    this.bombRunner = null;
    this.bombEngine.reset();
    this.activeBombSlots.length = 0;
    for (const region of this.bombClearRegions) region.framesLeft = 0;
    this.playerEffects.clear();
    this.screenShakes.length = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }

  setSlowRate(rate: number): void {
    this.slowRate = rate;
  }

  setBulletTimeVisual(active: boolean): void {
    // Th07.exe v1.00b @ 0x418020/0x418130 writes 2/1 to the +0x1c6 interrupt
    // field of both global spell-background VMs. The writes occur even for
    // effect-10 param=1 (rate remains 1): this is an authored visual state,
    // not a color inferred from slowRate.
    const label = active ? 2 : 1;
    for (const runner of this.spellBackgroundRunners) runner.interrupt(label);
  }

  // Screen FX scheduler (exe FUN_004459c0). Type 1 shake: each frame both
  // camera axes independently pick {0, +mag, -mag}, mag ramping from->to
  // over the duration. Type 3 flash: a full-screen tint held `duration`
  // frames, repeated `repeats` times, alpha from the ARGB high byte.
  private readonly screenShakes: { duration: number; elapsed: number; from: number; to: number }[] = [];
  private screenFlash: { duration: number; timer: number; repeats: number; color: number } | null = null;
  private shakeX = 0;
  private shakeY = 0;

  startScreenShake(duration: number, from: number, to: number): void {
    // FUN_004459c0 allocates one scheduler object per request. Concurrent
    // shakes therefore retain independent clocks/RNG draws instead of a new
    // request replacing the previous one (native Phantasm PRE10485/10486).
    this.screenShakes.push({ duration: Math.max(1, duration), elapsed: 0, from, to });
  }

  startScreenFlash(duration: number, repeats: number, argb: number): void {
    this.screenFlash = { duration: Math.max(1, duration), timer: 0, repeats, color: argb >>> 0 };
  }

  fadeBgm(seconds: number): void {
    this.audio.fadeOutBgm(seconds);
  }

  private tickScreenFx(): void {
    this.shakeX = 0;
    this.shakeY = 0;
    if (!this.isDialogueBlocking()) {
      for (let i = 0; i < this.screenShakes.length;) {
        const shake = this.screenShakes[i];
        // Th07.exe (v1.00b) FUN_00445790 @ 0x4457c4-0x4457e6 advances
        // the split counter BEFORE testing it against the duration. Thus a
        // duration-N shake draws on counter values 1..N-1 (N-1 ticks), not
        // 0..N-1. Drawing before the advance kept effect 9 alive one extra
        // frame and consumed a spurious u32 pair (Stage 5 replay PRE5280).
        shake.elapsed += this.slowRate;
        if (shake.elapsed >= shake.duration) {
          this.screenShakes.splice(i, 1);
          continue;
        }
        const mag = shake.from + (shake.elapsed / shake.duration) * (shake.to - shake.from);
        // Scheduler order is allocation order and every instance writes the
        // shared camera fields. The last surviving instance therefore owns
        // the visible offset while all earlier instances still consume RNG.
        const xPick = this.rng.u32InRange(3);
        const yPick = this.rng.u32InRange(3);
        this.shakeX = xPick === 0 ? 0 : xPick === 1 ? mag : -mag;
        this.shakeY = yPick === 0 ? 0 : yPick === 1 ? mag : -mag;
        i++;
      }
    }
    const flash = this.screenFlash;
    if (flash && ++flash.timer >= flash.duration) {
      flash.timer = 0;
      if (--flash.repeats <= 0) this.screenFlash = null;
    }
  }

  // FUN_00402260 (large pool) / FUN_00402310 (3-slot pool): digits stored
  // least-significant-first; value < 0 stores the single sentinel glyph 10;
  // value 0 stores one zero digit.
  spawnScorePopup(value: number, x: number, y: number, color: number, small = false): void {
    const pool = small ? this.popupsSmall : this.popupsLarge;
    const cursor = small ? this.popupCursorSmall : this.popupCursorLarge;
    const entry = pool[cursor % pool.length];
    if (small) this.popupCursorSmall = (cursor + 1) % pool.length;
    else this.popupCursorLarge = (cursor + 1) % pool.length;
    entry.active = true;
    entry.x = x;
    entry.y = y;
    entry.color = color >>> 0;
    entry.timer = 0;
    entry.timerFrac = 0;
    entry.digits.length = 0;
    let v = Math.trunc(value);
    if (v < 0) {
      entry.digits.push(10);
    } else if (v === 0) {
      entry.digits.push(0);
    } else {
      while (v !== 0) {
        entry.digits.push(v % 10);
        v = Math.trunc(v / 10);
      }
    }
  }

  // Th07.exe (v1.00b) FUN_00401ad0 @ 0x401ad0: the loop starts from each
  // entry's timer sub-structure (which hid it from the earlier pool-base
  // search), moves y by -0.5*slowRate, advances the standard split counter,
  // and clears active once its integer part is > 60.
  private updatePopups(): void {
    const updatePool = (pool: ScorePopup[]) => {
      for (const pop of pool) {
        if (!pop.active) continue;
        pop.y -= 0.5 * this.slowRate;
        if (this.slowRate > 0.99) {
          pop.timer++;
        } else {
          pop.timerFrac += this.slowRate;
          if (pop.timerFrac >= 1) {
            pop.timer++;
            pop.timerFrac -= 1;
          }
        }
        if (pop.timer > 60) pop.active = false;
      }
    };
    updatePool(this.popupsLarge);
    updatePool(this.popupsSmall);
  }

  // Draw pass (exe FUN_00403770 @ all.c:1684-1758): 8px-pitch glyphs, with
  // the first glyph center at x-digitCount*4. The popup
  // renderer indexes ascii.anm sprites 0..30 — the dedicated 8x8 Japanese-
  // styled number row, NOT the HUD's 8x12 sprites 132..141. At timer 52/56
  // it switches to the two authored decay rows. Script 3 has no ins_22, so
  // these VM coordinates retain center anchoring. Alpha is a squared-
  // distance-from-player pulse — 80/255 within 32px, an integer ramp to
  // 208/255 at 64px, flat beyond.
  private drawPopups(r: Renderer, ox: number, oy: number): void {
    const p = this.playerObj;
    const drawPool = (pool: ScorePopup[]) => {
      for (const pop of pool) {
        if (!pop.active) continue;
        const dx = pop.x - p.x;
        const dy = pop.y - p.y;
        const distSq = Math.round(dx * dx + dy * dy);
        const alphaByte = distSq <= 1024 ? 80
          : distSq >= 4096 ? 208
            : 80 + Math.trunc(((distSq - 1024) * 128) / 3072);
        const n = pop.digits.length;
        const startX = pop.x - n * 4;
        for (let i = 0; i < n; i++) {
          const glyph = pop.digits[n - 1 - i];
          // Th07.exe FUN_00403770 @ 0x40387b: the 48x8 PowerUp sentinel
          // (sprite 10) never changes bank; numeric glyphs use sprites
          // 11..20 at timer 52 and 21..30 at timer 56.
          const sprite = glyph === 10 ? 10
            : pop.timer >= 56 ? glyph + 21
              : pop.timer >= 52 ? glyph + 11 : glyph;
          const sx = sprite <= 9 ? sprite * 8
            : sprite === 10 ? 80 : 128 + ((sprite - 11) % 10) * 8;
          const sy = sprite >= 21 ? 8 : 0;
          const sw = sprite === 10 ? 48 : 8;
          r.drawSpriteInBatch('ascii', sx, sy, sw, 8,
            ox + startX + i * 8, oy + pop.y,
            0, 1, alphaByte / 255, 'source-over', pop.color);
        }
      }
    };
    // A full-field sweep legitimately activates the whole 720-slot large
    // pool at once (~4000 glyphs/frame for 60 frames) — bracketed batch
    // drawing keeps that survivable; the per-glyph save/restore path froze
    // Lunatic phase ends.
    r.ctx.save();
    drawPool(this.popupsLarge);
    drawPool(this.popupsSmall);
    r.ctx.restore();
  }

  // Th07.exe FUN_00431da0 (all.c:22298-22323): the instant a pickup completes
  // the power bar, every OTHER live power/bigPower item converts to bigCherry
  // with a white sparkle and, if falling, an upward nudge to velocity
  // (0, -0.5) (threshold _DAT_0048ed74 = -0.5).
  private convertLivePowerItems(): void {
    for (const other of this.items) {
      if (other.dead || (other.type !== 'power' && other.type !== 'bigPower')) continue;
      other.type = 'bigCherry';
      if (other.vy > -0.5) {
        other.vx = 0;
        other.vy = -0.5;
      }
      this.spawnEffectParticles(0, other.x, other.y, 1, 0xffffffff);
    }
  }

  spawnItem(type: ItemType, x: number, y: number, options: { state?: number; vx?: number; vy?: number; tweenTarget?: { tx: number; ty: number } } = {}): void {
    // Th07.exe FUN_00430970 @ 0x430970: a rotating next-fit cursor scans the
    // fixed 1100-slot pool, advancing once for every tested slot and leaving
    // the cursor immediately after the allocation. The item manager later
    // updates live slots in ascending physical order, not spawn order.
    this.itemSlots ??= new Array(ITEM_POOL_CAP).fill(null);
    if (!Number.isInteger(this.itemPoolCursor)) this.itemPoolCursor = 0;
    let slot = -1;
    for (let scanned = 0; scanned < ITEM_POOL_CAP; scanned++) {
      const candidate = this.itemPoolCursor;
      this.itemPoolCursor++;
      if (this.itemPoolCursor >= ITEM_POOL_CAP) this.itemPoolCursor = 0;
      if (this.itemSlots[candidate] === null) {
        slot = candidate;
        break;
      }
    }
    if (slot < 0) return;
    // Th07.exe (v1.00b) item spawn primitive FUN_00430970 @ 0x430970: at full
    // power, power(0)/bigPower(2) drops convert to bigCherry(7) -- so max-power
    // players get value items instead of wasted power.
    if (this.playerObj.power >= 128 && (type === 'power' || type === 'bigPower')) type = 'bigCherry';
    // Spawn mode 2 (FUN_00430970 all.c:21852-21862): the item lerps from its
    // spawn point to the caller's target over 60 frames (see updateItems).
    const tween = options.tweenTarget
      ? {
          sx: Math.fround(x),
          sy: Math.fround(y),
          tx: Math.fround(options.tweenTarget.tx),
          ty: Math.fround(options.tweenTarget.ty),
          elapsed: 0,
          frac: 0
        }
      : undefined;
    const item: ItemEntity = {
      id: this.id++,
      poolSlot: slot,
      // FUN_00430970 stores the item motion block at +0x24c..+0x26c as
      // float32. Keeping JS doubles shifts collection frames and the
      // round(y-PoC) score boundary despite otherwise-exact replay events.
      x: Math.fround(x),
      y: Math.fround(y),
      vx: Math.fround(options.vx ?? 0),
      vy: Math.fround(options.vy ?? -2.2),
      type,
      age: 0,
      state: tween ? 2 : options.state ?? 0,
      ...(tween ? { tween } : {})
    };
    this.itemSlots[slot] = item;
    this.insertByPoolSlot(this.items, item);
  }

  spawnEffectParticles(
    effectId: number,
    x: number,
    y: number,
    count: number,
    color: number,
    seed?: { x: number; y: number; z: number },
    ownerEnemyId?: number
  ): void {
    // The whole engine draws from ONE RNG stream (all 147 exe call sites share
    // state 0x495e00), so a decorative effect that consumes the wrong number of
    // draws desyncs every later GAMEPLAY draw that frame. FUN_0041b320 scans a
    // rolling, fixed 400-slot pool and only initializes (therefore only draws
    // RNG for) a particle after it finds a free slot. A full scan stops the
    // entire request. This capacity/order contract is observable in Stage 3,
    // where a four-snow request at processing frame 939 finds only two slots.
    const requested = Math.max(0, count | 0);
    const spec = EFFECT_DRAW_COST[effectId];
    for (let tries = 0, remaining = requested; tries < EFFECT_POOL_CAP && remaining > 0; tries++) {
      const slot = this.effectPoolCursor;
      this.effectPoolCursor = (this.effectPoolCursor + 1) % EFFECT_POOL_CAP;
      if (this.effectSlots[slot] !== null) continue;

      let particle: EffectParticle;
      if (effectId === 20 || effectId === 26 || effectId === 27 ||
          effectId === 30 || effectId === 31) {
        // Th07.exe DAT_00494fb0: ids 20/26/27/30/31 all install
        // FUN_0041a050 as their per-frame gate. Their spawn initializers are
        // FUN_0041a210/a600/a8d0/ab50/ad80 respectively. They are genuine
        // world-space particles, not fixed 300-frame screen sprites: omitting
        // the shared camera-cone/ground gate left hundreds of stale id30/31
        // slots alive in Stage 5 and changed which later RNG-visible effects
        // the rolling 400-slot allocator could accept.
        const camera = this.runtime.std.camera();
        const facing = this.runtime.std.facing();
        const r = (): number => this.rng.f();
        const scaled = (value: number): number => Math.fround(Math.fround(value) * this.slowRate);
        const origin = (dx: number, dy: number, dz: number) => ({
          x: Math.fround(camera.x + facing.x / 2 + dx),
          y: Math.fround(camera.y + facing.y / 2 + dy),
          z: Math.fround(camera.z + facing.z / 2 + dz)
        });
        const launchX = Math.fround(seed?.x ?? 0);
        const launchY = Math.fround(seed?.y ?? 0);
        const launchZ = Math.fround(seed?.z ?? 0);
        let pos: { x: number; y: number; z: number };
        let vx: number;
        let vy: number;
        let vz: number;
        let ax = 0;
        let ay = 0;
        let az = 0;
        if (effectId === 20) {
          // FUN_0041a210: ten frand calls plus one u32 tint branch.
          pos = origin(r() * 120 - 60, r() * 200 - 100, r() * 100 - 100);
          vx = scaled(launchX + r() * 0.06 - 0.03);
          vy = scaled(launchY + r() * 0.06 - 0.03);
          vz = scaled(launchZ + r() * 0.1 + 0.03);
          ax = scaled(r() * 0.0002 - 0.0001);
          ay = scaled(r() * 0.0002 - 0.0001);
        } else if (effectId === 26 || effectId === 27) {
          // FUN_0041a600 / FUN_0041a8d0. The caller's launch-x is the
          // authored orbital divisor (+0x258); real stage data keeps it
          // non-zero. Both variants bake slowRate into their velocity once.
          const dx = Math.fround(r() * 160 - 80);
          const dy = Math.fround(r() * 160 - 80);
          // Both FUN_0041a600 and FUN_0041a8d0 stage world Z as
          // frand*100-50 (Th07.exe v1.00b @ 0x41a632 / 0x41a8ee). The old
          // -frand-50 collapsed every particle into a one-unit slab, making
          // id27 leave the shared 400-slot pool far too early. At Stage-4
          // PRE17527 that exposed 24 false free slots and admitted eight
          // extra RNG-visible id17 particles.
          pos = origin(dx, dy, Math.fround(r() * 100 - 50));
          vx = scaled(-dy / launchX);
          vy = scaled(dx / launchX);
          vz = scaled(effectId === 26 ? r() * 0.1 + 0.09 : -(r() * 0.2) - 0.06);
          // FUN_0041a600 has one additional unconditional u32 tint branch.
          // It occurs after the two angle draws below.
        } else if (effectId === 30) {
          // FUN_0041ab50 deliberately does not slowRate-scale its launch
          // vector; its per-frame manager clock supplies the rate behavior.
          // Th07.exe (v1.00b) @ 0x41aba1-0x41abb0 stages world Z as
          // frand*100-100. The old 1-frand range kept Extra snow inside the
          // camera cone for the wrong lifetime and silently changed fixed-
          // pool pressure before PRE10621.
          pos = origin(r() * 160 - 80, r() * 160 - 80, r() * 100 - 100);
          vx = Math.fround(launchX + r() * 0.06 - 0.03);
          vy = Math.fround(launchY + r() * 0.06 - 0.03);
          vz = Math.fround(launchZ + r() * 0.02 + 0.01);
        } else {
          // FUN_0041ad80 (id31): falling world flakes with a constant
          // -0.015 z acceleration. Velocity is spawn-time slowRate baked.
          pos = origin(r() * 160 - 80, r() * 160 - 80, r() * 200);
          vx = scaled(launchX + r() * 0.06 - 0.03);
          vy = scaled(launchY + r() * 0.06 - 0.03);
          vz = scaled(launchZ - r() * 0.1);
          az = Math.fround(-0.015);
        }
        const angle = Math.fround(r() * Math.PI * 2 - Math.PI);
        const angularVelocity = Math.fround(r() * 0.031415928 - 0.015707964);
        if (effectId === 20 || effectId === 26) this.rng.u32();
        const world = { ...pos, vx, vy, vz, ax, ay, az, angle, angularVelocity };
        particle = {
          id: this.id++, poolSlot: slot, effectId,
          x, y, vx: 0, vy: 0, age: 0, life: 300,
          color, size: 3, kind: 'snow', world,
          ...(ownerEnemyId == null ? {} : { ownerEnemyId })
        };
      } else if (spec !== undefined) {
        // Effect ids 22/32 use FUN_0041b020's sentinel branch in addition to
        // four unconditional ANM time-0 draws. Th07.exe (v1.00b) @ 0x41b02c
        // compares launch-x with the f64 constant -990.0 @ 0x48ec28: values
        // <= -990 request a random angle (8 total draws), while ordinary
        // signed launch vectors are deterministic (6). Treating the low
        // dword of that f64 as a standalone 0.0 caused every negative half of
        // Stage 1 Sub51's orbit to overdraw by two.
        const conditional = effectId === 22 || effectId === 32;
        const perParticle = conditional ? (seed && seed.x <= -990 ? 8 : 6) : spec;
        // Draw EXACTLY `perParticle` raw u16. The first pair only drives the
        // port's fallback visual; authored lifetime/capacity remains exact.
        let vx = 0;
        let vy = 0;
        for (let d = 0; d < perParticle; d++) {
          const raw = this.rng.u16();
          if (d === 0) {
            const ang = (raw / 65536) * Math.PI * 2;
            vx = Math.cos(ang);
            vy = Math.sin(ang);
          } else if (d === 1) {
            const speed = (0.3 + (raw / 65536) * 0.9) * this.slowRate;
            vx *= speed;
            vy *= speed;
          }
        }
        if (seed) {
          vx += seed.x * 0.02;
          vy += seed.y * 0.02;
        }
        const snow = effectId === 26 || effectId === 27 || effectId === 30 || effectId === 31;
        particle = {
          id: this.id++, poolSlot: slot, effectId,
          x, y, vx, vy, age: 0,
          life: EFFECT_SCRIPT_LIFE[effectId] ?? 24,
          color, size: snow ? 3 : 2, kind: snow ? 'snow' : 'spark',
          ...(ownerEnemyId == null ? {} : { ownerEnemyId })
        };
      } else {
        // Unrecovered ids 16/25/28 keep the legacy visual/RNG model, but now
        // still obey the native fixed-pool allocation contract.
        const isSnow = effectId >= 18;
        const angle = this.rng.range(Math.PI * 2);
        const speed = (isSnow ? 0.2 + this.rng.range(0.5) : 0.5 + this.rng.range(2)) * this.slowRate;
        particle = {
          id: this.id++, poolSlot: slot, effectId,
          x: x + (isSnow ? this.rng.range(384) - 192 : 0),
          y: y + (isSnow ? this.rng.range(64) - 32 : 0),
          vx: isSnow ? -0.3 - this.rng.range(0.4) : Math.cos(angle) * speed,
          vy: isSnow ? 0.7 + this.rng.range(0.8) : Math.sin(angle) * speed,
          age: 0, life: isSnow ? 240 : 24 + this.rng.u32InRange(16),
          color, size: isSnow ? 2 + this.rng.range(2) : 3,
          kind: isSnow ? 'snow' : 'spark',
          ...(ownerEnemyId == null ? {} : { ownerEnemyId })
        };
      }
      this.effectSlots[slot] = particle;
      this.insertByPoolSlot(this.particles, particle);
      remaining--;
    }
  }

  releaseEnemyEffects(ownerEnemyId: number): void {
    // FUN_0041dda0 sets the six op100 aura handles' +0x2ce release byte.
    // FUN_004198b0 then fades them for 16 effect-manager ticks before freeing
    // their general-pool slots; release happens ahead of priority-11 effects,
    // so the first fade tick is the same frame as enemy removal.
    for (const particle of this.particles) {
      if (particle.ownerEnemyId === ownerEnemyId && particle.releaseFrames == null) {
        particle.releaseFrames = 16;
      }
    }
  }

  playSfx(id: number): void {
    // Th07.exe FUN_00446970 @ 0x446970: the 5-slot SE queue drops a request
    // whose id is already queued this service cycle — net effect, any SE id
    // plays at most once per frame no matter how many requests (bug 2: the
    // per-bullet se_damage00 spam).
    if (this.sfxPlayedThisFrame.has(id)) return;
    this.sfxPlayedThisFrame.add(id);
    const slot = SFX_SLOTS[id];
    if (slot) this.audio.sfx(slot[0], slot[1], id);
  }

  startDialogue(index: number): void {
    // Th07.exe timeline op 8 → FUN_0042819f (all.c:17715-17717): activating
    // a dialogue cancels every bullet+laser into auto-collecting cherry
    // items (FUN_00422ea0(1)), kills every non-boss enemy
    // (FUN_004217c0(0,0) — sweep-flagged ones drop their cherry item), and
    // force-autocollects every live item with a small upward nudge
    // (FUN_00431d10). This is what clears the pre-boss wave when a boss
    // arrives — the boss entry subs themselves carry no authored cancel.
    this.cancelBulletsToItems();
    this.runtime.killNonBossEnemies(this, null, 0);
    this.forceCollectAllItems();
    // msg1.dat entry layout is sparse: character*10 + phase (0 pre-boss,
    // 1 post-boss) — entries 0/1 Reimu, 10/11 Marisa, 20/21 Sakuya. The ECL
    // timeline passes only the phase; the engine adds the character offset.
    const entry = CHARACTERS[this.playerObj.character].family * 10 + index;
    // FUN_0042819f @ all.c:17734-17752: after the pre-dialogue clear above,
    // a phase-0 entry (`entry % 10 == 0`) in Stage 6/Extra/Phantasm writes
    // item type 9 to DAT_0099fa98. Native Stage-6 processing 5944 then passes
    // type=9 from FUN_00422ea0 to every FUN_00430970 constructor call.
    if (entry % 10 === 0 && this.stageNumber >= 6) this.cancelItemType = 'case9Cherry';
    this.dialogue = new DialogueRunner(this.runtime.msg, entry, {
      playBgm: (track) => {
        // Th07.exe FUN_00428392 case 7 (@ 0x4288ae): the argument indexes
        // this stage's BGM descriptor table, not the global thbgm list.
        // Every original pre-boss MSG uses slot 1 (the boss theme).
        const name = stageBgmTrack(this.stageNumber, track);
        if (name) this.audio.playBgm(name);
      },
      fadeBgm: () => this.audio.fadeOutBgm(4),
      showStageResults: () => {
        // FUN_00428392 case 9 runs at MSG priority 13. The clear-bonus
        // manager is earlier in the scheduler, so it observes the flag and
        // credits the snapshotted tally on the following frame.
        if (!this.stageResultsActive) this.stageResultsPending = true;
      },
      finishStage: () => {
        // FUN_00428392 case 0xb has two distinct scheduler exits. Stages 1-5
        // set manager+0x209bc; FUN_00426656 publishes game state 3 only on
        // the NEXT priority-13 tick, after one final replay PRE/gameplay pass.
        // Route-final stages write DAT_0056ba88 immediately and have no extra
        // PRE row. For 1-5, leaving the dialogue inactive lets timeline op9
        // fall through on that final tick and the common tail latch the clear.
        if (this.stageNumber >= 6) this.finishStageResults();
      }
    });
  }

  private activateStageResults(): void {
    if (this.stageResultsActive) return;
    this.stageResultsPending = false;
    this.stageResultsActive = true;
    this.stageClearTimer = 0;
    this.computeClearBonus();
    this.startStageClearPresentation();
  }

  private finishStageResults(): void {
    // Every authored post-boss flow reaches op9 first. Keep the fallback for
    // malformed/debug tracks without manufacturing a second bonus credit.
    if (!this.stageResultsActive) this.activateStageResults();
    if (this.stageClear) return;
    this.stageClear = true;
    this.clearTimer = 1;
  }

  isDialogueActive(): boolean {
    return !!this.dialogue && !this.dialogue.done;
  }

  isDialogueBlocking(): boolean {
    return !!this.dialogue && this.dialogue.blocking;
  }

  isBombActive(): boolean {
    return this.bombActiveThisFrame;
  }

  consumeDialogueResume(): boolean {
    if (this.dialogueResume) {
      this.dialogueResume = false;
      return true;
    }
    return false;
  }

  startBossSpell(spellId: number, arg0: number, name: string): void {
    this.spellName = name;
    // Explicit per-encounter cutin ownership (UI-001) — the old stage-1-only
    // spellId<=1?3:0 ternary picked Youmu's reused sheet for every Yuyuko
    // card ("妖夢的符卡释放立绘").
    const portraitSprite = cutinFaceForSpell(spellId);
    // Per-spell base bonus, Th07.exe table @ 0x4951a8 (ids 0-9 = stage 1;
    // read from the exe binary): Cirno cards 2.0M, Ringing Cold 2.2M
    // (E/N) / 2.4M (H/L per id), finals 2.4M. Decay divisor uses the boss's
    // timer-callback threshold armed before the declare (enemy+0x2edc).
    // Full per-spell base-bonus table, int32[141] @ 0x4951a8 read directly
    // from the exe binary (spec-extra-phantasm.md §6c) — ids 0-9 stage 1
    // ... 116-127 Extra, 128-140 Phantasm.
    const base = SPELL_BONUS_BASE[spellId] ?? 2000000;
    const timerFrames = this.bossActive?.ecl.timerCallbackThreshold ?? -1;
    const timerSec = timerFrames > 0 ? Math.trunc(timerFrames / 60) : 50;
    this.phaseTimedOut = false;
    this.spellcard = {
      name,
      id: spellId,
      capturing: true,
      bonus: base,
      bonusBase: base,
      decayPerSec: Math.trunc(base / (timerSec + 10)),
      grazeBonus: 0,
      elapsed: 0,
      elapsedFrac: 0,
      declAge: 0,
      portraitSprite
    };
    this.spellBackgroundRunners = this.stageNumber === 5
      ? this.effectAnm.entries.slice(0, 2).map((entry, entryIndex) =>
          new AnmRunner(this.effectAnm, 0, {
            entryIndex,
            spriteIndexOffset: entry.spriteBase,
            rng: this.rng
          })
        )
      : [];
    this.spellBanner = 150;
    const tally = this.spellHistory.get(spellId) ?? { seen: 0, got: 0 };
    tally.seen++;
    this.spellHistory.set(spellId, tally);
    this.playSfx(14);
    // Th07.exe (v1.00b) FUN_0040ee30 @ 0x40ee30 allocates one template-0x19
    // spell-presentation entity here. It does not request the generic id-3
    // particle family (and therefore consumes no gameplay RNG at declaration).
    // The authored presentation is represented by `spellcard`/`spellBanner`.
  }

  endBossSpell(): boolean {
    // Th07.exe FUN_0040f340 @ 0x40f340 gates the entire phase-end path on
    // DAT_012f40a8 != 0. Boss death callbacks reuse op91 after nonspells too;
    // in that case the native function is a no-op and must not sweep helper
    // enemies a second time. Stage 4 PRE16236 is the fixed-slot witness: the
    // false sweep duplicated two Sub77 trails into 14 extra cherry items.
    const hadActiveSpell = this.spellcard !== null;
    if (this.spellcard?.capturing) {
      // Th07.exe FUN_0040f340 @ 0x40f340: award = decayed base + graze
      // additions; the banner shows the full value while the score field
      // gains value/10 (same 10:1 display convention as point items —
      // score += uVar6/10 at all.c:6644).
      const bonus = this.spellcard.bonus + this.spellcard.grazeBonus;
      this.addScore(Math.trunc(bonus / 10));
      this.cherry.onSpellCapture();
      const tally = this.spellHistory.get(this.spellcard.id);
      if (tally) tally.got++;
      // Duration 280 frames (0x117+1 @ all.c:18302-18304). Failure path
      // arms nothing — no banner, no score credit (all.c:6639-6692).
      this.bonusPopup = { bonus, timer: 280 };
      this.playSfx(33);
    }
    this.spellName = '';
    this.spellcard = null;
    this.spellBackgroundRunners = [];
    // Exe FUN_0040f340: the scored phase-end field sweep only runs when the
    // spell did not time out (DAT_012f40a8 still 1). Getting HIT during the
    // spell voids the bonus but NOT the sweep.
    const sweep = hadActiveSpell && !this.phaseTimedOut;
    this.phaseTimedOut = false;
    return sweep;
  }

  voidSpellCapture(): void {
    if (this.spellcard) this.spellcard.capturing = false;
  }

  onBossPhaseTimeout(): void {
    this.cherry.onBossTimeout();
    // Exe timeout path (all.c:13831): FUN_00422ea0(10) — every bullet fades
    // out with NO item conversion, lasers clear unconditionally (bombType
    // 10 ignores the immunity bit) — and the spell is marked failed
    // (DAT_012f40a8 -> 2) so the op91 that follows skips the scored sweep.
    this.phaseTimedOut = true;
    this.clearEnemyBullets();
    this.cancelLasers(true);
  }

  setBossPresent(present: boolean, enemy: Enemy | null): void {
    this.bossActive = present ? enemy : null;
  }

  setBossLifeCount(count: number): void {
    this.bossLifeCount = count;
  }

  // op 154: drop N point items scattered ±64 (Th07.exe ECL VM 0x99 @ 0x4148f5).
  dropPointItems(e: Enemy, count: number): void {
    for (let i = 0; i < Math.max(0, count | 0); i++) {
      const x = e.x + this.rng.range(128) - 64;
      const y = e.y + this.rng.range(128) - 64;
      this.spawnItem('point', x, y);
    }
  }

  awardSpellValue(value: number): void {
    this.addScore(value);
  }

  spawnEnemyDeathEffect(e: Enemy, deathMode = e.ecl.deathMode & 7): void {
    // StageRuntime owns the executable's complete preburst -> item -> common
    // effect order. This optional hook remains as a test-observation seam.
    void e;
    void deathMode;
  }

  // Th07.exe FUN_00422ea0(1) (op80, spell declare, full-power crossing):
  // every live enemy bullet becomes an auto-collecting item using the bullet
  // manager's live +0x37a160 type (6 initially; Stage 6-8 pre-boss dialogue
  // changes it to 9). No score popups are created by this conversion.
  cancelBulletsToItems(): void {
    for (const b of this.enemyBullets) {
      if (b.dead) continue;
      this.spawnItem(this.cancelItemType, b.x, b.y, { state: 1 });
    }
    this.clearEnemyBullets(true);
    // FUN_00422ea0(1) also converts each non-immune live laser at its
    // origin and every 32 px along [nearDist, farDist).
    this.cancelLaserField(false, true, false);
  }

  // Th07.exe FUN_00423100(8000,1) (op91 spell end, boss nonspell death):
  // same conversion, but each bullet also pops an escalating score value —
  // 2000, +20 per bullet, capped at 8000 — summed and returned for the
  // caller to bank as total/10 (all.c:6632-6645 / 14343-14349).
  sweepBulletsToItems(): number {
    let total = 0;
    let value = 2000;
    for (const b of this.enemyBullets) {
      if (b.dead) continue;
      this.spawnItem(this.cancelItemType, b.x, b.y, { state: 1 });
      // FUN_00423100 @ all.c:15624: escalating popup per bullet — white
      // while ramping, yellow once the 8000 cap is reached.
      this.spawnScorePopup(value, b.x, b.y, value < 8000 ? 0xffffffff : 0xffffff00);
      total += value;
      value = Math.min(8000, value + 20);
    }
    this.clearEnemyBullets();
    // FUN_00423100 does not apply the bomb-immunity flag to lasers. Their
    // converted items do not contribute to the escalating score total.
    this.cancelLaserField(true, true, true);
    return total;
  }

  // Laser half of every FUN_00422ea0 field clear: non-bomb-immune lasers
  // (flags bit 2 clear) get the op-89-style graceful shrink and stop
  // hit-testing immediately (shrinkCutoff=0); `unconditional` mirrors
  // bombType 10 (spell timeout) which ignores the immunity bit. Every
  // clear also arms the exe's 10-frame new-laser suppression counter
  // (gamestate+0x37a12c).
  cancelLasers(unconditional: boolean): void {
    this.cancelLaserField(unconditional, false);
  }

  private cancelLaserField(unconditional: boolean, spawnItems: boolean, includeOrigin = false): void {
    for (const l of this.enemyLasers) {
      if (!l.inUse) continue;
      if ((l.flags & 4) !== 0 && !unconditional) continue;
      if (l.state < 2) {
        l.state = 2;
        l.phaseFrame = 0;
        l.width = l.displayWidth;
        if (spawnItems) {
          // FUN_00423100 emits an explicit origin item before sampling the
          // beam, but FUN_00422ea0 does not. When nearDist is zero the former
          // intentionally duplicates the origin; sharing that behavior made
          // every spell declaration add one spurious item per live laser.
          if (includeOrigin) this.spawnItem(this.cancelItemType, l.x, l.y, { state: 1 });
          const cos = Math.cos(l.angle);
          const sin = Math.sin(l.angle);
          // Th07.exe (v1.00b) FUN_00422ea0 @ 0x422ea0 and
          // FUN_00423100 @ 0x423100; DAT_0048ead4 = 32.0f.
          for (let d = l.nearDist; d < l.farDist; d += 32) {
            this.spawnItem(this.cancelItemType, l.x + cos * d, l.y + sin * d, { state: 1 });
          }
        }
      }
      l.shrinkCutoff = 0;
    }
    this.postBombLaserCounter = 10;
  }

  awardCherry(v: number): void {
    this.cherry.debugAddCherry(v);
  }

  // Test/debug-only: replace the live field with a deterministic three-shot
  // border-break fixture, reusing a real parsed bullet frame. The production
  // game never calls this; it gives the text-mode probe one direct hit, one
  // wave-cancellable bullet at 160px, and one 0x1000-immune bullet beside it.
  debugPrimeBorderCollision(): boolean {
    const source = this.enemyBullets.find((b) => !b.dead);
    if (!source) return false;
    const p = this.playerObj;
    const make = (x: number, flags: number): EnemyBullet => ({
      ...source,
      id: this.id++,
      x,
      y: p.y,
      vx: 0,
      vy: 0,
      speed: 0,
      angle: 0,
      age: 16,
      flags,
      grazed: false,
      spawnDuration: 0,
      spawnMoveScale: 1,
      exFlags: 0,
      exSlots: [null, null, null, null, null],
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
      dead: false
    });
    this.clearEnemyBullets();
    const bullets = [make(p.x, 0), make(p.x + 160, 0), make(p.x + 160, 0x1000)];
    bullets.forEach((bullet, poolSlot) => {
      bullet.poolSlot = poolSlot;
      this.addEnemyBullet(bullet);
    });
    return true;
  }

  playBgmTrack(name: string): void {
    this.audio.playBgm(name);
  }

  unpauseStd(label: number): void {
    this.runtime.std.requestResume(label);
  }

  // -- update ----------------------------------------------------------------

  update(input: InputFrame): void {
    this.frame++;
    this.syncFixedPools();
    // The continue screen freezes gameplay entirely, like the original.
    if (this.continueScreen) {
      this.updateContinueScreen(input);
      return;
    }
    // Vanilla ESC pause: a full freeze with its own menu, drawn over the
    // dimmed frame. Presentation comes verbatim from the authored
    // pause.png scripts in ascii.anm entry 2 (title + three rows + the
    // 本当に？ confirm set, each with show/hide interrupts 1/2).
    if (this.pauseState) {
      this.updatePause(input);
      return;
    }
    if (input.pressed.has('pause') && !this.gameOver && !this.stageClear) {
      this.openPause();
      return;
    }
    if (this.stageResultsPending) this.activateStageResults();
    // Declined / exhausted continues: linger on GAME OVER, then leave.
    // Practice has no continues and leaves the same way.
    if (this.gameOver && this.mode !== 'test') {
      if (++this.gameOverTimer > 240) this.exitToTitle();
    }
    if (this.stageResultsActive) {
      this.stageClearTimer++;
      this.clearLoadingRunner?.update(this.slowRate);
      this.clearCaptureRunner?.update(this.slowRate);
    }
    if (this.stageClear) {
      // Advance on Z once the tally has been visible for a beat, or after
      // the timeout. Stages 1-5 hand the run to the next stage; stage 6 /
      // Extra / Phantasm end the credit back at the title.
      const advance =
        (this.stageClearTimer > 90 && input.pressed.has('shoot')) || this.stageClearTimer > 900;
      if (this.mode !== 'test' && advance && !this.stageCompleteFired) {
        this.stageCompleteFired = true;
        if (((this.mode === 'arcade' && this.stageNumber < 6) || this.mode === 'replay') && this.onStageComplete) {
          this.onStageComplete(this.carryState());
        } else {
          // Stage 6 / Extra / Phantasm end the credit; practice always
          // returns to the title after its single stage (exe FUN_00428392
          // case 0xb, all.c:17980-17982).
          this.exitToTitle();
        }
      }
    }
    const p = this.playerObj;
    this.sfxPlayedThisFrame.clear();
    this.settledDamageThisFrame = 0;
    // Full story dialogue uses the global DAT_0061c25c freeze. `frozen` is
    // captured once at the top of the frame; the dialogue box's own advance
    // below may clear `this.dialogue` mid-frame, taking effect next frame.
    const frozen = this.isDialogueBlocking();
    // Timestamp-only MSG tracks (Stage 5/6 entry 22) leave DAT_0061c25c at
    // zero: player, enemy, effect, item, and bullet managers all keep running.
    // FUN_00429483 is a narrower MSG-active predicate used by input-triggered
    // actions such as bomb/border activation and the shot-cycle re-arm.
    const messageActive = this.isDialogueActive();
    const bombCleanupThisTick = !frozen && this.bombCleanupPending;
    if (!frozen) this.bombCleanupPending = false;
    this.bombCleanupDefersBorder = bombCleanupThisTick;
    this.bombActiveThisFrame = p.bombTimer > 0 || (frozen && this.bombCleanupPending);
    // Th07.exe (v1.00b) FUN_0043eef0 @ 0x43eefb-0x43ef05 starts with
    // FUN_0043d8f0 (clear the shared 112 attack slots), then FUN_0043d9a0
    // (bomb trigger + active bomb VM), before FUN_0043be00 moves the player
    // and before FUN_0043a290 republishes player-shot helper slots. ReimuA
    // bomb actors copy the live player position on their spawn frame, so
    // running the bomb after movement displaced each orb by that frame's
    // full 4px input step and falsely cleared Phantasm slot 394.
    const bombActiveAtFrameStart = p.bombTimer > 0;
    if (!frozen) {
      this.bombEngine.beginFrame();
      // FUN_0043d9a0 @ all.c:28516-28525 drains the fixed player+0x16a2c
      // amount only on the continuation branch. A newly-triggered bomb does
      // not pay until the following player tick; full-dialogue freeze pauses
      // the drain together with the rest of the player callback.
      if (bombActiveAtFrameStart || bombCleanupThisTick) {
        this.cherry.drainBomb(p.bombCherryDrain);
      }
    }
    // The exe reads the bomb button as a raw HELD bit (DAT_004afe30 bit 2 @
    // 0x43d9c3/0x43db3b — gameplay buttons have no edge detection at all),
    // so a bomb held across a dialogue unblock or across the cooldown fires
    // on the first frame the gates open. Bombing during the deathbomb
    // window (p.hitState) still rescues; the squish/materialize are closed
    // by the meter gate inside tryBomb().
    // FUN_0043d9a0 handles the free Border break before its normal resource,
    // message and cooldown gates. The break path returns immediately, so the
    // freshly-written cooldown remains 40 for this frame. Otherwise +0x23fc
    // is decremented first and held X may trigger as soon as it reaches zero.
    const borderBreakRequested = !frozen && !bombCleanupThisTick &&
      p.bombTimer <= 0 && this.cherry.borderEngaged && input.held.has('bomb');
    if (borderBreakRequested) {
      if (this.breakBorder(null, true, true)) this.forceCollectAllItems();
    } else if (!frozen) {
      if (p.bombCooldown > 0) p.bombCooldown--;
      if (!bombCleanupThisTick && !messageActive && input.held.has('bomb') &&
          (p.controllable || p.hitState) && !this.gameOver && p.tryBomb()) {
        this.voidSpellCapture();
        // Th07.exe bomb trigger @ all.c:28503-28506: zeroes the pending
        // spell bonus and latches DAT_012f40bc = spell-active state.
        this.bombDuringSpell = this.spellcard !== null;
        this.onBombUsed();
      }
    }
    if (!frozen && p.bombTimer > 0) this.prepareBombEffects();
    if (!messageActive) this.cherry.retryBorderStart();
    // FUN_0043a820's compound gate is bomb-active && Marisa family && B shot
    // (DAT_004ca4d8 / DAT_00625625 / DAT_00625626), not a global bomb gate.
    // Snapshot the frame-entry bomb state because Player.update() consumes
    // the remaining timer later in this callback: MarisaB's timer=1 tick is
    // still blocked, while Reimu/MarisaA/Sakuya continue firing throughout.
    const allowShotSpawnThisTick = playerShotAllocationAllowed(p.character, p.bombTimer > 0);
    // FUN_0043eef0 returns immediately while the full-dialogue global
    // DAT_0061c25c is set: movement, player ANM, timers and shot MOVE/FIRE
    // all stop. Timestamp-only MSG leaves that global zero, so the callback
    // still runs; only FUN_0043a930's shot-cycle re-arm is suppressed by the
    // narrower FUN_00429483 message-active predicate.
    if (!frozen) {
      // FUN_0043e2e0 precedes movement, shot MOVE/FIRE, and the priority-10
      // enemy manager. Snapshot the state before Player.update consumes the
      // last invulnerability tick, matching the native state dispatcher.
      this.tickPlayerShotCollisionClock(p.invulnFrames > 0 || this.cherry.borderActive);
      p.update(input, this.slowRate, !messageActive);
      if (bombActiveAtFrameStart && p.bombTimer === 0) {
        this.bombCleanupPending = true;
        // FUN_0040c620 / FUN_0040cbf0 detonation else-branch (all.c:5288 /
        // 5453): both SakuyaB casts end by restoring the speed multiplier
        // and publishing a one-pass r800 clear circle at the player
        // position into the +0x17dc pool (FUN_0043e7e0(player+0x930,
        // 800.0, 0, 0, 6)). This is the cast's only full-field cancel.
        if (p.character === 'sakuyaB') this.allocateBombClearRegion(p.x, p.y, 800, 0, 1);
      }
      this.focusHeld = p.focusHeld;
      if (p.focusTransition === 'in') {
        const entryIndex = 1;
        const entry = this.assets.anms.etama.entries[entryIndex];
        // Th07.exe (v1.00b) FUN_0043c9a5 @ 0x43c99b creates effect id 24
        // only on focus-in. Its master script 0x2c2 resolves to etama.anm
        // entry 1 / local script 26; time-0 op60 consumes one u32 from the
        // shared gameplay RNG. A fresh focus-in replaces the reserved slot.
        this.focusEffectRunner = new AnmRunner(this.assets.anms.etama, 26, {
          entryIndex,
          spriteIndexOffset: entry.spriteBase,
          rng: this.rng
        });
      } else if (p.focusTransition === 'out' && this.focusEffectRunner) {
        this.focusEffectRunner.interrupt(1);
      }
    }
    // The popup/ascii manager is priority 1, ahead of every gameplay
    // manager. Existing popups age now; item pickups later this frame create
    // fresh entries that do not tick until the next scheduler pass.
    this.updatePopups();
    if (!frozen) {
      const death = p.tickDeath(this.slowRate);
      if (death === 'effects') this.onPlayerDeath();
      else if (death === 'respawn') this.onPlayerRespawn();
      if (this.respawnClearFrames > 0) {
        // Exe FUN_0043e2e0 top (all.c:28692-28695): while player+0x2400
        // counts down, FUN_00422ea0(0) runs every frame — silent, itemless,
        // skips bomb-immune lasers.
        this.respawnClearFrames--;
        this.clearEnemyBullets();
        this.cancelLasers(false);
      }
      this.stageFrame++;
    }
    for (const runner of this.stageIntroRunners) {
      if (!runner.removed) runner.update(this.slowRate);
    }
    if (this.stageTransitionTiles.some((tile) => !tile.runner.removed)) {
      this.stageTransitionTimer++;
      for (const tile of this.stageTransitionTiles) tile.runner.update(this.slowRate);
    }
    if (this.spellBanner > 0) this.spellBanner--;
    if (this.spellcard) {
      this.spellcard.declAge++;
      for (const runner of this.spellBackgroundRunners) runner.update(this.slowRate);
    }
    if (this.bonusPopup && --this.bonusPopup.timer <= 0) this.bonusPopup = null;
    if (this.borderMessage) {
      this.borderMessage.age++;
      if (--this.borderMessage.timer <= 0) this.borderMessage = null;
    }
    if (!frozen) {
      // FUN_0043eef0 returns before the state-4 border timer while dialogue
      // freeze DAT_0061c25c is set; the 540-frame clock pauses with gameplay.
      const borderBonus = this.cherry.tick(this.slowRate);
      if (borderBonus > 0) this.addScore(borderBonus);
      // Native scheduler order (FUN_0042e420 + priority registrations):
      // player(8) -> enemies(10) -> effects(11) -> item+bullets/lasers(12).
      // Inside the player callback, existing shots move before the firing
      // pass allocates new shots (FUN_0043eef0 @ all.c:29061-29063).
      // FUN_0043eef0 keeps calling MOVE/ANM -> FIRE -> aim-cache reset while
      // timestamp-only MSG is active (DAT_0061c25c remains zero).  Player
      // update above prevents a disarmed cycle from re-arming; fire() still
      // drains any cycle that was already armed when the message began.
      this.updatePlayerBullets();
      this.firePlayerBullets(allowShotSpawnThisTick);
      // FUN_0043edc0 runs after firing and clears both target snapshots.
      // The enemy manager below repopulates them for the NEXT player tick.
      this.clearPlayerAimCaches();
    }
    // FUN_0041ed50 (priority 10) and the generic effect manager (priority
    // 11) do NOT honor DAT_0061c25c. Full story dialogue freezes the player
    // and priority-12 item/bullet callback, but invisible ECL controllers,
    // enemies, movement/collision and ambient effects continue. The only
    // enemy-tail exception is the boss timer, gated in tickEnemyManagerTail.
    this.updateEnemies();
    if (this.focusEffectRunner && !this.focusEffectRunner.removed) {
      this.focusEffectRunner.update(this.slowRate);
    }
    this.updateParticles();
    if (!frozen) {
      // FUN_004241c0 calls the item manager at the head of the priority-12
      // bullet callback (all.c:16039-16042). Items therefore update after
      // effects, before bullets/lasers, and freeze with dialogue gameplay.
      // Cancellation items created later in this callback wait until the
      // next frame for their first update.
      this.updateItems();
      this.updateBullets();
      this.updateLasers();
      if (this.postBombLaserCounter > 0) this.postBombLaserCounter--;
    }
    // The MSG manager is registered at priority 13 (FUN_00426656 via
    // FUN_0042e290(..., 0xd), all.c:18954), after enemies/effects and the
    // item+bullet+laser priority-12 callback. A timeline op8 created inside
    // this frame's enemy manager therefore gets its first interpreter tick
    // at this tail, not at the start of the next frame. `frozen` remains the
    // frame-start snapshot above: a dialogue that already existed freezes
    // this frame's gameplay, then may advance/end here; a newly-created empty
    // entry can end here without inventing a one-frame freeze next tick.
    // The message/stage mini-VM force-completes any engaged Border before
    // advancing its own script (FUN_00428392 -> FUN_0043e620,
    // all.c:17791-17793). This is distinct from the global gameplay-freeze
    // predicate: timestamp-only dialogue is active here too.
    if (this.isDialogueActive() && this.cherry.borderEngaged) {
      const forcedBorderBonus = this.cherry.forceBorderSurvival();
      if (forcedBorderBonus > 0) this.addScore(forcedBorderBonus);
    }
    if (this.dialogue) {
      // FUN_00428392 @ 0x428442 runs after the priority-12 item manager and
      // calls FUN_00431d10 on every live MSG tick (except player state 2).
      // This ordering matters for dialogue-start enemy drops: they first get
      // one ordinary falling tick, then are latched with velocity (0,-0.5).
      // Native Phantasm PRE3966 pins slot 1002 at (169.960052,125.800003),
      // state=1, age=1; pre-homing it at updateItems' head moved it 8 px too
      // soon and shifted three large-Cherry pickup frames.
      if (!p.hitState && p.dyingFrame < 0) this.forceCollectAllItems();
      this.dialogue.update(input.pressed.has('shoot'), input.held.has('skip'));
      if (this.dialogue.resumeTicket) {
        this.dialogue.resumeTicket = false;
        this.dialogueResume = true;
      }
      if (this.dialogue.done) this.dialogue = null;
    }
    // Bomb over: release the interrupt-gated bomb visuals (label 1 is the
    // fade-out path in the player bomb scripts) and tear down the form runner.
    if (this.prevBombTimer > 0 && p.bombTimer === 0) {
      this.finishBombPresentation();
    }
    this.prevBombTimer = p.bombTimer;
    this.playerEffects.update(this.slowRate);
    this.tickScreenFx();
    // The stage object arms its results screen on the same scheduler tick
    // that the last authored timeline wait is consumed. Native Stage 1 has
    // PRE10475 and then leaves gameplay; there is no PRE10476 player tick.
    // The former synthetic 180-frame grace let the ambient Sub1 manager run
    // one extra snow tick in the recorded stream and delayed the clear bonus
    // beyond the replay boundary.
    if (!this.stageClear && this.runtime.isTimelineComplete() && !this.bossActive && this.enemies.length <= 1) {
      if (!this.stageResultsActive) this.activateStageResults();
      this.finishStageResults();
      this.audio.fadeOutBgm(4);
    }
    if (this.score > this.hiScore) this.hiScore = this.score;
  }

  private finishBombPresentation(): void {
    this.playerEffects.interruptAll(1);
    this.bombRunner = null;
    this.bombEngine.reset();
    this.activeBombSlots.length = 0;
    // Do not clear player+0x17dc here. FUN_0043d8f0 owns that pool and keeps
    // aging its entries every player tick even after +0x16a20 (bomb-active)
    // reaches zero. ReimuA orb 7's detonation circle therefore outlives the
    // attack VM and clears Phantasm slot 883 on update 10549 before graze.
  }

  private onBombUsed(): void {
    const p = this.playerObj;
    this.bombActiveThisFrame = true;
    p.bombCherryDrain = bombCherryDrainPerFrame(
      p.character,
      p.bombFocused,
      this.difficulty,
      this.cherry.cherry,
      Math.trunc(p.bombTimer)
    );
    this.playSfx(14);
    // Th07.exe: bomb activation spawns an ANM VM (FUN_00407620 → FUN_0041b770(0x19))
    // whose init reseeds 2 object fields via FUN_00401700 (rand%100000 + 0x198f),
    // consuming exactly 8 RNG draws at the activation frame — NOT a 24-particle
    // flash. The values are presentation-only ANM state; only the draw count feeds
    // the shared stream. Model it as 2 effect particles (2 × 4 draws = 8).
    this.spawnEffectParticles(3, this.playerObj.x, this.playerObj.y, 2, 0xffffffff);
    // FUN_0043d9a0 @ 0x43dc31-0x43dc40: every successful bomb subtracts
    // 200 rank points. A free Border break never enters this path.
    this.adjustRank(-200);
    // Th07.exe FUN_00431d10: bombing flags every live item for collection
    // (same state=1 autocollect the border uses in updateItems).
    this.forceCollectAllItems();
    this.bombEngine.reset();
    this.bombFrame = 0;
    this.bombDuration = this.playerObj.bombTimer;
    // FUN_00407620: the shared activation presentation (a reserved-slot ANM
    // VM tied to the invuln duration) — represented here by the character's
    // own bomb ANM scripts plus the runner's choreography.
    // Th07.exe FUN_00407840 (ReimuA) @0x407862: the activation writes a fixed-center
    // expanding-circle bullet-clear region via FUN_0043e7e0(player+0x930, r0=32, grow=8,
    // life=16, 6) into the player+0x17dc pool. Native-verified: center = player snapshot
    // at cast, radius 32→160 at +8/frame over 17 frames. Other characters' activation
    // blasts (different r0/grow) are not yet traced — add per character as converged.
    if (p.character === 'reimuA') {
      this.allocateBombClearRegion(p.x, p.y, 32, 8, 17);
    }
    this.bombRunner = new BombRunner(this.bombEngine, p.character, p.bombFocused);
    this.bombRunner.start(this.refreshBombContext());
    this.spawnBombEffects();
  }

  private allocateBombClearRegion(
    x: number,
    y: number,
    radius: number,
    growth: number,
    framesLeft: number
  ): boolean {
    // Th07.exe FUN_0043e7e0 scans player+0x17dc from slot zero and writes
    // the first free entry. Full pools reject the request without allocating.
    for (const region of this.bombClearRegions) {
      if (region.framesLeft > 0) continue;
      region.x = Math.fround(x);
      region.y = Math.fround(y);
      region.radius = Math.fround(radius);
      region.growth = Math.fround(growth);
      region.framesLeft = framesLeft;
      return true;
    }
    return false;
  }

  private createBombContext(): BombContext {
    const p = this.playerObj;
    return {
      player: p,
      fx: this.playerEffects,
      rng: this.rng,
      frame: Math.floor(this.bombFrame),
      elapsed: this.bombFrame,
      duration: this.bombDuration,
      focused: p.bombFocused,
      rate: this.slowRate,
      enemies: this.enemies,
      enemyBullets: this.enemyBullets,
      playSfx: (id) => this.playSfx(id),
      spawnParticles: (effectId, x, y, count, color) => this.spawnEffectParticles(effectId, x, y, count, color),
      startScreenShake: (duration, from, to) => this.startScreenShake(duration, from, to),
      addBulletClearRegion: (x, y, radius, growth, frames) => {
        // FUN_0043e7e0 allocates the first free player+0x17dc entry. The
        // pool is advanced by FUN_0043d8f0 at the head of the next player
        // tick; a life-0 entry therefore survives only the current bullet
        // manager pass, while life-N entries are observed for N+1 passes.
        this.allocateBombClearRegion(x, y, radius, growth, frames + 1);
      },
      createBombAnmRunner: (scriptId) => new AnmRunner(p.anm, scriptId, { rng: this.rng })
    };
  }

  private refreshBombContext(): BombContext {
    const ctx = this.bombContext;
    const p = this.playerObj;
    ctx.frame = Math.floor(this.bombFrame);
    ctx.elapsed = this.bombFrame;
    ctx.duration = this.bombDuration;
    ctx.focused = p.bombFocused;
    ctx.rate = this.slowRate;
    return ctx;
  }

  // Per-frame bomb choreography: the active form's decoded state machine
  // writes moving attack slots into the pool each frame (Th07.exe bomb tick
  // functions 0x407840-0x40cbf0; specs spec-bombs-{shared,reimu,marisa,
  // sakuya}.md). Slot consumption below is exe-exact.
  private tickBombChoreography(): void {
    if (!this.bombRunner) return;
    this.bombRunner.tick(this.refreshBombContext());
  }

  // Bomb visuals, per shot type, from the character's own playerXX.anm bomb
  // scripts (decoded from the embedded data; script ids and their behavior
  // are the original's, the spawn cadence/anchor offsets below are flagged
  // approximations — the exe routine that places them is not reimplemented;
  // AGENTS.md §7).
  private spawnBombEffects(): void {
    const p = this.playerObj;
    const fx = this.playerEffects;
    const dur = p.bombTimer;
    switch (p.character) {
      case 'reimuA': {
        // 夢想封印: colored orbs (player00.anm scr133-136, offset-mode wander
        // + interrupt-1 fade) drifting outward in two waves.
        for (let wave = 0; wave < 2; wave++) {
          for (let i = 0; i < 4; i++) {
            const angle = -Math.PI / 2 + (i - 1.5) * 0.55 + (wave ? 0.27 : 0);
            fx.spawn({
              scriptId: 133 + i,
              x: p.x, y: p.y,
              vx: Math.cos(angle) * 1.1,
              vy: Math.sin(angle) * 1.1,
              delay: wave * 40
            });
          }
        }
        break;
      }
      case 'reimuB':
        // 封魔陣: the big seal circles (scr141-143) plus the four cross
        // beams sweeping out from the cast point (scr137-140).
        for (const id of [141, 142, 143, 137, 138, 139, 140]) fx.spawn({ scriptId: id, x: p.x, y: p.y });
        break;
      case 'marisaA':
        // スターダストレヴァリエ: magic circle (scr71) at the cast point;
        // star bursts (scr98-104) respawn per-frame in applyBombEffects.
        fx.spawn({ scriptId: 71, x: p.x, y: p.y, ttl: dur });
        break;
      case 'marisaB':
        // マスタースパーク: magic circle (scr72) + the star-column beam
        // layers (scr73-78, interrupt-1 releases their fade) tiled up the
        // playfield from the muzzle; bursts along the beam come from
        // applyBombEffects.
        fx.spawn({ scriptId: 72, x: p.x, y: p.y, ttl: dur });
        for (let tier = 0; tier < 3; tier++) {
          const y = p.y - 56 - tier * 94;
          fx.spawn({ scriptId: 73 + tier, x: p.x, y });
          fx.spawn({ scriptId: 76 + tier, x: p.x, y });
        }
        break;
      case 'sakuyaA': {
        // 殺人ドール: a ring of knives (scr5/6 trails) thrown outward, with
        // the red/blue "world" squares (scr9/10) flashing at the cast point.
        fx.spawn({ scriptId: 9, x: p.x, y: p.y });
        fx.spawn({ scriptId: 10, x: p.x, y: p.y });
        for (let i = 0; i < 16; i++) {
          const angle = (i / 16) * Math.PI * 2;
          fx.spawn({
            scriptId: 5 + (i & 1),
            x: p.x, y: p.y,
            vx: Math.cos(angle) * 3.2,
            vy: Math.sin(angle) * 3.2,
            rotation: angle + Math.PI / 2
          });
        }
        break;
      }
      case 'sakuyaB':
        // プライベートスクウェア: the staggered grow/shrink world squares
        // (scr9-12) under the two slow-rotating additive overlays (scr13/14,
        // ~300f — the time-stop tint for the whole bomb).
        for (const id of [9, 10, 11, 12, 13, 14]) fx.spawn({ scriptId: id, x: p.x, y: p.y - 96 });
        break;
    }
  }

  private prepareBombEffects(): void {
    // Per-form choreography updates the attack-slot pool (Th07.exe bomb tick
    // functions 0x407840-0x40cbf0 write player+0x9dc slots each frame).
    this.tickBombChoreography();
    this.bombFrame += this.slowRate;
    // Choreography has fixed active/radius state for the rest of this frame.
    // Cache the ordered object references instead of restarting the 112-slot
    // generator for every enemy and every bullet in a dense field.
    this.refreshActiveAttackSlots();
  }

  private refreshActiveAttackSlots(): void {
    this.activeBombSlots.length = 0;
    for (const slot of this.bombEngine.activeSlots()) this.activeBombSlots.push(slot);
  }

  // Compatibility seam for focused unit tests that exercise bomb collision
  // without running the full scheduler. Shipped gameplay uses the native
  // per-enemy/per-bullet interleaving above.
  private applyBombEffects(): void {
    this.bombEngine.beginFrame();
    this.prepareBombEffects();
    for (const e of this.enemies) this.collideBombSlots(e);
    for (const b of this.enemyBullets) this.cancelBulletWithBombSlots(b);
  }

  private collideBombSlots(e: Enemy, hitbox = e.ecl.hitbox): void {
    // FUN_0043a980 is entered for interactable shot-collision actors even
    // while ECL op103 has cleared canTakeDamage. Contacts still accumulate
    // raw damage, Cherry/score, the global hit tally, and impact effects;
    // only settlePendingDamage's final HP subtraction is bit2-gated
    // (Th07.exe v1.00b FUN_0041ed50 @ 0x41fa76). Extra PRE7692 is the
    // concrete witness: an op103(0) actor receives all 16 focused-beam
    // history-helper contacts and four id5 effects without losing HP.
    if (!e.ecl.interactable || !e.ecl.shotCollision) return;
    // FUN_0043a980 scans attack slots 0..111 after the 96 player-shot slots.
    for (const s of this.activeBombSlots) {
      const hw = (hitbox.x + s.radiusX) / 2;
      const hh = (hitbox.y + s.radiusY) / 2;
      if (Math.abs(e.x - s.x) > hw || Math.abs(e.y - s.y) > hh) continue;
      this.damageEnemy(
        e,
        s.damage,
        s.source === 'shot' && !this.bombActiveThisFrame ? 'shot' : 'bomb'
      );
      s.hitTally += s.damage;
      // Player+0x240c is one global hit counter. Every fourth attack-slot
      // contact emits id3 for slots 0..95, id5 for slots 96..111
      // (FUN_0043a980 @ all.c:27687-27712).
      if ((++this.playerHitTally & 3) === 0) {
        this.spawnEffectParticles(s.poolSlot < 0x60 ? 3 : 5, e.x, e.y, 1, 0xffffffff);
      }
    }
  }

  private beginBulletClearFade(
    b: EnemyBullet,
    itemType?: ItemType,
    ignoreClearImmunity = false
  ): boolean {
    if (b.clearFadeFrames != null || b.dead || (!ignoreClearImmunity && (b.flags & 0x1000) !== 0)) return false;
    if (itemType) this.spawnItem(itemType, b.x, b.y, { state: 1 });
    // Th07.exe (v1.00b) FUN_004241c0 @ 0x424633 enters state 5. The
    // authored removal ANM keeps the fixed slot occupied for 12 following
    // manager ticks (Phantasm native slot 666: PRE10463..PRE10474), moving
    // at half velocity before FUN_00416c90 releases it.
    b.clearFadeFrames = 12;
    b.clearRunner = this.runtime?.createBulletClearRunner(b.sprite) ?? undefined;
    return true;
  }

  private beginBombClearFade(b: EnemyBullet): boolean {
    return this.beginBulletClearFade(b, 'cherry');
  }

  private cancelBulletWithBombSlots(b: EnemyBullet): boolean {
    if (b.dead || b.clearFadeFrames != null || (b.flags & 0x1000) !== 0) return false;
    // FUN_0043b040 (all.c:27726): the +0x17dc clear-region pool — the activation
    // expanding blast plus the moving seal orbs — is scanned BEFORE the graze box.
    // Both FUN_0043b350 (clear/graze, age > 15) and FUN_0043b200 (clear/hit,
    // every other normal bullet) call it first. Clear regions therefore also
    // consume young or already-grazed bullets; the 16-frame gate is graze-only.
    for (const r of this.bombClearRegions) {
      if (r.framesLeft <= 0) continue;
      const dx = b.x - r.x;
      const dy = b.y - r.y;
      if (dx * dx + dy * dy < r.radius * r.radius) {
        return this.beginBombClearFade(b);
      }
    }
    // ReimuA's moving r128 circles are published explicitly by its state-1
    // bomb VM into bombClearRegions above. Do not infer them from attack
    // slots: the state-2/landmine r256 damage slots have no matching
    // FUN_0043e7e0 call and must not clear bullets (Phantasm PRE10470).
    // SakuyaB likewise: the focused cast publishes its own r96 one-pass
    // circle each frame (FUN_0040cbf0 -> FUN_0043e7e0) and the unfocused
    // cast clears no bullets at all (freeze-only), so neither may fall
    // back to the damage-slot boxes.
    if (this.playerObj.character === 'reimuA' ||
        this.playerObj.character === 'sakuyaB' ||
        (this.playerObj.character === 'marisaB' && !this.playerObj.bombFocused)) return false;
    for (const s of this.activeBombSlots) {
      // The attack-slot pool also carries MarisaB's persistent player-shot
      // beam helpers (slots 96+). FUN_0043b040 scans the separate
      // player+0x17dc clear-region pool, never those shot helpers. Keep this
      // compatibility fallback bomb-owned only: otherwise the six beam
      // helpers falsely clear Extra slots 164/168/172 before PRE1163.
      if (s.source === 'shot') continue;
      if (Math.abs(b.x - s.x) > s.radiusX / 2 || Math.abs(b.y - s.y) > s.radiusY / 2) continue;
      // Bomb attack-slot contact becomes a type-6 auto-collecting Cherry
      // item; unlike a Border break this remains strictly spatial.
      return this.beginBombClearFade(b);
    }
    return false;
  }

  // Fires once when the deathbomb window lapses (tickDeath 'effects'): the
  // death explosion, power drops, bullet clear. The respawn itself (teleport +
  // materialize) is deferred to onPlayerRespawn() after the 30-frame death
  // squish, matching Th07.exe fcn.0043dca0.
  private onPlayerDeath(): void {
    const p = this.playerObj;
    this.voidSpellCapture();
    // No SE/effects here: the exe front-loads the death SE and both hit
    // bursts onto the hit frame itself (FUN_0043bd60, see onPlayerHit); the
    // meter-zero commit only runs the drop/penalty bookkeeping + squish.
    // Th07.exe FUN_0043dca0 @ all.c:28601-28641: the power penalty applies
    // BEFORE the drops, so death drops can never hit the >=128 spawn-time
    // bigCherry conversion, and the branch picks the drop set:
    //  - power < 1: 5x fullPower (a pity refund), cherry penalty skipped;
    //  - else: power = 0 if < 17, otherwise -16, then 1x bigPower +
    //    5x power, then the cherry penalty.
    // (An earlier port spawned 5x power before the -16 landed 30 frames
    // later in the respawn — at max power those converted to bigCherry,
    // the tester's inconsistent miss-drop report.)
    if (p.power < 1) {
      for (let i = 0; i < 5; i++) this.spawnDeathDrop('fullPower', p.x, p.y);
    } else {
      p.power = p.power < 17 ? 0 : p.power - 16;
      this.spawnDeathDrop('bigPower', p.x, p.y);
      for (let i = 0; i < 5; i++) this.spawnDeathDrop('power', p.x, p.y);
      this.cherry.onDeath(p.sht.cherryLossOnDeath, p.character.startsWith('sakuya'));
    }
    // FUN_0043dca0 @ 0x43df6a-0x43df79: the miss penalty lands after the
    // power/cherry/drop bookkeeping, on the death-commit frame.
    this.adjustRank(-0x640);
    // The exe does NOT clear the field at the miss — the respawn arms a
    // 60-frame continuous silent cancel instead (see onPlayerRespawn).
    this.playerEffects.clear();
  }

  // Th07.exe FUN_00430970 spawn mode 2 (all.c:21852-21862): every death drop
  // launches from the fixed death point toward its own random target at
  // x = rand*288+48, y = rand*192-64 (playfield coords; constants @
  // 0x48eccc/0x48eb94/0x48ecc8/0x48eb68), riding a 60-frame positional lerp
  // (FUN_00430c10 all.c:21936-21956) before dropping to normal fall from
  // rest. Velocity starts zeroed — the exe reuses those fields as the tween
  // origin while state==2.
  private spawnDeathDrop(type: ItemType, x: number, y: number): void {
    const tx = this.rng.f() * 288 + 48;
    const ty = this.rng.f() * 192 - 64;
    this.spawnItem(type, x, y, { vx: 0, vy: 0, tweenTarget: { tx, ty } });
  }

  // Fires once when the death squish finishes (tickDeath 'respawn'): teleport
  // to the spawn point and enter the materialize state. fcn.0043dca0 loses the
  // life at this teleport, not at the hit.
  private onPlayerRespawn(): void {
    const p = this.playerObj;
    p.die();
    // Th07.exe FUN_0043e170 (respawn/materialize init, all.c:28657) arms
    // player+0x2400 = 60; while it counts down, FUN_0043e2e0 runs
    // FUN_00422ea0(0) every frame — a silent, itemless field clear that
    // gives the respawned player a bullet-free bubble.
    this.respawnClearFrames = 60;
    if (p.lives < 0) {
      this.gameOver = true;
      // PCB offers 3 continues per game; past that it's a straight game over.
      if (this.mode === 'arcade' && this.continuesUsed < 3) {
        this.continueScreen = { cursor: 0 };
      }
    }
  }

  // -- pause menu -------------------------------------------------------------

  private openPause(): void {
    const ascii = this.assets.anms.ascii;
    const entryIndex = 2; // data/ascii/pause.png
    const entry = ascii.entries[entryIndex];
    if (!entry) return;
    const runners: AnmRunner[] = [];
    for (let id = 0; id <= 6; id++) {
      if (!ascii.hasScriptInEntry(entryIndex, id)) return;
      runners.push(new AnmRunner(ascii, id, { entryIndex, spriteIndexOffset: entry.spriteBase }));
    }
    // Scripts 0-3 = 一時停止 + the three menu rows; 4-6 = the confirm set.
    for (let i = 0; i <= 3; i++) runners[i].interrupt(1);
    this.pauseState = { cursor: 0, confirm: false, confirmCursor: 1, closing: 0, action: null, runners };
    this.playSfx(37); // se_pause
  }

  private updatePause(input: InputFrame): void {
    const ps = this.pauseState!;
    for (const runner of ps.runners) runner.update(1);
    if (ps.closing > 0) {
      if (--ps.closing === 0) {
        const action = ps.action;
        this.pauseState = null;
        if (action === 'title') this.exitToTitle();
        else if (action === 'retry') this.onRetryRun?.();
      }
      return;
    }
    const select = () => this.audio.sfx('se_select00', 0.141, 12);
    if (ps.confirm) {
      if (input.pressed.has('up') || input.pressed.has('down')) {
        ps.confirmCursor ^= 1;
        select();
      }
      if (input.pressed.has('shoot') || input.pressed.has('confirm')) {
        if (ps.confirmCursor === 0) {
          this.audio.sfx('se_ok00', 0.316, 10);
          this.beginPauseClose(ps.cursor === 1 ? 'title' : 'retry');
        } else {
          this.pauseConfirmBack(ps);
        }
      } else if (input.pressed.has('back') || input.pressed.has('bomb')) {
        this.pauseConfirmBack(ps);
      }
      return;
    }
    if (input.pressed.has('up')) {
      // Replay playback exposes only Resume / Return to Title; the native
      // replay-bit branch never lets the cursor reach Retry (FUN_004023c0).
      ps.cursor = this.mode === 'replay' ? ps.cursor ^ 1 : (ps.cursor + 2) % 3;
      select();
    } else if (input.pressed.has('down')) {
      ps.cursor = this.mode === 'replay' ? ps.cursor ^ 1 : (ps.cursor + 1) % 3;
      select();
    }
    if (input.pressed.has('shoot') || input.pressed.has('confirm')) {
      if (ps.cursor === 0) {
        this.audio.sfx('se_ok00', 0.316, 10);
        this.beginPauseClose('resume');
      } else {
        // Both destructive rows confirm through 本当に？ (default いいえ).
        this.audio.sfx('se_ok00', 0.316, 10);
        ps.confirm = true;
        ps.confirmCursor = 1;
        for (let i = 0; i <= 3; i++) ps.runners[i].interrupt(2);
        for (let i = 4; i <= 6; i++) ps.runners[i].interrupt(1);
      }
    } else if (input.pressed.has('back') || input.pressed.has('bomb') || input.pressed.has('pause')) {
      this.audio.sfx('se_cancel00', 0.316, 11);
      this.beginPauseClose('resume');
    }
  }

  private pauseConfirmBack(ps: NonNullable<typeof this.pauseState>): void {
    this.audio.sfx('se_cancel00', 0.316, 11);
    ps.confirm = false;
    for (let i = 4; i <= 6; i++) ps.runners[i].interrupt(2);
    for (let i = 0; i <= 3; i++) ps.runners[i].interrupt(1);
  }

  private beginPauseClose(action: 'resume' | 'title' | 'retry'): void {
    const ps = this.pauseState!;
    ps.action = action;
    ps.closing = 20; // the authored hide interrupt fades over 20 frames
    for (const runner of ps.runners) runner.interrupt(2);
  }

  private drawPause(r: Renderer): void {
    const ps = this.pauseState!;
    const ctx = r.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, 640, 480);
    ctx.restore();
    ps.runners.forEach((runner, i) => {
      if (this.mode === 'replay' && i === 3) return;
      const frame = runner.spriteFrame();
      if (!frame) return;
      // Cursor highlight: unselected rows draw tinted down (the authored
      // scripts carry no selected/unselected variants — approximation).
      const selected = ps.confirm
        ? (i === 5 && ps.confirmCursor === 0) || (i === 6 && ps.confirmCursor === 1)
        : i === ps.cursor + 1;
      const isRow = ps.confirm ? i >= 5 : i >= 1 && i <= 3;
      r.drawAnmFrame(frame, 0, 0, isRow && !selected ? { color: 0xff707070 } : {});
    });
  }

  // -- arcade flow (continue screen / scene exit) ----------------------------

  private updateContinueScreen(input: InputFrame): void {
    const cs = this.continueScreen!;
    if (input.pressed.has('up') || input.pressed.has('down') || input.pressed.has('left') || input.pressed.has('right')) cs.cursor ^= 1;
    if (input.pressed.has('shoot') || input.pressed.has('confirm')) {
      if (cs.cursor === 0) this.doContinue();
      else this.declineContinue();
      return;
    }
    if (input.pressed.has('bomb') || input.pressed.has('back')) {
      if (cs.cursor === 1) this.declineContinue();
      else cs.cursor = 1;
    }
  }

  private doContinue(): void {
    const p = this.playerObj;
    this.continuesUsed++;
    // The original's famous continue penalty: the score is wiped and becomes
    // the number of continues used.
    this.score = this.continuesUsed;
    p.lives = 2;
    p.bombs = Math.trunc(p.unfocused.bombs);
    this.gameOver = false;
    this.gameOverTimer = 0;
    this.continueScreen = null;
    this.playSfx(10); // se_ok00
  }

  private declineContinue(): void {
    this.continueScreen = null;
    this.gameOverTimer = 0; // gameOver stays set; update() exits after the linger
  }

  private exitToTitle(): void {
    if (this.exitFired) return;
    this.exitFired = true;
    this.audio.fadeOutBgm(1);
    this.onExitToTitle?.();
  }

  // Accumulates a hit into the enemy's per-frame damage pool; the pool is
  // settled once per frame by settlePendingDamage() through the exe's exact
  // pipeline (Th07.exe FUN_0041ed50). NOT gated on canTakeDamage — in the
  // exe, hits on an invulnerable boss still award score and cherry (the
  // bit2 check only guards the HP subtraction).
  damageEnemy(e: Enemy, damage: number, kind: 'shot' | 'bomb' = 'shot'): void {
    if (!e.ecl.interactable || e.ecl.invisible) return;
    // Th07.exe FUN_0043a980 @ 0x43a9e6: while the player's own bomb is
    // active (player+0x16a20), each SHOT deals table/3 damage, min 1.
    if (kind === 'shot' && this.bombActiveThisFrame) {
      damage = Math.max(1, Math.trunc(damage / 3));
    }
    if (kind === 'shot') e.pendingShotDmg += damage;
    else e.pendingBombDmg += damage;
  }

  // Th07.exe FUN_0041ed50 damage pipeline (all.c:14174-14253), run once per
  // enemy per frame:
  //   raw = this frame's shot+bomb sum (shots pre-scaled /3 during a bomb)
  //   cherry gain from the PRE-cap raw sum (its own internal 70 cap)
  //   raw capped at 70 (0x46 @ all.c:14226 — TH07-confirmed, not TH06 lore)
  //   score += capped/5
  //   if canTakeDamage:
  //     spell card active (DAT_012f40a8): shots-only → /7 (min 1);
  //       any bomb contribution → 0 unless a bomb was triggered during this
  //       spell (DAT_012f40bc latch), then /2.5 (min 1; DAT_0048eda8=2.5,
  //       disasm @ 0x41fafa-0x41fb0e)
  //     op-142 shield active: boss → /9, non-boss → 0
  //     hp -= result
  private settlePendingDamage(e: Enemy): boolean {
    let shotRaw = e.pendingShotDmg;
    const bombRaw = e.pendingBombDmg;
    const raw = shotRaw + bombRaw;
    const hadBomb = bombRaw > 0;
    e.pendingShotDmg = 0;
    e.pendingBombDmg = 0;
    // Zeroed every frame like the exe's enemy+0x2e4c (all.c:14173) and set
    // to the HP actually removed below — ECL var 10061 (the Prismrivers'
    // op43 damage-sharing poll) reads it.
    e.damageThisFrame = 0;
    if (raw <= 0) return hadBomb;
    // Replay load writes DAT_00625627 as the complete shot byte
    // character*2+type (0 ReimuA .. 5 SakuyaB), not merely the A/B bit.
    // The quirks below compare it to zero and therefore apply to ReimuA only.
    const shotIndex = this.shotIndex;
    // Cherry gain uses the UNREDUCED damage — the exe computes it before
    // the per-stage reductions below (all.c:14189 vs 14200-14209). The
    // divisor input is the STAGE number (local_14 = min(stage*2,10),
    // all.c:13997-14003 — DAT_0062583c is the stage, not the difficulty;
    // spec-extra-phantasm.md §0).
    // DAT_004ca4d8 gates the complete Cherry-on-hit branch at 0x41f8ed.
    // Attack contacts still damage and score during a bomb, but never add
    // Cherry or Cherry+ while the bomb-active flag is set.
    if (!this.bombActiveThisFrame) {
      this.cherry.onShotHit(
        raw,
        e.ecl.isBoss,
        this.stageNumber,
        shotIndex,
        (e.ecl.bossTimer & 1) === 1,
        this.playerObj.focusHeld
      );
    }
    // Per-stage ReimuA shot-damage reduction vs NON-boss enemies
    // (all.c:14198-14209, gated on DAT_00625627=='\0' and bit6 clear):
    // stage 4 -> dmg - dmg/4 - dmg/16 (11/16), stages 5-6 -> dmg/2.
    if (shotIndex === 0 && !e.ecl.isBoss && shotRaw > 0) {
      if (this.stageNumber === 4) {
        shotRaw = shotRaw - Math.trunc(shotRaw / 4) - Math.trunc(shotRaw / 16);
      } else if (this.stageNumber === 5 || this.stageNumber === 6) {
        shotRaw = Math.trunc(shotRaw / 2);
      }
    }
    let dmg = Math.min(70, shotRaw + bombRaw);
    this.addScore(Math.trunc(dmg / 5));
    if (!e.ecl.canTakeDamage) return hadBomb;
    if (this.spellcard) {
      if (!hadBomb) dmg = dmg >= 8 ? Math.trunc(dmg / 7) : dmg > 0 ? 1 : 0;
      else if (!this.bombDuringSpell) dmg = 0;
      else dmg = dmg > 2 ? Math.trunc(dmg / 2.5) : dmg > 0 ? 1 : 0;
    }
    if (e.ecl.damageShield > 0) dmg = e.ecl.isBoss ? Math.trunc(dmg / 9) : 0;
    e.hp -= dmg;
    e.damageThisFrame = dmg;
    this.settledDamageThisFrame += dmg;
    return hadBomb;
  }

  private updatePlayerBullets(collide = true): void {
    this.syncPlayerBulletSlots();
    // FUN_0043edc0 clears the shared target after the prior firing pass;
    // FUN_0041ed50 repopulates it per enemy after collision but before death.
    // Therefore this player tick consumes the snapshot built last frame,
    // including an enemy killed during that pass.
    const homingTarget = this.homingAim;
    this.homingTargetId = homingTarget?.id ?? null;
    const rate = this.slowRate;
    this.shotCollisionEnabled = collide;
    this.tickLaserSlots();
    for (let slot = 0; slot < PLAYER_BULLET_POOL_CAP; slot++) {
      const b = this.playerBulletSlots[slot];
      if (!b) continue;
      // FUN_0043a290's focus-state teardown runs before the fixed 96-slot
      // loop and writes +0x34a=0. The loop then skips that slot entirely.
      // A focused beam killed by tickLaserSlots must therefore not publish
      // one last frame of history helper boxes (Extra PRE2832 witness).
      if (b.dead) {
        this.playerBulletSlots[slot] = null;
        continue;
      }
      if (b.state === 'fired') {
        if (b.shotType === 1 || b.shotType === 2) this.steerHomingBullet(b, homingTarget);
        else if (b.shotType === 3) {
          // MarisaA missile, Th07.exe FUN_00439650 (exe-player-funcs1.md §4):
          // per-frame random vertical boost from spawn, no age gate, no cap,
          // vx untouched — never routed through angle/speed.
          b.vy -= this.rng.range(0.1) + 0.27;
        } else if (b.shotType === 4 || b.shotType === 5) {
          this.anchorBeamBullet(b);
        }
      } else {
        b.hitAge++;
      }
      // Th07.exe FUN_0043a290: both fired and collided slots keep integrating
      // velocity (× the global rate) every frame; the per-shot ANM VM ticks
      // alongside and the bullet dies when its script removes itself (impact
      // scripts end in remove(); flight scripts end in static and never do).
      // FUN_0043a290 @ all.c:27472-27475 stores each rate-scaled add back
      // into the slot's float32 position fields. Per-tick f32 rounding is
      // observable at long-window id5 collision boundaries (Stages 2/3).
      b.x = Math.fround(b.x + b.vx * rate);
      b.y = Math.fround(b.y + b.vy * rate);
      // Beam release fade: the VM consumes the interrupt only while parked
      // at its waitInt checkpoint (exe FUN_0044aa20 @ all.c:36279) — the
      // request re-tries every frame until then.
      if (b.fadePending && b.runner.waiting) {
        b.runner.interrupt(1);
        b.fadePending = false;
      }
      b.runner.update(rate);
      if (b.runner.removed) {
        b.dead = true;
      } else if (b.shotType !== 4 && b.shotType !== 5) {
        // Player::UpdateShots (0x0043d2f0) culls with the shot VM's LIVE
        // sprite pointer (vm.sprite->widthPx/heightPx into
        // GameManager::IsInBounds @ 0x42bdc7); render visibility is never
        // consulted. ReimuB's orb bullet script (0x442) selects its real
        // 14x46 sprite at time zero, so the engine's 32x32 spawn-template
        // rect culled it above the field one frame before a native f2131
        // hit. spriteSize() exposes the wrapper's current pointer.
        const size = b.runner.spriteSize?.() ?? b.rect;
        const halfW = size.w / 2;
        const halfH = size.h / 2;
        const onscreen = b.x + halfW >= 0 && b.x - halfW <= 384 &&
          b.y + halfH >= 0 && b.y - halfH <= 448;
        if (!onscreen) b.dead = true;
      }
      // FUN_0043a290 advances the split age counter at the tail, after the
      // behavior callback, position integration, cull, and ANM tick.
      b.age += rate;
      if (b.dead && this.playerBulletSlots[slot] === b) this.playerBulletSlots[slot] = null;
    }
    this.compactLive(this.playerBullets);
    this.refreshActiveAttackSlots();
  }

  private firePlayerBullets(allowSpawn: boolean): void {
    if (this.gameOver) return;
    const volley = this.playerObj.fire(this.slowRate, allowSpawn);
    let playedShotSfx = false;
    for (const b of volley) {
      if (b.behaviorFunc === 4) this.aimBulletAtSpawn(b);
      else if (b.behaviorFunc === 5) {
        const spread = b.angle - -Math.PI / 2;
        // The spread angle reads the LIVE angle (player+0xb7e58, already
        // advanced by this tick's tail update) — unlike the spawn POSITION,
        // which comes from the option fields computed pre-advance
        // (renderOrbitAngle). Shot fns run after FUN_0043be00 returns.
        b.angle = Math.fround(this.playerObj.orbitAngle + spread);
        b.vx = Math.fround(Math.cos(b.angle) * b.speed);
        b.vy = Math.fround(Math.sin(b.angle) * b.speed);
      }
      if (!this.addPlayerBullet(b)) {
        b.dead = true;
        for (let i = 0; i < this.playerObj.laserSlots.length; i++) {
          if (this.playerObj.laserSlots[i]?.bullet === b) this.playerObj.laserSlots[i] = null;
        }
        continue;
      }
      if (b.sfxId >= 0) playedShotSfx = true;
    }
    // FUN_00438b70: the shot SE is tied to the accepted spawn event of the
    // one shooter whose SHT record carries sfxId>=0.
    if (playedShotSfx) this.playSfx(0);
  }

  // VALIDATION-EXPERIMENT: exe FUN_0043a980 (all.c:14176), called PER ENEMY
  // inside the enemy manager. Tests every player bullet against ONE enemy,
  // deals IMMEDIATE damage (accumulated into pending, settled this same frame
  // before the death check) and spawns the id5 impact spark — so id5/death
  // draws land in the exe's per-enemy stream order (vs our old bullet-outer
  // pass). A single-hit bullet becomes 'collided' on its first enemy and is
  // then skipped by later enemies (replacing the old inner-loop `break`).
  private collidePlayerShots(e: Enemy): void {
    if (!this.shotCollisionEnabled || !this.playerShotCollisionClockAdvanced) return;
    if (!e.ecl.shotCollision || !e.ecl.interactable || e.ecl.invisible || e.dead) return;
    this.collidePlayerShotsInBox(e, e.ecl.hitbox);
    const second = e.ecl.hitbox2;
    if (!second || second.x <= 0) return;
    const shotBefore = e.pendingShotDmg;
    const bombBefore = e.pendingBombDmg;
    this.collidePlayerShotsInBox(e, second);
    const secondaryShot = e.pendingShotDmg - shotBefore;
    const secondaryBomb = e.pendingBombDmg - bombBefore;
    // FUN_0041ed50's second FUN_0043a980 scan is always mutating (shots can
    // impact and effects spawn), but its damage contributes only when no
    // attack slot set local_18; then the aggregate is truncated /2.5.
    if (secondaryBomb === 0) {
      e.pendingShotDmg = shotBefore + Math.trunc(secondaryShot / 2.5);
      e.pendingBombDmg = bombBefore;
    } else {
      e.pendingShotDmg = shotBefore;
      e.pendingBombDmg = bombBefore;
    }
  }

  private tickPlayerShotCollisionClock(specialState: boolean): void {
    const rate = Math.fround(this.slowRate);
    if (specialState) {
      // Both state-3 invulnerability and state-4 Border setup initialize the
      // timer fraction to zero. FUN_00436a06's <=0.99 slow path then stores
      // current->previous, subtracts the float32 rate, and retreats the
      // integer only when the fraction crosses below zero. This makes the
      // first special-state tick scan, followed by the authored slow cadence.
      if (!this.playerShotCollisionClockSpecial) this.playerShotCollisionClockFrac = 0;
      this.playerShotCollisionClockSpecial = true;
      if (rate > 0.99) {
        // Fast path decrements the current integer without overwriting the
        // -999 previous-value sentinel, so every wall frame scans.
        this.playerShotCollisionClockAdvanced = true;
      } else {
        this.playerShotCollisionClockFrac = Math.fround(this.playerShotCollisionClockFrac - rate);
        if (this.playerShotCollisionClockFrac < 0) {
          this.playerShotCollisionClockFrac = Math.fround(this.playerShotCollisionClockFrac + 1);
          this.playerShotCollisionClockAdvanced = true;
        } else {
          this.playerShotCollisionClockAdvanced = false;
        }
      }
      return;
    }
    if (this.playerShotCollisionClockSpecial) {
      // Both state exits reset the timer's fractional word to zero before
      // returning to the normal incrementing branch.
      this.playerShotCollisionClockFrac = 0;
      this.playerShotCollisionClockSpecial = false;
    }
    if (rate > 0.99) {
      // FUN_00436acc's fast path increments the integer directly and leaves
      // any pre-existing fractional residue untouched.
      this.playerShotCollisionClockAdvanced = true;
      return;
    }
    this.playerShotCollisionClockFrac = Math.fround(this.playerShotCollisionClockFrac + rate);
    if (this.playerShotCollisionClockFrac >= 1) {
      this.playerShotCollisionClockFrac = Math.fround(this.playerShotCollisionClockFrac - 1);
      this.playerShotCollisionClockAdvanced = true;
    } else {
      this.playerShotCollisionClockAdvanced = false;
    }
  }

  private resetPlayerShotCollisionSpecialClock(): void {
    // Th07.exe (v1.00b) FUN_0043e620 @ 0x43e6c0-0x43e6e8 and
    // FUN_0043eb00 @ 0x43ed43-0x43ed68 both enter player state 3 with
    // current=40, frac=0 and previous=-999. `Advanced` describes the scan
    // already selected for the current manager pass, so leave it untouched;
    // the next tick must retreat immediately from the fresh zero fraction.
    this.playerShotCollisionClockFrac = 0;
    this.playerShotCollisionClockSpecial = true;
  }

  private collidePlayerShotsInBox(e: Enemy, hitbox: { x: number; y: number; z: number }): void {
    const anm = this.playerObj.anm;
    // Th07.exe (v1.00b) FUN_0043a980 @ 0x43a9e6-0x43aa13 builds the four
    // ENEMY edges first and fstp-stores each as f32. Bullet edges stay in
    // x87 until the inclusive comparisons. The algebraically equivalent
    // center-distance test rounds at different places; one SakuyaA knife
    // can then move across an edge by a frame and change the aggregated
    // focused-boss Cherry+ award without changing kill/RNG event streams.
    const enemyMinX = Math.fround(Math.fround(e.x) - Math.fround(hitbox.x) * 0.5);
    const enemyMinY = Math.fround(Math.fround(e.y) - Math.fround(hitbox.y) * 0.5);
    const enemyMaxX = Math.fround(Math.fround(e.x) + Math.fround(hitbox.x) * 0.5);
    const enemyMaxY = Math.fround(Math.fround(e.y) + Math.fround(hitbox.y) * 0.5);
    for (let slot = 0; slot < PLAYER_BULLET_POOL_CAP; slot++) {
      const b = this.playerBulletSlots[slot];
      if (!b) continue;
      if (b.dead) continue;
      if (b.state !== 'fired' && b.shotType !== 3) continue;
      const bulletMinX = Math.fround(b.x) - Math.fround(b.hitboxW) * 0.5;
      const bulletMinY = Math.fround(b.y) - Math.fround(b.hitboxH) * 0.5;
      const bulletMaxX = Math.fround(b.x) + Math.fround(b.hitboxW) * 0.5;
      const bulletMaxY = Math.fround(b.y) + Math.fround(b.hitboxH) * 0.5;
      if (bulletMinY <= enemyMaxY && bulletMinX <= enemyMaxX &&
          enemyMinY <= bulletMaxY && enemyMinX <= bulletMaxX) {
        if (b.shotType === 4 || b.shotType === 5) {
          if ((Math.floor(b.age) & 1) === 0) {
            this.damageEnemy(e, b.damage);
            if ((++this.playerHitTally & 7) === 0) this.spawnEffectParticles(5, b.x, e.y, 1, 0xffffffff);
          }
        } else if (b.state === 'collided') {
          if ((Math.floor(b.age) & 1) === 0) {
            b.damage = Math.max(1, Math.trunc(b.damage / 3));
            b.vx *= 0.88;
            b.vy *= 0.88;
            this.damageEnemy(e, b.damage);
            if (Math.floor(b.age) % 6 === 0) this.spawnEffectParticles(5, e.x, e.y, 1, 0xffffffff);
          }
        } else {
          if (b.shotType === 3) {
            const exp = MISSILE_EXPLOSION[b.impactScript - 0x20];
            if (exp) {
              b.hitboxW = exp[0];
              b.hitboxH = exp[0];
              const ang = this.rng.range(Math.PI / 2) - (3 * Math.PI) / 4;
              b.vx = Math.cos(ang) * exp[1];
              b.vy = Math.sin(ang) * exp[1];
            }
          }
          this.damageEnemy(e, b.damage);
          b.state = 'collided';
          if (anm.hasScript(b.impactScript)) {
            b.runner = new AnmRunner(anm, b.impactScript);
            // FUN_0043a980 re-arms the slot through FUN_004486e0 after the
            // player's ANM pass has already run. Its split clock has consumed
            // the synchronous t=0 init, so the first following player tick is
            // t=1; a remove authored at t=20 therefore frees the slot on the
            // twentieth following tick. Starting AnmRunner at zero kept every
            // impact alive one extra frame and changed which SHT record won a
            // full 96-slot pool (native Stage 3 processing frame 2811).
            b.runner.frame = 1;
          }
          this.spawnEffectParticles(5, b.x, b.y, 1, 0xffffffff);
          if (b.shotType !== 3) {
            b.vx /= 8;
            b.vy /= 8;
          }
          this.playSfx(20);
        }
      }
    }
    this.collideBombSlots(e, hitbox);
  }

  // MarisaB laser-slot upkeep, Th07.exe FUN_0043a290 head + the shared
  // timer logic inside FUN_004396a0/FUN_004398e0:
  //  - the countdown ticks every frame; shoot released clamps it to 50;
  //    a bomb or blocking dialogue clamps it to 20;
  //  - dropping below 71 arms the beam ANM's interrupt-1 release fade
  //    (script 75/77: 30f fade then remove — the removal frees the bullet);
  //  - leaving the settled-unfocused state fades slots 0/1; leaving the
  //    settled-focused state (state != 3) hard-frees slot 2;
  //  - timer 0 hard-frees.
  private tickLaserSlots(): void {
    const p = this.playerObj;
    const blocked = this.isDialogueBlocking() || this.bombActiveThisFrame;
    for (let i = 0; i < 3; i++) {
      const slot = p.laserSlots[i];
      if (!slot) continue;
      const b = slot.bullet;
      // FUN_0043a290's owner/countdown array is independent of the 96-shot
      // slot's active flag. An unfocused beam's fade ANM can free its bullet
      // while owner[slotId] remains nonzero and its countdown keeps ticking;
      // only countdown==0 clears that owner. Extra native PRE1923..1940 is
      // the witness (bullet gone, owner still points at slot 6/7). Clearing
      // on runner.removed let the web respawn both beams 39 frames early.
      const wantFocused = b.behaviorFunc === 3;
      if (wantFocused && !p.focusHeld) {
        // exe: 240a != 3 → slot 2's owner is freed outright (+0x34a = 0).
        b.dead = true;
        p.laserSlots[i] = null;
        continue;
      }
      // Th07.exe (v1.00b) FUN_0043a290 @ all.c:27449-27466 decrements
      // only 0 < countdown < 999.  Focused MarisaB seeds the exact 999
      // sentinel, which remains infinite while the armed shot cycle is
      // held; treating it as an ordinary counter made the Extra beam fade
      // after 929 ticks and dropped its slot 0x60..0x6f history helpers at
      // native PRE15036.
      if (slot.timer > 0 && slot.timer < 999) slot.timer -= this.slowRate;
      // FUN_0043a290 checks the shot-cycle counter (+0x169fc), not the raw
      // Z state. Releasing shoot leaves the armed 30-frame cycle running to
      // completion; only after it becomes -1 does the beam clamp to 50.
      if (p.fireFrame < 0 && slot.timer > 50) slot.timer = 50;
      if (blocked && slot.timer > 20) slot.timer = 20;
      if (!wantFocused && p.focusHeld) {
        // Th07.exe (v1.00b) FUN_0043a290 @ 0x43a2c6-0x43a30c writes ANM
        // interrupt request 1 unconditionally when option state leaves the
        // settled-unfocused value, then the fixed shot loop consumes it in
        // FUN_0044aa20 later in the same frame. This is distinct from the
        // per-beam countdown handler, which waits for the VM's waitInt bit.
        // A release fade may already be running here: the second request
        // deliberately restarts it from authored time 30 (Extra native
        // PRE5730 resets VM time 33 -> 31 and keeps the beam through PRE5759).
        b.runner.interrupt(1);
        b.fadePending = false;
        p.laserSlots[i] = null;
        continue;
      }
      if (slot.timer < 71) b.fadePending = true;
      if (slot.timer <= 0) {
        b.dead = true;
        p.laserSlots[i] = null;
      }
    }
  }

  // Per-frame beam anchoring, Th07.exe FUN_004396a0 (type 4) and
  // FUN_004398e0 (type 5). Type 4 rides its option: the beam box spans from
  // the option to the screen top (center optionY/2, full height optionY) and
  // the 14px beam sprite stretches to match (VM scaleY = optionY/14).
  // Type 5 rides the player with 64px of overhang past the top edge. Before
  // shifting its 16-entry ring it projects only the spawning record's cached
  // historyDepth into fixed attack slots 0x60..0x6f.
  private anchorBeamBullet(b: PlayerBullet): void {
    const p = this.playerObj;
    if (b.shotType === 4) {
      const off = p.orbOffset((b.orb === 2 ? 2 : 1) as 1 | 2);
      const optY = p.y + off.y;
      b.x = p.x + off.x + b.anchorX;
      b.hitboxH = optY;
      b.y = optY / 2;
      b.scaleYOverride = optY / 14;
    } else if (b.history) {
      const depth = Math.min(16, b.historyDepth ?? 0);
      for (let i = 0; i < depth; i++) {
        const hpt = b.history[i];
        if (hpt.x < -900) continue;
        this.bombEngine.set(
          0x60 + i,
          Math.fround(hpt.x),
          Math.fround(hpt.y),
          Math.fround(b.hitboxW),
          Math.fround(b.hitboxH),
          1,
          'shot'
        );
      }
      for (let i = 15; i > 0; i--) b.history[i] = b.history[i - 1];
      b.history[0] = { x: Math.fround(b.x), y: Math.fround(b.y) };
      b.x = p.x + b.anchorX;
      b.hitboxH = p.y + 64;
      b.y = p.y / 2 - 32;
      b.scaleYOverride = (p.y + 64) / 14;
    }
  }

  // Per-frame SakuyaA aim-target snapshot (exe player+0x2434/0x2438 copy of
  // the DAT_004b5eec cache). Refreshed at the top of update() — equivalent
  // to the exe's scan at the end of the previous frame's enemy pass, since
  // nothing moves in between.
  private sakuyaAim: { x: number; y: number } | null = null;

  private clearPlayerAimCaches(): void {
    this.homingAim = null;
    this.sakuyaAim = null;
    this.aimBossLocked = false;
  }

  private accumulatePlayerAimCaches(e: Enemy): void {
    // FUN_0041ed50 @ all.c:14258-14300 runs inside the interactable +
    // shot-collision block, after damage but before the death switch. It is
    // intentionally NOT gated on canTakeDamage, and a lethal target remains
    // cached for the next player tick.
    if (e.dead || !e.ecl.interactable || e.ecl.invisible || !e.ecl.shotCollision) return;
    const px = this.playerObj.x;
    const py = this.playerObj.y;
    const sakuya = this.playerObj.character.startsWith('sakuya');
    const angle = Math.atan2(e.y - py, e.x - px);
    const inSakuyaCone = angle >= -2.0943952 && angle < -1.0471976;
    if (e.ecl.isBoss) {
      if (!this.aimBossLocked || !this.homingAim ||
          Math.abs(e.x - px) < Math.abs(this.homingAim.x - px)) {
        this.homingAim = { id: e.id, x: e.x, y: e.y, z: e.z };
      }
      if (sakuya) {
        if (inSakuyaCone && (!this.aimBossLocked || !this.sakuyaAim ||
            Math.abs(e.x - px) < Math.abs(this.sakuyaAim.x - px))) {
          this.sakuyaAim = { x: e.x, y: e.y };
          this.aimBossLocked = true;
        }
      } else {
        this.aimBossLocked = true;
      }
    }
    if (this.aimBossLocked) return;
    // With no locked boss, Reimu's cache chooses the lowest-on-screen enemy
    // (largest Y), not nearest X. Sakuya takes the first cone-qualified actor
    // in ascending pool-slot order.
    if (!this.homingAim || this.homingAim.y < e.y) {
      this.homingAim = { id: e.id, x: e.x, y: e.y, z: e.z };
    }
    if (sakuya && !this.sakuyaAim && inSakuyaCone) this.sakuyaAim = { x: e.x, y: e.y };
  }

  // ReimuA homing amulet (shotType 1) / focused orb (shotType 2), Th07.exe
  // FUN_004391f0/FUN_00439420 (exe-player-funcs1.md §3, byte-identical
  // algorithms bar 4 constants). Operates directly on b.vx/b.vy — angle is
  // never consulted or written. `target` is the per-frame shared cache from
  // updatePlayerBullets, not a per-bullet nearest search.
  private steerHomingBullet(b: PlayerBullet, target: { x: number; y: number } | null): void {
    const maxSpeed = b.shotType === 1 ? 10 : 18;
    const accel = b.shotType === 1 ? 0.33333334 : 0.6;
    const homing = target !== null && b.age <= 39;
    if (!homing) {
      // No target this frame, or the 40-frame homing window (age 0..39)
      // has closed: accelerate toward maxSpeed, preserving direction.
      if (b.speed < maxSpeed) {
        // FUN_004391f0/FUN_00439420 store the updated speed and the vector
        // magnitude to float32 fields/locals before normalizing. Keeping the
        // whole recurrence as JS doubles moves a 30-tick amulet far enough
        // to cross a strict player-shot AABB edge in Phantasm PRE37751.
        b.speed = Math.fround(Math.fround(b.speed) + Math.fround(accel));
        const vx = Math.fround(b.vx);
        const vy = Math.fround(b.vy);
        const mag = Math.fround(Math.sqrt(vx * vx + vy * vy));
        if (mag > 0) {
          b.vx = Math.fround((vx * Math.fround(b.speed)) / mag);
          b.vy = Math.fround((vy * Math.fround(b.speed)) / mag);
        }
      }
      return;
    }
    // Th07.exe (v1.00b) FUN_004391f0 @ 0x439263-0x43937a (and the
    // byte-identical focused handler) fstp-stages every named temporary:
    // target delta, denominator, pull vector, magnitude, speed and final
    // velocity. Preserve those exact single-precision boundaries.
    const dx = Math.fround(Math.fround(target!.x) - Math.fround(b.x));
    const dy = Math.fround(Math.fround(target!.y) - Math.fround(b.y));
    const dist = Math.sqrt(dx * dx + dy * dy);
    let denom = Math.fround(dist / (Math.fround(b.speed) / 4.0));
    if (denom < 1.0) denom = 1.0;
    const pullX = Math.fround(dx / denom + Math.fround(b.vx));
    const pullY = Math.fround(dy / denom + Math.fround(b.vy));
    const magExact = Math.sqrt(pullX * pullX + pullY * pullY);
    const mag = Math.fround(magExact);
    if (mag === 0) return; // degenerate: bullet exactly on target with zero velocity
    let newSpeed = magExact >= maxSpeed ? maxSpeed : mag;
    if (newSpeed < 1.0) newSpeed = 1.0;
    b.speed = Math.fround(newSpeed);
    b.vx = Math.fround((pullX * b.speed) / mag);
    b.vy = Math.fround((pullY * b.speed) / mag);
  }

  // SHT behavior func 0 == 4 (every ply02as shooter): the knife aims at an
  // enemy the moment it spawns, keeping its small per-shooter spread relative
  // to the aim direction — SakuyaA's focused shot converges on one target.
  // Snap-aim (vs a continuous steer) is a flagged approximation of the exe
  // routine the index selects (AGENTS.md §7); with no target it flies by its
  // table angle. behaviorFunc 5 (SakuyaB) is intentionally not handled —
  // semantics unknown, knives fly straight per the table (AGENTS.md §7).
  private aimBulletAtSpawn(b: PlayerBullet): void {
    // Th07.exe FUN_00439070 (funcs[0]=4): aim from the SHOT's spawn position
    // at the frame's shared target snapshot; angle = atan2 + (table angle +
    // π/2) i.e. the record's spread relative to straight up (orbs fan ±20°);
    // speed = table × 1.5 (DAT_0048ec24). Without a target the spawn
    // velocity from the table stays — and no 1.5× boost.
    const target = this.sakuyaAim;
    if (!target) return;
    // FUN_00439070 @ 0x4390c9-0x439105 casts the x87 atan2 result to float
    // BEFORE FUN_0042fff0 adds the record's `(angle + pi/2)` float. That
    // helper then wraps by repeated float32 TAU adds/subtracts. Collapsing
    // this into one JS-double expression shifts SakuyaA knife vx by ~2e-5;
    // native Stage-2 slot 32 then hits at processing 9297 while WT misses its
    // 22px X boundary by 0.00011 and loses one id5 draw event.
    const dx = Math.fround(target.x - b.x);
    const dy = Math.fround(target.y - b.y);
    const aim = Math.fround(Math.atan2(dy, dx));
    const spread = Math.fround(b.angle + NATIVE_HALF_PI_F32);
    // FUN_00439070 writes angle, the 1.5x speed, and the derived vector back
    // into float32 slot fields before the shot's first manager tick.
    b.angle = normalizeNativeAngleF32(aim, spread);
    b.speed = Math.fround(b.speed * 1.5);
    b.vx = Math.fround(Math.cos(b.angle) * b.speed);
    b.vy = Math.fround(Math.sin(b.angle) * b.speed);
  }

  private checkEnemyBulletCollision(b: EnemyBullet): void {
    const p = this.playerObj;
    if (b.dead || this.gameOver || !p.alive) return;
    const dx = Math.abs(b.x - p.x);
    const dy = Math.abs(b.y - p.y);
    if (!b.grazed && b.age > 15 &&
        dx <= b.grazeW / 2 + p.grazeboxHalf + 20 &&
        dy <= b.grazeH / 2 + p.grazeboxHalf + 20) {
      b.grazed = true;
      this.onGrazeAward(b.x, b.y);
    }
    if (dx > b.grazeW / 2 + p.hitboxHalf || dy > b.grazeH / 2 + p.hitboxHalf) return;
    this.onPlayerContact?.('bullet');
    // FUN_0043b200 result 1 consumes the touching bullet while the player is
    // materializing, invulnerable, bombing, or already in the deathbomb state.
    if (p.invulnFrames > 0 || p.bombInvuln > 0 || p.hitState) {
      this.removeEnemyBullet(b);
      return;
    }
    this.onPlayerHit(b);
  }

  private collideEnemyBody(e: Enemy): void {
    const p = this.playerObj;
    if (this.gameOver || !p.alive || !e.ecl.collisionEnabled ||
        !e.ecl.interactable || e.ecl.invisible || e.dead) return;
    // FUN_0041ebc0 runs first at the live head, then at position-history
    // indices 1,7,13,... below. Each call performs graze before body hit.
    this.collideEnemyBodyAt(e, e.x, e.y, e.ecl.hitbox);

    // op138's +0x4f30/+0x4f34 history contract. FUN_0041ed50 samples every
    // sixth record starting at one, stopping before trailStart (all.c:
    // 14154-14171). Bit 1 tapers the hitbox against that same denominator.
    const s = e.ecl;
    if (s.trailFlags === 0 || s.trailStart <= 1) return;
    const limit = Math.min(s.trailStart, s.trailHistory.length);
    for (let i = 1; i < limit; i += 6) {
      const point = s.trailHistory[i];
      const scale = (s.trailFlags & 2) !== 0 ? 1 - i / s.trailStart : 1;
      this.collideEnemyBodyAt(e, point.x, point.y, {
        x: e.ecl.hitbox.x * scale,
        y: e.ecl.hitbox.y * scale,
        z: e.ecl.hitbox.z * scale
      });
    }
  }

  private collideEnemyBodyAt(
    e: Enemy,
    x: number,
    y: number,
    hitbox: { x: number; y: number; z: number }
  ): void {
    const p = this.playerObj;
    const px = p.x;
    const py = p.y;
    // Th07.exe FUN_0041ebc0: enemy bodies are grazable, region hitbox/1.4
    // (= *(1/0.7)/2), only when op136 armed +0x2e29 bit5 and the per-enemy
    // +0x2bcc clock advanced this manager pass to a multiple of six. The
    // +0x2bc4 comparison prevents repeat awards while slowmo holds a tick.
    const timer = Math.trunc(e.ecl.bossTimer);
    if (e.ecl.sweepItemFlag && timer !== (e.ecl.bossTimerPrevious ?? -999) && timer % 6 === 0 &&
        Math.abs(x - px) <= hitbox.x / 1.4 + p.grazeboxHalf + 20 &&
        Math.abs(y - py) <= hitbox.y / 1.4 + p.grazeboxHalf + 20) {
      this.onGrazeAward(x, y);
    }
    if (Math.abs(x - px) <= hitbox.x / 3 + p.hitboxHalf &&
        Math.abs(y - py) <= hitbox.y / 3 + p.hitboxHalf) {
      this.onPlayerContact?.('body');
      this.onPlayerHit(null, 'body');
    }
  }

  // Th07.exe FUN_0043bb30 (shared graze routine): +200 score, cherry/
  // cherryMax gain, and — while a spell card is up — the pending capture
  // bonus grows by 2500 + floor(cherry/1500)*20 (all.c:27969; the exe
  // accumulator DAT_012f40b0 is reset at each declare, so accumulating
  // only while a card is active is equivalent).
  private onGrazeAward(sourceX = this.playerObj.x, sourceY = this.playerObj.y): void {
    const p = this.playerObj;
    // Th07.exe (v1.00b) FUN_0043bb30 @ 0x43bc2f-0x43bc81: every graze
    // spawns generic effect id 8 at the midpoint between player and contact.
    // During an active Border, an UNFOCUSED player uses three red particles;
    // every other state uses one white particle. The native tests
    // player+0x240d (Border state) then player+0x240b (focus byte) at
    // 0x43bc42-0x43bc70; character is not consulted. DAT_00494fb0 maps id8
    // to FUN_004194d0, four raw RNG draws per particle, so this cosmetic
    // branch is gameplay-stream-visible.
    const borderUnfocused = this.cherry.borderActive && !p.focusHeld;
    this.spawnEffectParticles(
      8,
      (p.x + sourceX) / 2,
      (p.y + sourceY) / 2,
      borderUnfocused ? 3 : 1,
      borderUnfocused ? 0xffff8080 : 0xffffffff
    );
    // FUN_0043bb30 @ 0x43bc81-0x43bc8d: effect allocation precedes the
    // rank award; every bullet/laser/body graze contributes six points.
    this.adjustRank(6);
    // Th07.exe (v1.00b) FUN_0043bb30 @ 0x43bb3b-0x43bb8a: an active bomb
    // suppresses both the stage and total graze counters, but deliberately
    // does NOT suppress the +200 score, rank, spell-graze bonus, Cherry or
    // particle effects below. Extra update 11078 is the fixed witness: the
    // contact is real while Master Spark is active, yet the clear tally must
    // remain one lower than the HUD-independent effect/score stream.
    if (!this.bombActiveThisFrame) this.graze++;
    this.addScore(200);
    // FUN_0043bb30 @ all.c:27969-27978 reads the current Cherry value into
    // DAT_012f40b0 BEFORE FUN_0042de56/0042de03 apply this graze's Cherry
    // gains. Reversing that order crosses the /1500 step one graze early;
    // Yuyuko spell 115 crosses three such steps and was over-awarded by 60.
    if (this.spellcard) {
      this.spellcard.grazeBonus += 2500 + Math.trunc(this.cherry.cherry / 1500) * 20;
    }
    this.cherry.onGraze(this.focusHeld);
    this.playSfx(30);
  }

  private onPlayerHit(sourceBullet: EnemyBullet | null, kind: 'bullet' | 'laser' | 'body' = 'bullet'): void {
    const p = this.playerObj;
    // An invulnerable player (spawn/bomb invuln, or already in the
    // deathbomb window) takes no hit outcome at all in the exe — in
    // particular a contact during invuln must NOT break the border.
    // (Breaking it before this check let one absorbed hit's invulnerability
    // frames chain-eat every subsequent border the instant it started.)
    if (p.invulnFrames > 0 || p.bombInvuln > 0 || p.hitState) return;
    if (this.breakBorder(sourceBullet)) return;
    // Replay-divergence forensics: every committed hit records what struck
    // the player and, for bullets, its spawn provenance. Ring-capped.
    this.hitLog.push({
      frame: this.frame,
      stageFrame: this.stageFrame,
      kind,
      playerX: p.x,
      playerY: p.y,
      bullet: sourceBullet
        ? {
            ownerId: sourceBullet.ownerId,
            ownerSub: sourceBullet.ownerSub,
            spawnFrame: sourceBullet.spawnFrame,
            sprite: sourceBullet.sprite,
            spriteOffset: sourceBullet.spriteOffset,
            x: sourceBullet.x,
            y: sourceBullet.y,
            angle: sourceBullet.angle,
            speed: sourceBullet.speed,
            age: sourceBullet.age
          }
        : null
    });
    if (this.hitLog.length > 64) this.hitLog.shift();
    // Player::CalcKillboxCollision / CalcLaserCollision call
    // GameManager::RerollRng immediately before Die(): five ranged u32 values
    // followed by three ranged f32 values. They feed integrity-only fields in
    // retail, but still advance the shared gameplay RNG by sixteen raw u16s.
    for (let i = 0; i < 5; i++) this.rng.u32InRange(100000);
    for (let i = 0; i < 3; i++) this.rng.range(100000);
    const result = p.hit();
    if (result === 'deathbomb-window') {
      // Player::Die (0x0043edc0) — the hit frame itself runs the whole death
      // entry: RegenerateGameIntegrityCsum, then both hit-effect groups (a
      // dedicated-slot flash type 0xc color 0xff4040ff and a 16-particle
      // white scattering burst type 6), then the death SE. The later miss
      // commit spawns nothing new.
      // GameManager::RegenerateGameIntegrityCsum (0x004012b0): two ranged
      // u32 draws feeding integrity-only fields — four raw u16s.
      this.rng.u32InRange(100000);
      this.rng.u32InRange(100000);
      this.playSfx(4);
      this.spawnEffectParticles(12, p.x, p.y, 1, 0xff4040ff);
      this.spawnEffectParticles(6, p.x, p.y, 16, 0xffffffff);
    }
  }

  private breakBorder(sourceBullet: EnemyBullet | null, includePending = false, rescueDeathbomb = false): boolean {
    if (!this.cherry.breakBorder(includePending)) return false;
    this.applyBorderBreakEffects(sourceBullet, rescueDeathbomb);
    return true;
  }

  private applyBorderBreakEffects(sourceBullet: EnemyBullet | null, rescueDeathbomb: boolean): void {
    const p = this.playerObj;
    // Direct collision result 1 moves the touching bullet to state 5 without an item;
    // later result-2 contacts with the expanding field yield type-8 unboxed
    // Cherry items. FUN_0043eb00 passes 8 at all.c:28984; FUN_0043b040 writes
    // it through player+0x2404 / DAT_004b5ebc before the spawn at
    // all.c:16160/16169.
    // Unlike a result-2 clear, the direct contact transition ignores the
    // bullet's clear-immunity bit. The fixed slot remains occupied through
    // the same authored 12-tick removal ANM.
    if (sourceBullet) this.beginBulletClearFade(sourceBullet, undefined, true);
    // Exe FUN_0043eb00: any prior player state (incl. 2 = deathbomb window)
    // is overwritten to state 3 (invuln) — the miss is cancelled outright.
    this.resetPlayerShotCollisionSpecialClock();
    if (rescueDeathbomb) p.hitState = false;
    this.voidSpellCapture();
    if (p.invulnFrames < 40) {
      p.invulnFrames = 40;
      p.invulnFrac = 0;
    }
    p.bombCooldown = 40;
    this.borderClearWave = { x: p.x, y: p.y, radius: 32, ticksLeft: 50, createdFrame: this.frame };
    // Th07.exe FUN_0043eb00 @ 0x43ed9a-0x43eddf allocates thirty-two
    // general-pool effect-29 petals after arming the clear wave. Each id29
    // initializer consumes six raw u16 draws (ANM time-0 + FUN_00419bc0),
    // so omitting this decorative burst hid a 192-draw split at Extra
    // PRE10854 and also changed later fixed-pool pressure.
    this.spawnEffectParticles(29, p.x, p.y, 32, 0xffffffff);
    // Th07.exe FUN_0043eb00 @ 0x43ed6c-0x43ed89.
    this.playSfx(7);
    this.playSfx(33);
    // The bullet manager continues from its current slot; only later slots
    // in the native 0,1023..1 traversal see this new radius on this frame.
  }

  private updateEnemies(): void {
    this.tickRankSurvival();
    // FUN_0041ed50 processes authored timeline entries before scanning the
    // native 480-slot enemy pool (all.c:14016-14039). Timeline spawns are
    // therefore eligible later in this same pass.
    this.runtime.update(this);
    for (let slot = 0; slot < ENEMY_POOL_CAP; slot++) {
      const e = this.enemySlots[slot];
      if (!e || e.dead) continue;
      // Th07.exe FUN_0041ed50 @ 0x41ef55-0x41ef8f: op161 bit3 is tested
      // before FUN_0040f6c0 and every other per-enemy manager phase. During
      // either a bomb (DAT_004ca4d8) or Supernatural Border
      // (player+0x2408), the enemy is wholly frozen for this pass except for
      // one reverse tick of its +0x2bc4 boss-timer triple. In particular it
      // publishes no homing target and absorbs no player shot this frame.
      if (e.ecl.pauseDuringBombOrBorder &&
          (this.bombActiveThisFrame || this.cherry.borderActive)) {
        this.runtime.tickEnemyPausedManagerClock(this, e);
        continue;
      }
      e.frame++;
      let transitioned: boolean;
      do {
        this.runtime.tickEnemyCore(this, e);
        if (e.dead) break;
        this.runtime.integrateEnemyPosition(e, this.slowRate);
        this.tickSpellBonusDecay(e);
        this.updateEnemyTrailHistory(e);
        this.updateEnemyCull(e);
        if (e.dead) break;
        transitioned = this.runtime.processEnemyCallbacks(this, e);
      } while (transitioned);
      if (e.dead) {
        if (this.enemySlots[slot] === e) {
          this.enemySlots[slot] = null;
          this.runtime.releaseEnemy(this, e);
        }
        continue;
      }
      // Regular ANM VM ticking occurs after cull/callbacks and before every
      // collision scan (all.c:14139-14147).
      this.runtime.updateEnemyAnm(e, this.slowRate);
      // FUN_0040f6c0 may have armed enemy+0x2e2b bit2 in this same core
      // tick for Extra/Phantasm spell ids >=118 while bombing. Native skips
      // the complete collision block in that state: no body contact, no
      // shot/attack absorption, no damage settlement and no homing target.
      let bombContactThisFrame = false;
      if (!e.ecl.bombCollisionSuppressed) {
        this.collideEnemyBody(e);
        this.collidePlayerShots(e);
        // FUN_0041ed50 keeps FUN_0043a980's local_18 bomb-contact flag
        // through damage settlement and passes it as FUN_00430970's spawn
        // mode when this same manager pass kills the enemy. Bomb-contact
        // drops therefore start homing immediately even when their power
        // type is converted to big Cherry at full power.
        bombContactThisFrame = this.settlePendingDamage(e);
        this.accumulatePlayerAimCaches(e);
      }
      if (!e.dead && e.hp <= 0) {
        const keep = this.runtime.killEnemy(this, e, bombContactThisFrame);
        if (!keep) e.dead = true;
      }
      this.runtime.tickEnemyManagerTail(this, e);
      if (e.dead && this.enemySlots[slot] === e) {
        this.enemySlots[slot] = null;
        this.runtime.releaseEnemy(this, e);
      }
    }
    for (const e of this.enemies) {
      if (!e.dead) continue;
      const slot = e.poolSlot;
      if (slot >= 0 && slot < ENEMY_POOL_CAP && this.enemySlots[slot] === e) {
        this.enemySlots[slot] = null;
        this.runtime.releaseEnemy(this, e);
      }
    }
    this.compactLive(this.enemies);
  }

  private tickSpellBonusDecay(e: Enemy): void {
    // FUN_0041d050's spell block runs inside the main boss's enemy-manager
    // pass, after ECL execution/movement and before player-shot collision.
    // Thus an ECL op91 skips this tick, while a shot-killed card later in the
    // same pass includes it before endBossSpell banks the bonus.
    if (!e.ecl.isBoss || e.ecl.bossSlot !== 0) return;
    const sc = this.spellcard;
    if (!sc?.capturing) return;
    // Th07.exe FUN_0041d050 @ all.c:7328-7338: op135's enemy+0x2e2a
    // bit 6 suppresses the DAT_012f40ac decay write, while the shared spell
    // clock below keeps advancing. Yuyuko's final 反魂蝶 branch executes
    // op135(1) immediately after declaring spells 112-115, so their authored
    // base bonus remains frozen. Decaying spell 115 for its full 4081 ticks
    // under-awarded the native capture by 264,968 live score units.
    if (!e.ecl.spellTimeoutFlag) {
      // Native x87 order @ 0x4168c8-0x41690e is
      // ftol(base - decayPerSec * (elapsed + frac) / 60), followed by the
      // floor-to-10. Truncating the decay term before subtracting rounds the
      // opposite way and over-awards one live score unit on some captures.
      const decayed = Math.trunc(
        sc.bonusBase - (sc.decayPerSec * (sc.elapsed + sc.elapsedFrac)) / 60
      );
      sc.bonus = Math.max(0, decayed - (decayed % 10));
    }
    const rate = Math.fround(this.slowRate);
    if (rate > 0.99) {
      sc.elapsed++;
    } else {
      sc.elapsedFrac = Math.fround(sc.elapsedFrac + rate);
      if (sc.elapsedFrac >= 1) {
        sc.elapsed++;
        sc.elapsedFrac = Math.fround(sc.elapsedFrac - 1);
      }
    }
  }

  private updateEnemyTrailHistory(e: Enemy): void {
    const s = e.ecl;
    if (s.trailFlags === 0 || s.trailCount <= 0) return;
    // Th07.exe FUN_0041ed50 @ all.c:14075-14100: after the movement
    // integrator and before culling, shift the configured history toward
    // the oldest slot and write the current position at index zero. The
    // native enemy object has exactly 96 entries; op138 never clears them.
    const count = Math.min(96, s.trailCount, s.trailHistory.length);
    for (let i = count - 1; i > 0; i--) {
      const dst = s.trailHistory[i];
      const src = s.trailHistory[i - 1];
      dst.x = src.x;
      dst.y = src.y;
      dst.z = src.z;
    }
    const head = s.trailHistory[0];
    head.x = e.x;
    head.y = e.y;
    head.z = e.z;
  }

  private updateEnemyCull(e: Enemy): void {
    // ECL op132 writes enemy+0x2e29 bit 3. FUN_0041ed50 @ 0x41f30d
    // short-circuits the entire seen/off-screen cull while that bit is set;
    // invisible controller enemies such as Stage-1 Sub43 must therefore
    // retain their fixed slots even after their paths leave the playfield.
    if (e.ecl.invisible) return;
    // FUN_0041ed50 reads the ANM wrapper's current sprite pointer at +0x1e4,
    // not its render-visible result. Alpha-zero/hidden/waiting scripts still
    // participate in FUN_0042bdc7 culling as long as a sprite was selected;
    // only a genuinely null pointer skips the seen/offscreen latch.
    const size = e.ecl.anmRunner?.spriteSize();
    if (!size) return;
    const halfW = size.w / 2;
    const halfH = size.h / 2;
    const onscreenAt = (x: number, y: number): boolean =>
      x + halfW >= 0 && x - halfW <= 384 &&
      y + halfH >= 0 && y - halfH <= 448;
    const onscreen = onscreenAt(e.x, e.y);
    if (!e.ecl.seen) {
      if (onscreen) e.ecl.seen = true;
      return;
    }
    if (onscreen || e.ecl.offscreenCullExempt) return;
    // FUN_0041ed50 @ 0x41f363-0x41f45f: op138 trail actors are released
    // only after the head AND history[count-1] no longer overlap the field.
    // This preserves the fixed-slot lifetime that SakuyaA's native target
    // cache observes; culling the head alone permutes later enemy slots.
    const s = e.ecl;
    if (s.trailFlags !== 0 && s.trailCount > 0) {
      const oldest = s.trailHistory[Math.min(96, s.trailCount, s.trailHistory.length) - 1];
      if (oldest && onscreenAt(oldest.x, oldest.y)) return;
    }
    e.dead = true;
  }

  private updateBullets(): void {
    this.syncEnemyBulletSlots();
    // FUN_004241c0 @ 0x424203-0x4242ee: clear the counter, then increment it
    // once for every slot that is live on entry. Later frees in this manager
    // pass do not decrement it. Since enemies (priority 10) fire before the
    // bullet manager (priority 12), their next pass observes this exact
    // latched value even when the underlying fixed slots are already free.
    this.enemyBulletManagerEntryCount = this.enemyBulletSlots.reduce(
      (count, bullet) => count + (bullet && !bullet.dead ? 1 : 0), 0
    );
    const waveAtEntry = this.borderClearWave;
    if (waveAtEntry && waveAtEntry.createdFrame < this.frame) {
      // FUN_0043d8f0 updates the zone before the bullet manager tests it.
      waveAtEntry.radius += 16;
      waveAtEntry.ticksLeft--;
    }
    const updateSlot = (slot: number): void => {
      const b = this.enemyBulletSlots[slot];
      if (!b || b.dead) return;
      if (b.clearFadeFrames != null) {
        // Native state 5 runs only its half-speed removal animation. It is
        // neither collidable nor cullable, but still counts as an occupied
        // fixed slot until the ANM removes it.
        b.x = Math.fround(b.x + b.vx / 2);
        b.y = Math.fround(b.y + b.vy / 2);
        b.clearRunner?.update(this.slowRate);
        b.age += this.slowRate;
        b.clearFadeFrames -= this.slowRate;
        if (b.clearFadeFrames <= 0) this.removeEnemyBullet(b);
        return;
      }
      const wasInSpawnState = (b.spawnAge ?? b.spawnDuration) < b.spawnDuration;
      // Native spawn states 2/3/4 skip behavior, cull, bomb and player
      // collision until their authored ANM ends. On the ending tick control
      // falls through into state 1 and performs the normal move as well.
      if (!this.updateBulletMotion(b)) return;
      // op-79 0x2000 grace ticks in normal state (exe FUN_004241c0
      // all.c:16144-16146), immediately before the full-speed position add.
      // updateBulletMotion performs that add, so preserve the same frame's
      // observable countdown here before cull/collision.
      if (b.graceFrames && b.graceFrames > 0) b.graceFrames--;
      // Exe cull, FUN_004241c0 @ all.c:16150-16195: a live grace count skips
      // the bounds test entirely (the bullet stays valid and collidable
      // off-screen); otherwise FUN_0042bdc7 runs BEFORE FUN_0043b350/b200
      // (bomb clear, graze, player hit) and keeps the bullet while its OWN
      // sprite rect overlaps the 384x448 field (constants @ 0x48eabc/eab8 —
      // no flat pixel margin). Off-screen, dir-change/bounce bullets (mask
      // 0xdc0) survive up to 128 consecutive frames (+0xbfe); anything else
      // dies once any leftover count drains. This order matters: Phantasm
      // slot 730 crosses the right edge on update 10470 and native frees it
      // without ever entering FUN_0043b040; clearing first retained the Web
      // slot in state 5 and shifted every volley allocated from frame 10472.
      if (!b.graceFrames) {
        const halfW = b.rect.w / 2;
        const halfH = b.rect.h / 2;
        const onscreen = b.x + halfW >= 0 && b.x - halfW <= 384 && b.y + halfH >= 0 && b.y - halfH <= 448;
        if (onscreen) {
          b.offscreenFrames = 0;
          this.enemyBulletOffscreenCounters[slot] = 0;
        } else if ((b.exFlags & 0xdc0) === 0) {
          if (b.offscreenFrames && b.offscreenFrames > 0) {
            b.offscreenFrames--;
            this.enemyBulletOffscreenCounters[slot] = b.offscreenFrames;
          }
          else b.dead = true;
        } else {
          b.offscreenFrames = (b.offscreenFrames ?? 0) + 1;
          this.enemyBulletOffscreenCounters[slot] = b.offscreenFrames;
          if (b.offscreenFrames >= 128) b.dead = true;
        }
      }
      if (!b.dead && this.cancelBulletWithBombSlots(b)) {
        // The transition tick already performed the normal full-speed move;
        // the common native tail advances age once before state 5 begins on
        // the following manager pass.
        b.age += this.slowRate;
        return;
      }
      // A Border can break in the middle of this descending slot scan.
      // FUN_0043b040 reads the live clear-region pool on every call, so all
      // later slots immediately see the freshly published r32 circle.
      const wave = this.borderClearWave;
      if (wave && !b.dead && (b.flags & 0x1000) === 0) {
        const dx = b.x - wave.x;
        const dy = b.y - wave.y;
        // FUN_0043b040 uses a strict center-distance circle test; swept
        // bullets become auto-collecting type-8 unboxed Cherry items and
        // enter state 5 rather than freeing their fixed slot immediately.
        if (dx * dx + dy * dy < wave.radius * wave.radius) {
          if (this.beginBulletClearFade(b, 'pointBullet')) {
            b.age += this.slowRate;
            return;
          }
        }
      }
      if (!b.dead) this.checkEnemyBulletCollision(b);
      // FUN_004241c0 advances the normal-state split counter at the common
      // tail, after movement, cull and collision. On a spawn-ANM completion
      // tick the native reset survives to the next PRE state (age remains 0);
      // the first increment occurs on the following normal-entry tick.
      if (!b.dead && !wasInSpawnState) b.age += this.slowRate;
      if (b.dead && this.enemyBulletSlots[slot] === b) this.enemyBulletSlots[slot] = null;
    };
    // FUN_004241c0's pointer wrap is unusual but unambiguous: slot 0 first,
    // then 1023 down through 1 (all.c:16038-16049,16197-16203).
    updateSlot(0);
    for (let slot = ENEMY_BULLET_POOL_CAP - 1; slot >= 1; slot--) updateSlot(slot);
    this.compactLive(this.enemyBullets);
    if (this.borderClearWave && this.borderClearWave.ticksLeft <= 0) this.borderClearWave = null;
    // Advance the bomb clear-region blast after this frame's cancellations: the
    // expanding-circle consumer grows the radius by `growth` per frame and retires
    // the region once its lifetime lapses (native: 17 frames, r 32→160).
    for (const r of this.bombClearRegions) {
      if (r.framesLeft <= 0) continue;
      // FUN_0043d8f0 stores the radius back into the float32 pool entry on
      // every head-of-player-tick update, then marks the fixed slot free.
      r.radius = Math.fround(r.radius + r.growth);
      if (--r.framesLeft <= 0) r.framesLeft = 0;
    }
  }

  // Per-frame bullet ex-behaviors, matching Th07.exe FUN_004241c0 @ 0x4241c0.
  // Each activated behavior bit in b.exFlags (exe +0xbf4, promoted by
  // FUN_004229f0 — see advanceBulletExBehavior) runs as an INDEPENDENT
  // if in the order 0x1, 0x10, 0x20, 0x40/0x100/0x80, 0xc00, then velocity is
  // added to position ONCE. Every behavior reads only its OWN op-79 slot's
  // resolved params and clears its own bit when finished.
  private updateBulletMotion(b: EnemyBullet): boolean {
    const rate = this.slowRate;
    const rateF32 = Math.fround(rate);
    // Test/dev-created bullets predating the fixed queue contract are still
    // accepted; retail bullets initialize every field in FUN_00421e90.
    b.exRampElapsed ??= 0;
    b.exRampFrac ??= 0;
    b.exAccelElapsed ??= 0;
    b.exAccelFrac ??= 0;
    b.exAngleElapsed ??= 0;
    b.exAngleFrac ??= 0;
    b.exDirElapsed ??= 0;
    b.exDirFrac ??= 0;
    b.dirTimes ??= 0;
    b.exBounceTimes ??= 0;
    const spawnAge = b.spawnAge ?? b.spawnDuration;
    if (spawnAge < b.spawnDuration) {
      // Enemy-bullet storage is float32. FUN_004241c0 performs its spawn-
      // state multiply/add on x87, then writes the result back to the slot's
      // f32 position fields every manager tick. Keeping JS doubles here
      // accumulated a 0.006px drift over long slowmo fields and moved native
      // graze boundaries by one frame (Stage 5 slot 738 @ PRE7774).
      b.x = Math.fround(b.x + b.vx * b.spawnMoveScale);
      b.y = Math.fround(b.y + b.vy * b.spawnMoveScale);
      // The authored spawn ANM uses the engine's integer/fraction split
      // clock, but its copied VM begins at logical frame 1. Native state 2
      // performs the half-move and tests `(intFrame + 1)` against the
      // time-24 remove instruction BEFORE advancing the pair (Stage-5 slot
      // 449 direct trace, processing 11132). This is 24 wall ticks at rate
      // 1 and 70 wall ticks at rate 1/3, not 72.
      b.spawnAgeFrac ??= 0;
      const spawnEnded = spawnAge + 1 >= b.spawnDuration;
      if (!spawnEnded) {
        if (rate > 0.99) {
          b.spawnAge = spawnAge + 1;
        } else {
          b.spawnAge = spawnAge;
          b.spawnAgeFrac += rate;
          if (b.spawnAgeFrac >= 1) {
            b.spawnAge++;
            b.spawnAgeFrac -= 1;
          }
        }
        return false;
      }
      // Th07.exe FUN_004241c0 @ 0x424843-0x424860: an ending spawn ANM
      // changes state to 1, resets the normal age counter, and falls through
      // to the ordinary behavior/full-velocity move on this same tick.
      b.spawnAge = b.spawnDuration;
      b.spawnAgeFrac = 0;
      b.age = 0;
    }
    // Constructor promotion happens in FUN_00421e90. Every normal-state
    // manager tick performs exactly one further queue pass BEFORE executing
    // active behavior routines (FUN_004241c0 @ all.c:16120).
    advanceBulletExBehavior(b, rate);
    if (b.exFlags & 1) {
      // speed-ramp (FUN_00423840): velocity = polar(angle, speed + 5·decay)
      // for 17 frames; then just clears the bit. Never writes the speed
      // scalar, so it composes cleanly with accel/angle-change.
      const elapsed = b.exRampElapsed + b.exRampFrac;
      if (b.exRampElapsed < 17) {
        // FUN_00423840 stores the ramp result and the rate-scaled speed
        // argument as float32 before FUN_004074e0 writes float32 velocity.
        const extra = Math.fround(5 - (elapsed * 5) / 16);
        const scaledSpeed = Math.fround(
          Math.fround(Math.fround(b.speed) + extra) * rateF32
        );
        b.vx = Math.fround(Math.cos(Math.fround(b.angle)) * scaledSpeed);
        b.vy = Math.fround(Math.sin(Math.fround(b.angle)) * scaledSpeed);
      } else {
        b.exFlags &= ~1;
      }
      b.exRampFrac += rate;
      while (b.exRampFrac >= 1) {
        b.exRampFrac -= 1;
        b.exRampElapsed++;
      }
    }
    if ((b.exFlags & 0x10) && b.exAccel) {
      // accel (FUN_00423910): add a fixed accel vector to velocity and
      // recompute the heading. Does NOT touch the speed scalar (the exe
      // doesn't — writing hypot() here would feed the speed-ramp into a
      // runaway loop = the "supersonic" bug). Runs while age < limit.
      const ac = b.exAccel;
      if (b.exAccelElapsed >= ac.limit) b.exFlags &= ~0x10;
      else {
        // FUN_00423910 consumes the promotion-time f32 vector at +0xccc,
        // multiplies each component by the current f32 rate into an f32
        // local, and fstp-stores each velocity component after the add.
        // Re-evaluating cos/sin here and retaining JS doubles made a
        // 518-frame Phantasm bullet drift 0.009px before Bomb cancellation.
        const accelX = Math.fround(rateF32 * Math.fround(ac.vx));
        const accelY = Math.fround(rateF32 * Math.fround(ac.vy));
        b.vx = Math.fround(accelX + Math.fround(b.vx));
        b.vy = Math.fround(accelY + Math.fround(b.vy));
        if (!(Math.abs(b.vx) <= NATIVE_VELOCITY_EPSILON_F32 &&
              Math.abs(b.vy) <= NATIVE_VELOCITY_EPSILON_F32)) {
          b.angle = Math.fround(Math.atan2(Math.fround(b.vy), Math.fround(b.vx)));
        }
      }
      b.exAccelFrac += rate;
      while (b.exAccelFrac >= 1) {
        b.exAccelFrac -= 1;
        b.exAccelElapsed++;
      }
    }
    if ((b.exFlags & 0x20) && b.exAngle) {
      // angle-change (FUN_00423a80 @ 0x423a80): angle += rate*angleDelta,
      // speed += rate*speedDelta, velocity = polar(angle, rate*speed). Both
      // deltas are rate-scaled in the exe. Runs while the DEDICATED elapsed
      // counter (exe bullet+0xcec, reset at install — not bullet age; effect
      // id 1 installs this behavior mid-life) is below the duration; the
      // counter advances fractionally under slowmo (FUN_00436acc).
      const an = b.exAngle;
      const elapsed = b.exAngleElapsed;
      if (elapsed >= an.limit) b.exFlags &= ~0x20;
      else {
        // FUN_00423a80 stores angle and speed back to their f32 bullet
        // fields before passing an independently f32-staged speed*rate to
        // FUN_004074e0.
        const angleStep = Math.fround(rateF32 * Math.fround(an.angleDelta));
        b.angle = normalizeNativeAngleF32(b.angle, angleStep);
        const speedStep = Math.fround(rateF32 * Math.fround(an.speedDelta));
        b.speed = Math.fround(speedStep + Math.fround(b.speed));
        const scaledSpeed = Math.fround(rateF32 * Math.fround(b.speed));
        b.vx = Math.fround(Math.cos(Math.fround(b.angle)) * scaledSpeed);
        b.vy = Math.fround(Math.sin(Math.fround(b.angle)) * scaledSpeed);
      }
      b.exAngleFrac += rate;
      while (b.exAngleFrac >= 1) {
        b.exAngleFrac -= 1;
        b.exAngleElapsed++;
      }
    }
    if ((b.exFlags & 0x40) && b.exDir) this.dirChangeBullet(b, 'relative');
    if ((b.exFlags & 0x100) && b.exDir) this.dirChangeBullet(b, 'absolute');
    if ((b.exFlags & 0x80) && b.exDir) this.dirChangeBullet(b, 'aimed');
    if ((b.exFlags & 0xc00) && b.exBounce) this.bounceBullet(b, (b.exFlags & 0x400) !== 0);
    // Default bullet integration is the same f32 store-back (`pos += vel`)
    // at all.c:16147-16149. Math.fround is therefore state semantics, not a
    // rendering approximation.
    b.x = Math.fround(b.x + b.vx);
    b.y = Math.fround(b.y + b.vy);
    return true;
  }

  private dirChangeBullet(b: EnemyBullet, mode: 'relative' | 'absolute' | 'aimed'): void {
    const d = b.exDir!;
    const interval = Math.max(1, d.interval | 0);
    const maxTimes = Math.max(1, d.maxTimes | 0);
    const times = b.dirTimes;
    const elapsed = b.exDirElapsed + b.exDirFrac;
    let speed: number;
    if (b.exDirElapsed >= interval) {
      b.dirTimes = times + 1;
      if (b.dirTimes >= maxTimes) {
        b.exFlags &= mode === 'relative' ? ~0x40 : mode === 'absolute' ? ~0x100 : ~0x80;
      }
      if (mode === 'relative') b.angle = normalizeAngle(b.angle + d.angle);
      else if (mode === 'absolute') b.angle = d.angle;
      else b.angle = Math.atan2(this.player.y - b.y, this.player.x - b.x) + d.angle;
      b.speed = d.newSpeed;
      speed = b.speed;
      b.exDirElapsed = 0;
      b.exDirFrac = 0;
    } else {
      speed = b.speed - (elapsed * b.speed) / interval;
    }
    b.vx = Math.cos(b.angle) * speed * this.slowRate;
    b.vy = Math.sin(b.angle) * speed * this.slowRate;
    b.exDirFrac += this.slowRate;
    while (b.exDirFrac >= 1) {
      b.exDirFrac -= 1;
      b.exDirElapsed++;
    }
  }

  private bounceBullet(b: EnemyBullet, includeBottom: boolean): void {
    if (b.x >= 0 && b.x < 384 && b.y >= 0 && (includeBottom ? b.y < 448 : true)) return;
    const bo = b.exBounce!;
    const maxTimes = Math.max(1, bo.maxTimes | 0);
    if (b.x < 0 || b.x >= 384) b.angle = normalizeAngle(-b.angle - Math.PI);
    if (b.y < 0 || (includeBottom && b.y >= 448)) b.angle = -b.angle;
    b.speed = bo.speed;
    b.vx = Math.cos(b.angle) * b.speed * this.slowRate;
    b.vy = Math.sin(b.angle) * b.speed * this.slowRate;
    b.exBounceTimes++;
    if (b.exBounceTimes >= maxTimes) b.exFlags &= 0xf3ff;
  }

  // Additive two-pass beam: a soft colored outer quad at displayWidth plus
  // a bright core. Color indexes the standard 16-hue ZUN bullet palette
  // (ground truth uses 2/4/6/8/10). The telegraph (grow) line renders from
  // frame 0 — only the HIT test waits for telegraphDelay; a shrinking beam
  // stops drawing at shrinkCutoff like the exe.
  private static readonly LASER_COLORS = [
    '#888888', '#663333', '#ff3333', '#cc44cc', '#8844ff', '#4444ff', '#44aaff', '#44ffff',
    '#44ff88', '#44cc44', '#aaff44', '#ffff44', '#ffcc44', '#ff8844', '#cccccc', '#ffffff'
  ];

  // The player body sprite (Th07.exe FUN_0043eff0 @ 0x43f033-0x43f089), drawn
  // in every lifecycle state except game-over. It renders UNDER the danmaku
  // (enemy bullet/laser) layer — only the focus hitbox indicator is drawn on
  // top of the bullets so it stays visible.
  private drawPlayerSprite(r: Renderer, ox: number, oy: number): void {
    const p = this.playerObj;
    if (!(p.alive || p.hitState || p.materializeFrame >= 0 || p.dyingFrame >= 0)) return;
    const pf = p.runner.spriteFrame();
    const dt = p.dyingTransform();
    const mt = p.materializeTransform();
    if (dt) {
      // Death squish (exe state 2): in-place scaleX 1->0, scaleY 1->4.
      r.drawAnmFrame(pf, ox + p.x, oy + p.y, dt);
    } else if (mt) {
      // Respawn materialize (exe state 1): in-place scale/alpha ramp.
      r.drawAnmFrame(pf, ox + p.x, oy + p.y, mt);
    } else {
      // Spawn/respawn invuln (exe state 3): dark-tint 0x404040 on frames where
      // (timer & 7) < 2 (fcn.0043e2e0), instead of an invisibility blink.
      const dim = p.invulnFrames > 0 && (p.invulnFrames & 7) < 2;
      r.drawAnmFrame(pf, ox + p.x, oy + p.y, dim ? { color: 0x404040 } : {});
    }
  }

  private drawLasers(r: Renderer, ox: number, oy: number): void {
    const ctx = r.ctx;
    for (const l of this.enemyLasers) {
      // Exe render (FUN_004253b0, all.c:16375-16420): the beam body draws
      // for every ALLOCATED slot, through the whole shrink — shrinkCutoff is
      // a COLLISION-only gate (all.c:16301-16303). Cutting the draw at
      // shrinkCutoff made long shrink tails (e.g. Prismriver shrink 200-300,
      // cutoff 16) vanish abruptly (LASER-001).
      if (!l.inUse) continue;
      const len = l.farDist - l.nearDist;
      if (len <= 0 || l.displayWidth <= 0) continue;
      const color = StageScene.LASER_COLORS[((l.color % 16) + 16) % 16];
      ctx.save();
      ctx.translate(ox + l.x, oy + l.y);
      ctx.rotate(l.angle);
      ctx.globalCompositeOperation = 'lighter';
      const w = l.displayWidth;
      ctx.globalAlpha = l.state === 0 ? 0.55 : 0.4;
      ctx.fillStyle = color;
      ctx.fillRect(l.nearDist, -w / 2, len, w);
      ctx.globalAlpha = l.state === 0 ? 0.7 : 0.95;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(l.nearDist, -w * 0.18, len, w * 0.36);
      // Tip glow at the origin, per the exe render gate (suppressed during
      // grow when op156 armed hideTipDuringGrow).
      if ((l.nearDist < 16 || l.speed === 0) && (!l.hideTipDuringGrow || l.state !== 0)) {
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(l.nearDist, 0, Math.max(3, w * 0.7), 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // Th07.exe laser updater FUN_004241c0 (all.c:16205-16321), per
  // spec-lasers.md §3/§7.4: farDist auto-grows by speed, nearDist trails
  // by maxLength; state 0 GROW ramps displayWidth 1.2->width over
  // growDuration (hit-testable only after telegraphDelay), state 1 HOLD
  // runs holdDuration frames at full width (the ONLY state whose kill box
  // spans the beam's length), then the shared shrink body ramps width back
  // to 0 over shrinkDuration (drawn/hit only while phaseFrame <
  // shrinkCutoff); nearDist >= 640 or the shrink finishing frees the slot.
  private updateLasers(): void {
    const lrate = this.slowRate;
    for (const l of this.enemyLasers) {
      if (!l.inUse) continue;
      let retired = false;
      let transitionedFromGrow = false;
      // exe FUN_004241c0: farDist growth is rate-scaled; the phase clock is
      // a split counter at the same rate (spec-slowmo.md §3.1/§3.2).
      l.farDist += l.speed * lrate;
      if (l.farDist - l.nearDist > l.maxLength) l.nearDist = l.farDist - l.maxLength;
      if (l.nearDist < 0) l.nearDist = 0;
      if (l.state === 0) {
        if ((l.flags & 1) === 0) {
          // Exe grow ramp (all.c:16223-16241): the telegraph stays a FLAT
          // 1.2px hairline until the last min(growDuration,30) frames, then
          // jumps onto the growDuration-normalized ramp
          // (phaseFrame+frac)*width/growDuration. The old smooth full-phase
          // ramp drew (and hit-tested, via displayWidth) up to ~3x too wide
          // mid-telegraph on long grows (LASER-001).
          const rampWindow = Math.min(l.growDuration, 30);
          l.displayWidth = l.growDuration - rampWindow < l.phaseFrame
            ? Math.min(l.width, ((l.phaseFrame + (l.phaseFrac ?? 0)) * l.width) / Math.max(1, l.growDuration))
            : 1.2;
        }
        // FUN_004241c0 performs player collision inside each fixed laser
        // slot, before the phase counter is advanced at the common tail
        // (all.c:16258-16315). A separate post-update collision pass tests
        // phase N+1 and loses every 12-frame graze boundary; Stage-3 native
        // slot 1 at PRE4504 is phase 12 and consumes id8's four RNG draws,
        // while the old ordering first advanced it to 13.
        this.resolveLaserCollision(l);
        if (l.phaseFrame >= l.growDuration) {
          l.state = 1;
          l.phaseFrame = 0;
          l.phaseFrac = 0;
          l.displayWidth = l.width;
          transitionedFromGrow = true;
        }
        // Native jumps into HOLD with the state byte/phase already updated,
        // but FUN_004241c0 keeps the grow branch's stack-local collision box
        // for this second call (all.c:16221-16274). Recomputing from state=1
        // expands it to the whole beam and produced two false Stage-6 grazes
        // at processing 25206.
        if (transitionedFromGrow) this.resolveLaserCollision(l, 0);
      }
      // Native grow completion jumps directly into the HOLD label in this
      // same manager pass. The transition call above owns its stale grow
      // geometry; ordinary HOLD frames enter here directly.
      if (l.state === 1 && !transitionedFromGrow) {
        l.displayWidth = l.width;
        this.resolveLaserCollision(l);
        if (l.phaseFrame >= l.holdDuration) {
          l.state = 2;
          l.phaseFrame = 0;
          l.phaseFrac = 0;
          if (l.shrinkDuration === 0) {
            l.inUse = false;
            retired = true;
          }
        }
      }
      // HOLD completion likewise falls through to phase-0 SHRINK collision
      // before the shared phase tick. Unlike GROW -> HOLD, the native branch
      // recomputes the shrinking midpoint box before this call.
      if (!retired && l.state === 2) {
        if ((l.flags & 1) === 0) {
          l.displayWidth = Math.max(0, l.width - (l.phaseFrame * l.width) / Math.max(1, l.shrinkDuration));
        }
        this.resolveLaserCollision(l);
        if (l.phaseFrame >= l.shrinkDuration) {
          l.inUse = false;
          retired = true;
        }
      }
      if (retired) continue;
      if (l.nearDist >= 640) l.inUse = false;
      if (lrate > 0.99) {
        l.phaseFrame++;
      } else {
        l.phaseFrac = (l.phaseFrac ?? 0) + lrate;
        if (l.phaseFrac >= 1) {
          l.phaseFrame++;
          l.phaseFrac -= 1;
        }
      }
    }
    // Compact the pool once nothing references dead entries (the per-enemy
    // handle tables hold object references, so splicing is safe).
    if (this.enemyLasers.length > 96) {
      let w = 0;
      for (const l of this.enemyLasers) if (l.inUse) this.enemyLasers[w++] = l;
      this.enemyLasers.length = w;
    }
  }

  private resolveLaserCollision(l: EnemyLaser, geometryState = l.state): void {
    const result = this.checkLaserCollision(l, geometryState);
    if (result === 'hit') {
      this.onPlayerContact?.('laser');
      this.onPlayerHit(null, 'laser');
    }
    else if (result === 'graze') this.onGrazeAward();
  }

  // Player-vs-laser test, exe FUN_0043b650 (all.c:27867-27925) via
  // spec-lasers.md §7: rotate (player - anchor) by -angle into the beam's
  // local frame, then AABB the player hitbox against a box whose along-
  // axis extent is state-dependent (§7.4) — full length only during HOLD,
  // a width-sized nub around the midpoint during grow/shrink. Graze pads
  // the box by a flat 48 (DAT_0048eb94).
  private checkLaserCollision(l: EnemyLaser, geometryState = l.state): 'miss' | 'graze' | 'hit' {
    const inGrow = l.state === 0;
    if (inGrow && l.phaseFrame < l.telegraphDelay) return 'miss';
    if (l.state === 2 && l.phaseFrame >= l.shrinkCutoff) return 'miss';
    const p = this.playerObj;
    const dx = p.x - l.x;
    const dy = p.y - l.y;
    // FUN_00430070 uses outX = sin(a)*dy + cos(a)*dx and
    // outY = cos(a)*dy - sin(a)*dx. Feeding -a here mirrors every angled
    // beam across its anchor; axis-aligned tests hid the error. The native
    // Stage-3 slot-1 graze at processing 4504 is the boundary witness.
    const sin = Math.sin(l.angle);
    const cos = Math.cos(l.angle);
    const along = sin * dy + cos * dx;
    const perp = cos * dy - sin * dx;
    const phw = p.hitboxHalf;
    const midDist = (l.farDist - l.nearDist) / 2 + l.nearDist;
    const extX = geometryState === 1 ? l.farDist - l.nearDist : l.displayWidth / 2;
    const extY = l.width / 2;
    const sepX = Math.abs(along - midDist) - (extX / 2 + phw);
    const sepY = Math.abs(perp) - (extY / 2 + phw);
    if (sepX <= 0 && sepY <= 0) return 'hit';
    // Graze ticks every 12 frames (the exe passes phaseFrame % 12 == 0 as
    // the tick flag at all three call sites), box padded a flat 48.
    if (l.phaseFrame % 12 !== 0) return 'miss';
    const g = 48;
    if (sepX <= g && sepY <= g) return 'graze';
    return 'miss';
  }

  private updateItems(): void {
    const p = this.playerObj;
    const sht = p.sht;
    // Th07.exe FUN_00430c10 @ all.c:21958-21961: the PoC trigger is
    // (power >= 128 OR difficulty > 3 [Extra/Phantasm]) AND player.y <
    // pocLine (strict FCOMP <). DAT_0061c260 is the difficulty byte, not the
    // character/shot selector; treating it as Sakuya made Lunatic drops home
    // eleven to twenty-four frames too early in the replay oracle.
    // On success the item's state byte (+0x27f) is permanently latched to 1.
    // ItemManager::OnUpdate re-reads currentPower / hasBorder LIVE for every
    // item: a power pickup that crosses 128 (or a border activation) inside
    // this very pass immediately latches the LATER slots of the same pass.
    // Hoisting the predicate froze it at the frame-entry power and made
    // full-power conversions start homing one frame late (th7_udMt01 st6
    // collect#1, oracle rf919 vs web rf920).
    const pocActive = () => p.alive
      && (p.power >= 128 || this.difficulty > 3)
      && p.y < sht.pocLineY;
    const rate = Math.fround(this.slowRate);
    for (const it of this.items) {
      it.age++;
      if (it.state === 2 && it.tween) {
        // Spawn-mode-2 positional tween (death drops): pos = lerp(origin,
        // target, elapsed/60) for elapsed 0..59; at exactly 60 the velocity
        // zeroes and the item drops to normal fall from rest. Mid-tween
        // frames skip the latch, gravity and cull entirely (the exe's mode-2
        // branch jumps straight to the collect test). FUN_00430c10
        // all.c:21936-21956; duration divisor DAT_0048ea98 = 60.0.
        const tw = it.tween;
        if (tw.elapsed > 59) {
          if (tw.elapsed === 60) {
            it.vx = 0;
            it.vy = 0;
            it.state = 0;
            // ItemManager::OnUpdate's timer==60 branch does NOT jump to
            // check_collision: it falls through to the shared move (zero
            // velocity, no-op) and the gravity tail, so the fall arms
            // 0.03 on this very tick. Skipping that left every death-drop
            // item one gravity step behind native forever (th7_udYo01
            // stage 2, post-death collects 3 frames late).
            it.vy = Math.fround(Math.fround(0.03) * rate);
          }
        } else {
          const t = (tw.elapsed + tw.frac) / 60;
          it.x = Math.fround(t * tw.tx + (1 - t) * tw.sx);
          it.y = Math.fround(t * tw.ty + (1 - t) * tw.sy);
        }
        // Split-counter advance (exe FUN_00436acc): fractional under slowmo.
        tw.frac = Math.fround(tw.frac + rate);
        while (tw.frac >= 1) {
          tw.frac -= 1;
          tw.elapsed++;
        }
      } else {
        if (this.cherry.borderActive) {
          // FUN_00430c10: while the Supernatural Border is live, every item
          // is latched to homing state with guaranteed-max scoring. (The
          // decompile names DAT_004b5ec5 here; Stage 1-6 exact AUX requires
          // this latch while the border timer is active — do not drop it.)
          it.state = 1;
          it.guaranteedMax = true;
        } else if (pocActive()) {
          it.state = 1;
        }
        if (it.state === 1) {
          if (p.materializeFrame >= 0) {
            // Player state 1 (respawn materialize) clears the homing latch
            // and writes only vy=-0.5; the previous vx is intentionally
            // retained for this integration tick (0x430f73..0x430f8a).
            it.vy = Math.fround(-0.5);
            it.state = 0;
          } else {
            // FUN_0043f2b0 stages player-item deltas through float32 before
            // atan2; its x87 result is then explicitly narrowed before
            // FUN_004074e0 stores the velocity pair at +0x258/+0x25c.
            const dx = Math.fround(p.x - it.x);
            const dy = Math.fround(p.y - it.y);
            const angle = Math.fround(Math.atan2(dy, dx));
            it.vx = Math.fround(Math.cos(angle) * sht.autocollectSpeed);
            it.vy = Math.fround(Math.sin(angle) * sht.autocollectSpeed);
          }
        } else {
          // FUN_00430c10 @ all.c:21978-21991 integrates the current velocity
          // first, then applies gravity for the next frame.
          it.vx = 0;
          if (it.vy < Math.fround(-2.2)) it.vy = Math.fround(-2.2);
        }
        // All non-tween states share the rate-scaled integration and the
        // common vertical gravity/cap tail, including state-1 homing.
        const dx = Math.fround(it.vx * rate);
        const dy = Math.fround(it.vy * rate);
        it.x = Math.fround(it.x + dx);
        it.y = Math.fround(it.y + dy);
        if (it.vy >= 3) it.vy = 3;
        else it.vy = Math.fround(it.vy + Math.fround(Math.fround(0.03) * rate));
        // ItemManager::OnUpdate: `arcadeRegionSize.y + 16.0f <= y` — the
        // 448+16 boundary despawns INCLUSIVELY at exactly 464.
        if (it.y >= 464) {
          it.dead = true;
          // FUN_00430c10 clears +0x27d immediately on this branch, so a
          // later item in the same ascending manager pass may reuse the
          // physical slot through FUN_00430970.
          if (this.itemSlots?.[it.poolSlot] === it) this.itemSlots[it.poolSlot] = null;
          // FUN_00430c10 @ 0x4310ae-0x4310ba: every ordinary item that
          // leaves the bottom subtracts three rank points, regardless of
          // item type. Tween-state death drops bypass this cull branch.
          this.adjustRank(-3);
        }
      }
      // Player::CalcItemBoxCollision (0x0043b480): inclusive AABB of the
      // item box (item ± f32(itemRadius/2), from ItemManager's local size
      // vector) against the player's PRECOMPUTED grab corners
      // (grabItemTopLeft/BottomRight = positionCenter ± grabItemSize, with
      // grabItemSize fixed (12,12,5) — Player.cpp:1419/2444). Both sides
      // round each corner through f32 before the comparisons; the
      // algebraically equal center-distance form |Δ| <= r/2+12 rounds in
      // different places and flipped marginal collects by one frame
      // (th7_udMt01 stage 4 collect#161, oracle 4224 vs web 4225).
      const itemHalf = Math.fround(sht.itemRadius * 0.5);
      const itemMinX = Math.fround(Math.fround(it.x) - itemHalf);
      const itemMaxX = Math.fround(Math.fround(it.x) + itemHalf);
      const itemMinY = Math.fround(Math.fround(it.y) - itemHalf);
      const itemMaxY = Math.fround(Math.fround(it.y) + itemHalf);
      const grabMinX = Math.fround(Math.fround(p.x) - 12);
      const grabMaxX = Math.fround(Math.fround(p.x) + 12);
      const grabMinY = Math.fround(Math.fround(p.y) - 12);
      const grabMaxY = Math.fround(Math.fround(p.y) + 12);
      if (p.alive && !it.dead &&
          !(grabMinX > itemMaxX || grabMaxX < itemMinX ||
            grabMinY > itemMaxY || grabMaxY < itemMinY)) {
        this.collectItem(it);
        // The native pickup switch keeps the current slot occupied while its
        // nested item/effect spawns run, then clears +0x27d before advancing
        // to the next fixed slot. Releasing only after the whole JS pass made
        // later same-frame spawns skip reusable low slots and drifted the
        // Stage-4 cursor by hundreds of entries.
        if (it.dead && this.itemSlots?.[it.poolSlot] === it) this.itemSlots[it.poolSlot] = null;
      }
    }
    let w = 0;
    for (const it of this.items) {
      if (!it.dead) {
        this.items[w++] = it;
        continue;
      }
      if (this.itemSlots?.[it.poolSlot] === it) this.itemSlots[it.poolSlot] = null;
    }
    this.items.length = w;
  }

  private forceCollectAllItems(): void {
    // Th07.exe FUN_00431d10 @ 0x431d10: every live fixed-pool item is put in
    // homing state and its velocity/tween-origin vector is reset to the small
    // upward nudge. The next item-manager pass recomputes the real 8 px/frame
    // velocity from the then-current player position.
    for (const it of this.items) {
      if (it.dead) continue;
      it.state = 1;
      it.vx = 0;
      it.vy = Math.fround(-0.5);
    }
  }

  private collectItem(it: ItemEntity): void {
    const p = this.playerObj;
    it.dead = true;
    this.playSfx(21);
    switch (it.type) {
      case 'power':
      case 'bigPower': {
        // Item-collect cases 0/2 (spec-popups.md §4.1): below max power a
        // plain white "10" popup, or — when the pickup crosses a power
        // bracket (8/16/32/48/64/80/96/128) — a salmon sentinel glyph and
        // the power-up chime. Case 0 at max power pays the escalating
        // combo score (flat 12800 here — combo ladder unported, AGENTS §7).
        const add = it.type === 'power' ? 1 : 8;
        if (p.power < 128) {
          const before = this.powerTier(p.power);
          p.power = Math.min(128, p.power + add);
          // Th07.exe (v1.00b) FUN_00430860 @ 0x43089b calls
          // FUN_00401700 after every below-cap power change. That HUD-state
          // refresh consumes two u32 values from the shared gameplay RNG,
          // even though the generated display fields are not modeled here.
          this.refreshPowerHudRandomState();
          if (this.powerTier(p.power) > before) {
            this.spawnScorePopup(-1, it.x, it.y, 0xffffc0a0);
            this.playSfx(0x1f);
          } else {
            this.spawnScorePopup(10, it.x, it.y, 0xffffffff);
          }
          if (p.power === 128) {
            // Item cases 0/2 call FUN_00401700 a second time when the gain
            // crosses 128 (all.c:22029 / 22137), before the field cancel.
            this.refreshPowerHudRandomState();
            // Crossing to full power: FUN_00431da0 converts every other
            // live power/bigPower item to bigCherry (all.c:22034/22142),
            // then FUN_00422ea0(1) clears the field to cherry items — the
            // cancel (not the conversion) is gated on no active spell card
            // (DAT_012f40a8 == 0, all.c:22030/22138).
            this.convertLivePowerItems();
            if (!this.spellcard) this.cancelBulletsToItems();
          }
          // FUN_00430c10 cases 0 and 2 both credit one live score unit for
          // every below-cap pickup (all.c:22042 / 22149). The visible popup
          // says 10 because popup values use display×10 units.
          this.addScore(1);
        } else if (it.type === 'power') {
          this.addScore(12800);
          this.spawnScorePopup(128000, it.x, it.y, 0xffffff00);
        }
        // Collect case 0 calls FUN_0042db77(1) after both the below-cap and
        // max-power branches. Case 2 (bigPower) has no rank call.
        if (it.type === 'power') this.adjustRank(1);
        // bigPower at max: the exe path shows uninitialized garbage and
        // credits nothing (confirmed v1.00b bug) — the port draws nothing.
        break;
      }
      case 'fullPower': {
        // Case 4 (spec-popups.md §4.1): salmon sentinel + chime + convert
        // every live power/bigPower item to bigCherry (FUN_00431da0) when
        // power was below max, then always a white "1000" popup and +100.
        if (p.power < 128) {
          this.spawnScorePopup(-1, it.x, it.y, 0xffffc0a0);
          this.playSfx(0x1f);
          this.convertLivePowerItems();
          // Case 4's crossing cancel (all.c:22172) is NOT spell-gated,
          // unlike the power/bigPower cases.
          this.cancelBulletsToItems();
        }
        p.power = 128;
        // Item case 4 unconditionally refreshes the same HUD state after
        // writing full power (Th07.exe @ 0x43165a / all.c:22179).
        this.refreshPowerHudRandomState();
        this.addScore(100);
        this.spawnScorePopup(1000, it.x, it.y, 0xffffffff);
        break;
      }
      case 'point': {
        this.pointItems++;
        const pts = this.cherry.pointItemScore(it.y, p.sht.pocLineY, it.guaranteedMax);
        this.addScore(pts);
        // Case 1: position or +0x280 selects yellow. The +0x27f homing byte
        // by itself does not affect value/color.
        const yellow = !!it.guaranteedMax || it.y < p.sht.pocLineY;
        this.spawnScorePopup(pts * 10, it.x, it.y, yellow ? 0xffffff00 : 0xffffffff);
        // FUN_00430c10 @ 0x43151f-0x43154f: position alone selects the
        // award. Strictly above the PoC line is +10; on/below it is +3.
        this.adjustRank(it.y < p.sht.pocLineY ? 10 : 3);
        // Extend ladder (exe item-collect case 1 @ all.c:22099-22125).
        while (this.pointItems >= this.extendThreshold) {
          this.awardExtend();
          this.extendLevel++;
        }
        break;
      }
      case 'pointBullet':
        // Exe item type 8 (the Border-break circle's unboxed petal): +30
        // cherry&cherryPlus (dc6f) and +70 cherry-only (dd6c), NO score
        // (FUN_00430c10 case 8; FUN_0043eb00 @ all.c:28984).
        this.cherry.onBigCherryItem();
        break;
      case 'bomb':
        if (p.bombs < 8) {
          p.bombs++;
          // Item collect case 3, Th07.exe v1.00b @ 0x43153f-0x431558
          // (all.c:22162-22167): a successful stock increase calls
          // FUN_0042bd01(1), whose tail is FUN_00401700 (two u32 / four
          // raw draws). A capped pickup skips the refresh but still awards
          // the case's +5 rank below.
          this.refreshPowerHudRandomState();
        }
        // Collect case 3 awards +5 even when the bomb stock is already 8.
        this.adjustRank(5);
        break;
      case 'life':
        // Collect case 5 shares FUN_0042bf29 with point-item extends: award
        // a life, or a bomb when lives are full, and +200 rank only when one
        // of those resources was actually granted.
        this.awardExtend();
        break;
      case 'cherry': {
        // Exe case 6: normally +20; while a bomb is active the fixed slot's
        // parity selects +10 cherry+plus (even) or +10 cherry-only (odd).
        // The popup uses the 3-slot pool, always white (spec-popups.md §4.1).
        // player+0x23dc remains set through the final bomb cleanup callback,
        // one manager pass after the form timer reaches zero. It is a wider
        // item-score flag than DAT_004ca4d8/attack-slot activity: do not fold
        // this cleanup tick into the global bomb collision gate.
        const bombItemScoreActive = this.bombActiveThisFrame || this.bombCleanupDefersBorder;
        const v = this.cherry.grazeScaledItemScore(this.graze, bombItemScoreActive);
        this.addScore(v);
        this.spawnScorePopup(v * 10, it.x, it.y, 0xffffffff, true);
        this.cherry.onSmallCherryItem(this.bombActiveThisFrame, (it.poolSlot & 1) === 0);
        break;
      }
      case 'case9Cherry': {
        // Exe collect case 9: the same graze-scaled score/popup as case 6,
        // but a flat +100 cherry AND cherryPlus (FUN_00430c10,
        // all.c:22249-22260). Stage-6 native processing 5950 collects two
        // of these and advances cherryPlus by 200; treating them as type 6
        // advanced it by only 40.
        const v = this.cherry.grazeScaledItemScore(this.graze);
        this.addScore(v);
        this.spawnScorePopup(v * 10, it.x, it.y, 0xffffffff, true);
        this.cherry.onCase9CherryItem();
        break;
      }
      case 'bigCherry': {
        // This ItemType is exe item TYPE 7 (the drop-table entry, and what
        // power drops convert to at power>=128, FUN_00430970 all.c:21819) —
        // exe collect case 7: cherry AND cherryPlus += 1000 + 100×spell
        // captures (all.c:22236), plus a height-falloff score bonus when
        // cherry is already saturated. Saturated: white/yellow score popup;
        // otherwise a RED popup showing the cherry gain (spec-popups.md).
        if (this.cherry.cherry >= this.cherry.cherryMax) {
          const v = this.cherry.largeCherryItemScore(
            it.y,
            this.playerObj.sht.pocLineY,
            it.guaranteedMax
          );
          this.addScore(v);
          const yellow = !!it.guaranteedMax || it.y < p.sht.pocLineY;
          this.spawnScorePopup(v * 10, it.x, it.y, yellow ? 0xffffff00 : 0xffffffff);
        } else {
          this.spawnScorePopup(this.cherry.largeCherryItemGain(), it.x, it.y, 0xffff4040);
        }
        this.cherry.onLargeCherryItem();
        break;
      }
    }
  }

  private refreshPowerHudRandomState(): void {
    // FUN_00401700 @ 0x401700 performs two FUN_0042ff90 u32 draws.
    this.rng.u32();
    this.rng.u32();
  }

  private updateParticles(): void {
    for (const p of this.particles) {
      let alive = true;
      if (p.world) {
        // FUN_0041a050 @ 0x41a050 is shared by effect ids
        // 20/26/27/30/31 and runs before their ANM tick, including on the
        // allocation frame: integrate acceleration/velocity, then retain the
        // slot only inside the camera's 0.94 cosine cone and above the
        // world-space ground plane (negative z).
        const w = p.world;
        w.vx = Math.fround(w.vx + w.ax);
        w.vy = Math.fround(w.vy + w.ay);
        w.vz = Math.fround(w.vz + w.az);
        w.x = Math.fround(w.x + w.vx);
        w.y = Math.fround(w.y + w.vy);
        w.z = Math.fround(w.z + w.vz);
        w.angle = Math.fround(normalizeAngle(w.angle + w.angularVelocity));

        const std = this.runtime.std;
        const camera = std.camera();
        const facing = std.facing();
        const dx = w.x - camera.x;
        const dy = w.y - camera.y;
        const dz = w.z - camera.z;
        const dl = Math.hypot(dx, dy, dz) || 1;
        const fl = Math.hypot(facing.x, facing.y, facing.z) || 1;
        const dot = (dx * facing.x + dy * facing.y + dz * facing.z) / (dl * fl);
        alive = dot >= 0.94 && w.z < 0;
        if (alive) {
          const projected = std.project(w.x, w.y, w.z, std.cameraFrame(std.frame), {
            x: 0, y: 0, width: PLAYFIELD.width, height: PLAYFIELD.height
          });
          if (projected) {
            p.x = projected.x;
            p.y = projected.y;
          }
        }
      } else {
        p.x += p.vx;
        p.y += p.vy;
      }

      if (p.ownerEnemyId != null && p.releaseFrames == null) {
        const owner = this.enemies.find((enemy) => enemy.id === p.ownerEnemyId && !enemy.dead);
        if (owner) {
          p.x = owner.x;
          p.y = owner.y;
        }
      }
      if (p.releaseFrames != null && --p.releaseFrames <= 0) alive = false;
      p.age++;
      if (p.age >= p.life) alive = false;
      if (!alive) {
        p.age = p.life;
        if (this.effectSlots[p.poolSlot] === p) this.effectSlots[p.poolSlot] = null;
      }
    }
    let w = 0;
    for (const p of this.particles) if (p.age < p.life) this.particles[w++] = p;
    this.particles.length = w;
  }

  // Supernatural Border visual: a rotating square frame that shrinks as the
  // border's 9 seconds run out, drawn additively around the player.
  private drawBorder(r: Renderer, ox: number, oy: number): void {
    const p = this.playerObj;
    const t = this.cherry.borderTimer / BORDER_DURATION;
    // The ring closes fully at the mechanical end — it previously popped
    // out at 40px, which read as the visual ending early. (The exe kills
    // its border child object synchronously at expiry, all.c:28804-28807;
    // the ring itself is this port's flagged procedural approximation.)
    const radius = 360 * t;
    const ctx = r.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Screen tint envelope (exe FUN_0043e2e0 state-4, all.c:28756-28773):
    // color 0x303030 additive, alpha ramping over the first 30 frames,
    // flat 0x80 through frame 510, ramping out over the final 30.
    const elapsed = BORDER_DURATION - this.cherry.borderTimer;
    const alphaByte = elapsed < 30 ? (0x50 * elapsed) / 30
      : elapsed < 510 ? 0x80
        : (0x50 * (BORDER_DURATION - elapsed)) / 30;
    ctx.fillStyle = `rgba(48, 48, 48, ${(alphaByte / 255).toFixed(3)})`;
    ctx.fillRect(ox, oy, 384, 448);
    ctx.translate(ox + p.x, oy + p.y);
    for (const phase of [0, Math.PI / 4]) {
      ctx.save();
      ctx.rotate(this.frame * 0.01 + phase);
      ctx.strokeStyle = `rgba(180, 220, 255, ${0.35 + 0.2 * Math.sin(this.frame * 0.2)})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(-radius, -radius, radius * 2, radius * 2);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.72, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 200, 240, 0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // -- draw ------------------------------------------------------------------

  draw(r: Renderer, measurePasses = false): void {
    // The native one-shot capture flush runs before the next render, while
    // the backbuffer still holds the final live playfield. Capturing after
    // clear() would record the presentation itself instead.
    if (this.clearCaptureArmed || this.stageTransitionCaptureArmed) {
      r.capturePlayfield();
      this.clearCaptureArmed = false;
      this.stageTransitionCaptureArmed = false;
    }
    this.measureDrawPasses = measurePasses;
    if (measurePasses) {
      this.drawPassCosts = {};
      this.passT0 = performance.now();
    }
    r.clear('#101018');
    r.ctx.fillStyle = '#04040c';
    r.ctx.fillRect(PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
    this.markPass('clear');
    r.clipPlayfield(() => {
      const ox = PLAYFIELD.x + this.shakeX;
      const oy = PLAYFIELD.y + this.shakeY;
      this.drawBackground(r, ox, oy);
      this.drawSpellBackground(r);
      this.markPass('background');
      for (const p of this.particles) {
        const alpha = 1 - p.age / p.life;
        r.ctx.globalAlpha = alpha * 0.8;
        r.ctx.fillStyle = p.kind === 'snow' ? '#cde' : '#fff';
        r.ctx.fillRect(ox + p.x - p.size / 2, oy + p.y - p.size / 2, p.size, p.size);
        r.ctx.globalAlpha = 1;
      }
      for (const e of this.enemies) {
        if (e.ecl.invisible) continue;
        for (const slot of e.ecl.anmSlots) {
          if (slot?.runner) r.drawAnmFrame(slot.runner.spriteFrame(), ox + e.x, oy + e.y);
        }
        const frame = e.ecl.anmRunner?.spriteFrame() ?? null;
        // op150 writes an absolute VM rotation; the op27 angle-follow flag
        // takes precedence when armed (both write the same exe field).
        // op120 rotate-with-movement: the exe's per-frame ANM sync
        // (FUN_004208a0) copies the LIVE heading (enemy+0x2b54) into the
        // sprite rotZ — not the mode-1 polar angle, which mode-3 orbiters
        // (Letty's テーブルターニング papers) never touch.
        const rotation = e.ecl.anmRotateWithAngle ? e.ecl.heading : e.ecl.anmRotZ;
        r.drawAnmFrame(frame, ox + e.x, oy + e.y, rotation != null ? { rotation } : {});
      }
      this.markPass('enemies');
      // Th07.exe layers the player sprite UNDER the enemy bullet/laser danmaku
      // (only the focus hitbox indicator, drawn later, sits on top).
      this.drawPlayerSprite(r, ox, oy);
      this.drawLasers(r, ox, oy);
      // Player shots ride under the enemy-bullet danmaku so dense patterns
      // stay readable (Th07.exe layers player shot/laser below enemy bullets).
      for (const b of this.playerBullets) {
        // Script-driven sprite state (alpha/scale/spin/blend all come from
        // the playerXX.anm shot script). Auto-rotate scripts (op25 — Sakuya
        // knives, Marisa main star, the impact streaks) orient along the
        // live velocity +π/2 (sprites point up, exe FUN_0043a630); others
        // (Reimu's spinning amulets) use the script's own rotation.
        const frame = b.runner.spriteFrame();
        if (!frame) continue;
        const opts: { rotation?: number; scaleY?: number; alpha?: number } = {};
        if (frame.autoRotate) opts.rotation = Math.atan2(b.vy, b.vx) + Math.PI / 2;
        // Beam types stretch their 14px segment over the live beam length
        // (exe writes the VM scaleY each frame: FUN_004396a0/FUN_004398e0).
        if (b.scaleYOverride != null) opts.scaleY = b.scaleYOverride;
        r.drawAnmFrame(frame, ox + b.x, oy + b.y, opts);
        // FUN_00439c50 runs after the primary draw, visits newest-to-oldest
        // up to the cached SHT interval, and stops at the first -999 slot.
        if (b.shotType === 5 && b.history) {
          const depth = Math.min(16, b.historyDepth ?? 0);
          for (let i = 0; i < depth; i++) {
            const hpt = b.history[i];
            if (hpt.x === -999) break;
            r.drawAnmFrame(frame, ox + hpt.x, oy + hpt.y, {
              ...opts,
              alpha: 1 - i / depth
            });
          }
        }
      }
      // Enemy bullets dominate entity draw counts in dense spells. Their
      // sprites are untinted, so one saved Canvas state can safely cover the
      // whole batch while each draw assigns its own transform/alpha/blend.
      r.ctx.save();
      for (const b of this.enemyBullets) {
        if (b.dead) continue;
        if (b.clearFadeFrames != null) {
          r.drawAnmFrame(b.clearRunner?.spriteFrame() ?? null, ox + b.x, oy + b.y);
          continue;
        }
        // 大玉 (template 10) spawn bloom: the exe's flags-selected intro
        // script (etama2 entry-1 script 2, 24 frames — recon
        // gokushinken-bullets.md) draws the same offset-shifted sprite at
        // scale 2.0 shrinking to 1.0, additive, alpha fading 0->255 over
        // 32f (clipped by the 24f script end). Draw-time only; movement/
        // collision keep the byte-confirmed spawnDuration model.
        const spawnAge = Math.min(b.spawnDuration, b.spawnAge ?? b.spawnDuration);
        const visualAge = spawnAge + b.age;
        if (b.sprite === 10 && (b.flags & 0xe) !== 0 && visualAge < 24) {
          r.drawSpriteInBatch(
            b.rect.imageKey, b.rect.x, b.rect.y, b.rect.w, b.rect.h,
            ox + b.x, oy + b.y,
            b.angle + Math.PI / 2,
            2 - visualAge / 24,
            Math.min(1, visualAge / 32),
            'lighter'
          );
          continue;
        }
        const spawning = spawnAge < b.spawnDuration;
        r.drawSpriteInBatch(
          b.rect.imageKey,
          b.rect.x,
          b.rect.y,
          b.rect.w,
          b.rect.h,
          ox + b.x,
          oy + b.y,
          b.angle + Math.PI / 2,
          spawning ? 1.6 - 0.6 * (spawnAge / Math.max(1, b.spawnDuration)) : 1,
          spawning ? 0.6 + 0.4 * (spawnAge / Math.max(1, b.spawnDuration)) : 1,
          spawning ? 'lighter' : 'source-over'
        );
      }
      r.ctx.restore();
      this.markPass('bullets');
      // Items ride the same batched path as bullets: a phase-end sweep can
      // legitimately field 1000+ of them at once, and the per-call
      // save/translate/restore path was the measured freeze source there.
      r.ctx.save();
      for (const it of this.items) {
        // Items falling above the top edge peek in as their per-type arrow
        // sprite (original UX; etama2 emb14-21, +10 from the item id).
        const above = it.y < 0;
        const emb = ITEM_SPRITES[it.type] + (above ? ITEM_ARROW_OFFSET : 0);
        const sprite = this.assets.anms.etama.sprites.get(this.etamaItemBase + emb);
        if (sprite) {
          const drawY = Math.max(8, it.y);
          r.drawSpriteInBatch(sprite.imageKey, sprite.x, sprite.y, sprite.w, sprite.h,
            ox + it.x, oy + drawY, 0, 1, above ? 0.85 : 1, 'source-over');
        }
      }
      r.ctx.restore();
      this.markPass('items');
      const p = this.playerObj;
      this.playerEffects.draw(r, ox, oy);
      this.bombRunner?.draw(r, ox, oy);
      if (this.focusEffectRunner) {
        r.drawAnmFrame(this.focusEffectRunner.spriteFrame(), ox + p.x, oy + p.y);
      }
      this.drawPopups(r, ox, oy);
      // Option orbs (yin-yang, local sprite 128).
      if (p.alive && p.power >= 8) {
        const orbSprite = p.anm.sprites.get(128) ?? p.anm.sprites.get(66);
        if (orbSprite) {
          for (const orb of [1, 2] as const) {
            const off = p.orbOffset(orb);
            r.drawSprite(orbSprite.imageKey, orbSprite.x, orbSprite.y, orbSprite.w, orbSprite.h, ox + p.x + off.x, oy + p.y + off.y, {
              rotation: this.frame * 0.1,
              scaleMultiplier: 0.75
            });
          }
        }
      }
      // The player body sprite itself is drawn earlier, UNDER the danmaku
      // layer (drawPlayerSprite). Only the focus hitbox indicator stays here,
      // on top of the bullets, so it remains visible against dense fire.
      if (this.focusHeld && p.alive) {
        r.ctx.fillStyle = '#fff';
        r.ctx.beginPath();
        r.ctx.arc(ox + p.x, oy + p.y, p.hitboxHalf + 1.5, 0, Math.PI * 2);
        r.ctx.fill();
        r.ctx.strokeStyle = '#f66';
        r.ctx.stroke();
      }
      if (this.cherry.borderActive) this.drawBorder(r, ox, oy);
      if (this.screenFlash) {
        const f = this.screenFlash;
        const a = ((f.color >>> 24) & 0xff) / 255;
        const cr = (f.color >>> 16) & 0xff;
        const cg = (f.color >>> 8) & 0xff;
        const cb = f.color & 0xff;
        r.ctx.save();
        r.ctx.globalAlpha = a;
        r.ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
        r.ctx.fillRect(PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
        r.ctx.restore();
      }
      this.drawSpellDeclaration(r, ox, oy);
      this.markPass('player+fx');
    });
    this.drawFrame(r);
    this.drawSidebar(r);
    this.drawModeTags(r);
    if (this.stageResultsActive) this.drawStageClearPresentation(r);
    this.drawSpellOverlay(r);
    this.drawDialogue(r);
    this.drawStageTitle(r);
    if (this.borderMessage) this.drawBorderMessage(r);
    if (this.bonusPopup) this.drawSpellBonusPopup(r);
    if (this.bossActive) this.drawBossMarker(r);
    if (this.stageResultsActive) this.drawStageClear(r);
    this.drawStageTransition(r);
    if (this.continueScreen) this.drawContinueScreen(r);
    else if (this.gameOver) r.text('GAME OVER', PLAYFIELD.x + 140, PLAYFIELD.y + 200, { size: 20, color: '#f66' });
    if (this.pauseState) this.drawPause(r);
    this.markPass('hud');
  }

  private startStageClearPresentation(): void {
    // Th07.exe stage-clear case 9 @ all.c:17916-17936: stages 1-5 pair the
    // selected character's loading ANM script 0 (global 0x61e) with only
    // capture.anm script 1 (global 0x725). Capture scripts 0/2/3 belong to
    // separate transitions and are intentionally not created here.
    if (this.stageNumber >= 6) return;
    const family = CHARACTERS[this.playerObj.character].family;
    const loadingKey = CLEAR_LOADING_ANM[family] ?? CLEAR_LOADING_ANM[0];
    this.clearLoadingKey = loadingKey;
    this.clearLoadingRunner = new AnmRunner(this.assets.anms[loadingKey], 0);
    this.clearCaptureRunner = new AnmRunner(this.assets.anms.capture, 1, { imageKey: 'capture:@' });
    this.clearCaptureArmed = true;
  }

  private drawStageClearPresentation(r: Renderer): void {
    // Native draw order @ all.c:18798-18800: full-playfield loading art,
    // then the rotating/shrinking captured frame. Both ANMs contain absolute
    // 640x480 screen coordinates, so the caller contributes no playfield base.
    r.drawAnmFrame(this.clearLoadingRunner?.spriteFrame() ?? null, 0, 0);
    r.drawAnmFrame(this.clearCaptureRunner?.spriteFrame() ?? null, 0, 0);
  }

  private startStageTransition(): void {
    // Th07.exe FUN_00427269 @ 0x42740a-0x42770e, entered for game state 3:
    // capture the outgoing playfield, split it into 12x14 32px cells, then
    // seed capture.anm scripts 2/3 with var8 = row + 2*column. Their original
    // ANM bytecode staggers a 60-frame quadratic shrink/fade/rotation, which
    // reveals the already-running next stage beneath the old clear screen.
    const capture = this.assets.anms.capture;
    this.stageTransitionTiles.length = 0;
    for (let row = 0; row < 14; row++) {
      for (let column = 0; column < 12; column++) {
        const script = 2 + ((row + column) & 1);
        const delay = row + column * 2;
        const runner = new AnmRunner(capture, script, { imageKey: 'capture:@' });
        runner.setVariable(8, delay);
        this.stageTransitionTiles.push({
          runner,
          row,
          column,
          delay,
          // Exe coordinates are cell*32 - 0.5 + 16 (center semantics).
          x: column * 32 + 15.5,
          y: row * 32 + 15.5,
          sourceX: column * 32,
          sourceY: row * 32
        });
      }
    }
    this.stageTransitionTimer = 0;
    this.stageTransitionCaptureArmed = true;
  }

  private drawStageTransition(r: Renderer): void {
    if (!this.stageTransitionTiles.some((tile) => !tile.runner.removed)) return;
    r.clipPlayfield(() => {
      for (const tile of this.stageTransitionTiles) {
        if (tile.runner.removed) continue;
        r.drawAnmFrame(
          tile.runner.spriteFrame(),
          PLAYFIELD.x + tile.x,
          PLAYFIELD.y + tile.y,
          { sourceOffsetX: tile.sourceX, sourceOffsetY: tile.sourceY, project3d: true }
        );
      }
    });
  }

  // Shared Full-Power/Border message slot, exact text/timing/slide from
  // FUN_0042645b + FUN_00425dd1 (all.c:16941-16959, 17138-17169,
  // 18287-18300). The original uses ascii.anm's 16px glyphs at x scale .9;
  // canvas text is the existing glyph fallback, but coordinates and color
  // are recovered constants rather than hand-tuned placement.
  private drawBorderMessage(r: Renderer): void {
    const msg = this.borderMessage;
    if (!msg) return;
    const x = msg.age < 30 ? 416 - (312 * msg.age) / 30 : 104;
    const text = msg.type === 2
      ? 'Supernatural Border!!'
      : `Border Bonus ${String(Math.trunc(msg.value)).padStart(7, ' ')}`;
    r.text(text, x, 168, { size: 16, color: '#e0b0ff', stroke: false });
  }

  // Spell Card Bonus! popup — spec-ui-stageclear.md §4 / all.c:17171-17193.
  // Label: opaque red, 16px-class, x = (384 - 17*16)/2 + 32 = 88, y = 80.
  // Value: 2× scale light-salmon, re-centered on its own glyph width.
  // Duration 280 frames (all.c:18302-18304). Failure arms nothing.
  private drawSpellBonusPopup(r: Renderer): void {
    const pop = this.bonusPopup;
    if (!pop) return;
    // Fade out over the last 30 frames so the hard cut is less jarring
    // (exe fade path not fully decoded; cosmetic only).
    const alpha = pop.timer < 30 ? pop.timer / 30 : 1;
    const label = 'Spell Card Bonus!';
    const value = Math.trunc(pop.bonus).toLocaleString('en-US').replace(/,/g, '');
    // Label: 16px/glyph class → center over playfield width 384.
    const labelX = PLAYFIELD.x + (PLAYFIELD.width - label.length * 10) / 2;
    r.text(label, labelX, PLAYFIELD.y + 80, { size: 16, color: `rgba(255,0,0,${alpha})` });
    // Value: ~2× scale (32px/glyph class in the exe) light salmon 0xffff8080.
    const valueSize = 28;
    const valueX = PLAYFIELD.x + (PLAYFIELD.width - value.length * (valueSize * 0.6)) / 2;
    r.text(value, valueX, PLAYFIELD.y + 96, {
      size: valueSize,
      color: `rgba(255,128,128,${alpha})`
    });
  }

  // Boss X-position marker at the playfield bottom edge. Exact sprite not
  // recovered from front.anm (spec-ui-stageclear.md §3 — PROBABLE lead is
  // _DAT_004b5ee0 feed); fall back to a small "Enemy" label at ~60% alpha
  // tracking boss.x, clamped to the playfield.
  private drawBossMarker(r: Renderer): void {
    const boss = this.bossActive;
    if (!boss) return;
    const x = PLAYFIELD.x + Math.max(0, Math.min(PLAYFIELD.width, boss.x));
    const y = PLAYFIELD.y + PLAYFIELD.height - 2;
    r.text('Enemy', x, y, { size: 11, color: 'rgba(255,80,80,0.6)', align: 'center' });
  }

  // Vanilla result tally (reference screenshot: stage-2 Lunatic clear):
  // yellow spaced "Stage Clear", then Clear/Point/Graze/Cherry rows with
  // right-aligned values, the red "<Difficulty> Rank *<mult>" line, and
  // Total. Rows reveal one by one; Z advances the stage once all shown.
  private drawStageClear(r: Renderer): void {
    const b = this.clearBonus;
    if (!b) return;
    const ox = PLAYFIELD.x;
    const oy = PLAYFIELD.y;
    const t = this.stageClearTimer || 1;
    const ctx = r.ctx;
    ctx.save();
    ctx.globalAlpha = Math.min(0.45, t / 60);
    ctx.fillStyle = '#000';
    ctx.fillRect(ox, oy + 110, PLAYFIELD.width, 210);
    ctx.restore();
    const spaced = (s: string) => s.split('').join(' ');
    const labelX = ox + 74;
    const valueEndX = ox + 310;
    const num = (v: number) => v.toLocaleString('en-US').replace(/,/g, '');
    const row = (label: string, value: number, y: number, color: string) => {
      r.text(spaced(label), labelX, y, { size: 14, color });
      const txt = num(value);
      r.text(txt, valueEndX - txt.length * 9, y, { size: 14, color });
    };
    // "All Clear!" replaces "Stage Clear" on route-final clears (stage 6 /
    // Extra / Phantasm — exe gate DAT_0062583c >= 6 @ all.c:17063-17067).
    const heading = this.stageNumber >= 6 ? 'All Clear!' : 'Stage Clear';
    r.text(spaced(heading), labelX, oy + 130, { size: 16, color: '#ffcc44' });
    const reveal = Math.floor((t - 20) / 12); // rows appear one by one
    const rows: [string, number][] = [
      ['Clear', b.clear],
      ['Point', b.point],
      ['Graze', b.graze],
      ['Cherry', b.cherry]
    ];
    // Player/Bomb rows only appear on route-final clears (all.c:17081-17094).
    if (this.stageNumber >= 6) {
      rows.push(['Player', b.player], ['Bomb', b.bomb]);
    }
    rows.forEach(([label, value], i) => {
      if (reveal > i) row(label + '  =', value, oy + 168 + i * 22, '#d8d8f8');
    });
    if (reveal > rows.length) {
      const names = ['Easy', 'Normal', 'Hard', 'Lunatic', 'Extra'];
      const y = oy + 176 + rows.length * 22;
      // Phantasm prints no Rank line at all (no else arm in the exe chain).
      if (this.difficulty <= 4) {
        r.text(spaced(`${names[this.difficulty] ?? ''} Rank *${b.mult.toFixed(1)}`), labelX, y, { size: 14, color: '#ff5566' });
      }
      row('Total  =', b.total, y + 24, '#ffffff');
    }
  }

  private drawContinueScreen(r: Renderer): void {
    const cx = PLAYFIELD.x + PLAYFIELD.width / 2;
    const ctx = r.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 16, 0.65)';
    ctx.fillRect(PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
    ctx.restore();
    r.text('Continue?', cx, PLAYFIELD.y + 168, { size: 24, color: '#ffe0a0', align: 'center' });
    r.text(`Credits ${3 - this.continuesUsed}`, cx, PLAYFIELD.y + 204, { size: 13, color: '#ccc', align: 'center' });
    const blink = this.frame % 40 < 28;
    const cur = this.continueScreen!.cursor;
    r.text('Yes', cx - 40, PLAYFIELD.y + 240, {
      size: 16, align: 'center',
      color: cur === 0 ? (blink ? '#fff' : '#ffd700') : '#777'
    });
    r.text('No', cx + 40, PLAYFIELD.y + 240, {
      size: 16, align: 'center',
      color: cur === 1 ? (blink ? '#fff' : '#ffd700') : '#777'
    });
  }

  // Top-left-anchored sprite blit. Renderer#drawSprite centers on (x,y)
  // (entity semantics); the HUD layout spec's coordinates are all top-left
  // corners (the ANM scripts run ins_22 corner-relative), so convert here.
  private blit(r: Renderer, key: string, rect: readonly number[], x: number, y: number, alpha = 1): void {
    if (alpha === 1) {
      const img = r.image(key);
      if (img) r.ctx.drawImage(img, rect[0], rect[1], rect[2], rect[3], x, y, rect[2], rect[3]);
      return;
    }
    r.drawSprite(key, rect[0], rect[1], rect[2], rect[3], x + rect[2] / 2, y + rect[3] / 2, { alpha });
  }

  // Ornate maroon screen frame: tiles front.png's sprite12 (32x32) and
  // sprite13 (128x16) over every region outside the playfield. The tile
  // sizes divide the border area exactly (top/bottom 128x16 bands ×5, side
  // columns 32x32 grids), which is the spec's recommended construction — the
  // ANM scripts carry the tiles but not their positions (engine-placed).
  private drawFrame(r: Renderer): void {
    const right = PLAYFIELD.x + PLAYFIELD.width; // 416
    const bottom = PLAYFIELD.y + PLAYFIELD.height; // 464
    // Top & bottom bands (0..640 × 16), 128px strips.
    for (let x = 0; x < SCREEN_W; x += FRONT.strip128[2]) {
      this.blit(r, 'front', FRONT.strip128, x, 0);
      this.blit(r, 'front', FRONT.strip128, x, bottom);
    }
    // Left column and right sidebar background, 32×32 tiles.
    for (let y = PLAYFIELD.y; y < bottom; y += FRONT.tile32[3]) {
      for (let x = 0; x < PLAYFIELD.x; x += FRONT.tile32[2]) this.blit(r, 'front', FRONT.tile32, x, y);
      for (let x = right; x < SCREEN_W; x += FRONT.tile32[2]) this.blit(r, 'front', FRONT.tile32, x, y);
    }
  }

  // Blits a base-10 integer using the ascii.png 8x12 digit font, top-left
  // corner at (x,y). Optionally zero-pads to `width` digits (scores are
  // fixed-width in the original). Returns the x just past the last digit.
  private drawNumber(r: Renderer, value: number, x: number, y: number, width = 0, alpha = 1): number {
    let s = String(Math.max(0, Math.trunc(value)));
    if (width > 0) s = s.padStart(width, '0');
    for (let i = 0; i < s.length; i++) {
      const d = s.charCodeAt(i) - 48;
      if (d >= 0 && d <= 9) {
        this.blit(r, 'ascii', [d * DIGIT_W, DIGIT_Y, DIGIT_W, DIGIT_H], x + i * DIGIT_W, y, alpha);
      }
    }
    return x + s.length * DIGIT_W;
  }

  // Regular background quad VMs run on Std#animationFrame, which never
  // pauses or rewinds with the script clock (FUN_00406850 @ 0x406850).
  // NOTE both caches floor the target clock: under global slow motion the
  // STD animation clock is FRACTIONAL (…7000.33, 7000.66…), while the cached
  // runner steps in whole frames. Comparing the raw fractional target against
  // the integer runner position made "clock went backward" true on almost
  // every slowed frame, and each such frame rebuilt every background script
  // and replayed it from frame 0 — O(stage-frame) work per script per draw.
  // That was the 餓王剣 (stage-5 Youmu bullet-time) frame-drop report: cost
  // engaged exactly while slowRate < 1 and grew with elapsed stage time.
  // A genuine rewind (the STD op-4 boss loop) still rebuilds correctly.
  private bgAnmFrame(scriptId: number, targetFrame: number): AnmFrame | null {
    const target = Math.floor(targetFrame);
    let entry = this.bgAnmCache.get(scriptId);
    if (!entry || target < entry.frame) {
      const ref = this.bgScripts.get(scriptId);
      if (!ref) return null;
      entry = {
        runner: new AnmRunner(ref.anm, ref.localId, { entryIndex: ref.entryIndex, spriteIndexOffset: ref.spriteBase }),
        frame: 0
      };
      this.bgAnmCache.set(scriptId, entry);
    }
    while (entry.frame < target) {
      entry.runner.update();
      entry.frame++;
    }
    return entry.runner.spriteFrame();
  }

  private specialBgAnmFrame(slot: number, state: { script: number; age: number } | null): AnmFrame | null {
    if (!state) {
      this.specialBgAnmCache[slot] = null;
      return null;
    }
    const targetAge = Math.floor(state.age);
    let entry = this.specialBgAnmCache[slot];
    if (!entry || entry.script !== state.script || targetAge < entry.age) {
      const ref = this.bgScripts.get(state.script);
      if (!ref) return null;
      entry = {
        script: state.script,
        runner: new AnmRunner(ref.anm, ref.localId, { entryIndex: ref.entryIndex, spriteIndexOffset: ref.spriteBase }),
        age: 0
      };
      this.specialBgAnmCache[slot] = entry;
    }
    while (entry.age < targetAge) {
      entry.runner.update();
      entry.age++;
    }
    return entry.runner.spriteFrame();
  }

  // Pseudo-3D stage background: STD quad instances, perspective-projected
  // (see Std#project for the world-space axis convention this relies on),
  // subdivided along depth into strips for perspective-correct-enough
  // texture mapping, sorted back-to-front, with linear distance fog.
  private drawBackground(r: Renderer, ox: number, oy: number): void {
    const std = this.runtime.std;
    // Camera/fog use script time; quad textures use independent VM time.
    const frame = std.frame;
    const camFrame = std.cameraFrame(frame);
    const fog = std.fog(frame);
    const ctx = r.ctx;
    // The sky *is* the current fog color: clear to it every frame, then let
    // quads blend toward it with distance below.
    ctx.fillStyle = fog.css;
    ctx.fillRect(ox, oy, PLAYFIELD.width, PLAYFIELD.height);

    // FUN_00405a30 draws the primary VM, then secondary, before ordinary
    // stage geometry. Their ANM scripts carry screen-space positions.
    const primary = this.specialBgAnmFrame(0, std.primaryAnm);
    const secondary = this.specialBgAnmFrame(1, std.secondaryAnm);
    if (primary) r.drawAnmFrame(primary, 0, 0);
    if (secondary) r.drawAnmFrame(secondary, 0, 0);

    const playfield = { x: ox, y: oy, width: PLAYFIELD.width, height: PLAYFIELD.height };

    type Candidate = {
      depthCenter: number; // camera-relative forward distance; sort/step heuristic only
      lateral0: number;
      lateral1: number;
      depth0: number;
      depth1: number;
      height: number;
      script: number;
    };
    type Job = Candidate & {
      spriteFrame: AnmFrame;
      steps: number;
    };

    // Gather every quad of every instance — stage 1 has only ~31 ground
    // instances plus a couple dozen tree instances (18 quads each), so there's
    // no need to pre-filter by a shared draw-call budget; the per-strip
    // projection below (and Canvas2D itself) cheaply discards anything
    // actually off-screen.
    const candidates: Candidate[] = [];
    for (const inst of std.instances) {
      const obj = std.objects[inst.id];
      if (!obj) continue;
      for (const quad of obj.quads) {
        // STD quads extend from their position CORNER by width/height (the
        // PyTouhou vertex construction: (x,y)..(x+w,y+h)), not around a
        // center point. Corner semantics is what centers stage 1's ground
        // (instance x=-192, quad x=-64, w=512 → lateral [-256,256]) on the
        // camera's track; treating it as a center leaves the road's right
        // half ungeometried, which shows as a fog-colored void wherever
        // only single-side instances exist (most of the stage).
        const lateral0 = inst.x + quad.x;
        const depth0 = inst.y + quad.y;
        const height = inst.z + quad.z;
        candidates.push({
          depthCenter: depth0 + quad.h / 2 - camFrame.y,
          lateral0,
          lateral1: lateral0 + quad.w,
          depth0,
          depth1: depth0 + quad.h,
          height,
          script: quad.script
        });
      }
    }

    const focalDist = (PLAYFIELD.height / 2) / Math.tan(std.fov / 2);
    const jobs: Job[] = [];
    for (const c of candidates) {
      const spriteFrame = this.bgAnmFrame(c.script, std.animationFrame);
      if (!spriteFrame || spriteFrame.alpha <= 0) continue;
      const tl = std.project(c.lateral0, c.depth0, c.height, camFrame, playfield);
      const tr = std.project(c.lateral1, c.depth0, c.height, camFrame, playfield);
      const bl = std.project(c.lateral0, c.depth1, c.height, camFrame, playfield);
      const br = std.project(c.lateral1, c.depth1, c.height, camFrame, playfield);
      const corners = [tl, tr, bl, br].filter((p): p is { x: number; y: number; scale: number } => p != null);
      if (corners.length === 0) continue; // fully behind the camera
      // Only apply the coarse screen-bounds shortcut when all 4 corners
      // projected validly. A quad straddling the near-clip plane (the
      // ground tile the camera is *currently* passing through — this
      // happens every ~256 units of travel) would otherwise get dropped
      // wholesale here despite its far half being clearly visible; the
      // per-cell projection in the paint loop below clips each strip
      // individually, so simply always subdividing it renders correctly.
      if (corners.length === 4) {
        const xs = corners.map((p) => p.x);
        const ys = corners.map((p) => p.y);
        if (Math.max(...xs) < ox - 24 || Math.min(...xs) > ox + PLAYFIELD.width + 24) continue;
        if (Math.max(...ys) < oy - 24 || Math.min(...ys) > oy + PLAYFIELD.height + 24) continue;
      }

      const spanDepth = c.depth1 - c.depth0;
      const nearViewZ = Math.max(60, (c.depth0 - camFrame.y) + focalDist);
      const steps = Math.max(1, Math.min(BG_MAX_CELL_STEPS, Math.round((spanDepth / nearViewZ) * 14)));
      jobs.push({ ...c, spriteFrame, steps });
    }
    jobs.sort((a, b) => b.depthCenter - a.depthCenter);

    const lateralExpand = 10; // world units; hides seams between laterally-adjacent tiles
    for (const job of jobs) {
      const rect = job.spriteFrame;
      const tint = (rect.color & 0x00ffffff) !== 0x00ffffff;
      const img = tint ? r.tintedRect(rect.imageKey, rect.x, rect.y, rect.w, rect.h, rect.color) : r.image(rect.imageKey);
      if (!img) continue;
      const srcX0 = tint ? 0 : rect.x;
      const srcY0 = tint ? 0 : rect.y;
      const flip = rect.scaleX < 0;
      const l0 = job.lateral0 - lateralExpand;
      const l1 = job.lateral1 + lateralExpand;
      // UV is clamped to the sprite's own rect (unlike the geometry below):
      // small decorative quads sit only a few px apart in the atlas (e.g.
      // sprite1/sprite2), so letting UV overflow with the geometry would
      // bleed in neighboring sprites. Clamping just stretches the outermost
      // texel a hair instead — imperceptible at this scale.
      const u0 = srcX0;
      const u1 = srcX0 + rect.w;

      ctx.save();
      ctx.globalAlpha = rect.alpha / 255;
      ctx.globalCompositeOperation = rect.blendAdd ? 'lighter' : 'source-over';

      const spanDepth = job.depth1 - job.depth0;
      // Fraction of [0,1] each cell's *geometry* is expanded by (UV stays
      // clamped to the sprite, see above) — deliberately including the
      // outer i=0/i=steps-1 edges. Canvas2D's antialiased path clipping
      // otherwise leaves hairline gaps between adjacent cells, and between
      // adjacent STD instances stacked in depth, showing the fog clear
      // color through.
      const slack = 0.06 + 0.6 / job.steps;
      // Ground tiles are 256 units deep — a large enough slice of a fog
      // transition (as short as ~300 units near/far apart) that fogging the
      // whole quad as one flat overlay visibly banded at tile boundaries;
      // each cell gets its own alpha from its own depth instead, so the fade
      // stays continuous both within a quad and across adjacent quads.
      const fogSpan = Math.max(1, fog.far - fog.near);
      for (let i = 0; i < job.steps; i++) {
        const t0 = i / job.steps - slack;
        const t1 = (i + 1) / job.steps + slack;
        const d0 = job.depth0 + t0 * spanDepth;
        const d1 = job.depth0 + t1 * spanDepth;
        const ptl = std.project(l0, d0, job.height, camFrame, playfield);
        const ptr = std.project(l1, d0, job.height, camFrame, playfield);
        const pbl = std.project(l0, d1, job.height, camFrame, playfield);
        const pbr = std.project(l1, d1, job.height, camFrame, playfield);
        if (!ptl || !ptr || !pbl || !pbr) continue;
        const cellDepthCenter = (d0 + d1) / 2 - camFrame.y;
        const fogAlpha = clamp((cellDepthCenter - fog.near) / fogSpan, 0, 1);
        // Fully-fogged cells are indistinguishable from the sky clear color;
        // skipping them (instead of painting texture + an opaque fog quad)
        // is what actually dissolves the horizon — the slack-expanded
        // texture edges otherwise peek out past the fog overlay as streaks.
        if (fogAlpha >= 0.98) continue;
        const ct0 = clamp(t0, 0, 1);
        const ct1 = clamp(t1, 0, 1);
        const vLo = flip ? rect.h * (1 - ct1) : rect.h * ct0;
        const vHi = flip ? rect.h * (1 - ct0) : rect.h * ct1;
        r.drawTexturedQuadCell(img, { u0, v0: srcY0 + vLo, u1, v1: srcY0 + vHi }, { tl: ptl, tr: ptr, bl: pbl, br: pbr });
        if (fogAlpha > 0.01) r.fillFogQuad({ tl: ptl, tr: ptr, bl: pbl, br: pbr }, fog.css, fogAlpha);
      }
      ctx.restore();
    }
  }

  // Spellcard background: the scrolling eff01 sheet over the 3D scene while
  // a card is active. Open-coded from eff01.anm script 0 — cornerRel quad at
  // (32,16) sized 384x448 (a tiled view of the 256x256 texture), alpha
  // 0->255 over 60 frames, then a per-frame loop shifting u +0.004167 and
  // v -0.008333. Not run through AnmRunner: the script's op-4 frame-reset
  // loop would pin the frame-keyed fade interpolation near zero.
  // Spell-card playfield background: entry 0 of the stage's own eff0N.anm,
  // faded in over 60 frames (op15) and then presented per that script's own
  // authored model (decoded per stage, recon spellbg-diagnosis.md):
  //   stages 1/2 + 6-layer0: 384x448 oversized sprite over a 256x256 texture
  //     = GPU tile-wrap with per-frame op26/27 UV scroll (stage 1 scrolls
  //     diagonally u+0.004167/v-0.008333; stages 2/6 scroll v+0.008333 ONLY);
  //   stage 3: 256x256 stretched by op7 scale(1.5,1.75) with a v-wrapping
  //     pan inside the single stretched quad;
  //   stages 5/7/8: 256x256 stretched static — NO tiling, NO scroll (the old
  //     one-size eff01 pattern produced the seamy 2x3 grid the testers saw);
  //   stage 6 additionally layers entry 1 (eff06) as a static stretched
  //     overlay alpha-capped at 224/255;
  //   stage 4's eff04 entries are not corner-anchored backgrounds at all
  //     (flagged open) — kept on the legacy tiled path.
  private drawSpellBackground(r: Renderer): void {
    const sc = this.spellcard;
    if (!sc) return;
    if (this.stageNumber === 5 && this.spellBackgroundRunners.length) {
      for (const runner of this.spellBackgroundRunners) {
        r.drawAnmFrame(runner.spriteFrame(), 0, 0);
      }
      return;
    }
    // Per-stage effect sheet; resolved via the ANM entry's own texture name
    // (eff07.anm's textures are eff07b/eff07c — there is no eff07.png).
    const img = r.image(this.effectAnm.entries[0]?.imageKey ?? 'eff01');
    if (!img) return;
    const ctx = r.ctx;
    const fade = Math.min(1, sc.declAge / 60);
    const staticStretch = this.stageNumber === 5 || this.stageNumber === 7 || this.stageNumber === 8;
    ctx.save();
    ctx.globalAlpha = fade;
    if (staticStretch) {
      ctx.drawImage(img, 0, 0, img.width, img.height, PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
    } else if (this.stageNumber === 3) {
      // Stretched quad with a v-wrapping pan: draw two stacked stretched
      // copies offset by the wrapped scroll so the seamless cycle of the
      // original's UV window survives without tiling artifacts.
      const dv = ((0.004167 * 256 * sc.declAge) % 256) * (PLAYFIELD.height / 256);
      ctx.beginPath();
      ctx.rect(PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
      ctx.clip();
      ctx.drawImage(img, 0, 0, img.width, img.height, PLAYFIELD.x, PLAYFIELD.y + dv - PLAYFIELD.height, PLAYFIELD.width, PLAYFIELD.height);
      ctx.drawImage(img, 0, 0, img.width, img.height, PLAYFIELD.x, PLAYFIELD.y + dv, PLAYFIELD.width, PLAYFIELD.height);
    } else {
      if (!this.eff01Pattern) this.eff01Pattern = ctx.createPattern(img, 'repeat');
      if (this.eff01Pattern) {
        // Stage 1 scrolls diagonally; stages 2/6 (and legacy stage 4)
        // scroll vertically only.
        const u = this.stageNumber === 1 ? 0.004167 * 256 * sc.declAge : 0;
        const v = this.stageNumber === 1 ? -0.008333 * 256 * sc.declAge : 0.008333 * 256 * sc.declAge;
        ctx.save();
        ctx.translate(PLAYFIELD.x - u, PLAYFIELD.y - v);
        ctx.fillStyle = this.eff01Pattern;
        ctx.fillRect(u, v, PLAYFIELD.width, PLAYFIELD.height);
        ctx.restore();
      }
    }
    // Stage 6's second authored layer: entry 1 (eff06.png) statically
    // stretched over the field at 224/255 alpha.
    if (this.stageNumber === 6) {
      const overlay = r.image(this.effectAnm.entries[1]?.imageKey ?? '');
      if (overlay) {
        ctx.globalAlpha = fade * (224 / 255);
        ctx.drawImage(overlay, 0, 0, overlay.width, overlay.height, PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
      }
    }
    ctx.restore();
  }

  // Declaration-time effects drawn over the playfield entities: the teal
  // flash (capture.anm scr0: full-playfield quad, color 0x10c0e0, 30-frame
  // fade in/out — its runtime '@' texture is not extractable, so a flat
  // tint approximates it) and the boss portrait cutin sweep (face_01_00,
  // the dialogue portrait art; path/timing approximated — AGENTS.md §7).
  private drawSpellDeclaration(r: Renderer, ox: number, oy: number): void {
    const sc = this.spellcard;
    if (!sc) return;
    const t = sc.declAge;
    const ctx = r.ctx;
    if (t < 60) {
      const flash = (t < 30 ? t / 30 : 1 - (t - 30) / 30) * 0.5;
      ctx.save();
      ctx.globalAlpha = flash;
      ctx.fillStyle = 'rgb(16,192,224)';
      ctx.fillRect(ox, oy, PLAYFIELD.width, PLAYFIELD.height);
      ctx.restore();
    }
    if (t < 110) {
      const sprite = this.faceAnm.sprites.get(sc.portraitSprite);
      const img = sprite ? r.image(sprite.imageKey) : null;
      if (sprite && img) {
        const p = t / 110;
        const scale = 0.85;
        const w = sprite.w * scale;
        const h = sprite.h * scale;
        const x = ox + PLAYFIELD.width * 0.62 - w / 2;
        // Ease-out vertical sweep, fading in and back out at the ends.
        const ease = 1 - (1 - p) * (1 - p);
        const y = oy + PLAYFIELD.height / 2 - h / 2 + 140 - ease * 280;
        const alpha = Math.min(1, Math.min(p, 1 - p) * 5) * 0.55;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(img, sprite.x, sprite.y, sprite.w, sprite.h, x, y, w, h);
        ctx.restore();
      }
    }
  }

  private drawSpellOverlay(r: Renderer): void {
    if (!this.spellName) return;
    const sc = this.spellcard;
    const declAge = sc?.declAge ?? 999;
    const ctx = r.ctx;
    // Declaration window: the name rides a red ribbon banner in the lower
    // third, with Bonus / History beneath (text.anm's pre-rendered banner
    // textures are not extractable — r.text over a gradient approximates
    // the original look); afterwards it rests top-right under the HP bar.
    const declPhase = Math.min(1, Math.max(0, (declAge - 120) / 30));
    const slideIn = Math.min(1, declAge / 20);
    const bannerY = PLAYFIELD.y + 300;
    const restY = PLAYFIELD.y + 22;
    const y = bannerY + (restY - bannerY) * declPhase;
    const xRest = PLAYFIELD.x + PLAYFIELD.width - 12;
    const xBanner = PLAYFIELD.x + PLAYFIELD.width - 16 + (1 - slideIn) * 120;
    const x = xBanner + (xRest - xBanner) * declPhase;
    if (declPhase < 1) {
      const bannerAlpha = (1 - declPhase) * slideIn;
      const grad = ctx.createLinearGradient(PLAYFIELD.x, 0, PLAYFIELD.x + PLAYFIELD.width, 0);
      grad.addColorStop(0, 'rgba(160,16,16,0)');
      grad.addColorStop(0.55, 'rgba(190,24,24,0.75)');
      grad.addColorStop(1, 'rgba(120,8,8,0.9)');
      ctx.save();
      ctx.globalAlpha = bannerAlpha;
      ctx.fillStyle = grad;
      ctx.fillRect(PLAYFIELD.x, y - 13, PLAYFIELD.width, 18);
      ctx.restore();
    }
    r.text(this.spellName, x, y, { size: 13, color: '#fee', align: 'right' });
    if (sc) {
      const tally = this.spellHistory.get(sc.id);
      const history = tally ? `  history ${tally.got}/${tally.seen}` : '';
      const bonusText = sc.capturing ? `Bonus ${(sc.bonus + sc.grazeBonus).toLocaleString('en-US')}${history}` : `Bonus failed${history}`;
      r.text(bonusText, x, y + 18, { size: 11, color: sc.capturing ? '#adf' : '#977', align: 'right' });
    }
  }

  private drawDialogue(r: Renderer): void {
    const d = this.dialogue;
    if (!d) return;
    const ctx = r.ctx;
    const family = CHARACTERS[this.playerObj.character].family;
    const playerFaceKey = (['face_rm00', 'face_mr00', 'face_sk00'] as const)[family];
    const anms = [this.assets.anms[playerFaceKey], this.faceAnm];
    for (let side = 0; side < 2; side++) {
      const p = d.portraits[side];
      if (!p?.visible) continue;
      const anm = anms[side];
      if (!anm) continue;
      const sprite = portraitSprite(anm, p.face);
      if (!sprite) continue;
      const scale = 0.5;
      const w = sprite.w * scale;
      const h = sprite.h * scale;
      const baseX = side === 0 ? PLAYFIELD.x + 10 + (p.slideIn - 1) * 60 : PLAYFIELD.x + PLAYFIELD.width - w - 10 - (p.slideIn - 1) * 60;
      const y = PLAYFIELD.y + PLAYFIELD.height - h + 8;
      ctx.save();
      ctx.globalAlpha = p.active ? 1 : 0.55;
      const img = r.image(sprite.imageKey);
      if (img) {
        if (!p.active) ctx.filter = 'brightness(0.55)';
        ctx.drawImage(img, sprite.x, sprite.y, sprite.w, sprite.h, baseX, y, w, h);
        ctx.filter = 'none';
      }
      ctx.restore();
    }
    // Text box
    const boxY = PLAYFIELD.y + PLAYFIELD.height - 82;
    ctx.fillStyle = 'rgba(8, 8, 24, 0.78)';
    ctx.fillRect(PLAYFIELD.x + 8, boxY, PLAYFIELD.width - 16, 66);
    ctx.strokeStyle = 'rgba(160, 160, 220, 0.5)';
    ctx.strokeRect(PLAYFIELD.x + 8.5, boxY + 0.5, PLAYFIELD.width - 17, 65);
    if (d.lines[0]) r.text(d.lines[0], PLAYFIELD.x + 22, boxY + 12, { size: 14 });
    if (d.lines[1]) r.text(d.lines[1], PLAYFIELD.x + 22, boxY + 36, { size: 14 });
    if (d.bossIntroTimer > 0 && d.bossIntro.length) {
      const cx = PLAYFIELD.x + PLAYFIELD.width - 20;
      d.bossIntro.slice(-2).forEach((line, i) => {
        r.text(line, cx, PLAYFIELD.y + 120 + i * 22, { size: 15, color: '#fbd', align: 'right' });
      });
    }
  }

  // Stage title card during the opening seconds, using the stage/song names
  // decoded from the STD data.
  // Vanilla stage intro: play stdNtxt.anm's five scripts verbatim — crest,
  // vertical JP title, "Stage N", subtitle strip, and the vertical BGM
  // label — all positioned in screen coordinates by the scripts themselves
  // (see the constructor note). Runners self-remove around frame 460.
  private drawStageTitle(r: Renderer): void {
    for (const runner of this.stageIntroRunners) {
      if (runner.removed) continue;
      r.drawAnmFrame(runner.spriteFrame(), 0, 0);
    }
  }

  // PCB right sidebar, rebuilt from the original front.png sprites: the seven
  // label bitmaps (HiScore/Score/Player/Bomb/Power/Graze/Point) at their
  // exact resting columns, values in the ascii.png 8x12 digit font, life/bomb
  // stars, the Power bar, and the 東方妖々夢 logo + caption watermark. The
  // Cherry counters are NOT sidebar rows in the original (no such glyphs
  // exist in front.png); they live in a bottom-edge readout, see below.
  private drawSidebar(r: Renderer): void {
    const ctx = r.ctx;
    const labelX = 432; // resting column for every front.png label (spec §1.2)
    const valueX = 504; // digit readouts start just past the 64px label box
    const p = this.playerObj;
    const label = (rect: readonly number[], y: number) => this.blit(r, 'front', rect, labelX, y);
    const star = (rect: readonly number[], sx: number, sy: number) => this.blit(r, 'front', rect, sx, sy);

    // Logo panel + caption watermark (drawn first so text/labels sit on top).
    this.blit(r, 'front', FRONT.logo, 480, 208);
    this.blit(r, 'front', FRONT.caption, 448, 336);

    label(FRONT.hiscore, 48);
    // The exe's score HUD prints the internal score with a literal appended
    // zero ("%8d0" @ FUN_00429446 region) — displayed value = internal x10,
    // last digit always 0 (the slot vanilla uses for the continue count).
    this.drawNumber(r, Math.max(this.hiScore, this.score) * 10, valueX, 50, 9);
    label(FRONT.score, 64);
    this.drawNumber(r, this.score * 10, valueX, 66, 9);

    label(FRONT.player, 96);
    for (let i = 0; i < Math.max(0, p.lives); i++) star(FRONT.redStar, valueX + i * 16, 96);
    label(FRONT.bomb, 112);
    for (let i = 0; i < Math.max(0, p.bombs); i++) star(FRONT.blueStar, valueX + i * 16, 112);

    // Power row, exe-exact (sidebar draw @ all.c:18593-18648): an untextured
    // gradient quad from x=496 (0x48ecb0) to 496+power, y 144..160, vertex
    // colors ARGB 0xE0E0E0FF top / 0x80E0E0FF bottom (light periwinkle,
    // alpha 224 fading to 128); then the power value as HUD digits, or the
    // literal string "MAX" (DAT_0048e138) at 128.
    label(FRONT.power, 144);
    if (p.power > 0) {
      const grad = ctx.createLinearGradient(0, 144, 0, 160);
      grad.addColorStop(0, 'rgba(224,224,255,0.878)');
      grad.addColorStop(1, 'rgba(224,224,255,0.502)');
      ctx.fillStyle = grad;
      ctx.fillRect(496, 144, Math.min(128, p.power), 16);
    }
    if (p.power >= 128) r.text('MAX', 496, 146, { size: 12, color: '#fff' });
    else this.drawNumber(r, p.power, 496, 146);

    label(FRONT.graze, 160);
    this.drawNumber(r, this.graze, valueX, 162);
    // Point row displays "collected/next-extend threshold" ("%d/%d" @
    // all.c:18587, stats +0x28 / +0x30). Slash = ascii.png 16px-font glyph.
    label(FRONT.point, 176);
    const pointEnd = this.drawNumber(r, this.pointItems, valueX, 178);
    r.text('/', pointEnd + 1, 178, { size: 12, color: '#eee', stroke: false });
    this.drawNumber(r, this.extendThreshold, pointEnd + 8, 178);

    // Cherry readout hugging the screen's bottom-left (ascii.anm script4;
    // exe draw @ all.c:1760-1870): the main row is `cherry / cherryMax`
    // (the vanilla gauge — e.g. 86120/310000 on Lunatic), with the current
    // cherry right-aligned into the banner sprite's blank slot ending at
    // the baked slash (in-sprite x≈84) and cherryMax after it. The small
    // purple `+cherryPlus` (border progress toward 50000, exe vertex color
    // B/G/R = 0xb0/0x80/0xc0) floats above the blank. The banner sprite
    // dims to alpha 64/255 while charging and runs full-bright while the
    // border is up; the engine-drawn digits stay opaque.
    this.blit(r, 'ascii', [0, 224, 96, 16], PLAYFIELD.x, 448, this.cherry.borderActive ? 1 : 64 / 255);
    const cherryStr = String(Math.max(0, Math.trunc(this.cherry.cherry)));
    this.drawNumber(r, this.cherry.cherry, PLAYFIELD.x + 84 - cherryStr.length * DIGIT_W, 450);
    this.drawNumber(r, this.cherry.cherryMax, PLAYFIELD.x + 96, 450);
    // Exe layout (all.c:1846-1850 + rdata 0x48ec7c/0x48eac0): cherryPlus is
    // drawn one text row ABOVE the cherry/cherryMax line (base+2 vs base+11),
    // in the purple B/G/R 0xb0/0x80/0xc0 — right-aligned over the cherry
    // field so it never collides with cherryMax.
    // While a border is up, the exe repurposes the live cherryPlus storage
    // itself as the countdown. CherrySystem preserves the native write-before-
    // timer-advance order, including the repeated 50000 first active tick.
    const plusVal = Math.max(0, Math.trunc(this.cherry.cherryPlus));
    r.text(`+${plusVal}`, PLAYFIELD.x + 84, 444, { size: 10, color: '#c080b0', align: 'right' });

    if (this.bossActive) {
      const hp = Math.max(0, this.bossActive.hp);
      const max = Math.max(1, this.bossActive.maxHp);
      ctx.fillStyle = '#311';
      ctx.fillRect(PLAYFIELD.x + 40, PLAYFIELD.y + 6, PLAYFIELD.width - 80, 5);
      ctx.fillStyle = '#e55';
      ctx.fillRect(PLAYFIELD.x + 40, PLAYFIELD.y + 6, (PLAYFIELD.width - 80) * (hp / max), 5);
      for (let i = 0; i < this.bossLifeCount; i++) {
        this.drawStar(ctx, PLAYFIELD.x + 12 + i * 12, 9, '#e55');
      }
      const seconds = Math.max(0, Math.trunc((this.timerThreshold() - this.bossActive.ecl.bossTimer) / 60));
      this.drawNumber(r, seconds, PLAYFIELD.x + PLAYFIELD.width - 20, PLAYFIELD.y + 4, 2);
      // ename.png rows 0..15 are stage pairs (midboss, final boss) — the
      // row follows the CURRENT boss's root sub (UI-001), not a
      // dialogue-seen latch (stage 6 has two dialogue-bearing encounters).
      if (!this.dialogue) {
        const row = enameRowForBoss(this.stageNumber, this.bossActive.ecl.subId);
        this.blit(r, 'ename', [0, row * 16, 128, 16], 32, 26);
      }
    }
  }

  // Bottom-right difficulty tag (+ the Practice tag above it), straight from
  // pause.png: the authored ascii.anm entry-2 scripts place the 64x16 tags
  // corner-anchored at x=344 (difficulty y=444, practice y=428).
  private drawModeTags(r: Renderer): void {
    // Column layout pixel-verified against pause.png: Hard/Lunatic stack at
    // x=128, Easy/Normal at x=192 (the reverse of reading order).
    const DIFF_TAG_RECTS = [
      [192, 0, 64, 16], // Easy
      [192, 16, 64, 16], // Normal
      [128, 0, 64, 16], // Hard
      [128, 16, 64, 16], // Lunatic
      [192, 192, 64, 16], // Extra
      [192, 208, 64, 16] // Phantasm
    ] as const;
    const rect = DIFF_TAG_RECTS[this.difficulty] ?? DIFF_TAG_RECTS[1];
    this.blit(r, 'pause', rect, 344, 444, 0.9);
    if (this.mode === 'practice') this.blit(r, 'pause', [192, 240, 64, 16], 344, 428, 0.9);
  }

  private timerThreshold(): number {
    const s = this.bossActive?.ecl;
    if (!s) return 0;
    if (s.timerCallbackThreshold >= 0) return s.timerCallbackThreshold;
    // op148 is now an HP-threshold callback (no timer subs remain); fall back
    // to the default spell-card window.
    return 6000;
  }

  private drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string): void {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      const b = a + Math.PI / 5;
      ctx.lineTo(cx + Math.cos(a) * 6, cy + Math.sin(a) * 6);
      ctx.lineTo(cx + Math.cos(b) * 2.6, cy + Math.sin(b) * 2.6);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
