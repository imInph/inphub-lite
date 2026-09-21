/**
 * inphub lite: global search. The client-side api/search.php.
 *
 * Six groups in a fixed order, empty ones dropped. Every group ranks the same
 * way: rows whose main field STARTS with the query come first (that is the
 * `(title LIKE 'q%') DESC` boost in the SQL), then a domain-specific tiebreak.
 * Each group fetches one more row than it needs so it can tell whether more
 * exist without a second count.
 *
 * All matching goes through fold() from data/fold.ts, on both sides. inphub got
 * that from MySQL's collation and explicitly forbade re-filtering client-side;
 * here there is no collation to lean on, so the fold IS the collation.
 *
 * The LIKE-escaping machinery (like_escape, ESCAPE '!') has no equivalent and
 * needs none: a folded substring test treats % and _ as ordinary characters.
 */

import { getAll } from '../db.ts';
import { fold } from '../fold.ts';
import { clampInt, str } from '../normalize.ts';
import { GOAL_STATUS_ORDER } from '../types.ts';

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_DEFAULT_LIMIT = 5;

export interface SearchItem {
  id: number;
  label: string;
  sub: string;
  meta: string;
  amount?: number;
  currency?: string;
}

export interface SearchGroup {
  type: string;
  label: string;
  items: SearchItem[];
  truncated: boolean;
}

export interface SearchResult {
  q: string;
  total: number;
  truncated: boolean;
  groups: SearchGroup[];
}

/** Collapse whitespace and clip, appending an ellipsis. search_snippet(). */
function snippet(text: string | null, length = 90): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > length ? t.slice(0, length - 1) + '…' : t;
}

/**
 * Rank and cut one group.
 *
 * `primary` is the field the prefix boost applies to, matching which column the
 * SQL put in its `ORDER BY (… LIKE 'q%') DESC`.
 */
function rank<T>(
  rows: T[],
  needle: string,
  primary: (row: T) => string,
  tiebreak: (a: T, b: T) => number,
  limit: number,
): { items: T[]; truncated: boolean } {
  const sorted = rows.sort((a, b) => {
    const pa = fold(primary(a)).startsWith(needle) ? 0 : 1;
    const pb = fold(primary(b)).startsWith(needle) ? 0 : 1;
    return pa - pb || tiebreak(a, b);
  });
  // limit+1 so "there are more" is known without counting twice.
  const taken = sorted.slice(0, limit + 1);
  return { items: taken.slice(0, limit), truncated: taken.length > limit };
}

const matches = (needle: string, ...fields: (string | null)[]): boolean =>
  fields.some((f) => f !== null && f !== '' && fold(f).includes(needle));

