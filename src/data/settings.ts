/**
 * inphub lite: settings, appearance and the first-run seed.
 *
 * The defaults are default_settings() from inphub's lib/provision.php without
 * the eight AI keys, so a fresh install of either one starts out looking the
 * same. Seeding is guarded per store by a count check like provision_user() is,
 * so calling it on every boot is safe.
 *
 * Settings live in IndexedDB and go into a backup. The theme and appearance are
 * also cached in localStorage, but only because the pre-paint script in
 * index.html has to read them synchronously before the first paint and
 * IndexedDB can't do that; app.ts keeps that cache in sync. The GitHub token is
 * localStorage only, never the database and never an export (see github.ts).
 */

import { getAll, req, withTx } from './db.ts';
import { now } from './dates.ts';
import type { ExpenseCategory, Habit, Setting } from './types.ts';

/** Exactly the keys the UI may write, as ALLOWED_SETTING_KEYS did in PHP. */
export const DEFAULT_SETTINGS: Record<string, string> = {
  theme: 'dark',
  base_currency: 'TRY',
  starting_balance: '0',
  owner_name: '',
  github_username: '',
  stale_repo_days: '60',
};

/** Appearance keys are not seeded; they fall back to the values below. */
export const UI_ACCENTS = ['blue', 'indigo', 'purple', 'pink', 'red', 'orange', 'green', 'teal', 'graphite'] as const;
export const UI_WALLPAPERS = ['aurora', 'sunset', 'ocean', 'forest', 'graphite', 'plain', 'custom'] as const;
export const UI_TRANSPARENCY = ['full', 'reduced'] as const;
export const UI_LOGO_TINTS = ['accent', 'wallpaper'] as const;

export interface Appearance {
  accent: string;
  wallpaper: string;
  wallpaper_url: string;
  transparency: string;
  /** 'accent' | 'wallpaper': where the logo badge's gradient comes from. */
  logo_tint: string;
}

/* ------------------------------------------------------------------- read */

export async function allSettings(): Promise<Record<string, string>> {
  const rows = await getAll('settings');
  const out: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export async function getSetting(key: string, fallback = ''): Promise<string> {
  const all = await allSettings();
  return all[key] ?? fallback;
}

/** Write a batch. Validation belongs to the caller (api/settings equivalent). */
export async function saveSettings(values: Record<string, string>): Promise<void> {
  const at = now();
  const rows: Setting[] = Object.entries(values).map(([key, value]) => ({ key, value, updated_at: at }));
  await withTx(['settings'], 'readwrite', async (s) => {
    const os = s('settings') as IDBObjectStore;
    for (const row of rows) await req(os.put(row));
  });
}

/**
 * Resolve the look, as ui_appearance() does in lib/helpers.php, including the
 * odd rule at the end: the plain and custom wallpapers have no palette, so a
 * 'wallpaper' logo tint has nothing to read and falls back to the accent.
 * Settings locks that toggle there for the same reason.
 */
export function appearanceFrom(s: Record<string, string>): Appearance {
  const pick = (key: string, allowed: readonly string[], fallback: string): string => {
    const v = s[key] ?? '';
    return allowed.includes(v) ? v : fallback;
  };
  const wallpaper = pick('ui_wallpaper', UI_WALLPAPERS, 'aurora');
  const url = s['ui_wallpaper_url'] ?? '';
  return {
    accent: pick('ui_accent', UI_ACCENTS, 'blue'),
    wallpaper,
    wallpaper_url: /^https?:\/\//i.test(url) ? url : '',
    transparency: pick('ui_transparency', UI_TRANSPARENCY, 'full'),
    logo_tint: wallpaper === 'plain' || wallpaper === 'custom'
      ? 'accent'
      : pick('ui_logo_tint', UI_LOGO_TINTS, 'accent'),
  };
}

/* ------------------------------------------------------------------- seed */

/** default_categories() from lib/provision.php. No budgets, as there. */
const SEED_CATEGORIES: Array<Pick<ExpenseCategory, 'name' | 'color' | 'icon'>> = [
  { name: 'Food & Drink', color: '#f97316', icon: '🍔' },
  { name: 'Transport', color: '#3b82f6', icon: '🚌' },
  { name: 'Tech & Gadgets', color: '#8b5cf6', icon: '💻' },
  { name: 'Cubing', color: '#22c55e', icon: '🧩' },
  { name: 'Games', color: '#ec4899', icon: '🎮' },
  { name: 'Subscriptions', color: '#eab308', icon: '🔁' },
  { name: 'Education', color: '#14b8a6', icon: '📚' },
  { name: 'Other', color: '#6b7280', icon: '📦' },
];

/** default_habits() from lib/provision.php. */
const SEED_HABITS: Array<Omit<Habit, 'id' | 'created_at'>> = [
  { name: 'Cube practice', description: 'Timed solves / algorithm drills', frequency: 'daily', target_per_period: 1, color: '#22c55e', icon: '🧩', is_active: 1, sort_order: 1 },
  { name: 'Ship code', description: 'Commit something to a repo', frequency: 'daily', target_per_period: 1, color: '#8b5cf6', icon: '💾', is_active: 1, sort_order: 2 },
  { name: 'Read', description: 'Read anything non-screen', frequency: 'daily', target_per_period: 1, color: '#14b8a6', icon: '📖', is_active: 1, sort_order: 3 },
  { name: 'Move', description: 'Exercise / walk', frequency: 'daily', target_per_period: 1, color: '#f97316', icon: '🏃', is_active: 1, sort_order: 4 },
];

/**
 * Fill in the defaults for any of the three stores that's still empty.
 *
 * Count guards per store rather than one "already seeded" flag, so deleting
 * every habit on purpose doesn't get undone on the next boot. Only a genuinely
 * empty store gets filled, which is what provision_user() does too.
 *
 * Seeding writes no activity rows on purpose. A brand new History full of
 * "Habit added" lines you didn't do would just be noise.
 */
export async function seedIfEmpty(): Promise<void> {
  const at = now();

  await withTx(['settings', 'expense_categories', 'habits'], 'readwrite', async (s) => {
    const settings = s('settings') as IDBObjectStore;
    if (await req(settings.count()) === 0) {
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        await req(settings.put({ key, value, updated_at: at }));
      }
    }

    const categories = s('expense_categories') as IDBObjectStore;
    if (await req(categories.count()) === 0) {
      for (const c of SEED_CATEGORIES) {
        await req(categories.add({ ...c, monthly_budget: null, created_at: at }));
      }
    }

    const habits = s('habits') as IDBObjectStore;
    if (await req(habits.count()) === 0) {
      for (const h of SEED_HABITS) await req(habits.add({ ...h, created_at: at }));
    }
  });
}
