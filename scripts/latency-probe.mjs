// Chrome 144 Hz software latency proxy. This deliberately does not predict,
// advance the game manually, or claim photon latency: trusted CDP key events
// are paired with the game's Canvas-damage User Timing mark and Chrome's next
// display/presentation trace event.
import { attachPageDiagnostics, launchChromium, startStaticServer, uniqueErrors } from './lib/browser-harness.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const match = /^--([a-z-]+)$/.exec(argv[i]);
    if (!match) continue;
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[match[1]] = true;
    else { out[match[1]] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv);
const inputKind = args.input ?? 'direction';
const scenario = args.scenario ?? 'light';
const runs = Number(args.runs ?? 5);
const samplesPerRun = Number(args.samples ?? 250);
const headless = !!args.headless;
const allowInvalidRefresh = !!args['allow-invalid-refresh'];
const expectedChromeMajor = Number(args['chrome-major'] ?? 148);
const validInputs = new Set(['direction', 'shoot', 'focus', 'bomb']);
const validScenarios = new Set(['light', 'lunatic', 'dense-items']);
if (!validInputs.has(inputKind) || !validScenarios.has(scenario)) {
  console.error('usage: node scripts/latency-probe.mjs --input direction|shoot|focus|bomb --scenario light|lunatic|dense-items [--runs 5 --samples 250]');
  process.exit(2);
}

