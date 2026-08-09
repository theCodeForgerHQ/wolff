import { Prisma } from './generated/prisma/client';
import type { PrismaClient } from './client';

/**
 * Tenant guard: a Prisma extension that refuses to run a read,
 * update or delete on a tenant-owned model unless its `where` pins the
 * workspace. It catches the query that forgot the filter before it reaches
 * the database; it does not decide which workspace the caller may use.
 */

/** Models with their own `workspaceId` column. */
export const WORKSPACE_SCOPED_MODELS = [
  'Client',
  'ClientTag',
  'Quote',
  'Invoice',
  'CreditNote',
  'Contract',
  'ContractInstance',
  'Project',
  'RateCard',
  'RateCardCategory',
  'TaxRate',
  'ApiKey',
  'WebhookEndpoint',
  'WebhookDelivery',
  'ScheduledEmail',
  'EmailTemplate',
  'NumberSequence',
  'SavedLineItem',
  'InvoiceTemplate',
  'Notification',
  'Attachment',
  'Payment',
  'OutboxEvent',
  'IdempotencyKey',
  'Lead',
  'Pipeline',
  'Stage',
  'Deal',
  'DealActivity',
  'WorkspaceMember',
  'WorkspaceInvitation',
  'BusinessProfile',
  'PaymentSettings',
  'BrandingSettings',
  'WorkspaceSlugHistory',
  'JobRun',
  'Automation',
  'AutomationRun',
  // Read and written only through $unscoped by the webhook handlers and the
  // reconcile job; listed so that a scoped query on it must name a workspace.
  'ProviderWebhookEvent',
] as const;

/** Models scoped through a parent relation: `where: { invoice: { workspaceId } }`. */
export const PARENT_SCOPED_MODELS: Record<string, string> = {
  QuoteLineItem: 'quote',
  QuoteEvent: 'quote',
  InvoiceLineItem: 'invoice',
  InvoiceEvent: 'invoice',
  PaymentSchedule: 'invoice',
  CreditNoteLineItem: 'creditNote',
  CreditNoteEvent: 'creditNote',
};

const GUARDED_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

const OWN_SCOPED = new Set<string>(WORKSPACE_SCOPED_MODELS);

type Where = Record<string, unknown>;

const isObject = (value: unknown): value is Where =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A value that restricts a column to known, non-empty workspace ids. */
function pinsWorkspace(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (!isObject(value)) return false;
  if (typeof value.equals === 'string') return value.equals.length > 0;
  if (Array.isArray(value.in)) {
    return value.in.length > 0 && value.in.every((v) => typeof v === 'string' && v.length > 0);
  }
  return false;
}

/** The `AND` branches of a where, plus the where itself. `OR`/`NOT` never count. */
function conjuncts(where: Where): Where[] {
  const and = where.AND;
  const nested = Array.isArray(and) ? and : isObject(and) ? [and] : [];
  return [where, ...nested.filter(isObject).flatMap(conjuncts)];
}

function ownPredicate(where: Where): boolean {
  return conjuncts(where).some(
    (part) =>
      pinsWorkspace(part.workspaceId) ||
      // Compound unique selectors: { workspaceId_type: { workspaceId, type } }.
      Object.entries(part).some(
        ([key, value]) =>
          key.includes('workspaceId_') && isObject(value) && pinsWorkspace(value.workspaceId)
      )
  );
}

function parentPredicate(where: Where, parent: string): boolean {
  return conjuncts(where).some((part) => {
    const relation = part[parent];
    if (!isObject(relation)) return false;
    const target = isObject(relation.is) ? relation.is : relation;
    return ownPredicate(target);
  });
}

/**
 * Returns a description of what is missing, or null when the call is allowed.
 * Pure, so the rules can be tested without a database.
 */
export function findTenantViolation(
  model: string | undefined,
  operation: string,
  args: unknown
): string | null {
  if (!model || !GUARDED_OPERATIONS.has(operation)) return null;
  const where = isObject(args) && isObject(args.where) ? args.where : {};

  if (OWN_SCOPED.has(model)) {
    return ownPredicate(where) ? null : `${model}.${operation} needs a workspaceId in its where`;
  }
  const parent = PARENT_SCOPED_MODELS[model];
  if (parent) {
    return parentPredicate(where, parent)
      ? null
      : `${model}.${operation} needs where: { ${parent}: { workspaceId } }`;
  }
  return null;
}

export class TenantScopeError extends Error {
  constructor(
    message: string,
    readonly model: string,
    readonly operation: string
  ) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

export interface TenantGuardOptions {
  /** `throw` stops the query (development, tests). `report` lets it run (production). */
  mode?: 'throw' | 'report';
  onViolation?: (violation: { model: string; operation: string; message: string }) => void;
}

function defaultMode(): 'throw' | 'report' {
  return process.env.NODE_ENV === 'production' ? 'report' : 'throw';
}

/**
 * Wraps a client with the guard. `$unscoped` is the unguarded client, for the
 * exemptions the design lists (API key lookup by hash, inbound webhook
 * reconcile, portal token lookup, the outbox relay, backfills). Each use is a
 * place a reviewer should look at.
 */
export function withTenantGuard(client: PrismaClient, options: TenantGuardOptions = {}) {
  const mode = options.mode ?? defaultMode();

  return client.$extends(
    Prisma.defineExtension({
      name: 'tenant-guard',
      client: {
        $unscoped: client,
      },
      query: {
        $allModels: {
          $allOperations({ model, operation, args, query }) {
            const message = findTenantViolation(model, operation, args);
            if (message) {
              options.onViolation?.({ model, operation, message });
              if (mode === 'throw') {
                return Promise.reject(new TenantScopeError(message, model, operation));
              }
            }
            return query(args);
          },
        },
      },
    })
  );
}

export type TenantGuardedClient = ReturnType<typeof withTenantGuard>;
