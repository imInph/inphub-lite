/**
 * inphub lite: the History feed. api/activity.php.
 *
 * Read-only: nothing writes here except tx.ts, which is the point of that file.
 *
 * Never getAll() this store. It gains a row on every mutation and is the only
 * one with unbounded growth, so the newest N come off a reverse cursor on the
 * created_at index. That also matches PHP's ORDER BY created_at DESC, id DESC
 * exactly, because the auto-increment id breaks ties in the same direction.
 */

import { cursorEach, withTx } from '../db.ts';
import { clampInt, str } from '../normalize.ts';
import type { Activity, Actor } from '../types.ts';

export interface ActivityFilter {
  limit?: string | number;
  actor?: string;
  type?: string;
}

const ACTORS: readonly Actor[] = ['user', 'ai', 'system'];

export async function list(filter: ActivityFilter = {}): Promise<Activity[]> {
  const limit = clampInt(filter.limit ?? 100, 1, 500, 100);
  const actor = str(filter.actor);
  const type = str(filter.type);
  const wantActor = actor !== null && (ACTORS as readonly string[]).includes(actor) ? actor : null;

  const out: Activity[] = [];
  await withTx(['activity_log'], 'readonly', (s) =>
    cursorEach((s('activity_log') as IDBObjectStore).index('created_at'), null, 'prev', (row) => {
      const a = row as Activity;
      // Filtering inside the cursor rather than after it, so a narrow filter
      // still stops as soon as it has enough rows.
      if (wantActor !== null && a.actor !== wantActor) return;
      if (type !== null && a.type !== type) return;
      out.push(a);
      return out.length < limit;
    }));
  return out;
}

/** The distinct types present, for the History filter dropdown. */
export async function types(): Promise<string[]> {
  const seen = new Set<string>();
  await withTx(['activity_log'], 'readonly', (s) =>
    cursorEach((s('activity_log') as IDBObjectStore).index('created_at'), null, 'prev', (row) => {
      seen.add((row as Activity).type);
    }));
  return [...seen].sort();
}
