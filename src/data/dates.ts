/**
 * inphub lite: every date and time string in the app is built here.
 *
 * Don't use toISOString() anywhere. inphub kept timestamps in MySQL TIMESTAMP
 * columns and read them back in server-local time, and two things lean on that:
 * Insights' hours-of-the-day chart is HOUR(activity_log.created_at), and every
 * "is it today" test is PHP's date('Y-m-d'). Store UTC instead and every bucket
 * shifts by your offset. The chart still draws, it's just wrong, and you find
 * out weeks later.
 *
 * So local wall clock, no Z and no offset. That costs one duplicated or missing
 * hour a year at a DST change, which is fine here. It also keeps 'YYYY-MM-DD'
 * and 'YYYY-MM-DDTHH:mm:ss' sorting chronologically as plain strings, which is
 * what lets IDBKeyRange.bound() work on the spent_at and created_at indexes.
 *
 * inphub's ui.ts already had localDate() and localDateTime() for the same
 * reason. This is the same rule, applied to storage as well as display.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' in local time. */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DDTHH:mm:ss' in local time. */
export function localDateTime(d: Date = new Date()): string {
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Today as 'YYYY-MM-DD', local. */
export function today(): string {
  return localDate();
}

/** Now as 'YYYY-MM-DDTHH:mm:ss', local. */
export function now(): string {
  return localDateTime();
}

/** 'YYYY-MM' for the month a date falls in. */
export function monthKey(d: Date | string = new Date()): string {
  return (typeof d === 'string' ? d : localDate(d)).slice(0, 7);
}

/* ------------------------------------------------------------- arithmetic */

/** Parse 'YYYY-MM-DD' as a LOCAL midnight Date. `new Date('2026-09-20')` is UTC. */
export function parseDate(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** Parse a stored datetime as a local Date. Also accepts MySQL's space form. */
export function parseDateTime(s: string): Date {
  const [datePart, timePart = '00:00:00'] = s.replace(' ', 'T').split('T');
  const [y, m, d] = (datePart ?? '').split('-').map(Number);
  const [hh, mm, ss] = timePart.split(':').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, ss ?? 0);
}

/** Shift a 'YYYY-MM-DD' by whole days. */
export function addDays(s: string, days: number): string {
  const d = parseDate(s);
  d.setDate(d.getDate() + days);
  return localDate(d);
}

/**
 * Shift a 'YYYY-MM-DD' by whole months, keeping PHP's strtotime('+1 month')
 * overflow: 2026-01-31 +1 month is 2026-03-03, not 2026-02-28. inphub's
 * recurring to-dos behave that way and the two must agree.
 */
export function addMonths(s: string, months: number): string {
  const d = parseDate(s);
  d.setMonth(d.getMonth() + months);
  return localDate(d);
}

/** Whole days from `a` to `b`, both 'YYYY-MM-DD'. Negative when b precedes a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000);
}

/**
 * First and last day of a month, `delta` months from `ref`.
 *
 * This is the shape inphub's money_period_range() uses, and the reason it never
 * subtracts months from *today*: date('Y-m-01', strtotime('-1 month')) overflows
 * on the 29th to the 31st, so "last month" on 31 March lands in March. Building
 * from day 1 of the target month cannot overflow.
 */
export function monthBounds(delta: number, ref: Date = new Date()): { from: string; to: string } {
  const y = ref.getFullYear();
  const m = ref.getMonth() + delta;
  return { from: localDate(new Date(y, m, 1)), to: localDate(new Date(y, m + 1, 0)) };
}

/* ----------------------------------------------------------- ISO weeks */

/** The Monday of the ISO week a date falls in, as 'YYYY-MM-DD'. */
export function isoWeekStart(s: string): string {
  const d = parseDate(s);
  // getDay() is Sunday-first; MySQL's WEEKDAY() and ISO weeks are Monday-first.
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDate(d);
}

/**
 * ISO week key 'YYYY-Www' (PHP's date('o-W')), where the year is the ISO year,
 * which can differ from the calendar year in late December and early January.
 */
export function isoWeekKey(s: string): string {
  const d = parseDate(isoWeekStart(s));
  // The ISO year is the year of that week's Thursday.
  d.setDate(d.getDate() + 3);
  const thursday = new Date(d);
  const jan4 = new Date(thursday.getFullYear(), 0, 4);
  const firstMonday = parseDate(isoWeekStart(localDate(jan4)));
  const week = Math.round(daysBetween(localDate(firstMonday), localDate(thursday)) / 7) + 1;
  return `${thursday.getFullYear()}-${pad(week)}`;
}

/** Shift an ISO week key by whole weeks (PHP's shift_week()). */
export function shiftWeek(key: string, delta: number): string {
  const [y, w] = key.split('-').map(Number);
  const jan4 = new Date(y ?? 1970, 0, 4);
  const firstMonday = isoWeekStart(localDate(jan4));
  return isoWeekKey(addDays(firstMonday, ((w ?? 1) - 1 + delta) * 7));
}

/** MySQL WEEKDAY(): 0 = Monday … 6 = Sunday. JS getDay() is Sunday-first. */
export function weekdayIndex(s: string): number {
  return (parseDate(s).getDay() + 6) % 7;
}
