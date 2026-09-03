import { convertToBase, type ExchangeRateSource } from '@/lib/currency/exchange-rates';
import type { PipelineStageSummary } from './types';

interface PipelineDealRow {
  stageId: string;
  stageName: string;
  stagePosition: number;
  value: number;
  currency: string;
}

/**
 * One row per stage with its deal count and total value. Each deal's value
 * is converted to the base currency first, like every other dashboard
 * total: adding rupees to dollars as they are gives a number in neither.
 * A deal in a currency with no rate counts as a deal but adds nothing.
 */
export function summarisePipelineStages(
  rows: readonly PipelineDealRow[],
  baseCurrency: string,
  rates: Record<string, number>
): PipelineStageSummary[] {
  const stages = new Map<string, PipelineStageSummary>();
  for (const row of rows) {
    const value = convertToBase(row.value, row.currency, baseCurrency, rates);
    const stage = stages.get(row.stageId);
    stages.set(row.stageId, {
      stageId: row.stageId,
      stageName: row.stageName,
      position: row.stagePosition,
      dealCount: (stage?.dealCount ?? 0) + 1,
      totalValue: (stage?.totalValue ?? 0) + value,
      currency: baseCurrency,
    });
  }
  return [...stages.values()].sort((a, b) => a.position - b.position);
}

const RATE_WORDING: Record<ExchangeRateSource, string> = {
  live: 'current exchange rates',
  stale: 'the last exchange rates fetched',
  fallback: 'fallback exchange rates (fixed, approximate)',
};

function listOf(currencies: readonly string[]): string {
  return currencies.length === 1
    ? currencies[0]!
    : `${currencies.slice(0, -1).join(', ')} and ${currencies.at(-1)}`;
}

/**
 * The line under the dashboard's totals that says what currency they are
 * in, which other currencies were converted and at what rates, and which
 * were left out because there is no rate for them.
 */
export function currencyCaption(
  baseCurrency: string,
  currencies: readonly string[],
  {
    unconvertible = [],
    source = 'live',
  }: { unconvertible?: readonly string[]; source?: ExchangeRateSource } = {}
): string {
  const others = [...new Set(currencies)].filter((c) => c !== baseCurrency).sort();
  const leftOut = others.filter((c) => unconvertible.includes(c));
  const converted = others.filter((c) => !unconvertible.includes(c));
  const parts = [`Amounts in ${baseCurrency}`];
  if (converted.length > 0) {
    parts.push(`${listOf(converted)} amounts are converted at ${RATE_WORDING[source]}`);
  }
  if (leftOut.length > 0) {
    parts.push(`${listOf(leftOut)} amounts are left out of the totals: no exchange rate`);
  }
  return parts.length === 1 ? parts[0]! : `${parts.join('. ')}.`;
}
