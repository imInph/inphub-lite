/**
 * The period windows and the series fill. Both are pure, both are wrong in ways
 * that still draw a plausible chart, and both are what Money and Insights are
 * built on, so they get pinned here against PHP's answers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { moneyPeriodRange, moneyWindow, moneyMonthRange } from '../src/data/queries/money-window.ts';
import { fillSeries, granularityFor, bucketOf } from '../src/data/queries/series.ts';

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d);

test('periods are whole calendar months, inclusive', () => {
  const ref = at(2026, 9, 21);
  assert.deepEqual(moneyPeriodRange('month', ref), { from: '2026-09-01', to: '2026-09-30', label: 'This month' });
  assert.deepEqual(moneyPeriodRange('last_month', ref), { from: '2026-08-01', to: '2026-08-31', label: 'Last month' });
  assert.deepEqual(moneyPeriodRange('3m', ref), { from: '2026-07-01', to: '2026-09-30', label: 'Last 3 months' });
  assert.deepEqual(moneyPeriodRange('6m', ref), { from: '2026-04-01', to: '2026-09-30', label: 'Last 6 months' });
  assert.deepEqual(moneyPeriodRange('year', ref), { from: '2026-01-01', to: '2026-12-31', label: 'This year' });
  assert.deepEqual(moneyPeriodRange('all', ref), { from: null, to: null, label: 'All time' });
});

test('periods do not overflow on the 29th to the 31st', () => {
  // The documented bug: date('Y-m-01', strtotime('-1 month')) on 31 March
  // lands back in March. Every one of these must step a whole month.
  assert.equal(moneyPeriodRange('last_month', at(2026, 3, 31)).from, '2026-02-01');
  assert.equal(moneyPeriodRange('last_month', at(2026, 3, 31)).to, '2026-02-28');
  assert.equal(moneyPeriodRange('last_month', at(2026, 5, 31)).from, '2026-04-01');
  assert.equal(moneyPeriodRange('3m', at(2026, 3, 31)).from, '2026-01-01');
  assert.equal(moneyPeriodRange('6m', at(2026, 1, 31)).from, '2025-08-01');
  // Leap year.
  assert.equal(moneyPeriodRange('last_month', at(2028, 3, 31)).to, '2028-02-29');
});

test('moneyWindow: period wins, month is the fallback, junk falls back', () => {
  assert.equal(moneyWindow({ period: '3m' }).period, '3m');
  assert.equal(moneyWindow({ period: 'nonsense' }).period, 'month');
  assert.equal(moneyWindow({ period: 'nonsense' }, 'all').period, 'all');
  // No period at all: the caller's default decides, which is why the expense
  // list passes 'all' and the Money view passes 'month'.
  assert.equal(moneyWindow({}).period, 'month');
  assert.equal(moneyWindow({}, 'all').from, null);
  // Legacy month=YYYY-MM.
  assert.deepEqual(moneyMonthRange('2026-02')!.from, '2026-02-01');
  assert.deepEqual(moneyMonthRange('2026-02')!.to, '2026-02-28');
  assert.equal(moneyMonthRange('2026-13'), null);
  assert.equal(moneyMonthRange('nope'), null);
});

test('granularity switches at exactly 62 days', () => {
  assert.equal(granularityFor('2026-09-01', '2026-09-30'), 'day');
  // 62 days inclusive is still daily; 63 is monthly.
  assert.equal(granularityFor('2026-07-01', '2026-08-31'), 'day');
  assert.equal(granularityFor('2026-07-01', '2026-09-01'), 'month');
  assert.equal(granularityFor(null, null), 'month');
});

test('fillSeries emits every bucket in the window, zeros included', () => {
  const map = new Map([['2026-09-03', 50]]);
  const out = fillSeries(map, 'day', '2026-09-01', '2026-09-05', 'total', at(2026, 9, 5));
  assert.deepEqual(out.map((p) => p.d), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
  assert.deepEqual(out.map((p) => p.total), [0, 0, 50, 0, 0]);
});

test('fillSeries runs past today to the newest entry, then caps at the window', () => {
  // Post-dated rent. Stopping at today would draw a line that disagrees with
  // the totals above it.
  const map = new Map([['2026-09-25', 900]]);
  const out = fillSeries(map, 'day', '2026-09-01', '2026-09-30', 'total', at(2026, 9, 21));
  assert.equal(out.at(-1)!.d, '2026-09-25');
  assert.equal(out.at(-1)!.total, 900);

  // An entry beyond the window end is capped rather than extending it.
  const beyond = new Map([['2026-12-01', 10]]);
  const capped = fillSeries(beyond, 'day', '2026-09-01', '2026-09-30', 'total', at(2026, 9, 21));
  assert.equal(capped.at(-1)!.d, '2026-09-30');
});

test('fillSeries walks months from day 1, so no bucket is skipped or doubled', () => {
  const map = new Map([['2026-01', 5], ['2026-03', 7]]);
  const out = fillSeries(map, 'month', '2025-12-31', '2026-04-30', 'total', at(2026, 4, 30));
  assert.deepEqual(out.map((p) => p.d), ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04']);
  assert.deepEqual(out.map((p) => p.total), [0, 5, 0, 7, 0]);
});

test('fillSeries on an unbounded window starts at the oldest entry', () => {
  const map = new Map([['2026-07', 1], ['2026-09', 2]]);
  const out = fillSeries(map, 'month', null, null, 'total', at(2026, 9, 21));
  assert.deepEqual(out.map((p) => p.d), ['2026-07', '2026-08', '2026-09']);
  // Nothing at all and no window: an empty chart, not a fabricated one.
  assert.deepEqual(fillSeries(new Map(), 'month', null, null, 'total'), []);
});

test('fillSeries uses the caller value key', () => {
  const out = fillSeries(new Map([['2026-09-01', 3]]), 'day', '2026-09-01', '2026-09-01', 'value');
  assert.deepEqual(out, [{ d: '2026-09-01', value: 3 }]);
});

test('bucketOf', () => {
  assert.equal(bucketOf('2026-09-21', 'day'), '2026-09-21');
  assert.equal(bucketOf('2026-09-21', 'month'), '2026-09');
});
