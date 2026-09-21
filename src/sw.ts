/**
 * inphub lite: the service worker.
 *
 * Built separately from the app bundle and handed two values by tools/build.mjs:
 * __BUILD__, this build's id, and __PRECACHE__, the shell's file list, which is
 * generated from the esbuild metafile rather than written by hand. A hand-kept
 * list rots the first time you add a chunk and the app half-works offline.
 *
 * Four things here are load-bearing.
 *
 * A cold offline launch has to make no requests at all, hence the
 * navigator.onLine gate on the document. fetch() on a dead network isn't free,
 * it's a timeout, and on a phone a timeout is a blank screen.
 *
 * index.html is never served cache-first. It's the one file whose name doesn't
 * change between builds, so caching it first means a deploy never arrives.
 * Network while online, cache as the fallback.
 *
 * activate() keeps the previous build's cache. The old page may still be running
 * and may still import a chunk it hasn't needed yet; delete that cache and the
 * import 404s into a blank view.
 *
 * Every cache lookup passes ignoreSearch, or the ?v= stamped icons and manifest
 * miss their own entries. Which also means ?v= is useless as a cache key in
 * here, and that's why the build puts the hash in the filename instead.
 */

declare const __BUILD__: string;
declare const __PRECACHE__: string[];

/**
 * `self` is already typed as a generic WorkerGlobalScope, and redeclaring it is
 * an error, so the service-worker surface is reached through this alias. Using
 * `sw.` rather than `self.` also makes it obvious at each call site which global
 * is meant.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `inphub-lite-${__BUILD__}`;
/** How many older build caches to keep alive. 1 = keep the previous generation. */
const KEEP_GENERATIONS = 1;

/** The shell: enough to paint and run with no network at all. */
const PRECACHE: string[] = __PRECACHE__;

sw.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll() is atomic-or-nothing: one 404 and the whole install fails, which
    // is the behaviour we want for a shell. Chunks warmed later are best-effort.
    await cache.addAll(PRECACHE);
    // No skipWaiting() here on purpose. The new worker waits until the user
    // accepts the update toast, so a running page never loses its build.
  })());
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const mine = keys.filter((k) => k.startsWith('inphub-lite-'));
    // Newest last: cache names carry no ordering, so fall back to "keep the
    // current one plus however many the browser still lists", in practice the
    // previous build, which is the one a running page might still need.
    const doomed = mine.filter((k) => k !== CACHE).slice(0, Math.max(0, mine.length - 1 - KEEP_GENERATIONS));
    await Promise.all(doomed.map((k) => caches.delete(k)));
    await sw.clients.claim();
  })());
});

sw.addEventListener('message', (event: ExtendableMessageEvent) => {
  const type = (event.data as { type?: string } | null)?.type;
  // Only ever from the user's click on the update toast (see main.ts).
  if (type === 'skip-waiting') void sw.skipWaiting();
  if (type === 'warm') event.waitUntil(warm());
});

/**
 * Pull anything in the precache list that install() did not already store.
 * Runs on idle from main.ts, so a first offline launch is not missing the views
 * that were never opened while online.
 */
async function warm(): Promise<void> {
  const cache = await caches.open(CACHE);
  await Promise.all(PRECACHE.map(async (url) => {
    if (await cache.match(url, { ignoreSearch: true })) return;
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (res.ok) await cache.put(url, res);
    } catch {
      /* best effort */
    }
  }));
}

sw.addEventListener('fetch', (event: FetchEvent) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Same-origin only. api.github.com must never be cached: a stale repo list
  // that cannot be refreshed is worse than no repo list.
  if (url.origin !== sw.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(document_(request));
    return;
  }
  event.respondWith(asset(request));
});

/**
 * The document: network-first, but only while the browser believes it is online.
 * Offline, go straight to the cache so the launch costs nothing.
 */
async function document_(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  if (navigator.onLine) {
    try {
      const res = await fetch(request);
      if (res.ok) {
        await cache.put('./', res.clone());
        return res;
      }
    } catch {
      /* fall through to the cache */
    }
  }
  return (await cache.match('./', { ignoreSearch: true }))
    ?? (await cache.match('index.html', { ignoreSearch: true }))
    ?? new Response('inphub lite is offline and has nothing cached yet.', {
      status: 503, headers: { 'Content-Type': 'text/plain' },
    });
}

/**
 * Everything else: cache-first. Safe because every file that can change between
 * builds has its content hash in its filename, so a cache hit is by definition
 * the right bytes.
 */
async function asset(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;

  if (!navigator.onLine) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') await cache.put(request, res.clone());
  return res;
}
