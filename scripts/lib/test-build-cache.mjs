import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(new URL('../..', import.meta.url).pathname);
const cacheRoot = join(root, 'tests', '.build', 'cache');

function sourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) files.push(path);
    }
  };
  walk(join(root, 'src'));
  for (const name of ['tsconfig.json', 'package-lock.json']) {
    const path = join(root, name);
    if (existsSync(path)) files.push(path);
  }
  return files.sort();
}

function sourceHash() {
  const hash = createHash('sha256');
  for (const file of sourceFiles()) {
    hash.update(relative(root, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 24);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
}

function complete(dir) {
  return existsSync(join(dir, '.complete')) && existsSync(join(dir, 'bundle.mjs'));
}

function prune(specDir, keep = 4) {
  const entries = readdirSync(specDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, mtimeMs: statSync(join(specDir, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of entries.slice(keep)) {
    const path = join(specDir, entry.name);
    // A cache hit touches the directory before importing. Re-stat here so a
    // prune scan that raced with that touch cannot delete the module another
    // process is about to evaluate from a stale mtime snapshot.
    try {
      if (statSync(path).mtimeMs !== entry.mtimeMs) continue;
    } catch {
      continue;
    }
    rmSync(path, { recursive: true, force: true });
  }
}

async function importBundle(path) {
  return import(pathToFileURL(path).href);
}

export async function cachedEsbuild({ name, entryPoints, buildOptions = {} }) {
  const spec = stable({
    name,
    entryPoints: entryPoints.map((entry) => relative(root, resolve(root, entry))),
    buildOptions,
    node: process.version,
    esbuild: esbuild.version
  });
  const specHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
  const specDir = join(cacheRoot, `${basename(name)}-${specHash}`);
  mkdirSync(specDir, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt++) {
    const before = sourceHash();
    const target = join(specDir, before);
    if (complete(target)) {
      const now = new Date();
      utimesSync(target, now, now);
      const module = await importBundle(join(target, 'bundle.mjs'));
      prune(specDir);
      return module;
    }

    const temp = join(specDir, `.${before}-${process.pid}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(temp, { recursive: true });
    try {
      await esbuild.build({
        entryPoints: entryPoints.map((entry) => resolve(root, entry)),
        bundle: true,
        format: 'esm',
        outfile: join(temp, 'bundle.mjs'),
        logLevel: 'silent',
        ...buildOptions
      });
      const after = sourceHash();
      if (after !== before) {
        rmSync(temp, { recursive: true, force: true });
        continue;
      }
      writeFileSync(join(temp, '.complete'), `${JSON.stringify(spec)}\n`);
      try {
        renameSync(temp, target);
      } catch (error) {
        if (!complete(target)) throw error;
        rmSync(temp, { recursive: true, force: true });
      }
      const module = await importBundle(join(target, 'bundle.mjs'));
      prune(specDir);
      return module;
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error('source tree kept changing while building the test cache');
}
