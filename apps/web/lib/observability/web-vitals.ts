/**
 * Core Web Vitals metric names.
 */
export type VitalName = 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB' | 'FID';

/**
 * Rating categories for a metric value.
 */
export type VitalRating = 'good' | 'needs-improvement' | 'poor';

/**
 * A single observed sample of a web vital metric.
 */
export interface VitalSample {
  name: VitalName;
  value: number;
}

/**
 * Aggregated summary for a metric across multiple samples.
 */
export interface VitalSummary {
  name: VitalName;
  count: number;
  p75: number;
  rating: VitalRating;
}

/**
 * Threshold bounds for each metric.
 * good: value ≤ good => 'good'
 * poor: value > poor => 'poor'
 * otherwise => 'needs-improvement'
 */
export const THRESHOLDS = {
  LCP: { good: 2500, poor: 4000 },
  INP: { good: 200, poor: 500 },
  CLS: { good: 0.1, poor: 0.25 },
  FCP: { good: 1800, poor: 3000 },
  TTFB: { good: 800, poor: 1800 },
  FID: { good: 100, poor: 300 },
} as const satisfies Record<VitalName, { good: number; poor: number }>;

/**
 * Rates a single metric value against its Core Web Vitals thresholds.
 */
export function rateVital(name: VitalName, value: number): VitalRating {
  const threshold = THRESHOLDS[name];
  if (value <= threshold.good) {
    return 'good';
  }
  if (value > threshold.poor) {
    return 'poor';
  }
  return 'needs-improvement';
}

/**
 * Computes the p-th percentile using the nearest-rank method.
 * Does not mutate the input array.
 * @throws if values is empty or percentile is not in (0, 100]
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    throw new Error('Cannot compute percentile of empty array');
  }
  if (p <= 0 || p > 100) {
    throw new Error('Percentile must be in (0, 100]');
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  // values.length > 0 guarantees index is in bounds
  return sorted[index]!;
}

/**
 * Summarises an array of VitalSamples into one row per metric.
 * Filters out non-finite and negative values.
 * Orders rows as: LCP, INP, CLS, FCP, TTFB, FID.
 */
export function summariseVitals(samples: readonly VitalSample[]): VitalSummary[] {
  const metricOrder: VitalName[] = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB', 'FID'];
  const groups = new Map<VitalName, number[]>();

  for (const sample of samples) {
    const { name, value } = sample;
    if (!Number.isFinite(value) || value < 0) {
      continue;
    }
    const arr = groups.get(name) ?? [];
    arr.push(value);
    groups.set(name, arr);
  }

  const result: VitalSummary[] = [];
  for (const name of metricOrder) {
    const values = groups.get(name);
    if (!values || values.length === 0) {
      continue;
    }
    const p75 = percentile(values, 75);
    result.push({
      name,
      count: values.length,
      p75,
      rating: rateVital(name, p75),
    });
  }

  return result;
}

/**
 * Renders a markdown table from vital summaries.
 * Millisecond metrics are rounded to whole ms; CLS to 3 decimal places.
 */
export function toMarkdownTable(summaries: readonly VitalSummary[]): string {
  const header = '| Metric | p75 | Rating | Samples |';
  const separator = '| --- | --- | --- | --- |';

  if (summaries.length === 0) {
    return `${header}\n${separator}`;
  }

  const rows = summaries.map((s) => {
    const metric = s.name;
    const p75 = metric === 'CLS' ? s.p75.toFixed(3) : `${Math.round(s.p75)} ms`;
    return `| ${metric} | ${p75} | ${s.rating} | ${s.count} |`;
  });

  return [header, separator, ...rows].join('\n');
}
