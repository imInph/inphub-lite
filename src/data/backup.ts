/**
 * inphub lite: the shared backup format, reading and writing.
 *
 * The mirror of inphub's lib/backup.php. BACKUP-FORMAT.md is the contract and
 * the copy in the inphub repo is identical; change one and change all three.
 *
 * lite's stores are already the shapes the format wants (numbers are numbers,
 * datetimes carry a T, there is no user_id), so there is far less conversion
 * here than on the PHP side. What this file does carry is the list of tables
 * inphub has and lite does not, because those have to be counted and reported
 * rather than dropped in silence.
 */

import { getAll } from './db.ts';
import { localDateTime } from './dates.ts';
import { bool, dateOrNull, dateTimeOrNull, enumOf, int, intOrNull, json, money,
  moneyOrNull, str, text } from './normalize.ts';
import { DATA_STORES, type DataStoreName } from './types.ts';

export const BACKUP_FORMAT = 'inphub-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** Kept in localStorage, never in the database and never in a file. */
export const SECRET_SETTING_KEYS = ['github_token', 'claude_api_key', 'lmstudio_api_key'];

/**
 * inphub's AI and chat tables. lite has nowhere to put them, so an import counts
 * them and says so. Saying so matters: a silent drop looks like data loss.
 */
export const INPHUB_ONLY_TABLES = ['repo_suggestions', 'daily_briefs', 'chat_sessions', 'chat_messages'];

export interface BackupDoc {
  format: string;
  format_version: number;
  app: string;
  app_version: string;
  exported_at: string;
  counts: Record<string, number>;
  data: Record<string, unknown[]>;
}

/** A file that cannot be imported, with the status a view can branch on. */
export class BackupError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = 'BackupError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ write */

export async function buildBackup(appVersion: string): Promise<BackupDoc> {
  const data: Record<string, unknown[]> = {};

  for (const store of DATA_STORES) {
    if (store === 'settings') {
      const rows = await getAll('settings');
      data['settings'] = rows
        .filter((r) => !SECRET_SETTING_KEYS.includes(r.key))
        .map((r) => ({ key: r.key, value: r.value }));
      continue;
    }
    data[store] = await getAll(store);
  }

  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(data)) counts[table] = rows.length;

  return {
    format: BACKUP_FORMAT,
    format_version: BACKUP_FORMAT_VERSION,
    app: 'inphub-lite',
    app_version: appVersion,
    exported_at: localDateTime(),
    counts,
    data,
  };
}

/* ------------------------------------------------------------------- read */

type Coercer = (row: Record<string, unknown>) => Record<string, unknown>;

/**
 * One coercer per store, and the same ones the create paths would use.
 *
 * This is where an inphub file stops being MySQL-shaped. PDO with
 * EMULATE_PREPARES off hands DECIMAL and often INT back as strings, so an older
 * file says "amount": "42.50" and "id": "17". Miss the ids and the remap
 * compares "17" against 17 and every foreign key silently dangles.
 */
