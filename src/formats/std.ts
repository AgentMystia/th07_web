import { BinaryView } from './bin';
import { clamp, DEG, lerp } from '../core/util';

// TH07 STD stage-background format. Same layout family as TH06:
// header {u16 objectCount, u16 faceCount, u32 faceOffset, u32 scriptOffset,
// u32 zero} + stageName[128] + 4×songName[128] + 4×songPath[128], then the
// object offset table at 0x490, a FACE (instance) array
// {u16 objectId, u16 unknown, f32 x, f32 y, f32 z}, then a fixed-width (20
// byte) script: {i32 frame, i16 op, i16 unused, f32 arg0, f32 arg1, f32 arg2}.
//
// Base op numbers were cross-checked with stage1.std; TH07's advanced ops
// are recovered from Th07.exe FUN_004046f0 @ 0x4046f0:
//   ins_0(0,0,0)               no-op (also used as a padding/terminator entry)
//   ins_1(argb, near, far)     fog keyframe (near/far are fog distances)
//   ins_2(duration, 0, 0)      fog interpolation duration (always linear)
//   ins_3                       pause at the current instruction
//   ins_4(index, frame, 0)     jump to instruction index + raw integer clock
//   ins_5(x, y, z)             camera position keyframe (x is likewise a
//                              float stored in an int-tagged slot; e.g.
//                              -1018691584 raw-decodes to -200.0)
//   ins_6(duration, mode, 0)   interpolate camera position to the *next*
//                              ins_5 over `duration` frames, easing `mode`
//   ins_7(x, y, z)             camera facing: a camera-relative look
//                              direction vector (not an absolute point)
//   ins_8(duration, mode)      interpolate facing to the next ins_7
//   ins_9/10                    LookAt up-vector keyframe/interpolation
//   ins_11(fovRadians, 0, 0)   vertical field of view
//   ins_12(duration, mode)      FOV interpolation
//   ins_14..18                  camera P0/P1/m0/m1/Hermite duration
//   ins_19..23                  facing P0/P1/m0/m1/Hermite duration
//   ins_24..28                  up-vector P0/P1/m0/m1/Hermite duration
//   ins_29/30(script)           primary/secondary standalone ANM VM
//   ins_31(label)               resume label for ins_3
// World axes throughout: x = lateral, y = forward depth, z = height with
// *negative* z up (camera z ≈ -400 sits ~400 units above the ground at -12).

export interface StdQuad {
  type: number;
  script: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
}

export interface StdObject {
  id: number;
  zLevel: number;
  flags: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  quads: StdQuad[];
}

