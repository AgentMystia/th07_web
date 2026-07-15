import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/native-angle';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/core/util.ts --bundle --format=esm --outfile=${outDir}/util.mjs --log-level=silent`);
const {
  normalizeNativeAngleF32, NATIVE_PI_F32, NATIVE_TAU_F32
} = await import('../tests/.build/native-angle/util.mjs');

test('FUN_0042fff0 preserves exact -pi and wraps through float32 stores', () => {
  assert.equal(normalizeNativeAngleF32(-NATIVE_PI_F32), -NATIVE_PI_F32);
  const staged = Math.fround(Math.fround(NATIVE_PI_F32 + NATIVE_TAU_F32) - NATIVE_TAU_F32);
  assert.equal(
    normalizeNativeAngleF32(NATIVE_PI_F32, NATIVE_TAU_F32),
    staged
  );
});
