/**
 * inphub lite: SPA shell.
 *
 * Hash routing, lazy per-view rendering, the theme toggle, the clock and
 * greeting, and the global keyboard shortcuts. Each view exposes a
 * render(container) and gets mounted into its own <section id="view-*">.
 *
 * Ported from inphub's app.ts. There's no window.INPHUB any more: index.php used
 * to inject the user, theme and appearance server-side, and here boot() reads
 * them out of IndexedDB, which is asynchronous, so the pre-paint script in
 * index.html puts the cached look up first and boot() only fills in whatever the
 * cache was missing. toggleTheme() writes to IndexedDB rather than posting to
 * settings.php. Everything AI is gone, along with `c` in the shortcut sheet.
 */

import { toast, openModal, escapeHtml } from './ui.ts';
import { allSettings, appearanceFrom, saveSettings, seedIfEmpty, type Appearance } from './data/settings.ts';
import { setBlockedHandler, type BlockedReason } from './data/db.ts';

import { renderTodos } from './views/todos.ts';
import { renderExpenses } from './views/expenses.ts';
import { renderHabits } from './views/habits.ts';
import { renderGoals } from './views/goals.ts';
import { renderNotes } from './views/notes.ts';
import { renderFocus } from './views/focus.ts';
import { renderRepos } from './views/repos.ts';
import { renderDashboard } from './views/dashboard.ts';
import { renderInsights } from './views/insights.ts';
import { renderActivity } from './views/activity.ts';
import { renderSettings } from './views/settings.ts';

/** Stamped by tools/build.mjs; also what the sidebar and the export envelope show. */
export const VERSION = __VERSION__;
export const BUILD = __BUILD__;

declare global {
  const __VERSION__: string;
  const __BUILD__: string;
  interface Window {
    /** Called by inline onclick in index.html (see init() for why). */
    inphubToggleTheme?: () => void;
    /** Called by inline onclick in index.html; no arg = toggle. */
    inphubDrawer?: (open?: boolean) => void;
    /** Set once the shell boots; index.html's error guard checks it. */
    __inphubLoaded?: boolean;
  }
}

type ViewRenderer = (container: HTMLElement) => void | Promise<void>;

/** Placeholder until a view lands. Registered in sidebar order so the two cannot drift. */
const soon = (name: string): ViewRenderer => (container) => {
  container.innerHTML = `<div class="empty">
    <div>${escapeHtml(name)} is not built yet.</div></div>`;
};

const VIEWS: Record<string, ViewRenderer> = {
  dashboard: renderDashboard,
  todos: renderTodos,
  expenses: renderExpenses,
  repos: renderRepos,
  habits: renderHabits,
  goals: renderGoals,
  notes: renderNotes,
  focus: renderFocus,
  insights: renderInsights,
  activity: renderActivity,
  settings: renderSettings,
};

const DEFAULT_VIEW = 'dashboard';
let currentView = '';
/** The route key ("view?a=1") we last rendered, so a params change re-renders. */
let currentRoute = '';
let routeParams = new URLSearchParams();
let ownerName = '';

/* ------------------------------------------------------------------ routing */

interface Route {
  view: string;
  params: URLSearchParams;
}

