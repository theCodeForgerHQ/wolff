import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import {
  getGstOutwardSupplies,
  getPipelineStageTransitions,
  getReceivablesAgeing,
  getRevenueMonthly,
} from './index';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('reports from SQL views (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().replace(/-/g, '');
  let workspaceId = '';
  let clientId = '';
  let invoiceId = '';
  let dealId = '';

  beforeAll(async () => {
    const workspace = await base.workspace.create({
      data: {
        name: 'Reports',
        slug: `reports-${run}`,
        clients: { create: { name: 'Client', email: `client-${run}@example.test` } },
        businessProfile: { create: { businessName: 'Reports Co', currency: 'INR' } },
      },
      include: { clients: true },
    });
    workspaceId = workspace.id;
    clientId = workspace.clients[0]!.id;

    const invoice = await base.invoice.create({
      data: {
        workspaceId,
        clientId,
        invoiceNumber: `INV-${run}`,
        status: 'sent',
        issueDate: new Date('2026-09-01'),
        dueDate: new Date('2026-09-15'),
        subtotal: 100,
        taxTotal: 18,
        total: 118,
        amountDue: 118,
        currency: 'INR',
        supplyType: 'intra',
        supplierGstin: '33AABCU9603R1ZX',
        lineItems: {
          create: {
            name: 'Design',
            description: 'Design work',
            quantity: 1,
            rate: 100,
            amount: 100,
            taxableValue: 100,
            gstRate: 18,
            cgstRate: 9,
            cgstAmount: 9,
            sgstRate: 9,
            sgstAmount: 9,
            igstAmount: 0,
          },
        },
      },
    });
    invoiceId = invoice.id;

    await base.payment.create({
      data: {
        workspaceId,
        invoiceId,
        amount: 118,
        currency: 'INR',
        paymentMethod: 'upi',
        status: 'completed',
        provider: 'razorpay',
        processedAt: new Date('2026-09-20'),
      },
    });

    const pipeline = await base.pipeline.create({
      data: { workspaceId, name: 'Sales', isDefault: true },
    });
    const stage = await base.stage.create({
      data: {
        workspaceId,
        pipelineId: pipeline.id,
        name: 'Proposal',
        position: 1,
        probability: 50,
      },
    });
    const deal = await base.deal.create({
      data: {
        workspaceId,
        pipelineId: pipeline.id,
        stageId: stage.id,
        clientId,
        title: 'Big Project',
        value: 5000,
        currency: 'INR',
      },
    });
    dealId = deal.id;
  });

  afterAll(async () => {
    await base.dealActivity.deleteMany({ where: { workspaceId } });
    await base.deal.deleteMany({ where: { workspaceId } });
    await base.stage.deleteMany({ where: { workspaceId } });
    await base.pipeline.deleteMany({ where: { workspaceId } });
    await base.payment.deleteMany({ where: { workspaceId } });
    await base.invoiceLineItem.deleteMany({ where: { invoice: { workspaceId } } });
    await base.invoice.deleteMany({ where: { workspaceId } });
    await base.businessProfile.deleteMany({ where: { workspaceId } });
    await base.client.deleteMany({ where: { workspaceId } });
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  it('returns receivables ageing for outstanding invoices', async () => {
    const rows = await getReceivablesAgeing(db, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      invoiceId,
      invoiceNumber: `INV-${run}`,
      amountDue: 118,
      dueDate: expect.any(String),
      bucket: expect.stringMatching(/^bucket_/),
    });
  });

  it('returns monthly revenue from completed payments', async () => {
    const rows = await getRevenueMonthly(db, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      currency: 'INR',
      revenue: 118,
      paymentCount: 1,
    });
  });

  it('returns GST outward supplies', async () => {
    const rows = await getGstOutwardSupplies(db, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      invoiceId,
      supplyType: 'intra',
      taxableValue: 100,
      cgstAmount: 9,
      sgstAmount: 9,
      igstAmount: 0,
    });
  });

  it('returns pipeline stage transitions', async () => {
    const rows = await getPipelineStageTransitions(db, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dealId,
      title: 'Big Project',
      value: 5000,
      stageName: 'Proposal',
      probability: 50,
    });
  });
});
