/**
 * inphub lite: command palette (Ctrl/Cmd+K): commands *and* global search.
 *
 * Typing filters the built-in commands locally and, in parallel, searches
 * every entity through api/search.php and asks Google for suggestions
 * (api/suggest.php). Results are grouped under headings (Commands → inphub
 * groups → Google) and share one arrow/Enter selection. The Google group
 * always opens with a "Search Google for …" row, so with no local match,
 * typing and pressing Enter searches the web, even when suggestions fail.
 *
 * The box is built once into the persistent #palette node and its listeners
 * are bound once, open() only unhides and resets. Re-binding on every open
 * (as an earlier version did) stacks handlers on a node that is never
 * replaced; see the onAction() note in CLAUDE.md for the same hazard.
 */

import { go } from '../app.ts';
import { apiGet, apiPost } from '../api.ts';
import { toast, openModal, formValues, escapeHtml, money } from '../ui.ts';
import { exportBackup, exportExpensesCsv } from '../data/export.ts';
import { VERSION } from '../app.ts';
import {
  RESULT_VIEWS, SEARCH_MIN_CHARS, searchGoogle, isAbort,
  type SearchItem, type SearchGroup,
} from './web-search.ts';

declare global {
  interface Window {
    /** Called by the inline onclick in index.php. */
    inphubPalette?: () => void;
  }
}

interface Command {
  label: string;
  hint?: string;
  run: () => void;
}

/** Selectable row, commands and results share one index space. */
type Entry =
  | { kind: 'command'; cmd: Command }
  | { kind: 'result'; type: string; item: SearchItem }
  | { kind: 'web'; query: string };


const VIEW_COMMANDS: [string, string][] = [
  ['dashboard', 'Dashboard'],
  ['todos', 'To-Do'],
  ['expenses', 'Money'],
  ['repos', 'Repositories'],
  ['habits', 'Habits'],
  ['goals', 'Goals'],
  ['notes', 'Notes'],
  ['focus', 'Focus'],
  ['insights', 'Insights'],
  ['activity', 'History'],
  ['settings', 'Settings'],
];

/** g+letter hints, declared rather than derived from the view id. */
const VIEW_HINTS: Record<string, string> = {
  dashboard: 'g d', todos: 'g t', expenses: 'g e', repos: 'g r', habits: 'g h',
  goals: 'g g', notes: 'g n', focus: 'g f', insights: 'g i', activity: 'g a', settings: 'g s',
};

let palette: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let listHost: HTMLElement | null = null;

let commands: Command[] = [];
let entries: Entry[] = [];
let active = 0;

let groups: SearchGroup[] = [];
let searchedFor = '';
let searchTimer = 0;
let searchCtl: AbortController | null = null;

export function initPalette(): void {
  palette = document.getElementById('palette');
  if (!palette) return;

  palette.innerHTML = `
    <div class="palette-box">
      <input data-role="q" placeholder="Search or type a command" autocomplete="off"
             autocorrect="off" autocapitalize="off" spellcheck="false">
      <div class="palette-list" data-role="list"></div>
    </div>`;
  input = palette.querySelector<HTMLInputElement>('[data-role="q"]');
  listHost = palette.querySelector<HTMLElement>('[data-role="list"]');

  palette.addEventListener('mousedown', (e) => {
    if (e.target === palette) close();
  });
  input?.addEventListener('input', onInput);
  input?.addEventListener('keydown', onKey);
  // One delegated click for the whole list, so re-rendering results costs nothing.
  listHost?.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (row) choose(Number(row.dataset.i));
  });

  // Exposed for the inline onclick in index.php. Inline DOM level-0 handlers
  // are the established pattern here: in the owner's Firefox, addEventListener
  // bindings on the sidebar/topbar chrome silently never fire (an extension
  // appears to wrap addEventListener). See the note in CLAUDE.md.
  window.inphubPalette = open;
  document.getElementById('btn-palette')?.addEventListener('click', open);

  // Registered twice on purpose: addEventListener for normal browsers, and the
  // DOM level-0 slot as a fallback for the environment above. handleKey()
  // stamps the event so whichever fires second is a no-op.
  document.addEventListener('keydown', handleKey);
  const previous = document.onkeydown;
  document.onkeydown = (e: KeyboardEvent) => {
    handleKey(e);
    previous?.call(document, e);
  };
}

interface StampedEvent extends KeyboardEvent {
  __inphubPaletteSeen?: boolean;
}

function handleKey(e: KeyboardEvent): void {
  const ev = e as StampedEvent;
  if (ev.__inphubPaletteSeen) return;
  ev.__inphubPaletteSeen = true;

  // Ctrl/Cmd+K is the conventional binding, but Firefox reserves it for its
  // search bar and will not let a page have it, so bare 'k' opens the palette
  // too, matching the app's existing bare-letter keys (g+letter).
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    open();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;

  if (e.key === 'k') {
    e.preventDefault();
    open();
    return;
  }
}

