/**
 * inphub lite: repositories: synced from GitHub, sorted by staleness, health badge,
 * pin, detail drawer with the README.
 *
 * inphub also carried AI repo analysis here: an Analyze button per repo, an
 * "Analyze stale" sweep and a suggestions list backed by repo_suggestions.
 * There is nowhere for any of that to run, so it is gone.
 */

import { apiGet, apiPost } from '../api.ts';
import {
  escapeHtml, fmtDate, timeAgo, markdown, emptyState, toast, onAction, openModal, confirmDialog,
  flashFocused,
  loadingState,
} from '../ui.ts';
import { currentParams } from '../app.ts';

interface Repo {
  id: number; name: string; full_name: string; description: string | null;
  url: string | null; language: string | null; stars: number; forks: number; open_issues: number;
  default_branch: string | null; is_archived: number; is_private: number;
  has_readme: number; has_license: number; readme_excerpt: string | null;
  health_score: number | null; staleness_days: number | null; last_pushed_at: string | null;
  last_synced_at: string | null; pinned: number; is_stale: boolean;
}

let staleDays = 60;
let cache: Repo[] = [];
/** Free-text filter over the loaded repos (name, description, language). */
let repoFilter = '';

export async function renderRepos(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="view-head">
      <div class="toolbar">
        <input type="search" data-role="search" placeholder="Filter repos…" style="width:180px">
        <button class="btn btn-primary" data-action="sync">Sync from GitHub</button>
      </div>
    </div>
    <div data-role="grid">${loadingState()}</div>`;

  const searchEl = container.querySelector<HTMLInputElement>('[data-role="search"]')!;
  searchEl.value = repoFilter;
  searchEl.addEventListener('input', () => {
    repoFilter = searchEl.value.trim();
    render(container);
  });

  onAction(container, (action, el) => {
    const id = Number(el.dataset.id);
    if (action === 'sync') sync(container);
    if (action === 'pin') pin(container, id);
    if (action === 'detail') openDetail(id);
    if (action === 'delete') remove(container, id);
  });

  await load(container);
}

async function load(container: HTMLElement): Promise<void> {
  const res = await apiGet('repos', 'list');
  staleDays = res.stale_repo_days;
  cache = res.repos;
  render(container);
}

/** Paint the cached repos through the text filter. */
function render(container: HTMLElement): void {
  const grid = container.querySelector<HTMLElement>('[data-role="grid"]');
  if (!grid) return;

  if (!cache.length) {
    grid.innerHTML = emptyState('', 'No repos yet. Add a GitHub username in Settings, then sync.');
    return;
  }
  const q = repoFilter.toLowerCase();
  const shown = q
    ? cache.filter((r) => `${r.full_name} ${r.description ?? ''} ${r.language ?? ''}`.toLowerCase().includes(q))
    : cache;

  grid.innerHTML = shown.length
    ? `<div class="grid grid-3">${shown.map(card).join('')}</div>`
    : emptyState('', 'No repos match that filter.');
  flashFocused(container, currentParams().get('focus'));
}

function healthClass(score: number | null): string {
  if (score === null) return 'text-dim';
  if (score >= 70) return 'text-good';
  if (score >= 40) return 'text-dim';
  return 'text-bad';
}

function card(r: Repo): string {
  const meta: string[] = [];
  if (r.language) meta.push(escapeHtml(r.language));
  meta.push('★ ' + r.stars);
  if (r.open_issues) meta.push(r.open_issues + ' issues');
  return `<section class="card repo-card" data-row="${r.id}">
    <div class="card-head">
      <h3>${escapeHtml(r.name)} ${r.pinned ? '📌' : ''}</h3>
      <span class="health-ring ${healthClass(r.health_score)}">${r.health_score ?? '-'}</span>
    </div>
    <div class="text-dim" style="min-height:2.6em">${escapeHtml(r.description ?? 'No description.')}</div>
    <div class="repo-meta">${meta.join(' · ')}</div>
    <div class="repo-meta">
      ${r.last_pushed_at ? `pushed ${escapeHtml(timeAgo(r.last_pushed_at))}` : 'never pushed'}
      ${r.is_stale ? '<span class="badge badge-warn">stale</span>' : ''}
      ${r.is_archived ? '<span class="badge badge-bad">archived</span>' : ''}
      ${r.has_license ? '<span class="chip">licensed</span>' : ''}
    </div>
    <div class="row-actions" style="opacity:1;margin-top:6px">
      <button class="btn btn-ghost btn-sm" data-action="detail" data-id="${r.id}">Details</button>
      <button class="btn btn-ghost btn-sm" data-action="pin" data-id="${r.id}">${r.pinned ? 'Unpin' : 'Pin'}</button>
      ${r.url ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">GitHub ↗</a>` : ''}
      <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${r.id}">✕</button>
    </div>
  </section>`;
}

async function sync(container: HTMLElement): Promise<void> {
  const btn = container.querySelector<HTMLButtonElement>('[data-action="sync"]')!;
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const res = await apiPost('sync_repos', 'sync', {});
    toast(`Synced ${res.synced ?? ''} repos.`, 'good');
    await load(container);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Sync failed', 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync from GitHub';
  }
}

async function pin(container: HTMLElement, id: number): Promise<void> {
  try {
    await apiPost('repos', 'pin', { id });
    load(container);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Failed', 'bad');
  }
}

async function remove(container: HTMLElement, id: number): Promise<void> {
  if (!(await confirmDialog('Remove this repo from inphub? (Re-sync re-adds it.)'))) return;
  try {
    await apiPost('repos', 'delete', { id });
    load(container);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Failed', 'bad');
  }
}

async function openDetail(id: number): Promise<void> {
  // repos.php answered {repo, suggestions}. Without repo_suggestions the
  // endpoint returns the repo itself, and the modal is the README and the numbers.
  const r = await apiGet('repos', 'detail', { id });

  openModal({
    title: r.full_name,
    cancelLabel: 'Close',
    confirmLabel: 'Close',
    bodyHtml: `
      <div class="repo-meta">
        <span class="health-ring ${healthClass(r.health_score)}">Health ${r.health_score ?? '-'}</span>
        ${r.language ? `<span>${escapeHtml(r.language)}</span>` : ''}
        <span>★ ${r.stars}</span><span>⑂ ${r.forks}</span>
        ${r.last_pushed_at ? `<span>pushed ${escapeHtml(fmtDate(r.last_pushed_at))}</span>` : ''}
      </div>
      <p>${escapeHtml(r.description ?? '')}</p>
      ${r.readme_excerpt ? `<div class="md" style="max-height:36vh;overflow:auto;border-top:1px solid var(--border);padding-top:12px">${markdown(r.readme_excerpt)}</div>` : ''}`,
  });
}
