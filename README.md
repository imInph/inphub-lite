# inphub lite

v1.1.1, MIT licensed.

You can access inphub-lite [here](https://iminph.github.io/inphub-lite/).

The same dashboard as [inphub](https://github.com/): money, tasks, habits, goals,
notes, focus sessions, my GitHub repos and a history log, but with nothing
behind it. No PHP, no MySQL, no XAMPP, no AI. It's a static site on GitHub
Pages and everything it knows lives in your browser.

inphub only runs on my own machine with XAMPP started. This one opens on a
phone, installs to the home screen, and works on a plane.

## What's different from inphub

| | inphub | inphub lite |
| --- | --- | --- |
| Runs on | XAMPP, localhost only | GitHub Pages, any device |
| Backend | PHP 8, 21 endpoints | none |
| Data | MySQL, 17 tables | IndexedDB, 12 stores |
| Accounts | hand-made logins | none, it's your browser |
| AI | Claude / Ollama / LM Studio | gone |
| Offline | no | yes, installable |
| Backup | mysqldump | JSON export and import |

Everything else is the same on purpose, down to the stylesheet. Same eleven
views, same widgets, same keyboard shortcuts, same glass-over-wallpaper look
with nine accents and seven wallpapers. The logo just says `lite` now.

### The things it can't do

- **No accounts.** It opens straight to the dashboard. Anyone who can open your
  browser can read it, and the data is in DevTools for anyone who looks. It's a
  personal dashboard on your own device, not a secure vault.
- **No Google suggestions** in the search bar. That needed a server to proxy
  them. The bar still searches your own stuff, and Enter still opens Google.
- **No AI.** No chat, no daily brief, no weekly review, no repo analysis.

### Moving your data across

Both apps read and write the same backup file, so it goes either way. Export
from inphub (Settings, Data, Export), then Import it here, or the reverse.
`BACKUP-FORMAT.md` describes the file; inphub 3.2.0 or newer writes it.

Replace is what you want for "move me across": it keeps the original ids, so
anything that referred to a row still does. Merge is there for folding two
sets together and never trusts an incoming id.

## Your data

It's in IndexedDB, in one browser, on one device. There is no server and no
sync, so **there is exactly one copy and no safety net**.

- The app asks the browser to keep it (`navigator.storage.persist()`). Settings
  shows whether it agreed.
- **On iPhone, add it to the Home Screen.** Safari clears the storage of sites
  you haven't opened in seven days, and being installed is what stops that.
- Export a backup now and then. Settings, Data, Export. It'll nag you after
  two weeks.

Clearing site data deletes everything. So does "clear history" on some
browsers. Export first.

## Running it locally

```bash
npm install
npm run dev
```

Then <http://localhost:4173>. `npm run dev` rebuilds on every change and serves
`public/` the way Pages does, so an absolute path that would 404 in production
also 404s here.

```bash
npm run build      # typecheck, invariant check, then build into public/
npm test           # the date/streak/scoring maths
```

**`public/` is build output and it's committed.** That's what lets Pages deploy
with no build step. If you change anything in `src/`, run `npm run build` and
commit what it writes. A GitHub Action rebuilds and diffs on every push, so
you'll find out if you forget, but you'll find out slower.

## Installing it

Open the Pages URL, then add it to your home screen (iOS: Share, Add to Home
Screen; Android/desktop Chrome: the install button in the address bar). After
that it opens standalone and works with no network at all.

When you deploy a new build, the next time the app is online it shows a small
"A new version of inphub lite is ready" prompt with a Reload button. It waits
for you rather than timing out, and it only appears when there actually is a
new version. If you were offline when you opened it, the prompt turns up when
you reconnect.

Your data is untouched by any of that; the update only replaces the app.

## If it breaks

Open it with `?nosw=1` on the end of the URL. That unregisters the service
worker, drops every cache and reloads clean. It's there because a bad cached
build on a phone is otherwise very hard to escape.

Your data isn't touched by that, it's a separate thing from the cache.

## The GitHub token

The Repos tab talks to `api.github.com` straight from the browser. That needs a
personal access token and it's kept in `localStorage`. Without one it still
works, on public repos only, at 60 requests an hour.

Be aware of what that means: `yourname.github.io` is one origin for *every*
project you publish there, so any other page of yours on that domain can read
it. Use a fine-grained token, read-only, repo metadata, with an expiry date.
It's never written to the database and never included in an export.

## Layout

```
src/            the source: views, data layer, service worker, stylesheet
src/data/       IndexedDB. db.ts owns the connection, tx.ts owns every write
public/         the built site, committed, deployed as-is
tools/          build.mjs and check-invariants.mjs
tests/          the maths that would otherwise be wrong quietly
```

`CLAUDE.md` has the architecture notes and the gotchas worth knowing before
changing anything.

## License

[MIT](LICENSE). Do what you want with it, no warranty.
