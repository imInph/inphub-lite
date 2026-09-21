/**
 * inphub lite: settings. Appearance, profile, GitHub and data.
 *
 * inphub's version also had an AI provider card, a password form and an admin
 * account panel. There are no accounts and no AI, so what is left is the look,
 * the two profile numbers the rest of the app reads, the GitHub token, and the
 * backup tools.
 *
 * Everything except the token lives in the settings store. The token is
 * localStorage only, because IndexedDB round-trips into a backup file and a
 * credential has no business in one.
 */

import { escapeHtml, fmtDate, formValues, loadingState, onAction, openModal, toast } from '../ui.ts';
import {
  BUILD, VERSION, applyAppearance, applyTheme, cssUrl, refreshCurrentView,
} from '../app.ts';
import { meta } from '../data/db.ts';
import { allSettings, appearanceFrom, saveSettings, type Appearance } from '../data/settings.ts';
import { exportBackup } from '../data/export.ts';
import { parseBackup, type ParsedBackup } from '../data/backup.ts';
import { applyBackup, type ImportMode } from '../data/import.ts';
import { getToken, setToken } from '../github.ts';
import { daysBetween, localDate } from '../data/dates.ts';

/** The sentinel a masked secret round-trips as, so a mask never overwrites the real value. */
const SECRET_UNCHANGED = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

/** Accent presets with their dark-theme swatch colour (UI_ACCENTS in lib/helpers.php). */
const ACCENTS: [string, string, string][] = [
  ['blue', 'Blue', '#3d8bff'], ['indigo', 'Indigo', '#7a78ff'], ['purple', 'Purple', '#bf5af2'],
  ['pink', 'Pink', '#ff5ea8'], ['red', 'Red', '#ff5a5f'], ['orange', 'Orange', '#ff9f0a'],
  ['green', 'Green', '#30d158'], ['teal', 'Teal', '#40c8e0'], ['graphite', 'Graphite', '#9aa0ab'],
];

/** Wallpaper presets (UI_WALLPAPERS in lib/helpers.php). */
const WALLPAPERS: [string, string][] = [
  ['aurora', 'Aurora'], ['sunset', 'Sunset'], ['ocean', 'Ocean'], ['forest', 'Forest'],
  ['graphite', 'Graphite'], ['plain', 'Plain'], ['custom', 'Custom'],
];

