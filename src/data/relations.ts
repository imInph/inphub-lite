/**
 * inphub lite: the foreign keys IndexedDB doesn't have.
 *
 * MySQL enforced these three with ON DELETE clauses (see inphub.sql). IndexedDB
 * enforces nothing, so they're listed here and applied by remove() in tx.ts,
 * the only delete in the app. One table, one place that reads it, and a build
 * check so nothing else can call .delete().
 *
 * activity_log isn't in the list, and inphub doesn't cascade it either. It has
 * no foreign key to anything and "Deleted task: Buy milk" has to outlive the
 * task. The side effect is that a History row can link to an id that's gone,
 * which the router answers by saying so instead of showing an empty pane.
 */

import type { RecordStoreName } from './types.ts';

export interface Relation {
  parent: RecordStoreName;
  child: RecordStoreName;
  /** The column on the child holding the parent's id. */
  fk: string;
  /** The child's index on `fk`, needed to find the affected rows. */
  index: string;
  onDelete: 'cascade' | 'setNull';
}

export const RELATIONS: readonly Relation[] = [
  // fk_hl_habit ON DELETE CASCADE. A habit's logs are meaningless without it.
  { parent: 'habits', child: 'habit_logs', fk: 'habit_id', index: 'habit_date', onDelete: 'cascade' },
  // fk_exp_cat ON DELETE SET NULL. The spend happened, only its label goes.
  { parent: 'expense_categories', child: 'expenses', fk: 'category_id', index: 'category_id', onDelete: 'setNull' },
  // fk_focus_todo ON DELETE SET NULL. The focus time happened too.
  { parent: 'todos', child: 'focus_sessions', fk: 'linked_todo_id', index: 'linked_todo_id', onDelete: 'setNull' },
];

/** Relations whose parent is this store, i.e. what a delete has to clean up. */
export function childrenOf(store: RecordStoreName): Relation[] {
  return RELATIONS.filter((r) => r.parent === store);
}
