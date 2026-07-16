import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'fast';
const argv = process.argv.slice(3);

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i++) {
    const match = /^--([a-z-]+)$/.exec(values[i]);
    if (!match) continue;
    const next = values[i + 1];
    if (next == null || next.startsWith('--')) out[match[1]] = true;
    else { out[match[1]] = next; i++; }
  }
  return out;
}

function run(command, args, label = `${command} ${args.join(' ')}`) {
  console.log(`\n[verify] ${label}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal ?? code})`));
    });
  });
}

const npm = (script, extra = []) => run('npm', ['run', script, '--', ...extra], `npm run ${script}`);

async function fast() {
  await Promise.all([
    npm('check'),
    npm('build'),
    run('npm', ['test'], 'npm test'),
    npm('replay:verify')
  ]);
  await run('node', ['scripts/dev-shot.mjs', '/tmp/th07-verify-boot.png', '300'], 'clean browser boot');
}

async function edit() {
  const args = parseArgs(argv);
  const tests = args.test ? String(args.test).split(',') : [];
  const replayArgs = [];
  if (args.replay) replayArgs.push('--replay', String(args.replay));
  if (args.stage) replayArgs.push('--stage', String(args.stage));
  if (args.trace) replayArgs.push('--trace', String(args.trace));
  await Promise.all([
    npm('check'),
    tests.length ? run('node', ['--test', ...tests], `related tests: ${tests.join(', ')}`) : run('npm', ['test'], 'npm test'),
    npm('replay:verify', replayArgs)
  ]);
}

async function full() {
  await fast();
  // These pixel gates test STAGE CONTENT (geometry/HUD/spell art), not the
  // presentation path. Capture them on the standard (non-desync) canvas
  // (desync=0): a granted desynchronized canvas's headless screenshot may
  // bypass the compositor and read a stale/black frame (see the diff's
  // honesty note in desync-stage5-probe.mjs), which would flake the gates.
  // The presentation path itself is gated by desync-stage5-probe below.
  const shots = [
    ['120', 'desync=0', '', '120'],
    ['800', 'difficulty=3&desync=0', '', '800'],
    ['2500', 'difficulty=3&desync=0', 'shoot', '2500'],
    ['3400', 'difficulty=3&desync=0', '', '3400'],
    ['5800', 'difficulty=3&desync=0', '', 'boss']
  ];
  for (const [frame, query, held, profile] of shots) {
    const file = `/tmp/th07-full-${frame}.png`;
    await run('node', ['scripts/dev-shot.mjs', file, frame, query, held], `Stage 1 frame ${frame}`);
    await run('node', ['scripts/pixel-report.mjs', file], `pixel report ${frame}`);
    if (profile === '120' || profile === '800' || profile === '2500' || profile === 'boss') {
      await run('node', ['scripts/pixel-gate.mjs', file, profile], `pixel gate ${frame}`);
    }
  }
  await npm('replay:browser', ['tests/replays/th7_udFe25.rpy', '1', '300', '/tmp/th07-full-replay.png', '0']);
  await npm('prepare-pages');
  await run('node', ['scripts/browser-boot.mjs', 'dist/pages', '300'], 'static Pages boot');
  // Exercises the default-on backbuffer presentation against a Stage-5 spell
  // card (the 8552afe flicker scenario) when the environment grants it.
  // Grant is an environment property, not a code one (GPU-disabled CI,
  // older Chromium, headless shells all vary), so this is a soft check:
  // the probe still fails hard on page errors / black frames / a lost
  // spell, but a non-granting environment skips the grant-gated asserts
  // instead of turning a correct build red.
  await run('node', ['scripts/desync-stage5-probe.mjs'], 'stage-5 desync presentation probe');
}

try {
  if (mode === 'edit') await edit();
  else if (mode === 'fast') await fast();
  else if (mode === 'full') await full();
  else throw new Error(`unknown verify mode: ${mode}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
