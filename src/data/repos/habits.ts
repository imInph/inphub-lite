/**
 * inphub lite: habits. The client-side api/habits.php.
 *
 * The streaks are the whole point of this file and they have two rules that are
 * easy to lose.
 *
 * A day only counts once the target is met, so a 3x-a-day habit tapped once is
 * partial rather than done. And the current streak starts from today but drops
 * to yesterday when today has not been logged yet, so opening the app in the
 * morning does not show every streak as broken.
 *
 * The toggle counts up inside one row rather than inserting several, which is
 * what makes target_per_period mean anything: the unique index on
 * (habit_id, logged_date) enforces it, and the tap after the target is reached
 * clears the day so the control stays a toggle.
 */

import { getAll, req, withTx, DataError } from '../db.ts';
import { addDays, isoWeekKey, localDate, shiftWeek, today } from '../dates.ts';
import { bulk, create, remove, SILENT, update } from '../tx.ts';
import { bool, color, enumOf, int, str, text } from '../normalize.ts';
import type { Habit, HabitFrequency, HabitLog } from '../types.ts';

const FREQUENCIES: readonly HabitFrequency[] = ['daily', 'weekly'];

/** Sized for the heatmap: 140 days is 20 weeks. */
export const HEATMAP_DAYS = 140;

export interface HabitWithLogs extends Habit {
  logs: Pick<HabitLog, 'habit_id' | 'logged_date' | 'count'>[];
  target: number;
  today_count: number;
  logged_today: boolean;
  current_streak: number;
  best_streak: number;
}

/**
 * Longest run anywhere, and the run ending now.
 *
 * `dates` are the days that met the target, ascending. Daily counts consecutive
 * days; weekly counts consecutive ISO weeks with at least one qualifying log,
 * without which a once-a-week habit read "current 1 / best 1" forever and the
 * frequency setting was decorative.
 */
export function streaks(dates: string[], frequency: HabitFrequency): [number, number] {
  if (dates.length === 0) return [0, 0];
  return frequency === 'weekly' ? weekStreaks(dates) : dayStreaks(dates);
}

function dayStreaks(dates: string[]): [number, number] {
  const set = new Set(dates);

  let best = 0;
  for (const d of set) {
    // Only walk from the start of a run, so the whole scan stays linear.
    if (set.has(addDays(d, -1))) continue;
    let len = 1;
    let cur = d;
    while (set.has(addDays(cur, 1))) {
      cur = addDays(cur, 1);
      len++;
    }
    best = Math.max(best, len);
  }

  let current = 0;
  let cursor = today();
  if (!set.has(cursor)) cursor = addDays(cursor, -1);
  while (set.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }
  return [current, best];
}

function weekStreaks(dates: string[]): [number, number] {
  const weeks = new Set(dates.map((d) => isoWeekKey(d)));

  let best = 0;
  for (const w of weeks) {
    if (weeks.has(shiftWeek(w, -1))) continue;
    let len = 1;
    let cur = w;
    while (weeks.has(shiftWeek(cur, 1))) {
      cur = shiftWeek(cur, 1);
      len++;
    }
    best = Math.max(best, len);
  }

  let current = 0;
  let cursor = isoWeekKey(today());
  if (!weeks.has(cursor)) cursor = shiftWeek(cursor, -1);
  while (weeks.has(cursor)) {
    current++;
    cursor = shiftWeek(cursor, -1);
  }
  return [current, best];
}

/** ORDER BY sort_order ASC, id ASC, with the last 140 days of logs attached. */
export async function list(): Promise<HabitWithLogs[]> {
  const [habits, allLogs] = await Promise.all([getAll('habits'), getAll('habit_logs')]);
  const since = addDays(localDate(), -HEATMAP_DAYS);
  const day = today();

  const byHabit = new Map<number, HabitLog[]>();
  for (const log of allLogs) {
    if (log.logged_date < since) continue;
    const list = byHabit.get(log.habit_id);
    if (list) list.push(log);
    else byHabit.set(log.habit_id, [log]);
  }
  for (const list of byHabit.values()) list.sort((a, b) => a.logged_date.localeCompare(b.logged_date));

  return habits
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    .map((h) => {
      const logs = byHabit.get(h.id) ?? [];
      const target = Math.max(1, h.target_per_period);
      const dates: string[] = [];
      let todayCount = 0;
      for (const l of logs) {
        if (l.count >= target) dates.push(l.logged_date);
        if (l.logged_date === day) todayCount = l.count;
      }
      const [current_streak, best_streak] = streaks(dates, h.frequency);
      return {
        ...h,
        logs: logs.map((l) => ({ habit_id: l.habit_id, logged_date: l.logged_date, count: l.count })),
        target,
        today_count: todayCount,
        logged_today: todayCount >= target,
        current_streak,
        best_streak,
      };
    });
}

