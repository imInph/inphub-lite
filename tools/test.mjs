#!/usr/bin/env node
/**
 * Run the tests without depending on Node's experimental type stripping.
 *
 * `node --experimental-strip-types --test tests/` works on a recent Node and
 * quietly does not on an older one: the stripper is a bundled swc build, and
 * which TypeScript syntax it understands moves with the Node version. CI was on
 * 22, this machine is on 26, and `satisfies` in data/types.ts was enough to
 * split them. The tests passed locally and failed in CI, which is the worst
 * shape a test suite can be in.
 *
 * esbuild is already a dependency and already compiles the app, so it compiles
 * the tests too. Any Node that can run `node --test` can now run these.
 */

import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = path.join(ROOT, 'tests');
const OUT = path.join(ROOT, '.test-build');

/** Pinned so a machine in another zone does not pass these by accident. */
const TZ = 'Europe/Istanbul';

await fs.rm(OUT, { recursive: true, force: true });

const entries = (await fs.readdir(TESTS))
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join(TESTS, f));

if (!entries.length) {
  console.error('no tests found in tests/');
  process.exit(1);
}

await esbuild.build({
  entryPoints: entries,
  outdir: OUT,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node18'],
  // node:test and friends stay external; everything under src/ is bundled in.
  packages: 'external',
  sourcemap: 'inline',
  logLevel: 'warning',
});

// Fixtures are read relative to the test file, so they have to travel with it.
for (const f of await fs.readdir(TESTS)) {
  if (!f.endsWith('.test.ts')) await fs.copyFile(path.join(TESTS, f), path.join(OUT, f));
}

const child = spawn(process.execPath, ['--test', OUT], {
  stdio: 'inherit',
  env: { ...process.env, TZ },
});
child.on('exit', async (code) => {
  await fs.rm(OUT, { recursive: true, force: true });
  process.exit(code ?? 1);
});
