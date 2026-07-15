import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

export const STANDARD_PIXEL_REGIONS = [
  '200,30,80,40:sky',
  '48,300,60,60:ground-left',
  '180,300,80,60:ground-center',
  '320,300,60,60:ground-right',
  '4,200,24,60:frame-left',
  '612,200,24,60:frame-right',
  '432,48,64,144:hud-labels',
  '504,48,80,32:hud-digits',
  '480,240,128,96:logo',
  '32,448,96,16:cherry-banner',
  '176,360,32,40:player-zone'
];

export function readPixelStats(file, specs = STANDARD_PIXEL_REGIONS) {
  const png = PNG.sync.read(readFileSync(file));
  const scale = png.width / 640;
  const regions = {};
  for (const spec of specs) {
    const [coords, label = spec] = spec.split(':');
    const [gx, gy, gw, gh] = coords.split(',').map(Number);
    const x0 = Math.round(gx * scale);
    const y0 = Math.round(gy * scale);
    const x1 = Math.min(png.width, Math.round((gx + gw) * scale));
    const y1 = Math.min(png.height, Math.round((gy + gh) * scale));
    let n = 0, rs = 0, gs = 0, bs = 0;
    const seen = new Set();
    const pixels = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const offset = (y * png.width + x) * 4;
        const r = png.data[offset], g = png.data[offset + 1], b = png.data[offset + 2];
        rs += r; gs += g; bs += b; n++;
        pixels.push(r, g, b);
        seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      }
    }
    if (!n) {
      regions[label] = null;
      continue;
    }
    const r = rs / n, g = gs / n, b = bs / n;
    let far = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      if (Math.abs(pixels[i] - r) + Math.abs(pixels[i + 1] - g) + Math.abs(pixels[i + 2] - b) > 48) far++;
    }
    const cx = Math.round((x0 + x1) / 2), cy = Math.round((y0 + y1) / 2);
    const centerOffset = (cy * png.width + cx) * 4;
    regions[label] = {
      r, g, b,
      brightness: (r + g + b) / 3,
      texture: (far / n) * 100,
      colors: seen.size,
      center: [png.data[centerOffset], png.data[centerOffset + 1], png.data[centerOffset + 2]]
    };
  }
  return { width: png.width, height: png.height, scale, regions };
}

export function colorHex(r, g, b) {
  const hex = (value) => Math.round(value).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