// FACE/instance byte layout, cross-checked against thstd's std_object_instance_t
// (uint16 object_id, uint16 unknown1, float x, float y, float z) and its dump
// code (`fprintf("FACE: %i %g %g %g", unknown1, x, y, z)`, object_id itself
// coming from the enclosing ENTRY grouping, not printed per-line): our object
// id + x/y/z reads line up 1:1 with that struct; only the unused `unknown1`
// column (always 256 in stage1.std) is skipped.
export interface StdInstance {
  id: number;
  x: number;
  y: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface FogState {
  r: number;
  g: number;
  b: number;
  near: number;
  far: number;
}

interface StdInstruction {
  frame: number;
  op: number;
  f0: number;
  f1: number;
  f2: number;
  i0: number;
  i1: number;
  i2: number;
}

interface VecTrack {
  current: Vec3;
  p0: Vec3;
  p1: Vec3;
  m0: Vec3;
  m1: Vec3;
  duration: number;
  elapsed: number;
  mode: number;
}

interface ScalarTrack {
  current: number;
  p0: number;
  p1: number;
  duration: number;
  elapsed: number;
  mode: number;
}

export interface StdSpecialAnmState {
  script: number;
  age: number;
}

function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

function cloneVec(v: Vec3): Vec3 {
  return vec(v.x, v.y, v.z);
}

function makeVecTrack(initial: Vec3): VecTrack {
  return {
    current: cloneVec(initial),
    p0: cloneVec(initial),
    p1: cloneVec(initial),
    m0: vec(0, 0, 0),
    m1: vec(0, 0, 0),
    duration: 0,
    elapsed: 0,
    mode: 0
  };
}

function makeScalarTrack(initial: number): ScalarTrack {
  return { current: initial, p0: initial, p1: initial, duration: 0, elapsed: 0, mode: 0 };
}

// FUN_004043d0 uses the inverse numbering of ANM's formula table.
export function applyStdFormula(t: number, mode: number): number {
  switch (mode) {
    case 1: return 1 - (1 - t) ** 2;
    case 2: return 1 - (1 - t) ** 3;
    case 3: return 1 - (1 - t) ** 4;
    case 4: return t * t;
    case 5: return t * t * t;
    case 6: return t * t * t * t;
    default: return t;
  }
}

// Camera position + orientation basis for one frame, precomputed once so
// project() can be called many times per frame with only dot products.
export interface CameraFrame {
  x: number;
  y: number;
  z: number;
  rightX: number; rightY: number; rightZ: number;
  upX: number; upY: number; upZ: number;
  fwdX: number; fwdY: number; fwdZ: number;
  fov: number;
}

const OBJECT_TABLE_OFFSET = 0x490;

export class Std {
  readonly view: BinaryView;
  readonly stageName: string;
  readonly songNames: string[] = [];
  readonly songPaths: string[] = [];
  readonly objects: StdObject[] = [];
  readonly instances: StdInstance[] = [];
  private instructions: StdInstruction[] = [];
  private labels = new Map<number, number>();
  private scriptIndex = 0;
  private pausedAt = -1;
  private pendingResume = 0;
  private cameraTrack = makeVecTrack(vec(0, 0, 0));
  private facingTrack = makeVecTrack(vec(0, 1, 0));
  private upTrack = makeVecTrack(vec(0, 1, 0));
  private fovTrack = makeScalarTrack(30 * DEG);
  private fogCurrent: FogState = { r: 16, g: 0, b: 32, near: 200, far: 500 };
  private fogStart: FogState = { ...this.fogCurrent };
  private fogTarget: FogState = { ...this.fogCurrent };
  private fogDuration = 0;
  private fogElapsed = 0;
  frame = 0;
  // Unlike the script clock, object/special ANM VMs tick through op3 pauses
  // and never rewind at op4 jumps (FUN_004046f0 tail / FUN_00406850).
  animationFrame = 0;
  primaryAnm: StdSpecialAnmState | null = null;
  secondaryAnm: StdSpecialAnmState | null = null;

  constructor(source: string | Uint8Array) {
    this.view = new BinaryView(source);
    this.stageName = this.view.shiftJis(16, this.cstrEnd(16, 128));
    for (let i = 0; i < 4; i++) {
      const nameOff = 16 + 128 + i * 128;
      const pathOff = 16 + 128 + 4 * 128 + i * 128;
      this.songNames.push(this.view.shiftJis(nameOff, this.cstrEnd(nameOff, 128)));
      this.songPaths.push(this.view.shiftJis(pathOff, this.cstrEnd(pathOff, 128)));
    }
    this.parse();
    this.reset();
  }

  private cstrEnd(off: number, max: number): number {
    let end = off;
    while (end < off + max && end < this.view.length && this.view.bytes[end] !== 0) end++;
    return end;
  }

  private parse(): void {
    const v = this.view;
    const objectCount = v.i16(0);
    const faceOffset = v.i32(4);
    const scriptOffset = v.i32(8);
    for (let i = 0; i < objectCount; i++) {
      this.objects.push(this.parseObject(v.i32(OBJECT_TABLE_OFFSET + i * 4)));
    }
    for (let off = faceOffset, guard = 0; off + 16 <= v.length && guard < 4096; off += 16, guard++) {
      const id = v.i16(off);
      if (id < 0) break;
      this.instances.push({ id, x: v.f32(off + 4), y: v.f32(off + 8), z: v.f32(off + 12) });
    }

    for (let off = scriptOffset, guard = 0; off + 20 <= v.length && guard < 512; off += 20, guard++) {
      const rawFrame = v.i32(off);
      const op = v.i16(off + 4);
      if (rawFrame === -1 && op === -1) break;
      const frame = Math.max(0, rawFrame);
      // Every arg slot is 4 raw bytes; which reinterpretation (int vs float)
      // is correct depends on the op (see the format table in the header
      // comment) — e.g. ins_5's x is format-tagged as an int but is really a
      // float's bit pattern (confirmed: -1018691584 raw-decodes to -200.0).
      const x = v.f32(off + 8);
      const y = v.f32(off + 12);
      const z = v.f32(off + 16);
      const i0 = v.i32(off + 8);
      const i1 = v.i32(off + 12);
      const ins = { frame, op, f0: x, f1: y, f2: z, i0, i1, i2: v.i32(off + 16) };
      this.instructions.push(ins);
      if (op === 31 && !this.labels.has(i0)) this.labels.set(i0, this.instructions.length - 1);
    }
  }

