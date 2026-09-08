import { describe, expect, it } from 'vitest';
import { applyDiscount } from './pricing';

describe('applyDiscount', () => {
  it('taxes the discounted amount, not the full subtotal', () => {
    // 1000 at 18%, 10% off: tax is 18% of 900, not of 1000.
    expect(applyDiscount({ subtotal: 1000, taxTotal: 180 }, 'percentage', 10)).toEqual({
      discountAmount: 100,
      taxTotal: 162,
      total: 1062,
    });
  });

  it('scales the tax by a fixed discount too', () => {
    expect(applyDiscount({ subtotal: 400, taxTotal: 40 }, 'fixed', 100)).toEqual({
      discountAmount: 100,
      taxTotal: 30,
      total: 330,
    });
  });

  it('caps the discount at the subtotal', () => {
    expect(applyDiscount({ subtotal: 50, taxTotal: 5 }, 'fixed', 80)).toEqual({
      discountAmount: 50,
      taxTotal: 0,
      total: 0,
    });
  });

  it('leaves the totals alone without a discount', () => {
    expect(applyDiscount({ subtotal: 99.99, taxTotal: 9.99 }, null, 0)).toEqual({
      discountAmount: 0,
      taxTotal: 9.99,
      total: 109.98,
    });
  });
});
