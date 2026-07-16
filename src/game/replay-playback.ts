import type { Rpy, RpyStage } from '../formats/rpy';
import type { StageScene } from './stage-scene';

export interface ReplayStageEntry {
  stageIndex: number;
  stage: RpyStage;
  runtimeStageNumber: number;
}

// T7RP has seven physical stage slots (1-6 + Extra). Phantasm reuses the
// seventh slot, but the browser engine's data table calls that authored stage
// 8. The replay difficulty byte is the discriminator used by the executable's
// route selection too.
export function replayStageEntry(rpy: Rpy, stageIndex: number): ReplayStageEntry {
  const stage = rpy.stages[stageIndex];
  if (!stage) throw new Error(`replay stage index ${stageIndex} is not present`);
  return {
    stageIndex,
    stage,
    runtimeStageNumber: rpy.difficulty === 5 && stage.stage === 7 ? 8 : stage.stage
  };
}

// Th07.exe FUN_0042bfca @ all.c:19303 slowdown-reproduction cadence. The
// caller owns the counter and increments it only while no MSG is active.
export function replaySlowdownAdvances(recordedFps: number, counter: number): boolean {
  const fps = recordedFps & 0x7f;
  if (fps < 20) return counter % 3 === 0;
  if (fps < 30) return counter % 2 === 0;
  if (fps < 40) return counter % 3 !== 0;
  if (fps < 50) return counter % 6 !== 0;
  return true;
}

// FUN_0043fda0's manager-code-6 predicates, evaluated after consuming a
// replay frame. A skippable MSG fast-forwards to frame mod 3 == 2; boss-only
// mode additionally fast-forwards non-boss play to frame mod 5 == 4.
export function replayFastForwardContinues(
  mode: number,
  frame: number,
  skippableDialogue: boolean,
  bossActive: boolean
): boolean {
  return (skippableDialogue && frame % 3 !== 2) || (mode === 2 && !bossActive && frame % 5 !== 4);
}

// Apply the exact stage-entry state restored by Th07.exe FUN_00440480. The
// StageScene must already have been constructed with stage.rngSeed so manager
// bootstrap draws happen after the restored seed, exactly like native replay
// playback. Do not write rng.seed again here: doing so would erase those
// bootstrap draws and shift the first gameplay frame.
export function applyReplayStageSnapshot(scene: StageScene, rpy: Rpy, stageIndex: number): void {
  const { stage } = replayStageEntry(rpy, stageIndex);
  const previous = stageIndex > 0 ? rpy.stages[stageIndex - 1] : null;
  scene.score = stage.stage >= 2 && stage.stage <= 6 && previous?.stage === stage.stage - 1
    ? previous.scoreAtEnd
    : 0;
  scene.graze = stage.graze;
  scene.pointItems = stage.pointItems;
  scene.playerObj.lives = stage.lives;
  scene.playerObj.bombs = stage.bombs;
  scene.playerObj.power = stage.power;
  scene.cherry.cherry = stage.cherry;
  scene.cherry.cherryMax = stage.cherryMax;
  scene.cherry.cherryPlus = stage.cherryPlus;
  scene.cherry.spellsCaptured = stage.spellsCaptured;
  scene.extendLevel = stage.extendLevel;
  scene.powerItemCountForScore = stage.powerItemCountForScore;
  // Gui.cpp:1365's stage-6 clear-bonus arm reads stageReplayData[4] — slot
  // [4] is stage 5 (ReplayManager saves stage N to slot N-1).
  scene.replayHasStage5Data = rpy.stages.some((st) => st.stage === 5);
  scene.captureStageEntryTotals();
  if (scene.extendThreshold !== stage.extendThreshold) {
    throw new Error(
      `T7RP stage ${stage.stage} extend threshold ${stage.extendThreshold} ` +
      `does not match level ${stage.extendLevel} (${scene.extendThreshold})`
    );
  }
  scene.rank = stage.rankByte;
  // Config starting-lives from the replay header (run-state +0x1c) — drives
  // the FUN_00429446 Player Penalty on every stage-clear bonus.
  scene.startingLives = rpy.initialLives;
}
