// The MSG interpreter addresses the two stage-local BGM descriptors by slot:
// 0 = stage theme, 1 = boss theme. Th07.exe FUN_00428392 case 7
// (@ 0x4288ae) forwards the MSG argument to the descriptor table at
// stage-config + 0x290 + slot * 0x80; every msg1..msg8 pre-boss entry uses
// slot 1. Physical track numbers follow musiccmt.txt.
export function stageBgmTracks(stageNumber: number): readonly [string, string] {
  const base = stageNumber <= 6 ? stageNumber * 2 : 16 + (stageNumber - 7) * 2;
  const name = (track: number) => `th07_${String(track).padStart(2, '0')}`;
  return [name(base), name(base + 1)];
}

export function stageBgmTrack(stageNumber: number, slot: number): string | null {
  if (slot !== 0 && slot !== 1) return null;
  return stageBgmTracks(stageNumber)[slot];
}
