/**
 * inphub lite: coercing loose input into a valid record.
 *
 * One definition of "a valid Todo", used by the create path, the update path and
 * the importer alike. That sharing is the point. An inphub export comes out of
 * PDO with EMULATE_PREPARES off, which hands back DECIMAL and often INT columns
 * as strings, so a legacy file says "amount": "42.50" and "pinned": "1" and
 * "id": "17". None of that throws if you let it through, it just renders wrong
 * in one chart a few weeks later.
 */

/** Trim to a string, or null when there is nothing left. PHP's str_or_null(). */
export function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** A required string with a fallback, for columns that are NOT NULL. */
export function text(value: unknown, fallback = ''): string {
  return str(value) ?? fallback;
}

export function int(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Money: a number at 2dp. MySQL DECIMAL(12,2) arrived here as a string. */
export function money(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : fallback;
}

export function moneyOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** TINYINT(1) semantics, so the string "1" and the number 1 both mean yes. */
export function bool(value: unknown, fallback: 0 | 1 = 0): 0 | 1 {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') return value === '0' || value === '' ? 0 : 1;
  return value ? 1 : 0;
}

/** PHP's valid_enum(): the value if it is in the list, otherwise the default. */
export function enumOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const s = typeof value === 'string' ? value : String(value ?? '');
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

/** Clamp an integer into a range, as PHP's clamp_int() did for limits. */
export function clampInt(value: unknown, min: number, max: number, fallback = min): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * A stored date, or null. Accepts a full datetime and keeps only the date part,
 * which is what happens when a DATE column is fed a DATETIME.
 */
export function dateOrNull(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1]! : null;
}

/**
 * A stored datetime, normalised to 'YYYY-MM-DDTHH:mm:ss'.
 *
 * MySQL writes '2026-09-20 21:39:12' with a space, and mixing the two forms in
 * one store breaks the created_at index outright: a space is 0x20 and a T is
 * 0x54, so every space-form row sorts before every T-form row no matter what
 * the date says, and the History feed silently reorders itself.
 */
export function dateTimeOrNull(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(s);
  if (m) return `${m[1]}T${m[2]}`;
  const d = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
  return d ? `${d[1]}T00:00:00` : null;
}

/** MySQL's JSON column comes back from PDO as a string. */
export function json(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** A hex colour, or the fallback. Guards against junk reaching an inline style. */
export function color(value: unknown, fallback: string): string {
  const s = str(value);
  return s && /^#[0-9a-f]{6}$/i.test(s) ? s : fallback;
}