const COERCE: Record<DataStoreName, Coercer> = {
  settings: (r) => ({ key: text(r['key']), value: String(r['value'] ?? ''),
    updated_at: dateTimeOrNull(r['updated_at']) ?? localDateTime() }),

  expense_categories: (r) => ({
    id: int(r['id']), name: text(r['name']), color: text(r['color'], '#6b7280'),
    icon: str(r['icon']), monthly_budget: moneyOrNull(r['monthly_budget']),
    created_at: dateTimeOrNull(r['created_at']) ?? localDateTime(),
  }),

  expenses: (r) => ({
    id: int(r['id']), type: enumOf(r['type'], ['expense', 'income'] as const, 'expense'),
    amount: money(r['amount']), currency: text(r['currency'], 'TRY').slice(0, 3).toUpperCase(),
    category_id: intOrNull(r['category_id']), description: str(r['description']),
    payment_method: str(r['payment_method']), spent_at: dateOrNull(r['spent_at']) ?? '1970-01-01',
    is_recurring: bool(r['is_recurring']), recurring_interval: str(r['recurring_interval']),
    created_by: enumOf(r['created_by'], ['user', 'ai', 'system'] as const, 'user'),
    created_at: dateTimeOrNull(r['created_at']) ?? localDateTime(),
  }),

  todos: (r) => ({
    id: int(r['id']), title: text(r['title']), description: str(r['description']),
    status: enumOf(r['status'], ['todo', 'in_progress', 'done', 'archived'] as const, 'todo'),
    priority: enumOf(r['priority'], ['low', 'medium', 'high', 'urgent'] as const, 'medium'),
    project: str(r['project']), tags: str(r['tags']), due_date: dateOrNull(r['due_date']),
    recurring: str(r['recurring']), sort_order: int(r['sort_order']),
    created_by: enumOf(r['created_by'], ['user', 'ai', 'system'] as const, 'user'),
    created_at: dateTimeOrNull(r['created_at']) ?? localDateTime(),
    updated_at: dateTimeOrNull(r['updated_at']) ?? localDateTime(),
    completed_at: dateTimeOrNull(r['completed_at']),
  }),

  habits: (r) => ({
    id: int(r['id']), name: text(r['name']), description: str(r['description']),
    frequency: enumOf(r['frequency'], ['daily', 'weekly'] as const, 'daily'),
    target_per_period: Math.max(1, int(r['target_per_period'], 1)),
    color: text(r['color'], '#4f8cff'), icon: str(r['icon']),
    is_active: bool(r['is_active'], 1), sort_order: int(r['sort_order']),
    created_at: dateTimeOrNull(r['created_at']) ?? localDateTime(),
  }),

  habit_logs: (r) => ({
    id: int(r['id']), habit_id: int(r['habit_id']),
    logged_date: dateOrNull(r['logged_date']) ?? '1970-01-01',
    count: Math.max(1, int(r['count'], 1)), note: str(r['note']),
    created_at: dateTimeOrNull(r['created_at']) ?? localDateTime(),
  }),

  goals: (r) => ({
    id: int(r['id']), title: text(r['title']), description: str(r['description']),
    category: str(r['category']), target_value: intOrNull(r['target_value']),
    current_value: int(r['current_value']), unit: str(r['unit']),
    target_date: dateOrNull(r['target_date']),
    status: enumOf(r['status'], ['active', 'completed', 'paused'] as const, 'active'),
    created_at: dateTimeOrNull(r['created_at']) ?? localDateTime(),
    updated_at: dateTimeOrNull(r['updated_at']) ?? localDateTime(),
  }),

  notes: (r) => ({
    id: int(r['id']), title: str(r['title']), content: text(r['content']),
    tags: str(r['tags']), pinned: bool(r['pinned']),
    created_at: dateTimeOrNull(r['created_at']) ?? localDateTime(),
    updated_at: dateTimeOrNull(r['updated_at']) ?? localDateTime(),
  }),

  focus_sessions: (r) => ({
    id: int(r['id']), label: str(r['label']), linked_todo_id: intOrNull(r['linked_todo_id']),
    duration_minutes: int(r['duration_minutes']),
    started_at: dateTimeOrNull(r['started_at']) ?? localDateTime(),
    ended_at: dateTimeOrNull(r['ended_at']), completed: bool(r['completed'], 1),
    created_at: dateTimeOrNull(r['created_at']) ?? localDateTime(),
  }),

  repos: (r) => ({
    id: int(r['id']), github_id: intOrNull(r['github_id']), name: text(r['name']),
    full_name: text(r['full_name']), description: str(r['description']), url: str(r['url']),
    language: str(r['language']), stars: int(r['stars']), forks: int(r['forks']),
    open_issues: int(r['open_issues']), default_branch: text(r['default_branch'], 'main'),
    is_archived: bool(r['is_archived']), is_private: bool(r['is_private']),
    has_readme: bool(r['has_readme']), has_license: bool(r['has_license']),
    readme_excerpt: str(r['readme_excerpt']), health_score: intOrNull(r['health_score']),
    staleness_days: intOrNull(r['staleness_days']),
    last_pushed_at: dateTimeOrNull(r['last_pushed_at']),
    last_synced_at: dateTimeOrNull(r['last_synced_at']), pinned: bool(r['pinned']),
    created_at: dateTimeOrNull(r['created_at']) ?? localDateTime(),
  }),

  activity_log: (r) => ({
    id: int(r['id']), type: text(r['type']), entity_type: str(r['entity_type']),
    entity_id: intOrNull(r['entity_id']), summary: text(r['summary']).slice(0, 500),
    // 'ai' survives on the way in even though nothing here writes one, or an
    // inphub account's history would come across with holes in it.
    actor: enumOf(r['actor'], ['user', 'ai', 'system'] as const, 'user'),
    metadata: json(r['metadata']),
    created_at: dateTimeOrNull(r['created_at']) ?? localDateTime(),
  }),
};

