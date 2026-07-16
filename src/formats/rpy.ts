import { BinaryView } from './bin';

// TH07 replay container (.rpy, magic "T7RP"). Load pipeline mirrors
// Th07.exe FUN_004402d0 (all.c:29624): decrypt in place from +0x10 with the
// key byte at +0x0D (b -= key; key += 7), verify the additive checksum
// (0x3F000318 + sum of bytes [0x0D, EOF)) against u32 @+0x08, then
// LZSS-decompress the body at +0x54. Offsets in the two stage tables are
// absolute into the decompressed image (0x54 header + body), fixed up the
// same way FUN_00440480 rebases them at playback start. Field semantics:
// reference/re-specs/exe-replay.md.

const MAGIC = 0x50523754; // "T7RP"
const HEADER_SIZE = 0x54;
const STAGE_SLOTS = 7; // 1-6 + Extra; Phantasm replays use th7_udXXXX slots too
const SUBHEADER_SIZE = 0x2c;
export const MAX_RPY_BYTES = 16 * 1024 * 1024;

// Bits of the per-frame input word (a verbatim copy of DAT_004afe2c made by
// the recording tick FUN_0043fc40; playback injects it at FUN_0043fe30).
// Directions + shoot come from FUN_0042eab0 and menu code; bomb was pinned
// empirically (rare ~10-frame bursts in the demo replays, absent from a
// no-miss run), focus from the dominance of shoot|focus in a Sakuya score
// run, skip from held stretches spanning dialogue sections. The demo files
// also show a stray bit 0x2000 (one short burst each; unidentified, ignored).
export const RPY_BITS = {
  shoot: 0x0001,
  bomb: 0x0002,
  focus: 0x0004,
  up: 0x0010,
  down: 0x0020,
  left: 0x0040,
  right: 0x0080,
  skip: 0x0100
};

// Bits of the per-frame AUX word (the second u16 of each frame record,
// ctx+0x9e). The exe ORs event bits into it as the frame plays out — the
// recording preserves a per-frame EVENT STREAM of the original run, which
// makes it a frame-exact verification oracle. Writers in Th07.exe (all.c
// lines): 0x2 @27780/27914 (player hit registered), 0x4 @28596 (bomb),
// 0x8 @28928 (border start, FUN_0043e890 region), 0x10 @28994 (border
// break/end), 0x20 @13887/14351/14360 (enemy kill, incl. sweeps),
// 0x40 @22016 (item collected), 0x1 @28486 (border-adjacent, PROBABLE),
// 0x100 @29442 (DAT_00625620, a latched flag consumed each tick at
// scheduler prio 6; observed as sparse single-tick pulses — 1-3 per stage in
// the fixture, absent from most files — NOT a dialogue window; setter not
// visible in the decompile, unidentified).
export const RPY_AUX_BITS = {
  playerHit: 0x0002,
  bomb: 0x0004,
  borderStart: 0x0008,
  borderEnd: 0x0010,
  enemyKill: 0x0020,
  itemCollect: 0x0040
};

// Engine frames in a stage's aux stream where the given event bit is set.
//
// `auxOffset` is the recording environment's aux-column alignment: the aux
// word at record index i describes engine tick `i - auxOffset`. Two
// conventions exist in real files (evidence: native Wine+gdb playback traces
// of the SAME patched Th07.exe v1.00b, 2026-07-16):
//
//   offset 1 ("recorder-lagged", the shipped v1.00b loop): the recorder tick
//     (FUN_0043fc40, scheduler priority 16) advances its pointer then writes
//     {input, aux}, while the aux word is cleared at priority 6
//     (FUN_0043fbd0) and event bits are OR'd during world-sim (prio 7-0xf) —
//     record tick t lands in slot t+1, and the input latched at prio 16
//     drives the NEXT tick, so input[i] drives tick i but aux[i] holds tick
//     i-1's events. th7_udYo01: first kill completes during native tick 600
//     (/tmp/yo-kill-native2.log) with the kill bit at record index 601.
//   offset 0 ("recorder-synchronous"): files recorded under a loop with no
//     input latch delay (vpatch-style limiters used by scoreplayers) carry
//     aux[i] describing tick i. th7_udFe25 (golden fixture): first kill
//     completes during native tick 610 (/tmp/fe25-spawn.log, hp 2->0 across
//     frame-BP labels 610->611) with the kill bit at record index 610.
//
// The header carries no marker for this (all known files stamp version
// 0x1100); use detectAuxAlignment() to infer it per stage.
export function auxEventFrames(stage: RpyStage, bit: number, auxOffset = 0): number[] {
  const out: number[] = [];
  // Frame 0's aux word can hold uninitialized heap garbage (0xCDCD in the
  // shipped demo replays) — the context struct is cleared on the first
  // stage tick, not at allocation.
  for (let f = 1; f < stage.auxFlags.length; f++) {
    if (stage.auxFlags[f] & bit) out.push(f - auxOffset);
  }
  return out;
}

