# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`inphub lite` is the static, server-less sibling of `inphub`: the same personal
life-dashboard (expenses, GitHub repos, todos, habits, goals, notes, focus
sessions, activity history) with **no PHP, no MySQL, no XAMPP and no AI**. It is
a static site on GitHub Pages whose entire state is IndexedDB + localStorage.
TypeScript bundled by esbuild to plain ES modules, no React and no framework.

A reference clone of the full inphub lives at `./inphub/` and is **gitignored**.
It is the source of truth for anything ported: when a number here disagrees with
inphub's, inphub is right and this is a porting bug. Read `inphub/CLAUDE.md`
before changing ported logic; it records why things are the way they are.

**The design system is a copy, not an inspiration.** `src/styles/app.css` is
inphub's `app.css` with exactly two blocks removed (Login, Chat panel) and one
rule added (`.logo-lite`). A divergence is a bug, not a cleanup.

## Commands

- **Build:** `npm run build`, which runs typecheck (both tsconfigs), `check-invariants`,
  then `tools/build.mjs`. Never run esbuild directly; the build also stamps the
  version and build id into the HTML and generates the service worker's
  precache list from the esbuild metafile.
- **Dev:** `npm run dev`, watch plus a static server on :4173 that serves `public/`
  the way Pages does, so an absolute path 404s here too.
- **Test:** `npm test`, i.e. `node --test` with a pinned `TZ`. Tests cover the maths
  that fails silently: date windows, ISO weeks, streaks, scoring, import coercion.
- **`public/` is committed build output.** Every commit touching `src/` must
  include the rebuilt `public/`. The build is deterministic (id derived from
  sources, no timestamp), so an unchanged rebuild produces no diff, and
  `.github/workflows/verify.yml` diffs it on every push.

## Architecture

### The data layer (`src/data/`)
No server, so everything PHP used to do happens here.

- **`db.ts` is the only `indexedDB.open()`.** It owns the schema, the
  append-only `MIGRATIONS` array, `withTx()`, and the `onblocked` /
  `onversionchange` handling (skip either and the app hangs on a schema bump).
- **`tx.ts` is the only `.delete()`.** `create` / `update` / `remove` are the
  mutation primitives. `remove()` applies the cascade / set-null rules in
  `relations.ts`, the foreign keys IndexedDB does not have.
- **`tools/check-invariants.mjs` enforces both**, plus: no stray `fetch()`
  outside `github.ts`/`sw.ts`, no absolute paths, no unprefixed localStorage
  keys, no `'inphub.'` legacy keys. It fails the build. Add a rule whenever you
  find a mistake that is invisible in review.

**The transaction trap.** An IDB transaction auto-commits as soon as the
microtask queue drains with no request pending. Awaiting anything that is not an
IDB request inside one ends it, and the next store access throws
`TransactionInactiveError`. So: **compute everything before opening the
transaction**: timestamps, derived values, network responses, summary strings.
Inside the callback, only chain IDB requests.

**The activity log is not optional.** Insights' hours-of-day chart and the whole
History view are built *entirely* from `activity_log`, so a mutation that writes
no row is a hole in the charts. `tx.ts` therefore takes a **required** log
descriptor: omit it and `tsc` fails. Skipping is spelled `SILENT`, so
`grep -rn SILENT src/` is the complete audit list.

### Backup / restore (`src/data/backup.ts`, `import.ts`, `export.ts`)
`BACKUP-FORMAT.md` is the contract and **an identical copy lives in the inphub repo**,
alongside `lib/backup.php` which is this file's mirror. Both apps read and write the same
`.txt`. Change one side without the other and the migration breaks in one direction only,
which is the hardest kind to notice. Bump `format_version` when the shape changes.

`parseBackup()` validates everything in memory and writes nothing, so the counts a user
confirms against are real. `applyBackup()` then writes in one transaction across every
store. Two modes only: **replace** keeps original ids (the only way `entity_id` and deep
links survive) and **merge** never trusts an incoming id. `habit_logs` collisions take
`max(count)`, not the sum, or importing the same file twice doubles every day.

