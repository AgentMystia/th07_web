// Bundle entry for the headless replay harness (scripts/lib/replay-harness.mjs).
// Everything the Node-side runner needs comes from ONE esbuild bundle so all
// pieces share the same module instances (an Anm built here is the same class
// the StageScene bundle sees). Not imported by src/main.ts — ships nothing.
export { StageScene } from '../game/stage-scene';
export type { RunCarry } from '../game/stage-scene';
export { Rpy, RPY_BITS, RPY_CHARACTERS, RPY_AUX_BITS, auxEventFrames, detectAuxAlignment } from '../formats/rpy';
export { ReplayInputSource } from '../core/replay-input';
export {
  applyReplayStageSnapshot,
  replayFastForwardContinues,
  replaySlowdownAdvances,
  replayStageEntry
} from '../game/replay-playback';
export { Anm } from '../formats/anm';
export { TH07_DATA } from '../data/th07-data';
export { stageSnapshot } from '../game/snapshot';
export { DialogueRunner } from '../game/dialogue';
