import { describe, expect, it } from 'vitest';
import { currencyCaption, summarisePipelineStages } from '@/lib/dashboard/currency-summary';

// Per USD, as getExchangeRates returns them.
const rates = { USD: 1, INR: 80, EUR: 0.8 };

const row = (stageId: string, position: number, value: number, currency: string) => ({
  stageId,
  stageName: stageId,
  stagePosition: position,
  value,
  currency,
});

describe('summarisePipelineStages', () => {
  it('converts each deal to the base currency before adding a stage up', () => {
    const stages = summarisePipelineStages(
      [row('lead', 1, 8000, 'INR'), row('lead', 1, 100, 'USD'), row('won', 2, 100, 'EUR')],
      'INR',
      rates
    );

    expect(stages).toEqual([
      {
        stageId: 'lead',
        stageName: 'lead',
        position: 1,
        dealCount: 2,
        totalValue: 16000,
        currency: 'INR',
      },
      {
        stageId: 'won',
        stageName: 'won',
        position: 2,
        dealCount: 1,
        totalValue: 10000,
        currency: 'INR',
      },
    ]);
  });

  it('orders stages by position', () => {
    const stages = summarisePipelineStages(
      [row('b', 2, 1, 'USD'), row('a', 1, 1, 'USD')],
      'USD',
      rates
    );

    expect(stages.map((s) => s.stageId)).toEqual(['a', 'b']);
  });
});

describe('currencyCaption', () => {
  it('names the base currency when every document is in it', () => {
    expect(currencyCaption('INR', ['INR'])).toBe('Amounts in INR');
    expect(currencyCaption('INR', [])).toBe('Amounts in INR');
  });

  it('says which currencies were converted, and that the rates are current ones', () => {
    expect(currencyCaption('INR', ['USD', 'INR', 'EUR'])).toBe(
      'Amounts in INR. EUR and USD amounts are converted at current exchange rates.'
    );
    expect(currencyCaption('USD', ['GBP', 'USD'])).toBe(
      'Amounts in USD. GBP amounts are converted at current exchange rates.'
    );
  });
});
