/**
 * inphub lite: the bits the dashboard bar and the command palette share.
 *
 * inphub's version also proxied Google's autocomplete through api/suggest.php,
 * because Google sends no CORS headers and a browser cannot call it directly.
 * There is no server to proxy through any more, so fetchSuggestions() and
 * suggestionHtml() are gone with it. What is left is the plain "search Google
 * for this" escape hatch, which never needed a server: it is a link.
 */

export type { SearchItem, SearchGroup } from '../data/queries/search.ts';
export { SEARCH_MIN_CHARS } from '../data/queries/search.ts';

/** Result type to the view it belongs to, used by both search surfaces. */
export const RESULT_VIEWS: Record<string, string> = {
  todo: 'todos',
  expense: 'expenses',
  note: 'notes',
  habit: 'habits',
  goal: 'goals',
  repo: 'repos',
};

export function googleUrl(q: string): string {
  return 'https://www.google.com/search?q=' + encodeURIComponent(q);
}

export function searchGoogle(q: string): void {
  // A new tab, not this one: navigating away would drop an offline-first app
  // for a search, and coming back would be a cold start.
  window.open(googleUrl(q), '_blank', 'noopener');
}

/** AbortError is a deliberate cancellation, not a failure to report. */
export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}
