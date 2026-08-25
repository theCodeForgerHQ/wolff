// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Sending or issuing an invoice or a quote asks for its PDF: a `pdf.render`
 * outbox event written with the status change, on every path that sends
 * (dashboard actions and the public API). Nothing rendered PDFs before;
 * they existed only when a job was published by hand. Real Postgres.
 */
const url = process.env.TEST_DATABASE_URL;

vi.mock('@wolff/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wolff/database')>();
  return { ...actual, prisma: actual.createPrisma(process.env.TEST_DATABASE_URL) };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const workspaceContext = vi.hoisted(() => ({ workspaceId: '', userId: '', role: 'owner' }));
vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: vi.fn(async () => workspaceContext),
}));
vi.mock('@/lib/email/actions', () => ({
  sendTemplatedEmail: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('@/lib/api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/auth')>()),
  authenticateApiRequest: vi.fn(async () => ({
    context: { workspaceId: workspaceContext.workspaceId },
  })),
}));
vi.mock('@/lib/services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/email')>()),
  sendInvoiceSentEmail: vi.fn().mockResolvedValue({ success: true }),
  sendQuoteSentEmail: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('@/lib/notifications/internal', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from 'next/server';
import { prisma } from '@wolff/database';
import { createInvoice } from '@/lib/invoices/actions';
import { sendInvoice, updateInvoiceStatus } from '@/lib/invoices/status-actions';
import { sendQuote } from '@/lib/quotes/actions';
import { POST as postSendInvoice } from '@/app/api/v1/invoices/[id]/send/route';
import { POST as postSendQuote } from '@/app/api/v1/quotes/[id]/send/route';

describe.skipIf(!url)('a PDF is requested when a document is sent (Postgres)', () => {
  const run = randomUUID().slice(0, 8);
  let clientId = '';
  let n = 0;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `pdf-owner-${run}@example.test`, name: 'Owner' },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: 'PDF on send',
        slug: `pdf-send-${run}`,
        ownerId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
        clients: { create: { name: 'Acme', email: `acme-${run}@example.test` } },
      },
      include: { clients: true },
    });
    Object.assign(workspaceContext, { workspaceId: workspace.id, userId: user.id });
    clientId = workspace.clients[0]!.id;
  });

  afterAll(async () => {
    const { workspaceId, userId } = workspaceContext;
    await prisma.outboxEvent.deleteMany({ where: { workspaceId } });
    await prisma.invoiceEvent.deleteMany({ where: { invoice: { workspaceId } } });
    await prisma.invoice.deleteMany({ where: { workspaceId } });
    await prisma.quoteEvent.deleteMany({ where: { quote: { workspaceId } } });
    await prisma.quote.deleteMany({ where: { workspaceId } });
    await prisma.numberSequence.deleteMany({ where: { workspaceId } });
    await prisma.client.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const pdfRequests = (documentId: string) =>
    prisma.outboxEvent.findMany({
      where: {
        workspaceId: workspaceContext.workspaceId,
        type: 'pdf.render',
        aggregateId: documentId,
      },
    });

  const draftInvoice = async () =>
    prisma.invoice.create({
      data: {
        workspaceId: workspaceContext.workspaceId,
        clientId,
        invoiceNumber: `PDF-${run}-${++n}`,
        dueDate: new Date('2026-12-01'),
        subtotal: 100,
        total: 100,
        amountDue: 100,
        accessToken: randomBytes(16).toString('hex'),
      },
    });

  const draftQuote = async () =>
    prisma.quote.create({
      data: {
        workspaceId: workspaceContext.workspaceId,
        clientId,
        quoteNumber: `PQ-${run}-${++n}`,
        subtotal: 100,
        total: 100,
        accessToken: randomBytes(16).toString('hex'),
      },
    });

  const expectOneRequest = async (documentType: 'invoice' | 'quote', documentId: string) => {
    const rows = await pdfRequests(documentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      aggregateType: documentType,
      payload: { documentType, documentId },
      status: 'pending',
    });
  };

  it('sending an invoice from the dashboard requests its PDF once', async () => {
    const invoice = await draftInvoice();

    expect((await sendInvoice(invoice.id)).success).toBe(true);
    // Sending again (a reminder resend) does not change the document.
    expect((await sendInvoice(invoice.id)).success).toBe(true);

    await expectOneRequest('invoice', invoice.id);
  });

  it('marking an invoice sent requests its PDF', async () => {
    const invoice = await draftInvoice();

    expect((await updateInvoiceStatus(invoice.id, 'sent')).success).toBe(true);

    await expectOneRequest('invoice', invoice.id);
  });

  it('creating an invoice as sent requests its PDF; a draft does not', async () => {
    const line = { name: 'Logo', quantity: 1, rate: 100 };
    const sent = await createInvoice({
      clientId,
      title: 'Sent',
      dueDate: '2026-12-01',
      isDraft: false,
      lineItems: [line],
    } as never);
    const draft = await createInvoice({
      clientId,
      title: 'Draft',
      dueDate: '2026-12-01',
      lineItems: [line],
    } as never);

    await expectOneRequest('invoice', sent.invoice!.id);
    expect(await pdfRequests(draft.invoice!.id)).toHaveLength(0);
  });

  it('sending an invoice through the API requests its PDF', async () => {
    const invoice = await draftInvoice();
    const request = new NextRequest('http://localhost/api/v1/invoices/x/send', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });

    const response = await postSendInvoice(request, {
      params: Promise.resolve({ id: invoice.id }),
    });

    expect(response.status).toBe(200);
    await expectOneRequest('invoice', invoice.id);
  });

  it('sending a quote from the dashboard and through the API requests its PDF', async () => {
    const fromDashboard = await draftQuote();
    const fromApi = await draftQuote();

    expect((await sendQuote(fromDashboard.id)).success).toBe(true);
    const request = new NextRequest('http://localhost/api/v1/quotes/x/send', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    const response = await postSendQuote(request, { params: Promise.resolve({ id: fromApi.id }) });

    expect(response.status).toBe(200);
    await expectOneRequest('quote', fromDashboard.id);
    await expectOneRequest('quote', fromApi.id);
  });
});
