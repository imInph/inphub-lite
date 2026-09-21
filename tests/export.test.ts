/**
 * fputcsv() did the quoting before, so the escaper here is hand-written and
 * gets tested. The BOM is not decoration either: without it Excel reads a
 * Turkish column as mojibake and the obvious conclusion is a broken export.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toCsv } from '../src/data/export.ts';

test('toCsv quotes only what needs it', () => {
  const csv = toCsv(['a', 'b'], [['plain', 'has, comma'], ['has "quotes"', 'has\nnewline']]);
  // Split on the record separator only. A newline inside a quoted cell belongs
  // to that cell and must not start a new record, which is the point of quoting.
  const lines = csv.replace('\uFEFF', '').trimEnd().split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'a,b');
  assert.equal(lines[1], 'plain,"has, comma"');
  // Embedded quotes double, as in RFC 4180.
  assert.equal(lines[2], '"has ""quotes""","has\nnewline"');
});

test('toCsv starts with a UTF-8 BOM', () => {
  assert.equal(toCsv(['x'], [['y']]).charCodeAt(0), 0xFEFF);
});

test('toCsv renders null and undefined as empty, not as the word', () => {
  const row = toCsv(['a', 'b', 'c'], [[null, undefined, 0]]).replace('﻿', '').trimEnd().split('\r\n')[1];
  assert.equal(row, ',,0');
});

test('toCsv keeps Turkish characters intact', () => {
  assert.ok(toCsv(['ad'], [['Kahvaltı ve İçecek']]).includes('Kahvaltı ve İçecek'));
});
