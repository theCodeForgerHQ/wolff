import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { computeGst, determineSupplyType } from './engine';
import golden from './__fixtures__/golden.json';

function d(value: number | string): Decimal {
  return new Decimal(value);
}

describe('GST engine', () => {
  it.each(golden.cases)('$name', (c) => {
    const result = computeGst({
      supplierStateCode: c.supplierStateCode ?? undefined,
      placeOfSupply: c.placeOfSupply ?? undefined,
      isExport: c.isExport,
      isSez: c.isSez,
      hasLut: c.hasLut,
      reverseCharge: c.reverseCharge,
      lines: c.lines.map((l) => ({
        description: l.description,
        hsnSac: l.hsnSac,
        itemType: l.itemType as 'goods' | 'services',
        quantity: l.quantity,
        rate: l.rate,
        discount: 'discount' in l ? l.discount : undefined,
        gstRate: l.gstRate,
      })),
    });

    expect(result.supplyType).toBe(c.expected.supplyType);
    expect(result.taxableTotal.toNumber()).toBeCloseTo(c.expected.taxableTotal, 2);
    expect(result.cgstTotal.toNumber()).toBeCloseTo(c.expected.cgstTotal, 2);
    expect(result.sgstTotal.toNumber()).toBeCloseTo(c.expected.sgstTotal, 2);
    expect(result.igstTotal.toNumber()).toBeCloseTo(c.expected.igstTotal, 2);
    expect(result.total.toNumber()).toBeCloseTo(c.expected.total, 2);
    if (c.expected.hsnSummaryCount) {
      expect(result.hsnSummary).toHaveLength(c.expected.hsnSummaryCount);
    }
  });

  it('splits intra-state tax so cgst + sgst == igst for the same line', () => {
    const result = computeGst({
      supplierStateCode: '33',
      placeOfSupply: '33',
      lines: [{ description: 'X', itemType: 'services', quantity: 1, rate: 100.05, gstRate: 18 }],
    });
    const line = result.lines[0]!;
    expect(line.cgstAmount.plus(line.sgstAmount).toNumber()).toBeCloseTo(18.01, 2);
    expect(line.cgstAmount.plus(line.sgstAmount).toNumber()).toBe(
      line.taxableValue.mul(0.18).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber()
    );
  });

  it('matches the inter-state equivalent exactly', () => {
    const intra = computeGst({
      supplierStateCode: '33',
      placeOfSupply: '33',
      lines: [{ description: 'X', itemType: 'services', quantity: 1, rate: 100.05, gstRate: 18 }],
    });
    const inter = computeGst({
      supplierStateCode: '33',
      placeOfSupply: '29',
      lines: [{ description: 'X', itemType: 'services', quantity: 1, rate: 100.05, gstRate: 18 }],
    });
    expect(intra.total.toNumber()).toBe(inter.total.toNumber());
    expect(inter.lines[0]!.igstAmount.toNumber()).toBeCloseTo(18.01, 2);
  });

  it('zeroes tax for export with LUT', () => {
    const result = computeGst({
      supplierStateCode: '33',
      isExport: true,
      hasLut: true,
      lines: [{ description: 'X', itemType: 'services', quantity: 1, rate: 100000, gstRate: 18 }],
    });
    expect(result.taxTotal.toNumber()).toBe(0);
    expect(result.total.toNumber()).toBe(100000);
  });

  it('determines supply type correctly', () => {
    expect(determineSupplyType({ supplierStateCode: '33', placeOfSupply: '33' })).toBe('intra');
    expect(determineSupplyType({ supplierStateCode: '33', placeOfSupply: '29' })).toBe('inter');
    expect(determineSupplyType({ supplierStateCode: '33', isExport: true })).toBe('export');
    expect(determineSupplyType({ supplierStateCode: '33', isSez: true })).toBe('sez');
    expect(determineSupplyType({ supplierStateCode: '33' })).toBe('inter');
  });

  it('property: cgst + sgst == igst for the same intra-state line', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 100000 }),
        fc.integer({ min: 0, max: 28 }),
        (qty, rate, gstRate) => {
          const result = computeGst({
            supplierStateCode: '33',
            placeOfSupply: '33',
            lines: [
              {
                description: 'Property',
                itemType: 'services',
                quantity: qty,
                rate,
                gstRate,
              },
            ],
          });
          const line = result.lines[0]!;
          const intraTax = line.cgstAmount.plus(line.sgstAmount);
          const inter = computeGst({
            supplierStateCode: '33',
            placeOfSupply: '29',
            lines: [
              {
                description: 'Property',
                itemType: 'services',
                quantity: qty,
                rate,
                gstRate,
              },
            ],
          });
          expect(intraTax.toNumber()).toBeCloseTo(inter.lines[0]!.igstAmount.toNumber(), 2);
          expect(line.cgstAmount.plus(line.sgstAmount).toNumber()).toBeCloseTo(
            line.taxableValue
              .mul(gstRate)
              .div(100)
              .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
              .toNumber(),
            2
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('property: totals are sums of rounded line amounts', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 100 }),
            rate: fc.integer({ min: 1, max: 10000 }),
            gstRate: fc.integer({ min: 0, max: 28 }),
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (lines) => {
          const result = computeGst({
            supplierStateCode: '33',
            placeOfSupply: '33',
            lines: lines.map((l, i) => ({
              description: `Line ${i}`,
              itemType: 'services' as const,
              quantity: l.qty,
              rate: l.rate,
              gstRate: l.gstRate,
            })),
          });
          const expectedTaxable = result.lines.reduce(
            (acc, line) => acc.plus(line.taxableValue),
            d(0)
          );
          const expectedTotal = result.lines.reduce((acc, line) => acc.plus(line.total), d(0));
          expect(result.taxableTotal.toNumber()).toBeCloseTo(expectedTaxable.toNumber(), 2);
          expect(result.total.toNumber()).toBeCloseTo(expectedTotal.toNumber(), 2);
        }
      ),
      { numRuns: 100 }
    );
  });
});
