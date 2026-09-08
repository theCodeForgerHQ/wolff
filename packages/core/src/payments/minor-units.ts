/**
 * Converting between stored amounts (major units, e.g. 12.50 USD) and the
 * integer "smallest unit" the providers charge in. The factor is not always
 * 100: Stripe's zero-decimal currencies (JPY, KRW, VND...) are charged in
 * whole units, and BHD, JOD, KWD, OMR and TND have three decimals.
 * See https://docs.stripe.com/currencies#zero-decimal.
 */

const ZERO_DECIMAL = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

/** Decimal places of the currency's smallest unit (0, 2 or 3). */
export function currencyExponent(currency: string): 0 | 2 | 3 {
  const code = currency.toLowerCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** Major units to the provider's integer smallest unit. */
export function toMinorUnits(amount: number, currency: string): number {
  const factor = 10 ** currencyExponent(currency);
  // toPrecision drops float noise such as 19.99 * 100 = 1998.9999999999998.
  return Math.round(parseFloat((amount * factor).toPrecision(12)));
}

/** The provider's integer smallest unit back to major units. */
export function fromMinorUnits(minor: number, currency: string): number {
  const exponent = currencyExponent(currency);
  return parseFloat((minor / 10 ** exponent).toFixed(exponent));
}
