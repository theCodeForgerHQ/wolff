// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The body of a quote, invoice or contract email names the business from the
 * business profile, the same name as the subject. It used to name the
 * workspace ("Demo Workspace") under a subject naming the business
 * ("Acme Design Studio"). Real Postgres.
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
const sendTemplatedEmail = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));
vi.mock('@/lib/email/actions', () => ({ sendTemplatedEmail }));
vi.mock('@/lib/notifications/internal', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '@wolff/database';
import { sendInvoice } from '@/lib/invoices/status-actions';
import { sendQuote } from '@/lib/quotes/actions';

describe.skipIf(!url)('emails name the business, not the workspace (Postgres)', () => {
  const run = randomUUID().slice(0, 8);
  let clientId = '';

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `sender-${run}@example.test`, name: 'Owner' },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Demo Workspace',
        slug: `sender-${run}`,
        ownerId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
        clients: { create: { name: 'Acme', email: `acme-${run}@example.test` } },
        businessProfile: { create: { businessName: 'Acme Design Studio' } },
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
    await prisma.client.deleteMany({ where: { workspaceId } });
    await prisma.businessProfile.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const lastBusinessName = () =>
    (sendTemplatedEmail.mock.calls.at(-1)![0] as { variables: { businessName: string } }).variables
      .businessName;

  it('a sent quote', async () => {
    const quote = await prisma.quote.create({
      data: {
        workspaceId: workspaceContext.workspaceId,
        clientId,
        quoteNumber: `SQ-${run}`,
        subtotal: 100,
        total: 100,
        accessToken: randomBytes(16).toString('hex'),
      },
    });

    expect((await sendQuote(quote.id)).success).toBe(true);
    expect(lastBusinessName()).toBe('Acme Design Studio');
  });

  it('a sent invoice', async () => {
    const invoice = await prisma.invoice.create({
      data: {
        workspaceId: workspaceContext.workspaceId,
        clientId,
        invoiceNumber: `SI-${run}`,
        dueDate: new Date('2026-12-01'),
        subtotal: 100,
        total: 100,
        amountDue: 100,
        accessToken: randomBytes(16).toString('hex'),
      },
    });

    expect((await sendInvoice(invoice.id)).success).toBe(true);
    expect(lastBusinessName()).toBe('Acme Design Studio');
  });
});
