import { toMinorUnits } from '@wolff/core/payments';

/** A partial refund must name a real, positive amount. */
export function isValidRefundAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount > 0;
}

/**
 * Converts a refund amount in major units to Stripe's minor units of the
 * payment's currency (cents for USD, whole yen for JPY).
 *
 * `undefined`, and only `undefined`, means a full refund. Testing the amount
 * for truthiness instead would also treat 0 and NaN as "no amount" and refund
 * the whole payment.
 */
export function toRefundMinorUnits(
  amount: number | undefined,
  currency: string
): number | undefined {
  if (amount === undefined) return undefined;
  if (!isValidRefundAmount(amount)) {
    throw new RangeError('Refund amount must be a finite number greater than zero');
  }
  return toMinorUnits(amount, currency);
}