export async function renderSettings(container: HTMLElement): Promise<void> {
  container.innerHTML = loadingState();

  const [s, lastExport, persisted, estimate] = await Promise.all([
    allSettings(),
    meta<string | null>('last_export_at', null),
    navigator.storage?.persisted?.() ?? Promise.resolve(false),
    navigator.storage?.estimate?.() ?? Promise.resolve({ usage: 0 }),
  ]);

  const look = appearanceFrom(s);
  const root = document.documentElement;
  const theme = root.getAttribute('data-theme') || s['theme'] || 'dark';
  const accent = root.getAttribute('data-accent') || look.accent;
  const wallpaper = root.getAttribute('data-wallpaper') || look.wallpaper;
  const transparency = root.getAttribute('data-glass') || look.transparency;
  const logoLocked = !wallpaperHasPalette(wallpaper);
  const logoTint = logoLocked ? 'accent' : (root.getAttribute('data-logo') || look.logo_tint);
  const wpUrl = look.wallpaper_url;
  const tokenSet = getToken() !== '';

  const used = estimate.usage ? `${(estimate.usage / 1024 / 1024).toFixed(1)} MB` : 'nothing yet';
  const backupLine = lastExport
    ? `Last backup: ${daysBetween(lastExport, localDate()) === 0 ? 'today' : fmtDate(lastExport)}.`
    : 'You have never exported a backup.';

  container.innerHTML = `
    <form data-role="form" class="grid grid-2">

      <section class="card" style="grid-column:1/-1" data-role="appearance">
        <div class="card-head"><h3>Appearance</h3><small>Changes preview instantly, Save keeps them.</small></div>
        <div class="appearance">
          <div class="appearance-row"><span>Theme</span>
            <div class="segmented" role="group" aria-label="Theme">
              ${[['dark', 'Dark'], ['light', 'Light']].map(([k, label]) => `
                <button type="button" data-pick="theme" data-value="${k}" class="${theme === k ? 'on' : ''}" aria-pressed="${theme === k}">${label}</button>`).join('')}
            </div>
            <input type="hidden" name="theme" value="${escapeHtml(theme)}">
          </div>
          <div class="appearance-row"><span>Accent color</span>
            <div class="swatches">
              ${ACCENTS.map(([k, label, hex]) => `
                <button type="button" class="swatch ${accent === k ? 'on' : ''}" data-pick="ui_accent" data-value="${k}"
                  style="--sw:${hex}" title="${label}" aria-label="${label}" aria-pressed="${accent === k}"></button>`).join('')}
            </div>
            <input type="hidden" name="ui_accent" value="${escapeHtml(accent)}">
          </div>
          <div class="appearance-row"><span>Wallpaper</span>
            <div class="wp-grid">
              ${WALLPAPERS.map(([k, label]) => `
                <button type="button" class="wp-thumb ${wallpaper === k ? 'on' : ''}" data-pick="ui_wallpaper" data-value="${k}"
                  data-wallpaper="${k}" aria-pressed="${wallpaper === k}"
                  ${k === 'custom' && /^https?:\/\//i.test(wpUrl) ? `style="background-image:${escapeHtml(cssUrl(wpUrl))}"` : ''}><span>${label}</span></button>`).join('')}
            </div>
            <input type="hidden" name="ui_wallpaper" value="${escapeHtml(wallpaper)}">
            <label data-role="wp-url" style="margin-top:12px" ${wallpaper === 'custom' ? '' : 'hidden'}><span>Image URL</span>
              <input name="ui_wallpaper_url" type="url" inputmode="url" value="${escapeHtml(wpUrl)}" placeholder="https://example.com/wallpaper.jpg" autocomplete="off"></label>
          </div>
          <div class="appearance-row ${logoLocked ? 'is-locked' : ''}" data-role="logo-row"><span>Logo color</span>
            <div class="segmented" role="group" aria-label="Logo color">
              ${[['accent', 'Accent color'], ['wallpaper', 'Wallpaper']].map(([k, label]) => `
                <button type="button" data-pick="ui_logo_tint" data-value="${k}" class="${logoTint === k ? 'on' : ''}" aria-pressed="${logoTint === k}"
                  ${logoLocked ? 'disabled' : ''}>${label}</button>`).join('')}
            </div>
            <small class="logo-lock-note">Plain and Custom wallpapers don't have colors of their own, so the logo uses your accent color.</small>
            <input type="hidden" name="ui_logo_tint" value="${escapeHtml(logoTint)}">
          </div>
          <label class="checkbox"><input type="checkbox" data-role="reduce" ${transparency === 'reduced' ? 'checked' : ''}>
            <span>Reduce transparency</span></label>
          <input type="hidden" name="ui_transparency" value="${escapeHtml(transparency)}">
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h3>Profile</h3></div>
        <label><span>Display name</span><input name="owner_name" value="${escapeHtml(s['owner_name'] ?? '')}"></label>
        <label><span>Base currency</span><input name="base_currency" value="${escapeHtml(s['base_currency'] || 'TRY')}" maxlength="3"></label>
        <label><span>Starting balance</span>
          <input name="starting_balance" type="number" step="0.01" value="${escapeHtml(s['starting_balance'] || '0')}">
          <small class="text-dim">Money you had before you started logging here. Can be negative.</small></label>
      </section>

      <section class="card">
        <div class="card-head"><h3>GitHub</h3></div>
        <label><span>Username</span><input name="github_username" value="${escapeHtml(s['github_username'] ?? '')}"></label>
        <label><span>Personal access token ${tokenSet ? '<span class="chip">set</span>' : ''}</span>
          <input name="github_token" type="password" value="${tokenSet ? SECRET_UNCHANGED : ''}" placeholder="ghp_… (optional, for private repos)">
          <small class="text-warn">Kept in this browser's localStorage, not in the database and never in a backup.
            Anything running on this domain can read it, and on GitHub Pages that is every project you publish.
            Use a fine-grained, read-only token with an expiry date.</small></label>
        <label><span>Stale after (days)</span><input name="stale_repo_days" type="number" min="1" value="${escapeHtml(s['stale_repo_days'] || '60')}"></label>
      </section>

      <section class="card" style="grid-column:1/-1">
        <div class="card-head"><h3>Data</h3>
          <span class="text-dim" style="font-size:.82rem">Everything lives in this browser.</span></div>
        <div>${escapeHtml(backupLine)}</div>
        ${persisted ? '' : `<div class="text-warn" style="margin-top:6px">
          This browser hasn't promised to keep your data, so it can be cleared to free up space.
          Adding inphub lite to your home screen usually earns that promise.</div>`}
        <div class="toolbar" style="margin-top:14px">
          <button type="button" class="btn" data-action="export">Export / back up…</button>
          <button type="button" class="btn" data-action="import">Import…</button>
        </div>
        <div class="text-dim" style="margin-top:8px;font-size:.82rem">
          One .txt file with everything, minus your GitHub token.
          Import reads backups from inphub lite and from inphub.</div>
      </section>

      <div class="toolbar" style="grid-column:1/-1">
        <button class="btn btn-primary" type="submit">Save</button>
        <span class="text-dim" style="font-size:.82rem">
          inphub lite v${escapeHtml(VERSION)} · build ${escapeHtml(BUILD)} · ${escapeHtml(used)} stored${persisted ? ', kept by the browser' : ''}</span>
      </div>
    </form>`;

  const form = container.querySelector<HTMLFormElement>('[data-role="form"]')!;
  wireAppearance(form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void save(container, form);
  });

  onAction(container, (action) => {
    if (action === 'export') void runExport();
    if (action === 'import') openImport(container);
  });
}

/**
 * Save the form.
 *
 * The token goes to localStorage and everything else to the settings store. The
 * mask sentinel means "leave it alone", which is what stops opening Settings
 * and saving from wiping a token you never touched.
 *
 * The look is cached only once the write succeeds, so leaving without saving
 * reverts on the next reload, exactly as the preview promises.
 */
async function save(container: HTMLElement, form: HTMLFormElement): Promise<void> {
  const v = formValues(form);
  try {
    const token = (v['github_token'] ?? '').trim();
    if (token !== SECRET_UNCHANGED) setToken(token);

    const wallpaper = v['ui_wallpaper'] ?? 'aurora';
    await saveSettings({
      theme: v['theme'] ?? 'dark',
      owner_name: (v['owner_name'] ?? '').trim(),
      base_currency: (v['base_currency'] || 'TRY').slice(0, 3).toUpperCase(),
      starting_balance: String(Number(v['starting_balance'] ?? 0) || 0),
      github_username: (v['github_username'] ?? '').trim(),
      stale_repo_days: String(Math.max(1, Number(v['stale_repo_days'] ?? 60) || 60)),
      ui_accent: v['ui_accent'] ?? 'blue',
      ui_wallpaper: wallpaper,
      ui_wallpaper_url: v['ui_wallpaper_url'] ?? '',
      ui_transparency: v['ui_transparency'] ?? 'full',
      // Plain and Custom have no palette, so the tint is forced back to accent
      // here as well as in appearanceFrom(), or a stale value would round-trip.
      ui_logo_tint: wallpaperHasPalette(wallpaper) ? (v['ui_logo_tint'] ?? 'accent') : 'accent',
    });

    applyTheme(v['theme'] ?? 'dark');
    applyAppearance(lookFromForm(v));
    toast('Saved.', 'good');
    void renderSettings(container);
    refreshCurrentView();
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not save.', 'bad');
  }
}

/** Wallpapers with a colour palette the logo can use (UI_WALLPAPERS minus plain/custom). */
function wallpaperHasPalette(wallpaper: string): boolean {
  return wallpaper !== 'plain' && wallpaper !== 'custom';
}

function lookFromForm(v: Record<string, string>): Appearance {
  return {
    accent: v['ui_accent'] ?? 'blue',
    wallpaper: v['ui_wallpaper'] ?? 'aurora',
    wallpaper_url: v['ui_wallpaper_url'] ?? '',
    transparency: v['ui_transparency'] ?? 'full',
    logo_tint: v['ui_logo_tint'] ?? 'accent',
  };
}

/**
 * Live preview for the Appearance card. The hidden inputs carry the choices
 * into the normal Save; nothing is cached until Save succeeds, so leaving
 * without saving reverts on the next reload.
 */
function wireAppearance(form: HTMLFormElement): void {
  const section = form.querySelector<HTMLElement>('[data-role="appearance"]');
  if (!section) return;
  const field = (name: string) => form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const preview = () => {
    const v = formValues(form);
    applyTheme(v['theme'] ?? 'dark', false);
    applyAppearance(lookFromForm(v), false);
  };

  const select = (key: string, value: string) => {
    field(key).value = value;
    section.querySelectorAll<HTMLElement>(`[data-pick="${key}"]`).forEach((b) => {
      const on = b.dataset.value === value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  };

  // The user's own logo choice, put back when they leave Plain/Custom again.
  let chosenLogoTint = field('ui_logo_tint').value;
  const lockLogo = (wallpaper: string) => {
    const locked = !wallpaperHasPalette(wallpaper);
    section.querySelector('[data-role="logo-row"]')?.classList.toggle('is-locked', locked);
    section.querySelectorAll<HTMLButtonElement>('[data-pick="ui_logo_tint"]').forEach((b) => {
      b.disabled = locked;
    });
    select('ui_logo_tint', locked ? 'accent' : chosenLogoTint);
  };

  section.addEventListener('click', (e) => {
    const pick = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]');
    if (!pick || (pick as HTMLButtonElement).disabled) return;
    const key = pick.dataset.pick!;
    select(key, pick.dataset.value!);
    if (key === 'ui_logo_tint') chosenLogoTint = pick.dataset.value!;
    if (key === 'ui_wallpaper') {
      const urlRow = section.querySelector<HTMLElement>('[data-role="wp-url"]')!;
      urlRow.hidden = pick.dataset.value !== 'custom';
      if (!urlRow.hidden) urlRow.querySelector('input')?.focus();
      lockLogo(pick.dataset.value!);
    }
    preview();
  });

  section.querySelector<HTMLInputElement>('[data-role="reduce"]')?.addEventListener('change', (e) => {
    field('ui_transparency').value = (e.target as HTMLInputElement).checked ? 'reduced' : 'full';
    preview();
  });

  let timer = 0;
  field('ui_wallpaper_url').addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const url = field('ui_wallpaper_url').value.trim();
      const thumb = section.querySelector<HTMLElement>('.wp-thumb[data-value="custom"]');
      if (thumb) thumb.style.backgroundImage = /^https?:\/\//i.test(url) ? cssUrl(url) : '';
      preview();
    }, 350);
  });
}

async function runExport(): Promise<void> {
  try {
    const rows = await exportBackup(VERSION);
    toast(`Exported ${rows} rows.`, 'good');
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Export failed.', 'bad');
  }
}

/**
 * Two steps, on purpose.
 *
 * The file is parsed and checked first and nothing is written, so the counts you
 * confirm against are the real ones. Replace is offered first because it is what
 * "restore my backup" means, and it is the only mode that keeps ids, so anything
 * referring to a row by id still refers to it afterwards.
 */
function openImport(container: HTMLElement): void {
  const backdrop = openModal({
    title: 'Import a backup',
    confirmLabel: '',
    cancelLabel: 'Close',
    bodyHtml: `
      <p class="text-dim" style="margin-top:0">
        A <code>.txt</code> backup written by inphub lite or by inphub.</p>
      <label><span>Backup file</span>
        <input type="file" data-role="file" accept=".txt,.json,text/plain,application/json"></label>
      <div data-role="report" class="text-dim" style="margin-top:12px;font-size:.85rem"></div>
      <div data-role="choices" hidden style="margin-top:14px">
        <label><span>How</span>
          <select data-role="mode">
            <option value="replace">Replace everything here</option>
            <option value="merge">Merge into what is already here</option>
          </select></label>
        <div class="text-dim" style="margin-top:6px;font-size:.82rem" data-role="note"></div>
        <button class="btn btn-primary" data-role="go" style="margin-top:12px">Import</button>
      </div>`,
  });

  const pick = <T extends HTMLElement>(role: string) => backdrop.querySelector<T>(`[data-role="${role}"]`)!;
  const report = pick('report');
  const choices = pick('choices');
  const mode = pick<HTMLSelectElement>('mode');
  const note = pick('note');
  let parsed: ParsedBackup | null = null;

  const describe = () => {
    note.textContent = mode.value === 'replace'
      ? 'Everything here is deleted first, then the backup is written with its original ids.'
      : 'Nothing is deleted. Rows come in with new ids, and a category or repo that already exists is reused.';
  };
  mode.addEventListener('change', describe);
  describe();

  pick<HTMLInputElement>('file').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    choices.hidden = true;
    report.textContent = 'Reading…';
    try {
      parsed = parseBackup(await file.text());
      const rows = Object.entries(parsed.counts).filter(([, n]) => n > 0);
      const total = rows.reduce((n, [, c]) => n + c, 0);
      report.innerHTML = `
        <div>From <strong>${escapeHtml(parsed.meta.app)}</strong>
          ${escapeHtml(parsed.meta.app_version ? 'v' + parsed.meta.app_version : '')}${
          parsed.meta.exported_at ? ', exported ' + escapeHtml(fmtDate(parsed.meta.exported_at.slice(0, 10))) : ''}.</div>
        <div style="margin-top:6px">${total} rows: ${
          rows.map(([t, n]) => `${escapeHtml(t.replace(/_/g, ' '))} ${n}`).join(' · ')}</div>
        ${parsed.warnings.length ? `<div class="text-warn" style="margin-top:8px">${
          parsed.warnings.map((w) => escapeHtml(w)).join('<br>')}</div>` : ''}`;
      choices.hidden = false;
    } catch (err) {
      parsed = null;
      report.textContent = err instanceof Error ? err.message : 'Could not read that file.';
    }
  });

  pick<HTMLButtonElement>('go').addEventListener('click', async () => {
    if (!parsed) return;
    const btn = pick<HTMLButtonElement>('go');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const res = await applyBackup(parsed, mode.value as ImportMode);
      const total = Object.values(res.written).reduce((n, c) => n + c, 0);
      backdrop.remove();
      toast(`Imported ${total} rows.`, 'good');
      window.dispatchEvent(new CustomEvent('inphub:data-changed'));
      void renderSettings(container);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Import';
      toast(err instanceof Error ? err.message : 'Import failed.', 'bad');
    }
  });
}
