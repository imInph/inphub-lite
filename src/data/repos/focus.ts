/**
 * inphub lite: focus sessions. The client-side api/focus.php.
 *
 * The timer itself has always lived in the browser; the server only ever
 * recorded finished sessions, so this is the one view where almost nothing
 * moved. The view still keeps its running state in localStorage and survives a
 * reload the same way.
 *
 * Interrupted sessions count in every total. `completed` is recorded and never
 * filtered on, because twenty minutes you stopped early is still twenty minutes
 * you spent.
 */

import { getAll, DataError } from '../db.ts';
import { addDays, localDate, now } from '../dates.ts';
import { create, remove } from '../tx.ts';
import { bool, dateTimeOrNull, int, intOrNull, str } from '../normalize.ts';
import type { FocusSession } from '../types.ts';

export interface FocusRow extends FocusSession {
  todo_title: string | null;
}

export interface FocusSummary {
  sessions: FocusRow[];
  today_total: number;
  week_total: number;
  all_total: number;
  session_count: number;
  /** Exactly seven ascending entries, today-6 through today. */
  weekly: { date: string; minutes: number }[];
}

export async function list(): Promise<FocusSummary> {
  const [rows, todos] = await Promise.all([getAll('focus_sessions'), getAll('todos')]);
  const titles = new Map(todos.map((t) => [t.id, t.title]));

  const today = localDate();
  const weekStart = addDays(today, -6);

  let today_total = 0;
  let week_total = 0;
  let all_total = 0;
  const perDay = new Map<string, number>();

  for (const s of rows) {
    const day = s.started_at.slice(0, 10);
    all_total += s.duration_minutes;
    if (day === today) today_total += s.duration_minutes;
    if (day >= weekStart) {
      week_total += s.duration_minutes;
      perDay.set(day, (perDay.get(day) ?? 0) + s.duration_minutes);
    }
  }

  // Densified to exactly seven entries, so the bar chart always draws a week
  // rather than however many days happened to have a session.
  const weekly: { date: string; minutes: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    weekly.push({ date: d, minutes: perDay.get(d) ?? 0 });
  }

  const sessions = rows
    .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id - a.id)
    .slice(0, 30)
    .map((s) => ({
      ...s,
      todo_title: s.linked_todo_id === null ? null : titles.get(s.linked_todo_id) ?? null,
    }));

  return { sessions, today_total, week_total, all_total, session_count: rows.length, weekly };
}

/** Record a finished session. The only write this view makes. */
export async function logSession(input: Record<string, unknown>): Promise<FocusSession> {
  const duration = int(input['duration_minutes'], 0);
  if (duration <= 0) throw new DataError('duration_minutes must be positive.', 422);

  const linked = intOrNull(input['linked_todo_id']);
  if (linked !== null) {
    const exists = (await getAll('todos')).some((t) => t.id === linked);
    if (!exists) throw new DataError('That task no longer exists.', 404);
  }

  const completed = input['completed'] === undefined ? 1 : bool(input['completed'], 1);
  const label = str(input['label']);

  return create('focus_sessions', {
    label,
    linked_todo_id: linked,
    duration_minutes: duration,
    started_at: dateTimeOrNull(input['started_at']) ?? now(),
    ended_at: dateTimeOrNull(input['ended_at']) ?? now(),
    completed,
  }, () => ({
    type: completed ? 'focus.completed' : 'focus.stopped',
    entity_type: 'focus',
    summary: (completed ? `Focused ${duration} min` : `Stopped after ${duration} min`)
      + (label ? `: ${label}` : ''),
  }));
}

export async function deleteSession(id: number): Promise<void> {
  await remove('focus_sessions', id, (row) => ({
    type: 'focus.deleted',
    entity_type: 'focus',
    summary: `Deleted a ${row.duration_minutes} min session`,
  }));
}
