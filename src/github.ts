/**
 * inphub lite: GitHub sync, straight from the browser.
 *
 * inphub did this server-side with cURL because the token lived in MySQL.
 * api.github.com sends Access-Control-Allow-Origin, so a page can call it
 * directly and the only thing that had to move is where the token is kept.
 *
 * ON THE TOKEN. It sits in localStorage, which means anything that can run
 * JavaScript on this origin can read it, and <user>.github.io is ONE origin for
 * every project published there. Settings says so next to the field. Use a
 * fine-grained token, read-only, with an expiry. It is never written to
 * IndexedDB and never included in a backup.
 *
 * This is the only file besides sw.ts allowed to call fetch(), which
 * check-invariants enforces: an offline-first app should not be reaching for
 * the network anywhere else.
 */

import { DataError } from './data/db.ts';
import { localDateTime } from './data/dates.ts';

const API = 'https://api.github.com';
const TOKEN_KEY = 'inphub-lite:github_token';
/** inphub stopped at 10 pages of 100; a personal account never gets near it. */
const MAX_PAGES = 10;

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  default_branch: string;
  archived: boolean;
  private: boolean;
  pushed_at: string | null;
  license: { key: string } | null;
}

async function call(path: string, token: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, { headers });
  if (res.status === 401) throw new DataError('GitHub rejected that token.', 401);
  if (res.status === 403 && res.headers.get('X-RateLimit-Remaining') === '0') {
    const reset = Number(res.headers.get('X-RateLimit-Reset') ?? 0) * 1000;
    const mins = reset ? Math.max(1, Math.round((reset - Date.now()) / 60000)) : null;
    throw new DataError(
      `GitHub's rate limit is spent${mins ? `, try again in about ${mins} min` : ''}.`
      + (token ? '' : ' Adding a token raises it from 60 to 5000 an hour.'),
      429,
    );
  }
  return res;
}

/**
 * Every repo the account owns, newest push first.
 *
 * With a token this reads /user/repos, which includes private ones. Without,
 * it falls back to the public listing for a username, which is 60 requests an
 * hour and public repos only.
 */
export async function listRepos(username: string, token: string): Promise<GitHubRepo[]> {
  if (!token && !username) {
    throw new DataError('Add a GitHub username or a token in Settings first.', 422);
  }
  const base = token
    ? '/user/repos?per_page=100&affiliation=owner&sort=pushed'
    : `/users/${encodeURIComponent(username)}/repos?per_page=100&sort=pushed`;

  const out: GitHubRepo[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await call(`${base}&page=${page}`, token);
    if (!res.ok) {
      if (page === 1) throw new DataError(`GitHub said ${res.status}.`, 502);
      break;
    }
    const batch = await res.json() as GitHubRepo[];
    out.push(...batch);
    if (batch.length < 100) break;   // a short page is the last page
  }
  return out;
}

/**
 * The README's first 4000 characters, or null.
 *
 * base64 via atob alone mangles anything non-ASCII, which for this owner means
 * most of them. Decoding the bytes through TextDecoder is what keeps Turkish
 * and emoji intact.
 */
export async function fetchReadme(fullName: string, token: string): Promise<string | null> {
  try {
    const res = await call(`/repos/${fullName}/readme`, token);
    if (!res.ok) return null;
    const body = await res.json() as { content?: string; encoding?: string };
    if (!body.content) return null;
    const binary = atob(body.content.replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes).trim().slice(0, 4000);
  } catch {
    return null;
  }
}

/** repo.license covers most of it; this catches a LICENSE file GitHub did not classify. */
export async function hasLicenseFile(fullName: string, token: string): Promise<boolean> {
  try {
    return (await call(`/repos/${fullName}/license`, token)).ok;
  } catch {
    return false;
  }
}

/** Whole days since the last push, or null when GitHub reports none. */
export function stalenessDays(pushedAt: string | null, now: Date = new Date()): number | null {
  if (!pushedAt) return null;
  return Math.floor((now.getTime() - Date.parse(pushedAt)) / 86_400_000);
}

/**
 * repo_health_score() from api/sync_repos.php, step for step.
 *
 * A step function rather than a curve on purpose: it is meant to be explainable
 * at a glance, not precise. Note stale_repo_days is a SEPARATE setting for the
 * "is stale" badge and does not feed this.
 */
export function repoHealthScore(input: {
  hasReadme: boolean;
  hasLicense: boolean;
  hasDescription: boolean;
  stalenessDays: number | null;
  openIssues: number;
}): number {
  let score = 0;
  if (input.hasReadme) score += 25;
  if (input.hasLicense) score += 15;
  if (input.hasDescription) score += 15;

  const s = input.stalenessDays;
  if (s === null) score += 0;
  else if (s < 7) score += 30;
  else if (s < 30) score += 22;
  else if (s < 60) score += 15;
  else if (s < 180) score += 8;

  const issues = input.openIssues;
  if (issues === 0) score += 15;
  else if (issues <= 5) score += 10;
  else if (issues <= 15) score += 5;

  return Math.min(100, Math.max(0, score));
}

/** One GitHub repo mapped to a row, ready for the store. */
export function toRow(repo: GitHubRepo, readme: string | null, license: boolean, now = new Date()) {
  const stale = stalenessDays(repo.pushed_at, now);
  return {
    github_id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    description: repo.description,
    url: repo.html_url,
    language: repo.language,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    open_issues: repo.open_issues_count,
    default_branch: repo.default_branch || 'main',
    is_archived: repo.archived ? 1 : 0,
    is_private: repo.private ? 1 : 0,
    has_readme: readme !== null ? 1 : 0,
    has_license: license ? 1 : 0,
    readme_excerpt: readme,
    health_score: repoHealthScore({
      hasReadme: readme !== null,
      hasLicense: license,
      hasDescription: !!repo.description,
      stalenessDays: stale,
      openIssues: repo.open_issues_count,
    }),
    staleness_days: stale,
    last_pushed_at: repo.pushed_at ? localDateTime(new Date(repo.pushed_at)) : null,
    last_synced_at: localDateTime(now),
  } as const;
}