export async function search(input: Record<string, unknown>): Promise<SearchResult> {
  const q = str(input['q']) ?? '';
  const limit = clampInt(input['limit'] ?? SEARCH_DEFAULT_LIMIT, 1, 20, SEARCH_DEFAULT_LIMIT);

  if (q.length < SEARCH_MIN_CHARS) return { q, total: 0, truncated: false, groups: [] };
  const needle = fold(q);

  const [todos, expenses, cats, notes, habits, goals, repos] = await Promise.all([
    getAll('todos'), getAll('expenses'), getAll('expense_categories'),
    getAll('notes'), getAll('habits'), getAll('goals'), getAll('repos'),
  ]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));

  const groups: SearchGroup[] = [];
  const push = (type: string, label: string, r: { items: SearchItem[]; truncated: boolean }) => {
    if (r.items.length) groups.push({ type, label, items: r.items, truncated: r.truncated });
  };

  // Tasks: open before done, then by due date, nulls last.
  push('todo', 'Tasks', (() => {
    const hits = todos.filter((t) => matches(needle, t.title, t.description, t.project, t.tags));
    const { items, truncated } = rank(hits, needle, (t) => t.title, (a, b) =>
      Number(a.status === 'done' || a.status === 'archived') - Number(b.status === 'done' || b.status === 'archived')
      || Number(a.due_date === null) - Number(b.due_date === null)
      || (a.due_date ?? '').localeCompare(b.due_date ?? '')
      || b.id - a.id, limit);
    return {
      truncated,
      items: items.map((t) => {
        const bits: string[] = [];
        if (t.project) bits.push('#' + t.project);
        if (t.status !== 'todo') bits.push(t.status.replace('_', ' '));
        if (t.priority !== 'medium') bits.push(t.priority);
        return { id: t.id, label: t.title, sub: bits.join(' · '), meta: t.due_date ? 'due ' + t.due_date : '' };
      }),
    };
  })());

  // Money: most recent first. An entry with no description falls back to its
  // category name, then to "Entry", rather than showing an empty row.
  push('expense', 'Money', (() => {
    const hits = expenses.filter((e) =>
      matches(needle, e.description, e.category_id === null ? null : catName.get(e.category_id) ?? null, e.payment_method));
    const { items, truncated } = rank(hits, needle, (e) => e.description ?? '', (a, b) =>
      b.spent_at.localeCompare(a.spent_at) || b.id - a.id, limit);
    return {
      truncated,
      items: items.map((e) => {
        const category = e.category_id === null ? null : catName.get(e.category_id) ?? null;
        return {
          id: e.id,
          label: snippet(e.description) || category || 'Entry',
          sub: `${e.type === 'income' ? 'income' : 'expense'}${category ? ' · ' + category : ''}`,
          meta: e.spent_at,
          amount: e.amount,
          currency: e.currency,
        };
      }),
    };
  })());

  // Notes: pinned first, then most recently edited.
  push('note', 'Notes', (() => {
    const hits = notes.filter((n) => matches(needle, n.title, n.content, n.tags));
    const { items, truncated } = rank(hits, needle, (n) => n.title ?? '', (a, b) =>
      b.pinned - a.pinned || b.updated_at.localeCompare(a.updated_at) || b.id - a.id, limit);
    return {
      truncated,
      items: items.map((n) => ({
        id: n.id,
        label: n.title || snippet(n.content, 60),
        sub: n.title ? snippet(n.content, 70) : '',
        meta: (n.pinned ? 'pinned · ' : '') + n.updated_at.slice(0, 10),
      })),
    };
  })());

  push('habit', 'Habits', (() => {
    const hits = habits.filter((h) => matches(needle, h.name, h.description));
    const { items, truncated } = rank(hits, needle, (h) => h.name, (a, b) =>
      b.is_active - a.is_active || a.sort_order - b.sort_order || a.id - b.id, limit);
    return {
      truncated,
      items: items.map((h) => ({
        id: h.id, label: h.name, sub: snippet(h.description, 70),
        meta: h.frequency + (h.is_active ? '' : ' · paused'),
      })),
    };
  })());

  push('goal', 'Goals', (() => {
    const hits = goals.filter((g) => matches(needle, g.title, g.description, g.category));
    const { items, truncated } = rank(hits, needle, (g) => g.title, (a, b) =>
      GOAL_STATUS_ORDER.indexOf(a.status) - GOAL_STATUS_ORDER.indexOf(b.status) || b.id - a.id, limit);
    return {
      truncated,
      items: items.map((g) => {
        const progress = `${g.current_value}${g.target_value !== null ? '/' + g.target_value : ''}${g.unit ? ' ' + g.unit : ''}`;
        return {
          id: g.id, label: g.title,
          sub: `${progress}${g.status !== 'active' ? ' · ' + g.status : ''}`.trim(),
          meta: g.category ?? '',
        };
      }),
    };
  })());

  push('repo', 'Repositories', (() => {
    const hits = repos.filter((r) => matches(needle, r.name, r.full_name, r.description));
    const { items, truncated } = rank(hits, needle, (r) => r.name, (a, b) =>
      b.pinned - a.pinned || a.name.localeCompare(b.name) || b.id - a.id, limit);
    return {
      truncated,
      items: items.map((r) => ({
        id: r.id, label: r.full_name, sub: snippet(r.description, 70),
        meta: `${r.language ?? ''}${r.health_score !== null ? ' · health ' + r.health_score : ''}`.trim(),
      })),
    };
  })());

  return {
    q,
    total: groups.reduce((n, g) => n + g.items.length, 0),
    truncated: groups.some((g) => g.truncated),
    groups,
  };
}
