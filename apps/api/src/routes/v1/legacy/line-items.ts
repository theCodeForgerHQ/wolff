/** A line item as the quote and invoice routes accept it. */
export interface LineItemInput {
  name: string;
  description?: string;
  quantity: number;
  rate: number;
  taxRate?: number;
  hsnSac?: string;
  itemType?: 'goods' | 'services';
}

export const MAX_LINE_ITEMS = 100;
/** `lineItems` that is not a list made the Next routes throw (500). */
export const LINE_ITEMS_NOT_A_LIST = 'lineItems must be a list';
const MAX_VALUE = 1_000_000;

/**
 * The Next routes checked line items in three slightly different ways, and
 * clients may rely on the exact messages, so each is kept:
 * - `quote-create` (POST /quotes): name, finite, one "cannot be negative"
 *   message, bounds, tax rate 0 to 100;
 * - `quote-update` (PATCH /quotes/:id): no name check, separate negative
 *   messages, tax rate only finite;
 * - `invoice` (POST and PATCH /invoices): name check, separate negative
 *   messages, tax rate only finite.
 * Returns the first problem's message, or null.
 */
export function lineItemProblem(
  items: Iterable<LineItemInput>,
  variant: 'quote-create' | 'quote-update' | 'invoice'
): string | null {
  for (const item of items) {
    // Not an object (null, a number): the Next routes threw on it (500).
    if (typeof item !== 'object' || item === null) {
      return variant === 'quote-update'
        ? 'Line item quantity and rate must be valid numbers'
        : 'Line item name is required';
    }
    if (variant !== 'quote-update') {
      if (!item.name || typeof item.name !== 'string' || !item.name.trim()) {
        return 'Line item name is required';
      }
    } else if (typeof item.name !== 'string') {
      // The Next route did not check the name here; Prisma refused (500).
      return 'Line item name is required';
    }
    const wrongType = lineItemTypeProblem(item as unknown as Record<string, unknown>, variant);
    if (wrongType) return wrongType;
    if (!Number.isFinite(item.quantity) || !Number.isFinite(item.rate)) {
      return 'Line item quantity and rate must be valid numbers';
    }
    if (variant === 'quote-create') {
      if (item.quantity < 0 || item.rate < 0) {
        return 'Line item quantity and rate cannot be negative';
      }
    } else {
      if (item.quantity < 0) return 'Line item quantity cannot be negative';
      if (item.rate < 0) return 'Line item rate cannot be negative';
    }
    if (item.quantity > MAX_VALUE) return 'Line item quantity must be at most 1,000,000';
    if (item.rate > MAX_VALUE) return 'Line item rate must be at most 1,000,000';
    if (variant === 'quote-create') {
      if (
        item.taxRate !== undefined &&
        (!Number.isFinite(item.taxRate) || item.taxRate < 0 || item.taxRate > 100)
      ) {
        return 'Tax rate must be between 0 and 100';
      }
    } else if (
      item.taxRate !== undefined &&
      item.taxRate !== null &&
      !Number.isFinite(item.taxRate)
    ) {
      return 'Line item taxRate must be a valid number';
    }
  }
  return null;
}

/** A line's optional text fields with a JSON type their columns cannot take. */
function lineItemTypeProblem(
  item: Record<string, unknown>,
  variant: 'quote-create' | 'quote-update' | 'invoice'
): string | null {
  const text = (field: string) => {
    const value = item[field];
    return value === undefined || value === null || typeof value === 'string';
  };
  if (!text('description')) return 'Line item description must be a string';
  // Only invoices keep the GST fields.
  if (variant === 'invoice') {
    if (!text('hsnSac')) return 'Line item hsnSac must be a string';
    if (item.itemType !== undefined && item.itemType !== 'goods' && item.itemType !== 'services') {
      return "Line item itemType must be 'goods' or 'services'";
    }
  }
  return null;
}

/** Amount and tax per line, rounded to cents per line, and the running totals. */
export function priceLines(items: LineItemInput[]) {
  let subtotal = 0;
  let taxTotal = 0;
  const lines = items.map((item, i) => {
    const amount = Math.round(item.quantity * item.rate * 100) / 100;
    const taxAmount = item.taxRate ? Math.round(amount * (item.taxRate / 100) * 100) / 100 : 0;
    subtotal += amount;
    taxTotal += taxAmount;
    return {
      name: item.name,
      description: item.description || null,
      quantity: item.quantity,
      rate: item.rate,
      amount,
      taxRate: item.taxRate,
      taxAmount,
      sortOrder: i,
    };
  });
  return { lines, subtotal, taxTotal };
}

/** The discount kept on a document when its lines are replaced. */
export function recomputeDiscount(
  subtotal: number,
  discountType: string | null,
  discountValue: number
): number {
  if (discountType === 'percentage' && discountValue > 0) {
    return Math.round(subtotal * (discountValue / 100) * 100) / 100;
  }
  if (discountType === 'fixed' && discountValue > 0) return Math.min(discountValue, subtotal);
  return 0;
}
