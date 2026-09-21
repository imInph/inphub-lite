/**
 * inphub lite: applying a parsed backup.
 *
 * parseBackup() in backup.ts has already validated everything in memory, so by
 * the time anything here runs the only remaining failures are storage ones. The
 * whole write is one transaction across every store: a half-restored database
 * is worse than a failed import.
 *
 * Two modes and no third. Ambiguity in a restore path is how people lose data.
 */

import { req, withTx } from './db.ts';
import { localDate } from './dates.ts';
import { logOnly } from './tx.ts';
import { setMeta } from './db.ts';
import { DATA_STORES, type DataStoreName } from './types.ts';
import type { ParsedBackup } from './backup.ts';

export type ImportMode = 'replace' | 'merge';

/** Parents before children, so a foreign key is never written ahead of its target. */
const ORDER: DataStoreName[] = [
  'expense_categories', 'todos', 'habits', 'goals', 'notes', 'repos',
  'expenses', 'habit_logs', 'focus_sessions', 'activity_log', 'settings',
];

/** child store => [parent store, fk column]. Used to rewrite ids in merge mode. */
const PARENTS: Partial<Record<DataStoreName, [DataStoreName, string]>> = {
  expenses: ['expense_categories', 'category_id'],
  habit_logs: ['habits', 'habit_id'],
  focus_sessions: ['todos', 'linked_todo_id'],
};

export interface ImportResult {
  mode: ImportMode;
  written: Record<string, number>;
  warnings: string[];
}

export async function applyBackup(parsed: ParsedBackup, mode: ImportMode): Promise<ImportResult> {
  const stores = [...DATA_STORES];
  const written: Record<string, number> = {};

  await withTx(stores, 'readwrite', async (s) => {
    if (mode === 'replace') {
      // clear() is the one legitimate wipe in the app, which is why import.ts is
      // on the check-invariants allowlist beside tx.ts. It does not reset the
      // autoIncrement generator, so ids jump afterwards. That is cosmetic.
      for (const store of stores) await req((s(store) as IDBObjectStore).clear());
    }

    // Existing keys, read once, for the merge-mode collision rules.
    const existingCats = new Map<string, number>();
    const existingHabits = new Map<string, number>();
    const existingRepos = new Map<string, number>();
    const existingLogs = new Map<string, { id: number; count: number }>();
    const existingActivity = new Set<string>();
    if (mode === 'merge') {
      for (const c of await req((s('expense_categories') as IDBObjectStore).getAll())) existingCats.set(c.name, c.id);
      for (const h of await req((s('habits') as IDBObjectStore).getAll())) existingHabits.set(h.name, h.id);
      for (const r of await req((s('repos') as IDBObjectStore).getAll())) existingRepos.set(r.full_name, r.id);
      for (const l of await req((s('habit_logs') as IDBObjectStore).getAll())) {
        existingLogs.set(`${l.habit_id}|${l.logged_date}`, { id: l.id, count: l.count });
      }
      for (const a of await req((s('activity_log') as IDBObjectStore).getAll())) {
        existingActivity.add(`${a.created_at}|${a.type}|${a.summary}`);
      }
    }

    const remap = new Map<DataStoreName, Map<number, number>>();
    const mapOf = (store: DataStoreName) => {
      let m = remap.get(store);
      if (!m) { m = new Map(); remap.set(store, m); }
      return m;
    };

    for (const store of ORDER) {
      const list = parsed.rows[store];
      if (!list?.length) continue;
      const os = s(store) as IDBObjectStore;
      let count = 0;

      for (const raw of list) {
        const row: Record<string, unknown> = { ...raw };

        if (store === 'settings') {
          // Incoming wins for the keys it carries; anything else is left alone.
          await req(os.put(row));
          count++;
          continue;
        }

        const oldId = Number(row['id']);
        if (mode === 'merge') delete row['id'];

        // Point a child at wherever its parent actually landed.
        const parent = PARENTS[store];
        if (parent) {
          const [parentStore, fk] = parent;
          const current = row[fk] === null || row[fk] === undefined ? null : Number(row[fk]);
          if (current !== null) {
            row[fk] = mapOf(parentStore).get(current) ?? (mode === 'replace' ? current : null);
          }
        }

        if (mode === 'merge') {
          const reuse = await mergeCollision(store, row, os, {
            existingCats, existingHabits, existingRepos, existingLogs, existingActivity,
          });
          if (reuse !== undefined) {
            if (reuse !== null && Number.isFinite(oldId)) mapOf(store).set(oldId, reuse);
            continue;
          }
        }

        const newId = await req(os.put(row)) as number;
        if (Number.isFinite(oldId)) mapOf(store).set(oldId, Number(newId));
        count++;
      }
      written[store] = count;
    }
  });

  await setMeta('last_import_at', localDate());
  await logOnly({
    type: 'data.imported',
    entity_type: 'data',
    summary: `Imported a backup (${mode})`,
    actor: 'system',
    metadata: { counts: written, from: parsed.meta.app },
  });

  return { mode, written, warnings: parsed.warnings };
}

interface MergeState {
  existingCats: Map<string, number>;
  existingHabits: Map<string, number>;
  existingRepos: Map<string, number>;
  existingLogs: Map<string, { id: number; count: number }>;
  existingActivity: Set<string>;
}

/**
 * What a merge should do about a row that already exists.
 *
 * Returns the id to reuse, `null` to drop the row outright, or `undefined` to
 * insert it normally.
 */
async function mergeCollision(
  store: DataStoreName,
  row: Record<string, unknown>,
  os: IDBObjectStore,
  state: MergeState,
): Promise<number | null | undefined> {
  if (store === 'expense_categories') {
    // Reuse the existing category rather than making a second "Food & Drink".
    return state.existingCats.get(String(row['name']));
  }
  if (store === 'habits') {
    // Nothing stops a second "Read" from existing, so merging a backup into an
    // account that already has these habits would double them. Worse, the logs
    // would attach to the new copy and the (habit_id, logged_date) rule below
    // could never fire. Matching on name is what makes that rule reachable.
    return state.existingHabits.get(String(row['name']));
  }
  if (store === 'repos') {
    return state.existingRepos.get(String(row['full_name']));
  }
  if (store === 'habit_logs') {
    const key = `${row['habit_id']}|${row['logged_date']}`;
    const hit = state.existingLogs.get(key);
    if (!hit) return undefined;
    // max(), not sum. Summing is the obvious choice and it is wrong: importing
    // the same file twice would double every day's count.
    const merged = Math.max(hit.count, Number(row['count']) || 1);
    if (merged !== hit.count) {
      const current = await req(os.get(hit.id)) as Record<string, unknown> | undefined;
      if (current) await req(os.put({ ...current, count: merged }));
    }
    return hit.id;
  }
  if (store === 'activity_log') {
    // Dedupe, or a re-import triples the hours-of-day chart.
    const key = `${row['created_at']}|${row['type']}|${row['summary']}`;
    return state.existingActivity.has(key) ? null : undefined;
  }
  return undefined;
}
