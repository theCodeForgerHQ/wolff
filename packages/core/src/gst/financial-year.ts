/**
 * Indian financial year helpers. The FY starts on 1 April and is named by
 * the calendar years it spans ("2026-27").
 */

const INDIA_TZ = 'Asia/Kolkata';

function formatFY(startYear: number): string {
  const endYear = (startYear + 1) % 100;
  return `${startYear}-${String(endYear).padStart(2, '0')}`;
}

/**
 * Returns the Indian financial-year string for a date. Defaults to now.
 */
export function getFinancialYear(date?: Date): string {
  const d = date ?? new Date();
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: INDIA_TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(d);

  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const startYear = month >= 4 ? year : year - 1;
  return formatFY(startYear);
}

/**
 * True if `date` falls in the given financial-year string.
 */
export function isInFinancialYear(date: Date, fy: string): boolean {
  return getFinancialYear(date) === fy;
}
