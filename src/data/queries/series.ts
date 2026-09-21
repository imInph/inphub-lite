/**
 * inphub lite: bucketing and zero-filling a time series.
 *
 * expense_series_fill() from api/stats.php and insights_fill() from
 * api/insights.php are the same algorithm with a different value key, so they
 * are one function here.
 *
 * The filling is what makes a chart draw a timeline instead of a list of days
 * that happened to have data. Two details are easy to lose and both change what
 * the chart says:
 *
 * It fills to whichever is LATER, today or the newest entry, then caps at the
 * window end. spent_at accepts future dates (post-dated rent), and a series that
 * stopped at today would draw a line disagreeing with the totals printed above it.
 *
 * Month iteration walks from day 1 of each month. Stepping a month off an
 * arbitrary date overflows (31 Jan + 1 month is 3 March, which dates.ts keeps on
 * purpose for recurring todos), and that would skip or double a bucket here.
 */

import { addDays, localDate, monthKey } from '../dates.ts';

export type Granularity = 'day' | 'month';

/**
 * Daily buckets for short windows, monthly once a point per day is unreadable.
 * 'all' (an unbounded window) is always monthly.
 */
export function granularityFor(from: string | null, to: string | null): Granularity {
  if (from === null || to === null) return 'month';
  const spanDays = Math.floor(
    (Date.parse(`${to}T00:00:00`) - Date.parse(`${from}T00:00:00`)) / 86_400_000) + 1;
  return spanDays <= 62 ? 'day' : 'month';
}

/** The bucket a date falls in: the date itself, or its 'YYYY-MM'. */
export function bucketOf(date: string, granularity: Granularity): string {
  return granularity === 'month' ? monthKey(date) : date.slice(0, 10);
}

/**
 * Zero-fill `map` across the window.
 *
 * `valueKey` is 'total' for the spending series and 'value' for the Insights
 * ones, matching what each chart already reads.
 */
export function fillSeries<K extends string>(
  map: Map<string, number>,
  granularity: Granularity,
  from: string | null,
  to: string | null,
  valueKey: K,
  ref: Date = new Date(),
): Array<{ d: string } & Record<K, number>> {
  const keys = [...map.keys()];
  if (from === null && keys.length === 0) return [];

  const monthly = granularity === 'month';
  const todayKey = monthly ? monthKey(localDate(ref)) : localDate(ref);

  // Lexicographic order is chronological for both key shapes, which is the
  // whole reason dates are stored as strings (see dates.ts).
  let start = from !== null
    ? (monthly ? from.slice(0, 7) : from)
    : keys.reduce((a, b) => (a < b ? a : b));

  let end = todayKey;
  if (keys.length) {
    const newest = keys.reduce((a, b) => (a > b ? a : b));
    if (newest > end) end = newest;
  }
  if (to !== null) {
    const cap = monthly ? to.slice(0, 7) : to;
    if (end > cap) end = cap;
  }
  if (end < start) end = start;

  const out: Array<{ d: string } & Record<K, number>> = [];
  if (monthly) {
    const [sy, sm] = start.split('-').map(Number);
    const [ey, em] = end.split('-').map(Number);
    let y = sy!;
    let m = sm!;
    // Guarded on the key itself rather than a month count, so a malformed
    // bound can never spin here.
    while (y < ey! || (y === ey! && m <= em!)) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      out.push({ d: key, [valueKey]: map.get(key) ?? 0 } as { d: string } & Record<K, number>);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  } else {
    for (let cur = start; cur <= end; cur = addDays(cur, 1)) {
      out.push({ d: cur, [valueKey]: map.get(cur) ?? 0 } as { d: string } & Record<K, number>);
    }
  }
  return out;
}
