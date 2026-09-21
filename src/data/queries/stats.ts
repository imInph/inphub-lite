/**
 * inphub lite: the Money view's read model, i.e. expense_charts() from
 * api/stats.php. One call feeds the totals strip, the donut, the line and the
 * budget bars, exactly as it did over HTTP.
 *
 * Three things here are not obvious and all three are deliberate in inphub:
 *
 * all_time is never windowed. "Current net" is the money in your pocket and
 * that does not reset when a month does.
 *
 * by_category comes from the categories side, so a category with no spending in
 * the window still groups (and is then dropped by the > 0 test), and anything
 * with no category at all is appended afterwards as a synthetic Uncategorised
 * row rather than silently vanishing from the donut.
 *
 * budgets ignore the period selector entirely and always describe the current
 * calendar month, so the card can be trusted at a glance whatever else is on
 * screen.
 */

import { cursorEach, getAll, withTx } from '../db.ts';
import { addDays, localDate, monthBounds, monthKey } from '../dates.ts';
import { allSettings } from '../settings.ts';
import { moneyWindow, type MoneyWindow } from './money-window.ts';
import { bucketOf, fillSeries, granularityFor, type Granularity } from './series.ts';
import { dashboardLayout, parseShortcuts } from './layout.ts';
import { PRIORITY_ORDER, type Activity, type Expense } from '../types.ts';

/**
 * The newest N activity rows.
 *
 * A cursor rather than getAll(): activity_log gains a row on every mutation and
 * is the only store with unbounded growth, so reading all of it to show eight
 * lines is the thing that makes the dashboard slow in year two. Walking the
 * created_at index backwards also matches PHP's ORDER BY created_at DESC,
 * id DESC exactly, since the auto-increment id breaks ties the same way.
 */
export async function recentActivity(limit: number): Promise<Activity[]> {
  const out: Activity[] = [];
  await withTx(['activity_log'], 'readonly', (s) =>
    cursorEach((s('activity_log') as IDBObjectStore).index('created_at'), null, 'prev', (row) => {
      out.push(row as Activity);
      return out.length < limit;
    }));
  return out;
}

/**
 * Activity rows inside a date window, read through the created_at index.
 *
 * A bounded key range rather than a full walk: the index is there precisely so
 * a month of history does not cost a scan of every row ever written. Bounds are
 * date-only, so the upper one carries a trailing character to include the whole
 * of `to` rather than stopping at its midnight.
 */
export async function activityBetween(from: string | null, to: string | null): Promise<Activity[]> {
  const range = from === null || to === null
    ? null
    : IDBKeyRange.bound(`${from}T00:00:00`, `${to}T23:59:59`);
  const out: Activity[] = [];
  await withTx(['activity_log'], 'readonly', (s) =>
    cursorEach((s('activity_log') as IDBObjectStore).index('created_at'), range, 'next', (row) => {
      out.push(row as Activity);
    }));
  return out;
}

const UNCATEGORISED_COLOR = '#6b7280';

export interface CategorySlice { name: string; color: string; total: number }
export interface BudgetRow { name: string; color: string; monthly_budget: number; spent: number }

export interface ExpenseCharts {
  period: string;
  label: string;
  from: string | null;
  to: string | null;
  currency: string;
  granularity: Granularity;
  budget_month: string;
  totals: { expense: number; income: number; net: number };
  all_time: { expense: number; income: number; starting_balance: number; current_net: number };
  by_category: CategorySlice[];
  over_time: Array<{ d: string; total: number }>;
  budgets: BudgetRow[];
}

/** Round to 2dp once, at the end, so a long sum does not drift in float. */
const r2 = (n: number): number => Math.round(n * 100) / 100;

const inWindow = (e: Expense, win: MoneyWindow): boolean =>
  win.from === null || (e.spent_at >= win.from && e.spent_at <= win.to!);

