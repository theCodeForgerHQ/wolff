import type { Prisma } from '@wolff/database';
import type { CoreContext } from '../context';
import { CoreError } from '../errors';
import { allocateSerialNumber } from '../gst/numbering';
import { requestAiIndexing } from '../outbox';

/**
 * A quote proposed by the AI quote agent. It is created as a
 * draft only, acting as the user who asked for it; the user reviews and
 * saves it in the builder.
 */
export interface DraftQuoteLine {
  name: string;
  description?: string | null;
  quantity: number;
  unit?: string | null;
  rate: number;
  hsnSac?: string | null;
  gstRate?: number | null;
  source: 'rate_card' | 'past_quote' | 'new';
  sourceRef?: string | null;
}

export interface DraftQuoteInput {
  clientId: string;
  dealId?: string | null;
  title: string;
  currency: string;
  lineItems: DraftQuoteLine[];
  terms?: string | null;
  notes?: string | null;
  assumptions?: string[];
}

export const MAX_DRAFT_LINES = 50;
const MAX_AMOUNT = 1e10;

function invalid(field: string, message: string): never {
  throw new CoreError('validation_error', message, { [field]: [message] });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function checkLines(lines: DraftQuoteLine[]): void {
  if (lines.length === 0 || lines.length > MAX_DRAFT_LINES) {
    invalid('lineItems', `A draft needs 1 to ${MAX_DRAFT_LINES} lines`);
  }
  lines.forEach((line, i) => {
    if (!line.name?.trim()) invalid(`lineItems.${i}.name`, 'Each line needs a name');
    if (!Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > 1e6) {
      invalid(`lineItems.${i}.quantity`, 'Quantity must be a positive number');
    }
    if (!Number.isFinite(line.rate) || line.rate < 0 || line.rate > MAX_AMOUNT) {
      invalid(`lineItems.${i}.rate`, 'Rate must be zero or a positive number');
    }
    if (
      line.gstRate != null &&
      (!Number.isFinite(line.gstRate) || line.gstRate < 0 || line.gstRate > 28)
    ) {
      invalid(`lineItems.${i}.gstRate`, 'GST rate must be between 0 and 28');
    }
  });
}

/**
 * Creates the draft in one transaction: checks that the client, the deal and
 * every referenced rate card belong to the workspace, numbers the quote,
 * links the deal, records a `created` event and asks for AI indexing.
 * Anything wrong throws before a row is written.
 */
export async function createDraftQuote(
  ctx: CoreContext,
  input: DraftQuoteInput
): Promise<{ quoteId: string; quoteNumber: string }> {
  const { db, workspaceId, actorId } = ctx;
  if (!/^[A-Z]{3}$/.test(input.currency)) invalid('currency', 'Currency must be an ISO code');
  if (!input.title?.trim()) invalid('title', 'A draft needs a title');
  checkLines(input.lineItems);

  return db.$transaction(async (tx) => {
    const client = await tx.client.findFirst({
      where: { id: input.clientId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!client) throw new CoreError('not_found', 'Client not found');

    if (input.dealId) {
      const deal = await tx.deal.findFirst({
        where: { id: input.dealId, workspaceId, deletedAt: null },
        select: { id: true, quoteId: true },
      });
      if (!deal) throw new CoreError('not_found', 'Deal not found');
      if (deal.quoteId) throw new CoreError('conflict', 'Deal already has a quote');
    }

    const cardIds = [
      ...new Set(
        input.lineItems
          .filter((l) => l.source === 'rate_card' && l.sourceRef)
          .map((l) => l.sourceRef!)
      ),
    ];
    if (cardIds.length) {
      const found = await tx.rateCard.count({
        where: { id: { in: cardIds }, workspaceId, deletedAt: null },
      });
      if (found !== cardIds.length) {
        invalid('lineItems', 'A line refers to a rate card that does not exist');
      }
    }

    const { serialNumber: quoteNumber } = await allocateSerialNumber(tx, {
      workspaceId,
      type: 'quote',
      prefix: 'QT',
      padding: 4,
    });

    const lines: Prisma.QuoteLineItemCreateWithoutQuoteInput[] = input.lineItems.map(
      (line, index) => ({
        name: line.name.trim().slice(0, 200),
        description: line.description?.slice(0, 2000) || null,
        quantity: line.quantity,
        rate: line.rate,
        amount: round2(line.quantity * line.rate),
        hsnSac: line.hsnSac?.slice(0, 8) || null,
        gstRate: line.gstRate ?? null,
        sortOrder: index,
        ...(line.source === 'rate_card' && line.sourceRef
          ? { rateCard: { connect: { id: line.sourceRef } } }
          : {}),
      })
    );
    const subtotal = round2(lines.reduce((sum, l) => sum + Number(l.amount), 0));
    const assumptions = (input.assumptions ?? []).filter((a) => a.trim());

    const quote = await tx.quote.create({
      data: {
        workspaceId,
        clientId: client.id,
        quoteNumber,
        title: input.title.trim().slice(0, 300),
        status: 'draft',
        currency: input.currency,
        expirationDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        subtotal,
        taxTotal: 0,
        total: subtotal,
        terms: input.terms || null,
        notes: input.notes || null,
        internalNotes: assumptions.length
          ? `Drafted by the AI assistant. Assumptions:\n- ${assumptions.join('\n- ')}`
          : 'Drafted by the AI assistant.',
        lineItems: { create: lines },
      },
      select: { id: true },
    });
    await tx.quoteEvent.create({
      data: {
        quoteId: quote.id,
        eventType: 'created',
        actorId: actorId ?? null,
        metadata: { by: 'ai' },
      },
    });
    if (input.dealId) {
      await tx.deal.update({
        where: { id: input.dealId, workspaceId },
        data: { quoteId: quote.id },
      });
    }
    await requestAiIndexing(tx, { workspaceId, sourceType: 'quote', sourceId: quote.id });
    return { quoteId: quote.id, quoteNumber };
  });
}
