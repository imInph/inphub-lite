/**
 * inphub lite: the shim the views still call.
 *
 * inphub's views talk to the backend through exactly two functions, and after
 * dropping AI and auth about thirty-six (endpoint, action) pairs survive. Rather
 * than rewrite eleven dense view modules to gain typing on three lines each,
 * those two functions keep their signatures and their ApiError, and dispatch
 * into src/data instead of fetch(). The views port with tiny diffs.
 *
 * The Routes map below is what makes that worth doing rather than just tolerable.
 * inphub's apiGet<T> was a type assertion, not a type, because the other end was
 * PHP; here the handler is in the same tsconfig, so the return type is knowable.
 * Routes gives back real inference and turns a typo'd action into a compile
 * error, and it costs nothing at the call sites. The few places that compute an
 * action (`apiPost('goals', g ? 'update' : 'create', ...)`) still work: TS
 * narrows to a union and indexing Routes with a union gives a union back.
 *
 * Don't add new code that calls this. src/data is the real API; the shim exists
 * so the ported views don't all have to change on day one. Views that need real
 * work anyway (repos, settings, insights, dashboard) go straight to src/data.
 */

import { DataError } from './data/db.ts';
import * as todos from './data/repos/todos.ts';
import * as expenses from './data/repos/expenses.ts';
import * as categories from './data/repos/categories.ts';
import * as habits from './data/repos/habits.ts';
import * as goals from './data/repos/goals.ts';
import * as notes from './data/repos/notes.ts';
import * as focus from './data/repos/focus.ts';
import * as repos from './data/repos/repos.ts';
import * as activity from './data/repos/activity.ts';
import { allSettings, saveSettings } from './data/settings.ts';
import { expenseCharts, type ExpenseCharts } from './data/queries/stats.ts';
import { search, type SearchResult } from './data/queries/search.ts';
import { dashboard, type DashData } from './data/queries/stats.ts';
import { summary as insightsSummary, type InsightsSummary } from './data/queries/insights.ts';
import type { Activity, ExpenseCategory, Goal, Note, Todo } from './data/types.ts';

/* ----------------------------------------------------------------- errors */

/**
 * Kept because view code reads `.status`. The numbers carry over from HTTP, but
 * they mean local things now: 0 is "no database" (private browsing, blocked site
 * data), 404 unknown route or missing row, 409 a unique-index collision, 422
 * validation, 500 anything unexpected out of IndexedDB.
 *
 * inphub's 401-to-login redirect is gone with the login page.
 */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/* ----------------------------------------------------------------- routes */

type Query = Record<string, string | number | undefined>;
type Body = Record<string, unknown>;

/**
 * Every route the views may call, with the shape it answers.
 * Add an entry when a view lands; the handler table below has to match it.
 */
export interface Routes {
  'todos.list': { in: Query; out: Todo[] };
  'todos.create': { in: Body; out: Todo };
  'todos.update': { in: Body; out: Todo };
  'todos.complete': { in: Body; out: { id: number; regenerated: Todo | null } };
  'todos.delete': { in: Body; out: void };
  'todos.reorder': { in: Body; out: number };

  'expenses.list': { in: Query; out: expenses.ExpenseRow[] };
  'expenses.create': { in: Body; out: { id: number } };
  'expenses.update': { in: Body; out: { id: number } };
  'expenses.delete': { in: Body; out: void };

  'categories.list': { in: Query; out: ExpenseCategory[] };
  'categories.create': { in: Body; out: ExpenseCategory };
  'categories.update': { in: Body; out: ExpenseCategory };
  'categories.delete': { in: Body; out: void };

  'stats.expenses': { in: Query; out: ExpenseCharts };
  'search.search': { in: Query; out: SearchResult };

  'repos.list': { in: Query; out: repos.RepoList };
  'repos.detail': { in: Query; out: repos.RepoRow };
  'repos.pin': { in: Body; out: { id: number } };
  'repos.delete': { in: Body; out: void };
  'sync_repos.sync': { in: Body; out: { synced: number } };

