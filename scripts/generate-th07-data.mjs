// Rebuilds src/data/th07-data.ts from reference/th07-original/ (never committed).
// ANM files are embedded with their THTX texture payloads stripped, because the
// textures ship separately as PNGs in assets/th07-img/ (extracted via thanm -x 7).
// Everything else (ECL/STD/MSG/SHT/thbgm.fmt) is embedded verbatim.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseThbgmFmt } from './split-th07-bgm.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'reference/th07-original');
const outFile = join(root, 'src/data/th07-data.ts');

// TH07 ANM entry header (anm_header06_t, version 2), 64 bytes.
const H = {
  sprites: 0, scripts: 4, w: 12, h: 16, format: 20, colorkey: 24,
  nameoffset: 28, version: 40, memorypriority: 44,
  thtxoffset: 48, hasdata: 52, nextoffset: 56, size: 64
};

// Removes THTX blobs from every entry of an ANM file. Sprite tables, script
// bytecode, and names all precede the THTX payload, so each entry is truncated
// at its thtxoffset and headers are patched (thtxoffset=0, hasdata=0).
function stripAnmTextures(buf, fileName) {
  const parts = [];
  let offset = 0;
  let guard = 0;
  while (true) {
    if (guard++ > 64) throw new Error(`${fileName}: too many entries`);
    const version = buf.readUInt32LE(offset + H.version);
    if (version !== 2) throw new Error(`${fileName}: entry at ${offset} has version ${version}, expected 2`);
    const nextoffset = buf.readUInt32LE(offset + H.nextoffset);
    const hasdata = buf.readUInt16LE(offset + H.hasdata);
    const thtxoffset = buf.readUInt32LE(offset + H.thtxoffset);
    const entryEnd = nextoffset ? offset + nextoffset : buf.length;
    const keepLen = hasdata && thtxoffset ? thtxoffset : entryEnd - offset;
    const nameoffset = buf.readUInt32LE(offset + H.nameoffset);
    if (nameoffset >= keepLen) throw new Error(`${fileName}: name outside kept range`);
    const entry = Buffer.from(buf.subarray(offset, offset + keepLen));
    entry.writeUInt32LE(0, H.thtxoffset);
    entry.writeUInt16LE(0, H.hasdata);
    entry.writeUInt32LE(nextoffset ? keepLen : 0, H.nextoffset);
    parts.push(entry);
    if (!nextoffset) break;
    offset = entryEnd;
  }
  const stripped = Buffer.concat(parts);
  verifyStrippedAnm(stripped, buf, fileName);
  return stripped;
}

// Fidelity guard: the stripped file must contain the same entry/sprite/script
// counts and identical name strings as the original.
function verifyStrippedAnm(stripped, original, fileName) {
  const walk = (b) => {
    const entries = [];
    let o = 0;
    while (true) {
      const name = readCString(b, o + b.readUInt32LE(o + H.nameoffset));
      entries.push({ sprites: b.readUInt32LE(o + H.sprites), scripts: b.readUInt32LE(o + H.scripts), name });
      const next = b.readUInt32LE(o + H.nextoffset);
      if (!next) return entries;
      o += next;
    }
  };
  const a = walk(stripped);
  const b = walk(original);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${fileName}: stripped ANM does not match original metadata`);
  }
}

function readCString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.toString('latin1', offset, end);
}

const b64 = (name) => readFileSync(join(source, name)).toString('base64');
const anm = (name) => stripAnmTextures(readFileSync(join(source, name)), name).toString('base64');

// ANM files needed for stages 1-8 + menus. Keys are used by the runtime to
// resolve entry texture names (data/xxx/yyy.png) to assets/th07-img/yyy.png.
const ANM_FILES = [
  'etama', 'player00', 'player01', 'player02',
  'ascii', 'text', 'title01', 'capture', 'front',
  'face_rm00', 'face_mr00', 'face_sk00',
  'stg1enm', 'stg2enm', 'stg3enm', 'stg4enm', 'stg5enm', 'stg6enm', 'stg7enm', 'stg8enm',
  'stg1bg', 'stg2bg', 'stg3bg', 'stg4bg', 'stg4bg2', 'stg4bg3', 'stg4bg4', 'stg4bg5',
  'stg5bg', 'stg6bg', 'stg7bg', 'stg8bg',
  'eff01', 'eff02', 'eff03', 'eff04', 'eff04b', 'eff05', 'eff06', 'eff07', 'eff08',
  'std1txt', 'std2txt', 'std3txt', 'std4txt', 'std5txt', 'std6txt', 'std7txt', 'std8txt',
  'face_01_00', 'face_02_00', 'face_03_00', 'face_04_00', 'face_05_00', 'face_06_00',
  'face_07_00', 'face_08_00'
];

const SHT_FILES = [
  'ply00a', 'ply00as', 'ply00b', 'ply00bs',
  'ply01a', 'ply01as', 'ply01b', 'ply01bs',
  'ply02a', 'ply02as', 'ply02b', 'ply02bs'
];

const bgmTracks = parseThbgmFmt(readFileSync(join(source, 'thbgm.fmt'))).map((t) => ({
  name: t.name,
  sampleRate: t.sampleRate,
  // 16-bit stereo PCM positions from thbgm.fmt, converted to sample frames.
  loopStartSample: t.loopStartBytes / 4,
  totalSamples: t.lengthBytes / 4
}));

// One entry per stage 1-8 (7 = Extra, 8 = Phantasm). extraBgAnms: stage 4
// swaps between five background ANM banks mid-stage (stg4bg2..5); stage 6's
// second texture lives inside stg6bg.anm itself so needs no extra entry.
const stageEntry = (n, extraBgAnms = []) => ({
  ecl: b64(`ecldata${n}.ecl`),
  std: b64(`stage${n}.std`),
  msg: b64(`msg${n}.dat`),
  enemyAnm: `stg${n}enm`,
  bgAnm: `stg${n}bg`,
  extraBgAnms,
  effectAnm: `eff0${n}`,
  stdTxtAnm: `std${n}txt`,
  faceAnm: `face_0${n}_00`
});

const data = {
  stages: {
    1: stageEntry(1),
    2: stageEntry(2),
    3: stageEntry(3),
    4: stageEntry(4, ['stg4bg2', 'stg4bg3', 'stg4bg4', 'stg4bg5']),
    5: stageEntry(5),
    6: stageEntry(6),
    7: stageEntry(7),
    8: stageEntry(8)
  },
  anm: Object.fromEntries(ANM_FILES.map((n) => [n, anm(`${n}.anm`)])),
  sht: Object.fromEntries(SHT_FILES.map((n) => [n, b64(`${n}.sht`)])),
  bgm: bgmTracks
};

const banner = '// Generated by scripts/generate-th07-data.mjs from reference/th07-original/.\n// Do not edit by hand.\n';
writeFileSync(outFile, `${banner}export const TH07_DATA = ${JSON.stringify(data, null, 1)} as const;\n`);
const kib = (JSON.stringify(data).length / 1024).toFixed(0);
console.log(`wrote src/data/th07-data.ts (~${kib} KiB)`);