/** Parse "#view?key=value"; an unknown view falls back to the default. */
function parseRoute(hash: string = location.hash): Route {
  const raw = hash.replace(/^#/, '');
  const cut = raw.indexOf('?');
  const id = cut === -1 ? raw : raw.slice(0, cut);
  return {
    view: VIEWS[id] ? id : DEFAULT_VIEW,
    params: new URLSearchParams(cut === -1 ? '' : raw.slice(cut + 1)),
  };
}

/** Canonical string for a route, used to decide whether to re-render. */
function routeKey(route: Route): string {
  const qs = route.params.toString();
  return route.view + (qs ? '?' + qs : '');
}

/**
 * Query params of the active route, e.g. ?focus=7 from a search result.
 *
 * Params are READ, never consumed. A view can be re-rendered without a route
 * change (any inphub:data-changed does it) and the re-render replaces the DOM,
 * taking the highlight with it. Keeping `focus` in the route lets the view
 * re-apply it; activate() drops it the moment the user navigates elsewhere.
 * flashRow() only scrolls when the row is off-screen, so re-applying is invisible.
 */
export function currentParams(): URLSearchParams {
  return routeParams;
}

/** Monotonic render token: a superseded render must not paint over a newer one. */
let renderToken = 0;

async function activate(route: Route): Promise<void> {
  const token = ++renderToken;
  const view = route.view;
  cursor = -1;   // the row cursor belongs to whichever view is on screen
  currentView = view;
  routeParams = route.params;
  currentRoute = routeKey(route);

  document.querySelectorAll<HTMLElement>('.nav-item[data-view]').forEach((el) => {
    const active = el.dataset.view === view;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
    // The large title in the topbar names the page; the views do not.
    if (active) {
      const title = document.getElementById('page-title');
      if (title) title.textContent = el.querySelector('.nav-label')?.textContent ?? '';
    }
  });
  document.querySelectorAll<HTMLElement>('.view').forEach((section) => {
    section.hidden = section.id !== `view-${view}`;
  });

  const container = document.getElementById(`view-${view}`);
  const render = VIEWS[view];
  if (!container || !render) return;
  try {
    await render(container);
  } catch (err) {
    // Two fast navigations (Enter-Enter on search results) race here; without
    // the token the loser's error block paints over the winner's good content.
    if (token !== renderToken) return;
    container.innerHTML = `<div class="empty"><div class="big">⚠️</div>
      <div>Could not load this view.</div>
      <div class="text-dim" style="margin-top:6px;font-size:.85rem">${escapeHtml(err instanceof Error ? err.message : 'Unknown error')}</div>
      <button class="btn btn-primary btn-sm" style="margin-top:12px" data-action="retry-view">Retry</button></div>`;
    container.querySelector('[data-action="retry-view"]')?.addEventListener('click', () => {
      void activate(route);
    });
    toast(err instanceof Error ? err.message : 'Load failed.', 'bad');
  }
}

function onRoute(): void {
  const route = parseRoute();
  // Compare the whole route, not just the view: #notes?focus=7 → #notes?focus=9
  // is a real navigation and must re-render.
  if (routeKey(route) !== currentRoute) void activate(route);
}

/** Navigate programmatically (used by the palette, search results and shortcuts). */
export function go(view: string, params?: Record<string, string | number>): void {
  if (!VIEWS[view]) return;
  const qs = params
    ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
    : '';
  location.hash = view + (qs ? '?' + qs : '');
}

/** Re-render the current view (used after any write). */
export function refreshCurrentView(): void {
  const container = document.getElementById(`view-${currentView}`);
  const render = VIEWS[currentView];
  if (!container || !render) return;
  void Promise.resolve(render(container)).catch((err: unknown) => {
    toast(err instanceof Error ? err.message : 'Could not refresh this view.', 'bad');
  });
}

/* -------------------------------------------------------------------- theme */

// Namespaced because <user>.github.io is one origin for everything published
// there, so a bare 'theme' would collide with any other site of yours.

const THEME_KEY = 'inphub-lite:theme';
const APPEARANCE_KEY = 'inphub-lite:appearance';

/** Apply a theme and cache it. Every theme change goes through here. */
export function applyTheme(theme: string, remember = true): void {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f6fa' : '#0b0d12');
  if (!remember) return;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage unavailable */
  }
}

/** `url("…")` for a wallpaper, with the url()-breaking characters encoded (css_url() in PHP). */
export function cssUrl(url: string): string {
  return `url("${url.replace(/[\\"'()\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))}")`;
}

/** Apply accent, wallpaper and transparency to <html>, and cache for the pre-paint script. */
export function applyAppearance(a: Appearance, remember = true): void {
  const root = document.documentElement;
  root.setAttribute('data-accent', a.accent || 'blue');
  root.setAttribute('data-wallpaper', a.wallpaper || 'aurora');
  root.setAttribute('data-glass', a.transparency || 'full');
  root.setAttribute('data-logo', a.logo_tint === 'wallpaper' ? 'wallpaper' : 'accent');
  const image = a.wallpaper_url && /^https?:\/\//i.test(a.wallpaper_url) ? cssUrl(a.wallpaper_url) : '';
  if (image) root.style.setProperty('--wp-image', image);
  else root.style.removeProperty('--wp-image');
  if (!remember) return;
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({
      accent: a.accent, wallpaper: a.wallpaper, transparency: a.transparency,
      logo: a.logo_tint, image, url: a.wallpaper_url,
    }));
  } catch {
    /* storage unavailable */
  }
}

async function toggleTheme(): Promise<void> {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  // Cached instantly so the choice survives a reload even if the write fails.
  applyTheme(next);
  try {
    await saveSettings({ theme: next });
  } catch {
    // Unlike inphub there is no account to sync to, so this only means the
    // local write failed, which is worth saying, because the next reload may disagree.
    toast('Theme applied, but could not be saved.', 'bad');
  }
}

/* ---------------------------------------------------------- clock + greeting */

