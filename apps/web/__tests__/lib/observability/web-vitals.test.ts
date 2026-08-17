import { describe, it, expect } from 'vitest';
import {
  percentile,
  rateVital,
  summariseVitals,
  toMarkdownTable,
  type VitalSample,
} from '@/lib/observability/web-vitals';

describe('rateVital', () => {
  it('uses the Core Web Vitals thresholds, inclusive of the good bound', () => {
    expect(rateVital('LCP', 2500)).toBe('good');
    expect(rateVital('LCP', 2501)).toBe('needs-improvement');
    expect(rateVital('LCP', 4000)).toBe('needs-improvement');
    expect(rateVital('LCP', 4001)).toBe('poor');
    expect(rateVital('INP', 200)).toBe('good');
    expect(rateVital('INP', 500)).toBe('needs-improvement');
    expect(rateVital('INP', 501)).toBe('poor');
    expect(rateVital('CLS', 0.1)).toBe('good');
    expect(rateVital('CLS', 0.25)).toBe('needs-improvement');
    expect(rateVital('CLS', 0.26)).toBe('poor');
    expect(rateVital('FCP', 1800)).toBe('good');
    expect(rateVital('FCP', 3001)).toBe('poor');
    expect(rateVital('TTFB', 800)).toBe('good');
    expect(rateVital('TTFB', 1801)).toBe('poor');
    expect(rateVital('FID', 100)).toBe('good');
    expect(rateVital('FID', 301)).toBe('poor');
  });
});

describe('percentile', () => {
  it('uses the nearest-rank method on unsorted input without mutating it', () => {
    const values = [40, 10, 30, 20];
    expect(percentile(values, 75)).toBe(30);
    expect(percentile(values, 100)).toBe(40);
    expect(percentile(values, 1)).toBe(10);
    expect(values).toEqual([40, 10, 30, 20]);
  });

  it('returns the only value for a single sample', () => {
    expect(percentile([7], 75)).toBe(7);
  });

  it('throws on an empty list or a percentile outside (0, 100]', () => {
    expect(() => percentile([], 75)).toThrow();
    expect(() => percentile([1], 0)).toThrow();
    expect(() => percentile([1], 101)).toThrow();
  });
});

describe('summariseVitals', () => {
  const samples: VitalSample[] = [
    { name: 'LCP', value: 1000 },
    { name: 'LCP', value: 3000 },
    { name: 'LCP', value: 2000 },
    { name: 'LCP', value: 5000 },
    { name: 'CLS', value: 0.01 },
    { name: 'INP', value: Number.NaN },
    { name: 'INP', value: -5 },
  ];

  it('gives one row per metric with count, p75 and the p75 rating, in a fixed order', () => {
    expect(summariseVitals(samples)).toEqual([
      { name: 'LCP', count: 4, p75: 3000, rating: 'needs-improvement' },
      { name: 'CLS', count: 1, p75: 0.01, rating: 'good' },
    ]);
  });

  it('drops non-finite and negative values, and metrics left with no samples', () => {
    const rows = summariseVitals(samples);
    expect(rows.find((r) => r.name === 'INP')).toBeUndefined();
  });

  it('orders rows LCP, INP, CLS, FCP, TTFB, FID', () => {
    const rows = summariseVitals([
      { name: 'FID', value: 1 },
      { name: 'TTFB', value: 1 },
      { name: 'FCP', value: 1 },
      { name: 'CLS', value: 0 },
      { name: 'INP', value: 1 },
      { name: 'LCP', value: 1 },
    ]);
    expect(rows.map((r) => r.name)).toEqual(['LCP', 'INP', 'CLS', 'FCP', 'TTFB', 'FID']);
  });
});

describe('toMarkdownTable', () => {
  it('renders ms metrics as whole milliseconds and CLS to three decimals', () => {
    const table = toMarkdownTable([
      { name: 'LCP', count: 4, p75: 2999.6, rating: 'needs-improvement' },
      { name: 'CLS', count: 1, p75: 0.01, rating: 'good' },
    ]);
    expect(table).toBe(
      [
        '| Metric | p75 | Rating | Samples |',
        '| --- | --- | --- | --- |',
        '| LCP | 3000 ms | needs-improvement | 4 |',
        '| CLS | 0.010 | good | 1 |',
      ].join('\n')
    );
  });

  it('renders a header-only table for no rows', () => {
    expect(toMarkdownTable([])).toBe(
      '| Metric | p75 | Rating | Samples |\n| --- | --- | --- | --- |'
    );
  });
});
