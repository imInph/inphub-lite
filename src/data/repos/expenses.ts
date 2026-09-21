/**
 * inphub lite: money entries. The client-side api/expenses.php.
 *
 * One store for both directions: `type` carries the sign and `amount` is always
 * positive. spent_at accepts future dates, which post-dated rent depends on and
 * which the wallet series and the chart fill both have to account for.
 *
 * is_recurring / recurring_interval are stored and echoed back and nothing ever
 * reads them. That is not an oversight here, it is inphub's behaviour: there is
 * no recurrence engine for money, only for todos.
 */

import { getAll } from '../db.ts';
import { now, today } from '../dates.ts';
import { create, remove, update } from '../tx.ts';
import { bool, dateOrNull, enumOf, intOrNull, money, str } from '../normalize.ts';
import { DataError } from '../db.ts';
import { getSetting } from '../settings.ts';
import { moneyWindow } from '../queries/money-window.ts';
import type { EntryType, Expense, ExpenseCategory } from '../types.ts';

const TYPES: readonly EntryType[] = ['expense', 'income'];

/** An expense joined to its category, which is what the ledger renders. */
export interface ExpenseRow extends Expense {
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
}

/**
 * money_text() from lib/helpers.php: "2000.00 TRY", no thousands separator and
 * always suffixed with the code. It exists so an activity summary can never
 * carry a bare number, which is what made History rows ambiguous once more than
 * one currency was in play. The UI has its own Intl formatter in ui.ts.
 */
export function moneyText(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency.trim().toUpperCase()}`;
}

export interface ExpenseFilter {
  period?: string;
  month?: string;
  category_id?: string | number;
  type?: string;
}

/**
 * ORDER BY spent_at DESC, id DESC.
 *
 * Defaults to the 'all' window, deliberately: no date parameter means no date
 * filter, so an unparameterised fetch returns everything rather than silently
 * hiding rows outside the current month.
 */
export async function list(filter: ExpenseFilter = {}): Promise<ExpenseRow[]> {
  const [rows, cats] = await Promise.all([getAll('expenses'), getAll('expense_categories')]);
  const byId = new Map<number, ExpenseCategory>(cats.map((c) => [c.id, c]));
  const win = moneyWindow(filter as Record<string, unknown>, 'all');

  const catId = filter.category_id === undefined || filter.category_id === ''
    ? null : Number(filter.category_id);
  const type = str(filter.type);

  return rows
    .filter((e) =>
      (win.from === null || (e.spent_at >= win.from && e.spent_at <= win.to!))
      && (catId === null || e.category_id === catId)
      && (type === null || e.type === enumOf(type, TYPES, 'expense')))
    .sort((a, b) => b.spent_at.localeCompare(a.spent_at) || b.id - a.id)
    .map((e) => {
      const c = e.category_id === null ? undefined : byId.get(e.category_id);
      return {
        ...e,
        category_name: c?.name ?? null,
        category_color: c?.color ?? null,
        category_icon: c?.icon ?? null,
      };
    });
}

/** A category id from the client is checked against the store, never trusted. */
async function assertCategory(id: number | null): Promise<number | null> {
  if (id === null) return null;
  const exists = (await getAll('expense_categories')).some((c) => c.id === id);
  if (!exists) throw new DataError('That category does not exist.', 404);
  return id;
}

async function fields(input: Record<string, unknown>, base?: Expense) {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  const currency = str(input['currency']) ?? base?.currency ?? (await getSetting('base_currency', 'TRY'));
  return {
    type: enumOf(input['type'] ?? base?.type, TYPES, base?.type ?? 'expense'),
    amount: money(input['amount'] ?? base?.amount, base?.amount ?? 0),
    currency: currency.slice(0, 3).toUpperCase(),
    category_id: await assertCategory(has('category_id') ? intOrNull(input['category_id']) : base?.category_id ?? null),
    description: has('description') ? str(input['description']) : base?.description ?? null,
    payment_method: has('payment_method') ? str(input['payment_method']) : base?.payment_method ?? null,
    spent_at: (has('spent_at') ? dateOrNull(input['spent_at']) : base?.spent_at) ?? today(),
    is_recurring: has('is_recurring') ? bool(input['is_recurring']) : base?.is_recurring ?? 0,
    recurring_interval: has('recurring_interval') ? str(input['recurring_interval']) : base?.recurring_interval ?? null,
  };
}

export async function createExpense(input: Record<string, unknown>): Promise<Expense> {
  const f = await fields(input);
  if (!(f.amount > 0)) throw new DataError('Amount is required.', 422);
  // Summaries are inphub's, word for word. Units always, because a bare number
  // reads as dollars, and History has to look the same in both apps.
  return create('expenses', { ...f, created_by: 'user' }, (row) => ({
    type: 'expense.created',
    entity_type: 'expense',
    summary: `${row.type === 'income' ? 'Income' : 'Spent'} ${moneyText(row.amount, row.currency)}`,
  }));
}

export async function updateExpense(id: number, input: Record<string, unknown>): Promise<Expense> {
  const existing = (await getAll('expenses')).find((e) => e.id === id);
  if (!existing) throw new DataError('That entry no longer exists.', 404);
  const f = await fields(input, existing);
  return update('expenses', id, f, () => ({
    type: 'expense.updated',
    entity_type: 'expense',
    summary: 'Updated an entry',
  }));
}

export async function deleteExpense(id: number): Promise<void> {
  await remove('expenses', id, () => ({
    type: 'expense.deleted',
    entity_type: 'expense',
    summary: 'Deleted an entry',
  }));
}
