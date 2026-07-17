import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// The 3D background transform (AnmManager::Draw3's S·RotX·RotY·RotZ on a
// centered local quad, anchor-shifted in unrotated world x/y for op22
// scripts) against hand-computed stage-5 staircase geometry decoded from
// the real data: treads tilt -11.25° with a z=-2 offset, risers stand at
// +90° bridging consecutive treads, balustrades rotate on all three axes.

const outDir = 'tests/.build/bg3d';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/formats/std.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { bgQuadCorner, Std } = await import(`../${outDir}/std.mjs`);

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

function corner(u, v, rx, ry, rz, cx, cy, cz) {
  const out = { x: 0, y: 0, z: 0 };
  bgQuadCorner(out, u, v, Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz), cx, cy, cz);
  return out;
}

test('identity rotation reduces to the flat corner-anchored slab', () => {
  // Stage-1 ground semantics: anchorTL quad at pos (-64,0,-12) with 512x256
  // extents spans x [-64,448], y [0,256] around center (192,128).
  const cx = -64 + 512 / 2, cy = 0 + 256 / 2, cz = -12;
  assert.deepEqual(corner(-256, -128, 0, 0, 0, cx, cy, cz), { x: -64, y: 0, z: -12 });
  assert.deepEqual(corner(256, 128, 0, 0, 0, cx, cy, cz), { x: 448, y: 256, z: -12 });
});

test('stage-5 riser (rotX=+90°, anchorTL) stands vertical and bridges its treads', () => {
  // Real data: riser quad pos (0,12,-12) size 256x24 (inst placed at origin
  // here), script rot(+PI/2,0,0) + anchorTL. Draw3 anchors the translation
  // in unrotated x/y, so the wall occupies x=[0,256], y=12 (flat),
  // z=-12±12 — exactly the gap between the tread slabs at z=0 and z=-24.
  const rx = Math.PI / 2;
  const cx = 0 + 256 / 2, cy = 12 + 24 / 2, cz = -12;
  for (const [u, v] of [[-128, -12], [128, -12], [-128, 12], [128, 12]]) {
    const c = corner(u, v, rx, 0, 0, cx, cy, cz);
    close(c.x, u + 128);
    close(c.y, 24);
    close(c.z, -12 + v);
  }
  // Riser spans z [-24, 0] at y=24 — the treads it joins sit at z≈0/-24.
  const top = corner(0, 12, rx, 0, 0, cx, cy, cz);
  const bottom = corner(0, -12, rx, 0, 0, cx, cy, cz);
  close(top.z, 0);
  close(bottom.z, -24);
});

test('stage-5 tread (rotX=-11.25°, anchorTL, z offset -2) tilts around its center', () => {
  // Tread quad pos (0,0,0) size 256x24, script rot(-0.19635,0,0) + offset
  // (0,0,-2): the center drops 2 units, far edge another ~2.34.
  const rx = -0.19635;
  const cx = 128, cy = 12, cz = -2;
  const near = corner(0, -12, rx, 0, 0, cx, cy, cz);
  const far = corner(0, 12, rx, 0, 0, cx, cy, cz);
  close(near.z, -2 + 12 * Math.sin(0.19635), 1e-3);
  close(far.z, -2 - 12 * Math.sin(0.19635), 1e-3);
  close(near.y, 12 - 12 * Math.cos(0.19635), 1e-3);
  close(far.y, 12 + 12 * Math.cos(0.19635), 1e-3);
  close(near.x, 128);
});

test('stage-5 balustrade (rot(90°,135°,90°), unanchored) matches the hand-derived basis', () => {
  // Scripts 23/24 author rot(PI/2, 3PI/4, PI/2) with NO anchor: the quad is
  // centered on its position. Hand-derive the basis through
  // v·S·RotX·RotY·RotZ: local x maps to (0, -√2/2, -√2/2) and local y to
  // (0, √2/2, -√2/2) — an orthonormal pair spanning the tilted rail plane.
  const rx = Math.PI / 2, ry = 3 * Math.PI / 4, rz = Math.PI / 2;
  const xAxis = corner(1, 0, rx, ry, rz, 0, 0, 0);
  close(xAxis.x, 0, 1e-9);
  close(xAxis.y, -Math.SQRT1_2, 1e-9);
  close(xAxis.z, -Math.SQRT1_2, 1e-9);
  const yAxis = corner(0, 1, rx, ry, rz, 0, 0, 0);
  close(yAxis.x, 0, 1e-9);
  close(yAxis.y, Math.SQRT1_2, 1e-9);
  close(yAxis.z, -Math.SQRT1_2, 1e-9);
});

test('viewDepth uses the camera forward axis (D3D linear vertex-fog metric)', () => {
  // Minimal camera: at origin, facing +y (fwd=(0,1,0)).
  const cam = { x: 0, y: 0, z: 0, rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 0, upZ: 1, fwdX: 0, fwdY: 1, fwdZ: 0, fov: 0.5 };
  const std = Object.create(Std.prototype);
  close(std.viewDepth(3, 200, -50, cam), 200);
  // Tilted camera: fwd=(0, cos30°, -sin30°) (looking down 30°) — a point
  // straight ahead at (0, 100·cos30°, -100·sin30°) reads exactly 100.
  const tilt = { ...cam, fwdX: 0, fwdY: Math.cos(Math.PI / 6), fwdZ: -Math.sin(Math.PI / 6) };
  close(std.viewDepth(0, 100 * Math.cos(Math.PI / 6), -100 * Math.sin(Math.PI / 6), tilt), 100, 1e-9);
});
