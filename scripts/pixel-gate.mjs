import { readPixelStats } from './lib/pixel-stats.mjs';

const [file, profile = '800'] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/pixel-gate.mjs <shot.png> [120|800|2500|boss]');
  process.exit(2);
}
const { regions } = readPixelStats(file);
const failures = [];
const atLeast = (name, field, value) => {
  if (!regions[name] || regions[name][field] < value) failures.push(`${name}.${field} < ${value}`);
};
const atMost = (name, field, value) => {
  if (!regions[name] || regions[name][field] > value) failures.push(`${name}.${field} > ${value}`);
};

atLeast('hud-labels', 'texture', 30);
atLeast('hud-labels', 'colors', 100);
atLeast('hud-digits', 'texture', 20);
atLeast('logo', 'texture', 70);
atLeast('logo', 'colors', 200);
if (profile === '800') {
  atMost('sky', 'texture', 13);
}
if (profile === '800' || profile === 'boss') {
  for (const name of ['ground-left', 'ground-center', 'ground-right']) atLeast(name, 'texture', 10);
}
if (profile === '2500') atLeast('cherry-banner', 'texture', 15);
if (failures.length) {
  console.error(`PIXEL GATE FAILED (${profile}): ${failures.join('; ')}`);
  process.exit(3);
}
console.log(`PIXEL GATE PASS (${profile})`);
