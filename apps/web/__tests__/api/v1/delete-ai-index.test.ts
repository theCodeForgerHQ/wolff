import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockPrisma } = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), update: vi.fn() });
  const mockPrisma: Record<string, any> = {
    quote: model(),
    invoice: model(),
    client: model(),
    outboxEvent: { create: vi.fn().mockResolvedValue({ id: 'evt-1' }) },
    $transaction: vi.fn((fn: any) => fn(mockPrisma)),
  };
  return { mockPrisma };
});

vi.mock('@wolff/database', () => ({
  prisma: mockPrisma,
  withTenantGuard: vi.fn(),
  Prisma: {},
}));
vi.mock('@/lib/api/auth', () => ({
  authenticateApiRequest: vi.fn(async () => ({ context: { workspaceId: 'ws-1' } })),
  apiSuccess: (data: unknown) => Response.json({ success: true, data }),
  apiError: (message: string, status: number) =>
    Response.json({ success: false, error: message }, { status }),
}));

import { DELETE as deleteQuote } from '@/app/api/v1/quotes/[id]/route';
import { DELETE as deleteInvoice } from '@/app/api/v1/invoices/[id]/route';
import { DELETE as deleteClient } from '@/app/api/v1/clients/[id]/route';

const request = () => new NextRequest('http://localhost/api/v1/x', { method: 'DELETE' });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('DELETE /api/v1/{quotes,invoices,clients}/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['quote', 'quote', deleteQuote],
    ['invoice', 'invoice', deleteInvoice],
    ['client', 'client_note', deleteClient],
  ] as const)(
    'soft-deletes a %s and asks the AI service to drop it',
    async (model, kind, handler) => {
      mockPrisma[model].findFirst.mockResolvedValue({ id: 'doc-1', status: 'draft' });

      const response = await handler(request(), params('doc-1'));

      expect(response.status).toBe(200);
      expect(mockPrisma[model].update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { deletedAt: expect.any(Date) } })
      );
      expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: 'ws-1',
          type: 'ai.index',
          payload: { sourceType: kind, sourceId: 'doc-1' },
        }),
        select: { id: true },
      });
    }
  );

  it('emits nothing when the document is not in the workspace', async () => {
    mockPrisma.quote.findFirst.mockResolvedValue(null);

    const response = await deleteQuote(request(), params('elsewhere'));

    expect(response.status).toBe(404);
    expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
  });
});
