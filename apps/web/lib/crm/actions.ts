'use server';

import { revalidatePath } from 'next/cache';
import { prisma, withTenantGuard, Prisma } from '@wolff/database';
import { getCurrentUserWorkspace } from '@/lib/workspace/get-current-workspace';
import {
  createLead as createLeadCore,
  updateLead as updateLeadCore,
  deleteLead as deleteLeadCore,
  convertLead as convertLeadCore,
  getLead as getLeadCore,
  listLeads as listLeadsCore,
  ensureDefaultPipeline,
  moveDeal as moveDealCore,
  createDeal as createDealCore,
} from '@wolff/core/crm';
import { createQuoteFromDeal as createQuoteFromDealCore } from '@wolff/core/quotes';
import { ROUTES } from '@/lib/routes';
import { toNumber } from '@/lib/utils';
import type {
  LeadFilter,
  PaginatedLeads,
  LeadListItem,
  LeadDetail,
  CreateLeadInput,
  UpdateLeadInput,
  ConvertLeadInput,
  ConvertLeadResult,
  DealsBoard,
  DealListItem,
  MoveDealInput,
} from './types';

const db = withTenantGuard(prisma);

function toListItem(
  row: Prisma.LeadGetPayload<{}> & { owner?: { name: string | null } | null }
): LeadListItem {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    source: row.source as LeadListItem['source'],
    status: row.status as LeadListItem['status'],
    score: row.score,
    ownerId: row.ownerId,
    ownerName: row.owner?.name ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getContext() {
  const { workspaceId, userId } = await getCurrentUserWorkspace();
  return { db, workspaceId, actorId: userId };
}

export async function getLeads(filter: LeadFilter = {}): Promise<PaginatedLeads> {
  const ctx = await getContext();
  const page = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
  const sortBy = filter.sortBy ?? 'createdAt';
  const sortOrder = filter.sortOrder ?? 'desc';

  const where: Record<string, unknown> = {
    workspaceId: ctx.workspaceId,
    deletedAt: null,
  };

  if (filter.status) {
    where.status = filter.status;
  }
  if (filter.source) {
    where.source = filter.source;
  }
  if (filter.search) {
    const q = filter.search.slice(0, 200);
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { company: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [total, rows] = await Promise.all([
    ctx.db.lead.count({ where }),
    ctx.db.lead.findMany({
      where,
      include: { owner: { select: { name: true } } },
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data: rows.map(toListItem),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getLead(id: string): Promise<LeadDetail | null> {
  const ctx = await getContext();
  const row = await getLeadCore(ctx, id);
  if (!row) return null;
  return {
    ...toListItem({ ...row, owner: null }),
    message: row.message ?? null,
  };
}

export async function createLead(input: CreateLeadInput): Promise<LeadListItem> {
  const ctx = await getContext();
  const lead = await createLeadCore(ctx, input);
  revalidatePath(ROUTES.leads);
  return toListItem({ ...lead, owner: null });
}

export async function updateLead(id: string, input: UpdateLeadInput): Promise<LeadListItem> {
  const ctx = await getContext();
  const lead = await updateLeadCore(ctx, id, input);
  if (!lead) throw new Error('Lead not found');
  revalidatePath(ROUTES.leads);
  return toListItem({ ...lead, owner: null });
}

export async function deleteLead(id: string): Promise<void> {
  const ctx = await getContext();
  await deleteLeadCore(ctx, id);
  revalidatePath(ROUTES.leads);
}

export async function convertLead(
  id: string,
  input: ConvertLeadInput = {}
): Promise<ConvertLeadResult> {
  const ctx = await getContext();
  const result = await convertLeadCore(ctx, { leadId: id, ...input });
  revalidatePath(ROUTES.leads);
  revalidatePath(ROUTES.deals);
  return result;
}

// Cursor-based list for infinite scroll variants.
export async function listLeadsCursor(cursor?: string, limit = 25) {
  const ctx = await getContext();
  return listLeadsCore(ctx, { limit, cursor });
}

// ============================================
// Deals
// ============================================

export async function getDealsBoard(): Promise<DealsBoard> {
  const ctx = await getContext();
  const { pipelineId } = await ensureDefaultPipeline(ctx.db, ctx.workspaceId);

  const pipeline = await ctx.db.pipeline.findFirstOrThrow({
    where: { id: pipelineId, workspaceId: ctx.workspaceId },
    include: { stages: { orderBy: { position: 'asc' } } },
  });

  const deals = await ctx.db.deal.findMany({
    where: { pipelineId, workspaceId: ctx.workspaceId, deletedAt: null },
    include: {
      client: { select: { name: true } },
      owner: { select: { name: true } },
    },
    orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
  });

  return {
    pipelineId,
    pipelineName: pipeline.name,
    stages: pipeline.stages.map((s) => ({
      id: s.id,
      name: s.name,
      position: s.position,
      probability: s.probability,
      kind: s.kind as DealsBoard['stages'][number]['kind'],
    })),
    deals: deals.map((d) => ({
      id: d.id,
      title: d.title,
      value: toNumber(d.value),
      currency: d.currency,
      stageId: d.stageId,
      clientName: d.client?.name ?? null,
      ownerName: d.owner?.name ?? null,
      expectedCloseDate: d.expectedCloseDate,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
  };
}

export async function moveDeal(input: MoveDealInput): Promise<void> {
  const ctx = await getContext();
  await moveDealCore(ctx, input);
  revalidatePath(ROUTES.deals);
}

export async function createDeal(input: {
  stageId: string;
  clientId?: string;
  leadId?: string;
  title: string;
  value?: number;
  currency?: string;
  expectedCloseDate?: Date;
}): Promise<{ dealId: string }> {
  const ctx = await getContext();
  const result = await createDealCore(ctx, {
    ...input,
    pipelineId: (await ensureDefaultPipeline(ctx.db, ctx.workspaceId)).pipelineId,
  });
  revalidatePath(ROUTES.deals);
  return result;
}

export async function createQuoteFromDeal(dealId: string): Promise<{ quoteId: string }> {
  const ctx = await getContext();
  const result = await createQuoteFromDealCore(ctx, { dealId });
  revalidatePath(ROUTES.deals);
  revalidatePath(ROUTES.quotes);
  return result;
}
