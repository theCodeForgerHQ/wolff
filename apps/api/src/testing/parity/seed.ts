import { LEGACY_KEY_SCOPES } from '@wolff/contracts';
import { hashApiKey } from '@wolff/core/auth/api-keys';
import type { PrismaClient } from '@wolff/database';

/**
 * The fixed data the `/v1` parity suite runs against. The recorder seeds it
 * before replaying the scenario on the Next routes, and the parity test seeds
 * it before replaying the same scenario on the Express routes, so both start
 * from the same rows. Ids are fixed (and kept by the normalizer); timestamps
 * are fixed in 2025 so list order (newest first) is stable.
 */
const ID_PREFIX = '00000000-0000-4000-8000-';
export const PARITY_ID_PATTERN = /^00000000-0000-4000-8000-\d{12}$/;

const id = (n: number) => `${ID_PREFIX}${String(n).padStart(12, '0')}`;

export const PARITY = {
  workspace: id(1),
  otherWorkspace: id(2),
  gstWorkspace: id(3),
  /** Keys with LEGACY_KEY_SCOPES: every scope but webhooks:manage, as existing keys were backfilled. */
  key: 'qc_sk_parity0000000000000000000000000001',
  gstKey: 'qc_sk_parity0000000000000000000000000003',
  clients: { acme: id(11), bharat: id(12), deleted: id(13), noEmail: id(14), other: id(15) },
  gstClient: id(16),
  quotes: { draft: id(21), sent: id(22), accepted: id(23), empty: id(24), other: id(25) },
  invoices: { draft: id(31), sent: id(32), paid: id(33), empty: id(34), other: id(35) },
  gstInvoiceDraft: id(36),
} as const;

const at = (day: number) => new Date(Date.UTC(2025, 0, day, 10, 0, 0));
const WORKSPACES = [PARITY.workspace, PARITY.otherWorkspace, PARITY.gstWorkspace];

/** Removes everything the seed and a scenario run created. */
export async function clearParityData(db: PrismaClient): Promise<void> {
  const where = { workspaceId: { in: WORKSPACES } };
  await db.outboxEvent.deleteMany({ where });
  await db.idempotencyKey.deleteMany({ where });
  await db.payment.deleteMany({ where });
  await db.invoiceEvent.deleteMany({ where: { invoice: where } });
  await db.quoteEvent.deleteMany({ where: { quote: where } });
  await db.invoice.deleteMany({ where });
  await db.quote.deleteMany({ where });
  await db.client.deleteMany({ where });
  await db.workspace.deleteMany({ where: { id: { in: WORKSPACES } } });
}

const line = (name: string, quantity: number, rate: number, sortOrder: number) => ({
  name,
  description: `${name} work`,
  quantity,
  rate,
  amount: quantity * rate,
  taxRate: 18,
  taxAmount: Math.round(quantity * rate * 18) / 100,
  sortOrder,
});

