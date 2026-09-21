/**
 * inphub lite: expense categories. The client-side api/categories.php.
 *
 * Plain CRUD, and like inphub none of it writes an activity row: renaming a
 * category is bookkeeping, not something you want to read back in History.
 *
 * Deleting one does not delete its expenses. The unique index on `name` and the
 * set-null on delete both come from inphub.sql and are applied by relations.ts.
 */

import { getAll } from '../db.ts';
import { create, remove, SILENT, update } from '../tx.ts';
import { color, moneyOrNull, str, text } from '../normalize.ts';
import { DataError } from '../db.ts';
import type { ExpenseCategory } from '../types.ts';

export const DEFAULT_CATEGORY_COLOR = '#6b7280';

/** ORDER BY name ASC. */
export async function list(): Promise<ExpenseCategory[]> {
  const rows = await getAll('expense_categories');
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function fields(input: Record<string, unknown>, base?: ExpenseCategory) {
  return {
    name: text(input['name'], base?.name ?? ''),
    color: color(input['color'] ?? base?.color, base?.color ?? DEFAULT_CATEGORY_COLOR),
    icon: Object.prototype.hasOwnProperty.call(input, 'icon') ? str(input['icon']) : base?.icon ?? null,
    monthly_budget: Object.prototype.hasOwnProperty.call(input, 'monthly_budget')
      ? moneyOrNull(input['monthly_budget'])
      : base?.monthly_budget ?? null,
  };
}

/**
 * The unique index on `name` is what enforces uq_cat_user_name, and it throws a
 * ConstraintError rather than quietly making a second "Food & Drink". inphub
 * caught the PDO 23000 and answered 409 with this wording; match it.
 */
export async function createCategory(input: Record<string, unknown>): Promise<ExpenseCategory> {
  const f = fields(input);
  if (!f.name) throw new DataError('Name is required.', 422);
  try {
    return await create('expense_categories', f, SILENT);
  } catch (e) {
    throw e instanceof DataError && e.status === 409
      ? new DataError('A category with that name already exists.', 409)
      : e;
  }
}

export async function updateCategory(id: number, input: Record<string, unknown>): Promise<ExpenseCategory> {
  const existing = (await getAll('expense_categories')).find((c) => c.id === id);
  if (!existing) throw new DataError('That category no longer exists.', 404);
  try {
    return await update('expense_categories', id, fields(input, existing), SILENT);
  } catch (e) {
    throw e instanceof DataError && e.status === 409
      ? new DataError('A category with that name already exists.', 409)
      : e;
  }
}

/** Expenses survive; relations.ts nulls their category_id. */
export async function deleteCategory(id: number): Promise<void> {
  await remove('expense_categories', id, SILENT);
}