// Infers a stage's aux-column alignment (see auxEventFrames) by scoring the
// two candidate offsets against the simulation's own event streams and
// keeping the one with the longer exact leading agreement, summed across
// streams. This is metadata inference, not tolerance: the chosen offset must
// be a single whole-stage constant, the alternative loses by construction on
// any healthy stream (hundreds of events), and a genuine engine-timing
// regression cannot hide in it — a global 1-frame shift would flip the
// detected offset of the committed golden fixture, which the test gate pins
// to 0 (tests/th07-rpy-aux-alignment.test.mjs). Throws when the vote is not
// decisive rather than guessing.
export function detectAuxAlignment(
  stage: RpyStage,
  ourEvents: ReadonlyArray<{ bit: number; frames: ReadonlyArray<number> }>
): { offset: 0 | 1; prefixByOffset: [number, number] } {
  const prefixFor = (offset: 0 | 1): number => {
    let total = 0;
    for (const { bit, frames } of ourEvents) {
      const oracle = auxEventFrames(stage, bit, offset);
      const n = Math.min(oracle.length, frames.length);
      let p = 0;
      while (p < n && oracle[p] === frames[p]) p++;
      total += p;
    }
    return total;
  };
  const prefixByOffset: [number, number] = [prefixFor(0), prefixFor(1)];
  if (prefixByOffset[0] === prefixByOffset[1]) {
    throw new Error(
      `T7RP stage ${stage.stage} aux alignment is ambiguous ` +
        `(exact-prefix score ${prefixByOffset[0]} at both offsets)`
    );
  }
  return { offset: prefixByOffset[0] > prefixByOffset[1] ? 0 : 1, prefixByOffset };
}

export interface RpyStage {
  stage: number; // 1-based table index: 1..6 = stages, 7 = Extra
  offset: number; // absolute offset of the 0x2C sub-header in the image
  // Stage-entry snapshot (+ scoreAtEnd). rngSeed (+0x20) is what
  // FUN_00440480 (all.c:29748) injects into the live RNG (DAT_00495e00) at
  // playback start. The cherry triple was pinned by cross-checking the
  // recorded values against INITIAL_CHERRY_MAX_BY_DIFFICULTY (Lunatic
  // 300000 == stage-1 cherryMax) and the CHERRY_PLUS_MAX=50000 cap the exe
  // enforces on the +0x10 slot; the extend pair matches the point-item
  // ladder (50/125/200/300/450/800+200n) exactly across all six stages of
  // the fixture run.
  scoreAtEnd: number; // +0x00 u32 — score at this stage's END (exe reads the
  // previous block's value for mid-run starts); the last stage's equals the
  // file's global score.
  pointItems: number; // +0x04 u32
  cherry: number; // +0x08 u32
  cherryMax: number; // +0x0C u32
  cherryPlus: number; // +0x10 u32 (≤ 50000)
  graze: number; // +0x14 u32
  extendLevel: number; // +0x18 u32
  extendThreshold: number; // +0x1C u32 — next point-item extend target
  rngSeed: number; // +0x20 u16
  power: number; // +0x22 u8
  lives: number; // +0x23 u8
  bombs: number; // +0x24 u8
  rankByte: number; // +0x25 u8 = DAT_00625884 (16 at run start, climbs; the
  // port's rank model is under review against this evidence)
  powerItemCountForScore: number; // +0x26 u8 — GameManager
  // powerItemCountForScore (ReplayManager.hpp:28), the full-power P-item
  // score-ladder index. 0 in a no-miss run: at full power power drops spawn
  // as cherry items, so the ladder only advances on the rare post-crossing
  // pickup of a pre-conversion power item (or after a miss rebuild).
  spellsCaptured: number; // +0x27 u8 (provisional — trajectory 0/3/7/12/16/21
  // over a Lunatic clear fits captures)
  inputs: Uint16Array; // per-frame input word (first u16 of each 4-byte record)
  auxFlags: Uint16Array; // second u16 (ctx+0x9e; opaque, usually 0)
  // One playback-observed-FPS byte per 30 input frames from the matching
  // +0x38 table block. The raw trailer has one leading recorder byte; native
  // playback reads pointer+1 before advancing, so this array intentionally
  // exposes raw[1..ceil(frames/30)]. Bit 7 is the slowdown marker and the low
  // 7 bits are FPS.
  slowdown: Uint8Array;
}

