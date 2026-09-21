#!/usr/bin/env node
/**
 * inphub lite: the linter this project doesn't otherwise have. Run by
 * `npm run build`; a violation fails it.
 *
 * Each rule stands for a mistake that reads fine in a diff and hurts later.
 * A delete outside tx.ts skips the cascade rules that replace MySQL's foreign
 * keys. A second indexedDB.open misses the onblocked handling and hangs the app
 * at the next schema bump. A stray fetch breaks the promise that an offline
 * launch makes no requests. An absolute path 404s on Pages, which serves from
 * /inphub-lite/ rather than the domain root. And an unprefixed localStorage key
 * collides with every other project on <user>.github.io, since that's one origin
 * for all of them.
 *
 * Add a rule whenever you find another one of these.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** @type {{name: string, test: RegExp, allow: string[], hint: string}[]} */
const RULES = [
  {
    name: 'delete-outside-tx',
    // Matches `anything.delete(`, which is the dangerous form.
    // The CacheStorage API is not a database and is excluded by name, not by
    // allowlisting whole files, so a real store.delete() in sw.ts would still fail.
    test: /(?<!caches)\.delete\(/,
    allow: ['data/tx.ts', 'data/import.ts'],
    hint: 'use remove() from data/tx.ts, which applies the cascade/set-null rules in relations.ts',
  },
  {
    name: 'indexeddb-open',
    test: /indexedDB\.open\(/,
    allow: ['data/db.ts'],
    hint: 'data/db.ts owns the connection, the migrations and the onblocked/onversionchange handling',
  },
  {
    name: 'stray-fetch',
    test: /(?<![.\w])fetch\(/,
    allow: ['github.ts', 'sw.ts', 'data/build-info.ts'],
    hint: 'inphub lite is offline-first; the network belongs to github.ts and sw.ts only',
  },
  {
    name: 'absolute-path',
    test: /(?:href|src)="\/(?!\/)|from '\/(?!\/)/,
    allow: [],
    hint: 'GitHub Pages serves this from /inphub-lite/, so every path must be relative',
  },
  {
    // clear() wipes a whole store, so it is as destructive as a delete and gets
    // the same treatment. The importer's replace mode is the only caller.
    name: 'clear-outside-import',
    test: /(?<!caches)\.clear\(/,
    allow: ['data/import.ts'],
    hint: 'clearing a store belongs to the importer; use remove() from data/tx.ts',
  },
  {
    // Only literals: a named constant (THEME_KEY) is checked at its declaration
    // by the rule below, and flagging identifiers here would just train people
    // to hoist the string to dodge the check.
    name: 'unprefixed-localstorage',
    test: /localStorage\.(?:get|set|remove)Item\(\s*['"`](?!inphub-lite:)/,
    allow: ['index.html'],
    hint: "namespace it: localStorage keys must start with 'inphub-lite:'",
  },
  {
    // inphub loaded chart.js, marked and DOMPurify as globals from <script>
    // tags, so its modules just declared them. Here they are bundled, and a
    // declare with no import compiles fine and is undefined at runtime: the
    // charts never draw and nothing says why. Found exactly that way.
    name: 'declared-global-library',
    test: /declare const (Chart|marked|markedFootnote|DOMPurify)\b/,
    allow: [],
    hint: 'import it instead; these are bundled now, not window globals',
  },
  {
    // The copy-paste hazard: inphub's own keys are 'inphub.theme' etc, and a
    // module ported from it will bring them along. index.html reads them on
    // purpose, once, for the first-run appearance fallback.
    name: 'legacy-storage-key',
    test: /['"`]inphub\.[a-z]/,
    allow: ['index.html'],
    hint: "that is inphub's key namespace; lite uses 'inphub-lite:'",
  },
];

async function* walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (/\.(ts|html)$/.test(e.name)) yield full;
  }
}

/** Strip comments and string literals so a rule never fires on prose. */
function strip(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const failures = [];
for await (const file of walk(SRC)) {
  const relPath = path.relative(SRC, file).split(path.sep).join('/');
  const lines = strip(await fs.readFile(file, 'utf8')).split('\n');
  for (const rule of RULES) {
    if (rule.allow.includes(relPath)) continue;
    lines.forEach((line, i) => {
      if (rule.test.test(line)) {
        failures.push(`  src/${relPath}:${i + 1}  [${rule.name}] ${rule.hint}\n      ${line.trim()}`);
      }
    });
  }
}

if (failures.length) {
  console.error(`\ncheck-invariants: ${failures.length} violation(s)\n`);
  console.error(failures.join('\n\n'));
  console.error('');
  process.exit(1);
}
console.log(`[check] ${RULES.length} invariants hold`);
