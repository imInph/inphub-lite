/**
 * inphub lite: one case- and accent-insensitive fold, used on BOTH sides of
 * every text comparison in the app.
 *
 * inphub got this free from MySQL's utf8mb4_unicode_ci, and its CLAUDE.md
 * explicitly forbids re-filtering results client-side because JS gets Turkish
 * wrong. lite has no database, so the matching is JS whether we like it or not,
 * and this is the one place it happens.
 *
 * WHY NOT toLocaleLowerCase('tr'). That is the obvious reach and it is the
 * wrong tool. Turkish locale lowercasing preserves the dotted/dotless
 * distinction: I becomes ı and İ becomes i, so "ISTANBUL" would stop matching
 * "istanbul". utf8mb4_unicode_ci is not Turkish-aware at all, it strips
 * diacritics, which is why inphub matches İSTANBUL, ISTANBUL, istanbul and
 * ıstanbul to each other. Stripping is what this does, so the two agree.
 *
 * The order matters: lowercase first (İ decomposes to i + combining dot),
 * normalise to NFD so every accent becomes a separate combining mark, drop the
 * marks, then map the one Turkish letter that has no decomposition at all.
 */

/** ı (U+0131) has no combining mark to strip, so it needs saying outright. */
const DOTLESS_I = /ı/g;

export function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(DOTLESS_I, 'i');
}

/** Whether `haystack` contains `needle`, both folded. */
export function foldIncludes(haystack: string, needle: string): boolean {
  return fold(haystack).includes(fold(needle));
}

/** Whether `haystack` starts with `needle`, for the prefix boost in search. */
export function foldStartsWith(haystack: string, needle: string): boolean {
  return fold(haystack).startsWith(fold(needle));
}
