import { convertToBase } from '@/lib/currency/exchange-rates';
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

/**
 * The line under the dashboard's totals that says what currency they are
 * in and, when documents use other currencies, that those were converted.
 */
export function currencyCaption(baseCurrency: string, currencies: readonly string[]): string {
  const others = [...new Set(currencies)].filter((c) => c !== baseCurrency).sort();
  if (others.length === 0) return `Amounts in ${baseCurrency}`;
  const list =
    others.length === 1 ? others[0] : `${others.slice(0, -1).join(', ')} and ${others.at(-1)}`;
  return `Amounts in ${baseCurrency}. ${list} amounts are converted at current exchange rates.`;
}
