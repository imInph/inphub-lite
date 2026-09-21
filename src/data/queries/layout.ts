/**
 * inphub lite: the dashboard layout and shortcuts, out of settings.
 *
 * DASHBOARD_WIDGETS from lib/helpers.php, minus `brief`, which was the AI daily
 * brief and the only wide widget. The ids here and in views/widgets.ts must
 * match exactly: normalise drops anything it does not recognise, so a widget
 * added on one side only can never be saved, and one added on the other renders
 * as nothing.
 */

export const WIDGET_SIZES = ['normal', 'wide'] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** id => default size, in the default order. */
export const DASHBOARD_WIDGETS: Record<string, WidgetSize> = {
  clock: 'normal',
  capture: 'normal',
  todos: 'normal',
  upcoming: 'normal',
  habits: 'normal',
  money: 'normal',
  wallet: 'normal',
  goals: 'normal',
  focus: 'normal',
  activity: 'normal',
  repos: 'normal',
};

export interface LayoutItem { id: string; size: WidgetSize }
/** {name, url}, matching widgets.ts. Renaming it would silently empty the rail. */
export interface Shortcut { name: string; url: string }

/**
 * normalise_dashboard_layout(): whitelist the ids, drop unknowns and
 * duplicates, and fall back to each widget's default size. Returns null when
 * the input is not a list, so a caller can reject the save rather than silently
 * resetting someone's dashboard.
 */
export function normaliseLayout(raw: unknown): LayoutItem[] | null {
  let list = raw;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;

  const seen = new Set<string>();
  const out: LayoutItem[] = [];
  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : (entry as { id?: unknown })?.id;
    if (typeof id !== 'string' || !(id in DASHBOARD_WIDGETS) || seen.has(id)) continue;
    seen.add(id);
    const size = (entry as { size?: unknown })?.size;
    out.push({
      id,
      size: WIDGET_SIZES.includes(size as WidgetSize) ? size as WidgetSize : DASHBOARD_WIDGETS[id]!,
    });
  }
  return out;
}

/** The stored layout, or every widget in default order when nothing is saved. */
export function dashboardLayout(settings: Record<string, string>): LayoutItem[] {
  const stored = normaliseLayout(settings['dashboard_widgets']);
  if (stored && stored.length) return stored;
  return Object.entries(DASHBOARD_WIDGETS).map(([id, size]) => ({ id, size }));
}

export function parseShortcuts(raw: string | undefined): Shortcut[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter((s) => s && typeof s.url === 'string')
        .map((s) => ({ name: String(s.name ?? s.url), url: String(s.url) }))
      : [];
  } catch {
    return [];
  }
}
