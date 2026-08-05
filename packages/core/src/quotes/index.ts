import { CoreError } from '../errors';
import type { CoreContext } from '../context';
import { nextSerialNumber } from '../gst/numbering';

export interface CreateQuoteFromDealInput {
  dealId: string;
  title?: string;
  expirationDate?: Date;
}

export interface CreateQuoteFromDealResult {
  quoteId: string;
  quoteNumber: string;
}

/**
 * Creates a draft quote from a deal. The deal must belong to the workspace,
 * must not already be linked to a quote, and must have a client. The quote
 * number is generated from the workspace's quote sequence.
 */
export async function createQuoteFromDeal(
  ctx: CoreContext,
  input: CreateQuoteFromDealInput
): Promise<CreateQuoteFromDealResult> {
  const { db, workspaceId } = ctx;

  const deal = await db.deal.findFirst({
    where: { id: input.dealId, workspaceId, deletedAt: null },
    include: { client: { select: { id: true, name: true } } },
  });
  if (!deal) throw new CoreError('not_found', 'Deal not found');
  if (!deal.clientId || !deal.client) {
    throw new CoreError('business_rule', 'Deal must have a client to create a quote');
  }
  if (deal.quoteId) {
    throw new CoreError('conflict', 'Deal already has a quote');
  }

  const workspace = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    include: { businessProfile: true },
  });

  const { serialNumber: quoteNumber } = await nextSerialNumber(db, {
    workspaceId,
    type: 'quote',
    prefix: 'QT',
    padding: 4,
  });

  const expirationDate = input.expirationDate ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const quote = await db.quote.create({
    data: {
      workspaceId,
      clientId: deal.clientId,
      quoteNumber,
      title: input.title ?? `Quote for ${deal.title}`,
      status: 'draft',
      currency: deal.currency,
      expirationDate,
      subtotal: 0,
      taxTotal: 0,
      total: 0,
    },
  });

  await db.deal.update({
    where: { id: deal.id },
    data: { quoteId: quote.id },
  });

  return { quoteId: quote.id, quoteNumber };
}
