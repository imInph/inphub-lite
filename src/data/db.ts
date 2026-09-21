/**
 * inphub lite: the IndexedDB connection, schema and transaction wrapper.
 *
 * The only indexedDB.open() in the app, and withTx() is the only way to reach a
 * store. check-invariants.mjs enforces both: without foreign keys the cascade
 * rules live in tx.ts, and a store reached around them skips those rules with
 * nothing to notice.
 *
 * Careful with transactions. An IDB transaction commits as soon as the microtask
 * queue drains with no request pending against it, so awaiting anything that
 * isn't an IDB request inside one (a fetch, a timeout, even an already-resolved
 * promise in some engines) ends it, and the next store access throws
 * TransactionInactiveError. Work out timestamps, derived values and summary
 * strings first, then open the transaction and only chain IDB requests in it.
 *
 * Stores use { keyPath: 'id', autoIncrement: true } rather than a counter row.
 * put({id: 500}) advances the generator to 501, so an import that keeps original
 * ids leaves it correct, which is the bit people assume autoIncrement gets
 * wrong. A counter in its own transaction hands out duplicate ids across two
 * tabs; in the same transaction it serialises every insert on one row.
 *
 * clear() doesn't reset the generator, so ids jump after a wipe-and-reimport.
 * Cosmetic. Leave it alone.
 */

import type { StoreMap, StoreName } from './types.ts';

export const DB_NAME = 'inphub-lite';
export const DB_VERSION = 1;

/** Thrown for every data-layer failure, with a status the views already read. */
export class DataError extends Error {
  /**
   * Mirrors the HTTP statuses inphub's api.ts threw, because view code branches
   * on them: 0 database unavailable · 404 not found · 409 constraint ·
   * 422 validation · 500 unexpected.
   */
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'DataError';
    this.status = status;
  }
}

/* ---------------------------------------------------------------- migrations */

/**
 * Append-only. Don't edit a shipped migration: an existing database has already
 * run it, so a change only affects fresh installs and the two silently diverge.
 * Add a new entry and bump DB_VERSION instead.
 *
 * Data backfills belong here too; the upgrade transaction is the one place
 * where reading and writing every store at once is free.
 */
const MIGRATIONS: Array<(db: IDBDatabase, tx: IDBTransaction) => void> = [
  /* v1 */ (db) => {
    const auto = (name: StoreName) => db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });

    auto('todos');
    auto('goals');
    auto('notes');
    auto('habits');

    // Unique indexes replace the MySQL UNIQUE KEYs they are named after.
    auto('expense_categories').createIndex('name', 'name', { unique: true });

    const expenses = auto('expenses');
    expenses.createIndex('spent_at', 'spent_at');
    expenses.createIndex('category_id', 'category_id');

    auto('repos').createIndex('full_name', 'full_name', { unique: true });

    // uq_habit_day. This index is about correctness, not speed: it is what stops
    // a double-click creating two rows for the same habit-day.
    const habitLogs = auto('habit_logs');
    habitLogs.createIndex('habit_date', ['habit_id', 'logged_date'], { unique: true });
    habitLogs.createIndex('logged_date', 'logged_date');

    const focus = auto('focus_sessions');
    focus.createIndex('started_at', 'started_at');
    focus.createIndex('linked_todo_id', 'linked_todo_id');

    // The only store that grows per user action forever, so it is the only one
    // that must never be getAll()'d. Read it through the created_at cursor.
    const activity = auto('activity_log');
    activity.createIndex('created_at', 'created_at');
    activity.createIndex('entity', ['entity_type', 'entity_id']);

    db.createObjectStore('settings', { keyPath: 'key' });
    db.createObjectStore('_meta', { keyPath: 'key' });
  },
];

/* ---------------------------------------------------------------- connection */

let conn: IDBDatabase | null = null;
let opening: Promise<IDBDatabase> | null = null;

/** Raised when another tab holds an older connection open, or a newer one wants in. */
export type BlockedReason = 'blocked' | 'outdated';
type BlockedHandler = (reason: BlockedReason) => void;
let onBlocked: BlockedHandler = () => {};

/**
 * Called when the connection cannot proceed because of another tab. Both cases
 * hang the app if ignored, so the shell installs a banner here:
  *   'blocked'   we are upgrading and an older tab still holds the old version.
  *   'outdated'  a newer tab is upgrading, so we closed and need a reload.
 */
export function setBlockedHandler(fn: BlockedHandler): void {
  onBlocked = fn;
}