  private parseObject(off: number): StdObject {
    const v = this.view;
    const obj: StdObject = {
      id: v.i16(off),
      zLevel: v.i8(off + 2),
      flags: v.i8(off + 3),
      x: v.f32(off + 4),
      y: v.f32(off + 8),
      z: v.f32(off + 12),
      w: v.f32(off + 16),
      h: v.f32(off + 20),
      d: v.f32(off + 24),
      quads: []
    };
    let q = off + 28;
    for (let guard = 0; q + 28 <= v.length && guard < 256; guard++) {
      const type = v.i16(q);
      if (type < 0) break;
      const size = v.i16(q + 2);
      obj.quads.push({
        type,
        script: v.i16(q + 4),
        x: v.f32(q + 8),
        y: v.f32(q + 12),
        z: v.f32(q + 16),
        w: v.f32(q + 20),
        h: v.f32(q + 24)
      });
      if (size <= 0) break;
      q += size;
    }
    return obj;
  }

  reset(): void {
    this.frame = 0;
    this.animationFrame = 0;
    this.scriptIndex = 0;
    this.pausedAt = -1;
    this.pendingResume = 0;
    this.cameraTrack = makeVecTrack(vec(0, 0, 0));
    this.facingTrack = makeVecTrack(vec(0, 1, 0));
    this.upTrack = makeVecTrack(vec(0, 1, 0));
    this.fovTrack = makeScalarTrack(30 * DEG);
    this.fogCurrent = { r: 16, g: 0, b: 32, near: 200, far: 500 };
    this.fogStart = { ...this.fogCurrent };
    this.fogTarget = { ...this.fogCurrent };
    this.fogDuration = 0;
    this.fogElapsed = 0;
    this.primaryAnm = null;
    this.secondaryAnm = null;
  }

  get paused(): boolean {
    return this.pausedAt >= 0;
  }

  get fov(): number {
    return this.fovTrack.current;
  }

  // Th07.exe FUN_004046f0 @ 0x404719-0x4047e7 searches op31's argument,
  // then resumes immediately after that label at the label's script time.
  requestResume(label: number): void {
    if (label > 0) this.pendingResume = label;
  }

  // Script time may pause or jump. Object and special-ANM time is monotonic,
  // and all interpolation tracks continue through op3 pauses.
  advance(): void {
    this.animationFrame++;
    if (this.primaryAnm) this.primaryAnm.age++;
    if (this.secondaryAnm) this.secondaryAnm.age++;

    if (this.pendingResume > 0) {
      const labelIndex = this.labels.get(this.pendingResume);
      this.pendingResume = 0;
      if (labelIndex != null) {
        this.scriptIndex = labelIndex + 1;
        this.frame = this.instructions[labelIndex].frame;
        this.pausedAt = -1;
      }
    }

    if (!this.paused) this.dispatchDueInstructions();
    this.tickTracks();
    if (!this.paused) this.frame++;
  }

  private dispatchDueInstructions(): void {
    for (let guard = 0; guard < 1024; guard++) {
      const ins = this.instructions[this.scriptIndex];
      if (!ins || ins.frame > this.frame) return;
      if (ins.op === 3) {
        this.pausedAt = this.scriptIndex;
        return;
      }
      if (ins.op === 4) {
        // op4's first argument is the destination instruction index; its
        // second is the destination script clock (FUN_004046f0 @ 0x4057fb).
        this.scriptIndex = Math.max(0, ins.i0);
        this.frame = Math.max(0, ins.i1);
        this.cameraTrack.duration = 0;
        continue;
      }
      this.executeInstruction(ins);
      this.scriptIndex++;
    }
    throw new Error('STD instruction dispatch guard exhausted');
  }

