/**
 * Streaks, pinned against inphub's answers.
 *
 * The two rules that are easy to lose: a day only counts once the target is
 * met, and the current streak drops to yesterday when today is not logged yet,
 * so opening the app in the morning does not show every streak as broken.
 *
 * `today()` reads the clock, so these fix it by generating dates relative to a
 * known day rather than hardcoding one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { streaks } from '../src/data/repos/habits.ts';
import { addDays, localDate, isoWeekKey } from '../src/data/dates.ts';

const TODAY = localDate();
const ago = (n: number) => addDays(TODAY, -n);

test('daily: a run ending today', () => {
  assert.deepEqual(streaks([ago(2), ago(1), TODAY], 'daily'), [3, 3]);
});

test('daily: today not logged yet still counts the run to yesterday', () => {
  // The grace rule. Without it every streak reads 0 until you log that morning.
  assert.deepEqual(streaks([ago(3), ago(2), ago(1)], 'daily'), [3, 3]);
});

test('daily: a gap ends the current streak but not the best', () => {
  //  best is the 4-day run; current is only the 2 days ending today.
  const dates = [ago(9), ago(8), ago(7), ago(6), ago(1), TODAY];
  assert.deepEqual(streaks(dates, 'daily'), [2, 4]);
});

test('daily: missing both today and yesterday is a broken streak', () => {
  assert.deepEqual(streaks([ago(5), ago(4), ago(3)], 'daily'), [0, 3]);
});

test('daily: one day, and none at all', () => {
  assert.deepEqual(streaks([TODAY], 'daily'), [1, 1]);
  assert.deepEqual(streaks([], 'daily'), [0, 0]);
});

test('daily: order and duplicates do not matter', () => {
  assert.deepEqual(streaks([TODAY, ago(2), ago(1), TODAY], 'daily'), [3, 3]);
});

test('daily: a run across a year boundary is still one run', () => {
  const dates = ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'];
  assert.equal(streaks(dates, 'daily')[1], 4);
});

test('weekly: consecutive ISO weeks, one qualifying log each', () => {
  // A once-a-week habit read "current 1 / best 1" forever before the weekly
  // branch existed, which made the frequency setting decorative.
  const dates = [ago(21), ago(14), ago(7), TODAY];
  const [current, best] = streaks(dates, 'weekly');
  assert.ok(best >= 4, `best was ${best}`);
  assert.ok(current >= 4, `current was ${current}`);
});

test('weekly: this week not logged yet falls back to last week', () => {
  // Exact multiples of 7, so each date is a whole ISO week back whatever
  // weekday today is. An offset of 8 lands two weeks back and leaves a real
  // gap, which correctly reads as a broken streak.
  const dates = [ago(14), ago(7)];
  assert.deepEqual(streaks(dates, 'weekly'), [2, 2]);
});

test('weekly: a gap one week back really is broken', () => {
  assert.deepEqual(streaks([ago(21), ago(14)], 'weekly'), [0, 2]);
});

test('weekly: several logs in one week count once', () => {
  const dates = ['2026-09-21', '2026-09-22', '2026-09-23'];
  assert.equal(new Set(dates.map(isoWeekKey)).size, 1);
  assert.equal(streaks(dates, 'weekly')[1], 1);
});

test('weekly: a run spanning the ISO year boundary', () => {
  // 2026-W53 runs into 2027-W01; a naive year+week comparison breaks here.
  const dates = ['2026-12-28', '2027-01-04', '2027-01-11'];
  assert.equal(streaks(dates, 'weekly')[1], 3);
});