function buildCommands(): Command[] {
  const list: Command[] = VIEW_COMMANDS.map(([id, label]) => ({
    label: `Go to ${label}`,
    hint: VIEW_HINTS[id],
    run: () => go(id),
  }));
  list.push({ label: 'Quick capture (task / expense / note)', hint: 'add', run: quickCapture });
  list.push({ label: 'Sync repositories from GitHub', hint: 'sync', run: syncRepos });
  list.push({ label: 'Toggle theme', hint: 'theme', run: () => document.getElementById('btn-theme')?.click() });
  list.push({ label: 'Export all data (JSON)', run: () => download('json') });
  list.push({ label: 'Export expenses (CSV)', run: () => download('expenses_csv') });
  return list;
}

function open(): void {
  if (!palette || !input) return;
  commands = buildCommands();
  groups = [];
  searchedFor = '';
  input.value = '';
  palette.hidden = false;
  render('', true);
  input.focus();
}

function close(): void {
  if (palette) palette.hidden = true;
  // Drop anything in flight so a late response can't render into a closed
  // (or freshly reopened) palette.
  clearTimeout(searchTimer);
  searchCtl?.abort();
  searchCtl = null;
}

/* ------------------------------------------------------------------ search */

function onInput(): void {
  const q = input!.value.trim();
  render(q, true);

  clearTimeout(searchTimer);
  searchCtl?.abort();

  if (q.length < SEARCH_MIN_CHARS) {
    groups = [];
    searchedFor = '';
    return;
  }
  searchTimer = window.setTimeout(() => runSearch(q), 200);
}

/**
 * Local results only.
 *
 * inphub ran this alongside a call to Google's autocomplete, proxied through
 * api/suggest.php because Google sends no CORS headers. With no server to proxy
 * through there is nothing to ask, so the Google group keeps its one fixed
 * "Search Google for …" row and loses the suggestions under it.
 */
function runSearch(q: string): void {
  const ctl = new AbortController();
  searchCtl = ctl;
  // A newer keystroke may have superseded this request.
  const current = () => ctl === searchCtl && input!.value.trim() === q;

  apiGet('search', 'search', { q }, { signal: ctl.signal })
    .then((res) => res.groups, (e: unknown) => (isAbort(e) ? null : []))
    .then((res) => {
      // Search failing must never break the command palette.
      if (res === null || !current()) return;
      groups = res;
      searchedFor = q;
      render(q, false);
    });
}

/* ------------------------------------------------------------------ render */

/**
 * @param resetActive true when the user typed (selection returns to the top),
 *   false when debounced results merge in, moving the highlight out from
 *   under their fingers mid-keystroke is disorienting.
 */
function render(query: string, resetActive: boolean): void {
  if (!listHost) return;
  const q = query.trim();
  // Commands are matched locally; results arrive already ranked by the server
  // and must not be re-filtered (its collation is Turkish-correct, JS
  // toLowerCase is not, and fuzzy() would drop good hits).
  const cmds = q ? commands.filter((c) => fuzzy(c.label.toLowerCase(), q.toLowerCase())) : commands;

  const previous = entries[active];
  entries = [];
  const html: string[] = [];

  if (cmds.length) {
    if (q) html.push(section('Commands'));
    for (const cmd of cmds) {
      html.push(row(entries.length, escapeHtml(cmd.label), '', cmd.hint ? escapeHtml(cmd.hint) : ''));
      entries.push({ kind: 'command', cmd });
    }
  }

  for (const group of groups) {
    if (!group.items.length) continue;
    html.push(section(group.label + (group.truncated ? ' <span class="hint">top ' + group.items.length + '</span>' : '')));
    for (const item of group.items) {
      const meta = item.amount !== undefined
        ? escapeHtml(money(item.amount, item.currency ?? 'TRY')) + ' · ' + escapeHtml(item.meta)
        : escapeHtml(item.meta);
      html.push(row(entries.length, escapeHtml(item.label), escapeHtml(item.sub), meta));
      entries.push({ kind: 'result', type: group.type, item });
    }
  }

  if (q) {
    html.push(section('Google'));
    html.push(row(entries.length, `Search Google for “${escapeHtml(q)}”`, '', ''));
    entries.push({ kind: 'web', query: q });
  }

  if (!entries.length) {
    const searching = q.length >= SEARCH_MIN_CHARS && searchedFor !== q;
    html.push(`<div class="palette-item text-dim">${searching ? 'Searching…' : 'No matches'}</div>`);
  }

  listHost.innerHTML = html.join('');

  if (resetActive) {
    active = 0;
  } else {
    // Keep the same row selected across a results merge where possible.
    const i = previous ? entries.findIndex((e) => sameEntry(e, previous)) : -1;
    active = i >= 0 ? i : Math.min(active, Math.max(0, entries.length - 1));
  }
  paintActive(false);
}

function section(label: string): string {
  return `<div class="palette-section">${label}</div>`;
}

function row(i: number, label: string, sub: string, meta: string): string {
  return `<div class="palette-item" data-i="${i}">
    <span class="palette-label">${label}${sub ? `<small>${sub}</small>` : ''}</span>
    ${meta ? `<span class="hint">${meta}</span>` : ''}
  </div>`;
}

