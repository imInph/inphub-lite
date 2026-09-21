/**
 * inphub lite: the record shapes, one per object store, taken column for column
 * from inphub.sql. Two things differ.
 *
 * user_id is gone. inphub is multi-account and scopes every query to
 * current_user_id(); this is one local profile, so there's nothing to scope to
 * and the column would just be a lie that survives an export.
 *
 * created_by and actor keep their 'ai' member even though nothing here writes
 * one, because an inphub backup can contain AI-authored rows and dropping it
 * would make those rows unimportable for no gain.
 *
 * The rest of the data layer assumes: dates are 'YYYY-MM-DD' and datetimes are
 * 'YYYY-MM-DDTHH:mm:ss', both local (see dates.ts), never a Date and never UTC;
 * booleans are 0 or 1, the way TINYINT(1) reached the views; and money is a
 * number rounded to 2dp, not a string.
 */

/* ------------------------------------------------------------------ scalars */

export type Bool = 0 | 1;
/** 'YYYY-MM-DD', local. */
export type DateStr = string;
/** 'YYYY-MM-DDTHH:mm:ss', local wall clock. */
export type DateTimeStr = string;

export type Actor = 'user' | 'ai' | 'system';
export type TodoStatus = 'todo' | 'in_progress' | 'done' | 'archived';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type EntryType = 'expense' | 'income';
export type HabitFrequency = 'daily' | 'weekly';
export type GoalStatus = 'active' | 'completed' | 'paused';

/** Ordering for MySQL's FIELD(priority,…) / FIELD(status,…), most urgent first. */
export const PRIORITY_ORDER: readonly Priority[] = ['urgent', 'high', 'medium', 'low'];
/** goals.status is an ENUM, so `ORDER BY status ASC` followed declaration order. */
export const GOAL_STATUS_ORDER: readonly GoalStatus[] = ['active', 'completed', 'paused'];
export const TODO_STATUS_ORDER: readonly TodoStatus[] = ['todo', 'in_progress', 'done', 'archived'];

/* ------------------------------------------------------------------ records */

export interface Todo {
  id: number;
  title: string;
  description: string | null;
  status: TodoStatus;
  priority: Priority;
  project: string | null;
  tags: string | null;
  due_date: DateStr | null;
  /** 'daily' | 'weekly' | 'monthly' | null. Acted on by todos.complete(). */
  recurring: string | null;
  sort_order: number;
  created_by: Actor;
  created_at: DateTimeStr;
  updated_at: DateTimeStr;
  completed_at: DateTimeStr | null;
}

export interface ExpenseCategory {
  id: number;
  name: string;
  color: string;
  icon: string | null;
  monthly_budget: number | null;
  created_at: DateTimeStr;
}

export interface Expense {
  id: number;
  type: EntryType;
  /** Always positive; `type` carries the direction. */
  amount: number;
  currency: string;
  category_id: number | null;
  description: string | null;
  payment_method: string | null;
  spent_at: DateStr;
  /** Stored and echoed back, but there is no recurrence engine, as in inphub. */
  is_recurring: Bool;
  recurring_interval: string | null;
  created_by: Actor;
  created_at: DateTimeStr;
}

export interface Repo {
  id: number;
  github_id: number | null;
  name: string;
  /** owner/repo. Unique, and what sync upserts on. */
  full_name: string;
  description: string | null;
  url: string | null;
  language: string | null;
  stars: number;
  forks: number;
  open_issues: number;
  default_branch: string;
  is_archived: Bool;
  is_private: Bool;
  has_readme: Bool;
  has_license: Bool;
  readme_excerpt: string | null;
  /** 0–100, see repoHealthScore() in github.ts. */
  health_score: number | null;
  staleness_days: number | null;
  last_pushed_at: DateTimeStr | null;
  last_synced_at: DateTimeStr | null;
  pinned: Bool;
  created_at: DateTimeStr;
}

export interface Habit {
  id: number;
  name: string;
  description: string | null;
  frequency: HabitFrequency;
  target_per_period: number;
  color: string;
  icon: string | null;
  is_active: Bool;
  sort_order: number;
  created_at: DateTimeStr;
}

export interface HabitLog {
  id: number;
  habit_id: number;
  logged_date: DateStr;
  /** Counts up to the habit's target, then the row is deleted. */
  count: number;
  note: string | null;
  created_at: DateTimeStr;
}

export interface Goal {
  id: number;
  title: string;
  description: string | null;
  category: string | null;
  target_value: number | null;
  current_value: number;
  unit: string | null;
  target_date: DateStr | null;
  status: GoalStatus;
  created_at: DateTimeStr;
  updated_at: DateTimeStr;
}

export interface Note {
  id: number;
  title: string | null;
  content: string;
  tags: string | null;
  pinned: Bool;
  created_at: DateTimeStr;
  updated_at: DateTimeStr;
}

export interface FocusSession {
  id: number;
  label: string | null;
  linked_todo_id: number | null;
  duration_minutes: number;
  started_at: DateTimeStr;
  ended_at: DateTimeStr | null;
  completed: Bool;
  created_at: DateTimeStr;
}

export interface Activity {
  id: number;
  /** Machine tag, e.g. 'todo.completed'. See activity-types.ts. */
  type: string;
  entity_type: string | null;
  entity_id: number | null;
  summary: string;
  actor: Actor;
  metadata: Record<string, unknown> | null;
  created_at: DateTimeStr;
}

export interface Setting {
  key: string;
  value: string;
  updated_at: DateTimeStr;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

/* -------------------------------------------------------------- store index */

/** Store name → record type. The single source of truth for the data layer. */
export interface StoreMap {
  todos: Todo;
  expense_categories: ExpenseCategory;
  expenses: Expense;
  repos: Repo;
  habits: Habit;
  habit_logs: HabitLog;
  goals: Goal;
  notes: Note;
  focus_sessions: FocusSession;
  activity_log: Activity;
  settings: Setting;
  _meta: MetaRow;
}

export type StoreName = keyof StoreMap;

/** The stores that hold user data: everything a backup round-trips. */
export const DATA_STORES = [
  'todos', 'expense_categories', 'expenses', 'repos', 'habits', 'habit_logs',
  'goals', 'notes', 'focus_sessions', 'activity_log', 'settings',
] as const satisfies readonly StoreName[];

export type DataStoreName = (typeof DATA_STORES)[number];

/** Stores keyed by an auto-incrementing integer `id`. */
export type RecordStoreName = Exclude<DataStoreName, 'settings'>;

/** A new record: no id (the store assigns it) and no created_at (tx.ts stamps it). */
export type Input<S extends StoreName> = Omit<StoreMap[S], 'id' | 'created_at'> &
  Partial<Pick<StoreMap[S], Extract<keyof StoreMap[S], 'id' | 'created_at'>>>;