  private executeInstruction(ins: StdInstruction): void {
    const value = vec(ins.f0, ins.f1, ins.f2);
    switch (ins.op) {
      case 1: {
        const color = ins.i0 >>> 0;
        this.fogTarget = {
          r: (color >> 16) & 0xff,
          g: (color >> 8) & 0xff,
          b: color & 0xff,
          near: ins.f1,
          far: ins.f2
        };
        if (this.fogDuration === 0) this.fogCurrent = { ...this.fogTarget };
        return;
      }
      case 2:
        this.fogStart = { ...this.fogCurrent };
        this.fogDuration = Math.max(0, ins.i0);
        this.fogElapsed = 0;
        return;
      case 5: this.setVecKeyframe(this.cameraTrack, value); return;
      case 6: this.setVecDuration(this.cameraTrack, ins.i0, ins.i1); return;
      case 7: this.setVecKeyframe(this.facingTrack, value); return;
      case 8: this.setVecDuration(this.facingTrack, ins.i0, ins.i1); return;
      case 9: this.setVecKeyframe(this.upTrack, value); return;
      case 10: this.setVecDuration(this.upTrack, ins.i0, ins.i1); return;
      case 11: this.setScalarKeyframe(this.fovTrack, ins.f0); return;
      case 12: this.setScalarDuration(this.fovTrack, ins.i0, ins.i1); return;
      case 14: this.cameraTrack.p0 = value; return;
      case 15: this.cameraTrack.p1 = value; return;
      case 16: this.cameraTrack.m0 = value; return;
      case 17: this.cameraTrack.m1 = value; return;
      case 18: this.setVecDuration(this.cameraTrack, ins.i0, 7); return;
      case 19: this.facingTrack.p0 = value; return;
      case 20: this.facingTrack.p1 = value; return;
      case 21: this.facingTrack.m0 = value; return;
      case 22: this.facingTrack.m1 = value; return;
      case 23: this.setVecDuration(this.facingTrack, ins.i0, 7); return;
      case 24: this.upTrack.p0 = value; return;
      case 25: this.upTrack.p1 = value; return;
      case 26: this.upTrack.m0 = value; return;
      case 27: this.upTrack.m1 = value; return;
      case 28: this.setVecDuration(this.upTrack, ins.i0, 7); return;
      case 29: this.primaryAnm = ins.i0 < 0 ? null : { script: ins.i0, age: 0 }; return;
      case 30: this.secondaryAnm = ins.i0 < 0 ? null : { script: ins.i0, age: 0 }; return;
      default: return;
    }
  }

  private setVecKeyframe(track: VecTrack, target: Vec3): void {
    track.p0 = cloneVec(track.p1);
    track.p1 = target;
    if (track.duration === 0) track.current = cloneVec(target);
  }

  private setVecDuration(track: VecTrack, duration: number, mode: number): void {
    track.duration = Math.max(0, duration);
    track.elapsed = 0;
    track.mode = mode;
    if (track.duration === 0) track.current = cloneVec(track.p1);
  }

  private setScalarKeyframe(track: ScalarTrack, target: number): void {
    track.p0 = track.p1;
    track.p1 = target;
    if (track.duration === 0) track.current = target;
  }

  private setScalarDuration(track: ScalarTrack, duration: number, mode: number): void {
    track.duration = Math.max(0, duration);
    track.elapsed = 0;
    track.mode = mode;
    if (track.duration === 0) track.current = track.p1;
  }

  private static hermite(p0: number, p1: number, m0: number, m1: number, t: number): number {
    const oneMinus = 1 - t;
    const h00 = (1 + 2 * t) * oneMinus * oneMinus;
    const h10 = t * oneMinus * oneMinus;
    const h01 = t * t * (3 - 2 * t);
    const h11 = t * t * (t - 1);
    return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
  }

  private tickVec(track: VecTrack): void {
    if (track.duration <= 0) return;
    track.elapsed = Math.min(track.duration, track.elapsed + 1);
    const t0 = clamp(track.elapsed / track.duration, 0, 1);
    if (track.mode === 7) {
      track.current = {
        x: Std.hermite(track.p0.x, track.p1.x, track.m0.x, track.m1.x, t0),
        y: Std.hermite(track.p0.y, track.p1.y, track.m0.y, track.m1.y, t0),
        z: Std.hermite(track.p0.z, track.p1.z, track.m0.z, track.m1.z, t0)
      };
    } else {
      const t = applyStdFormula(t0, track.mode);
      track.current = {
        x: lerp(track.p0.x, track.p1.x, t),
        y: lerp(track.p0.y, track.p1.y, t),
        z: lerp(track.p0.z, track.p1.z, t)
      };
    }
    if (track.elapsed >= track.duration) track.duration = 0;
  }

  private tickScalar(track: ScalarTrack): void {
    if (track.duration <= 0) return;
    track.elapsed = Math.min(track.duration, track.elapsed + 1);
    const t = applyStdFormula(clamp(track.elapsed / track.duration, 0, 1), track.mode);
    track.current = lerp(track.p0, track.p1, t);
    if (track.elapsed >= track.duration) track.duration = 0;
  }

