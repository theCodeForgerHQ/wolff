import { describe, expect, it } from 'vitest';
import { addInterval, businessDate, daysBetween, periodKeyFor } from './dates';

describe('businessDate', () => {
  it('is the calendar date in India, not in UTC', () => {
    // 19:00 UTC on 30 Sep is 00:30 on 1 Oct in Asia/Kolkata.
    expect(businessDate(new Date('2026-09-30T19:00:00Z'))).toBe('2026-10-01');
    expect(businessDate(new Date('2026-09-30T18:29:59Z'))).toBe('2026-09-30');
    expect(businessDate(new Date('2026-09-30T18:30:00Z'))).toBe('2026-10-01');
  });
});

describe('periodKeyFor', () => {
  it.each([
    ['monthly', '2026-10-15', '2026-10'],
    ['quarterly', '2026-10-15', '2026-10'],
    ['yearly', '2026-01-01', '2026-01'],
    ['weekly', '2026-10-05', '2026-W41'],
    ['biweekly', '2026-10-11', '2026-W41'],
    // ISO weeks: 1 Jan 2027 is a Friday and belongs to week 53 of 2026.
    ['weekly', '2027-01-01', '2026-W53'],
    ['weekly', '2024-12-30', '2025-W01'],
  ])('%s on %s is %s', (interval, date, key) => {
    expect(periodKeyFor(date, interval)).toBe(key);
    expect(key.length).toBeLessThanOrEqual(10);
  });
});

describe('addInterval', () => {
  it.each([
    ['weekly', '2026-10-01', '2026-10-08'],
    ['biweekly', '2026-10-01', '2026-10-15'],
    ['monthly', '2026-10-01', '2026-11-01'],
    ['quarterly', '2026-11-30', '2027-02-28'],
    ['yearly', '2024-02-29', '2025-02-28'],
    ['monthly', '2026-01-31', '2026-02-28'],
    ['unknown', '2026-10-01', '2026-11-01'],
  ])('%s after %s is %s', (interval, from, next) => {
    expect(addInterval(from, interval)).toBe(next);
  });
});

describe('daysBetween', () => {
  it('counts whole days between two dates', () => {
    expect(daysBetween('2026-10-01', '2026-10-08')).toBe(7);
    expect(daysBetween('2026-10-08', '2026-10-01')).toBe(-7);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });
});