  'stats.dashboard': { in: Query; out: DashData };
  'insights.summary': { in: Query; out: InsightsSummary };
  'activity.list': { in: Query; out: Activity[] };

  'settings.get': { in: Query; out: Record<string, string> };
  'settings.save': { in: Body; out: { saved: number } };

  'habits.list': { in: Query; out: habits.HabitWithLogs[] };
  'habits.create': { in: Body; out: { id: number } };
  'habits.update': { in: Body; out: { id: number } };
  'habits.delete': { in: Body; out: void };
  'habits.log': { in: Body; out: habits.LogResult };
  'habits.reorder': { in: Body; out: number };

  'goals.list': { in: Query; out: Goal[] };
  'goals.create': { in: Body; out: { id: number } };
  'goals.update': { in: Body; out: { id: number } };
  'goals.delete': { in: Body; out: void };
  'goals.nudge': { in: Body; out: { id: number; current_value: number; status: string } };

  'notes.list': { in: Query; out: Note[] };
  'notes.create': { in: Body; out: { id: number } };
  'notes.update': { in: Body; out: { id: number } };
  'notes.pin': { in: Body; out: { id: number } };
  'notes.delete': { in: Body; out: void };

  'focus.list': { in: Query; out: focus.FocusSummary };
  'focus.log': { in: Body; out: { id: number } };
  'focus.delete': { in: Body; out: void };
}

export type RouteKey = keyof Routes;

/**
 * Pull the endpoints and their actions back out of Routes so the two arguments
 * constrain each other. Without this the generics accept any pair of strings and
 * a typo resolves to `never` in silence, which compiles fine and fails at run
 * time. With it, 'todoz' or 'lsit' is a compile error at the call site.
 */
// The `K = RouteKey` parameter is load-bearing: a conditional only distributes
// over a union when the checked type is a NAKED type parameter. Writing
// `RouteKey extends ...` directly does not distribute, so with more than one
// endpoint in Routes the infer collapses to never and every call site fails.
type Endpoint<K = RouteKey> = K extends `${infer E}.${string}` ? E : never;
type ActionOf<E extends string, K = RouteKey> = K extends `${E}.${infer A}` ? A : never;
type Result<K> = K extends RouteKey ? Routes[K]['out'] : never;

type Handler = (input: Record<string, unknown>) => Promise<unknown>;

const num = (v: unknown): number => Number(v);

/**
 * Query values arrive as strings because that is what a URL carries. That was
 * the wire format when the other end was PHP; here it is just something to undo,
 * and it is where a silent NaN would otherwise get in.
 */
