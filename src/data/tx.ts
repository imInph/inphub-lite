/**
 * inphub lite: create / update / remove, and the only place a row is deleted.
 *
 * All the things the PHP endpoints used to do on the way in and out of a query.
 *
 * Timestamps are stamped here so a caller can't reach for toISOString() and
 * break the local-wall-clock rule in dates.ts. remove() applies the cascade and
 * set-null rules from relations.ts, which is what replaces MySQL's foreign keys.
 *
 * The log argument is required, deliberately: leave it off and tsc fails. It's
 * not a convention because conventions get forgotten, and a mutation that writes
 * no activity row is a hole in the History view and in Insights' hours chart,
 * both of which read nothing but activity_log. Where a mutation genuinely
 * shouldn't log, pass SILENT, so `grep -rn SILENT src/` lists every one of them.
 *
 * The activity row goes in the same transaction, after the add() resolves, so
 * entity_id is the real id and a failed write can't leave a log line claiming
 * it worked.
 *
 * Same transaction warning as db.ts: compute everything before opening one.
 */

import { DataError, req, withTx, cursorEach } from './db.ts';
import { now } from './dates.ts';
import { childrenOf } from './relations.ts';
import type { ActivityType, EntityType } from './activity-types.ts';
import type { Activity, Actor, Input, RecordStoreName, StoreMap, StoreName } from './types.ts';

/** What to write to activity_log for a mutation. */
export interface LogDraft {
  type: ActivityType;
  entity_type: EntityType;
  /** One human line, as it appears in History. Truncated to 500 like MySQL's column. */
  summary: string;
  /**
   * The row History should link to, when that is not the row being written.
   * Logging a habit writes a habit_logs row but the event is about the HABIT,
   * and that is the id the History deep link needs. Defaults to the written row.
   */
  entity_id?: number | null;
  /** 'user' unless something automatic did it. lite never writes 'ai'. */
  actor?: Actor;
  metadata?: Record<string, unknown> | null;
}

/**
 * "This mutation writes no history, on purpose."
 *
 * Legitimate uses are narrow: reordering (sort_order churn), the bulk upsert in
 * a GitHub sync (one summary row covers the batch), and the importer (it writes
 * its own single row). Anything else should log.
 */
export const SILENT = Symbol('no activity row');
export type Silent = typeof SILENT;

type LogFor<T> = ((record: T) => LogDraft) | Silent;
type LogForUpdate<T> = ((before: T, after: T) => LogDraft) | Silent;

const ACTIVITY: StoreName = 'activity_log';

/** Build the activity row. Kept out of the transaction body: pure, no IDB. */
function draftRow(draft: LogDraft, at: string): Omit<Activity, 'id'> {
  return {
    type: draft.type,
    entity_type: draft.entity_type,
    entity_id: draft.entity_id ?? null,
    // MySQL's summary column is VARCHAR(500); keep the same ceiling so an
    // inphub export and a lite export stay interchangeable.
    summary: draft.summary.slice(0, 500),
    actor: draft.actor ?? 'user',
    metadata: draft.metadata ?? null,
    created_at: at,
  };
}

/* ------------------------------------------------------------------ create */

export async function create<S extends RecordStoreName>(
  store: S,
  value: Input<S>,
  log: LogFor<StoreMap[S]>,
): Promise<StoreMap[S]> {
  const at = now();
  const row = { created_at: at, ...(value as object) } as StoreMap[S];
  delete (row as { id?: number }).id;   // the store assigns it

  return withTx([store, ACTIVITY], 'readwrite', async (s) => {
    const id = await req((s(store) as IDBObjectStore).add(row)) as number;
    const saved = { ...row, id } as StoreMap[S];
    if (log !== SILENT) {
      const entry = draftRow(log(saved), at);
      entry.entity_id ??= id;
      await req((s(ACTIVITY) as IDBObjectStore).add(entry));
    }
    return saved;
  });
}

/* ------------------------------------------------------------------ update */

