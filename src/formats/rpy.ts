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
  b26: number; // +0x26 u8 — unidentified (0 in a no-miss run; likely misses)
  spellsCaptured: number; // +0x27 u8 (provisional — trajectory 0/3/7/12/16/21
  // over a Lunatic clear fits captures)
  inputs: Uint16Array; // per-frame input word (first u16 of each 4-byte record)
  auxFlags: Uint16Array; // second u16 (ctx+0x9e; opaque, usually 0)
}

export const RPY_CHARACTERS = ['reimuA', 'reimuB', 'marisaA', 'marisaB', 'sakuyaA', 'sakuyaB'] as const;

export class Rpy {
  readonly version: number;
  readonly shotByte: number; // character*2 + subtype == StageScene.shotIndex
  readonly difficulty: number; // 0=Easy .. 3=Lunatic, 4=Extra
  readonly date: string; // "MM/DD"
  readonly name: string;
  readonly score: number; // raw internal units; displayed value is ×10
  readonly stages: RpyStage[] = [];
  readonly image: BinaryView; // decrypted+decompressed full image (debugging)

  constructor(source: string | Uint8Array) {
    const raw = new BinaryView(source);
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
    if (HEADER_SIZE + compSize > data.length) throw new Error('T7RP truncated body');
    const image = new Uint8Array(HEADER_SIZE + decompSize);
    image.set(data.subarray(0, HEADER_SIZE));
    lzssDecompress(data.subarray(HEADER_SIZE, HEADER_SIZE + compSize), image.subarray(HEADER_SIZE));
    const v = new BinaryView(image);
    this.image = v;

    this.shotByte = v.u8(HEADER_SIZE + 0x02);
    this.difficulty = v.u8(HEADER_SIZE + 0x03);
    this.date = v.cstring(HEADER_SIZE + 0x04);
    this.name = v.cstring(HEADER_SIZE + 0x0a).trim();
    this.score = v.u32(HEADER_SIZE + 0x18);

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
    b26: v.u8(offset + 0x26),
    spellsCaptured: v.u8(offset + 0x27),
    inputs,
    auxFlags
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