function fields(input: Record<string, unknown>, base?: Habit) {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  return {
    name: text(input['name'], base?.name ?? ''),
    description: has('description') ? str(input['description']) : base?.description ?? null,
    frequency: enumOf(input['frequency'] ?? base?.frequency, FREQUENCIES, base?.frequency ?? 'daily'),
    target_per_period: Math.max(1, int(input['target_per_period'], base?.target_per_period ?? 1)),
    color: color(input['color'] ?? base?.color, base?.color ?? '#4f8cff'),
    icon: has('icon') ? str(input['icon']) : base?.icon ?? null,
    is_active: has('is_active') ? bool(input['is_active']) : base?.is_active ?? 1,
    sort_order: int(input['sort_order'], base?.sort_order ?? 0),
  };
}

// Creating, editing and deleting a habit write no activity row, matching inphub:
// the log of what you *did* is the interesting one, not the bookkeeping.
export async function createHabit(input: Record<string, unknown>): Promise<Habit> {
  const f = fields(input);
  if (!f.name) throw new DataError('Name is required.', 422);
  return create('habits', f, SILENT);
}

export async function updateHabit(id: number, input: Record<string, unknown>): Promise<Habit> {
  const existing = (await getAll('habits')).find((h) => h.id === id);
  if (!existing) throw new DataError('That habit no longer exists.', 404);
  return update('habits', id, fields(input, existing), SILENT);
}

/** relations.ts cascades the logs, as fk_hl_habit ON DELETE CASCADE did. */
export async function deleteHabit(id: number): Promise<void> {
  await remove('habits', id, SILENT);
}

export interface LogResult {
  logged: boolean;
  count: number;
  target: number;
  date: string;
}

/**
 * Advance one habit-day: absent becomes 1, below target counts up, at target
 * clears the row.
 *
 * Read first, then exactly one write through the tx.ts primitives, so the
 * cascade rules and the required activity row both still apply. The unique
 * index on (habit_id, logged_date) is what stops a double tap creating two
 * rows: the second add throws rather than inserting.
 */
export async function log(id: number, date?: string, note?: string): Promise<LogResult> {
  const habit = (await getAll('habits')).find((h) => h.id === id);
  if (!habit) throw new DataError('That habit no longer exists.', 404);

  const when = str(date) ?? today();
  const target = Math.max(1, habit.target_per_period);

  const existing = await withTx(['habit_logs'], 'readonly', (s) =>
    req((s('habit_logs') as IDBObjectStore).index('habit_date').get([id, when])),
  ) as HabitLog | undefined;

  // entity_id is the habit, not the habit_logs row: History links to the habit,
  // and a log row's id would point at nothing once the day is cleared.
  const logged = (count: number) => ({
    type: 'habit.logged' as const,
    entity_type: 'habit' as const,
    entity_id: id,
    summary: `Logged habit: ${habit.name}${target > 1 ? ` (${count}/${target})` : ''}`,
  });

  if (!existing) {
    await create('habit_logs', { habit_id: id, logged_date: when, count: 1, note: str(note) },
      () => logged(1));
    return { logged: true, count: 1, target, date: when };
  }

  if (existing.count < target) {
    const next = existing.count + 1;
    await update('habit_logs', existing.id, { count: next }, () => logged(next));
    return { logged: true, count: next, target, date: when };
  }

  await remove('habit_logs', existing.id, () => ({
    type: 'habit.unlogged',
    entity_type: 'habit',
    entity_id: id,
    summary: `Cleared habit: ${habit.name} on ${when}`,
  }));
  return { logged: false, count: 0, target, date: when };
}

/** Drag-reorder, SILENT for the same reason todos' reorder is. */
export async function reorder(ids: number[]): Promise<number> {
  const rows = await getAll('habits');
  const byId = new Map(rows.map((h) => [h.id, h]));
  const updated = ids
    .map((id, pos) => { const row = byId.get(id); return row ? { ...row, sort_order: pos } : null; })
    .filter((r): r is Habit => r !== null);
  return bulk('habits', updated, SILENT);
}
