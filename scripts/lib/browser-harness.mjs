import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.map': 'application/json'
};

export const repoRoot = new URL('../..', import.meta.url).pathname;

export function resolveChromiumExecutable() {
  const explicit = process.env.TH07_CHROMIUM;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`TH07_CHROMIUM does not exist: ${explicit}`);
    return explicit;
  }

  const playwrightPath = chromium.executablePath();
  if (playwrightPath && existsSync(playwrightPath)) return playwrightPath;

  const base = '/opt/pw-browsers';
  if (existsSync(base)) {
    const candidates = [];
    for (const dir of readdirSync(base)) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const candidate = join(base, dir, rel);
        if (existsSync(candidate)) candidates.push(candidate);
      }
    }
    candidates.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (candidates[0]) return candidates[0];
  }
  throw new Error('No Chromium executable found; set TH07_CHROMIUM or run `npx playwright install chromium`.');
}

export async function startStaticServer(rootDir = repoRoot) {
  const root = resolve(rootDir);
  const server = createServer(async (req, res) => {
    try {
      let pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      if (pathname === '/') pathname = '/index.html';
      const file = resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(root + sep)) throw new Error('path traversal');
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('static server failed to bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((done) => server.close(done))
  };
}

export function attachPageDiagnostics(page) {
  const errors = [];
  const add = (kind, value) => errors.push(`${kind}: ${String(value).slice(0, 400)}`);
  page.on('pageerror', (error) => add('pageerror', error));
  page.on('console', (message) => {
    if (message.type() === 'error') add('console', message.text());
  });
  page.on('requestfailed', (request) => add('requestfailed', `${request.url()} ${request.failure()?.errorText ?? ''}`));
  return errors;
}

export async function launchChromium(options = {}) {
  return chromium.launch({
    ...options,
    executablePath: options.executablePath ?? resolveChromiumExecutable(),
    headless: options.headless ?? true,
    args: options.args ?? []
  });
}

export function uniqueErrors(errors) {
  return [...new Set(errors)];
}
