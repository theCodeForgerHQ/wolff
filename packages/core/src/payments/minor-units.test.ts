import { describe, expect, it } from 'vitest';
import { currencyExponent, fromMinorUnits, toMinorUnits } from './minor-units';

describe('minor units', () => {
  it.each([
    ['usd', 2],
    ['INR', 2],
    ['jpy', 0],
    ['KRW', 0],
    ['vnd', 0],
    ['kwd', 3],
    ['BHD', 3],
  ] as const)('%s has %i decimals', (currency, exponent) => {
    expect(currencyExponent(currency)).toBe(exponent);
  });

  it('charges a 5000 JPY invoice as 5000, not 500000', () => {
    expect(toMinorUnits(5000, 'jpy')).toBe(5000);
    expect(fromMinorUnits(5000, 'jpy')).toBe(5000);
  });

  it('charges 12.345 KWD as 12345 fils', () => {
    expect(toMinorUnits(12.345, 'kwd')).toBe(12345);
    expect(fromMinorUnits(12345, 'kwd')).toBe(12.345);
  });

  it('keeps cents exact for two-decimal currencies', () => {
    expect(toMinorUnits(19.99, 'usd')).toBe(1999);
    expect(toMinorUnits(1.005, 'usd')).toBe(101);
    expect(fromMinorUnits(1999, 'usd')).toBe(19.99);
  });
});
