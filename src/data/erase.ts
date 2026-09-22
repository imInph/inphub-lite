/**
 * inphub lite: erasing everything.
 *
 * The counterpart to a restore, and the second and last module allowed to call
 * clear(). import.ts owns the wipe that precedes a replace-mode restore; this
 * owns the wipe that stands on its own. Both are on the check-invariants
 * allowlist for the same reason: clear() is the only way to empty a store, so
 * every caller of it should be a file you would think to open before trusting
 * this app with the only copy of your data.
 *
 * Scope is "everything this app put in this browser": every data store, the
 * _meta bookkeeping the backup nag reads, and lite's own localStorage keys,
 * which is where the GitHub token lives. A button labelled "Erase all data"
 * that leaves a credential behind is the worst kind of surprise.
 *
 * What it deliberately does not touch is the 'inphub.' localStorage namespace.
 * <user>.github.io is one origin for every project published there, so those
 * keys may well belong to a real inphub deployment living next door, and
 * erasing lite's data is not permission to erase another app's.
 *
 * Counting happens in the same transaction as the wipe, so the number the user
 * is told afterwards is the number that actually went, the same promise
 * parseBackup() makes on the way in.
 */

import { req, withTx, setMeta } from './db.ts';
import { today } from './dates.ts';
import { logOnly } from './tx.ts';
import { DATA_STORES } from './types.ts';

/** Every localStorage key this app owns. The GitHub token is one of them. */
const LOCAL_PREFIX = 'inphub-lite:';

export interface EraseResult {
  /** Rows removed per store, for the toast and the one History row left behind. */
  erased: Record<string, number>;
  total: number;
}

/**
 * How much there is to lose, for the confirmation dialog.
 *
 * count() rather than getAll(): activity_log is the one store with unbounded
 * growth and must never be read whole.
 */
export async function countEverything(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await withTx([...DATA_STORES], 'readonly', async (s) => {
    for (const store of DATA_STORES) {
      counts[store] = await req((s(store) as IDBObjectStore).count());
    }
  });
  return counts;
}

/**
 * Wipe the database, the bookkeeping and this app's localStorage.
 *
 * There is no undo. The caller's job is to be sure before calling; settings.ts
 * shows the real counts and asks the user to type the word.
 */
export async function eraseEverything(): Promise<EraseResult> {
  // Before the transaction: it auto-commits the moment the microtask queue
  // drains with no IDB request pending, so anything that isn't a request has
  // to be computed up front.
  const stores = [...DATA_STORES];
  const startedOn = today();
  const erased: Record<string, number> = {};

  await withTx(stores, 'readwrite', async (s) => {
    for (const store of stores) {
      const os = s(store) as IDBObjectStore;
      // count() and clear() are both IDB requests, so the transaction survives
      // the loop. clear() leaves the autoIncrement generator alone, exactly as
      // in import.ts, so ids carry on from where they were. That is cosmetic.
      erased[store] = await req(os.count());
      await req(os.clear());
    }
  });

  // The nag in main.ts reads these, and a database with nothing in it has
  // never been exported. meta() treats a stored null as absent, so writing null
  // resets the pair without needing a delete().
  await setMeta('last_export_at', null);
  await setMeta('last_import_at', null);
  await setMeta('first_run_at', startedOn);

  clearLocalStorage();

  const total = Object.values(erased).reduce((n, c) => n + c, 0);

  // One row survives the wipe, written after it. The log is what History and
  // the Insights hours chart are built from, so the single biggest mutation in
  // the app is not the one that writes nothing. It names no erased content.
  await logOnly({
    type: 'data.erased',
    entity_type: 'data',
    summary: `Erased all data (${total} rows)`,
    actor: 'user',
    metadata: { counts: erased },
  });

  return { erased, total };
}

/**
 * Drop every key in lite's namespace: the theme and appearance cache the
 * pre-paint script reads, and the GitHub token.
 *
 * By prefix rather than by naming the three keys, so a key added later is
 * erased by a button that already promises to erase everything, instead of
 * quietly outliving it.
 */
function clearLocalStorage(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(LOCAL_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    /* storage unavailable; the database is what mattered */
  }
}
