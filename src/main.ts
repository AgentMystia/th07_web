import { Loop } from './core/loop';
import { Input } from './core/input';
import { Renderer } from './gfx/renderer';
import { AudioBus } from './audio/audio';
import { loadAssets } from './game/assets';
import { StageScene } from './game/stage-scene';
import { MenuFlow, type ReplayPlaybackMode } from './game/title-scene';
import type { CharacterId } from './game/player';
import { stageBgmTracks } from './game/bgm';
import { stageSnapshot } from './game/snapshot';
import { MAX_RPY_BYTES, Rpy } from './formats/rpy';
import { ReplayInputSource } from './core/replay-input';
import {
  applyReplayStageSnapshot,
  replayFastForwardContinues,
  replaySlowdownAdvances,
  replayStageEntry
} from './game/replay-playback';

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
  lifecycleLog(): { f: number; ev: string; id: number; sub: number; a?: number }[];
  frameCost(): { update: number[]; draw: number[] };
  // Last frame's per-pass draw costs (ms), PERF-001 breakdown.
  drawPasses(): Record<string, number>;
  // Test-only: flood the item pool for PERF-001's dense-items scenario.
  fillItems(n: number): void;
  // Releases every previously injected held key (Input.inject is additive).
  clearInput(): void;
  setBombs(n: number): void;
  bgm(): { active: string | null; decoded: string[] };
}