`import.ts` is the only caller of `clear()` and is allowlisted for it in
check-invariants. The `COERCE` table is the same job `normalize.ts` does for the create
path, and it exists because an inphub file carries PDO's stringified numbers.

### Dates (`src/data/dates.ts`)
Every date and time string is built here, and **`toISOString()` is banned**.
Dates are `YYYY-MM-DD`, datetimes are `YYYY-MM-DDTHH:mm:ss`, both **local wall
clock**. inphub read MySQL `TIMESTAMP` columns in server-local time and
`HOUR(created_at)` drives the Insights chart; store UTC instead and every bucket
shifts by your offset. The chart does not break, it lies. Local also keeps
lexicographic order chronological, which is what makes `IDBKeyRange.bound()`
work on `spent_at` / `created_at` / `logged_date`.

`addMonths()` deliberately keeps PHP's `strtotime('+1 month')` overflow
(Jan 31 → Mar 3) because inphub's recurring to-dos land there.
`monthBounds()` never subtracts months from *today*, which overflows on the
29th–31st, which is the bug `money_period_range()` documents.

### Storage layout
- **IndexedDB**, the durable source of truth, and what a backup round-trips.
- **localStorage**, the theme/appearance cache *only*, because the pre-paint
  script in `index.html` has to read it synchronously before first paint. Keys
  are prefixed `inphub-lite:` because `<user>.github.io` is **one origin for
  every project published there**.
- **localStorage (GitHub PAT)**, never in IndexedDB and never in
  an export. Same origin caveat: say so in the UI.

### Indexing rule
Index only the four append-only stores on their time column, the unique indexes
replacing MySQL constraints, and the two fk indexes needed for set-null.
**Everything else is `getAll()` + JS.** Notably `todos` is *not* indexed even
though MySQL indexed it: `ORDER BY (due_date IS NULL), due_date, FIELD(priority,…)`
is not expressible as an IDB index, so you would re-sort in JS anyway.

`activity_log` is the exception. It gets a row on every mutation and is the only
store with unbounded growth. **Never `getAll()` it**; walk
`index('created_at').openCursor(null, 'prev')` and stop at the limit, which also
matches PHP's `ORDER BY created_at DESC, id DESC LIMIT n` exactly.

### Build and cache (`tools/build.mjs`, `src/sw.ts`)
Content-hashed filenames replace inphub's `tools/stamp-modules.mjs`. Read that
file's comment before wondering why: inphub's separate ES modules imported each
other by bare relative path, so a fresh `app.js` could pair with a cached
`ui.js`, and a missing export is an ES-module *link* error that kills the app in
silence. Hashed filenames make mixing two builds impossible.

`?v=` survives only where a filename cannot change (icons, manifest). It is
useless as a cache key *inside* the service worker, because `ignoreSearch: true`
hides it, which is the other reason the hash goes in the filename.

Service worker rules, each for a specific failure:
- `updateViaCache: 'none'` or a deploy may not arrive for 24 hours.
- Never cache-first `index.html`; its name never changes.
- `navigator.onLine` gates the document fetch, so a cold offline launch makes
  **zero** requests (a fetch on a dead network is a timeout, i.e. a blank screen).
- **Keep the previous build's cache for one generation.** `skipWaiting` mid-session
  otherwise deletes a cache the running page still needs, and any not-yet-imported
  chunk 404s into a blank view. `skipWaiting` fires only from the update toast.
- `?nosw=1` is the documented kill switch.

The update prompt is the part users actually see, and it is modelled on inphner's,
which is the proven one:
- Registration waits for `load` and only runs on https or localhost.
- **If the app is offline and already controlled, it does not register at all**;
  it waits for the `online` event and tries then. That is what makes the prompt
  appear when you reconnect rather than never. Opening from the home screen with
  no signal is the normal case on a phone.