function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'command' && b.kind === 'command') return a.cmd.label === b.cmd.label;
  if (a.kind === 'result' && b.kind === 'result') return a.type === b.type && a.item.id === b.item.id;
  if (a.kind === 'web' && b.kind === 'web') return a.query === b.query;
  return false;
}

function paintActive(scroll: boolean): void {
  if (!listHost) return;
  const rows = listHost.querySelectorAll<HTMLElement>('[data-i]');
  rows.forEach((el, i) => el.classList.toggle('active', i === active));
  // The list scrolls at 320px; without this, arrowing past the fold looks inert.
  if (scroll) rows[active]?.scrollIntoView({ block: 'nearest' });
}

/* -------------------------------------------------------------------- keys */

function onKey(e: KeyboardEvent): void {
  // Enter/arrows that confirm an IME composition belong to the IME.
  if (e.isComposing) return;
  if (e.key === 'Escape') {
    close();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(active);
  }
}

function move(delta: number): void {
  if (!entries.length) return;
  active = (active + delta + entries.length) % entries.length;
  paintActive(true);
}

function choose(i: number): void {
  const entry = entries[i];
  if (!entry) return;
  close();
  if (entry.kind === 'command') {
    entry.cmd.run();
    return;
  }
  if (entry.kind === 'web') {
    searchGoogle(entry.query);
    return;
  }
  // Routing through go() keeps view validation in one place, a result can
  // never navigate somewhere that isn't a real view.
  const view = RESULT_VIEWS[entry.type];
  if (view) go(view, { focus: entry.item.id });
}

/** Subsequence fuzzy match: every char of q appears in order in text. */
function fuzzy(text: string, q: string): boolean {
  let i = 0;
  for (const ch of text) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return q.length === 0;
}

/* ----------------------------------------------------------------- actions */

async function syncRepos(): Promise<void> {
  toast('Syncing repositories…');
  try {
    const res = await apiPost('sync_repos', 'sync', {});
    toast(`Synced ${res.synced} repos.`, 'good');
    window.dispatchEvent(new CustomEvent('inphub:data-changed'));
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Sync failed', 'bad');
  }
}

/** The exports are built in the browser now; export.ts owns the formats. */
function download(action: string): void {
  const run = action === 'expenses_csv' ? exportExpensesCsv : () => exportBackup(VERSION);
  void run().catch((e: unknown) => toast(e instanceof Error ? e.message : 'Export failed', 'bad'));
}

/**
 * Free-text capture.
 *
 * inphub sent this to api/ai.php, which classified it with a model when AI was
 * on and fell back to prefix parsing when it was off. Only the fallback is left,
 * so the grammar is stated rather than guessed at: a leading amount is money,
 * "note:" is a note, anything else is a task. The picker stays as the
 * confirmation step, so a wrong guess is visible before it is filed.
 */
function quickCapture(): void {
  openModal({
    title: 'Quick capture',
    confirmLabel: 'Add',
    bodyHtml: `
      <label><span>What happened?</span>
        <input name="text" placeholder="e.g. 45 groceries · todo: call the bank · note: idea" autocomplete="off"></label>
      <div class="text-dim" style="margin-top:8px;font-size:.82rem">
        Starts with a number: money. Starts with <code>note:</code>: a note. Anything else: a task.</div>`,
    onConfirm: async (root) => {
      const text = (formValues(root)['text'] ?? '').trim();
      if (!text) return false;
      try {
        const parsed = parseCapture(text);
        await apiPost(parsed.endpoint as 'todos', parsed.action as 'create', parsed.payload);
        toast(parsed.summary, 'good');
        window.dispatchEvent(new CustomEvent('inphub:data-changed'));
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
        return false;
      }
      return undefined;
    },
  });
}

interface Capture {
  endpoint: string;
  action: string;
  payload: Record<string, unknown>;
  summary: string;
}

/** The whole grammar, in one place, so the modal's help text can state it. */
export function parseCapture(text: string): Capture {
  const note = /^note\s*:\s*(.+)$/is.exec(text);
  if (note) {
    return { endpoint: 'notes', action: 'create', payload: { content: note[1]!.trim() }, summary: 'Note added.' };
  }

  // A leading amount, with an optional currency symbol in front of it.
  const money = /^[^\d-]{0,2}\s*(\d+(?:[.,]\d{1,2})?)\s*(.*)$/s.exec(text);
  if (money) {
    const amount = Number(money[1]!.replace(',', '.'));
    const description = money[2]!.trim();
    return {
      endpoint: 'expenses', action: 'create',
      payload: { amount, description: description || null },
      summary: `Added ${amount}${description ? ' for ' + description : ''}.`,
    };
  }

  const todo = /^(?:todo|task)\s*:\s*(.+)$/is.exec(text);
  const title = todo ? todo[1]!.trim() : text;
  return { endpoint: 'todos', action: 'create', payload: { title }, summary: 'Task added.' };
}

function isTyping(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  return !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable);
}
