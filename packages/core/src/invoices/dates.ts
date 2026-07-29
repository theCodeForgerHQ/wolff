/**
 * Calendar-date helpers for scheduled invoice work. Dates are handled as
 * `YYYY-MM-DD` strings so that no time zone can shift them by a day.
 */
export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

const inBusinessZone = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's date where the business day is counted (`today(IST)`). */
export function businessDate(now: Date = new Date()): string {
  return inBusinessZone.format(now);
}

/** A `@db.Date` value from Prisma (midnight UTC) as `YYYY-MM-DD`. */
export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` as the Date Prisma expects for a `@db.Date` column. */
export function fromDateString(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((fromDateString(to).getTime() - fromDateString(from).getTime()) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  const d = fromDateString(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateString(d);
}

function addMonths(date: string, months: number): string {
  const d = fromDateString(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // Clamp to the month's last day: 31 Jan + 1 month is 28 Feb, not 3 Mar.
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return toDateString(d);
}

/** The next occurrence after `date`. Unknown intervals are treated as monthly. */
export function addInterval(date: string, interval: string): string {
  switch (interval) {
    case 'weekly':
      return addDays(date, 7);
    case 'biweekly':
      return addDays(date, 14);
    case 'quarterly':
      return addMonths(date, 3);
    case 'yearly':
      return addMonths(date, 12);
    default:
      return addMonths(date, 1);
  }
}

function isoWeek(date: string): { year: number; week: number } {
  const d = fromDateString(date);
  // Thursday of this week decides the ISO year.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return {
    year: d.getUTCFullYear(),
    week: Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7),
  };
}

/**
 * The period an occurrence on `date` belongs to: `2026-10` for month-based
 * intervals, `2026-W41` (ISO week) for week-based ones.
 */
export function periodKeyFor(date: string, interval: string): string {
  if (interval === 'weekly' || interval === 'biweekly') {
    const { year, week } = isoWeek(date);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }
  return date.slice(0, 7);
}
