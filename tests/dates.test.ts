/**
 * The date layer is where a wrong answer is cheapest to produce and hardest to
 * spot, so it gets the tests. The expected values are PHP's, i.e. the answers
 * inphub gives, because the two have to agree on the same data.
 *
 * Runs with a fixed TZ (see package.json). A machine set to UTC would pass some
 * of these by accident.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays, addMonths, daysBetween, isoWeekKey, isoWeekStart, localDate,
  localDateTime, monthBounds, monthKey, parseDate, shiftWeek, weekdayIndex,
} from '../src/data/dates.ts';

test('localDate / localDateTime use local wall clock, never UTC', () => {
  // 00:30 local on the 21st is still the 20th in UTC for a positive offset.
  const d = new Date(2026, 8, 21, 0, 30, 15);
  assert.equal(localDate(d), '2026-09-21');
  assert.equal(localDateTime(d), '2026-09-21T00:30:15');
  assert.equal(monthKey(d), '2026-09');
  // The whole point: the ISO form would say something else.
  assert.notEqual(localDateTime(d), d.toISOString().slice(0, 19));
});

test('parseDate reads YYYY-MM-DD as local midnight', () => {
  const d = parseDate('2026-09-21');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 21);
  assert.equal(d.getHours(), 0);
});

test('isoWeekKey matches PHP date("o-W"), including ISO-year boundaries', () => {
  assert.equal(isoWeekKey('2026-09-20'), '2026-38', 'Sunday closes the week');
  assert.equal(isoWeekKey('2026-09-21'), '2026-39', 'Monday opens the next');
  assert.equal(isoWeekKey('2026-01-01'), '2026-01');
  // A January date whose ISO year is the previous calendar year, and vice versa.
  assert.equal(isoWeekKey('2027-01-01'), '2026-53');
  assert.equal(isoWeekKey('2025-12-29'), '2026-01');
  assert.equal(isoWeekKey('2024-12-30'), '2025-01');
});

test('isoWeekStart is the Monday', () => {
  assert.equal(isoWeekStart('2026-09-20'), '2026-09-14');
  assert.equal(isoWeekStart('2026-09-21'), '2026-09-21');
});

test('shiftWeek crosses year boundaries', () => {
  assert.equal(shiftWeek('2026-01', -1), '2025-52');
  assert.equal(shiftWeek('2026-53', 1), '2027-01');
  assert.equal(shiftWeek('2026-38', 1), '2026-39');
  assert.equal(shiftWeek('2026-38', -1), '2026-37');
});

test('monthBounds never overflows (the money_period_range gotcha)', () => {
  // date('Y-m-01', strtotime('-1 month')) on 31 March lands back in March.
  // Building from day 1 of the target month cannot.
  const mar31 = new Date(2026, 2, 31);
  assert.deepEqual(monthBounds(-1, mar31), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthBounds(0, mar31), { from: '2026-03-01', to: '2026-03-31' });
  const jan31 = new Date(2026, 0, 31);
  assert.deepEqual(monthBounds(-2, jan31), { from: '2025-11-01', to: '2025-11-30' });
  // Leap year February.
  assert.deepEqual(monthBounds(0, new Date(2028, 1, 29)), { from: '2028-02-01', to: '2028-02-29' });
});

test('addMonths keeps PHP strtotime("+1 month") overflow on purpose', () => {
  // inphub's recurring to-dos land on 3 March, so lite's must too.
  assert.equal(addMonths('2026-01-31', 1), '2026-03-03');
  assert.equal(addMonths('2026-01-15', 1), '2026-02-15');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
});

test('addDays and daysBetween survive year and DST boundaries', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(daysBetween('2026-03-01', '2026-04-01'), 31);
  assert.equal(daysBetween('2026-04-01', '2026-03-01'), -31);
  assert.equal(daysBetween('2026-09-21', '2026-09-21'), 0);
});

test('weekdayIndex is Monday-first, like MySQL WEEKDAY()', () => {
  assert.equal(weekdayIndex('2026-09-21'), 0, 'Monday');
  assert.equal(weekdayIndex('2026-09-26'), 5, 'Saturday');
  assert.equal(weekdayIndex('2026-09-20'), 6, 'Sunday');
});