export async function expenseCharts(
  input: Record<string, unknown>,
  ref: Date = new Date(),
): Promise<ExpenseCharts> {
  const win = moneyWindow(input, 'month');
  const [rows, cats, settings] = await Promise.all([
    getAll('expenses'), getAll('expense_categories'), allSettings(),
  ]);

  const currency = settings['base_currency'] || 'TRY';
  const opening = Number(settings['starting_balance'] ?? 0) || 0;

  const windowed = rows.filter((e) => inWindow(e, win));
  const sum = (list: Expense[], type: string) =>
    list.reduce((n, e) => (e.type === type ? n + e.amount : n), 0);

  const expense = sum(windowed, 'expense');
  const income = sum(windowed, 'income');
  const lifeExp = sum(rows, 'expense');
  const lifeInc = sum(rows, 'income');

  // Donut. Categories first so the order is theirs, then the orphans.
  const spendByCat = new Map<number, number>();
  let uncategorised = 0;
  for (const e of windowed) {
    if (e.type !== 'expense') continue;
    if (e.category_id === null) uncategorised += e.amount;
    else spendByCat.set(e.category_id, (spendByCat.get(e.category_id) ?? 0) + e.amount);
  }
  const by_category: CategorySlice[] = cats
    .map((c) => ({ name: c.name, color: c.color, total: r2(spendByCat.get(c.id) ?? 0) }))
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total);
  if (uncategorised > 0) {
    by_category.push({ name: 'Uncategorised', color: UNCATEGORISED_COLOR, total: r2(uncategorised) });
  }

  // Line. Expenses only, bucketed, then zero-filled across the window.
  const granularity = granularityFor(win.from, win.to);
  const map = new Map<string, number>();
  for (const e of windowed) {
    if (e.type !== 'expense') continue;
    const key = bucketOf(e.spent_at, granularity);
    map.set(key, (map.get(key) ?? 0) + e.amount);
  }
  for (const [k, v] of map) map.set(k, r2(v));

  // Budgets: always this calendar month, whatever the selector says.
  const thisMonth = monthBounds(0, ref);
  const budgetSpend = new Map<number, number>();
  for (const e of rows) {
    if (e.type !== 'expense' || e.category_id === null) continue;
    if (e.spent_at < thisMonth.from || e.spent_at > thisMonth.to) continue;
    budgetSpend.set(e.category_id, (budgetSpend.get(e.category_id) ?? 0) + e.amount);
  }
  const budgets: BudgetRow[] = cats
    .filter((c) => c.monthly_budget !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({
      name: c.name,
      color: c.color,
      monthly_budget: c.monthly_budget!,
      spent: r2(budgetSpend.get(c.id) ?? 0),
    }));

  return {
    period: win.period,
    label: win.label,
    from: win.from,
    to: win.to,
    currency,
    granularity,
    budget_month: monthKey(localDate(ref)),
    totals: { expense: r2(expense), income: r2(income), net: r2(income - expense) },
    all_time: {
      expense: r2(lifeExp),
      income: r2(lifeInc),
      starting_balance: opening,
      current_net: r2(opening + lifeInc - lifeExp),
    },
    by_category,
    over_time: fillSeries(map, granularity, win.from, win.to, 'total', ref),
    budgets,
  };
}

/* ------------------------------------------------------------- dashboard */

export interface DashData {
  layout: { id: string; size: string }[];
  wallet: { balance: number; series: { d: string; balance: number }[] };
  upcoming: {
    todos: { id: number; title: string; priority: string; due_date: string | null }[];
    goals: { id: number; title: string; target_date: string | null }[];
  };
  owner_name: string;
  currency: string;
  shortcuts: { name: string; url: string }[];
  todos: { id: number; title: string; priority: string; due_date: string | null }[];
  habits: { id: number; name: string; icon: string | null; logged_today: number }[];
  money: {
    spent: number; income: number; month: string;
    top_categories: { name: string; color: string; icon: string | null; monthly_budget: number | null; total: number }[];
  };
  repos: {
    stale_count: number;
    most_neglected: { name: string; full_name: string; staleness_days: number | null; health_score: number | null } | null;
  };
  goals: { id: number; title: string; current_value: number; target_value: number | null; unit: string | null }[];
  focus: {
    today_minutes: number; week_minutes: number;
    last: { label: string | null; duration_minutes: number; started_at: string; todo_title: string | null } | null;
  };
  activity: { id: number; type: string; summary: string; actor: string; created_at: string }[];
}

/** FIELD(priority,'urgent','high','medium','low'). */
const byPriority = (p: string) => PRIORITY_ORDER.indexOf(p as never);

/**
 * Everything the dashboard needs, in one read, as stats.php's `dashboard`
 * action was. Each widget renders from this payload rather than fetching, so
 * twelve widgets cost one pass over the stores instead of twelve.
 */
