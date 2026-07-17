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
const { bgQuadCorner, Std, orderBgJobsByVisibility, viewDepthOf } = await import(`../${outDir}/std.mjs`);

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

// --- Painter ordering (orderBgJobsByVisibility) ------------------------------
// The exe depth-tests background pixels; the web painter emulates that with
// pairwise ray ordering. Geometry below is real stage-5 data at STD frame
// 2400 (camera from the live run): the -45° slope wall spans the whole
// staircase run and its CENTER depth (1056.5) is NEARER than an individual
// tread's (1093.8), so the legacy center-depth sort painted the wall over
// the treads — the "brown band through the stairs" tear.

const S5_CAM = {
  x: 0, y: 884.613563950842, z: -1684.613563950842,
  rightX: 1, rightY: 0, rightZ: 0,
  upX: 0, upY: 0.04993761694389223, upZ: -0.9987523388778446,
  fwdX: 0, fwdY: 0.9987523388778446, fwdZ: 0.04993761694389223,
  fov: 0.6283185482025146
};
const S5_PLAYFIELD = { x: 32, y: 16, width: 384, height: 448 };

function bgJob(overrides) {
  return {
    group: 0, sortZ: 0, billboard: false,
    cx: 0, cy: 0, cz: 0, hw: 10, hh: 10,
    cosRx: 1, sinRx: 0, cosRy: 1, sinRy: 0, cosRz: 1, sinRz: 0,
    ...overrides
  };
}

test('ordering: stage-5 slope wall draws before the tread it passes behind', () => {
  // obj1 wall (script 16, instY=1244): anchorTL 900x271.5 quad rot(-45°,0,0),
  // center (130, 1379.75, -1376). obj0 tread (script 6, same flight): 256x24
  // rot(-11.25°,0,0) with z offset -2, center (0, 1400, -1490). At this
  // camera the pair overlaps on screen (tread at screen y≈462) — every obj1
  // piece lies in the y+z=3.75 slope plane, and the camera/tread both sit on
  // its near side, so the tread is in front and the wall must paint first.
  const wallRx = -Math.PI / 4;
  const wall = bgJob({
    cx: 130, cy: 1379.75, cz: -1376, hw: 450, hh: 135.75,
    cosRx: Math.cos(wallRx), sinRx: Math.sin(wallRx),
    sortZ: viewDepthOf(130, 1379.75, -1376, S5_CAM)
  });
  const treadRx = -0.19635;
  const tread = bgJob({
    cx: 0, cy: 1400, cz: -1490, hw: 128, hh: 12,
    cosRx: Math.cos(treadRx), sinRx: Math.sin(treadRx),
    sortZ: viewDepthOf(0, 1400, -1490, S5_CAM)
  });
  // Precondition (the live-dump pathology): the wall's center is NEARER
  // (smaller depth), so the legacy sort drew the tread first and the wall
  // over it — the brown band. The ray test must reverse that.
  assert.ok(wall.sortZ < tread.sortZ, 'wall center must sort nearer than the tread');
  const ordered = orderBgJobsByVisibility([tread, wall], S5_CAM, S5_PLAYFIELD);
  assert.equal(ordered[0], wall, 'wall must draw before the tread');
  assert.equal(ordered[1], tread);
});

test('ordering: screen-disjoint quads keep the legacy center-depth order', () => {
  // Two small flat slabs left/right of the view axis: no screen overlap, so
  // no constraint forms and the farther-center quad still draws first.
  const near = bgJob({ cx: -60, cy: 1200, cz: -1500, sortZ: viewDepthOf(-60, 1200, -1500, S5_CAM) });
  const far = bgJob({ cx: 60, cy: 1400, cz: -1500, sortZ: viewDepthOf(60, 1400, -1500, S5_CAM) });
  const ordered = orderBgJobsByVisibility([near, far], S5_CAM, S5_PLAYFIELD);
  assert.equal(ordered[0], far);
  assert.equal(ordered[1], near);
});

test('ordering: coplanar overlapping quads keep the zLevel-chain order', () => {
  // Identical plane, identical center depth, different draw chains: the ray
  // and depth fallbacks both tie, so the group-0 quad must stay first (the
  // exe draws chain 0/1 before 2/3, and ties resolve by draw order there).
  const decalBase = bgJob({ cx: 0, cy: 1400, cz: -1500, hw: 50, hh: 50, group: 0, sortZ: viewDepthOf(0, 1400, -1500, S5_CAM) });
  const decalTop = { ...decalBase, group: 1 };
  const ordered = orderBgJobsByVisibility([decalTop, decalBase], S5_CAM, S5_PLAYFIELD);
  assert.equal(ordered[0], decalBase, 'group 0 must draw before group 1 on a tie');
  assert.equal(ordered[1], decalTop);
});