  private tickTracks(): void {
    this.tickVec(this.cameraTrack);
    this.tickVec(this.facingTrack);
    this.tickVec(this.upTrack);
    this.tickScalar(this.fovTrack);
    if (this.fogDuration > 0) {
      this.fogElapsed = Math.min(this.fogDuration, this.fogElapsed + 1);
      const t = clamp(this.fogElapsed / this.fogDuration, 0, 1);
      this.fogCurrent = {
        r: lerp(this.fogStart.r, this.fogTarget.r, t),
        g: lerp(this.fogStart.g, this.fogTarget.g, t),
        b: lerp(this.fogStart.b, this.fogTarget.b, t),
        near: lerp(this.fogStart.near, this.fogTarget.near, t),
        far: lerp(this.fogStart.far, this.fogTarget.far, t)
      };
      if (this.fogElapsed >= this.fogDuration) this.fogDuration = 0;
    }
  }

  camera(_frame = this.frame): Vec3 {
    return cloneVec(this.cameraTrack.current);
  }

  facing(_frame = this.frame): Vec3 {
    return cloneVec(this.facingTrack.current);
  }

  upHint(_frame = this.frame): Vec3 {
    return cloneVec(this.upTrack.current);
  }

  fog(_frame = this.frame): { r: number; g: number; b: number; near: number; far: number; css: string } {
    const r = Math.round(this.fogCurrent.r);
    const g = Math.round(this.fogCurrent.g);
    const b = Math.round(this.fogCurrent.b);
    return { r, g, b, near: this.fogCurrent.near, far: this.fogCurrent.far, css: `rgb(${r}, ${g}, ${b})` };
  }

  // FUN_00407310 @ 0x40736d passes authored +0x5210 directly as D3DX
  // LookAt's up argument. Keep the raw STD axes: right = upHint x forward,
  // then screen-up = forward x right. This is Stage 4's roll/flip track.
  cameraFrame(frame: number): CameraFrame {
    const pos = this.camera(frame);
    const face = this.facing(frame);
    const upHint = this.upHint(frame);
    const flen = Math.hypot(face.x, face.y, face.z) || 1;
    const fx = face.x / flen;
    const fy = face.y / flen;
    const fz = face.z / flen;
    let rx = upHint.y * fz - upHint.z * fy;
    let ry = upHint.z * fx - upHint.x * fz;
    let rz = upHint.x * fy - upHint.y * fx;
    let rlen = Math.hypot(rx, ry, rz);
    if (rlen < 1e-6) {
      // Defensive only: the original Stage 1-8 authored vectors are valid.
      rx = fy; ry = -fx; rz = 0;
      rlen = Math.hypot(rx, ry, rz);
      if (rlen < 1e-6) { rx = 1; ry = 0; rz = 0; rlen = 1; }
    }
    rx /= rlen; ry /= rlen; rz /= rlen;
    // up = forward × right completes the right-handed basis.
    const ux = fy * rz - fz * ry;
    const uy = fz * rx - fx * rz;
    const uz = fx * ry - fy * rx;
    return {
      x: pos.x, y: pos.y, z: pos.z,
      rightX: rx, rightY: ry, rightZ: rz,
      upX: ux, upY: uy, upZ: uz,
      fwdX: fx, fwdY: fy, fwdZ: fz,
      fov: this.fov
    };
  }

  // Perspective projection of a world-space point into playfield coordinates,
  // using the full camera position + orientation (see cameraFrame). World
  // axes: x lateral, y forward depth, z height (negative = up); the camera's
  // own facing vector lives in the same axes and may carry a downward tilt
  // (stage 1 settles at atan(400/500) ≈ 38.7° once the intro pan finishes),
  // so the view-space depth/vertical used here are proper rotated
  // projections, not the raw world y/z.
  project(x: number, y: number, z: number, cam: CameraFrame, playfield: { x: number; y: number; width: number; height: number }): { x: number; y: number; scale: number } | null {
    const relX = x - cam.x;
    const relY = y - cam.y;
    const relZ = z - cam.z;
    const viewX = relX * cam.rightX + relY * cam.rightY + relZ * cam.rightZ;
    const viewY = relX * cam.upX + relY * cam.upY + relZ * cam.upZ;
    const viewZ = relX * cam.fwdX + relY * cam.fwdY + relZ * cam.fwdZ;
    if (viewZ <= 40) return null;
    const halfH = playfield.height / 2;
    const aspect = playfield.width / playfield.height;
    const yScale = 1 / Math.tan(cam.fov / 2);
    const xScale = yScale / aspect;
    const nx = (viewX * xScale) / viewZ;
    const ny = (viewY * yScale) / viewZ;
    return {
      x: playfield.x + playfield.width * (0.5 + nx * 0.5),
      y: playfield.y + playfield.height * (0.5 - ny * 0.5),
      scale: (halfH * yScale) / viewZ
    };
  }
}
