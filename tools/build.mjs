#!/usr/bin/env node
/**
 * inphub lite: the whole build. src/ through esbuild into public/, which is
 * committed and deployed to Pages exactly as it sits.
 *
 * The order below can't be shuffled. The service worker's precache list comes
 * from the app bundle's output filenames, so the app has to be built first.
 *
 * inphub's tools/stamp-modules.mjs isn't ported, and content hashes are why.
 * inphub compiles to separate ES modules that import each other by bare relative
 * path, so only the entry URL carried a version, which let a fresh app.js pair
 * with a cached ui.js. A missing export is an ES-module link error, so the entry
 * never executes and the app dies without a word. The stamper existed to stop
 * that. Hashed filenames stop it by construction: a changed chunk is a different
 * URL, so two builds can't mix, and esbuild writes the cross-chunk imports.
 *
 * ?v= survives only on the icons and the manifest, whose names never change.
 * It's useless as a cache key inside the service worker anyway, since that reads
 * with ignoreSearch, which is the other reason the hash goes in the filename.
 */

import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'public');

const WATCH = process.argv.includes('--watch');
const SERVE = process.argv.includes('--serve');
const PORT = 4173;

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

/** Schema version, mirrored from src/data/db.ts so build.json can report it. */
async function schemaVersion() {
  try {
    const src = await fs.readFile(path.join(SRC, 'data/db.ts'), 'utf8');
    return Number(/export const DB_VERSION\s*=\s*(\d+)/.exec(src)?.[1] ?? 1);
  } catch {
    return 1;
  }
}

const rel = (p) => path.relative(OUT, p).split(path.sep).join('/');

/**
 * The build id: sha256 over the build's inputs, first 10 hex.
 *
 * Inputs and not outputs, because both the app bundle and the service worker
 * need this value baked in (the sidebar prints it, the worker names its cache
 * after it), so hashing the output it appears in would be circular. What matters
 * is that it's stable: an unchanged rebuild writes an identical public/, which
 * is what lets verify.yml catch a stale one with git diff --exit-code.
 *
 * This script counts as an input: it picks the output filenames, so editing it
 * without touching src/ produces new chunks under the old id, and the service
 * worker then reuses its cache and holds both generations of every file. Found
 * exactly that way.
 *
 * Only this script, though, not all of tools/. check-invariants.mjs and test.mjs
 * never touch the output, and hashing them meant a change to a test helper
 * invalidated the deployed build and failed the staleness check for no reason.
 * Found that way too.
 */
async function sourceHash() {
  const files = [];
  for await (const f of walk(SRC)) files.push(f);
  files.push(path.join(ROOT, 'tools', 'build.mjs'));
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(ROOT, file).split(path.sep).join('/'));
    hash.update(await fs.readFile(file));
  }
  hash.update(await fs.readFile(path.join(ROOT, 'package.json')));
  return hash.digest('hex').slice(0, 10);
}

