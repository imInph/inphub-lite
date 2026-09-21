/**
 * inphub lite: entry point.
 *
 * The stylesheet is not imported here. tools/build.mjs builds src/styles/app.css
 * as its own esbuild entry, so the CSS and JS hashes are independent and a
 * style-only change does not invalidate the cached bundle.
 *
 * Everything this file does beyond booting the shell is about the two things a
 * local-only app has to get right: staying installed, and staying updated
 * without trapping you on a broken build.
 */

import { init } from './app.ts';
import { toast } from './ui.ts';
import { meta, setMeta } from './data/db.ts';
import { localDate, daysBetween, today } from './data/dates.ts';

/**
 * ?nosw=1 unregisters every worker, drops every cache and reloads clean. Checked
 * before anything else registers. A service worker holding a broken build is
 * otherwise very hard to get out of on a phone, where there are no devtools.
 */
async function killSwitch(): Promise<boolean> {
  if (!new URLSearchParams(location.search).has('nosw')) return false;
  try {
    const regs = await navigator.serviceWorker?.getRegistrations() ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    /* nothing to clear */
  }
  location.replace(location.pathname + location.hash);
  return true;
}

/**
 * Offer the update. Persistent on purpose: this is the only prompt in the app
 * that waits, because one that times out after seven seconds is one you miss,
 * and then the app quietly stays on the old build forever.
 */
function offerUpdate(worker: ServiceWorker): void {
  toast('A new version of inphub lite is ready.', '', {
    label: 'Reload',
    run: () => {
      // Reload as soon as the new worker takes over, not before: the page is
      // still running the old build until then.
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      worker.postMessage({ type: 'skip-waiting' });
    },
  }, { persistent: true });
}

/**
 * Pull the rest of the chunks into the cache once the page is idle, so the
 * first offline launch is not missing whichever views were never opened.
 */
function warmCache(): void {
  const warm = () => {
    if (navigator.onLine) navigator.serviceWorker.controller?.postMessage({ type: 'warm' });
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 8000 });
  else setTimeout(warm, 3000);
}

/**
 * Register the worker and offer an update. Never take one silently.
 *
 * updateViaCache:'none' matters. Without it the browser can serve sw.js from its
 * own HTTP cache for a day, so a deploy just doesn't show up.
 *
 * skipWaiting only ever fires from the toast button, and a reload follows
 * straight after. Activating mid-session lets the new worker clear the old
 * build's cache while this page is still running, and any chunk that hasn't been
 * imported yet then 404s into a blank view.
 *
 * The offline guard is what makes "it told me when I came back online" work.
 * Registering while offline is a guaranteed failed fetch of sw.js, so when the
 * app is already controlled it waits for the `online` event and tries then.
 * That is the usual case on a phone: you open it from the home screen with no
 * signal, it works from cache, and the update prompt appears when you reconnect.
 */
async function registerWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  if (!navigator.onLine && navigator.serviceWorker.controller) {
    window.addEventListener('online', () => void registerWorker(), { once: true });
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });

    // A worker left waiting from a previous visit. The controller check is what
    // keeps the very first install from announcing itself as an update.
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(installing);
      });
    });

    if (navigator.serviceWorker.controller) warmCache();
    else navigator.serviceWorker.addEventListener('controllerchange', warmCache, { once: true });
  } catch {
    // An offline app that fails to register is still a working online app.
  }
}

/**
 * Service workers need a secure context. Localhost counts, which is what lets
 * `npm run dev` exercise the whole update flow before anything is deployed.
 *
 * Registration waits for load so it never competes with the first paint.
 */
function startWorker(): void {
  const localhost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (location.protocol !== 'https:' && !localhost) return;
  if (document.readyState === 'complete') void registerWorker();
  else window.addEventListener('load', () => void registerWorker(), { once: true });
}

/**
 * Ask the browser not to evict the database, which is the only copy of anything.
 * Safari clears it after seven days of no interaction unless the site is on the
 * Home Screen, and Chrome evicts under storage pressure unless the origin is
 * persisted. Chrome decides from engagement, so the first request usually fails
 * and one a few visits later succeeds. That's why this runs every boot.
 */
async function requestPersistence(): Promise<void> {
  try {
    if (!navigator.storage?.persist) return;
    if (await navigator.storage.persisted()) return;
    await navigator.storage.persist();
  } catch {
    /* not supported, or denied */
  }
}

/**
 * Nag about backups. A browser database with no export is one cleared cache away
 * from nothing, and the person most likely to clear it is you. Two weeks is long
 * enough not to be noise.
 */
async function backupReminder(): Promise<void> {
  try {
    const last = await meta<string | null>('last_export_at', null);
    const first = await meta<string | null>('first_run_at', null);
    if (!first) {
      await setMeta('first_run_at', today());
      return;
    }
    const since = last ?? first;
    if (daysBetween(since, localDate()) < 14) return;
    toast(
      last ? 'It has been a while since your last backup.' : 'You have never exported a backup.',
      '',
      { label: 'Export', run: () => { location.hash = 'settings'; } },
    );
  } catch {
    /* never let a reminder break the boot */
  }
}

async function main(): Promise<void> {
  if (await killSwitch()) return;
  init();
  startWorker();
  void requestPersistence();
  // After the shell has painted and the database has had a chance to open.
  setTimeout(() => void backupReminder(), 4000);
}

void main();
