/**
 * The shared backup format, from lite's side.
 *
 * The fixture is not hand-written: it was produced by inphub's own
 * lib/backup.php from rows shaped the way PDO really hands them back, so this
 * tests the actual contract rather than my idea of it. Regenerate it with
 * inphub's tools/backup-selftest.php as a guide if the format changes, and bump
 * format_version in BACKUP-FORMAT.md when you do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BackupError, parseBackup, BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from '../src/data/backup.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures-inphub-backup.txt'), 'utf8');

test('reads a file written by inphub', () => {
  const p = parseBackup(fixture);
  assert.equal(p.meta.app, 'inphub');
  assert.equal(p.counts['expenses'], 1);
  assert.equal(p.counts['todos'], 1);
});

test('coerces the strings PDO hands back', () => {
  // This is the bug the plan called risk 5: none of these throw if missed,
  // they just render wrong in one chart weeks later.
  const e = parseBackup(fixture).rows.expenses![0]!;
  assert.equal(typeof e['amount'], 'number');
  assert.equal(e['amount'], 42.5);
  assert.equal(typeof e['id'], 'number');
  assert.equal(e['id'], 17);
  assert.equal(e['is_recurring'], 0);
  assert.equal(e['description'], 'Kahvaltı');
});

test('normalises MySQL datetimes to the T form', () => {
  // Mixing the two forms in one store breaks the created_at index outright:
  // a space is 0x20 and a T is 0x54, so every space-form row sorts first.
  const e = parseBackup(fixture).rows.expenses![0]!;
  assert.equal(e['created_at'], '2026-09-10T09:15:00');
  const a = parseBackup(fixture).rows.activity_log![0]!;
  assert.equal(a['created_at'], '2026-09-20T21:39:12');
});

test('JSON columns arrive as objects, not strings holding JSON', () => {
  const a = parseBackup(fixture).rows.activity_log![0]!;
  assert.deepEqual(a['metadata'], { count: 4 });
});

test("keeps inphub's 'ai' author, which lite never writes but must not lose", () => {
  assert.equal(parseBackup(fixture).rows.todos![0]!['created_by'], 'ai');
});

test('refuses a secret in the file and says so', () => {
  const p = parseBackup(fixture);
  assert.equal(p.rows.settings!.length, 1);
  assert.equal(p.rows.settings![0]!['key'], 'base_currency');
  assert.ok(p.warnings.some((w) => w.includes('github_token')));
});

test('counts the AI rows it skips rather than dropping them in silence', () => {
  const p = parseBackup(fixture);
  assert.ok(p.warnings.some((w) => /Skipped 2 AI rows/.test(w)));
});

test('rejects anything it cannot safely import', () => {
  const rejects = (label: string, text: string) =>
    assert.throws(() => parseBackup(text), BackupError, label);

  rejects('not JSON', 'hello');
  rejects('wrong format', JSON.stringify({ format: 'something-else' }));
  rejects('newer format version', JSON.stringify({
    format: BACKUP_FORMAT, format_version: BACKUP_FORMAT_VERSION + 1, data: {} }));
  rejects('no data', JSON.stringify({ format: BACKUP_FORMAT, format_version: 1 }));
  rejects('table is not a list', JSON.stringify({
    format: BACKUP_FORMAT, format_version: 1, data: { todos: 'nope' } }));
  rejects('row missing a required field', JSON.stringify({
    format: BACKUP_FORMAT, format_version: 1, data: { todos: [{ description: 'orphan' }] } }));
});

test('warns about an unknown table instead of failing the whole file', () => {
  const p = parseBackup(JSON.stringify({
    format: BACKUP_FORMAT, format_version: 1,
    data: { todos: [], invented_table: [{ a: 1 }] },
  }));
  assert.ok(p.warnings.some((w) => w.includes('invented_table')));
});
