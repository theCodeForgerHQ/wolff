import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Per USD, as getExchangeRates returns them.
const rates = { USD: 1, INR: 80, EUR: 0.8 };

describe('convertToBase', () => {
  it('converts through USD', async () => {
    const { convertToBase } = await import('@/lib/currency/exchange-rates');
    expect(convertToBase(100, 'USD', 'INR', rates)).toBe(8000);
    expect(convertToBase(80, 'EUR', 'USD', rates)).toBe(100);
  });

  it('leaves out an amount whose currency has no rate instead of adding it unconverted', async () => {
    const { convertToBase } = await import('@/lib/currency/exchange-rates');
    expect(convertToBase(500, 'XYZ', 'INR', rates)).toBe(0);
    expect(convertToBase(500, 'USD', 'XYZ', rates)).toBe(0);
  });

  it('returns an amount already in the base currency as it is, even without rates', async () => {
    const { convertToBase } = await import('@/lib/currency/exchange-rates');
    expect(convertToBase(500, 'XYZ', 'XYZ', {})).toBe(500);
  });
});

describe('canConvert', () => {
  it('needs a rate for both currencies unless they are the same', async () => {
    const { canConvert } = await import('@/lib/currency/exchange-rates');
    expect(canConvert('EUR', 'INR', rates)).toBe(true);
    expect(canConvert('XYZ', 'INR', rates)).toBe(false);
    expect(canConvert('XYZ', 'XYZ', rates)).toBe(true);
  });
});

describe('getExchangeRatesWithSource', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says the rates are live when the rates service answered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: 'success', rates: { USD: 1, INR: 84 } }))
    );
    const { getExchangeRatesWithSource } = await import('@/lib/currency/exchange-rates');

    expect(await getExchangeRatesWithSource()).toEqual({
      rates: { USD: 1, INR: 84 },
      source: 'live',
    });
  });

  it('says the rates are the fallback ones when the service is down and nothing was fetched before', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    const { getExchangeRatesWithSource } = await import('@/lib/currency/exchange-rates');

    const result = await getExchangeRatesWithSource();
    expect(result.source).toBe('fallback');
    expect(result.rates.USD).toBe(1);
  });
});