/** Fields without which a row is structurally broken. */
const REQUIRED: Partial<Record<DataStoreName, string[]>> = {
  expense_categories: ['name'],
  expenses: ['amount', 'spent_at'],
  todos: ['title'],
  habits: ['name'],
  habit_logs: ['habit_id', 'logged_date'],
  goals: ['title'],
  notes: ['content'],
  repos: ['name', 'full_name'],
  focus_sessions: ['duration_minutes', 'started_at'],
  activity_log: ['type', 'summary'],
  settings: ['key'],
};

export interface ParsedBackup {
  meta: { app: string; app_version: string; exported_at: string };
  counts: Record<string, number>;
  warnings: string[];
  rows: Partial<Record<DataStoreName, Record<string, unknown>[]>>;
}

/**
 * Read and check a file. Writes nothing, so a caller can show the counts and
 * let someone confirm before anything is touched.
 */
export function parseBackup(textIn: string): ParsedBackup {
  let doc: unknown;
  try {
    doc = JSON.parse(textIn.trim());
  } catch {
    throw new BackupError('That file is not valid JSON.');
  }
  const d = doc as Partial<BackupDoc>;
  if (!d || typeof d !== 'object') throw new BackupError('That file is not a backup.');
  if (d.format !== BACKUP_FORMAT) throw new BackupError('That is not an inphub backup file.');
  if (Number(d.format_version) > BACKUP_FORMAT_VERSION) {
    throw new BackupError(`That backup was written by a newer version (format ${d.format_version}). Update inphub lite first.`);
  }
  if (!d.data || typeof d.data !== 'object') throw new BackupError('That backup has no data section.');

  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const rows: ParsedBackup['rows'] = {};
  let skippedAi = 0;

  for (const [table, list] of Object.entries(d.data)) {
    if (INPHUB_ONLY_TABLES.includes(table)) {
      skippedAi += Array.isArray(list) ? list.length : 0;
      continue;
    }
    if (!(DATA_STORES as readonly string[]).includes(table)) {
      warnings.push(`Skipped an unknown table: ${table}.`);
      continue;
    }
    if (!Array.isArray(list)) throw new BackupError(`${table} is not a list.`);

    const store = table as DataStoreName;
    const coerce = COERCE[store];
    const required = REQUIRED[store] ?? [];
    const out: Record<string, unknown>[] = [];

    list.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') throw new BackupError(`${table} row ${i} is not an object.`);
      const row = raw as Record<string, unknown>;
      for (const key of required) {
        if (row[key] === undefined || row[key] === null || row[key] === '') {
          throw new BackupError(`${table} row ${i} has no ${key}.`);
        }
      }
      if (store === 'settings' && SECRET_SETTING_KEYS.includes(String(row['key']))) {
        warnings.push(`Ignored the stored value for ${row['key']}; re-enter it in Settings.`);
        return;
      }
      out.push(coerce(row));
    });

    rows[store] = out;
    counts[table] = out.length;
  }

  if (skippedAi > 0) {
    warnings.push(`Skipped ${skippedAi} AI rows (chat, briefs, repo suggestions). inphub lite has no AI.`);
  }

  return {
    meta: {
      app: String(d.app ?? 'unknown'),
      app_version: String(d.app_version ?? ''),
      exported_at: String(d.exported_at ?? ''),
    },
    counts,
    warnings,
    rows,
  };
}