const HANDLERS: Record<RouteKey, Handler> = {
  'todos.list': (i) => todos.list(i as todos.TodoFilter),
  'todos.create': (i) => todos.createTodo(i),
  'todos.update': (i) => todos.updateTodo(num(i['id']), i),
  'todos.complete': (i) => todos.completeTodo(num(i['id'])),
  'todos.delete': (i) => todos.deleteTodo(num(i['id'])),
  'todos.reorder': (i) => todos.reorder((i['order'] as unknown[] ?? []).map(num)),

  'expenses.list': (i) => expenses.list(i as expenses.ExpenseFilter),
  'expenses.create': async (i) => ({ id: (await expenses.createExpense(i)).id }),
  'expenses.update': async (i) => ({ id: (await expenses.updateExpense(num(i['id']), i)).id }),
  'expenses.delete': (i) => expenses.deleteExpense(num(i['id'])),

  'categories.list': () => categories.list(),
  'categories.create': (i) => categories.createCategory(i),
  'categories.update': (i) => categories.updateCategory(num(i['id']), i),
  'categories.delete': (i) => categories.deleteCategory(num(i['id'])),

  'stats.expenses': (i) => expenseCharts(i),
  'search.search': (i) => search(i),

  'repos.list': () => repos.list(),
  'repos.detail': (i) => repos.detail(num(i['id'])),
  'repos.pin': async (i) => ({ id: (await repos.pin(num(i['id']), i['pinned'])).id }),
  'repos.delete': (i) => repos.deleteRepo(num(i['id'])),
  'sync_repos.sync': () => repos.sync(),

  'stats.dashboard': () => dashboard(),
  'insights.summary': (i) => insightsSummary(i),
  'activity.list': (i) => activity.list(i as activity.ActivityFilter),

  'settings.get': () => allSettings(),
  'settings.save': async (i) => {
    const values = (i['settings'] ?? {}) as Record<string, string>;
    await saveSettings(values);
    return { saved: Object.keys(values).length };
  },

  'habits.list': () => habits.list(),
  'habits.create': async (i) => ({ id: (await habits.createHabit(i)).id }),
  'habits.update': async (i) => ({ id: (await habits.updateHabit(num(i['id']), i)).id }),
  'habits.delete': (i) => habits.deleteHabit(num(i['id'])),
  'habits.log': (i) => habits.log(num(i['id']), i['date'] as string | undefined, i['note'] as string | undefined),
  'habits.reorder': (i) => habits.reorder((i['order'] as unknown[] ?? []).map(num)),

  'goals.list': () => goals.list(),
  'goals.create': async (i) => ({ id: (await goals.createGoal(i)).id }),
  'goals.update': async (i) => ({ id: (await goals.updateGoal(num(i['id']), i)).id }),
  'goals.delete': (i) => goals.deleteGoal(num(i['id'])),
  'goals.nudge': (i) => goals.nudge(num(i['id']), num(i['delta'])),

  'notes.list': (i) => notes.list(i['q'] as string | undefined),
  'notes.create': async (i) => ({ id: (await notes.createNote(i)).id }),
  'notes.update': async (i) => ({ id: (await notes.updateNote(num(i['id']), i)).id }),
  'notes.pin': async (i) => ({ id: (await notes.pinNote(num(i['id']), i['pinned'])).id }),
  'notes.delete': (i) => notes.deleteNote(num(i['id'])),

  'focus.list': () => focus.list(),
  'focus.log': async (i) => ({ id: (await focus.logSession(i)).id }),
  'focus.delete': (i) => focus.deleteSession(num(i['id'])),
};

/* --------------------------------------------------------------- dispatch */

async function dispatch<K extends RouteKey>(
  key: K,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Result<K>> {
  // Not real cancellation: there is no request to abort. But a superseded search
  // resolving after a newer one is the bug the signal existed to prevent, and
  // checking on the way in and the way out still prevents it.
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const handler = HANDLERS[key];
  if (!handler) throw new ApiError(`Unknown action: ${key}`, 404);

  try {
    const data = await handler(input);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return data as Result<K>;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    if (e instanceof ApiError) throw e;
    if (e instanceof DataError) throw new ApiError(e.message, e.status);
    const status = (e as { status?: number })?.status;
    throw new ApiError(e instanceof Error ? e.message : 'Something went wrong.', status ?? 500);
  }
}

export function apiGet<E extends Endpoint, A extends ActionOf<E> & string = 'list' & ActionOf<E>>(
  endpoint: E,
  action: A = 'list' as A,
  query: Query = {},
  opts: { signal?: AbortSignal } = {},
): Promise<Result<`${E}.${A}`>> {
  return dispatch(`${endpoint}.${action}` as RouteKey, query as Record<string, unknown>, opts.signal) as Promise<Result<`${E}.${A}`>>;
}

export function apiPost<E extends Endpoint, A extends ActionOf<E> & string>(
  endpoint: E,
  action: A,
  payload: Body = {},
  opts: { signal?: AbortSignal } = {},
): Promise<Result<`${E}.${A}`>> {
  return dispatch(`${endpoint}.${action}` as RouteKey, payload, opts.signal) as Promise<Result<`${E}.${A}`>>;
}