declare global {
  interface Window {
    __TH07_TEST__?: TestHook;
  }
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
  let activeReplay: {
    replay: Rpy;
    fileName: string;
    stageIndex: number;
    frame: number;
    mode: ReplayPlaybackMode;
    modeCounter: number;
    source: ReplayInputSource;
  } | null = null;
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
    carry: import('./game/stage-scene').RunCarry | null = null,
    practice = false
  ): StageScene {
    activeReplay = null;
    const s = new StageScene(assets, audio, difficulty, character, stageNumber, carry);
    // Headless probes (?test=1 without ?menu=1) keep the scene alive forever;
    // real play gets the arcade flow: continue screen + return to title.
    // Practice (exe DAT_00625628 bit0): one stage, no continues, straight
    // back to the title on clear or game over.
    s.mode = practice ? 'practice' : useMenu || testArcade ? 'arcade' : 'test';
    // Practice starts with 8 lives (Th07.exe FUN_0042cf2f @ all.c:19718-19720,
    // CONFIRMED), and any stage other than 1 starts at FULL power — the
    // stage-entry tail sets power to _DAT_0048eb84 = 128.0 when the run's
    // practice flag (stats+0x93d8 bit 0) is set and the stage isn't 1
    // (all.c:19856-19859). Stage-1 practice keeps the normal power-0 start.
    if (practice) {
      s.playerObj.lives = 8;
      if (stageNumber !== 1) s.playerObj.power = 128;
    }
    s.hiScore = Math.max(s.hiScore, sessionHiScore);
    s.onExitToTitle = () => {
      sessionHiScore = Math.max(sessionHiScore, s.hiScore);
      stage = null;
      // Returning from practice parks the title cursor back on Practice
      // Start (exe FUN_00452e91 @ all.c:40457-40459).
      menu = createMenu(practice ? 2 : 0);
      audio.preloadBgm(['th07_01']);
      audio.playBgm('th07_01');
    };
    // Pause-menu 最初からやり直す: restart the run from its beginning —
    // story from stage 1, practice/test from the current stage.
    s.onRetryRun = () => {
      sessionHiScore = Math.max(sessionHiScore, s.hiScore);
      startStage(difficulty, character, s.mode === 'arcade' ? 1 : stageNumber, null, practice);
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
  // stage 8; main difficulties start at stage 1. Practice carries its own
  // chosen stage.
  const startFromMenu = (
    difficulty: number,
    character: CharacterId,
    opts?: import('./game/title-scene').MenuStartOptions
  ) =>
    startStage(
      difficulty,
      character,
      opts?.practice ? opts.stage ?? 1 : difficulty >= 4 ? difficulty + 3 : 1,
      null,
      opts?.practice ?? false
    );

  function createMenu(initialTitleCursor = 0): MenuFlow {
    return new MenuFlow(assets, audio, startFromMenu, initialTitleCursor, startReplayStage);
  }

  function showReplayMenu(replay: Rpy, fileName: string, stageIndex: number): void {
    activeReplay = null;
    stage = null;
    menu = createMenu(3);
    menu.showReplay(replay, fileName, stageIndex);
    audio.preloadBgm(['th07_01']);
    audio.playBgm('th07_01');
  }

  function advanceReplayStage(
    replay: Rpy,
    fileName: string,
    stageIndex: number,
    mode: ReplayPlaybackMode
  ): void {
    const next = stageIndex + 1;
    const currentStage = replay.stages[stageIndex];
    const nextStage = replay.stages[next];
    // Native playback tests the immediately following physical offset slot;
    // it does not skip a zero entry to a later present slot.
    if (nextStage?.stage === currentStage.stage + 1) startReplayStage(replay, next, fileName, mode);
    else showReplayMenu(replay, fileName, stageIndex);
  }

  // Browser replay playback uses the same constructor/restore order as the
  // Node verifier: seed first, let manager bootstrap consume from it, then
  // restore the remaining T7RP stage-entry fields. Starting from a selected
  // middle stage continues only while each immediately following physical
  // slot exists, as Th07.exe FUN_0045207e does.
  function startReplayStage(
    replay: Rpy,
    stageIndex: number,
    fileName: string,
    mode: ReplayPlaybackMode
  ): void {
    const entry = replayStageEntry(replay, stageIndex);
    const s = new StageScene(
      assets,
      audio,
      replay.difficulty,
      replay.character,
      entry.runtimeStageNumber,
      null,
      entry.stage.rngSeed
    );
    s.mode = 'replay';
    applyReplayStageSnapshot(s, replay, stageIndex);
    s.onExitToTitle = () => showReplayMenu(replay, fileName, stageIndex);
    s.onStageComplete = () => advanceReplayStage(replay, fileName, stageIndex, mode);
    stage = s;
    menu = null;
    activeReplay = {
      replay,
      fileName,
      stageIndex,
      frame: 0,
      mode,
      modeCounter: 0,
      source: new ReplayInputSource()
    };
    const [stageTrack, bossTrack] = stageBgmTracks(entry.runtimeStageNumber);
    audio.preloadBgm([stageTrack, bossTrack]);
    if (stageIndex + 1 < replay.stages.length) {
      audio.preloadBgm([...stageBgmTracks(replayStageEntry(replay, stageIndex + 1).runtimeStageNumber)]);
    }
    audio.playBgm(stageTrack);
  }

  // Local-file loading remains wholly browser-side: no upload, no server
  // path, and the hidden element provides a stable Playwright setInputFiles
  // seam for visual replay acceptance.
  const replayFileInput = document.createElement('input');
  replayFileInput.id = 'replay-file';
  replayFileInput.type = 'file';
  replayFileInput.accept = '.rpy,application/octet-stream';
  replayFileInput.hidden = true;
  document.body.appendChild(replayFileInput);
  replayFileInput.addEventListener('change', () => {
    const file = replayFileInput.files?.[0];
    if (!file) return;
    if (file.size > MAX_RPY_BYTES) {
      input.frame();
      menu?.showReplayError(file.name, 'T7RP file exceeds 16 MiB safety limit');
      replayFileInput.value = '';
      return;
    }
    void (async () => {
      try {
        const buffer = await file.arrayBuffer();
        const replay = new Rpy(new Uint8Array(buffer));
        // Force validation of the shot byte before the menu presents it.
        void replay.character;
        if (replay.stages.length === 0) throw new Error('T7RP contains no playable stage');
        // Consume the Z/Enter edge that opened the native file dialog. Its
        // delayed delivery must not instantly confirm Stage 1 after loading.
        input.frame();
        menu?.showReplay(replay, file.name);
      } catch (err) {
        input.frame();
        const message = err instanceof Error ? err.message : String(err);
        menu?.showReplayError(file.name, message);
      } finally {
        replayFileInput.value = '';
      }
    })();
  });
  // File pickers require transient user activation. MenuFlow consumes input
  // on the next rAF tick, so open the dialog synchronously on the physical
  // key event while Replay is focused.
  addEventListener('keydown', (event) => {
    if ((event.code === 'KeyZ' || event.code === 'Enter') && !event.repeat && menu?.replayFileHotkeyActive()) {
      replayFileInput.value = '';
      replayFileInput.click();
    }
  });

  if (useMenu) {
    menu = createMenu();
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

  // A throw escaping the rAF tick used to end the loop permanently (frozen
  // canvas, BGM still playing, input dead — the stage-4 tester hard-lock).
  // Halt the crashed phase but keep rAF alive, and rethrow asynchronously so
  // the failure still surfaces as an uncaught page error for devtools and the
  // headless probes' PAGE ERRORS reporting.
  let simHalted = false;
  let drawHalted = false;
  const reportFatal = (phase: string, err: unknown): void => {
    console.error(`[th07] ${phase} halted by uncaught error`, err);
    setTimeout(() => {
      throw err instanceof Error ? err : new Error(String(err));
    });
  };
  const drawErrorBanner = (): void => {
    const ctx = renderer.ctx;
    const scale = ctx.canvas.width / 640;
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(0, 458, 640, 22);
    ctx.fillStyle = '#ff6666';
    ctx.font = '12px monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText('ERROR: simulation halted by an uncaught exception (see console)', 8, 469);
    ctx.restore();
  };
  const loop = new Loop({
    update: () => {
      if (simHalted) return;
      const liveFrame = input.frame();
      try {
        if (menu) {
          menu.update(liveFrame);
        } else if (stage && activeReplay) {
          const playback = activeReplay;
          // Pause/menu time is outside the T7RP frame stream. Feed physical
          // input to the pause UI and leave the replay cursor untouched.
          if (stage.pauseState || liveFrame.pressed.has('pause')) {
            stage.update(liveFrame);
          } else {
            const replayStage = playback.replay.stages[playback.stageIndex];
            let advances = true;
            if (playback.mode === 1) {
              const recordedFps = replayStage.slowdown[Math.floor(playback.frame / 30)] & 0x7f;
              // Th07.exe FUN_0042bfca @ all.c:19303 reproduces slowdown in
              // discrete cadence bands, not by linear FPS interpolation.
              // MSG playback bypasses these skips so dialogue timing remains
              // tied to its recorded input stream.
              if (!stage.dialogue) {
                advances = replaySlowdownAdvances(recordedFps, ++playback.modeCounter);
              }
            }
            // FUN_0043fda0 returns manager code 6 to immediately restart the
            // priority chain in the same rendered frame. Skippable dialogue
            // runs up to 3x; boss-only playback runs non-boss sections up to
            // 5x. The two predicates can combine, meeting within 15 ticks.
            for (let i = 0; advances && i < 15 && activeReplay === playback; i++) {
              const word = replayStage.inputs[playback.frame];
              if (word == null) {
                advanceReplayStage(playback.replay, playback.fileName, playback.stageIndex, playback.mode);
                break;
              }
              stage.update(playback.source.frame(word));
              playback.frame++;
              // A stage callback may already have replaced activeReplay.
              if (activeReplay === playback && playback.frame >= replayStage.inputs.length) {
                advanceReplayStage(playback.replay, playback.fileName, playback.stageIndex, playback.mode);
              }
              if (activeReplay !== playback) break;
              if (!replayFastForwardContinues(
                playback.mode,
                playback.frame,
                !!stage.dialogue?.skippable,
                !!stage.bossActive
              )) break;
            }
          }
        } else if (stage) {
          stage.update(liveFrame);
        }
      } catch (err) {
        simHalted = true;
        reportFatal('simulation', err);
      }
    },
    draw: () => {
      if (!drawHalted) {
        try {
          if (menu) menu.draw(renderer);
          else if (stage) stage.draw(renderer);
        } catch (err) {
          drawHalted = true;
          if (!simHalted) reportFatal('rendering', err);
          simHalted = true;
        }
      }
      if (simHalted || drawHalted) drawErrorBanner();
    }
  });

  // ?paused=1 (test-only): do not start the rAF loop — the page renders
  // nothing until the probe's first advance(). Removes the boot-frame
  // jitter between probe runs so fixed-frame checkpoints are comparable.
  const startPaused = isTest && params.get('paused') === '1';
  if (isTest) {
    window.__TH07_TEST__ = {
      ready: true,
      pause: () => loop.stop(),
      advance: (n: number) => loop.advance(n),
      snapshot: () => {
        if (menu) return menu.snapshot();
        const snapshot = stageSnapshot(stage!);
        if (!activeReplay) return snapshot;
        const replayStage = activeReplay.replay.stages[activeReplay.stageIndex];
        return {
          ...snapshot,
          replay: {
            fileName: activeReplay.fileName,
            name: activeReplay.replay.name,
            stage: replayStage.stage,
            frame: activeReplay.frame,
            totalFrames: replayStage.inputs.length,
            playbackMode: activeReplay.mode
          }
        };
      },
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
      lifecycleLog: () => stage?.runtime.lifecycleLog ?? [],
      frameCost: () => loop.frameCosts(),
      drawPasses: () => stage?.drawPassCosts ?? {},
      fillItems: (n: number) => {
        if (!stage) return;
        // Deterministic grid fill through the real spawn path (1100 cap
        // applies); types cycle so the draw path sees mixed art.
        const types = ['power', 'point', 'bigPower', 'cherry', 'bigCherry'] as const;
        for (let i = 0; i < n; i++) {
          stage.spawnItem(types[i % types.length], 16 + (i * 7) % 352, 16 + (i * 13) % 400);
        }
      },
      clearInput: () => input.clearInjected(),
      setBombs: (n: number) => { if (stage) stage.playerObj.bombs = n; },
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
  if (!startPaused) loop.start();
}

void boot().catch((err) => {
  console.error(err);
  const el = document.createElement('pre');
  el.style.color = '#f66';
  el.textContent = String((err as Error)?.stack ?? err);
  document.body.appendChild(el);
});
