import { StageRuntime } from './eclvm';
import type { GameHost, Enemy, EnemyBullet, EnemyLaser, ItemEntity, ItemType, EffectParticle } from './types';
import { Rng } from '../core/rng';
import { normalizeAngle, clamp } from '../core/util';
import type { InputFrame } from '../core/input';
import { Renderer, PLAYFIELD, SCREEN_W } from '../gfx/renderer';
import type { GameAssets } from './assets';
import { AnmRunner, type AnmFrame } from '../formats/anm';
import { TH07_DATA } from '../data/th07-data';
import type { AudioBus } from '../audio/audio';
import { CHARACTERS, Player, type CharacterId, type PlayerBullet } from './player';
import { PlayerEffects } from './player-effects';
import { CherrySystem, BORDER_DURATION, CHERRY_PLUS_MAX } from './cherry';
import { DialogueRunner, portraitSprite } from './dialogue';

// Stage host. At the M3 milestone this runs the full stage 1 timeline with a
// movable player stub (no collision yet) so ECL patterns can be verified.

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
  pointBullet: 10, // grey star box (bullet-cancel item)
  cherry: 11, // boxed pink petal
  bigCherry: 11 // TH07-TODO: distinct big-cherry art unconfirmed; shares the box
};
// Per-type offscreen indicator arrows sit 10 embedded ids after their item
// (emb14-21, same order) — drawn while an item is still above the top edge.
const ITEM_ARROW_OFFSET = 10;

// Per-frame damage cap for a single enemy, from the TH06 engine family; the
// ECL op 142 parameter appears related but is not yet confirmed (TH07-TODO).
const ENEMY_FRAME_DAMAGE_CAP = 70;

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

// Per-quad cap on subdivided cells for perspective-correct-enough texture
// mapping (see drawBackground); not a shared budget — stage 1 only has ~31
// ground instances and 18 tree quads per tree instance, so every visible
// quad is drawn in full every frame with plenty of headroom to spare.
const BG_MAX_CELL_STEPS = 24;

export class StageScene implements GameHost {
  rng = new Rng();
  difficulty = 1;
  rank = 16;
  frame = 0;
  id = 1;
  player = { x: 192, y: 384 };
  enemies: Enemy[] = [];
  enemyBullets: EnemyBullet[] = [];
  enemyLasers: EnemyLaser[] = [];
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
  private frameDamage = new Map<number, number>();
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
  gameOver = false;
  // Arcade end-of-game flow. 'test' keeps the pre-existing headless-probe
  // semantics (no freeze, no scene exit); 'arcade' is the real game: PCB's
  // continue screen (3 credits, score reset to the continue count) and a
  // return to the title after game over or the stage-clear tally.
  mode: 'arcade' | 'test' = 'arcade';
  onExitToTitle: (() => void) | null = null;
  continueScreen: { cursor: number } | null = null;
  continuesUsed = 0;
  private gameOverTimer = 0;
  private stageClearTimer = 0;
  private exitFired = false;
  cherry = new CherrySystem({
    onBorderStart: () => this.playSfx(27),
    onBorderEnd: (result) => {
      if (result === 'survived') this.playSfx(28);
    }
  });
  hiScore = 100000;
  dialogue: DialogueRunner | null = null;
  private dialogueResume = false;
  stageFrame = 0;
  stageClear = false;
  private clearTimer = 0;
  spellcard: { name: string; id: number; capturing: boolean; bonus: number; declAge: number; portraitSprite: number } | null = null;
  private spellBanner = 0;
  private bonusPopup: { text: string; timer: number } | null = null;
  bossActive: Enemy | null = null;
  bossLifeCount = 0;
  spellName = '';
  // Session-scoped per-spell attempt/capture tally for the "History n/m"
  // line of the declaration banner. The original persists this in
  // score.dat across runs — out of scope here (AGENTS.md §7).
  private spellHistory = new Map<number, { seen: number; got: number }>();
  // Latched when the pre-boss dialogue starts: stage 1's ename.png rows are
  // 0 = Cirno (midboss, no dialogue) and 1 = Letty (after the dialogue) —
  // stage-1 heuristic, TH07-TODO a data-driven boss->nameplate mapping.
  private dialogueSeen = false;
  private eff01Pattern: CanvasPattern | null = null;

  // Global sprite id of etama entry 1's embedded sprite 0 (the etama2.png
  // item sheet); see ITEM_SPRITES above.
  private readonly etamaItemBase: number;
  // Script-driven bomb visuals (see spawnBombEffects).
  private readonly playerEffects: PlayerEffects;
  private prevBombTimer = 0;

  constructor(private assets: GameAssets, private audio: AudioBus, difficulty = 1, character: CharacterId = 'reimuA') {
    this.difficulty = difficulty;
    this.runtime = new StageRuntime(TH07_DATA.stages[1], {
      etama: assets.anms.etama,
      enemy: assets.anms.stg1enm,
      effect: assets.anms.eff01
    });
    this.etamaItemBase = assets.anms.etama.entries[1].spriteBase;
    this.playerObj = new Player(character, assets.anms);
    this.playerEffects = new PlayerEffects(this.playerObj.anm);
    this.player = this.playerObj;
  }

