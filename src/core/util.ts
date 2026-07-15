export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const NATIVE_PI_F32 = 3.1415927410125732;
export const NATIVE_TAU_F32 = 6.2831854820251465;
export const NATIVE_HALF_PI_F32 = 1.5707963705062866;

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// Matches the original engine's angle normalization: ±π stays put, everything
// else wraps into (-π, π].
export function normalizeAngle(v: number): number {
  const EPS = 1e-6;
  if (Math.abs(v - Math.PI) <= EPS) return Math.PI;
  if (Math.abs(v + Math.PI) <= EPS) return -Math.PI;
  while (v < -Math.PI) v += TAU;
  while (v > Math.PI) v -= TAU;
  return v;
}

// Th07.exe FUN_0042fff0 @ 0x42fff0 stores both operands and every wrap
// through float32, preserving exactly -pi and stopping after 18 iterations.
// Large authored angles and collision-boundary headings observe both details.
export function normalizeNativeAngleF32(angle: number, delta = 0): number {
  let value = Math.fround(Math.fround(angle) + Math.fround(delta));
  for (let i = 0; i < 18 && value > NATIVE_PI_F32; i++) {
    value = Math.fround(value - NATIVE_TAU_F32);
  }
  for (let i = 0; i < 18 && value < -NATIVE_PI_F32; i++) {
    value = Math.fround(value + NATIVE_TAU_F32);
  }
  return value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
