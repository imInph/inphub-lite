/**
 * inphub lite: goals. The client-side api/goals.php.
 *
 * Goals hold integers only and the server never computes a percentage; the
 * progress bar is the view's current/target. nudge() is the one piece of real
 * behaviour: it floors at zero and auto-completes one way, so passing the
 * target marks the goal done but dropping back below it does not undo that.
 */

import { getAll, DataError } from '../db.ts';
import { create, remove, SILENT, update } from '../tx.ts';
import { dateOrNull, enumOf, int, intOrNull, str, text } from '../normalize.ts';
import { GOAL_STATUS_ORDER, type Goal, type GoalStatus } from '../types.ts';

/** ORDER BY status ASC (enum order), (target_date IS NULL), target_date ASC, id DESC. */
export async function list(): Promise<Goal[]> {
  const rows = await getAll('goals');
  return rows.sort((a, b) =>
    GOAL_STATUS_ORDER.indexOf(a.status) - GOAL_STATUS_ORDER.indexOf(b.status)
    || Number(a.target_date === null) - Number(b.target_date === null)
    || (a.target_date ?? '').localeCompare(b.target_date ?? '')
    || b.id - a.id);
}

function fields(input: Record<string, unknown>, base?: Goal) {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  return {
    title: text(input['title'], base?.title ?? ''),
    description: has('description') ? str(input['description']) : base?.description ?? null,
    category: has('category') ? str(input['category']) : base?.category ?? null,
    target_value: has('target_value') ? intOrNull(input['target_value']) : base?.target_value ?? null,
    current_value: int(input['current_value'], base?.current_value ?? 0),
    unit: has('unit') ? str(input['unit']) : base?.unit ?? null,
    target_date: has('target_date') ? dateOrNull(input['target_date']) : base?.target_date ?? null,
    status: enumOf(input['status'] ?? base?.status, GOAL_STATUS_ORDER, base?.status ?? 'active'),
  };
}

export async function createGoal(input: Record<string, unknown>): Promise<Goal> {
  const f = fields(input);
  if (!f.title) throw new DataError('Title is required.', 422);
  return create('goals', { ...f, updated_at: new Date().toISOString().slice(0, 19) },
    (row) => ({ type: 'goal.created', entity_type: 'goal', summary: `Added goal: ${row.title}` }));
}

/** No activity row, matching inphub: editing the wording is not an event. */
export async function updateGoal(id: number, input: Record<string, unknown>): Promise<Goal> {
  const existing = (await getAll('goals')).find((g) => g.id === id);
  if (!existing) throw new DataError('That goal no longer exists.', 404);
  return update('goals', id, fields(input, existing), SILENT);
}

export async function deleteGoal(id: number): Promise<void> {
  await remove('goals', id, SILENT);
}

/**
 * Move a goal's progress. Floors at zero, and crossing the target completes it
 * one way only: dropping back below does not reopen it, because "I finished
 * this" is a decision, not a number.
 */
export async function nudge(id: number, delta: number): Promise<{ id: number; current_value: number; status: GoalStatus }> {
  const existing = (await getAll('goals')).find((g) => g.id === id);
  if (!existing) throw new DataError('That goal no longer exists.', 404);

  const current_value = Math.max(0, existing.current_value + Math.trunc(delta));
  const status: GoalStatus =
    existing.target_value !== null && current_value >= existing.target_value && existing.status === 'active'
      ? 'completed'
      : existing.status;

  await update('goals', id, { current_value, status }, () => ({
    type: 'goal.progress',
    entity_type: 'goal',
    summary: `${existing.title} → ${current_value}${existing.unit ? ' ' + existing.unit : ''}`,
  }));
  return { id, current_value, status };
}
