import type { Prisma } from '@wolff/database';
import { CoreError } from '../errors';
import type { CoreContext, DbOrTx } from '../context';
import { afterCursor, toCursorPage, type CursorPosition } from '../pagination';
import { ensureDefaultPipeline } from './pipelines';

export interface CreateLeadInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  source?: 'manual' | 'widget' | 'api' | 'import';
  status?: 'new' | 'contacted' | 'qualified' | 'disqualified' | 'converted';
  score?: number | null;
  message?: string | null;
  ownerId?: string | null;
}

export interface UpdateLeadInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  source?: 'manual' | 'widget' | 'api' | 'import';
  status?: 'new' | 'contacted' | 'qualified' | 'disqualified' | 'converted';
  score?: number | null;
  message?: string | null;
  ownerId?: string | null;
}

export interface LeadFilters {
  status?: 'new' | 'contacted' | 'qualified' | 'disqualified' | 'converted';
  source?: 'manual' | 'widget' | 'api' | 'import';
  ownerId?: string;
  q?: string;
}

export interface ListLeadsQuery {
  limit: number;
  cursor?: string;
  filters?: LeadFilters;
}

export interface ConvertLeadInput {
  leadId: string;
  /** Override the deal title; defaults to the lead's company or name. */
  title?: string;
  /** Override the deal value; defaults to 0. */
  value?: number;
  /** Override the deal currency; defaults to the workspace currency or USD. */
  currency?: string;
  /** Place the new deal in this stage; defaults to the first open stage. */
  stageId?: string;
}

export interface ConvertLeadResult {
  clientId: string;
  dealId: string;
  leadId: string;
}

/**
 * Converts a lead into a client and a deal in the workspace's default
 * pipeline. The lead is marked converted and linked to the new client.
 * Idempotent: converting the same lead twice returns the existing client and
 * deal.
 */
