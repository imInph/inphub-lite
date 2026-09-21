/**
 * The fold, pinned against what MySQL's utf8mb4_unicode_ci actually did.
 *
 * inphub's CLAUDE.md names the exact case that matters:
 * İSTANBUL, istanbul and ıstanbul all match each other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fold, foldIncludes, foldStartsWith } from '../src/data/fold.ts';

test('the four Turkish i forms all fold together', () => {
  const forms = ['İSTANBUL', 'ISTANBUL', 'istanbul', 'ıstanbul', 'İstanbul', 'Istanbul'];
  const folded = forms.map(fold);
  assert.deepEqual([...new Set(folded)], ['istanbul'], `got ${JSON.stringify(folded)}`);
});

test('this is exactly what toLocaleLowerCase("tr") gets wrong', () => {
  // Turkish lowercasing keeps the distinction, so these would not match.
  assert.notEqual('ISTANBUL'.toLocaleLowerCase('tr'), 'istanbul');
  // The fold does match, which is the behaviour inphub has.
  assert.equal(fold('ISTANBUL'), fold('istanbul'));
});

test('the rest of the Turkish alphabet folds to ascii', () => {
  assert.equal(fold('ŞĞÜÖÇİ'), 'sguoci');
  assert.equal(fold('şğüöçı'), 'sguoci');
  assert.equal(fold('Kahvaltı'), 'kahvalti');
  assert.equal(fold('KAHVALTI'), 'kahvalti');
});

test('a search typed either way finds the other', () => {
  assert.ok(foldIncludes('Kahvaltı ve çay', 'kahvalti'));
  assert.ok(foldIncludes('Kahvaltı ve çay', 'KAHVALTI'));
  assert.ok(foldIncludes('Kahvaltı ve çay', 'ÇAY'));
  assert.ok(foldIncludes('Kahvaltı ve çay', 'cay'));
  assert.ok(!foldIncludes('Kahvaltı ve çay', 'kahve'));
});

test('other accented scripts fold too, as unicode_ci does', () => {
  assert.equal(fold('Café'), 'cafe');
  assert.equal(fold('MÜNCHEN'), 'munchen');
  assert.equal(fold('naïve'), 'naive');
});

test('prefix matching for the search ranking boost', () => {
  assert.ok(foldStartsWith('İstanbul trip', 'ista'));
  assert.ok(!foldStartsWith('Trip to İstanbul', 'ista'));
});

test('folding is idempotent and safe on empty input', () => {
  assert.equal(fold(fold('İSTANBUL')), fold('İSTANBUL'));
  assert.equal(fold(''), '');
});
