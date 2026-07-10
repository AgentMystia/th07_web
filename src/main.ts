import { Loop } from './core/loop';
import { Input } from './core/input';
import { Renderer } from './gfx/renderer';
import { AudioBus } from './audio/audio';
import { loadAssets } from './game/assets';
import { StageScene } from './game/stage-scene';
import { MenuFlow } from './game/title-scene';
import type { CharacterId } from './game/player';
import { stageBgmTracks } from './game/bgm';

interface TestHook {
  ready: boolean;
  pause(): void;
  advance(n: number): void;
  setLives(n: number): void;
  setInvuln(frames: number): void;
  snapshot(): Record<string, unknown>;
  pixelAt(x: number, y: number): number[];
  capturePixel(x: number, y: number): number[];
  setPlayer(x: number, y: number): void;
  setPower(v: number): void;
  inject(held: string[], pressed: string[]): void;
  damageBoss(n: number): void;
  addCherry(n: number): void;
  primeBorderCollision(): boolean;
  clearEnemyBullets(): void;
  spawnLog(): { t: number; time: number; sub: number }[];
  bgm(): { active: string | null; decoded: string[] };
}

declare global {
  interface Window {
    __TH07_TEST__?: TestHook;
  }
}

// Unchanged from before the title/menu flow was added (see scripts/dev-shot.mjs
// and the test suite, which depend on this exact shape), plus a `scene:
// 'stage'` tag so the unified test hook below can report which kind of
// screen is active without special-casing either side.
function stageSnapshot(scene: StageScene): Record<string, unknown> {
  return {
    scene: 'stage',
    stageNumber: scene.stageNumber,
    mode: scene.mode,
    frame: scene.frame,
    stageFrame: scene.stageFrame,
    difficulty: scene.difficulty,
    character: scene.playerObj.character,
    score: scene.score,
    hiScore: scene.hiScore,
    enemies: scene.enemies.length,
    bullets: scene.enemyBullets.length,
    items: scene.items.length,
    itemDump: scene.items.slice(0, 12).map((it) => ({
      type: it.type, x: Math.round(it.x), y: Math.round(it.y), state: it.state
    })),
    timelines: scene.runtime.timelineCursors.map((c) => ({ ...c })),
    bossActive: !!scene.bossActive,
    bossHp: scene.bossActive?.hp ?? null,
    lasers: scene.enemyLasers.filter((l) => l.inUse).length,
    laserDump: scene.enemyLasers.filter((l) => l.inUse).slice(0, 6).map((l) => ({
      x: Math.round(l.x), y: Math.round(l.y), angle: Number(l.angle.toFixed(2)),
      near: Math.round(l.nearDist), far: Math.round(l.farDist), w: Number(l.displayWidth.toFixed(1)), state: l.state
    })),
    stageClear: scene.stageClear,
    stageClearTimer: scene.stageClearTimer,
    clearPresentation: {
      loadingKey: scene.clearLoadingKey,
      loading: scene.clearLoadingRunner ? {
        id: scene.clearLoadingRunner.scriptId,
        frame: Math.round(scene.clearLoadingRunner.frame),
        removed: scene.clearLoadingRunner.removed,
        visible: scene.clearLoadingRunner.visible
      } : null,
      capture: scene.clearCaptureRunner ? {
        id: scene.clearCaptureRunner.scriptId,
        frame: Math.round(scene.clearCaptureRunner.frame),
        removed: scene.clearCaptureRunner.removed,
        visible: scene.clearCaptureRunner.visible,
        waiting: scene.clearCaptureRunner.waiting
      } : null
    },
    stageTransition: {
      timer: scene.stageTransitionTimer,
      total: scene.stageTransitionTiles.length,
      live: scene.stageTransitionTiles.filter((tile) => !tile.runner.removed).length,
      first: scene.stageTransitionTiles[0] ? {
        script: scene.stageTransitionTiles[0].runner.scriptId,
        frame: Math.round(scene.stageTransitionTiles[0].runner.frame),
        delay: scene.stageTransitionTiles[0].delay
      } : null,
      last: scene.stageTransitionTiles.length ? {
        script: scene.stageTransitionTiles[scene.stageTransitionTiles.length - 1].runner.scriptId,
        frame: Math.round(scene.stageTransitionTiles[scene.stageTransitionTiles.length - 1].runner.frame),
        delay: scene.stageTransitionTiles[scene.stageTransitionTiles.length - 1].delay
      } : null
    },
    gameOver: scene.gameOver,
    continueActive: !!scene.continueScreen,
    spellName: scene.spellName,
    spell: scene.spellcard ? { id: scene.spellcard.id, capturing: scene.spellcard.capturing, declAge: scene.spellcard.declAge } : null,
    rngSeed: scene.rng.seed,
    player: {
      x: scene.playerObj.x,
      y: scene.playerObj.y,
      lives: scene.playerObj.lives,
      bombs: scene.playerObj.bombs,
      power: scene.playerObj.power,
      invuln: scene.playerObj.invulnFrames,
      bombInvuln: scene.playerObj.bombInvuln,
      deathTimer: scene.playerObj.deathTimer,
      alive: scene.playerObj.alive
    },
    bomb: { timer: scene.playerObj.bombTimer },
    graze: scene.graze,
    pointItems: scene.pointItems,
    spellsCaptured: scene.cherry.spellsCaptured,
    playerBullets: scene.playerBullets.length,
    playerBulletDump: scene.playerBullets.slice(0, 8).map((b) => ({
      x: Math.round(b.x),
      y: Math.round(b.y),
      shotType: b.shotType,
      rect: [b.rect.x, b.rect.y, b.rect.w, b.rect.h],
      img: b.rect.imageKey,
      vx: Number(b.vx.toFixed(2)),
      vy: Number(b.vy.toFixed(2))
    })),
    cherry: {
      c: scene.cherry.cherry,
      max: scene.cherry.cherryMax,
      plus: scene.cherry.cherryPlus,
      border: scene.cherry.borderTimer,
      pending: scene.cherry.borderPending,
      message: scene.borderMessage ? { ...scene.borderMessage } : null,
      clearWave: scene.borderClearWave ? { ...scene.borderClearWave } : null
    },
    std: {
      frame: scene.runtime.std.frame,
      animationFrame: scene.runtime.std.animationFrame,
      paused: scene.runtime.std.paused,
      primary: scene.runtime.std.primaryAnm ? { ...scene.runtime.std.primaryAnm } : null,
      secondary: scene.runtime.std.secondaryAnm ? { ...scene.runtime.std.secondaryAnm } : null
    },
    bulletDump: scene.enemyBullets.slice(0, 64).map((b) => ({
      id: b.id,
      x: Math.round(b.x),
      y: Math.round(b.y),
      flags: b.flags,
      dead: !!b.dead,
      sprite: b.sprite,
      off: b.spriteOffset,
      rect: [b.rect.x, b.rect.y, b.rect.w, b.rect.h],
      img: b.rect.imageKey,
      vx: Number(b.vx.toFixed(2)),
      vy: Number(b.vy.toFixed(2))
    })),
    enemyDump: scene.enemies.slice(0, 8).map((e) => ({
      sub: e.ecl.subId,
      ctxSub: e.ecl.ctx.subId,
      ctxTime: e.ecl.ctx.time,
      ctxIndex: e.ecl.ctx.index,
      waitTimer: e.ecl.ctx.waitTimer,
      x: Math.round(e.x),
      y: Math.round(e.y),
      hp: e.hp,
      boss: e.ecl.isBoss,
      bossSlot: e.ecl.bossSlot,
      canTakeDamage: e.ecl.canTakeDamage,
      deathCallbackSub: e.ecl.deathCallbackSub,
      pendingInterrupt: e.ecl.pendingInterrupt,
      interactable: e.ecl.interactable,
      invisible: e.ecl.invisible,
      deathMode: e.ecl.deathMode,
      timer: e.ecl.bossTimer
    }))
  };
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('missing #game canvas');
  const renderer = new Renderer(canvas);
  renderer.clear('#000');
  renderer.text('Now Loading...', 270, 230, { size: 16 });

  const assets = await loadAssets();
  renderer.assets = assets.images;
  const input = new Input();
  const audio = new AudioBus();
  // Eager-preload every BGM track stage 1 can need (title + stage + boss) as
  // soon as the AudioBus exists, so decodeAudioData has already finished by
  // the time playBgm() is actually called for it (title on first
  // interaction; stage/boss at stage start). Without this, the stage track
  // was measured starting 138.9ms (~8 frames) after stage frame 0 on a
  // zero-latency local server, and 8.9s/26.2s (~533/~1573 frames) under
  // throttled Slow-4G/Fast-3G — with the title theme still audibly looping
  // for the entire gap (measured during the 2026-07-10 BGM preload audit).
  audio.preloadBgm(['th07_01', 'th07_02', 'th07_03']);
  const params = new URLSearchParams(location.search);

  // ?test=1 alone must still boot directly into the stage exactly as before
  // the menu flow existed (scripts/dev-shot.mjs and other automated tooling
  // depend on this). Add ?menu=1 alongside ?test=1 to make the menu flow
  // itself screenshot-testable; without ?test=1 (i.e. a real player), the
  // menu flow is always used.
  const isTest = params.get('test') === '1';
  const useMenu = !isTest || params.get('menu') === '1';
  // Test-only direct arcade entry: keep the normal menu bypass while using
  // the real stage-clear/continue/next-stage flow. This lets the transition
  // probe exercise carryState() rather than constructing stage 2 directly.
  const testArcade = isTest && params.get('arcade') === '1';

  let stage: StageScene | null = null;
  let menu: MenuFlow | null = null;
  // Hi-score carried across stage runs within this browser session.
  let sessionHiScore = 100000;

  // Shared by both the menu's "confirm" callback and the direct (?test=1,
  // no ?menu=1) boot path below, so BGM/preload behavior is identical either
  // way. Track 1 (th07_01) is the title theme, per musiccmt.txt.
  //
  function startStage(
    difficulty: number,
    character: CharacterId,
    stageNumber = 1,
    carry: import('./game/stage-scene').RunCarry | null = null
  ): StageScene {
    const s = new StageScene(assets, audio, difficulty, character, stageNumber, carry);
    // Headless probes (?test=1 without ?menu=1) keep the scene alive forever;
    // real play gets the arcade flow: continue screen + return to title.
    s.mode = useMenu || testArcade ? 'arcade' : 'test';
    s.hiScore = Math.max(s.hiScore, sessionHiScore);
    s.onExitToTitle = () => {
      sessionHiScore = Math.max(sessionHiScore, s.hiScore);
      stage = null;
      menu = new MenuFlow(assets, audio, startFromMenu);
      audio.preloadBgm(['th07_01']);
      audio.playBgm('th07_01');
    };
    // Stage clear tally advanced -> tear down and enter the next stage with
    // the run state carried over (score/lives/bombs/power/graze/cherry).
    s.onStageComplete = (c) => {
      sessionHiScore = Math.max(sessionHiScore, c.hiScore);
      startStage(difficulty, character, stageNumber + 1, c);
    };
    stage = s;
    menu = null;
    const [stageTrack, bossTrack] = stageBgmTracks(stageNumber);
    audio.preloadBgm([stageTrack, bossTrack]);
    // Main-route transitions have an entire stage of lead time to decode the
    // next pair, matching the native game's ready-before-play behavior.
    if (stageNumber < 6) audio.preloadBgm([...stageBgmTracks(stageNumber + 1)]);
    audio.playBgm(stageTrack);
    return s;
  }

  // Menu-initiated runs: difficulty 4 = Extra -> stage 7, 5 = Phantasm ->
  // stage 8; main difficulties start at stage 1.
  const startFromMenu = (difficulty: number, character: CharacterId) =>
    startStage(difficulty, character, difficulty >= 4 ? difficulty + 3 : 1);

  if (useMenu) {
    menu = new MenuFlow(assets, audio, startFromMenu);
    audio.preloadBgm(['th07_01']);
    audio.playBgm('th07_01');
  } else {
    // ?difficulty=0..5 (4 = Extra, 5 = Phantasm), ?stage=1..8 for probes.
    const difficulty = Math.min(5, Math.max(0, Number(params.get('difficulty') ?? 1)));
    const character = (params.get('shot') ?? 'reimuA') as CharacterId;
    const stageNumber = Math.min(8, Math.max(1, Number(params.get('stage') ?? 1)));
    const s = startStage(difficulty, character, stageNumber);
    // Test-only override so scripts/dev-shot.mjs can snapshot a shot pattern
    // at an arbitrary power bracket without needing to grind for it in-game.
    if (params.has('power')) s.playerObj.power = Number(params.get('power'));
    // Test-only entry point for driving a real MSG stream without waiting
    // thousands of stage frames; DialogueRunner and AudioBus are unchanged.
    if (params.has('dialogue')) s.startDialogue(Number(params.get('dialogue')));
  }

  const loop = new Loop({
    update: () => {
      const frame = input.frame();
      if (menu) menu.update(frame);
      else if (stage) stage.update(frame);
    },
    draw: () => {
      if (menu) menu.draw(renderer);
      else if (stage) stage.draw(renderer);
    }
  });

  if (isTest) {
    window.__TH07_TEST__ = {
      ready: true,
      pause: () => loop.stop(),
      advance: (n: number) => loop.advance(n),
      snapshot: () => (menu ? menu.snapshot() : stageSnapshot(stage!)),
      pixelAt: (x: number, y: number) => Array.from(renderer.ctx.getImageData(x, y, 1, 1).data),
      capturePixel: (x: number, y: number) => {
        const surface = renderer.image('capture:@');
        if (!(surface instanceof HTMLCanvasElement)) return [0, 0, 0, 0];
        const ctx = surface.getContext('2d');
        return ctx ? Array.from(ctx.getImageData(x, y, 1, 1).data) : [0, 0, 0, 0];
      },
      setPlayer: (x: number, y: number) => {
        if (!stage) return;
        stage.playerObj.x = x;
        stage.playerObj.y = y;
      },
      setPower: (v: number) => {
        if (stage) stage.playerObj.power = v;
      },
      inject: (held: string[], pressed: string[]) => {
        input.inject(held as never, pressed as never);
      },
      spawnLog: () => stage?.runtime.spawnLog ?? [],
      damageBoss: (n: number) => {
        // Same gate as player damage, so probes can't hit a boss that is
        // invulnerable during phase transitions / the death animation.
        const b = stage?.bossActive;
        if (b && b.ecl.canTakeDamage && b.ecl.interactable) b.hp -= n;
      },
      addCherry: (n: number) => {
        if (!stage) return;
        stage.cherry.debugAddCherry(n);
      },
      primeBorderCollision: () => stage?.debugPrimeBorderCollision() ?? false,
      clearEnemyBullets: () => { if (stage) stage.enemyBullets.length = 0; },
      // Test-only: force the life count so probes can reach and observe
      // late-stage content (boss spells, the Supernatural Border) that a
      // no-dodge headless run would otherwise die before reaching. Same
      // spirit as setPower/addCherry above.
      setLives: (n: number) => { if (stage) stage.playerObj.lives = n; },
      // Test-only, same spirit as setLives: hold spawn-invulnerability so
      // probes can observe full bullet patterns without death-wipes
      // (player death clears all enemy bullets) resetting the field.
      setInvuln: (frames: number) => { if (stage) stage.playerObj.invulnFrames = frames; },
      bgm: () => ({ active: audio.active, decoded: audio.decodedTracks })
    };
  }
  loop.start();
}

void boot().catch((err) => {
  console.error(err);
  const el = document.createElement('pre');
  el.style.color = '#f66';
  el.textContent = String((err as Error)?.stack ?? err);
  document.body.appendChild(el);
});