function tick(): void {
  const clock = document.getElementById('clock');
  if (clock) {
    clock.textContent = new Date().toLocaleTimeString(undefined, {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }
}

function greet(): void {
  const el = document.getElementById('greeting');
  if (!el) return;
  const h = new Date().getHours();
  const part = h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  // No account, so no username to fall back to: without a name in Settings the
  // greeting is just the time of day rather than "Good evening, undefined".
  el.textContent = ownerName ? `${part}, ${ownerName}` : part;
}

/* ----------------------------------------------------------------- shortcuts */

/**
 * Global keys:
 *   g then d/t/e/r/h/g/n/f/i/a/s → jump to a view
 *   /                            → focus the current view's search box (if any)
 *   n                            → "new" in the current view
 *   j / k / x                    → row cursor
 *   ?                            → shortcut sheet
 * k and Ctrl/Cmd+K belong to the command palette module.
 */
let awaitingG = false;
let gTimer = 0;

const G_MAP: Record<string, string> = {
  d: 'dashboard', t: 'todos', e: 'expenses', r: 'repos', h: 'habits', g: 'goals',
  n: 'notes', f: 'focus', i: 'insights', a: 'activity', s: 'settings',
};

function isTyping(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  return !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA'
    || node.tagName === 'SELECT' || node.isContentEditable);
}

function onKey(e: KeyboardEvent): void {
  if (isTyping(e.target)) return;
  // Hard-rejects every modifier, so a new Cmd+… binding belongs in the palette.
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (awaitingG) {
    awaitingG = false;
    clearTimeout(gTimer);
    const dest = G_MAP[e.key.toLowerCase()];
    if (dest) {
      e.preventDefault();
      go(dest);
    }
    return;
  }

  if (e.key === 'g') {
    awaitingG = true;
    gTimer = window.setTimeout(() => (awaitingG = false), 900);
    return;
  }
  if (e.key === '/') {
    const search = document.querySelector<HTMLInputElement>(
      `#view-${currentView} input[type="search"], #view-${currentView} input[data-role="search"]`);
    if (search) {
      e.preventDefault();
      search.focus();
    }
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    showShortcuts();
    return;
  }
  if (e.key === 'n') {
    const btn = document.querySelector<HTMLElement>(`#view-${currentView} [data-action="new"]`);
    if (btn) {
      e.preventDefault();
      btn.click();
    }
    return;
  }
  if (e.key === 'Escape') {
    window.inphubDrawer?.(false);
    return;
  }
  if (e.key === 'j' || e.key === 'k' || e.key === 'x') rowKeys(e);
}

/* ------------------------------------------------------- row navigation */

/** Index of the row cursor within the active view, -1 when nothing is picked. */
let cursor = -1;

function rowsInView(): HTMLElement[] {
  const host = document.getElementById(`view-${currentView}`);
  return host ? [...host.querySelectorAll<HTMLElement>('[data-row]')] : [];
}

/**
 * j/k move a cursor through the current view's rows and x acts on the focused
 * one. Rows already carry data-row for search highlighting, so this rides on
 * the same markup.
 */
function rowKeys(e: KeyboardEvent): void {
  const rows = rowsInView();
  if (!rows.length) return;
  e.preventDefault();

  if (e.key === 'x') {
    const row = rows[cursor];
    // Prefer a completion control, fall back to whatever primary action exists.
    row?.querySelector<HTMLElement>('[data-action="complete"], [data-action="toggle"], [data-action="read"]')?.click();
    return;
  }

  cursor = e.key === 'j'
    ? Math.min(rows.length - 1, cursor + 1)
    : Math.max(0, cursor === -1 ? 0 : cursor - 1);

  rows.forEach((r, i) => r.classList.toggle('row-cursor', i === cursor));
  rows[cursor]?.scrollIntoView({ block: 'nearest' });
}

function showShortcuts(): void {
  const keys: [string, string][] = [
    ['k', 'Search everything'],
    ['g then d t e r h g n f i a s', 'Jump to a view'],
    ['/', 'Filter the current view'],
    ['n', 'New item in the current view'],
    ['j / k', 'Move down / up the list'],
    ['x', 'Complete or open the highlighted row'],
    ['Esc', 'Close a panel, drawer or dialog'],
    ['?', 'This list'],
  ];
  openModal({
    title: 'Keyboard shortcuts',
    confirmLabel: 'Close',
    cancelLabel: '',
    bodyHtml: `<div class="list">${keys.map(([k, what]) => `
      <div class="row" style="border:none;background:none;padding:5px 0">
        <span class="chip mono">${escapeHtml(k)}</span>
        <span class="grow">${escapeHtml(what)}</span>
      </div>`).join('')}</div>`,
  });
}

/* -------------------------------------------------------------------- init */

/**
 * Another tab is holding an old schema open, or has opened a newer one. Either
 * way the app hangs if it says nothing, so it says something.
 */
function onBlocked(reason: BlockedReason): void {
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:999;padding:12px 16px;'
    + 'background:#ef4444;color:#fff;font:14px system-ui;text-align:center';
  banner.textContent = reason === 'blocked'
    ? 'inphub lite is open in another tab. Close it to finish updating.'
    : 'inphub lite was updated in another tab. Reload to continue.';
  document.body.appendChild(banner);
}

async function boot(): Promise<void> {
  setBlockedHandler(onBlocked);
  await seedIfEmpty();

  const settings = await allSettings();
  ownerName = settings['owner_name'] ?? '';
  greet();

  // The pre-paint script already applied whatever was cached. The stored values
  // only need to be pushed to <html> when there is no cache yet: a first visit,
  // or a new browser restored from an import.
  let cachedTheme: string | null = null;
  let cachedLook: string | null = null;
  try {
    cachedTheme = localStorage.getItem(THEME_KEY);
    cachedLook = localStorage.getItem(APPEARANCE_KEY);
  } catch {
    /* storage unavailable */
  }
  if (cachedTheme !== 'light' && cachedTheme !== 'dark') applyTheme(settings['theme'] || 'dark');
  if (!cachedLook) applyAppearance(appearanceFrom(settings));
}

function init(): void {
  tick();
  setInterval(tick, 1000);
  greet();
  alive();

  // Mobile nav drawer (the hamburger is only visible at the small breakpoint).
  const sidebar = document.querySelector<HTMLElement>('.sidebar');
  const navBackdrop = document.getElementById('nav-backdrop');
  const setDrawer = (open: boolean) => {
    sidebar?.classList.toggle('open', open);
    if (navBackdrop) navBackdrop.hidden = !open;
    // Without the lock the page scrolls under the overlay.
    document.body.classList.toggle('drawer-open', open);
    document.getElementById('btn-nav')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  // The theme button, hamburger and drawer backdrop are wired through inline
  // onclick attributes in index.html that call these globals. This is DOM
  // level-0 on purpose: in the owner's environment BOTH addEventListener
  // bindings and a document-level delegated listener silently never fired for
  // these buttons (likely an extension wrapping addEventListener), while inline
  // handlers cannot be intercepted that way. Keep it. New global chrome should
  // follow the same pattern.
  window.inphubToggleTheme = () => {
    void toggleTheme();
  };
  window.inphubDrawer = (open?: boolean) => {
    setDrawer(open !== undefined ? open : !sidebar?.classList.contains('open'));
  };

  // Navigating or using a footer action closes the drawer.
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.sidebar .nav-item, .sidebar .sidebar-foot .btn')) setDrawer(false);
  });

  window.addEventListener('hashchange', onRoute);
  document.addEventListener('keydown', onKey);
  window.addEventListener('inphub:data-changed', refreshCurrentView);

  // Initial route. Normalise only when the *view id* is empty or unknown:
  // comparing the raw hash would rewrite a deep link like #notes?focus=7 down
  // to #notes and eat the param before any view rendered.
  const initial = parseRoute();
  if ((location.hash.replace(/^#/, '').split('?')[0] || '') !== initial.view) {
    location.replace('#' + routeKey(initial));
  }

  // The data layer is asynchronous, unlike inphub's PHP-injected boot payload,
  // so the shell paints immediately and the first view renders once the seed
  // and settings are in. A failure here is fatal and has to be visible.
  void boot()
    .then(() => activate(initial))
    .catch((err: unknown) => {
      const container = document.getElementById(`view-${initial.view}`);
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (container) {
        container.hidden = false;
        container.innerHTML = `<div class="empty"><div class="big">⚠️</div>
          <div>inphub lite could not open its local database.</div>
          <div class="text-dim" style="margin-top:6px;font-size:.85rem">${escapeHtml(message)}</div>
          <div class="text-dim" style="margin-top:6px;font-size:.85rem">Private browsing and blocked site data both prevent it.</div></div>`;
      }
      toast(message, 'bad');
    });

  // Tells index.html's error guard that the module graph linked and ran, so the
  // "hard-reload" banner only appears for a genuine boot failure.
  window.__inphubLoaded = true;

  // Deploy sanity stamp: if this line is missing from the console, the browser
  // is running a stale bundle.
  console.info(`[inphub lite] v${VERSION} (${BUILD}) ready`);
}

/**
 * The two ambient touches: the title bar turns to glass once content scrolls
 * under it (iOS nav bars), and cards carry a soft highlight that follows the
 * pointer. Both are decorative, so if an extension swallows these listeners
 * (see the inline-onclick note above) nothing breaks.
 */
function alive(): void {
  const topbar = document.querySelector<HTMLElement>('.topbar');
  const onScroll = () => topbar?.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (!window.matchMedia('(hover: hover)').matches) return;
  let frame = 0;
  let last: PointerEvent | null = null;
  document.addEventListener('pointermove', (e) => {
    last = e;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const card = (last?.target as HTMLElement | null)?.closest?.<HTMLElement>('.card');
      if (!card || !last) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${Math.round(last.clientX - r.left)}px`);
      card.style.setProperty('--my', `${Math.round(last.clientY - r.top)}px`);
    });
  }, { passive: true });
}

export { init };
