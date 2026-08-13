import { describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import { nextSerialNumber, validateSerialNumber } from './numbering';
import { getFinancialYear } from './financial-year';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('GST numbering', () => {
  const base = createPrisma(url!);
  const db = withTenantGuard(base, { mode: 'throw' });

  it('increments serial numbers per financial year for GST workspaces', async () => {
    const workspace = await base.workspace.create({
      data: {
        name: 'GST Numbering',
        slug: `gst-num-${Date.now()}`,
        businessProfile: {
          create: { businessName: 'GST Co', gstin: '33AABCU9603R1ZX', currency: 'INR' },
        },
      },
    });

    const first = await nextSerialNumber(db, {
      workspaceId: workspace.id,
      type: 'invoice',
      prefix: 'INV',
    });
    const second = await nextSerialNumber(db, {
      workspaceId: workspace.id,
      type: 'invoice',
      prefix: 'INV',
    });

    expect(first.serialNumber).toMatch(/^INV\/\d{2}-\d{2}\/\d{4}$/);
    expect(second.serialNumber).toMatch(/^INV\/\d{2}-\d{2}\/\d{4}$/);
    expect(first.financialYear).toBe(getFinancialYear());
    expect(second.serialNumber).not.toBe(first.serialNumber);
  });

  it('uses a non-FY row for non-GST workspaces', async () => {
    const workspace = await base.workspace.create({
      data: {
        name: 'Non-GST Numbering',
        slug: `non-gst-num-${Date.now()}`,
        businessProfile: { create: { businessName: 'Non-GST Co', currency: 'USD' } },
      },
    });

    const result = await nextSerialNumber(db, {
      workspaceId: workspace.id,
      type: 'invoice',
      prefix: 'INV',
    });
    expect(result.financialYear).toBeNull();
  });

  it('rejects serial numbers over 16 characters', () => {
    expect(() => validateSerialNumber('A'.repeat(17))).toThrow();
    expect(() => validateSerialNumber('A'.repeat(16))).not.toThrow();
  });

  it('validates serial length before incrementing the sequence', async () => {
    const workspace = await base.workspace.create({
      data: {
        name: 'GST Numbering Validation',
        slug: `gst-num-val-${Date.now()}`,
        businessProfile: {
          create: { businessName: 'GST Co', gstin: '33AABCU9603R1ZX', currency: 'INR' },
        },
      },
    });

    await expect(
      nextSerialNumber(db, {
        workspaceId: workspace.id,
        type: 'invoice',
        prefix: 'VERY-LONG-PREFIX',
        padding: 10,
      })
    ).rejects.toThrow('Serial number exceeds 16 characters');

    // Sequence should not have been incremented: the next valid number is 1.
    const result = await nextSerialNumber(db, {
      workspaceId: workspace.id,
      type: 'invoice',
      prefix: 'INV',
    });
    expect(result.serialNumber).toBe(`INV/${getFinancialYear().slice(2)}/0001`);
  });
  it('hands out distinct numbers when the first numbers are requested at once', async () => {
    const workspace = await base.workspace.create({
      data: {
        name: 'GST Numbering Race',
        slug: `gst-num-race-${Date.now()}`,
        businessProfile: {
          create: { businessName: 'GST Co', gstin: '33AABCU9603R1ZX', currency: 'INR' },
        },
      },
    });

    // No sequence row exists yet: every call races to create it. Hold each
    // call after its first query on number_sequences until all have made it
    // (or 300 ms pass, for code that serialises them in the database).
    let arrived = 0;
    let release: () => void = () => {};
    const allArrived = new Promise<void>((resolve) => (release = resolve));
    const racy = db.$extends({
      query: {
        async $queryRaw({ args, query }) {
          const result = await query(args);
          if (++arrived === 8) release();
          await Promise.race([allArrived, new Promise((r) => setTimeout(r, 300))]);
          return result;
        },
      },
    }) as unknown as typeof db;

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        nextSerialNumber(racy, { workspaceId: workspace.id, type: 'invoice', prefix: 'INV' })
      )
    );

    expect(results.map((r) => r.serialNumber).sort()).toEqual(
      Array.from(
        { length: 8 },
        (_, i) => `INV/${getFinancialYear().slice(2)}/${String(i + 1).padStart(4, '0')}`
      )
    );
  });
});
