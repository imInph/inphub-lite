/**
 * inphub lite: to-dos. The client-side api/todos.php.
 *
 * Every ordering and default here comes from that file, so keep them matched.
 * The one piece of real behaviour is regenerateRecurring(), the only recurrence
 * engine in either app: completing a recurring task inserts a fresh open copy
 * with the next due date. (expenses.is_recurring is stored and never acted on,
 * in inphub too.)
 */

import { getAll } from '../db.ts';
import { addDays, addMonths, now, today } from '../dates.ts';
import { bulk, create, remove, SILENT, update } from '../tx.ts';
import { dateOrNull, enumOf, int, str, text } from '../normalize.ts';
import { PRIORITY_ORDER, type Priority, type Todo, type TodoStatus } from '../types.ts';

const STATUSES: readonly TodoStatus[] = ['todo', 'in_progress', 'done', 'archived'];
const PRIORITIES: readonly Priority[] = ['low', 'medium', 'high', 'urgent'];

export interface TodoFilter {
  status?: string;
  project?: string;
}

/**
 * ORDER BY sort_order ASC, (due_date IS NULL), due_date ASC, id DESC.
 *
 * Note the second term: undated tasks sort last, not first, which is the
 * opposite of what a plain date comparison gives you. This is also why todos has
 * no IndexedDB index. No index expresses "nulls last, then a FIELD() ranking",
 * so it would be a cursor walk followed by the same sort in JS anyway.
 */
export function sortTodos(rows: Todo[]): Todo[] {
  return rows.sort((a, b) =>
    a.sort_order - b.sort_order
    || Number(a.due_date === null) - Number(b.due_date === null)
    || (a.due_date ?? '').localeCompare(b.due_date ?? '')
    || b.id - a.id);
}

/** Rank for FIELD(priority,'urgent','high','medium','low'). */
export function priorityRank(p: Priority): number {
  return PRIORITY_ORDER.indexOf(p);
}

export async function list(filter: TodoFilter = {}): Promise<Todo[]> {
  const rows = await getAll('todos');
  const status = str(filter.status);
  const project = str(filter.project);
  return sortTodos(rows.filter((t) =>
    (status === null || t.status === status)
    && (project === null || t.project === project)));
}

/** The fields create and update share, resolved against an existing row or the defaults. */
function fields(input: Record<string, unknown>, base?: Todo) {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  return {
    title: text(input['title'], base?.title ?? ''),
    description: has('description') ? str(input['description']) : base?.description ?? null,
    status: enumOf(input['status'] ?? base?.status, STATUSES, base?.status ?? 'todo'),
    priority: enumOf(input['priority'] ?? base?.priority, PRIORITIES, base?.priority ?? 'medium'),
    project: has('project') ? str(input['project']) : base?.project ?? null,
    tags: has('tags') ? str(input['tags']) : base?.tags ?? null,
    due_date: has('due_date') ? dateOrNull(input['due_date']) : base?.due_date ?? null,
    recurring: has('recurring') ? str(input['recurring']) : base?.recurring ?? null,
  };
}

export async function createTodo(input: Record<string, unknown>): Promise<Todo> {
  const f = fields(input);
  if (!f.title) throw Object.assign(new Error('Title is required.'), { status: 422 });
  const at = now();
  return create('todos', {
    ...f,
    sort_order: int(input['sort_order'], 0),
    created_by: 'user',
    updated_at: at,
    completed_at: null,
  }, (row) => ({ type: 'todo.created', entity_type: 'todo', summary: `Added todo: ${row.title}` }));
}

export async function updateTodo(id: number, input: Record<string, unknown>): Promise<Todo> {
  const existing = await getOne(id);
  const f = fields(input, existing);
  // completed_at has to track status, or a task un-checked in the UI keeps its
  // old timestamp and stays filed under "done" in that week of History forever.
  // Set once on the way to done, preserved on a re-save, cleared on the way out.
  const completed_at = f.status === 'done' ? existing.completed_at ?? now() : null;
  return update('todos', id, { ...f, completed_at },
    (_before, after) => ({ type: 'todo.updated', entity_type: 'todo', summary: `Updated todo: ${after.title}` }));
}

export async function completeTodo(id: number): Promise<{ id: number; regenerated: Todo | null }> {
  const existing = await getOne(id);
  await update('todos', id, { status: 'done', completed_at: now() },
    () => ({ type: 'todo.completed', entity_type: 'todo', summary: `Completed: ${existing.title}` }));
  const regenerated = existing.recurring ? await regenerateRecurring(existing) : null;
  return { id, regenerated };
}

export async function deleteTodo(id: number): Promise<void> {
  await remove('todos', id,
    (row) => ({ type: 'todo.deleted', entity_type: 'todo', summary: `Deleted todo: ${row.title}` }));
}

/**
 * Write the new order, position by array index.
 *
 * SILENT because this fires on every drag, and a History full of "reordered"
 * lines would bury everything that actually happened.
 */
export async function reorder(ids: number[]): Promise<number> {
  const rows = await getAll('todos');
  const byId = new Map(rows.map((t) => [t.id, t]));
  const updated = ids
    .map((id, pos) => { const row = byId.get(id); return row ? { ...row, sort_order: pos } : null; })
    .filter((r): r is Todo => r !== null);
  return bulk('todos', updated, SILENT);
}

/**
 * Advance a recurring task's due date and insert a fresh open copy.
 *
 * The base is the old due date, falling back to today when it had none, and
 * addMonths() keeps PHP's overflow so 31 January rolls to 3 March exactly as it
 * does in inphub. An unknown interval regenerates nothing rather than guessing.
 *
 * SILENT: completeTodo() has already written the "Completed" line, and a second
 * row for the copy it made would read like you added a task you didn't.
 */
async function regenerateRecurring(todo: Todo): Promise<Todo | null> {
  const base = todo.due_date ?? today();
  const next = todo.recurring === 'daily' ? addDays(base, 1)
    : todo.recurring === 'weekly' ? addDays(base, 7)
    : todo.recurring === 'monthly' ? addMonths(base, 1)
    : null;
  if (next === null) return null;

  return create('todos', {
    title: todo.title,
    description: todo.description,
    status: 'todo',
    priority: todo.priority,
    project: todo.project,
    tags: todo.tags,
    due_date: next,
    recurring: todo.recurring,
    sort_order: todo.sort_order,
    created_by: todo.created_by,
    updated_at: now(),
    completed_at: null,
  }, SILENT);
}

async function getOne(id: number): Promise<Todo> {
  const rows = await getAll('todos');
  const row = rows.find((t) => t.id === id);
  if (!row) throw Object.assign(new Error('That task no longer exists.'), { status: 404 });
  return row;
}

/** Distinct project names, for the filter chips. */
export async function projects(): Promise<string[]> {
  const rows = await getAll('todos');
  return [...new Set(rows.map((t) => t.project).filter((p): p is string => !!p))].sort();
}