  // -- GameHost --------------------------------------------------------------

  addScore(v: number): void {
    this.score += v;
  }

  spawnItem(type: ItemType, x: number, y: number, options: { state?: number; vx?: number; vy?: number } = {}): void {
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
      const speed = isSnow ? 0.2 + this.rng.range(0.5) : 0.5 + this.rng.range(2);
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
    // Original SE index mapping (TH07-TODO: verify full table). Index into
    // the se_* files by the original sound ids used in ECL data.
    const SFX_BY_INDEX = [
      'se_plst00', 'se_enep00', 'se_pldead00', 'se_power0', 'se_power1',
      'se_tan00', 'se_tan01', 'se_tan02', 'se_ok00', 'se_cancel00',
      'se_select00', 'se_gun00', 'se_cat00', 'se_lazer00', 'se_lazer01',
      'se_enep01', 'se_nep00', 'se_damage00', 'se_item00', 'se_kira00',
      'se_kira01', 'se_kira02', 'se_extend', 'se_timeout', 'se_graze',
      'se_powerup', 'se_pause', 'se_border', 'se_bonus', 'se_bonus2'
    ];
    const file = SFX_BY_INDEX[id];
    if (file) this.audio.sfx(file);
  }

  startDialogue(index: number): void {
    // msg1.dat entry layout is sparse: character*10 + phase (0 pre-boss,
    // 1 post-boss) — entries 0/1 Reimu, 10/11 Marisa, 20/21 Sakuya. The ECL
    // timeline passes only the phase; the engine adds the character offset.
    const entry = CHARACTERS[this.playerObj.character].family * 10 + index;
    this.dialogue = new DialogueRunner(this.runtime.msg, entry, {
      playBgm: (track) => {
        const names = ['th07_01', 'th07_02', 'th07_03'];
        const name = names[track];
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
    // TH07-TODO: exact per-spell capture bonus values.
    this.spellcard = { name, id: spellId, capturing: true, bonus: 100000 + spellId * 10000, declAge: 0, portraitSprite };
    this.spellBanner = 150;
    const tally = this.spellHistory.get(spellId) ?? { seen: 0, got: 0 };
    tally.seen++;
    this.spellHistory.set(spellId, tally);
    this.playSfx(12);
    // Declaration charge burst at the boss (se_cat00 above is the charge SE).
    if (this.bossActive) this.spawnEffectParticles(3, this.bossActive.x, this.bossActive.y, 24, 0xffffffff);
  }

  endBossSpell(): void {
    if (this.spellcard?.capturing) {
      const bonus = this.spellcard.bonus;
      this.addScore(bonus);
      this.cherry.onSpellCapture();
      const tally = this.spellHistory.get(this.spellcard.id);
      if (tally) tally.got++;
      this.bonusPopup = { text: `Spell Card Bonus! ${bonus.toLocaleString('en-US')}`, timer: 180 };
      this.playSfx(28);
    } else if (this.spellcard) {
      this.bonusPopup = { text: 'Bonus failed...', timer: 120 };
    }
    this.spellName = '';
    this.spellcard = null;
  }

  voidSpellCapture(): void {
    if (this.spellcard) this.spellcard.capturing = false;
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

  turnBulletsIntoPointItems(): void {
    for (const b of this.enemyBullets) {
      this.spawnItem('pointBullet', b.x, b.y, { state: 1 });
    }
    this.enemyBullets.length = 0;
  }

  // ECL op 125 ("STD unpause") is a no-op here: stage1.std's script clock
  // never actually pauses (that reading of op 5 was wrong — op 5 is the
  // camera-position keyframe; see formats/std.ts), so there's nothing to
  // release. Kept only to satisfy GameHost / the original opcode table.
  unpauseStd(): void {}

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
    if (this.stageClear && this.mode === 'arcade') {
      if (++this.stageClearTimer > 480) this.exitToTitle();
    }
    const p = this.playerObj;
    this.frameDamage.clear();
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
      if (p.tryBomb()) {
        this.cherry.onBomb();
        this.voidSpellCapture();
        this.onBombUsed();
      }
    }
    // Movement runs every frame, dialogue or not.
    p.update(input);
    this.focusHeld = p.focusHeld;
    if (!frozen) {
      const death = p.tickDeath();
      if (death === 'effects') this.onPlayerDeath();
      else if (death === 'respawn') this.onPlayerRespawn();
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
    if (this.dialogue) {
      this.dialogueSeen = true;
      this.dialogue.update(input.pressed.has('shoot') || input.held.has('skip'));
      if (this.dialogue.resumeTicket) {
        this.dialogue.resumeTicket = false;
        this.dialogueResume = true;
      }
      if (this.dialogue.done) this.dialogue = null;
    }
    if (this.spellBanner > 0) this.spellBanner--;
    if (this.spellcard) this.spellcard.declAge++;
    if (this.bonusPopup && --this.bonusPopup.timer <= 0) this.bonusPopup = null;
    if (!this.stageClear && this.runtime.isTimelineComplete() && !this.bossActive && this.enemies.length <= 1) {
      this.clearTimer++;
      if (this.clearTimer > 180) {
        this.stageClear = true;
        this.audio.fadeOutBgm(4);
      }
    }
    const borderBonus = this.cherry.tick();
    if (borderBonus > 0) this.addScore(borderBonus);
    if (!frozen) {
      this.runtime.update(this);
      this.updateEnemies();
      this.updatePlayerBullets();
      this.updateBullets();
      this.checkPlayerCollision();
    }
    this.updateItems();
    this.updateParticles();
    // Bomb damage / bullet-cancel is suspended while a dialogue box is up
    // (no damage dealt during dialogue), even though the player may keep
    // moving -- otherwise a bomb still active when dialogue opens would keep
    // clearing bullets and damaging the frozen boss for the whole
    // conversation.
    if (!frozen && p.bombTimer > 0) this.applyBombEffects();
    // Bomb over: release the interrupt-gated bomb visuals (label 1 is the
    // fade-out path in the player bomb scripts).
    if (this.prevBombTimer > 0 && p.bombTimer === 0) this.playerEffects.interruptAll(1);
    this.prevBombTimer = p.bombTimer;
    this.playerEffects.update();
    if (this.score > this.hiScore) this.hiScore = this.score;
  }

  private onBombUsed(): void {
    this.playSfx(12);
    this.spawnEffectParticles(3, this.playerObj.x, this.playerObj.y, 24, 0xffffffff);
    // Th07.exe FUN_00431d10: bombing flags every live item for collection
    // (same state=1 autocollect the border uses in updateItems).
    for (const it of this.items) if (!it.dead) it.state = 1;
    this.spawnBombEffects();
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
    // Approximation of Th07.exe's per-orb localized hitboxes (radii 24-256,
    // per-tick damage 1-23, exe-bombs.md §3): a single player-centered 128px
    // region at 8 dmg/frame. Full 24-state-machine fidelity out of scope;
    // flagged per AGENTS.md §7. No full-screen sweep exists in the exe.
    for (const e of this.enemies) {
      if (!e.ecl.canTakeDamage || !e.ecl.interactable) continue;
      if (Math.abs(e.x - p.x) <= 128 && Math.abs(e.y - p.y) <= 128) this.damageEnemy(e, 8);
    }
    for (const b of this.enemyBullets) {
      if (b.dead) continue;
      if (Math.abs(b.x - p.x) <= 128 && Math.abs(b.y - p.y) <= 128) {
        this.spawnItem('pointBullet', b.x, b.y, { state: 1 });
        b.dead = true;
      }
    }
    // Marisa's bombs continuously pop star bursts (player01.anm scr98-104)
    // — around the player for A, along the spark beam for B (cadence
    // approximated, AGENTS.md §7).
    if (p.character === 'marisaA' && this.frame % 4 === 0) {
      this.playerEffects.spawn({
        scriptId: 98 + this.rng.u32InRange(7),
        x: p.x + this.rng.range(192) - 96,
        y: p.y - this.rng.range(224)
      });
    } else if (p.character === 'marisaB' && this.frame % 3 === 0) {
      this.playerEffects.spawn({
        scriptId: 98 + this.rng.u32InRange(7),
        x: p.x + this.rng.range(48) - 24,
        y: p.y - 40 - this.rng.range(280)
      });
    }
  }

  // Fires once when the deathbomb window lapses (tickDeath 'effects'): the
  // death explosion, power drops, bullet clear. The respawn itself (teleport +
  // materialize) is deferred to onPlayerRespawn() after the 30-frame death
  // squish, matching Th07.exe fcn.0043dca0.
  private onPlayerDeath(): void {
    const p = this.playerObj;
    // exe-cherry-border.md §3d: the traced rate source is a per-stage
    // config float, not the SHT's per-character cherryLossOnDeath field
    // (still parsed on `p.unfocused` but unused here — see cherry.ts
    // CherrySystem#onDeath).
    this.cherry.onDeath(this.difficulty);
    this.voidSpellCapture();
    this.playSfx(2);
    this.spawnEffectParticles(3, p.x, p.y, 32, 0xffffffff);
    for (let i = 0; i < 5; i++) {
      this.spawnItem('power', p.x + this.rng.range(64) - 32, p.y - this.rng.range(32));
    }
    for (const b of this.enemyBullets) b.dead = true;
    this.playerEffects.clear();
  }

  // Fires once when the death squish finishes (tickDeath 'respawn'): teleport
  // to the spawn point and enter the materialize state. fcn.0043dca0 loses the
  // life at this teleport, not at the hit.
  private onPlayerRespawn(): void {
    const p = this.playerObj;
    p.die();
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
    this.playSfx(8); // se_ok00
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

  // Returns the actually-applied damage (post frame-cap), 0 if none — the
  // shot-hit cherry formula (cherry.ts onShotHit) needs this real amount,
  // not the raw pre-clamp bullet damage.
  damageEnemy(e: Enemy, damage: number): number {
    if (!e.ecl.canTakeDamage || !e.ecl.interactable || e.ecl.invisible) return 0;
    const done = this.frameDamage.get(e.id) ?? 0;
    const allowed = Math.max(0, ENEMY_FRAME_DAMAGE_CAP - done);
    const applied = Math.min(allowed, damage);
    if (applied <= 0) return 0;
    this.frameDamage.set(e.id, done + applied);
    e.hp -= applied;
    // Th07.exe FUN_0041ed50 @ all.c:14220: score += ((applied/5)*10)/10 --
    // the "*10)/10" is a compiler no-op (exact multiple of 10 divided back
    // down), collapsing to score += floor(min(70,applied)/5); the min(70,..)
    // cap ("if (0x45 < local_1c) local_1c = 0x46;") is unconditional, unlike
    // the cherry-gain divisor logic above it. Confirmed against the HUD's
    // raw "%.8d"/"%.9d" digit format (no display-side rescale anywhere) --
    // see EXECUTION-LOG.md's score-unit adjudication.
    this.addScore(Math.trunc(Math.min(70, applied) / 5));
    return applied;
  }

  private updatePlayerBullets(): void {
    // Th07.exe FUN_0043edc0/FUN_0041ed50 (exe-player-funcs1.md §2): the homing
    // target is a single per-frame cache shared by every ReimuA amulet/orb —
    // the eligible enemy minimizing |e.x - player.x| (Y ignored entirely).
    // Reset+repopulated once per frame here, not per-bullet.
    const px = this.playerObj.x;
    // exe-cherry-border.md §3a: DAT_00625627 (raw difficulty*2+shotTypeBit)
    // gates a parity quirk in the shot-hit cherry formula. shotTypeBit is
    // the low bit of that byte (spec §3d: DAT_00625626 = byte&1); this
    // port's "A"/"B" shot suffix is the closest available analogue.
    const shotTypeBit = this.playerObj.character.endsWith('B') ? 1 : 0;
    let homingTarget: Enemy | null = null;
    let homingBestDx = Infinity;
    for (const e of this.enemies) {
      if (!e.ecl.interactable || e.ecl.invisible || e.dead || !e.ecl.canTakeDamage) continue;
      const dx = Math.abs(e.x - px);
      if (dx < homingBestDx) {
        homingBestDx = dx;
        homingTarget = e;
      }
    }
    for (const b of this.playerBullets) {
      b.age++;
      if (b.state === 'fired') {
        if (b.shotType === 1 || b.shotType === 2) this.steerHomingBullet(b, homingTarget);
        else if (b.shotType === 3) {
          // MarisaA missile, Th07.exe FUN_00439650 (exe-player-funcs1.md §4):
          // per-frame random vertical boost from spawn, no age gate, no cap,
          // vx untouched — never routed through angle/speed.
          b.vy -= this.rng.range(0.1) + 0.27;
        }
        b.x += b.vx;
        b.y += b.vy;
      } else {
        b.hitAge++;
        if (b.hitAge > 16) b.dead = true;
      }
      if (b.state !== 'fired') continue;
      for (const e of this.enemies) {
        if (!e.ecl.collisionEnabled || !e.ecl.interactable || e.ecl.invisible || e.dead) continue;
        const hw = (e.ecl.hitbox.x + b.hitboxW) / 2;
        const hh = (e.ecl.hitbox.y + b.hitboxH) / 2;
        if (Math.abs(b.x - e.x) <= hw && Math.abs(b.y - e.y) <= hh) {
          if (b.shotType === 4 || b.shotType === 5) {
            // Th07.exe FUN_0043a980: lasers deal FULL table damage on even values
            // of their own age counter only, never enter 'collided', never spawn
            // the hit effect/SE, and pierce indefinitely (no damage decay).
            if ((b.age & 1) === 0) {
              const applied = this.damageEnemy(e, b.damage);
              if (applied > 0) {
                this.cherry.onShotHit(applied, e.ecl.isBoss, this.difficulty, shotTypeBit, (e.ecl.bossTimer & 1) === 1);
              }
            }
          } else {
            const applied = this.damageEnemy(e, b.damage);
            if (applied > 0) {
              this.cherry.onShotHit(applied, e.ecl.isBoss, this.difficulty, shotTypeBit, (e.ecl.bossTimer & 1) === 1);
            }
            b.state = 'collided';
            if (b.shotType !== 3) {
              // Th07.exe: velocity/8 on hit — except shotType 3 (MarisaA missile)
              // which keeps full velocity into its collided fade.
              b.vx /= 8;
              b.vy /= 8;
            }
            this.playSfx(17);
          }
          break;
        }
      }
      if (b.y < -32 || b.x < -32 || b.x > 416) b.dead = true;
    }
    let w = 0;
    for (const b of this.playerBullets) if (!b.dead) this.playerBullets[w++] = b;
    this.playerBullets.length = w;
  }

  // Nearest damageable enemy to (x, y); shared by the homing steer and the
  // SakuyaA focused spawn-aim.
  private findAimTarget(x: number, y: number): Enemy | null {
    let best: Enemy | null = null;
    let bestDist = 1e9;
    for (const e of this.enemies) {
      if (!e.ecl.interactable || e.ecl.invisible || e.dead || !e.ecl.canTakeDamage) continue;
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
    // killing -- onPlayerHit() calls cherry.breakBorder(), which absorbs the
    // hit (brief invuln, no death) and forfeits the survive bonus. So the same
    // graze+kill path below runs whether or not a border is up; only the
    // outcome of a kill contact differs. (A prior version special-cased the
    // border here with a graze-only early return, which made it fully
    // invincible and always pay the survive bonus -- the breakBorder path was
    // unreachable.)
    for (const b of this.enemyBullets) {
      if (b.dead) continue;
      const dx = Math.abs(b.x - px);
      const dy = Math.abs(b.y - py);
      // Th07.exe FUN_0043b350: bulletFull/2 + sht.grazebox/2 + flat 20.0 pad.
      if (!b.grazed && b.age > 15 && dx <= b.grazeW / 2 + p.grazeboxHalf + 20 && dy <= b.grazeH / 2 + p.grazeboxHalf + 20) {
        // exe: 16-frame minimum age before graze eligibility
        b.grazed = true;
        this.graze++;
        this.addScore(200); // Th07.exe FUN_0043bb30: +200 per graze
        this.cherry.onGraze(this.focusHeld);
        this.playSfx(24);
      }
      // exe FUN_004241c0: kill test runs from spawn; only graze has a min age (outer gate +0xbf0 unresolved)
      if (dx <= b.grazeW / 2 + hit && dy <= b.grazeH / 2 + hit) {
        this.onPlayerHit();
        return;
      }
    }
    for (const e of this.enemies) {
      if (!e.ecl.collisionEnabled || !e.ecl.interactable || e.ecl.invisible || e.dead) continue;
      // Th07.exe FUN_0041ebc0: body kill uses hitbox*(1/1.5)/2 = /3
      if (Math.abs(e.x - px) <= e.ecl.hitbox.x / 3 + hit && Math.abs(e.y - py) <= e.ecl.hitbox.y / 3 + hit) {
        this.onPlayerHit();
        return;
      }
    }
    // Th07.exe FUN_0041ebc0: enemy bodies are grazable, region hitbox/1.4
    // (= *(1/0.7)/2), re-attempted every 6 frames while touching -- only
    // when op136 armed `bodyRegrazeFlag` (`+0x2e29` bit5, see the
    // borderActive branch above for the full citation).
    for (const e of this.enemies) {
      if (!e.ecl.collisionEnabled || !e.ecl.interactable || e.ecl.invisible || e.dead || !e.ecl.bodyRegrazeFlag) continue;
      const cd = this.bodyGrazeCooldown.get(e.id) ?? 0;
      if (cd > 0) { this.bodyGrazeCooldown.set(e.id, cd - 1); continue; }
      if (Math.abs(e.x - px) <= e.ecl.hitbox.x / 1.4 + p.grazeboxHalf + 20 &&
          Math.abs(e.y - py) <= e.ecl.hitbox.y / 1.4 + p.grazeboxHalf + 20) {
        this.bodyGrazeCooldown.set(e.id, 6);
        this.graze++;
        this.addScore(200);
        this.cherry.onGraze(this.focusHeld);
        this.playSfx(24);
      }
    }
  }

  private onPlayerHit(): void {
    if (this.cherry.breakBorder()) {
      // The border absorbs the hit.
      this.playerObj.invulnFrames = Math.max(this.playerObj.invulnFrames, 30);
      return;
    }
    const result = this.playerObj.hit();
    if (result === 'deathbomb-window') this.playSfx(17);
  }

  private updateEnemies(): void {
    for (const e of this.enemies) {
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
    for (const b of this.enemyBullets) {
      this.updateBulletMotion(b);
      const exActive = (b.flags & (0x40 | 0x80 | 0x100 | 0x400 | 0x800)) !== 0;
      const margin = exActive ? 160 : 32;
      if (b.x < -margin || b.x > 384 + margin || b.y < -margin || b.y > 448 + margin) b.dead = true;
    }
    let w = 0;
    for (const b of this.enemyBullets) if (!b.dead) this.enemyBullets[w++] = b;
    this.enemyBullets.length = w;
  }

  // Per-frame bullet ex-behaviors, matching Th07.exe FUN_004241c0 @ 0x4241c0.
  // Each activated behavior bit in b.exFlags (exe +0xbf4, built at spawn via
  // the op-79 cond gate — see eclvm resolveExBehaviors) runs as an INDEPENDENT
  // if in the order 0x1, 0x10, 0x20, 0x40/0x100/0x80, 0xc00, then velocity is
  // added to position ONCE. Every behavior reads only its OWN op-79 slot's
  // resolved params and clears its own bit when finished.
  private updateBulletMotion(b: EnemyBullet): void {
    if (b.age < b.spawnDuration) {
      b.x += b.vx * b.spawnMoveScale;
      b.y += b.vy * b.spawnMoveScale;
      b.age++;
      return;
    }
    const age = b.age - b.spawnDuration;
    if (b.exFlags & 1) {
      // speed-ramp (FUN_00423840): velocity = polar(angle, speed + 5·decay)
      // for 17 frames; then just clears the bit. Never writes the speed
      // scalar, so it composes cleanly with accel/angle-change.
      if (age <= 16) {
        const extra = 5 - (age * 5) / 16;
        b.vx = Math.cos(b.angle) * (b.speed + extra);
        b.vy = Math.sin(b.angle) * (b.speed + extra);
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
        b.vx += Math.cos(ac.angle) * ac.mag;
        b.vy += Math.sin(ac.angle) * ac.mag;
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
        b.vx = Math.cos(b.angle) * b.speed;
        b.vy = Math.sin(b.angle) * b.speed;
      }
    }
    if ((b.exFlags & 0x40) && b.exDir) this.dirChangeBullet(b, age, 'relative');
    else if ((b.exFlags & 0x100) && b.exDir) this.dirChangeBullet(b, age, 'absolute');
    else if ((b.exFlags & 0x80) && b.exDir) this.dirChangeBullet(b, age, 'aimed');
    if ((b.exFlags & 0x400) && b.exBounce) this.bounceBullet(b, true);
    if ((b.exFlags & 0x800) && b.exBounce) this.bounceBullet(b, false);
    b.x += b.vx;
    b.y += b.vy;
    b.age++;
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
    b.vx = Math.cos(b.angle) * speed;
    b.vy = Math.sin(b.angle) * speed;
  }

  private bounceBullet(b: EnemyBullet, includeBottom: boolean): void {
    if (b.x >= 0 && b.x < 384 && b.y >= 0 && (includeBottom ? b.y < 448 : true)) return;
    const bo = b.exBounce!;
    const maxTimes = Math.max(1, bo.maxTimes | 0);
    if (b.x < 0 || b.x >= 384) b.angle = normalizeAngle(-b.angle - Math.PI);
    if (b.y < 0 || (includeBottom && b.y >= 448)) b.angle = -b.angle;
    b.speed = bo.speed;
    b.vx = Math.cos(b.angle) * b.speed;
    b.vy = Math.sin(b.angle) * b.speed;
    b.dirTimes = (b.dirTimes ?? 0) + 1;
    if (b.dirTimes >= maxTimes) b.exFlags &= includeBottom ? ~0x400 : ~0x800;
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
        it.x += Math.cos(angle) * sht.autocollectSpeed;
        it.y += Math.sin(angle) * sht.autocollectSpeed;
      } else {
        it.vy = Math.min(3, it.vy + 0.03);
        it.x += it.vx;
        it.y += it.vy;
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
    this.playSfx(18);
    switch (it.type) {
      case 'power':
        if (p.power < 128) {
          p.power = Math.min(128, p.power + 1);
          if (p.power === 128) this.turnBulletsIntoPointItems();
        } else {
          this.addScore(12800);
        }
        break;
      case 'bigPower':
        p.power = Math.min(128, p.power + 8);
        break;
      case 'fullPower':
        p.power = 128;
        break;
      case 'point': {
        this.pointItems++;
        this.addScore(this.cherry.pointItemScore(it.y, p.sht.pocLineY, it.state === 1));
        break;
      }
      case 'pointBullet':
        // exe-cherry-border.md §3/§6: star/cancel items (cases 0/2) never
        // touch any cherry accumulator — score/graze-combo only.
        this.addScore(this.graze * 10 + 500);
        break;
      case 'bomb':
        p.bombs = Math.min(8, p.bombs + 1);
        break;
      case 'life':
        p.lives = Math.min(8, p.lives + 1);
        this.playSfx(22);
        break;
      case 'cherry':
        // exe case 6 (spec §3b): +20 cherry, score = grazeScaledValue/10.
        this.addScore(this.cherry.grazeScaledItemScore(this.graze));
        this.cherry.onSmallCherryItem();
        break;
      case 'bigCherry':
        // exe case 8 (spec §3b): +100 cherry total (30 dc6f + 70 dd6c), no
        // score effect at all.
        this.cherry.onBigCherryItem();
        break;
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
    r.clear('#101018');
    r.ctx.fillStyle = '#04040c';
    r.ctx.fillRect(PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
    r.clipPlayfield(() => {
      const ox = PLAYFIELD.x;
      const oy = PLAYFIELD.y;
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
        const rotation = e.ecl.anmRotateWithAngle ? e.ecl.angle : undefined;
        r.drawAnmFrame(frame, ox + e.x, oy + e.y, rotation != null ? { rotation } : {});
      }
      for (const b of this.enemyBullets) {
        const spawning = b.age < b.spawnDuration;
        r.drawSprite(b.rect.imageKey, b.rect.x, b.rect.y, b.rect.w, b.rect.h, ox + b.x, oy + b.y, {
          rotation: b.angle + Math.PI / 2,
          scaleMultiplier: spawning ? 1.6 - 0.6 * (b.age / Math.max(1, b.spawnDuration)) : 1,
          alpha: spawning ? 0.6 + 0.4 * (b.age / Math.max(1, b.spawnDuration)) : 1,
          blend: spawning ? 'lighter' : 'source-over'
        });
      }
      for (const it of this.items) {
        // Items falling above the top edge peek in as their per-type arrow
        // sprite (original UX; etama2 emb14-21, +10 from the item id).
        const above = it.y < 0;
        const emb = ITEM_SPRITES[it.type] + (above ? ITEM_ARROW_OFFSET : 0);
        const sprite = this.assets.anms.etama.sprites.get(this.etamaItemBase + emb);
        if (sprite) {
          const drawY = Math.max(8, it.y);
          r.drawSprite(sprite.imageKey, sprite.x, sprite.y, sprite.w, sprite.h, ox + it.x, oy + drawY, {
            alpha: above ? 0.85 : 1
          });
        }
      }
      const p = this.playerObj;
      for (const b of this.playerBullets) {
        const fade = b.state === 'collided' ? 1 - b.hitAge / 16 : 0.9;
        r.drawSprite(b.rect.imageKey, b.rect.x, b.rect.y, b.rect.w, b.rect.h, ox + b.x, oy + b.y, {
          rotation: b.angle + Math.PI / 2,
          alpha: Math.max(0, fade),
          scaleMultiplier: b.state === 'collided' ? 1 + b.hitAge / 10 : 1
        });
      }
      this.playerEffects.draw(r, ox, oy);
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
      this.drawSpellDeclaration(r, ox, oy);
    });
    this.drawFrame(r);
    this.drawSidebar(r);
    this.drawSpellOverlay(r);
    this.drawDialogue(r);
    this.drawStageTitle(r);
    if (this.bonusPopup) {
      r.text(this.bonusPopup.text, PLAYFIELD.x + 70, PLAYFIELD.y + 90, { size: 15, color: '#ffd700' });
    }
    if (this.stageClear) {
      r.text('STAGE CLEAR', PLAYFIELD.x + 128, PLAYFIELD.y + 190, { size: 22, color: '#ffa' });
      r.text(`Stage Bonus  ${(this.graze * 10 + this.pointItems * 1000 + this.cherry.cherry).toLocaleString('en-US')}`, PLAYFIELD.x + 100, PLAYFIELD.y + 230, { size: 14 });
    }
    if (this.continueScreen) this.drawContinueScreen(r);
    else if (this.gameOver) r.text('GAME OVER', PLAYFIELD.x + 140, PLAYFIELD.y + 200, { size: 20, color: '#f66' });
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
    r.drawSprite(key, rect[0], rect[1], rect[2], rect[3], x + rect[2] / 2, y + rect[3] / 2, alpha === 1 ? {} : { alpha });
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

  // Background ANM scripts (stg1bg scripts 0-2) are static, time-driven
  // scripts with no per-instance branching, so one cached AnmRunner per
  // script id — stepped forward to the current STD frame — is shared by
  // every quad instance that references it.
  private bgAnmFrame(scriptId: number, targetFrame: number): AnmFrame | null {
    let entry = this.bgAnmCache.get(scriptId);
    if (!entry || targetFrame < entry.frame) {
      entry = { runner: new AnmRunner(this.assets.anms.stg1bg, scriptId), frame: 0 };
      this.bgAnmCache.set(scriptId, entry);
    }
    while (entry.frame < targetFrame) {
      entry.runner.update();
      entry.frame++;
    }
    return entry.runner.spriteFrame();
  }

  // Pseudo-3D stage background: STD quad instances, perspective-projected
  // (see Std#project for the world-space axis convention this relies on),
  // subdivided along depth into strips for perspective-correct-enough
  // texture mapping, sorted back-to-front, with linear distance fog.
  private drawBackground(r: Renderer, ox: number, oy: number): void {
    const std = this.runtime.std;
    // The STD script clock free-runs every frame (advanced in
    // StageRuntime#update); stage 1's script loops it between frames
    // 5510-6022 during the boss fight (ins_4), which Std#advance handles
    // generically, so std.frame is always the right clock to render from.
    const frame = std.frame;
    const camFrame = std.cameraFrame(frame);
    const fog = std.fog(frame);
    const ctx = r.ctx;
    // The sky *is* the current fog color: clear to it every frame, then let
    // quads blend toward it with distance below.
    ctx.fillStyle = fog.css;
    ctx.fillRect(ox, oy, PLAYFIELD.width, PLAYFIELD.height);

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
      const spriteFrame = this.bgAnmFrame(c.script, frame);
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
    const img = r.image('eff01');
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
      const sprite = this.assets.anms.face_01_00.sprites.get(sc.portraitSprite);
      const img = r.image('face_01_00');
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
      const bonusText = sc.capturing ? `Bonus ${sc.bonus.toLocaleString('en-US')}${history}` : `Bonus failed${history}`;
      r.text(bonusText, x, y + 18, { size: 11, color: sc.capturing ? '#adf' : '#977', align: 'right' });
    }
  }

  private drawDialogue(r: Renderer): void {
    const d = this.dialogue;
    if (!d) return;
    const ctx = r.ctx;
    const family = CHARACTERS[this.playerObj.character].family;
    const playerFaceKey = (['face_rm00', 'face_mr00', 'face_sk00'] as const)[family];
    const anms = [this.assets.anms[playerFaceKey], this.assets.anms.face_01_00];
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
  private drawStageTitle(r: Renderer): void {
    const f = this.stageFrame;
    if (f > 360 || this.dialogue) return;
    const alpha = f < 60 ? f / 60 : f > 280 ? Math.max(0, (360 - f) / 80) : 1;
    if (alpha <= 0) return;
    const ctx = r.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    r.text('STAGE 1', PLAYFIELD.x + 150, PLAYFIELD.y + 150, { size: 18, color: '#fdd' });
    r.text(this.runtime.std.stageName, PLAYFIELD.x + 90, PLAYFIELD.y + 180, { size: 16 });
    r.text(`♪ ${this.runtime.std.songNames[0] ?? ''}`, PLAYFIELD.x + 100, PLAYFIELD.y + 215, { size: 12, color: '#aac' });
    ctx.restore();
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
    this.drawNumber(r, Math.max(this.hiScore, this.score), valueX, 50, 9);
    label(FRONT.score, 64);
    this.drawNumber(r, this.score, valueX, 66, 9);

    label(FRONT.player, 96);
    for (let i = 0; i < Math.max(0, p.lives); i++) star(FRONT.redStar, valueX + i * 16, 96);
    label(FRONT.bomb, 112);
    for (let i = 0; i < Math.max(0, p.bombs); i++) star(FRONT.blueStar, valueX + i * 16, 112);

    // Power bar sits on the Power row at the value column (a filled gradient
    // bar with MAX/current inside, like the original's readout).
    label(FRONT.power, 144);
    const barW = 128;
    ctx.fillStyle = '#2a0817';
    ctx.fillRect(valueX, 146, barW, 12);
    ctx.fillStyle = p.power >= 128 ? '#d9b95c' : '#a53a63';
    ctx.fillRect(valueX, 146, barW * Math.min(1, p.power / 128), 12);
    if (p.power >= 128) r.text('MAX', valueX + 4, 156, { size: 12, color: '#fff' });
    else this.drawNumber(r, p.power, valueX + 4, 146);

    label(FRONT.graze, 160);
    this.drawNumber(r, this.graze, valueX, 162);
    label(FRONT.point, 176);
    this.drawNumber(r, this.pointItems, valueX, 178);

    // Cherry+ readout hugging the screen's bottom-left (ascii.anm script4):
    // the banner sprite reads "Cherry+ [blank]/" — the current Cherry+ value
    // is composited right-aligned into the blank slot ending at the slash
    // (in-sprite x≈84), and the 50000 cap goes after it. The banner itself
    // dims to alpha 64/255 while charging and runs full-bright while the
    // border is up (the script's interrupt-2/3 states); the engine-drawn
    // digits stay opaque.
    this.blit(r, 'ascii', [0, 224, 96, 16], PLAYFIELD.x, 448, this.cherry.borderActive ? 1 : 64 / 255);
    const plusStr = String(Math.max(0, Math.trunc(this.cherry.cherryPlus)));
    this.drawNumber(r, this.cherry.cherryPlus, PLAYFIELD.x + 84 - plusStr.length * DIGIT_W, 450);
    this.drawNumber(r, CHERRY_PLUS_MAX, PLAYFIELD.x + 96, 450);

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
      // Boss nameplate: ename.png 16px rows composited at (32,26) (AGENTS.md
      // §6). Row selection is the stage-1 heuristic from dialogueSeen (0 =
      // Cirno midboss, 1 = Letty after the pre-boss dialogue).
      if (!this.dialogue) {
        this.blit(r, 'ename', [0, this.dialogueSeen ? 16 : 0, 128, 16], 32, 26);
      }
      // Enemy position marker on the bottom edge (PCB feature).
      const bx = PLAYFIELD.x + Math.max(0, Math.min(PLAYFIELD.width, this.bossActive.x));
      ctx.fillStyle = '#f8bcd0';
      ctx.beginPath();
      ctx.moveTo(bx - 7, PLAYFIELD.y + PLAYFIELD.height);
      ctx.lineTo(bx + 7, PLAYFIELD.y + PLAYFIELD.height);
      ctx.lineTo(bx, PLAYFIELD.y + PLAYFIELD.height - 8);
      ctx.closePath();
      ctx.fill();
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
