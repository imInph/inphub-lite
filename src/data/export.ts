/**
 * inphub lite: downloads.
 *
 * export.php set Content-Disposition and streamed; here a Blob and a synthetic
 * <a download> do the same job. Two details in download() are not optional, and
 * both are the kind of thing that only shows up later.
 *
 * The shared backup document is built in backup.ts and read back by import.ts;
 * this file is the download plumbing plus the per-view "give me this list as a
 * file" exports.
 */

import { getAll, setMeta } from './db.ts';
import { localDate } from './dates.ts';
import { buildBackup } from './backup.ts';
import { TODO_STATUS_ORDER, type Todo } from './types.ts';

/** inphub named its files inphub-todos-YYYY-MM-DD.ext; keep the shape. */
function stamp(): string {
  return localDate();
}

export function download(filename: string, mime: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking matters: without it the whole serialised list stays pinned in
  // memory for as long as the page is open, and this is an app you leave open
  // all day. The timeout matters too, because Chrome needs the URL to outlive
  // the click's task, so revoking immediately cancels the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* -------------------------------------------------------------------- csv */

/** fputcsv() is gone, so quoting is ours. Anything with a comma, quote or newline. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  // The BOM is for Excel. Without it a Turkish column comes out as mojibake and
  // the obvious conclusion is that the export is broken.
  return '﻿' + body + '\r\n';
}

/* ------------------------------------------------------------------ todos */

const TODO_COLUMNS = ['title', 'description', 'status', 'priority', 'project', 'tags',
  'due_date', 'recurring', 'created_at', 'completed_at'] as const;

const STATUS_LABELS: Record<string, string> = {
  todo: 'To do', in_progress: 'In progress', done: 'Done', archived: 'Archived',
};

/** ORDER BY (status="done"), sort_order, (due_date IS NULL), due_date, id DESC. */
async function todosForExport(): Promise<Todo[]> {
  const rows = await getAll('todos');
  return rows.sort((a, b) =>
    Number(a.status === 'done') - Number(b.status === 'done')
    || a.sort_order - b.sort_order
    || Number(a.due_date === null) - Number(b.due_date === null)
    || (a.due_date ?? '').localeCompare(b.due_date ?? '')
    || b.id - a.id);
}

export async function exportTodosCsv(): Promise<void> {
  const rows = await todosForExport();
  download(`inphub-lite-todos-${stamp()}.csv`, 'text/csv;charset=utf-8',
    toCsv([...TODO_COLUMNS], rows.map((t) => TODO_COLUMNS.map((c) => t[c]))));
}

export async function exportTodosJson(): Promise<void> {
  const rows = await todosForExport();
  const todos = rows.map((t) => Object.fromEntries(TODO_COLUMNS.map((c) => [c, t[c]])));
  download(`inphub-lite-todos-${stamp()}.json`, 'application/json;charset=utf-8',
    JSON.stringify({ exported_at: new Date().toISOString(), todos }, null, 2));
}

/** A checklist grouped by status, in the status enum's own order. */
export async function exportTodosMarkdown(): Promise<void> {
  const rows = await todosForExport();
  let md = `# inphub lite - To-Do list (${stamp()})\n`;

  for (const status of TODO_STATUS_ORDER) {
    const items = rows.filter((t) => t.status === status);
    if (!items.length) continue;
    md += `\n## ${STATUS_LABELS[status]}\n\n`;
    for (const t of items) {
      const box = status === 'done' || status === 'archived' ? 'x' : ' ';
      const meta: string[] = [];
      if (t.priority !== 'medium') meta.push(t.priority);
      if (t.project) meta.push(t.project);
      if (t.due_date) meta.push(`due ${t.due_date}`);
      if (t.completed_at) meta.push(`completed ${t.completed_at.slice(0, 10)}`);
      md += `- [${box}] ${t.title}${meta.length ? ` _(${meta.join(' · ')})_` : ''}\n`;
    }
  }
  download(`inphub-lite-todos-${stamp()}.md`, 'text/markdown;charset=utf-8', md);
}

/* --------------------------------------------------------------- expenses */

const EXPENSE_COLUMNS = ['date', 'type', 'amount', 'currency', 'category', 'description',
  'payment_method', 'is_recurring'] as const;

/** The ledger as CSV, columns and order as export.php had them. */
export async function exportExpensesCsv(): Promise<void> {
  const [rows, cats] = await Promise.all([getAll('expenses'), getAll('expense_categories')]);
  const name = new Map(cats.map((c) => [c.id, c.name]));
  const sorted = rows.sort((a, b) => b.spent_at.localeCompare(a.spent_at) || b.id - a.id);
  download(`inphub-lite-expenses-${stamp()}.csv`, 'text/csv;charset=utf-8',
    toCsv([...EXPENSE_COLUMNS], sorted.map((e) => [
      e.spent_at, e.type, e.amount.toFixed(2), e.currency,
      e.category_id === null ? '' : name.get(e.category_id) ?? '',
      e.description, e.payment_method, e.is_recurring,
    ])));
}

/* ----------------------------------------------------------------- backup */

/**
 * The whole database as one .txt, in the format inphub also reads and writes.
 *
 * The .txt is deliberate, and matches what inphub writes: it is what csTimer
 * does, it survives being pasted into a chat or an email that would block a
 * .json, and it opens anywhere. See BACKUP-FORMAT.md.
 *
 * Records the date, because main.ts nags when a backup gets old and doing so on
 * a date nobody ever set would mean nagging forever.
 */
export async function exportBackup(appVersion: string): Promise<number> {
  const doc = await buildBackup(appVersion);
  download(`inphub-backup-${stamp()}.txt`, 'text/plain;charset=utf-8', JSON.stringify(doc, null, 2));
  await setMeta('last_export_at', localDate());
  return Object.values(doc.counts).reduce((n, c) => n + c, 0);
}