export async function update<S extends RecordStoreName>(
  store: S,
  id: number,
  patch: Partial<StoreMap[S]>,
  log: LogForUpdate<StoreMap[S]>,
): Promise<StoreMap[S]> {
  const at = now();

  return withTx([store, ACTIVITY], 'readwrite', async (s) => {
    const os = s(store) as IDBObjectStore;
    const before = await req(os.get(id)) as StoreMap[S] | undefined;
    if (!before) throw new DataError('That item no longer exists.', 404);

    const after = { ...before, ...patch, id } as StoreMap[S];
    // Only stamp stores that actually carry the column, as MySQL's ON UPDATE did.
    if ('updated_at' in after) (after as { updated_at: string }).updated_at = at;

    await req(os.put(after));
    if (log !== SILENT) {
      const entry = draftRow(log(before, after), at);
      entry.entity_id ??= id;
      await req((s(ACTIVITY) as IDBObjectStore).add(entry));
    }
    return after;
  });
}

/* ------------------------------------------------------------------ remove */

/**
 * Delete a row and everything the relations say goes with it.
 *
 * The only delete in the app. Reaching a store directly and calling
 * .delete() would orphan habit_logs or leave an expense pointing at a category
 * that is gone, silently, because nothing checks.
 */
export async function remove<S extends RecordStoreName>(
  store: S,
  id: number,
  log: LogFor<StoreMap[S]>,
): Promise<void> {
  const at = now();
  const relations = childrenOf(store);
  const stores: StoreName[] = [store, ACTIVITY, ...relations.map((r) => r.child)];

  await withTx(stores, 'readwrite', async (s) => {
    const os = s(store) as IDBObjectStore;
    const row = await req(os.get(id)) as StoreMap[S] | undefined;
    if (!row) throw new DataError('That item no longer exists.', 404);

    for (const rel of relations) {
      const child = s(rel.child) as IDBObjectStore;
      const index = child.index(rel.index);
      // habit_logs' index is compound ([habit_id, logged_date]), so the range
      // has to span every date under this parent id rather than match a key.
      const range = index.keyPath instanceof Array
        ? IDBKeyRange.bound([id, ''], [id, '￿'])
        : IDBKeyRange.only(id);

      const affected: any[] = [];
      await cursorEach(index, range, 'next', (v) => { affected.push(v); });

      for (const childRow of affected) {
        if (rel.onDelete === 'cascade') await req(child.delete(childRow.id));
        else await req(child.put({ ...childRow, [rel.fk]: null }));
      }
    }

    await req(os.delete(id));
    if (log !== SILENT) {
      const entry = draftRow(log(row), at);
      entry.entity_id ??= id;
      await req((s(ACTIVITY) as IDBObjectStore).add(entry));
    }
  });
}

/* -------------------------------------------------------------------- bulk */

/**
 * Rewrite several rows of one store in a single transaction.
 *
 * For the writes that are one logical action over many rows: a drag-reorder, a
 * GitHub sync. Doing those as N update() calls would be N transactions, so a
 * failure halfway leaves the order half-applied. Takes the same required log
 * argument as everything else, and usually gets SILENT, because one line per
 * touched row would bury everything else in History.
 */
export async function bulk<S extends RecordStoreName>(
  store: S,
  rows: StoreMap[S][],
  log: LogDraft | Silent,
): Promise<number> {
  const at = now();
  const entry = log === SILENT ? null : draftRow(log, at);

  return withTx([store, ACTIVITY], 'readwrite', async (s) => {
    const os = s(store) as IDBObjectStore;
    for (const row of rows) await req(os.put(row));
    if (entry) await req((s(ACTIVITY) as IDBObjectStore).add(entry));
    return rows.length;
  });
}

/* --------------------------------------------------------------- bare log */

/**
 * Write a history row for something that is not a single-record mutation: a
 * GitHub sync, an import. Everything else should log through the primitives
 * above so the row and the write share a transaction.
 */
export async function logOnly(draft: LogDraft, entityId: number | null = null): Promise<void> {
  const entry = draftRow(draft, now());
  entry.entity_id = entityId;
  await withTx([ACTIVITY], 'readwrite', (s) => req((s(ACTIVITY) as IDBObjectStore).add(entry)));
}