export async function dashboard(ref: Date = new Date()): Promise<DashData> {
  const [todos, expenses, cats, habitRows, habitLogs, goals, focusRows, repos, settings] =
    await Promise.all([
      getAll('todos'), getAll('expenses'), getAll('expense_categories'),
      getAll('habits'), getAll('habit_logs'), getAll('goals'),
      getAll('focus_sessions'), getAll('repos'), allSettings(),
    ]);

  const today = localDate(ref);
  const month = monthKey(today);
  const currency = settings['base_currency'] || 'TRY';
  const opening = Number(settings['starting_balance'] ?? 0) || 0;

  // Due and overdue: undated tasks belong here too, at the end.
  const due = todos
    .filter((t) => (t.status === 'todo' || t.status === 'in_progress')
      && (t.due_date === null || t.due_date <= today))
    .sort((a, b) =>
      Number(a.due_date === null) - Number(b.due_date === null)
      || (a.due_date ?? '').localeCompare(b.due_date ?? '')
      || byPriority(a.priority) - byPriority(b.priority))
    .slice(0, 12);

  const weekOut = addDays(today, 7);
  const upcomingTodos = todos
    .filter((t) => (t.status === 'todo' || t.status === 'in_progress')
      && t.due_date !== null && t.due_date > today && t.due_date <= weekOut)
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '')
      || byPriority(a.priority) - byPriority(b.priority) || b.id - a.id)
    .slice(0, 20);
  const upcomingGoals = goals
    .filter((g) => g.status === 'active' && g.target_date !== null
      && g.target_date > today && g.target_date <= weekOut)
    .sort((a, b) => (a.target_date ?? '').localeCompare(b.target_date ?? '') || b.id - a.id)
    .slice(0, 10);

  // The dashboard's logged_today is a row count (0 or 1), not the target-aware
  // flag the Habits view computes. That difference is inphub's, kept on purpose.
  const loggedToday = new Set(habitLogs.filter((l) => l.logged_date === today).map((l) => l.habit_id));
  const habits = habitRows
    .filter((h) => h.is_active === 1)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((h) => ({ id: h.id, name: h.name, icon: h.icon, logged_today: loggedToday.has(h.id) ? 1 : 0 }));

  // Money, this calendar month.
  let spent = 0;
  let income = 0;
  const monthByCat = new Map<number, number>();
  for (const e of expenses) {
    if (monthKey(e.spent_at) !== month) continue;
    if (e.type === 'expense') {
      spent += e.amount;
      if (e.category_id !== null) monthByCat.set(e.category_id, (monthByCat.get(e.category_id) ?? 0) + e.amount);
    } else income += e.amount;
  }
  const top_categories = cats
    .map((c) => ({
      name: c.name, color: c.color, icon: c.icon,
      monthly_budget: c.monthly_budget, total: r2(monthByCat.get(c.id) ?? 0),
    }))
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  // Wallet: the same maths as Money's "current net", then walked backwards so
  // each point is that day's closing balance. Post-dated entries count toward
  // the balance but sit outside the chart, so the walk starts from the balance
  // as of today rather than the lifetime one.
  const balance = opening + expenses.reduce((n, e) => n + (e.type === 'income' ? e.amount : -e.amount), 0);
  const walletFrom = addDays(today, -29);
  const netMap = new Map<string, number>();
  let future = 0;
  for (const e of expenses) {
    const signed = e.type === 'income' ? e.amount : -e.amount;
    if (e.spent_at > today) future += signed;
    else if (e.spent_at >= walletFrom) netMap.set(e.spent_at, (netMap.get(e.spent_at) ?? 0) + signed);
  }
  let running = balance - future;
  const days = fillSeries(netMap, 'day', walletFrom, today, 'total', ref);
  const series: { d: string; balance: number }[] = new Array(days.length);
  for (let i = days.length - 1; i >= 0; i--) {
    series[i] = { d: days[i]!.d, balance: r2(running) };
    running -= days[i]!.total;
  }

  const weekStart = addDays(today, -6);
  let today_minutes = 0;
  let week_minutes = 0;
  for (const f of focusRows) {
    const day = f.started_at.slice(0, 10);
    if (day === today) today_minutes += f.duration_minutes;
    if (day >= weekStart) week_minutes += f.duration_minutes;
  }
  const lastSession = [...focusRows].sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  const titles = new Map(todos.map((t) => [t.id, t.title]));

  const staleDays = Number(settings['stale_repo_days'] ?? 60) || 60;
  const neglected = [...repos].sort((a, b) =>
    Number(a.staleness_days === null) - Number(b.staleness_days === null)
    || (b.staleness_days ?? 0) - (a.staleness_days ?? 0))[0];

  const activity = await recentActivity(8);

  return {
    layout: dashboardLayout(settings),
    wallet: { balance: r2(balance), series },
    upcoming: {
      todos: upcomingTodos.map((t) => ({ id: t.id, title: t.title, priority: t.priority, due_date: t.due_date })),
      goals: upcomingGoals.map((g) => ({ id: g.id, title: g.title, target_date: g.target_date })),
    },
    owner_name: settings['owner_name'] ?? '',
    currency,
    shortcuts: parseShortcuts(settings['dashboard_shortcuts']),
    todos: due.map((t) => ({ id: t.id, title: t.title, priority: t.priority, due_date: t.due_date })),
    habits,
    money: { spent: r2(spent), income: r2(income), top_categories, month },
    repos: {
      stale_count: repos.filter((r) => r.staleness_days !== null && r.staleness_days >= staleDays).length,
      most_neglected: neglected
        ? { name: neglected.name, full_name: neglected.full_name, staleness_days: neglected.staleness_days, health_score: neglected.health_score }
        : null,
    },
    goals: goals
      .filter((g) => g.status === 'active')
      .sort((a, b) => Number(a.target_date === null) - Number(b.target_date === null)
        || (a.target_date ?? '').localeCompare(b.target_date ?? ''))
      .slice(0, 6)
      .map((g) => ({ id: g.id, title: g.title, current_value: g.current_value, target_value: g.target_value, unit: g.unit })),
    focus: {
      today_minutes,
      week_minutes,
      last: lastSession
        ? {
            label: lastSession.label,
            duration_minutes: lastSession.duration_minutes,
            started_at: lastSession.started_at,
            todo_title: lastSession.linked_todo_id === null ? null : titles.get(lastSession.linked_todo_id) ?? null,
          }
        : null,
    },
    activity,
  };
}