export const RPY_CHARACTERS = ['reimuA', 'reimuB', 'marisaA', 'marisaB', 'sakuyaA', 'sakuyaB'] as const;

export class Rpy {
  readonly version: number;
  readonly shotByte: number; // character*2 + subtype == StageScene.shotIndex
  readonly difficulty: number; // 0=Easy .. 3=Lunatic, 4=Extra, 5=Phantasm
  readonly date: string; // "MM/DD"
  readonly name: string;
  readonly score: number; // raw internal units; displayed value is ×10
  // Config starting-lives at record time (global header +0x38, the 8th int of
  // the 14-int run-state block FUN_00440480 restores to DAT_0061c254 at
  // playback start; low byte 2-5). Drives the results-screen "Player
  // Penalty" clear-bonus scaling (FUN_00429446: 3 -> x5/10, 4 -> x2/10) and
  // matches the first stage sub-header's lives field in every known file.
  readonly initialLives: number;
  readonly stages: RpyStage[] = [];
  readonly image: BinaryView; // decrypted+decompressed full image (debugging)

  constructor(source: string | Uint8Array) {
    const raw = new BinaryView(source);
    if (raw.length > MAX_RPY_BYTES) throw new Error('T7RP file exceeds 16 MiB safety limit');
    if (raw.length < HEADER_SIZE || raw.u32(0) !== MAGIC) throw new Error('not a T7RP replay');
    this.version = raw.u16(4);
    if ((this.version & 0xfff) !== 0x100) throw new Error(`unsupported T7RP version 0x${this.version.toString(16)}`);

    const data = raw.bytes.slice();
    let key = data[0x0d];
    for (let i = 0x10; i < data.length; i++) {
      data[i] = (data[i] - key) & 0xff;
      key = (key + 7) & 0xff;
    }
    let sum = 0x3f000318;
    for (let i = 0x0d; i < data.length; i++) sum = (sum + data[i]) >>> 0;
    if (sum !== raw.u32(8)) throw new Error('T7RP checksum mismatch');

    const dec = new BinaryView(data);
    const compSize = dec.u32(0x14);
    const decompSize = dec.u32(0x18);
    if (decompSize > MAX_RPY_BYTES) throw new Error('T7RP decompressed body exceeds 16 MiB safety limit');
    if (HEADER_SIZE + compSize > data.length) throw new Error('T7RP truncated body');
    const image = new Uint8Array(HEADER_SIZE + decompSize);
    image.set(data.subarray(0, HEADER_SIZE));
    lzssDecompress(data.subarray(HEADER_SIZE, HEADER_SIZE + compSize), image.subarray(HEADER_SIZE));
    const v = new BinaryView(image);
    this.image = v;

    this.shotByte = v.u8(HEADER_SIZE + 0x02);
    this.difficulty = v.u8(HEADER_SIZE + 0x03);
    if (this.difficulty > 5) throw new Error(`T7RP difficulty ${this.difficulty} is out of range`);
    this.date = v.cstring(HEADER_SIZE + 0x04);
    this.name = v.cstring(HEADER_SIZE + 0x0a).trim();
    this.score = v.u32(HEADER_SIZE + 0x18);
    this.initialLives = v.u8(HEADER_SIZE + 0x38);

    const inputOffsets: number[] = [];
    const trailerOffsets: number[] = [];
    for (let i = 0; i < STAGE_SLOTS; i++) {
      inputOffsets.push(v.u32(0x1c + i * 4));
      trailerOffsets.push(v.u32(0x38 + i * 4));
    }
    // Stage input blocks are laid out contiguously; each frame stream runs to
    // the next present block. The last one ends where the per-stage slowdown
    // trailers begin (the smallest +0x38-table offset).
    const trailerStart = Math.min(...trailerOffsets.filter((o) => o > 0), v.length);
    const present = inputOffsets
      .map((offset, i) => ({ offset, stage: i + 1 }))
      .filter((s) => s.offset > 0)
      .sort((a, b) => a.offset - b.offset);
    for (let i = 0; i < present.length; i++) {
      const { offset, stage } = present[i];
      const end = i + 1 < present.length ? present[i + 1].offset : trailerStart;
      this.stages.push(parseStage(v, stage, offset, end));
    }
    this.stages.sort((a, b) => a.stage - b.stage);
    for (const stage of this.stages) {
      const offset = trailerOffsets[stage.stage - 1];
      const length = Math.ceil(stage.inputs.length / 30);
      if (offset <= 0 || offset + 1 + length > v.length) {
        throw new Error(`T7RP stage ${stage.stage} slowdown trailer out of bounds`);
      }
      stage.slowdown = v.bytes.slice(offset + 1, offset + 1 + length);
    }
  }