const difficulty = scenario === 'light' ? 1 : 3;
const targetFrame = scenario === 'light' ? 120 : 800;
const server = await startStaticServer();
const browser = await launchChromium({
  headless,
  args: headless ? [] : ['--start-fullscreen', '--disable-features=CalculateNativeWinOcclusion']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const pageErrors = attachPageDiagnostics(page);
const client = await page.context().newCDPSession(page);

const keyDef = (kind, index) => {
  if (kind === 'direction') {
    return index & 1
      ? { code: 'ArrowRight', key: 'ArrowRight', vk: 39 }
      : { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 };
  }
  if (kind === 'shoot') return { code: 'KeyZ', key: 'z', vk: 90 };
  if (kind === 'focus') return { code: 'ShiftLeft', key: 'Shift', vk: 16, modifiers: 8 };
  return { code: 'KeyX', key: 'x', vk: 88 };
};

const dispatch = (type, def) => client.send('Input.dispatchKeyEvent', {
  type,
  code: def.code,
  key: def.key,
  windowsVirtualKeyCode: def.vk,
  nativeVirtualKeyCode: def.vk,
  modifiers: type === 'keyUp' ? 0 : (def.modifiers ?? 0)
});

const waitForSample = async (code, minimumSequence) => {
  await page.waitForFunction(
    ({ wantedCode, min }) => window.__TH07_TEST__.latencySamples()
      .some((sample) => sample.edge === 'down' && sample.code === wantedCode && sample.sequence >= min && sample.drawEndAt != null),
    { wantedCode: code, min: minimumSequence },
    { timeout: 5000 }
  );
  return page.evaluate(({ wantedCode, min }) => window.__TH07_TEST__.latencySamples()
    .find((sample) => sample.edge === 'down' && sample.code === wantedCode && sample.sequence >= min && sample.drawEndAt != null),
  { wantedCode: code, min: minimumSequence });
};

const measureRefresh = () => page.evaluate(async () => {
  const stamps = [];
  await new Promise((resolve) => {
    const tick = (time) => {
      stamps.push(time);
      if (stamps.length >= 181) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return stamps.slice(1).map((value, index) => value - stamps[index]);
});

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

const summarize = (values) => ({
  samples: values.length,
  p50: percentile(values, 0.50),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
  max: values.length ? Math.max(...values) : null
});

const tracingComplete = () => new Promise((resolve) => client.once('Tracing.tracingComplete', resolve));
const readTrace = async (stream) => {
  let json = '';
  while (true) {
    const chunk = await client.send('IO.read', { handle: stream });
    json += chunk.data;
    if (chunk.eof) break;
  }
  await client.send('IO.close', { handle: stream });
  return JSON.parse(json).traceEvents ?? [];
};

try {
  await page.goto(`${server.baseUrl}/index.html?test=1&latency=1&difficulty=${difficulty}&power=128`);
  await page.waitForFunction(() => window.__TH07_TEST__?.ready, null, { timeout: 30000 });
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const major = Number(/(?:Chrome|HeadlessChrome)\/(\d+)/.exec(userAgent)?.[1] ?? 0);
  if (major !== expectedChromeMajor) throw new Error(`Chrome major ${major} does not match required ${expectedChromeMajor}`);

  await page.waitForFunction((frame) => window.__TH07_TEST__.snapshot().frame >= frame, targetFrame, { timeout: 30000 });
  if (scenario === 'dense-items') await page.evaluate(() => window.__TH07_TEST__.fillItems(1100));
  const refreshIntervals = await measureRefresh();
  const refreshMedian = median(refreshIntervals);
  const refreshValid = refreshMedian >= 6.5 && refreshMedian <= 7.4;

  await client.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    traceConfig: {
      recordMode: 'recordContinuously',
      includedCategories: [
        'benchmark', 'blink.user_timing', 'input', 'latencyInfo', 'cc', 'viz', 'gpu',
        'disabled-by-default-devtools.timeline', 'disabled-by-default-latencyInfo'
      ]
    }
  });

  const samples = [];
  for (let run = 0; run < runs; run++) {
    for (let index = 0; index < samplesPerRun; index++) {
      if (inputKind === 'bomb') await page.evaluate(() => window.__TH07_TEST__.resetBombForLatencyProbe());
      await page.evaluate(() => window.__TH07_TEST__.clearLatencySamples());
      const def = keyDef(inputKind, run * samplesPerRun + index);
      const phaseWait = Math.random() * (1000 / 60);
      await page.waitForTimeout(phaseWait);
      const minimumSequence = await page.evaluate(() => {
        const samples = window.__TH07_TEST__.latencySamples();
        return (samples.at(-1)?.sequence ?? 0) + 1;
      });
      await dispatch('rawKeyDown', def);
      const sample = await waitForSample(def.code, minimumSequence);
      await dispatch('keyUp', def);
      samples.push({ ...sample, run, index, input: inputKind, scenario, cold: run === 0 && index === 0 });
      // Let key-up state settle before the next isolated trial.
      await page.waitForTimeout(25);
    }
  }

  const complete = tracingComplete();
  await client.send('Tracing.end');
  const { stream } = await complete;
  const events = await readTrace(stream);
  const displays = events
    .filter((event) => /Display::FrameDisplayed|FramePresented|FrameDisplayed/.test(event.name ?? '') && Number.isFinite(event.ts))
    .sort((a, b) => a.ts - b.ts);

  const rows = [];
  for (const sample of samples) {
    const markName = `th07-latency-${sample.sequence}`;
    const mark = events.find((event) =>
      Number.isFinite(event.ts) && (event.name === markName || event.args?.data?.name === markName)
    );
    const display = mark ? displays.find((event) => event.ts >= mark.ts) : null;
    const drawToDisplayed = mark && display ? (display.ts - mark.ts) / 1000 : null;
    rows.push({
      ...sample,
      eventToHandler: sample.handlerStart - sample.eventTimestamp,
      handlerToSample: sample.sampledAt - sample.handlerEnd,
      sampleToLogic: sample.logicAppliedAt - sample.sampledAt,
      logicToDraw: sample.drawEndAt - sample.logicAppliedAt,
      drawToDisplayed,
      eventToDisplayed: drawToDisplayed == null
        ? null
        : sample.drawEndAt - sample.eventTimestamp + drawToDisplayed,
      displayEvent: display?.name ?? null
    });
  }

  const metric = (name, filter = () => true) => rows.filter(filter).map((row) => row[name]).filter(Number.isFinite);
  const report = {
    metric: 'event-to-present proxy',
    claim: 'software proxy only; excludes keyboard scan/USB/display scanout/panel response',
    chromeMajor: major,
    scenario,
    input: inputKind,
    runs,
    samplesPerRun,
    refresh: {
      medianMs: refreshMedian,
      p95Ms: percentile(refreshIntervals, 0.95),
      valid144Hz: refreshValid,
      requiredRangeMs: [6.5, 7.4]
    },
    canvas: await page.evaluate(() => window.__TH07_TEST__.canvasContextAttributes()),
    all: {
      eventToHandler: summarize(metric('eventToHandler')),
      handlerToSample: summarize(metric('handlerToSample')),
      sampleToLogic: summarize(metric('sampleToLogic')),
      logicToDraw: summarize(metric('logicToDraw')),
      drawToDisplayed: summarize(metric('drawToDisplayed')),
      eventToDisplayed: summarize(metric('eventToDisplayed'))
    },
    cold: summarize(metric('eventToDisplayed', (row) => row.cold)),
    steady: summarize(metric('eventToDisplayed', (row) => !row.cold)),
    missedPresentationRate: rows.length
      ? rows.filter((row) => !Number.isFinite(row.eventToDisplayed)).length / rows.length
      : 1,
    trace: {
      events: events.length,
      displayEvents: displays.length,
      eventLatencyEvents: events.filter((event) => event.name === 'EventLatency').length,
      latencyFlowEvents: events.filter((event) => event.name === 'LatencyInfo.Flow').length
    },
    pageErrors: uniqueErrors(pageErrors),
    samples: rows
  };
  console.log(JSON.stringify(report, null, 2));

  if (report.pageErrors.length) process.exitCode = 4;
  else if (!refreshValid && !allowInvalidRefresh) process.exitCode = 3;
  else if (report.missedPresentationRate > 0.001) process.exitCode = 5;
} finally {
  await browser.close();
  await server.close();
}