- `reg.waiting` is offered on load too, for an update that arrived last visit,
  but only when `navigator.serviceWorker.controller` exists, or the very first
  install would announce itself as an update.
- The toast is **persistent**: it is the one prompt in the app that does not time
  out. A seven-second offer to reload is one you miss, and then the app quietly
  stays on the old build.

The manifest needs a real **512x512 PNG** (plus a maskable one) or Chrome will not
offer to install it; SVG icons alone are not enough. `tools/build.mjs` precaches
whatever is in `src/icons/`, so adding a size there is all it takes.

### Shell (`src/app.ts`, `src/index.html`)
`index.html` is a **template**; `tools/build.mjs` fills the double-brace slots and
writes `public/index.html`. Never edit the output.

Conventions carried over from inphub that prevent recurring bugs. The reasons are
in `inphub/CLAUDE.md` and still apply:
- **Topbar/drawer chrome is wired through inline `onclick`** calling
  `window.inphubToggleTheme` / `inphubDrawer` / `inphubPalette`. In the owner's
  Firefox both `addEventListener` and document-level delegation silently never
  fired for these buttons. Keep it; new global chrome follows the same pattern.
- **View containers are persistent nodes whose `innerHTML` is swapped.** Wire
  delegated clicks through `onAction()` in `ui.ts` (idempotent, WeakMap-backed).
  Never `addEventListener` on a `#view-*` container from a render function, and
  never capture child nodes across renders.
- **Routes carry params** (`#notes?focus=7`). `routeKey()` compares the *whole*
  route, and the boot normaliser compares the parsed **view id**, never the raw
  hash, or a deep link is rewritten before anything renders. Params are *read,
  not consumed*.
- **Entry animations on containers use fill mode `backwards`, never `both`**:
  a filled animation isolates the element and kills `backdrop-filter` inside it.
- All user data interpolated into HTML goes through `escapeHtml()` or `markdown()`.

### Porting a view from inphub
The pattern that worked: copy the file, rewrite the imports, drop the explicit
type arguments (`apiGet<Todo[]>` no longer compiles, the route map infers it),
then fix what `tsc` complains about. Three classes of bug came out of that and
they will come out of the next one too:

- **Local interfaces that encode PDO's types.** inphub's views declare
  `amount: string` and `total: string` because `EMULATE_PREPARES => false`
  stringifies `DECIMAL`. Delete the local copy and import the real type; the
  now-pointless `parseFloat` calls fall out with it.
- **`declare const Chart`** (and `marked`, `DOMPurify`). Fine with a `<script>`
  tag, undefined when bundled, and it fails *silently*: the tiles render, the
  charts draw nothing. There is an invariant rule for this now.
- **Hardcoded "inphub"** in user-visible copy. `focus.ts` sets the tab title.

### Turkish
inphub got case-insensitive `İ/I/ı/i` matching free from MySQL's
`utf8mb4_unicode_ci` and explicitly **forbade** client-side re-filtering because
JS `toLowerCase()` gets Turkish wrong. Lite has no choice, matching is now JS.
Use the single `fold()` helper on **both** sides of every comparison, and keep
its test.

## Layout

```
src/index.html      shell TEMPLATE ({{ENTRY}} {{CSS}} {{VERSION}} {{BUILD}})
src/styles/app.css  inphub's stylesheet, two blocks removed
src/main.ts         entry: kill switch, SW registration, persistence, backup nag
src/app.ts          SPA shell: routing, theme, clock, drawer, shortcuts
src/ui.ts           toasts, modals, markdown, formatting (ported unchanged)
src/data/           db · tx · relations · types · dates · settings · queries
src/sw.ts           service worker source (own tsconfig: WebWorker lib)
public/             committed build output, never hand-edited
tools/              build.mjs · check-invariants.mjs
inphub/             reference clone of the full app, gitignored
```
