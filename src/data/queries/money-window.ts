/**
 * inphub lite: the period selector shared by Money and Insights.
 *
 * money_period_range() / money_window() from lib/helpers.php. The name is
 * historical, the maths is generic, which is why Insights uses the same
 * vocabulary rather than inventing a second one.
 *
 * Windows are whole calendar months and both bounds are inclusive, which is
 * exact because spent_at is a date with no time. 'all' returns null bounds and
 * the caller drops the range test entirely.
 *
 * The gotcha, carried over verbatim: never shift a month off *today*. PHP used
 * the relative-text forms ("first day of last month") because
 * date('Y-m-01', strtotime('-1 month')) overflows on the 29th to the 31st; on
 * 2026-03-31 it gives March again instead of February. monthBounds() in
 * dates.ts builds from day 1 of the target month, which cannot overflow.
 */

import { localDate, monthBounds } from '../dates.ts';
import { str } from '../normalize.ts';

export const MONEY_PERIODS = ['month', 'last_month', '3m', '6m', 'year', 'all'] as const;
export type MoneyPeriod = (typeof MONEY_PERIODS)[number];

export interface MoneyWindow {
  period: MoneyPeriod;
  /** 'YYYY-MM-DD', or null for 'all'. */
  from: string | null;
  to: string | null;
  label: string;
}

export function isMoneyPeriod(v: unknown): v is MoneyPeriod {
  return typeof v === 'string' && (MONEY_PERIODS as readonly string[]).includes(v);
}

export function moneyPeriodRange(period: MoneyPeriod, ref: Date = new Date()): Omit<MoneyWindow, 'period'> {
  const thisMonth = monthBounds(0, ref);
  switch (period) {
    case 'last_month': {
      const m = monthBounds(-1, ref);
      return { from: m.from, to: m.to, label: 'Last month' };
    }
    case '3m':
      return { from: monthBounds(-2, ref).from, to: thisMonth.to, label: 'Last 3 months' };
    case '6m':
      return { from: monthBounds(-5, ref).from, to: thisMonth.to, label: 'Last 6 months' };
    case 'year':
      return {
        from: localDate(new Date(ref.getFullYear(), 0, 1)),
        to: localDate(new Date(ref.getFullYear(), 11, 31)),
        label: 'This year',
      };
    case 'all':
      return { from: null, to: null, label: 'All time' };
    case 'month':
    default:
      return { from: thisMonth.from, to: thisMonth.to, label: 'This month' };
  }
}

/** The legacy month=YYYY-MM param, still honoured. Null when it is not a month. */
export function moneyMonthRange(month: string): Omit<MoneyWindow, 'period'> | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [y, m] = month.split('-').map(Number);
  const ref = new Date(y!, m! - 1, 1);
  const bounds = monthBounds(0, ref);
  return {
    from: bounds.from,
    to: bounds.to,
    label: ref.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  };
}

/**
 * What window a request is asking for. `period` wins, the legacy `month=YYYY-MM`
 * is honoured when no period is given, and anything unrecognised falls back.
 *
 * The default differs by caller and that is deliberate: the Money view opens on
 * 'month', but the expense list defaults to 'all' so an unparameterised fetch
 * returns everything rather than silently hiding last month's rows.
 */
export function moneyWindow(input: Record<string, unknown>, fallback: MoneyPeriod = 'month'): MoneyWindow {
  const period = str(input['period']);
  if (period !== null) {
    const key = isMoneyPeriod(period) ? period : fallback;
    return { period: key, ...moneyPeriodRange(key) };
  }
  const month = str(input['month']);
  if (month !== null) {
    const range = moneyMonthRange(month);
    if (range !== null) return { period: fallback, ...range };
  }
  return { period: fallback, ...moneyPeriodRange(fallback) };
}