async function* walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function build() {
  const started = Date.now();
  const BUILD = await sourceHash();

  // 1. Clean the hashed output. Mandatory: without it every build leaves its
  //    predecessors behind and the committed repo grows without bound.
  await fs.rm(path.join(OUT, 'assets'), { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, 'assets'), { recursive: true });

  // 2a. The stylesheet, as its own entry point. Importing it from main.ts would
  //     work, but esbuild then names the CSS after the JS entry and drops it in
  //     assets/js/ beside the bundle. A separate entry is what puts it where it
  //     belongs and keeps the two hashes independent, so a CSS-only change
  //     does not invalidate the cached JS, and vice versa.
  const cssResult = await esbuild.build({
    entryPoints: [path.join(SRC, 'styles/app.css')],
    bundle: true,
    outdir: path.join(OUT, 'assets'),
    entryNames: 'css/app-[hash]',
    assetNames: 'css/[name]-[hash]',
    minify: !WATCH,
    sourcemap: WATCH,
    legalComments: 'none',
    metafile: true,
  });

  // 2b. The app bundle.
  //     Source maps only in watch mode: public/ is committed, and a half-megabyte
  //     map that changes on every build would dominate the repo's history for a
  //     file nobody reads in production. `npm run dev` has them.
  const result = await esbuild.build({
    entryPoints: [path.join(SRC, 'main.ts')],
    bundle: true,
    format: 'esm',
    splitting: true,
    target: ['es2022'],
    outdir: path.join(OUT, 'assets'),
    entryNames: 'js/app-[hash]',
    chunkNames: 'js/chunk-[hash]',
    minify: !WATCH,
    sourcemap: WATCH,
    legalComments: 'none',
    metafile: true,
    logLevel: 'info',
    define: {
      __VERSION__: JSON.stringify(VERSION),
      __BUILD__: JSON.stringify(BUILD),
    },
  });

  const outputs = [
    ...Object.keys(result.metafile.outputs),
    ...Object.keys(cssResult.metafile.outputs),
  ].map((p) => path.resolve(ROOT, p));
  const entry = outputs.find((p) => /\/js\/app-[^/]+\.js$/.test(p));
  const css = outputs.find((p) => /\/css\/app-[^/]+\.css$/.test(p));
  if (!entry) throw new Error('esbuild produced no entry chunk');
  if (!css) throw new Error('esbuild produced no stylesheet');

  // 4. Static assets, copied before the precache list is assembled.
  await fs.cp(path.join(SRC, 'icons'), path.join(OUT, 'icons'), { recursive: true });
  const icons = (await fs.readdir(path.join(SRC, 'icons'))).map((f) => `icons/${f}`);

  const manifest = (await fs.readFile(path.join(SRC, 'manifest.webmanifest'), 'utf8'));
  await fs.writeFile(path.join(OUT, 'manifest.webmanifest'), manifest);

  // 5. The service worker, second, with the precache list injected. The list is
  //    generated, never hand-kept: a hand-written one rots the first time
  //    a chunk is added, and the failure is an app that half-works offline.
  const precache = ['./', ...outputs.filter((p) => !p.endsWith('.map')).map(rel),
                    'manifest.webmanifest', ...icons];
  await esbuild.build({
    entryPoints: [path.join(SRC, 'sw.ts')],
    bundle: true,
    format: 'iife',
    target: ['es2022'],
    outfile: path.join(OUT, 'sw.js'),
    minify: !WATCH,
    legalComments: 'none',
    define: {
      __BUILD__: JSON.stringify(BUILD),
      __PRECACHE__: JSON.stringify(precache),
    },
  });

  // 6. The shell.
  const html = (await fs.readFile(path.join(SRC, 'index.html'), 'utf8'))
    .replaceAll('{{ENTRY}}', rel(entry))
    .replaceAll('{{CSS}}', rel(css))
    .replaceAll('{{VERSION}}', VERSION)
    .replaceAll('{{BUILD}}', BUILD);
  await fs.writeFile(path.join(OUT, 'index.html'), html);

  // 7. Provenance. Settings shows these numbers; "which build, which schema" is
  //    always the first question when something looks wrong.
  //
  //    No timestamp here: public/ is committed, and a build time would
  //    change on every run, so `git diff --exit-code public/` could no longer
  //    tell "you forgot to rebuild" from "you rebuilt". Git already records when.
  await fs.writeFile(path.join(OUT, 'build.json'), JSON.stringify({
    version: VERSION,
    build: BUILD,
    schemaVersion: await schemaVersion(),
    files: precache,
  }, null, 2) + '\n');

  // Without .nojekyll, Pages runs the output through Jekyll, which drops every
  // path beginning with "_" and reports nothing. Cheapest possible insurance.
  await fs.writeFile(path.join(OUT, '.nojekyll'), '');

  console.log(`[build] v${VERSION} ${BUILD} · ${outputs.length} files · ${Date.now() - started}ms`);
  return BUILD;
}

await build();

if (WATCH) {
  const { watch } = await import('node:fs');
  let timer = null;
  watch(SRC, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((e) => console.error('[build]', e.message)), 80);
  });
  console.log('[build] watching src/');
}

if (SERVE) {
  // A plain static server that mimics Pages closely enough to catch an absolute
  // path: it serves public/ at the root and 404s anything outside it.
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };
  createServer(async (req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.join(OUT, url);
    if (url.endsWith('/')) file = path.join(file, 'index.html');
    if (!file.startsWith(OUT)) { res.writeHead(403).end(); return; }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      }).end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404');
    }
  }).listen(PORT, () => console.log(`[serve] http://localhost:${PORT}/`));
}
