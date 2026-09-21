/**
 * inphub lite: repositories. api/repos.php plus api/sync_repos.php.
 *
 * The AI half of inphub's Repos view is gone with everything else AI: there are
 * no repo_suggestions, so the detail modal is the README and the numbers.
 */

import { getAll, req, withTx, DataError } from '../db.ts';
import { bulk, logOnly, remove, SILENT, update } from '../tx.ts';
import { bool, int } from '../normalize.ts';
import { getSetting } from '../settings.ts';
import { fetchReadme, getToken, hasLicenseFile, listRepos, toRow } from '../../github.ts';
import type { Repo } from '../types.ts';

export interface RepoRow extends Repo {
  is_stale: boolean;
}

export interface RepoList {
  repos: RepoRow[];
  stale_repo_days: number;
}

/** ORDER BY pinned DESC, (staleness_days IS NULL), staleness_days DESC, name ASC. */
export async function list(): Promise<RepoList> {
  const [rows, staleSetting] = await Promise.all([getAll('repos'), getSetting('stale_repo_days', '60')]);
  const staleDays = int(staleSetting, 60);

  const repos = rows
    .sort((a, b) =>
      b.pinned - a.pinned
      || Number(a.staleness_days === null) - Number(b.staleness_days === null)
      || (b.staleness_days ?? 0) - (a.staleness_days ?? 0)
      || a.name.localeCompare(b.name)
      || b.id - a.id)
    .map((r) => ({ ...r, is_stale: r.staleness_days !== null && r.staleness_days >= staleDays }));

  return { repos, stale_repo_days: staleDays };
}

export async function detail(id: number): Promise<RepoRow> {
  const { repos } = await list();
  const row = repos.find((r) => r.id === id);
  if (!row) throw new DataError('That repository is not here.', 404);
  return row;
}

/** Toggles when `pinned` is absent, as repos.php did. */
export async function pin(id: number, pinned?: unknown): Promise<Repo> {
  const existing = (await getAll('repos')).find((r) => r.id === id);
  if (!existing) throw new DataError('That repository is not here.', 404);
  const next = pinned === undefined ? (existing.pinned ? 0 : 1) : bool(pinned);
  return update('repos', id, { pinned: next }, SILENT);
}

export async function deleteRepo(id: number): Promise<void> {
  await remove('repos', id, SILENT);
}

/**
 * Pull everything from GitHub and upsert on full_name.
 *
 * All the network work happens before any transaction opens, which is not
 * stylistic: an IndexedDB transaction ends the moment you await something that
 * is not an IDB request, and the next store access then throws. See db.ts.
 *
 * One activity row for the batch rather than one per repo, so a sync does not
 * bury the rest of History.
 */
export async function sync(): Promise<{ synced: number }> {
  const [username, token] = await Promise.all([
    getSetting('github_username', ''),
    Promise.resolve(getToken()),
  ]);

  const remote = await listRepos(username, token);

  // Sequential on purpose: two extra calls per repo in parallel is the quickest
  // way to spend the rate limit on a large account.
  const rows = [];
  for (const repo of remote) {
    const readme = await fetchReadme(repo.full_name, token);
    const license = repo.license !== null || await hasLicenseFile(repo.full_name, token);
    rows.push(toRow(repo, readme, license));
  }

  const existing = await getAll('repos');
  const byName = new Map(existing.map((r) => [r.full_name, r]));
  const merged = rows.map((row) => {
    const prev = byName.get(row.full_name);
    // pinned is the user's, not GitHub's, so a sync must not clear it.
    return prev ? { ...prev, ...row, pinned: prev.pinned } : { ...row, pinned: 0 as const, created_at: row.last_synced_at };
  });

  const updates = merged.filter((r) => 'id' in r);
  const inserts = merged.filter((r) => !('id' in r));

  if (updates.length) await bulk('repos', updates as Repo[], SILENT);
  if (inserts.length) {
    await withTx(['repos'], 'readwrite', async (s) => {
      const os = s('repos') as IDBObjectStore;
      for (const row of inserts) await req(os.add(row));
    });
  }

  await logOnly({
    type: 'repos.synced',
    entity_type: 'repo',
    summary: `Synced ${merged.length} repositor${merged.length === 1 ? 'y' : 'ies'}`,
    actor: 'system',
    metadata: { count: merged.length },
  });

  return { synced: merged.length };
}
