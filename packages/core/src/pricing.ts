/**
 * The discount and the tax on what remains, for a quote or invoice priced
 * without the GST engine. The discount comes off the subtotal before tax
 * (as GST and most tax regimes require), so the line tax is scaled by the
 * share of the subtotal left after the discount. Amounts are rounded to
 * cents. Shared by the dashboard actions, the Next routes and the API so
 * all three store the same totals for the same document.
 */
export function applyDiscount(
  totals: { subtotal: number; taxTotal: number },
  discountType: string | null | undefined,
  discountValue: number | null | undefined
): { discountAmount: number; taxTotal: number; total: number } {
  const round = (value: number) => Math.round(value * 100) / 100;
  const { subtotal } = totals;
  const value = discountValue ?? 0;

  let discountAmount = 0;
  if (value > 0 && discountType === 'percentage') discountAmount = subtotal * (value / 100);
  else if (value > 0 && discountType === 'fixed') discountAmount = value;
  discountAmount = round(Math.max(0, Math.min(discountAmount, subtotal)));

  let taxTotal = totals.taxTotal;
  if (subtotal > 0 && discountAmount > 0) {
    taxTotal = taxTotal * ((subtotal - discountAmount) / subtotal);
  }
  taxTotal = round(taxTotal);

  return { discountAmount, taxTotal, total: round(subtotal - discountAmount + taxTotal) };
}