  get character(): (typeof RPY_CHARACTERS)[number] {
    const c = RPY_CHARACTERS[this.shotByte];
    if (!c) throw new Error(`T7RP shot byte ${this.shotByte} out of range`);
    return c;
  }
}

function parseStage(v: BinaryView, stage: number, offset: number, end: number): RpyStage {
  if (offset + SUBHEADER_SIZE > end || end > v.length) {
    throw new Error(`T7RP stage ${stage} block out of bounds (${offset}..${end})`);
  }
  const frames = Math.floor((end - offset - SUBHEADER_SIZE) / 4);
  const inputs = new Uint16Array(frames);
  const auxFlags = new Uint16Array(frames);
  for (let f = 0; f < frames; f++) {
    inputs[f] = v.u16(offset + SUBHEADER_SIZE + f * 4);
    auxFlags[f] = v.u16(offset + SUBHEADER_SIZE + f * 4 + 2);
  }
  return {
    stage,
    offset,
    scoreAtEnd: v.u32(offset),
    pointItems: v.u32(offset + 0x04),
    cherry: v.u32(offset + 0x08),
    cherryMax: v.u32(offset + 0x0c),
    cherryPlus: v.u32(offset + 0x10),
    graze: v.u32(offset + 0x14),
    extendLevel: v.u32(offset + 0x18),
    extendThreshold: v.u32(offset + 0x1c),
    rngSeed: v.u16(offset + 0x20),
    power: v.u8(offset + 0x22),
    lives: v.u8(offset + 0x23),
    bombs: v.u8(offset + 0x24),
    rankByte: v.u8(offset + 0x25),
    powerItemCountForScore: v.u8(offset + 0x26),
    spellsCaptured: v.u8(offset + 0x27),
    inputs,
    auxFlags,
    slowdown: new Uint8Array(0)
  };
}

// The TH06-era bitstream LZSS ZUN reuses across pak-family formats
// (Th07.exe FUN_00454e50, all.c:42203): 0x2000-byte zero-initialized window
// with the write cursor starting at 1, MSB-first bits, control bit 1 =
// literal (8 bits), 0 = match (13-bit absolute window position, 0 terminates;
// 4-bit length-3). Matches copy from the absolute position wrapping &0x1FFF,
// and everything emitted is also written back into the window.
export function lzssDecompress(src: Uint8Array, dst: Uint8Array): number {
  const win = new Uint8Array(0x2000);
  let wpos = 1;
  let acc = 0;
  let accBits = 0;
  let sp = 0;
  let dp = 0;
  const bits = (n: number): number => {
    while (accBits < n) {
      acc = (acc << 8) | (sp < src.length ? src[sp++] : 0);
      accBits += 8;
    }
    accBits -= n;
    const out = (acc >>> accBits) & ((1 << n) - 1);
    acc &= (1 << accBits) - 1;
    return out;
  };
  while (dp < dst.length) {
    if (bits(1)) {
      const b = bits(8);
      dst[dp++] = b;
      win[wpos] = b;
      wpos = (wpos + 1) & 0x1fff;
    } else {
      const pos = bits(13);
      if (pos === 0) break;
      const len = bits(4) + 3;
      for (let i = 0; i < len && dp < dst.length; i++) {
        const b = win[(pos + i) & 0x1fff];
        dst[dp++] = b;
        win[wpos] = b;
        wpos = (wpos + 1) & 0x1fff;
      }
    }
  }
  return dp;
}