export function openDb(): Promise<IDBDatabase> {
  if (conn) return Promise.resolve(conn);
  if (opening) return opening;

  opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new DataError('This browser has no local database available.', 0));
      return;
    }

    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      // Firefox in private mode throws here rather than failing the request.
      reject(new DataError('Local database unavailable. Private browsing blocks it.', 0));
      return;
    }

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      if (!tx) return;
      for (let v = event.oldVersion; v < DB_VERSION; v++) MIGRATIONS[v]?.(db, tx);
      tx.objectStore('_meta').put({ key: 'schema_version', value: DB_VERSION });
    };

    req.onblocked = () => onBlocked('blocked');

    req.onsuccess = () => {
      const db = req.result;
      // A newer tab is upgrading and is stuck on its own onblocked until we let
      // go. Close immediately; the app is unusable until it reloads either way.
      db.onversionchange = () => {
        db.close();
        conn = null;
        opening = null;
        onBlocked('outdated');
      };
      db.onclose = () => { conn = null; opening = null; };
      conn = db;
      resolve(db);
    };

    req.onerror = () => {
      opening = null;
      reject(new DataError(
        req.error?.name === 'QuotaExceededError'
          ? 'No room left to store data. Export a backup and free some space.'
          : 'Local database unavailable.',
        0,
      ));
    };
  });

  return opening;
}

/* -------------------------------------------------------------- request glue */

/** Promise wrapper for a single IDB request. Safe to await inside a transaction. */
export function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const err = request.error;
      reject(new DataError(
        err?.name === 'ConstraintError' ? 'That value already exists.' : (err?.message || 'Database write failed.'),
        err?.name === 'ConstraintError' ? 409 : 500,
      ));
    };
  });
}

/** Walk an index or store with a cursor, stopping when `each` returns false. */
export async function cursorEach(
  source: IDBObjectStore | IDBIndex,
  range: IDBKeyRange | null,
  direction: IDBCursorDirection,
  each: (value: any) => boolean | void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = source.openCursor(range, direction);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      if (each(cursor.value) === false) { resolve(); return; }
      cursor.continue();
    };
    request.onerror = () => reject(new DataError(request.error?.message || 'Database read failed.'));
  });
}

/* --------------------------------------------------------------- withTx */

/**
 * A transaction's stores, minus delete().
 *
 * Hiding delete() is deliberate and structural: remove() in tx.ts is the only
 * place that applies the cascade / set-null rules in relations.ts, so a direct
 * store.delete() would leave orphaned habit_logs or dangling category ids with
 * nothing to notice. check-invariants.mjs catches the textual case; this
 * catches it in the type system.
 */
export type SafeStore = Omit<IDBObjectStore, 'delete' | 'clear'>;

export interface TxStores {
  <S extends StoreName>(name: S): SafeStore;
}

export async function withTx<T>(
  stores: readonly StoreName[],
  mode: IDBTransactionMode,
  run: (store: TxStores, tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores as string[], mode);
    } catch (e) {
      reject(new DataError(`Could not open a transaction on ${stores.join(', ')}.`));
      return;
    }

    let result: T;
    let settled = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      reject(e instanceof DataError ? e : new DataError(e instanceof Error ? e.message : 'Database error.'));
      try { tx.abort(); } catch { /* already finished */ }
    };

    tx.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
    tx.onerror = () => fail(new DataError(tx.error?.message || 'Transaction failed.'));
    tx.onabort = () => fail(new DataError(tx.error?.message || 'Transaction aborted.'));

    const get: TxStores = (name) => tx.objectStore(name) as SafeStore;

    Promise.resolve()
      .then(() => run(get, tx))
      .then((value) => { result = value; })
      .catch(fail);
  });
}

/** Read-only convenience: the whole store as an array. */
export async function getAll<S extends StoreName>(name: S): Promise<StoreMap[S][]> {
  return withTx([name], 'readonly', (s) => req((s(name) as IDBObjectStore).getAll()));
}

/** Read-only convenience: one record by key, or null. */
export async function getOne<S extends StoreName>(
  name: S, key: IDBValidKey,
): Promise<StoreMap[S] | null> {
  const row = await withTx([name], 'readonly', (s) => req((s(name) as IDBObjectStore).get(key)));
  return (row as StoreMap[S] | undefined) ?? null;
}

/* ----------------------------------------------------------------- _meta */

export async function meta<T>(key: string, fallback: T): Promise<T> {
  const row = await getOne('_meta', key);
  return row ? (row.value as T) : fallback;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await withTx(['_meta'], 'readwrite', (s) => req((s('_meta') as IDBObjectStore).put({ key, value })));
}