export async function seedParityData(db: PrismaClient): Promise<void> {
  await clearParityData(db);

  await db.workspace.create({
    data: {
      id: PARITY.workspace,
      name: 'Parity Studio',
      slug: 'parity-studio',
      businessProfile: { create: { businessName: 'Parity Studio', currency: 'INR' } },
      apiKeys: {
        create: {
          name: 'parity',
          keyHash: hashApiKey(PARITY.key),
          keyPrefix: PARITY.key.slice(0, 10),
          scopes: [...LEGACY_KEY_SCOPES],
          rateLimitPerMin: 100_000,
        },
      },
    },
  });
  await db.workspace.create({
    data: { id: PARITY.otherWorkspace, name: 'Other Studio', slug: 'parity-other' },
  });
  await db.workspace.create({
    data: {
      id: PARITY.gstWorkspace,
      name: 'Parity GST',
      slug: 'parity-gst',
      businessProfile: {
        create: {
          businessName: 'Parity GST Pvt Ltd',
          currency: 'INR',
          gstin: '29ABCDE1234F1Z5',
          stateCode: '29',
          gstRegistrationType: 'regular',
        },
      },
      apiKeys: {
        create: {
          name: 'parity-gst',
          keyHash: hashApiKey(PARITY.gstKey),
          keyPrefix: PARITY.gstKey.slice(0, 10),
          scopes: [...LEGACY_KEY_SCOPES],
          rateLimitPerMin: 100_000,
        },
      },
    },
  });

  const ws = PARITY.workspace;
  await db.client.createMany({
    data: [
      {
        id: PARITY.clients.acme,
        workspaceId: ws,
        name: 'Acme Works',
        email: 'acme@parity.test',
        company: 'Acme Works LLP',
        phone: '+91 80 1234 5678',
        address: { city: 'Bengaluru', country: 'IN' },
        metadata: { tier: 'gold' },
        createdAt: at(1),
        updatedAt: at(1),
      },
      {
        id: PARITY.clients.bharat,
        workspaceId: ws,
        name: 'Bharat Prints',
        email: 'bharat@parity.test',
        createdAt: at(2),
        updatedAt: at(2),
      },
      {
        id: PARITY.clients.deleted,
        workspaceId: ws,
        name: 'Gone Ltd',
        email: 'gone@parity.test',
        deletedAt: at(3),
        createdAt: at(3),
        updatedAt: at(3),
      },
      {
        id: PARITY.clients.noEmail,
        workspaceId: ws,
        name: 'Quiet Co',
        email: '',
        createdAt: at(4),
        updatedAt: at(4),
      },
      {
        id: PARITY.clients.other,
        workspaceId: PARITY.otherWorkspace,
        name: 'Elsewhere Inc',
        email: 'else@parity.test',
        createdAt: at(5),
        updatedAt: at(5),
      },
      {
        id: PARITY.gstClient,
        workspaceId: PARITY.gstWorkspace,
        name: 'Kaveri Traders',
        email: 'kaveri@parity.test',
        stateCode: '29',
        createdAt: at(6),
        updatedAt: at(6),
      },
    ],
  });

  const quote = (
    quoteId: string,
    n: number,
    status: string,
    lines: ReturnType<typeof line>[],
    extra: Record<string, unknown> = {}
  ) => {
    const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
    const taxTotal = lines.reduce((sum, l) => sum + l.taxAmount, 0);
    return db.quote.create({
      data: {
        id: quoteId,
        workspaceId: ws,
        clientId: PARITY.clients.acme,
        quoteNumber: `PQ-${n}`,
        title: `Parity quote ${n}`,
        status,
        currency: 'INR',
        subtotal,
        taxTotal,
        total: subtotal + taxTotal,
        accessToken: id(100 + n),
        issueDate: at(10 + n),
        createdAt: at(10 + n),
        updatedAt: at(10 + n),
        lineItems: { create: lines },
        ...extra,
      },
    });
  };
  await quote(PARITY.quotes.draft, 1, 'draft', [
    line('Design', 2, 2500, 0),
    line('Build', 1, 900, 1),
  ]);
  await quote(PARITY.quotes.sent, 2, 'sent', [line('Audit', 1, 4000, 0)], { sentAt: at(13) });
  await quote(PARITY.quotes.accepted, 3, 'accepted', [line('Retainer', 3, 1000, 0)], {
    acceptedAt: at(14),
    discountType: 'fixed',
    discountValue: 100,
    discountAmount: 100,
  });
  await quote(PARITY.quotes.empty, 4, 'draft', []);
  await db.quote.create({
    data: {
      id: PARITY.quotes.other,
      workspaceId: PARITY.otherWorkspace,
      clientId: PARITY.clients.other,
      quoteNumber: 'OQ-1',
      accessToken: id(199),
      createdAt: at(15),
      updatedAt: at(15),
    },
  });

  const invoice = (
    invoiceId: string,
    n: number,
    status: string,
    lines: ReturnType<typeof line>[],
    extra: Record<string, unknown> = {}
  ) => {
    const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
    const taxTotal = lines.reduce((sum, l) => sum + l.taxAmount, 0);
    const total = subtotal + taxTotal;
    return db.invoice.create({
      data: {
        id: invoiceId,
        workspaceId: ws,
        clientId: PARITY.clients.acme,
        invoiceNumber: `PINV-${n}`,
        title: `Parity invoice ${n}`,
        status,
        currency: 'INR',
        subtotal,
        taxTotal,
        total,
        amountDue: status === 'paid' ? 0 : total,
        amountPaid: status === 'paid' ? total : 0,
        accessToken: id(200 + n),
        issueDate: at(20 + n),
        dueDate: new Date('2025-03-01'),
        createdAt: at(20 + n),
        updatedAt: at(20 + n),
        lineItems: { create: lines },
        ...extra,
      },
    });
  };
  await invoice(PARITY.invoices.draft, 1, 'draft', [line('Design', 2, 2500, 0)], {
    notes: 'Thanks',
  });
  await invoice(PARITY.invoices.sent, 2, 'sent', [line('Audit', 1, 4000, 0)], { sentAt: at(23) });
  await invoice(PARITY.invoices.paid, 3, 'paid', [line('Retainer', 1, 1000, 0)], {
    sentAt: at(24),
    paidAt: at(24),
  });
  await invoice(PARITY.invoices.empty, 4, 'draft', []);
  await db.invoice.create({
    data: {
      id: PARITY.invoices.other,
      workspaceId: PARITY.otherWorkspace,
      clientId: PARITY.clients.other,
      invoiceNumber: 'OINV-1',
      accessToken: id(299),
      dueDate: new Date('2025-03-01'),
      createdAt: at(25),
      updatedAt: at(25),
    },
  });
  await db.invoice.create({
    data: {
      id: PARITY.gstInvoiceDraft,
      workspaceId: PARITY.gstWorkspace,
      clientId: PARITY.gstClient,
      invoiceNumber: 'GINV-1',
      title: 'GST draft',
      currency: 'INR',
      subtotal: 1000,
      total: 1000,
      amountDue: 1000,
      accessToken: id(298),
      dueDate: new Date('2025-03-01'),
      createdAt: at(26),
      updatedAt: at(26),
      lineItems: { create: [line('Consulting', 1, 1000, 0)] },
    },
  });
}
