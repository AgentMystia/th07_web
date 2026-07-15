// Text-mode visual verification. See AGENTS.md §5.
import { colorHex, readPixelStats, STANDARD_PIXEL_REGIONS } from './lib/pixel-stats.mjs';

const [file, ...regionArgs] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/pixel-report.mjs <shot.png> [x,y,w,h:label ...]');
  process.exit(1);
}
const result = readPixelStats(file, regionArgs.length ? regionArgs : STANDARD_PIXEL_REGIONS);
console.log(`${file}  ${result.width}x${result.height}  scale=${result.scale}`);
for (const [label, stats] of Object.entries(result.regions)) {
  if (!stats) {
    console.log(`${label.padEnd(14)} out of bounds`);
    continue;
  }
  console.log(
    `${label.padEnd(14)} avg=${colorHex(stats.r, stats.g, stats.b)} ` +
    `bright=${String(Math.round(stats.brightness)).padStart(3)} ` +
    `texture=${String(Math.round(stats.texture)).padStart(3)}% ` +
    `colors=${String(stats.colors).padStart(4)} ` +
    `center=${colorHex(...stats.center)}`
  );
}
