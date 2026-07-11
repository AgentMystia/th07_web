import { StageRuntime, type StageData } from './eclvm';
import type { GameHost, Enemy, EnemyBullet, EnemyLaser, ItemEntity, ItemType, EffectParticle } from './types';
import { Rng } from '../core/rng';
import { normalizeAngle, clamp } from '../core/util';
import type { InputFrame } from '../core/input';
import { Renderer, PLAYFIELD, SCREEN_W } from '../gfx/renderer';
import type { GameAssets } from './assets';
import { Anm, AnmRunner, type AnmFrame } from '../formats/anm';
import { TH07_DATA } from '../data/th07-data';
import type { AudioBus } from '../audio/audio';
import { CHARACTERS, Player, type CharacterId, type PlayerBullet } from './player';
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
  pointBullet: 12 // type 8: unboxed petal used by the Border-break circle
};
// Per-type offscreen indicator arrows sit 10 embedded ids after their item
// (emb14-21, same order) — drawn while an item is still above the top edge.
const ITEM_ARROW_OFFSET = 10;
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

export class StageScene implements GameHost {
  rng = new Rng();
  difficulty = 1;
  // Th07.exe DAT_00625884 lives in .data's zero-fill tail (BSS) — retail
  // rank is 0 for the whole game: nothing writes it during play and no
  // stage ECL touches its var (10017); replays just round-trip the 0. At
  // rank 0 the non-spell FIRE scale contributes spdLo (default -0.5) and
  // countLo, and op73/74 intervals stretch x1.2 (see eclvm). The previous
  // hardcoded 16 made every non-spell pattern 0.5 px/f faster and fire 20%
  // more often than vanilla.
  rank = 0;
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
  enemyBullets: EnemyBullet[] = [];
  enemyLasers: EnemyLaser[] = [];
  postBombLaserCounter = 0;
  items: ItemEntity[] = [];
  particles: EffectParticle[] = [];
  power = 0;
  score = 0;
  focusHeld = false;
  runtime: StageRuntime;
  playerObj: Player;
  playerBullets: PlayerBullet[] = [];
  graze = 0;
  pointItems = 0;
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
  private bodyGrazeCooldown = new Map<number, number>();
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
  mode: 'arcade' | 'test' = 'arcade';
  onExitToTitle: (() => void) | null = null;
  // Fired (arcade mode, stages 1-5) when the player advances past the
  // stage-clear tally; the host tears this scene down and starts stage+1
  // with carryState(). Null/unset → fall back to exitToTitle.
  onStageComplete: ((carry: RunCarry) => void) | null = null;
  continueScreen: { cursor: number } | null = null;
  continuesUsed = 0;
  private gameOverTimer = 0;
  // Post-respawn continuous silent field clear (exe player+0x2400, 60f).
  private respawnClearFrames = 0;
  stageClearTimer = 0;
  private exitFired = false;
  private stageCompleteFired = false;
  cherry: CherrySystem;
  hiScore = 100000;
  dialogue: DialogueRunner | null = null;
  private dialogueResume = false;
  stageFrame = 0;
  stageClear = false;
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
    declAge: number;
    portraitSprite: number;
  } | null = null;
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
  // Each stage owns two consecutive ename.png rows: midboss, then boss.
  // Dialogue starts only for the latter and latches the within-stage row.
  private dialogueSeen = false;
  private eff01Pattern: CanvasPattern | null = null;

  // Global sprite id of etama entry 1's embedded sprite 0 (the etama2.png
  // item sheet); see ITEM_SPRITES above.
  private readonly etamaItemBase: number;
  // Script-driven bomb visuals (see spawnBombEffects).
  private readonly playerEffects: PlayerEffects;
  private prevBombTimer = 0;
  // Moving bomb attack hitboxes (exe player+0x9dc pool; see player-bombs.ts).
  private readonly bombEngine = new BombEngine();
  private readonly activeBombSlots: AttackSlot[] = [];
  // The active bomb form's decoded state machine (12 forms, player-bombs.ts).
  private bombRunner: BombRunner | null = null;
  // Latched bomb duration (frames) for end-window checks (ReimuA focused's
  // final-30-frames detonation, etc.).
  private bombDuration = 0;
  // Bomb-local frame counter (exe 16a38): 0 on the first active tick.
  private bombFrame = 0;
  // Player-wide hit tally (exe player+0x240c): beams/attack slots pop a
  // spark on every 8th (lasers) / 4th (bomb slots) accumulated hit.
  private playerHitTally = 0;
  // Floating number popups: two contiguous ring pools in the exe (720 large,
  // 3 small — the latter serves small cherry pickups). FUN_00401ad0 updates
  // all 723 slots: rise 0.5 px per rate-scaled frame and retire after 60.
  private popupsLarge: ScorePopup[] = Array.from({ length: 720 }, makeScorePopup);
  private popupsSmall: ScorePopup[] = Array.from({ length: 3 }, makeScorePopup);
  private popupCursorLarge = 0;
  private popupCursorSmall = 0;

  constructor(
    private assets: GameAssets,
    private audio: AudioBus,
    difficulty = 1,
    character: CharacterId = 'reimuA',
    stageNumber = 1,
    carry: RunCarry | null = null
  ) {
    // The native game loads every SE buffer before play. Web Audio otherwise
    // drops the first request while fetching it; se_pldead00 is normally used
    // only on the first miss, so without this preload that miss is silent.
    this.audio.preloadSfx(SFX_SLOTS.map(([file]) => file));
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
          if (this.isDialogueBlocking() || p.bombTimer > 0 || p.bombInvuln > 0 ||
              p.invulnFrames > 0 || p.materializeFrame >= 0 || p.dyingFrame >= 0) {
            return 'defer';
          }
          // State 2 with a live deathbomb meter consumes the pending border
          // through FUN_0043eb00: no miss, no border timer, 40f invulnerability.
          if (p.deathTimer >= 0) return 'cancel';
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
            // 40 frames and displays post-award cherry*10, while score gains
            // post-award cherry*1.
            this.playerObj.invulnFrames = Math.max(this.playerObj.invulnFrames, 40);
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
    this.etamaItemBase = assets.anms.etama.entries[1].spriteBase;
    this.playerObj = new Player(character, assets.anms);
    this.playerEffects = new PlayerEffects(this.playerObj.anm);
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
      this.startStageTransition();
    }
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
  // lives, else +1 bomb below 8 bombs, else nothing. se_extend either way.
  private awardExtend(): void {
    const p = this.playerObj;
    if (p.lives < 8) p.lives++;
    else if (p.bombs < 8) p.bombs++;
    else return;
    this.playSfx(28);
  }

  // Stage-clear bonus, exe-exact (FUN_00429446's credit block @
  // all.c:18308-18337, display strings @ all.c:17038-17120):
  //   internal = stage*100000 + graze*50 + pointItems*5000 + cherry
  //   [+ lives*2,000,000 + bombs*400,000 on route-final clears (stage>5)]
  //   Easy /2, Hard *12/10, Lunatic *15/10, Extra <<1; Normal AND Phantasm
  //   have no arm (x1.0 — the Phantasm screen prints no Rank line at all).
  //   Continue penalty: x0.5 / x0.2 tiers.
  // The tally rows display internal*10 (the exe's "%8d0" appended-zero
  // trick); the score field gains the internal total via ten +=/10 ticks.
  private computeClearBonus(): void {
    const finalClear = this.stageNumber >= 6;
    let internal =
      this.stageNumber * 100000 + this.graze * 50 + this.pointItems * 5000 + this.cherry.cherry;
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
    if (this.continuesUsed > 0) internal = Math.trunc((internal * 5) / 10);
    this.clearBonus = {
      clear: this.stageNumber * 1000000,
      point: this.pointItems * 50000,
      graze: this.graze * 500,
      cherry: this.cherry.cherry * 10,
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
      extendLevel: this.extendLevel
    };
  }

  // -- GameHost --------------------------------------------------------------

  addScore(v: number): void {
    this.score += v;
  }

  setSlowRate(rate: number): void {
    this.slowRate = rate;
  }

  // Screen FX scheduler (exe FUN_004459c0). Type 1 shake: each frame both
  // camera axes independently pick {0, +mag, -mag}, mag ramping from->to
  // over the duration. Type 3 flash: a full-screen tint held `duration`
  // frames, repeated `repeats` times, alpha from the ARGB high byte.
  private screenShake: { duration: number; elapsed: number; from: number; to: number } | null = null;
  private screenFlash: { duration: number; timer: number; repeats: number; color: number } | null = null;
  private shakeX = 0;
  private shakeY = 0;

  startScreenShake(duration: number, from: number, to: number): void {
    this.screenShake = { duration: Math.max(1, duration), elapsed: 0, from, to };
  }

  startScreenFlash(duration: number, repeats: number, argb: number): void {
    this.screenFlash = { duration: Math.max(1, duration), timer: 0, repeats, color: argb >>> 0 };
  }

  fadeBgm(seconds: number): void {
    this.audio.fadeOutBgm(seconds);
  }

  private tickScreenFx(): void {
    const shake = this.screenShake;
    this.shakeX = 0;
    this.shakeY = 0;
    if (shake) {
      const mag = shake.from + (shake.elapsed / shake.duration) * (shake.to - shake.from);
      const pick = () => [0, mag, -mag][this.rng.u32InRange(3)];
      this.shakeX = pick();
      this.shakeY = pick();
      if (++shake.elapsed >= shake.duration) this.screenShake = null;
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

  spawnItem(type: ItemType, x: number, y: number, options: { state?: number; vx?: number; vy?: number } = {}): void {
    // Th07.exe item pool is a fixed 1100-slot array — FUN_00430970 scans for
    // a free slot and silently drops the spawn when none is left (the 0x44c
    // loop bound appears in every item pass, e.g. FUN_00431d10/FUN_00431da0).
    // Without the cap, a Lunatic boss-phase sweep pushed 1000+ items in one
    // frame on top of the existing field and the item pass froze the game.
    if (this.items.length >= 1100) return;
    // Th07.exe (v1.00b) item spawn primitive FUN_00430970 @ 0x430970: at full
    // power, power(0)/bigPower(2) drops convert to bigCherry(7) -- so max-power
    // players get value items instead of wasted power.
    if (this.playerObj.power >= 128 && (type === 'power' || type === 'bigPower')) type = 'bigCherry';
    this.items.push({
      id: this.id++,
      x, y,
      vx: options.vx ?? 0,
      vy: options.vy ?? -2.2,
      type,
      age: 0,
      state: options.state ?? 0
    });
  }

  spawnEffectParticles(effectId: number, x: number, y: number, count: number, color: number): void {
    // Approximation of the original etama-based effect scripts (documented
    // deviation, to be refined): simple drifting/fading particles.
    const isSnow = effectId >= 18;
    for (let i = 0; i < Math.min(count, 64); i++) {
      const angle = this.rng.range(Math.PI * 2);
      // Decorative particles bake the current slow rate into their spawn
      // velocity and then tick at wall clock (exe FUN_004194d0 family /
      // FUN_00419650; spec-slowmo.md §3.4.5).
      const speed = (isSnow ? 0.2 + this.rng.range(0.5) : 0.5 + this.rng.range(2)) * this.slowRate;
      this.particles.push({
        id: this.id++,
        x: x + (isSnow ? this.rng.range(384) - 192 : 0),
        y: y + (isSnow ? this.rng.range(64) - 32 : 0),
        vx: isSnow ? -0.3 - this.rng.range(0.4) : Math.cos(angle) * speed,
        vy: isSnow ? 0.7 + this.rng.range(0.8) : Math.sin(angle) * speed,
        age: 0,
        life: isSnow ? 240 : 24 + this.rng.u32InRange(16),
        color,
        size: isSnow ? 2 + this.rng.range(2) : 3,
        kind: isSnow ? 'snow' : 'spark'
      });
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
    for (const it of this.items) {
      if (it.dead) continue;
      it.state = 1;
      it.vx = 0;
      it.vy = -0.5;
    }
    // msg1.dat entry layout is sparse: character*10 + phase (0 pre-boss,
    // 1 post-boss) — entries 0/1 Reimu, 10/11 Marisa, 20/21 Sakuya. The ECL
    // timeline passes only the phase; the engine adds the character offset.
    const entry = CHARACTERS[this.playerObj.character].family * 10 + index;
    this.dialogue = new DialogueRunner(this.runtime.msg, entry, {
      playBgm: (track) => {
        // Th07.exe FUN_00428392 case 7 (@ 0x4288ae): the argument indexes
        // this stage's BGM descriptor table, not the global thbgm list.
        // Every original pre-boss MSG uses slot 1 (the boss theme).
        const name = stageBgmTrack(this.stageNumber, track);
        if (name) this.audio.playBgm(name);
      },
      fadeBgm: () => this.audio.fadeOutBgm(4)
    });
  }

  isDialogueBlocking(): boolean {
    return !!this.dialogue && !this.dialogue.done;
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
    // Stage-1 spell ownership decoded from ecldata1 op 90: ids 0-1 are the
    // Cirno midboss cards (霜符「フロストコラムス」), 2-9 Letty's — picks
    // the face_01_00 cutin portrait (sprite 3 = Cirno, 0 = Letty).
    const portraitSprite = spellId <= 1 ? 3 : 0;
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
      declAge: 0,
      portraitSprite
    };
    this.spellBanner = 150;
    const tally = this.spellHistory.get(spellId) ?? { seen: 0, got: 0 };
    tally.seen++;
    this.spellHistory.set(spellId, tally);
    this.playSfx(14);
    // Declaration charge burst at the boss (se_cat00 above is the charge SE).
    if (this.bossActive) this.spawnEffectParticles(3, this.bossActive.x, this.bossActive.y, 24, 0xffffffff);
  }

  endBossSpell(): boolean {
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
    // Exe FUN_0040f340: the scored phase-end field sweep only runs when the
    // spell did not time out (DAT_012f40a8 still 1). Getting HIT during the
    // spell voids the bonus but NOT the sweep.
    const sweep = !this.phaseTimedOut;
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
    this.enemyBullets.length = 0;
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

  spawnEnemyDeathEffect(e: Enemy): void {
    this.spawnEffectParticles(3, e.x, e.y, 12, 0xffffffff);
  }

  // Th07.exe FUN_00422ea0(1) (op80, spell declare, full-power crossing):
  // every live enemy bullet becomes an auto-collecting small cherry item
  // (type 6 = the cancel type FUN_00421a40 bakes into +0x37a160; mode 1
  // sets the item's autocollect byte +0x27f). No score popups on this path.
  cancelBulletsToItems(): void {
    for (const b of this.enemyBullets) {
      if (b.dead) continue;
      this.spawnItem('cherry', b.x, b.y, { state: 1 });
    }
    this.enemyBullets.length = 0;
    // FUN_00422ea0(1) also converts each non-immune live laser at its
    // origin and every 32 px along [nearDist, farDist).
    this.cancelLaserField(false, true);
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
      this.spawnItem('cherry', b.x, b.y, { state: 1 });
      // FUN_00423100 @ all.c:15624: escalating popup per bullet — white
      // while ramping, yellow once the 8000 cap is reached.
      this.spawnScorePopup(value, b.x, b.y, value < 8000 ? 0xffffffff : 0xffffff00);
      total += value;
      value = Math.min(8000, value + 20);
    }
    this.enemyBullets.length = 0;
    // FUN_00423100 does not apply the bomb-immunity flag to lasers. Their
    // converted items do not contribute to the escalating score total.
    this.cancelLaserField(true, true);
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

  private cancelLaserField(unconditional: boolean, spawnItems: boolean): void {
    for (const l of this.enemyLasers) {
      if (!l.inUse) continue;
      if ((l.flags & 4) !== 0 && !unconditional) continue;
      if (l.state < 2) {
        l.state = 2;
        l.phaseFrame = 0;
        l.width = l.displayWidth;
        if (spawnItems) {
          this.spawnItem('cherry', l.x, l.y, { state: 1 });
          const cos = Math.cos(l.angle);
          const sin = Math.sin(l.angle);
          // Th07.exe (v1.00b) FUN_00422ea0 @ 0x422ea0 and
          // FUN_00423100 @ 0x423100; DAT_0048ead4 = 32.0f.
          for (let d = l.nearDist; d < l.farDist; d += 32) {
            this.spawnItem('cherry', l.x + cos * d, l.y + sin * d, { state: 1 });
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
      exAccel: null,
      exAngle: null,
      exDir: null,
      exBounce: null,
      dirTimes: undefined,
      dead: false
    });
    this.enemyBullets.length = 0;
    this.enemyBullets.push(
      make(p.x, 0),
      make(p.x + 160, 0),
      make(p.x + 160, 0x1000)
    );
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
    // The continue screen freezes gameplay entirely, like the original.
    if (this.continueScreen) {
      this.updateContinueScreen(input);
      return;
    }
    // Declined / exhausted continues: linger on GAME OVER, then leave.
    if (this.gameOver && this.mode === 'arcade') {
      if (++this.gameOverTimer > 240) this.exitToTitle();
    }
    if (this.stageClear) {
      this.stageClearTimer++;
      this.clearLoadingRunner?.update(this.slowRate);
      this.clearCaptureRunner?.update(this.slowRate);
      // Advance on Z once the tally has been visible for a beat, or after
      // the timeout. Stages 1-5 hand the run to the next stage; stage 6 /
      // Extra / Phantasm end the credit back at the title.
      const advance =
        (this.stageClearTimer > 90 && input.pressed.has('shoot')) || this.stageClearTimer > 900;
      if (this.mode === 'arcade' && advance && !this.stageCompleteFired) {
        this.stageCompleteFired = true;
        if (this.stageNumber < 6 && this.onStageComplete) {
          this.onStageComplete(this.carryState());
        } else {
          this.exitToTitle();
        }
      }
    }
    const p = this.playerObj;
    this.sfxPlayedThisFrame.clear();
    // During a story-dialogue box the player keeps FULL movement control, as
    // in the original PCB: only damage is suspended. What freezes is the rest
    // of the simulation -- enemy/boss scripts, enemy-bullet motion, the
    // player's own shots and bomb, and every collision test -- so you can
    // reposition while the conversation is up but neither deal nor take
    // damage. (The exe's DAT_0061c25c freeze, exe-misc-ecl-ops.md §2, covers
    // the boss timer, enemy-bullet motion and stage spawns; player movement
    // is deliberately NOT gated by it.) `frozen` is captured once at the top
    // of the frame; the dialogue box's own advance below may clear
    // `this.dialogue` mid-frame, taking effect next frame.
    const frozen = this.isDialogueBlocking();
    // Bombing is allowed in normal play AND during the deathbomb window
    // (p.deathTimer >= 0) -- the few frames after a hit in which a bomb still
    // rescues you. Blocked during the death squish / materialize (controllable
    // false, deathTimer < 0) and while a dialogue box is up (no damage in/out).
    if (!frozen && input.pressed.has('bomb') && (p.controllable || p.deathTimer >= 0) && !this.gameOver) {
      if (this.cherry.borderEngaged) {
        // Th07.exe FUN_0043d9a0 @ 0x43d9e8-0x43da17: bombing during a
        // border invokes the same free break as a hit. It spends no bomb,
        // then flags every existing item for collection.
        if (this.breakBorder(null)) {
          for (const it of this.items) if (!it.dead) it.state = 1;
        }
      } else if (p.tryBomb()) {
        this.voidSpellCapture();
        // Th07.exe bomb trigger @ all.c:28503-28506: zeroes the pending
        // spell bonus and latches DAT_012f40bc = spell-active state.
        this.bombDuringSpell = this.spellcard !== null;
        this.onBombUsed();
      }
    }
    if (!frozen) this.cherry.retryBorderStart();
    // Movement runs every frame, dialogue or not.
    p.update(input, this.slowRate);
    this.focusHeld = p.focusHeld;
    if (!frozen) {
      const death = p.tickDeath();
      if (death === 'effects') this.onPlayerDeath();
      else if (death === 'respawn') this.onPlayerRespawn();
      if (this.respawnClearFrames > 0) {
        // Exe FUN_0043e2e0 top (all.c:28692-28695): while player+0x2400
        // counts down, FUN_00422ea0(0) runs every frame — silent, itemless,
        // skips bomb-immune lasers.
        this.respawnClearFrames--;
        for (const b of this.enemyBullets) b.dead = true;
        this.cancelLasers(false);
      }
      if (!this.gameOver) {
        const volley = this.playerObj.fire();
        if (volley.some((b) => b.sfxId >= 0)) this.playSfx(0);
        // Th07.exe FUN_00438b70: the shot SE fires per spawn event of the one
        // shooter with sfxId>=0 (always SE 0), not on a free-running 8f clock.
        for (const b of volley) {
          if (b.behaviorFunc === 4) this.aimBulletAtSpawn(b);
          else if (b.behaviorFunc === 5) {
            // Th07.exe FUN_00439160 (SakuyaB): bullets fly at orbitAngle + the
            // shot's own deviation from straight-up — the whole fan banks with
            // strafe. At rest (orbit = -π/2) this is exactly the table angle.
            const spread = b.angle - -Math.PI / 2;
            b.angle = this.playerObj.orbitAngle + spread;
            b.vx = Math.cos(b.angle) * b.speed;
            b.vy = Math.sin(b.angle) * b.speed;
          }
          this.playerBullets.push(b);
        }
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
    if (this.dialogue) {
      this.dialogueSeen = true;
      this.dialogue.update(input.pressed.has('shoot'), input.held.has('skip'));
      if (this.dialogue.resumeTicket) {
        this.dialogue.resumeTicket = false;
        this.dialogueResume = true;
      }
      if (this.dialogue.done) this.dialogue = null;
    }
    if (this.spellBanner > 0) this.spellBanner--;
    if (this.spellcard) {
      this.spellcard.declAge++;
      // Bonus decay runs only while the capture is still valid (exe gates
      // the decay on DAT_012f40a4, all.c:7331); floored to tens like the
      // exe's floor10 write at all.c:7334.
      const sc = this.spellcard;
      if (sc.capturing) {
        sc.elapsed++;
        const decayed = sc.bonusBase - Math.trunc((sc.decayPerSec * sc.elapsed) / 60);
        sc.bonus = Math.max(0, decayed - (decayed % 10));
      }
    }
    if (this.bonusPopup && --this.bonusPopup.timer <= 0) this.bonusPopup = null;
    if (this.borderMessage) {
      this.borderMessage.age++;
      if (--this.borderMessage.timer <= 0) this.borderMessage = null;
    }
    if (!this.stageClear && this.runtime.isTimelineComplete() && !this.bossActive && this.enemies.length <= 1) {
      this.clearTimer++;
      if (this.clearTimer > 180) {
        this.stageClear = true;
        this.audio.fadeOutBgm(4);
        this.computeClearBonus();
        this.startStageClearPresentation();
      }
    }
    if (!frozen) {
      // FUN_0043eef0 returns before the state-4 border timer while dialogue
      // freeze DAT_0061c25c is set; the 540-frame clock pauses with gameplay.
      const borderBonus = this.cherry.tick(this.slowRate);
      if (borderBonus > 0) this.addScore(borderBonus);
      this.runtime.update(this);
      this.updateEnemies();
      this.updatePlayerBullets();
      this.updateBullets();
      this.updateLasers();
      this.checkPlayerCollision();
      if (this.postBombLaserCounter > 0) this.postBombLaserCounter--;
    } else {
      // Dialogue up: in-flight player shots keep moving and leave the
      // screen (the exe's shot manager keeps running; only firing and
      // damage are suspended). collide=false skips the enemy hit tests.
      this.updatePlayerBullets(false);
    }
    // The popup manager is rate-scaled but is not part of the dialogue-frozen
    // gameplay managers; update existing entries before this frame's item
    // collections create fresh entries at their exact pickup coordinates.
    this.updatePopups();
    this.updateItems();
    this.updateParticles();
    // Bomb damage / bullet-cancel is suspended while a dialogue box is up
    // (no damage dealt during dialogue), even though the player may keep
    // moving -- otherwise a bomb still active when dialogue opens would keep
    // clearing bullets and damaging the frozen boss for the whole
    // conversation.
    if (!frozen && p.bombTimer > 0) this.applyBombEffects();
    // Bomb over: release the interrupt-gated bomb visuals (label 1 is the
    // fade-out path in the player bomb scripts) and tear down the form runner.
    if (this.prevBombTimer > 0 && p.bombTimer === 0) {
      this.playerEffects.interruptAll(1);
      this.bombRunner = null;
      this.bombEngine.reset();
    }
    this.prevBombTimer = p.bombTimer;
    this.playerEffects.update(this.slowRate);
    this.tickScreenFx();
    if (this.score > this.hiScore) this.hiScore = this.score;
  }

  private onBombUsed(): void {
    this.playSfx(14);
    this.spawnEffectParticles(3, this.playerObj.x, this.playerObj.y, 24, 0xffffffff);
    // Th07.exe FUN_00431d10: bombing flags every live item for collection
    // (same state=1 autocollect the border uses in updateItems).
    for (const it of this.items) if (!it.dead) it.state = 1;
    this.bombEngine.reset();
    this.bombFrame = 0;
    this.bombDuration = this.playerObj.bombTimer;
    // FUN_00407620: the shared activation presentation (a reserved-slot ANM
    // VM tied to the invuln duration) — represented here by the character's
    // own bomb ANM scripts plus the runner's choreography.
    const p = this.playerObj;
    this.bombRunner = new BombRunner(this.bombEngine, p.character, p.bombFocused);
    this.bombRunner.start(this.bombCtx());
    this.spawnBombEffects();
  }

  private bombCtx(): BombContext {
    const p = this.playerObj;
    return {
      player: p,
      fx: this.playerEffects,
      rng: this.rng,
      frame: Math.floor(this.bombFrame),
      duration: this.bombDuration,
      focused: p.bombFocused,
      rate: this.slowRate,
      enemies: this.enemies,
      enemyBullets: this.enemyBullets,
      playSfx: (id) => this.playSfx(id),
      spawnParticles: (effectId, x, y, count, color) => this.spawnEffectParticles(effectId, x, y, count, color),
      startScreenShake: (duration, from, to) => this.startScreenShake(duration, from, to)
    };
  }

  // Per-frame bomb choreography: the active form's decoded state machine
  // writes moving attack slots into the pool each frame (Th07.exe bomb tick
  // functions 0x407840-0x40cbf0; specs spec-bombs-{shared,reimu,marisa,
  // sakuya}.md). Slot consumption below is exe-exact.
  private tickBombChoreography(): void {
    if (!this.bombRunner) return;
    this.bombRunner.tick(this.bombCtx());
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

  private applyBombEffects(): void {
    const p = this.playerObj;
    // Per-form choreography updates the attack-slot pool (Th07.exe bomb tick
    // functions 0x407840-0x40cbf0 write player+0x9dc slots each frame).
    this.tickBombChoreography();
    this.bombFrame += this.slowRate;
    // Choreography has fixed active/radius state for the rest of this frame.
    // Cache the ordered object references instead of restarting the 112-slot
    // generator for every enemy and every bullet in a dense field.
    this.activeBombSlots.length = 0;
    for (const slot of this.bombEngine.activeSlots()) this.activeBombSlots.push(slot);
    // Slot consumption, exe FUN_0043a980 @ 0x43a980: every active slot's
    // AABB (pos ± radius/2) is tested against the enemy box EVERY frame;
    // overlapping slots each apply their damage value per frame (the /5
    // score credit and the 70 cap happen in settlePendingDamage).
    for (const e of this.enemies) {
      // shotCollision: bomb damage flows through the same bit4-gated hit
      // test as shots (Th07.exe FUN_0041ed50) — emitters with op104=0 are
      // bomb-immune too.
      if (!e.ecl.canTakeDamage || !e.ecl.interactable || !e.ecl.shotCollision) continue;
      for (const s of this.activeBombSlots) {
        const hw = (e.ecl.hitbox.x + s.radiusX) / 2;
        const hh = (e.ecl.hitbox.y + s.radiusY) / 2;
        if (Math.abs(e.x - s.x) <= hw && Math.abs(e.y - s.y) <= hh) {
          this.damageEnemy(e, s.damage, 'bomb');
          s.hitTally += s.damage;
        }
      }
    }
    for (const b of this.enemyBullets) {
      if (b.dead || (b.flags & 0x1000) !== 0) continue;
      for (const s of this.activeBombSlots) {
        if (Math.abs(b.x - s.x) <= s.radiusX / 2 && Math.abs(b.y - s.y) <= s.radiusY / 2) {
          // Bomb attack-slot contact is a spiritual-strike cancel. Normal
          // Bomb zones pass type 6 to FUN_0043e730/e7e0; FUN_0043b040 then
          // writes it to player+0x2404 (DAT_004b5ebc), read by the bullet loop
          // at all.c:16160. Unlike the Border-break circle's type 8, this is
          // the grey type-6 item; both bypass full-power promotion. The touch
          // stays spatial (exe-bombs.md §4), never a full-screen sweep.
          this.spawnItem('cherry', b.x, b.y, { state: 1 });
          b.dead = true;
          break;
        }
      }
    }
  }

  // Fires once when the deathbomb window lapses (tickDeath 'effects'): the
  // death explosion, power drops, bullet clear. The respawn itself (teleport +
  // materialize) is deferred to onPlayerRespawn() after the 30-frame death
  // squish, matching Th07.exe fcn.0043dca0.
  private onPlayerDeath(): void {
    const p = this.playerObj;
    this.voidSpellCapture();
    this.playSfx(4);
    this.spawnEffectParticles(3, p.x, p.y, 32, 0xffffffff);
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
    // The exe does NOT clear the field at the miss — the respawn arms a
    // 60-frame continuous silent cancel instead (see onPlayerRespawn).
    this.playerEffects.clear();
  }

  // Th07.exe FUN_00430970 spawn mode 2 (all.c:21852-21862): every death drop
  // launches from the fixed death point toward its own random target at
  // x = rand*288+48, y = rand*192-64 (playfield coords; constants @
  // 0x48eccc/0x48eb94/0x48ecc8/0x48eb68). The exe tweens the position; the
  // port approximates the arc with a 40-frame velocity handed to the normal
  // gravity integrator (flagged approximation).
  private spawnDeathDrop(type: ItemType, x: number, y: number): void {
    const tx = this.rng.f() * 288 + 48;
    const ty = this.rng.f() * 192 - 64;
    this.spawnItem(type, x, y, { vx: (tx - x) / 40, vy: (ty - y) / 40 });
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
    if (kind === 'shot' && this.playerObj.bombTimer > 0) {
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
  private settlePendingDamage(e: Enemy): void {
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
    if (raw <= 0) return;
    // DAT_00625627 = the shot-type bit (A=0 / B=1); the formulas below gate
    // on it being 0 (type-A shots).
    const shotTypeBit = this.playerObj.character.endsWith('B') ? 1 : 0;
    // Cherry gain uses the UNREDUCED damage — the exe computes it before
    // the per-stage reductions below (all.c:14189 vs 14200-14209). The
    // divisor input is the STAGE number (local_14 = min(stage*2,10),
    // all.c:13997-14003 — DAT_0062583c is the stage, not the difficulty;
    // spec-extra-phantasm.md §0).
    this.cherry.onShotHit(raw, e.ecl.isBoss, this.stageNumber, shotTypeBit, (e.ecl.bossTimer & 1) === 1);
    // Per-stage type-A shot-damage reduction vs NON-boss enemies
    // (all.c:14200-14209, gated on DAT_00625627=='\0' and bit6 clear):
    // stage 4 -> dmg - dmg/4 - dmg/16 (11/16), stages 5-6 -> dmg/2.
    if (shotTypeBit === 0 && !e.ecl.isBoss && shotRaw > 0) {
      if (this.stageNumber === 4) {
        shotRaw = shotRaw - Math.trunc(shotRaw / 4) - Math.trunc(shotRaw / 16);
      } else if (this.stageNumber === 5 || this.stageNumber === 6) {
        shotRaw = Math.trunc(shotRaw / 2);
      }
    }
    let dmg = Math.min(70, shotRaw + bombRaw);
    this.addScore(Math.trunc(dmg / 5));
    if (!e.ecl.canTakeDamage) return;
    if (this.spellcard) {
      if (!hadBomb) dmg = dmg >= 8 ? Math.trunc(dmg / 7) : dmg > 0 ? 1 : 0;
      else if (!this.bombDuringSpell) dmg = 0;
      else dmg = dmg > 2 ? Math.trunc(dmg / 2.5) : dmg > 0 ? 1 : 0;
    }
    if (e.ecl.damageShield > 0) dmg = e.ecl.isBoss ? Math.trunc(dmg / 9) : 0;
    e.hp -= dmg;
    e.damageThisFrame = dmg;
  }

  private updatePlayerBullets(collide = true): void {
    // Th07.exe FUN_0043edc0/FUN_0041ed50 (exe-player-funcs1.md §2): the homing
    // target is a single per-frame cache shared by every ReimuA amulet/orb —
    // the eligible enemy minimizing |e.x - player.x| (Y ignored entirely).
    // Reset+repopulated once per frame here, not per-bullet.
    const px = this.playerObj.x;
    let homingTarget: Enemy | null = null;
    let homingBestDx = Infinity;
    for (const e of this.enemies) {
      // The exe's homing-target repopulate lives inside the bit4-gated shot
      // block (FUN_0041ed50 all.c:14258+) — shot-transparent emitters are
      // never homing candidates.
      if (!e.ecl.interactable || e.ecl.invisible || e.dead || !e.ecl.canTakeDamage || !e.ecl.shotCollision) continue;
      const dx = Math.abs(e.x - px);
      if (dx < homingBestDx) {
        homingBestDx = dx;
        homingTarget = e;
      }
    }
    const anm = this.playerObj.anm;
    const rate = this.slowRate;
    this.tickLaserSlots();
    for (const b of this.playerBullets) {
      // Player-shot age is a rate-scaled split counter (exe FUN_0043a290
      // tail); parity checks below use the integer part.
      b.age += rate;
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
      b.x += b.vx * rate;
      b.y += b.vy * rate;
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
        continue;
      }
      // Hit-test gate, exe FUN_0043a980 @ 0x43a9d1: state 1 (fired) bullets,
      // plus shotType 3 (MarisaA missile) in EITHER state — the collided
      // missile keeps dealing contact damage while its explosion plays.
      if (b.state !== 'fired' && b.shotType !== 3) continue;
      for (const e of collide ? this.enemies : []) {
        // Exe shot gate is bit0 (interactable) && bit4 (shotCollision) —
        // NOT bit1 (collisionEnabled), which only covers body-vs-player.
        if (!e.ecl.shotCollision || !e.ecl.interactable || e.ecl.invisible || e.dead) continue;
        const hw = (e.ecl.hitbox.x + b.hitboxW) / 2;
        const hh = (e.ecl.hitbox.y + b.hitboxH) / 2;
        if (Math.abs(b.x - e.x) <= hw && Math.abs(b.y - e.y) <= hh) {
          if (b.shotType === 4 || b.shotType === 5) {
            // Th07.exe FUN_0043a980: lasers deal FULL table damage on even values
            // of their own age counter only, never enter 'collided', never spawn
            // the impact ANM, and pierce (the test continues to further
            // enemies). FUN_0043a080 (funcs[3]=2) pops a spark at the
            // beam/enemy crossing every 8th tallied hit.
            if ((Math.floor(b.age) & 1) === 0) {
              this.damageEnemy(e, b.damage);
              if ((++this.playerHitTally & 7) === 0) this.spawnEffectParticles(5, b.x, e.y, 1, 0xffffffff);
            }
          } else if (b.state === 'collided') {
            // Missile re-hit (FUN_00439d80 state-2 branch): even values of
            // the bullet's own age counter only; the slot damage is
            // PERMANENTLY /3 (min 1), the explosion slows ×0.88 per
            // qualifying hit, and a spark pops on ages divisible by 6.
            if ((Math.floor(b.age) & 1) === 0) {
              b.damage = Math.max(1, Math.trunc(b.damage / 3));
              b.vx *= 0.88;
              b.vy *= 0.88;
              this.damageEnemy(e, b.damage);
              if (Math.floor(b.age) % 6 === 0) this.spawnEffectParticles(5, e.x, e.y, 1, 0xffffffff);
            }
          } else {
            // First hit. MarisaA's missile (FUN_00439d80 state-1 branch)
            // expands its box per sprite id and bursts at a random upward
            // angle in [-3π/4, -π/4] before the shared hit path runs.
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
            // Exe impact switch (FUN_0043a980 @ 0x43aa8c): re-arm the VM with
            // script sprite+0x20 and pop one type-5 particle at the bullet.
            if (anm.hasScript(b.impactScript)) b.runner = new AnmRunner(anm, b.impactScript);
            this.spawnEffectParticles(5, b.x, b.y, 1, 0xffffffff);
            if (b.shotType !== 3) {
              // Th07.exe: velocity/8 on hit — except shotType 3 (MarisaA missile)
              // which keeps full velocity into its collided explosion.
              b.vx /= 8;
              b.vy /= 8;
            }
            this.playSfx(20);
          }
          // Beams pierce and the collided missile keeps overlapping — only a
          // fresh single-hit bullet stops testing further enemies.
          if (b.shotType !== 3 && b.shotType !== 4 && b.shotType !== 5) break;
        }
        // Type-5 helper boxes (FUN_004398e0 → attack slots 0x60+): every
        // beam-history sample is a 10-wide, full-beam-height, damage-1 box
        // tested every frame with no parity gate.
        if (b.shotType === 5 && b.history) {
          for (const hpt of b.history) {
            if (Math.abs(hpt.x - e.x) <= (e.ecl.hitbox.x + 10) / 2 &&
                Math.abs(hpt.y - e.y) <= (e.ecl.hitbox.y + b.hitboxH) / 2) {
              this.damageEnemy(e, 1, this.playerObj.bombTimer > 0 ? 'bomb' : 'shot');
            }
          }
        }
      }
      // Bounds cull, exe FUN_0043a290 (FUN_0042bdc7): skipped entirely for
      // the persistent beam types — their lifetime is the laser-slot timer.
      if (b.shotType !== 4 && b.shotType !== 5 &&
          (b.y < -32 || b.x < -32 || b.x > 416 || b.y > 480)) b.dead = true;
    }
    let w = 0;
    for (const b of this.playerBullets) if (!b.dead) this.playerBullets[w++] = b;
    this.playerBullets.length = w;
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
    const blocked = this.isDialogueBlocking() || p.bombTimer > 0;
    for (let i = 0; i < 3; i++) {
      const slot = p.laserSlots[i];
      if (!slot) continue;
      const b = slot.bullet;
      if (b.dead || b.runner.removed) {
        p.laserSlots[i] = null;
        continue;
      }
      const wantFocused = b.behaviorFunc === 3;
      if (wantFocused && !p.focusHeld) {
        // exe: 240a != 3 → slot 2's owner is freed outright (+0x34a = 0).
        b.dead = true;
        p.laserSlots[i] = null;
        continue;
      }
      slot.timer -= this.slowRate;
      if (!p.shooting && slot.timer > 50) slot.timer = 50;
      if (blocked && slot.timer > 20) slot.timer = 20;
      if (!wantFocused && p.focusHeld) {
        // exe: 240a != 1 → unfocused beams get the fade interrupt and their
        // slot is released for the focused-file record.
        b.fadePending = true;
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
  // Type 5 rides the player with 64px of overhang past the top edge and
  // records its previous centers into the 16-sample history ring.
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
      b.history.unshift({ x: b.x, y: b.y });
      if (b.history.length > 16) b.history.pop();
      b.x = p.x + b.anchorX;
      b.hitboxH = p.y + 64;
      b.y = p.y / 2 - 32;
      b.scaleYOverride = (p.y + 64) / 14;
    }
  }

  // Nearest damageable enemy to (x, y); shared by the homing steer and the
  // SakuyaA focused spawn-aim.
  private findAimTarget(x: number, y: number): Enemy | null {
    let best: Enemy | null = null;
    let bestDist = 1e9;
    for (const e of this.enemies) {
      if (!e.ecl.interactable || e.ecl.invisible || e.dead || !e.ecl.canTakeDamage || !e.ecl.shotCollision) continue;
      const d = (e.x - x) ** 2 + (e.y - y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  // ReimuA homing amulet (shotType 1) / focused orb (shotType 2), Th07.exe
  // FUN_004391f0/FUN_00439420 (exe-player-funcs1.md §3, byte-identical
  // algorithms bar 4 constants). Operates directly on b.vx/b.vy — angle is
  // never consulted or written. `target` is the per-frame shared cache from
  // updatePlayerBullets, not a per-bullet nearest search.
  private steerHomingBullet(b: PlayerBullet, target: Enemy | null): void {
    const maxSpeed = b.shotType === 1 ? 10 : 18;
    const accel = b.shotType === 1 ? 0.33333334 : 0.6;
    const homing = target !== null && b.age <= 39;
    if (!homing) {
      // No target this frame, or the 40-frame homing window (age 0..39)
      // has closed: accelerate toward maxSpeed, preserving direction.
      if (b.speed < maxSpeed) {
        b.speed += accel;
        const mag = Math.hypot(b.vx, b.vy);
        if (mag > 0) {
          b.vx = (b.vx * b.speed) / mag;
          b.vy = (b.vy * b.speed) / mag;
        }
      }
      return;
    }
    const dx = target!.x - b.x;
    const dy = target!.y - b.y;
    const dist = Math.hypot(dx, dy);
    let denom = dist / (b.speed / 4.0);
    if (denom < 1.0) denom = 1.0;
    const pullX = dx / denom + b.vx;
    const pullY = dy / denom + b.vy;
    const mag = Math.hypot(pullX, pullY);
    if (mag === 0) return; // degenerate: bullet exactly on target with zero velocity
    let newSpeed = Math.min(mag, maxSpeed);
    if (newSpeed < 1.0) newSpeed = 1.0;
    b.speed = newSpeed;
    b.vx = (pullX * b.speed) / mag;
    b.vy = (pullY * b.speed) / mag;
  }

  // SHT behavior func 0 == 4 (every ply02as shooter): the knife aims at an
  // enemy the moment it spawns, keeping its small per-shooter spread relative
  // to the aim direction — SakuyaA's focused shot converges on one target.
  // Snap-aim (vs a continuous steer) is a flagged approximation of the exe
  // routine the index selects (AGENTS.md §7); with no target it flies by its
  // table angle. behaviorFunc 5 (SakuyaB) is intentionally not handled —
  // semantics unknown, knives fly straight per the table (AGENTS.md §7).
  private aimBulletAtSpawn(b: PlayerBullet): void {
    const target = this.findAimTarget(b.x, b.y);
    if (!target) return;
    const spread = b.angle - -Math.PI / 2; // table angle relative to straight up
    b.angle = Math.atan2(target.y - b.y, target.x - b.x) + spread;
    // Th07.exe FUN_00439070: aimed shots get speed*1.5 (table 12 -> 18)
    b.speed *= 1.5;
    b.vx = Math.cos(b.angle) * b.speed;
    b.vy = Math.sin(b.angle) * b.speed;
  }

  private checkPlayerCollision(): void {
    const p = this.playerObj;
    // Th07.exe: graze runs during invuln/bomb (states 3/4); only materialize/dying block it. player.hit() already no-ops while invulnerable.
    if (this.gameOver || !p.alive) return;
    const px = p.x;
    const py = p.y;
    const hit = p.hitboxHalf;
    // The Supernatural Border does NOT make the player skip collision: a
    // bullet (or body) reaching the kill hitbox BREAKS the border instead of
    // killing -- onPlayerHit() enters the 40-frame state-3 invulnerability
    // and creates the original expanding cancel field. So the same
    // graze+kill path below runs whether or not a border is up; only the
    // outcome of a kill contact differs. (A prior version special-cased the
    // border here with a graze-only early return, which made it fully
    // invincible and always pay the survive bonus -- the breakBorder path was
    // unreachable.)
    for (const b of this.enemyBullets) {
      if (b.dead) continue;
      // Zone result 2 has precedence over graze/player AABB. A 0x1000-
      // immune bullet inside the Border-break circle is therefore neither
      // converted nor allowed to fall through into the player test.
      // Th07.exe bullet loop @ all.c:16153-16170.
      const wave = this.borderClearWave;
      if (wave) {
        const wx = b.x - wave.x;
        const wy = b.y - wave.y;
        if (wx * wx + wy * wy < wave.radius * wave.radius) continue;
      }
      const dx = Math.abs(b.x - px);
      const dy = Math.abs(b.y - py);
      // Th07.exe FUN_0043b350: bulletFull/2 + sht.grazebox/2 + flat 20.0 pad.
      if (!b.grazed && b.age > 15 && dx <= b.grazeW / 2 + p.grazeboxHalf + 20 && dy <= b.grazeH / 2 + p.grazeboxHalf + 20) {
        // exe: 16-frame minimum age before graze eligibility
        b.grazed = true;
        this.onGrazeAward();
      }
      // exe FUN_004241c0: kill test runs from spawn; only graze has a min age (outer gate +0xbf0 unresolved)
      if (dx <= b.grazeW / 2 + hit && dy <= b.grazeH / 2 + hit) {
        // FUN_0043b200 returns result 1 in player states 1/2/3; the caller
        // consumes the bullet without an item. This applies to ordinary
        // spawn/respawn/bomb invulnerability as well as the 40f Border
        // aftermath, not only to Border state (all.c:27785-27791).
        if (p.invulnFrames > 0 || p.bombInvuln > 0 || p.deathTimer >= 0) {
          b.dead = true;
          continue;
        }
        this.onPlayerHit(b);
        return;
      }
    }
    for (const l of this.enemyLasers) {
      if (!l.inUse) continue;
      const result = this.checkLaserCollision(l);
      if (result === 'hit') {
        this.onPlayerHit(null);
        return;
      }
      if (result === 'graze') this.onGrazeAward();
    }
    for (const e of this.enemies) {
      if (!e.ecl.collisionEnabled || !e.ecl.interactable || e.ecl.invisible || e.dead) continue;
      // Th07.exe FUN_0041ebc0: body kill uses hitbox*(1/1.5)/2 = /3
      if (Math.abs(e.x - px) <= e.ecl.hitbox.x / 3 + hit && Math.abs(e.y - py) <= e.ecl.hitbox.y / 3 + hit) {
        this.onPlayerHit(null);
        return;
      }
    }
    // Th07.exe FUN_0041ebc0: enemy bodies are grazable, region hitbox/1.4
    // (= *(1/0.7)/2), re-attempted every 6 frames while touching -- only
    // when op136 armed `sweepItemFlag` (`+0x2e29` bit5, see the
    // borderActive branch above for the full citation).
    for (const e of this.enemies) {
      if (!e.ecl.collisionEnabled || !e.ecl.interactable || e.ecl.invisible || e.dead || !e.ecl.sweepItemFlag) continue;
      const cd = this.bodyGrazeCooldown.get(e.id) ?? 0;
      if (cd > 0) { this.bodyGrazeCooldown.set(e.id, cd - 1); continue; }
      if (Math.abs(e.x - px) <= e.ecl.hitbox.x / 1.4 + p.grazeboxHalf + 20 &&
          Math.abs(e.y - py) <= e.ecl.hitbox.y / 1.4 + p.grazeboxHalf + 20) {
        this.bodyGrazeCooldown.set(e.id, 6);
        this.onGrazeAward();
      }
    }
  }

  // Th07.exe FUN_0043bb30 (shared graze routine): +200 score, cherry/
  // cherryMax gain, and — while a spell card is up — the pending capture
  // bonus grows by 2500 + floor(cherry/1500)*20 (all.c:27969; the exe
  // accumulator DAT_012f40b0 is reset at each declare, so accumulating
  // only while a card is active is equivalent).
  private onGrazeAward(): void {
    this.graze++;
    this.addScore(200);
    this.cherry.onGraze(this.focusHeld);
    if (this.spellcard) {
      this.spellcard.grazeBonus += 2500 + Math.trunc(this.cherry.cherry / 1500) * 20;
    }
    this.playSfx(30);
  }

  private onPlayerHit(sourceBullet: EnemyBullet | null): void {
    const p = this.playerObj;
    // An invulnerable player (spawn/bomb invuln, or already in the
    // deathbomb window) takes no hit outcome at all in the exe — in
    // particular a contact during invuln must NOT break the border.
    // (Breaking it before this check let one absorbed hit's invulnerability
    // frames chain-eat every subsequent border the instant it started.)
    if (p.invulnFrames > 0 || p.bombInvuln > 0 || p.deathTimer >= 0) return;
    if (this.breakBorder(sourceBullet)) return;
    const result = p.hit();
    if (result === 'deathbomb-window') this.playSfx(20);
  }

  private breakBorder(sourceBullet: EnemyBullet | null): boolean {
    if (!this.cherry.breakBorder()) return false;
    this.applyBorderBreakEffects(sourceBullet, false);
    return true;
  }

  private applyBorderBreakEffects(sourceBullet: EnemyBullet | null, rescueDeathbomb: boolean): void {
    const p = this.playerObj;
    // Direct collision result 1 deletes the touching bullet without an item;
    // later result-2 contacts with the expanding field yield type-8 unboxed
    // Cherry items. FUN_0043eb00 passes 8 at all.c:28984; FUN_0043b040 writes
    // it through player+0x2404 / DAT_004b5ebc before the spawn at
    // all.c:16160/16169.
    if (sourceBullet) sourceBullet.dead = true;
    if (rescueDeathbomb) p.deathTimer = -1;
    this.voidSpellCapture();
    p.invulnFrames = Math.max(p.invulnFrames, 40);
    this.borderClearWave = { x: p.x, y: p.y, radius: 32, ticksLeft: 50, createdFrame: this.frame };
    // Th07.exe FUN_0043eb00 @ 0x43ed6c-0x43ed89.
    this.playSfx(7);
    this.playSfx(33);
    // The original bullet loop can test later pool entries against the new
    // radius-32 field on the creation frame. Sweep once now; the direct
    // source is already dead and therefore produces no item.
    this.sweepBorderClearWave();
  }

  private sweepBorderClearWave(): void {
    const wave = this.borderClearWave;
    if (!wave) return;
    for (const b of this.enemyBullets) {
      if (b.dead || (b.flags & 0x1000) !== 0) continue;
      const dx = b.x - wave.x;
      const dy = b.y - wave.y;
      if (dx * dx + dy * dy < wave.radius * wave.radius) {
        this.spawnItem('pointBullet', b.x, b.y, { state: 1 });
        b.dead = true;
      }
    }
  }

  private updateEnemies(): void {
    for (const e of this.enemies) {
      // Settle last frame's shot/bomb damage through the exe pipeline
      // before the ECL runs, so life-threshold callbacks see the new HP —
      // same relative order as Th07.exe FUN_0041ed50 (hit test, damage,
      // then FUN_0041e4a0/FUN_0041e6b0 callbacks in the same pass).
      this.settlePendingDamage(e);
      e.frame++;
      this.runtime.updateEnemy(this, e);
    }
    for (const e of this.enemies) {
      if (e.dead) continue;
      const offscreen = e.x < -64 || e.x > 448 || e.y < -64 || e.y > 512;
      // op137 (exe `+0x2e2a` bit7, exe-misc-ecl-ops.md §4): exempts an
      // enemy from this cull even after it's been seen and gone offscreen
      // -- e.g. a decorative particle emitter whose position legitimately
      // wanders outside the visible rect.
      if (offscreen && e.ecl.seen && !e.ecl.offscreenCullExempt) e.dead = true;
      if (!e.ecl.seen && !offscreen) e.ecl.seen = true;
      if (!e.dead && e.hp <= 0) {
        const keep = this.runtime.killEnemy(this, e);
        if (!keep) e.dead = true;
      }
    }
    let w = 0;
    for (const e of this.enemies) {
      if (!e.dead) this.enemies[w++] = e;
      else this.runtime.releaseEnemy(this, e);
    }
    this.enemies.length = w;
  }

  private updateBullets(): void {
    const wave = this.borderClearWave;
    if (wave && wave.createdFrame < this.frame) {
      // FUN_0043d8f0 updates the zone before the bullet manager tests it.
      wave.radius += 16;
      wave.ticksLeft--;
    }
    for (const b of this.enemyBullets) {
      if (b.dead) continue;
      this.updateBulletMotion(b);
      if (wave && !b.dead && (b.flags & 0x1000) === 0) {
        const dx = b.x - wave.x;
        const dy = b.y - wave.y;
        // FUN_0043b040 uses a strict center-distance circle test; swept
        // bullets become auto-collecting type-8 unboxed Cherry items.
        if (dx * dx + dy * dy < wave.radius * wave.radius) {
          this.spawnItem('pointBullet', b.x, b.y, { state: 1 });
          b.dead = true;
        }
      }
      const exActive = (b.flags & (0x40 | 0x80 | 0x100 | 0x400 | 0x800)) !== 0;
      const margin = exActive ? 160 : 32;
      if (b.x < -margin || b.x > 384 + margin || b.y < -margin || b.y > 448 + margin) b.dead = true;
    }
    let w = 0;
    for (const b of this.enemyBullets) if (!b.dead) this.enemyBullets[w++] = b;
    this.enemyBullets.length = w;
    if (wave && wave.ticksLeft <= 0) this.borderClearWave = null;
  }

  // Per-frame bullet ex-behaviors, matching Th07.exe FUN_004241c0 @ 0x4241c0.
  // Each activated behavior bit in b.exFlags (exe +0xbf4, built at spawn via
  // the op-79 cond gate — see eclvm resolveExBehaviors) runs as an INDEPENDENT
  // if in the order 0x1, 0x10, 0x20, 0x40/0x100/0x80, 0xc00, then velocity is
  // added to position ONCE. Every behavior reads only its OWN op-79 slot's
  // resolved params and clears its own bit when finished.
  private updateBulletMotion(b: EnemyBullet): void {
    const rate = this.slowRate;
    if (b.age < b.spawnDuration) {
      b.x += b.vx * b.spawnMoveScale;
      b.y += b.vy * b.spawnMoveScale;
      b.age += rate;
      return;
    }
    const age = b.age - b.spawnDuration;
    if (b.exFlags & 1) {
      // speed-ramp (FUN_00423840): velocity = polar(angle, speed + 5·decay)
      // for 17 frames; then just clears the bit. Never writes the speed
      // scalar, so it composes cleanly with accel/angle-change.
      if (age <= 16) {
        const extra = 5 - (age * 5) / 16;
        b.vx = Math.cos(b.angle) * (b.speed + extra) * rate;
        b.vy = Math.sin(b.angle) * (b.speed + extra) * rate;
      } else {
        b.exFlags &= ~1;
      }
    }
    if ((b.exFlags & 0x10) && b.exAccel) {
      // accel (FUN_00423910): add a fixed accel vector to velocity and
      // recompute the heading. Does NOT touch the speed scalar (the exe
      // doesn't — writing hypot() here would feed the speed-ramp into a
      // runaway loop = the "supersonic" bug). Runs while age < limit.
      const ac = b.exAccel;
      if (age >= ac.limit) b.exFlags &= ~0x10;
      else {
        b.vx += Math.cos(ac.angle) * ac.mag * rate;
        b.vy += Math.sin(ac.angle) * ac.mag * rate;
        b.angle = Math.atan2(b.vy, b.vx);
      }
    }
    if ((b.exFlags & 0x20) && b.exAngle) {
      // angle-change (FUN_00423a80): angle += angleDelta, speed += speedDelta,
      // velocity = polar(angle, speed). Runs while age < limit.
      const an = b.exAngle;
      if (age >= an.limit) b.exFlags &= ~0x20;
      else {
        b.angle = normalizeAngle(b.angle + an.angleDelta);
        b.speed += an.speedDelta;
        b.vx = Math.cos(b.angle) * b.speed * rate;
        b.vy = Math.sin(b.angle) * b.speed * rate;
      }
    }
    if ((b.exFlags & 0x40) && b.exDir) this.dirChangeBullet(b, age, 'relative');
    else if ((b.exFlags & 0x100) && b.exDir) this.dirChangeBullet(b, age, 'absolute');
    else if ((b.exFlags & 0x80) && b.exDir) this.dirChangeBullet(b, age, 'aimed');
    if ((b.exFlags & 0x400) && b.exBounce) this.bounceBullet(b, true);
    if ((b.exFlags & 0x800) && b.exBounce) this.bounceBullet(b, false);
    b.x += b.vx;
    b.y += b.vy;
    b.age += rate;
  }

  private dirChangeBullet(b: EnemyBullet, age: number, mode: 'relative' | 'absolute' | 'aimed'): void {
    const d = b.exDir!;
    const interval = Math.max(1, d.interval | 0);
    const maxTimes = Math.max(1, d.maxTimes | 0);
    const times = b.dirTimes ?? 0;
    let speed: number;
    if (age >= interval * (times + 1)) {
      b.dirTimes = times + 1;
      if (b.dirTimes >= maxTimes) {
        b.exFlags &= mode === 'relative' ? ~0x40 : mode === 'absolute' ? ~0x100 : ~0x80;
      }
      if (mode === 'relative') b.angle = normalizeAngle(b.angle + d.angle);
      else if (mode === 'absolute') b.angle = d.angle;
      else b.angle = Math.atan2(this.player.y - b.y, this.player.x - b.x) + d.angle;
      b.speed = d.newSpeed;
      speed = b.speed;
    } else {
      speed = b.speed - ((age - interval * times) * b.speed) / interval;
    }
    b.vx = Math.cos(b.angle) * speed * this.slowRate;
    b.vy = Math.sin(b.angle) * speed * this.slowRate;
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
    b.dirTimes = (b.dirTimes ?? 0) + 1;
    if (b.dirTimes >= maxTimes) b.exFlags &= includeBottom ? ~0x400 : ~0x800;
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

  private drawLasers(r: Renderer, ox: number, oy: number): void {
    const ctx = r.ctx;
    for (const l of this.enemyLasers) {
      if (!l.inUse) continue;
      if (l.state === 2 && l.phaseFrame >= l.shrinkCutoff) continue;
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
      // exe FUN_004241c0: farDist growth is rate-scaled; the phase clock is
      // a split counter at the same rate (spec-slowmo.md §3.1/§3.2).
      l.farDist += l.speed * lrate;
      if (l.farDist - l.nearDist > l.maxLength) l.nearDist = l.farDist - l.maxLength;
      if (l.nearDist < 0) l.nearDist = 0;
      if (l.state === 0) {
        if ((l.flags & 1) === 0) {
          l.displayWidth = Math.min(l.width, 1.2 + (l.width - 1.2) * (l.phaseFrame / Math.max(1, l.growDuration)));
        }
        if (l.phaseFrame >= l.growDuration) {
          l.state = 1;
          l.phaseFrame = 0;
          l.displayWidth = l.width;
          continue;
        }
      } else if (l.state === 1) {
        l.displayWidth = l.width;
        if (l.phaseFrame >= l.holdDuration) {
          l.state = 2;
          l.phaseFrame = 0;
          continue;
        }
      } else {
        if ((l.flags & 1) === 0) {
          l.displayWidth = Math.max(0, l.width - (l.phaseFrame * l.width) / Math.max(1, l.shrinkDuration));
        }
        if (l.phaseFrame >= l.shrinkDuration) l.inUse = false;
      }
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

  // Player-vs-laser test, exe FUN_0043b650 (all.c:27867-27925) via
  // spec-lasers.md §7: rotate (player - anchor) by -angle into the beam's
  // local frame, then AABB the player hitbox against a box whose along-
  // axis extent is state-dependent (§7.4) — full length only during HOLD,
  // a width-sized nub around the midpoint during grow/shrink. Graze pads
  // the box by a flat 48 (DAT_0048eb94).
  private checkLaserCollision(l: EnemyLaser): 'miss' | 'graze' | 'hit' {
    const inGrow = l.state === 0;
    if (inGrow && l.phaseFrame < l.telegraphDelay) return 'miss';
    if (l.state === 2 && l.phaseFrame >= l.shrinkCutoff) return 'miss';
    const p = this.playerObj;
    const dx = p.x - l.x;
    const dy = p.y - l.y;
    const sin = Math.sin(-l.angle);
    const cos = Math.cos(-l.angle);
    const along = sin * dy + cos * dx;
    const perp = cos * dy - sin * dx;
    const phw = p.hitboxHalf;
    const midDist = (l.farDist - l.nearDist) / 2 + l.nearDist;
    const extX = l.state === 1 ? l.farDist - l.nearDist : l.displayWidth / 2;
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
    const pocActive = p.alive && ((p.power >= 128 && p.y <= sht.pocLineY) || this.cherry.borderActive);
    for (const it of this.items) {
      it.age++;
      if (this.cherry.borderActive) it.state = 1;
      if (p.alive && (it.state === 1 || pocActive)) {
        const angle = Math.atan2(p.y - it.y, p.x - it.x);
        it.x += Math.cos(angle) * sht.autocollectSpeed * this.slowRate;
        it.y += Math.sin(angle) * sht.autocollectSpeed * this.slowRate;
      } else {
        // exe FUN_00430c10: item motion is rate-scaled (spec-slowmo.md §3.1).
        it.vy = Math.min(3, it.vy + 0.03 * this.slowRate);
        it.x += it.vx * this.slowRate;
        it.y += it.vy * this.slowRate;
      }
      if (p.alive && Math.abs(it.x - p.x) <= sht.itemRadius && Math.abs(it.y - p.y) <= sht.itemRadius) {
        this.collectItem(it);
      }
      if (it.y > 480) it.dead = true;
    }
    let w = 0;
    for (const it of this.items) if (!it.dead) this.items[w++] = it;
    this.items.length = w;
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
          if (this.powerTier(p.power) > before) {
            this.spawnScorePopup(-1, it.x, it.y, 0xffffc0a0);
            this.playSfx(0x1f);
          } else {
            this.spawnScorePopup(10, it.x, it.y, 0xffffffff);
          }
          if (p.power === 128) {
            // Crossing to full power: FUN_00431da0 converts every other
            // live power/bigPower item to bigCherry (all.c:22034/22142),
            // then FUN_00422ea0(1) clears the field to cherry items — the
            // cancel (not the conversion) is gated on no active spell card
            // (DAT_012f40a8 == 0, all.c:22030/22138).
            this.convertLivePowerItems();
            if (!this.spellcard) this.cancelBulletsToItems();
          }
        } else if (it.type === 'power') {
          this.addScore(12800);
          this.spawnScorePopup(128000, it.x, it.y, 0xffffff00);
        }
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
        this.addScore(100);
        this.spawnScorePopup(1000, it.x, it.y, 0xffffffff);
        break;
      }
      case 'point': {
        this.pointItems++;
        const pts = this.cherry.pointItemScore(it.y, p.sht.pocLineY, it.state === 1);
        this.addScore(pts);
        // Case 1: the popup shows the pre-divide value — yellow above the
        // collection line or when auto-collected, white otherwise.
        const yellow = it.state === 1 || it.y <= p.sht.pocLineY;
        this.spawnScorePopup(pts * 10, it.x, it.y, yellow ? 0xffffff00 : 0xffffffff);
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
        p.bombs = Math.min(8, p.bombs + 1);
        break;
      case 'life':
        p.lives = Math.min(8, p.lives + 1);
        this.playSfx(28);
        break;
      case 'cherry': {
        // exe case 6 (spec §3b): +20 cherry, score = grazeScaledValue/10.
        // The popup uses the 3-slot pool, always white (spec-popups.md §4.1).
        const v = this.cherry.grazeScaledItemScore(this.graze);
        this.addScore(v);
        this.spawnScorePopup(v * 10, it.x, it.y, 0xffffffff, true);
        this.cherry.onSmallCherryItem();
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
          const v = this.cherry.largeCherryItemScore(it.y, this.playerObj.sht.pocLineY, it.state === 1);
          this.addScore(v);
          const yellow = it.state === 1 || it.y <= p.sht.pocLineY;
          this.spawnScorePopup(v * 10, it.x, it.y, yellow ? 0xffffff00 : 0xffffffff);
        } else {
          this.spawnScorePopup(this.cherry.largeCherryItemGain(), it.x, it.y, 0xffff4040);
        }
        this.cherry.onLargeCherryItem();
        break;
      }
    }
  }

  private updateParticles(): void {
    for (const p of this.particles) {
      p.age++;
      p.x += p.vx;
      p.y += p.vy;
      if (p.age >= p.life || p.y > 470) p.age = p.life;
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
    const radius = 40 + 320 * t;
    const ctx = r.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
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

  draw(r: Renderer): void {
    // The native one-shot capture flush runs before the next render, while
    // the backbuffer still holds the final live playfield. Capturing after
    // clear() would record the presentation itself instead.
    if (this.clearCaptureArmed || this.stageTransitionCaptureArmed) {
      r.capturePlayfield();
      this.clearCaptureArmed = false;
      this.stageTransitionCaptureArmed = false;
    }
    r.clear('#101018');
    r.ctx.fillStyle = '#04040c';
    r.ctx.fillRect(PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
    r.clipPlayfield(() => {
      const ox = PLAYFIELD.x + this.shakeX;
      const oy = PLAYFIELD.y + this.shakeY;
      this.drawBackground(r, ox, oy);
      this.drawSpellBackground(r);
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
        const rotation = e.ecl.anmRotateWithAngle ? e.ecl.angle : e.ecl.anmRotZ;
        r.drawAnmFrame(frame, ox + e.x, oy + e.y, rotation != null ? { rotation } : {});
      }
      this.drawLasers(r, ox, oy);
      // Enemy bullets dominate entity draw counts in dense spells. Their
      // sprites are untinted, so one saved Canvas state can safely cover the
      // whole batch while each draw assigns its own transform/alpha/blend.
      r.ctx.save();
      for (const b of this.enemyBullets) {
        if (b.dead) continue;
        const spawning = b.age < b.spawnDuration;
        r.drawSpriteInBatch(
          b.rect.imageKey,
          b.rect.x,
          b.rect.y,
          b.rect.w,
          b.rect.h,
          ox + b.x,
          oy + b.y,
          b.angle + Math.PI / 2,
          spawning ? 1.6 - 0.6 * (b.age / Math.max(1, b.spawnDuration)) : 1,
          spawning ? 0.6 + 0.4 * (b.age / Math.max(1, b.spawnDuration)) : 1,
          spawning ? 'lighter' : 'source-over'
        );
      }
      r.ctx.restore();
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
      const p = this.playerObj;
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
        // Type-5 ghost trail (FUN_00439c50, funcs[2]=1): the beam redraws at
        // each history sample with alpha falling off by sample index.
        if (b.shotType === 5 && b.history) {
          const n = b.history.length;
          for (let i = n - 1; i >= 0; i--) {
            const hpt = b.history[i];
            r.drawAnmFrame(frame, ox + hpt.x, oy + hpt.y, { ...opts, alpha: 1 - (i + 1) / 16 });
          }
        }
        r.drawAnmFrame(frame, ox + b.x, oy + b.y, opts);
      }
      this.playerEffects.draw(r, ox, oy);
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
      if (p.alive || p.materializeFrame >= 0 || p.dyingFrame >= 0) {
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
          // Spawn/respawn invuln (exe state 3): dark-tint 0x404040 on frames
          // where (timer & 7) < 2 (fcn.0043e2e0), instead of an invisibility
          // blink -- the original dims the sprite, never hides it.
          const dim = p.invulnFrames > 0 && (p.invulnFrames & 7) < 2;
          r.drawAnmFrame(pf, ox + p.x, oy + p.y, dim ? { color: 0x404040 } : {});
        }
        if (this.focusHeld && p.alive) {
          r.ctx.fillStyle = '#fff';
          r.ctx.beginPath();
          r.ctx.arc(ox + p.x, oy + p.y, p.hitboxHalf + 1.5, 0, Math.PI * 2);
          r.ctx.fill();
          r.ctx.strokeStyle = '#f66';
          r.ctx.stroke();
        }
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
    });
    this.drawFrame(r);
    this.drawSidebar(r);
    if (this.stageClear) this.drawStageClearPresentation(r);
    this.drawSpellOverlay(r);
    this.drawDialogue(r);
    this.drawStageTitle(r);
    if (this.borderMessage) this.drawBorderMessage(r);
    if (this.bonusPopup) this.drawSpellBonusPopup(r);
    if (this.bossActive) this.drawBossMarker(r);
    if (this.stageClear) this.drawStageClear(r);
    this.drawStageTransition(r);
    if (this.continueScreen) this.drawContinueScreen(r);
    else if (this.gameOver) r.text('GAME OVER', PLAYFIELD.x + 140, PLAYFIELD.y + 200, { size: 20, color: '#f66' });
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
  private bgAnmFrame(scriptId: number, targetFrame: number): AnmFrame | null {
    let entry = this.bgAnmCache.get(scriptId);
    if (!entry || targetFrame < entry.frame) {
      const ref = this.bgScripts.get(scriptId);
      if (!ref) return null;
      entry = {
        runner: new AnmRunner(ref.anm, ref.localId, { entryIndex: ref.entryIndex, spriteIndexOffset: ref.spriteBase }),
        frame: 0
      };
      this.bgAnmCache.set(scriptId, entry);
    }
    while (entry.frame < targetFrame) {
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
    let entry = this.specialBgAnmCache[slot];
    if (!entry || entry.script !== state.script || state.age < entry.age) {
      const ref = this.bgScripts.get(state.script);
      if (!ref) return null;
      entry = {
        script: state.script,
        runner: new AnmRunner(ref.anm, ref.localId, { entryIndex: ref.entryIndex, spriteIndexOffset: ref.spriteBase }),
        age: 0
      };
      this.specialBgAnmCache[slot] = entry;
    }
    while (entry.age < state.age) {
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
  private drawSpellBackground(r: Renderer): void {
    const sc = this.spellcard;
    if (!sc) return;
    // Per-stage effect sheet; resolved via the ANM entry's own texture name
    // (eff07.anm's textures are eff07b/eff07c — there is no eff07.png).
    const img = r.image(this.effectAnm.entries[0]?.imageKey ?? 'eff01');
    if (!img) return;
    if (!this.eff01Pattern) this.eff01Pattern = r.ctx.createPattern(img, 'repeat');
    if (!this.eff01Pattern) return;
    const ctx = r.ctx;
    const u = 0.004167 * 256 * sc.declAge;
    const v = -0.008333 * 256 * sc.declAge;
    ctx.save();
    ctx.globalAlpha = Math.min(1, sc.declAge / 60);
    ctx.translate(PLAYFIELD.x - u, PLAYFIELD.y - v);
    ctx.fillStyle = this.eff01Pattern;
    ctx.fillRect(u, v, PLAYFIELD.width, PLAYFIELD.height);
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
    // While a border is up, the exe repurposes the display as the border
    // countdown = 50000 * timerLeft / 540 (mode-4 recompute, all.c:28735).
    const plusVal = this.cherry.borderActive
      ? Math.trunc((50000 * this.cherry.borderTimer) / BORDER_DURATION)
      : Math.max(0, Math.trunc(this.cherry.cherryPlus));
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
      // ename.png rows 0..15 are stage pairs: midboss, then dialogue boss.
      if (!this.dialogue) {
        const row = 2 * (this.stageNumber - 1) + (this.dialogueSeen ? 1 : 0);
        this.blit(r, 'ename', [0, row * 16, 128, 16], 32, 26);
      }
    }
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
