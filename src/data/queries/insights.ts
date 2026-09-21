/**
 * inphub lite: the Insights read model, i.e. api/insights.php's `summary`.
 *
 * One call feeds the whole view and nothing is stored. It reuses the Money
 * period vocabulary on purpose: the name money_window() is historical, the
 * maths is generic, so the two views share one set of periods rather than
 * inventing a second.
 *
 * Three details worth keeping straight, all of them inphub's:
 *
 * habit_rate is the MEAN OF PER-HABIT RATES, not a pooled ratio. Four habits at
 * 100%, 0%, 0%, 0% reads 25%, not "1 of 4 days".
 *
 * The consistency denominator is elapsed days, not the window length, so a
 * partial month is not punished for the days that have not happened yet.
 *
 * Weekday buckets are Monday-first, because MySQL's WEEKDAY() is 0 = Monday.
 * DAYOFWEEK() starts Sunday, and mixing the two silently rotates the chart.
 */

import { getAll } from '../db.ts';
import { daysBetween, localDate, weekdayIndex } from '../dates.ts';
import { allSettings } from '../settings.ts';
import { moneyWindow, type MoneyWindow } from './money-window.ts';
import { bucketOf, fillSeries, granularityFor, type Granularity } from './series.ts';
import { activityBetween } from './stats.ts';

export interface InsightsSummary {
  period: string;
  label: string;
  from: string | null;
  to: string | null;
  days: number;
  currency: string;
  granularity: Granularity;
  totals: {
    spend: number; income: number; tasks_done: number;
    focus_minutes: number; notes: number; habit_rate: number;
  };
  weekday: { dow: number; total: number; count: number }[];
  habits: { name: string; color: string; rate: number; done_days: number; days: number }[];
  focus: { d: string; value: number }[];
  velocity: { d: string; value: number }[];
  hours: { hour: number; count: number }[];
  categories: { name: string; color: string; total: number }[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r4 = (n: number): number => Math.round(n * 10000) / 10000;

const inWindow = (date: string, win: MoneyWindow): boolean =>
  win.from === null || (date >= win.from && date <= win.to!);

export async function summary(
  input: Record<string, unknown>,
  ref: Date = new Date(),
): Promise<InsightsSummary> {
  const win = moneyWindow(input, 'month');
  const today = localDate(ref);

  const [expenses, cats, todos, focusRows, notes, habitRows, habitLogs, settings] =
    await Promise.all([
      getAll('expenses'), getAll('expense_categories'), getAll('todos'),
      getAll('focus_sessions'), getAll('notes'), getAll('habits'),
      getAll('habit_logs'), allSettings(),
    ]);

  const currency = settings['base_currency'] || 'TRY';
  const windowed = expenses.filter((e) => inWindow(e.spent_at, win));

  const spend = windowed.reduce((n, e) => e.type === 'expense' ? n + e.amount : n, 0);
  const income = windowed.reduce((n, e) => e.type === 'income' ? n + e.amount : n, 0);

  const doneTodos = todos.filter((t) => t.completed_at !== null && inWindow(t.completed_at.slice(0, 10), win));
  const windowFocus = focusRows.filter((f) => inWindow(f.started_at.slice(0, 10), win));
  const focus_minutes = windowFocus.reduce((n, f) => n + f.duration_minutes, 0);
  const noteCount = notes.filter((n) => inWindow(n.created_at.slice(0, 10), win)).length;

  // Weekday: expenses only, densified to exactly seven, Monday first.
  const weekday = Array.from({ length: 7 }, (_, dow) => ({ dow, total: 0, count: 0 }));
  for (const e of windowed) {
    if (e.type !== 'expense') continue;
    const slot = weekday[weekdayIndex(e.spent_at)]!;
    slot.total += e.amount;
    slot.count += 1;
  }
  for (const w of weekday) w.total = r2(w.total);

  // Habit consistency. The denominator stops at today so a partial month is
  // measured against the days that have actually happened.
  const activeHabits = habitRows.filter((h) => h.is_active === 1);
  let days: number;
  if (win.from !== null) {
    const end = win.to! < today ? win.to! : today;
    days = Math.max(1, daysBetween(win.from, end) + 1);
  } else {
    const first = habitLogs.reduce<string | null>(
      (min, l) => (min === null || l.logged_date < min ? l.logged_date : min), null);
    days = first ? Math.max(1, daysBetween(first, today) + 1) : 1;
  }

  const habits = activeHabits
    .map((h) => {
      const target = Math.max(1, h.target_per_period);
      // Only days that MET the target count, the same rule the streaks use.
      const done = new Set(habitLogs
        .filter((l) => l.habit_id === h.id && l.count >= target && inWindow(l.logged_date, win))
        .map((l) => l.logged_date));
      return {
        name: h.name,
        color: h.color || '#4f8cff',
        done_days: done.size,
        days,
        rate: r4(Math.min(1, done.size / days)),
      };
    })
    .sort((a, b) => b.done_days - a.done_days);

  const habit_rate = habits.length
    ? r4(habits.reduce((n, h) => n + h.rate, 0) / habits.length)
    : 0;

  // Series. Same granularity rule as Money.
  const granularity = granularityFor(win.from, win.to);
  const focusMap = new Map<string, number>();
  for (const f of windowFocus) {
    const key = bucketOf(f.started_at.slice(0, 10), granularity);
    focusMap.set(key, (focusMap.get(key) ?? 0) + f.duration_minutes);
  }
  const velocityMap = new Map<string, number>();
  for (const t of doneTodos) {
    const key = bucketOf(t.completed_at!.slice(0, 10), granularity);
    velocityMap.set(key, (velocityMap.get(key) ?? 0) + 1);
  }

  // Hours of the day, from the activity log and nothing else. This is why every
  // mutation has to write a row, and why timestamps are local wall clock: store
  // UTC and every bucket shifts by the offset without the chart looking broken.
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const activity = await activityBetween(win.from, win.to);
  for (const a of activity) {
    const h = Number(a.created_at.slice(11, 13));
    if (Number.isFinite(h) && hours[h]) hours[h]!.count += 1;
  }

  // Categories: the donut query again, wider, and without the synthetic
  // Uncategorised row that the Money view appends.
  const byCat = new Map<number, number>();
  for (const e of windowed) {
    if (e.type !== 'expense' || e.category_id === null) continue;
    byCat.set(e.category_id, (byCat.get(e.category_id) ?? 0) + e.amount);
  }
  const categories = cats
    .map((c) => ({ name: c.name, color: c.color, total: r2(byCat.get(c.id) ?? 0) }))
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  return {
    period: win.period,
    label: win.label,
    from: win.from,
    to: win.to,
    days,
    currency,
    granularity,
    totals: {
      spend: r2(spend), income: r2(income), tasks_done: doneTodos.length,
      focus_minutes, notes: noteCount, habit_rate,
    },
    weekday,
    habits,
    focus: fillSeries(focusMap, granularity, win.from, win.to, 'value', ref),
    velocity: fillSeries(velocityMap, granularity, win.from, win.to, 'value', ref),
    hours,
    categories,
  };
}
