const MINOR_UNITS_PER_MAJOR = 100;

/** A partial refund must name a real, positive amount. */
export function isValidRefundAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount > 0;
}

/**
 * Converts a refund amount in major units (dollars) to Stripe's minor units.
 *
 * `undefined`, and only `undefined`, means a full refund. Testing the amount
 * for truthiness instead would also treat 0 and NaN as "no amount" and refund
 * the whole payment.
 */
export function toRefundMinorUnits(amount: number | undefined): number | undefined {
  if (amount === undefined) return undefined;
  if (!isValidRefundAmount(amount)) {
    throw new RangeError('Refund amount must be a finite number greater than zero');
  }
  return Math.round(amount * MINOR_UNITS_PER_MAJOR);
}