export async function convertLead(
  ctx: CoreContext,
  input: ConvertLeadInput
): Promise<ConvertLeadResult> {
  const { db, workspaceId, actorId } = ctx;

  const existing = await db.lead.findFirst({
    where: { id: input.leadId, workspaceId, deletedAt: null },
    include: { deal: true, client: true },
  });
  if (!existing) throw new Error('Lead not found');
  if (existing.status === 'converted' && existing.deal && existing.client) {
    return {
      clientId: existing.client.id,
      dealId: existing.deal.id,
      leadId: existing.id,
    };
  }

  const { pipelineId, stageIds } = await ensureDefaultPipeline(db, workspaceId);

  // Pick the target stage: explicit, or the first open stage, or the first
  // stage as a fallback.
  const stages = await db.stage.findMany({
    where: { pipelineId, workspaceId },
    orderBy: { position: 'asc' },
  });
  const targetStage = input.stageId
    ? stages.find((s) => s.id === input.stageId)
    : (stages.find((s) => s.kind === 'open') ?? stages[0]);
  if (!targetStage) throw new Error('Pipeline has no stages');

  return db.$transaction(async (tx) => {
    // Lock the lead so concurrent conversions do not create duplicates.
    const [locked] = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status::text FROM leads
      WHERE id = ${input.leadId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL
      FOR UPDATE`;
    if (!locked) throw new Error('Lead not found');
    if (locked.status === 'converted') {
      const converted = await tx.lead.findUniqueOrThrow({
        where: { id: input.leadId, workspaceId },
        include: { deal: true, client: true },
      });
      if (converted.client && converted.deal) {
        return {
          clientId: converted.client.id,
          dealId: converted.deal.id,
          leadId: converted.id,
        };
      }
    }

    const workspace = await tx.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      include: { businessProfile: true },
    });

    const client = await tx.client.create({
      data: {
        workspaceId,
        name: existing.name,
        company: existing.company ?? undefined,
        email: existing.email ?? `${existing.id}@lead.local`,
        phone: existing.phone ?? undefined,
        countryCode: workspace.businessProfile?.gstin ? 'IN' : 'US',
      },
    });

    const deal = await tx.deal.create({
      data: {
        workspaceId,
        pipelineId,
        stageId: targetStage.id,
        leadId: existing.id,
        clientId: client.id,
        title:
          input.title ?? (existing.company ? `${existing.company} deal` : `${existing.name} deal`),
        value: input.value ?? 0,
        currency: input.currency ?? workspace.businessProfile?.currency ?? 'USD',
        ownerId: existing.ownerId ?? null,
      },
    });

    await tx.lead.update({
      where: { id: existing.id, workspaceId },
      data: {
        status: 'converted',
        clientId: client.id,
        convertedAt: new Date(),
      },
    });

    await tx.dealActivity.create({
      data: {
        workspaceId,
        dealId: deal.id,
        type: 'stage_changed',
        actorId,
        payload: {
          fromStageId: null,
          toStageId: targetStage.id,
          source: 'lead_conversion',
        },
      },
    });

    return { clientId: client.id, dealId: deal.id, leadId: existing.id };
  });
}

function leadWhere(workspaceId: string, filters?: LeadFilters): Prisma.LeadWhereInput {
  const where: Prisma.LeadWhereInput = { workspaceId, deletedAt: null };
  if (filters?.status) where.status = filters.status;
  if (filters?.source) where.source = filters.source;
  if (filters?.ownerId) where.ownerId = filters.ownerId;
  if (filters?.q) {
    const q = filters.q.replace(/[%_]/g, '\\$&');
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { company: { contains: q, mode: 'insensitive' } },
    ];
  }
  return where;
}

export async function listLeads(ctx: CoreContext, query: ListLeadsQuery) {
  const { db, workspaceId } = ctx;
  const limit = Math.min(query.limit, 100);
  const where = leadWhere(workspaceId, query.filters);

  const rows = await db.lead.findMany({
    where: { ...where, ...afterCursor(query.cursor) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  return toCursorPage(rows, limit);
}

export async function getLead(ctx: CoreContext, id: string) {
  const { db, workspaceId } = ctx;
  return db.lead.findFirst({
    where: { id, workspaceId, deletedAt: null },
  });
}

function normalizeLeadInput<T extends CreateLeadInput | UpdateLeadInput>(input: T): T {
  const copy: T = { ...input };
  if (copy.email === '') copy.email = null;
  if (copy.phone === '') copy.phone = null;
  if (copy.company === '') copy.company = null;
  if (copy.message === '') copy.message = null;
  return copy;
}

export async function createLead(ctx: CoreContext, input: CreateLeadInput) {
  const { db, workspaceId, actorId } = ctx;
  const data = normalizeLeadInput(input);

  try {
    const lead = await db.lead.create({
      data: {
        workspaceId,
        name: data.name,
        email: data.email ?? null,
        phone: data.phone ?? null,
        company: data.company ?? null,
        source: data.source ?? 'manual',
        status: data.status ?? 'new',
        score: data.score ?? null,
        message: data.message ?? null,
        ownerId: data.ownerId ?? null,
      },
    });
    return lead;
  } catch (error) {
    if (isUniqueEmailConflict(error)) {
      throw new CoreError('conflict', 'A lead with this email already exists');
    }
    throw error;
  }
}

export async function updateLead(ctx: CoreContext, id: string, input: UpdateLeadInput) {
  const { db, workspaceId } = ctx;
  const data = normalizeLeadInput(input);

  const existing = await db.lead.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!existing) return null;

  try {
    return await db.lead.update({
      where: { id, workspaceId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.email !== undefined && { email: data.email }),
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.company !== undefined && { company: data.company }),
        ...(data.source !== undefined && { source: data.source }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.score !== undefined && { score: data.score }),
        ...(data.message !== undefined && { message: data.message }),
        ...(data.ownerId !== undefined && { ownerId: data.ownerId }),
      },
    });
  } catch (error) {
    if (isUniqueEmailConflict(error)) {
      throw new CoreError('conflict', 'A lead with this email already exists');
    }
    throw error;
  }
}

export async function deleteLead(ctx: CoreContext, id: string) {
  const { db, workspaceId } = ctx;
  const existing = await db.lead.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!existing) return false;

  await db.lead.update({
    where: { id, workspaceId },
    data: { deletedAt: new Date(), email: null },
  });
  return true;
}

export interface ImportLeadsInput {
  leads: Array<{
    name: string;
    email?: string | null;
    phone?: string | null;
    company?: string | null;
    source?: 'manual' | 'widget' | 'api' | 'import';
    status?: 'new' | 'contacted' | 'qualified' | 'disqualified' | 'converted';
    score?: number | null;
    message?: string | null;
    ownerId?: string | null;
  }>;
  dedupeBy: Array<'email' | 'phone'>;
}

export interface ImportLeadsResult {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

function normalizeImportRow(
  row: ImportLeadsInput['leads'][number]
): ImportLeadsInput['leads'][number] {
  const copy = { ...row };
  if (copy.email === '') copy.email = null;
  if (copy.phone === '') copy.phone = null;
  if (copy.company === '') copy.company = null;
  if (copy.message === '') copy.message = null;
  return copy;
}

/**
 * Imports leads into a workspace with email/phone deduplication. Existing
 * leads are updated; new leads are created. Errors on individual rows are
 * counted but do not fail the whole batch.
 */
export async function importLeads(
  ctx: CoreContext,
  input: ImportLeadsInput
): Promise<ImportLeadsResult> {
  const { db, workspaceId } = ctx;
  const result: ImportLeadsResult = { created: 0, updated: 0, skipped: 0, errors: 0 };

  // Track keys seen in this batch so duplicate imports do not create multiple
  // rows for the same contact.
  const seen = new Set<string>();

  for (const raw of input.leads) {
    const row = normalizeImportRow(raw);
    try {
      const keys: string[] = [];
      if (input.dedupeBy.includes('email') && row.email)
        keys.push(`email:${row.email.toLowerCase()}`);
      if (input.dedupeBy.includes('phone') && row.phone) keys.push(`phone:${row.phone}`);

      if (keys.some((key) => seen.has(key))) {
        result.skipped++;
        continue;
      }

      const where: Prisma.LeadWhereInput = { workspaceId, deletedAt: null };
      const orConditions: Prisma.LeadWhereInput[] = [];
      if (input.dedupeBy.includes('email') && row.email) {
        orConditions.push({ email: { equals: row.email, mode: 'insensitive' } });
      }
      if (input.dedupeBy.includes('phone') && row.phone) {
        orConditions.push({ phone: row.phone });
      }
      if (orConditions.length > 0) where.OR = orConditions;

      const existing = orConditions.length > 0 ? await db.lead.findFirst({ where }) : null;

      if (existing) {
        await db.lead.update({
          where: { id: existing.id, workspaceId },
          data: {
            name: row.name,
            ...(row.email !== undefined && { email: row.email }),
            ...(row.phone !== undefined && { phone: row.phone }),
            ...(row.company !== undefined && { company: row.company }),
            source: 'import',
            ...(row.status !== undefined &&
              existing.status !== 'converted' && { status: row.status }),
            ...(row.score !== undefined && { score: row.score }),
            ...(row.message !== undefined && { message: row.message }),
            ...(row.ownerId !== undefined && { ownerId: row.ownerId }),
          },
        });
        result.updated++;
      } else {
        await db.lead.create({
          data: {
            workspaceId,
            name: row.name,
            email: row.email ?? null,
            phone: row.phone ?? null,
            company: row.company ?? null,
            source: row.source ?? 'import',
            status: row.status ?? 'new',
            score: row.score ?? null,
            message: row.message ?? null,
            ownerId: row.ownerId ?? null,
          },
        });
        result.created++;
      }

      keys.forEach((k) => seen.add(k));
    } catch {
      result.errors++;
    }
  }

  return result;
}

export interface BulkLeadResult {
  updated: number;
}

export async function bulkLeads(
  ctx: CoreContext,
  input: { ids: string[]; action: 'assign' | 'status' | 'delete'; value?: string }
): Promise<BulkLeadResult> {
  const { db, workspaceId } = ctx;
  const where = { workspaceId, id: { in: input.ids }, deletedAt: null as Date | null };

  if (input.action === 'delete') {
    const result = await db.lead.updateMany({
      where,
      data: { deletedAt: new Date(), email: null },
    });
    return { updated: result.count };
  }

  if (input.action === 'assign') {
    if (!input.value) throw new CoreError('validation_error', 'value is required for assign');
    const result = await db.lead.updateMany({
      where,
      data: { ownerId: input.value },
    });
    return { updated: result.count };
  }

  if (input.action === 'status') {
    if (!input.value) throw new CoreError('validation_error', 'value is required for status');
    const status = input.value as 'new' | 'contacted' | 'qualified' | 'disqualified' | 'converted';
    const result = await db.lead.updateMany({ where, data: { status } });
    return { updated: result.count };
  }

  throw new CoreError('validation_error', `Unknown action: ${input.action}`);
}

function isUniqueEmailConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    code?: string;
    meta?: {
      target?: unknown;
      driverAdapterError?: {
        constraint?: { index?: string };
        cause?: { constraint?: { index?: string } };
      };
    };
  };
  if (e.code !== 'P2002') return false;
  const target = e.meta?.target;
  const index =
    e.meta?.driverAdapterError?.constraint?.index ??
    e.meta?.driverAdapterError?.cause?.constraint?.index;
  const names = ['leads_workspace_id_email_key', 'workspace_id_email'];
  return (
    (Array.isArray(target) && names.some((n) => target.includes(n))) ||
    (typeof index === 'string' && names.includes(index))
  );
}
