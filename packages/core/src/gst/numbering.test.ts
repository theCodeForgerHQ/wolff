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

    expect(first.serialNumber).toMatch(/^INV-\d{4}$/);
    expect(second.serialNumber).toMatch(/^INV-\d{4}$/);
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
});
