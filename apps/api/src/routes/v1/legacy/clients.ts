import { Router, type Response } from 'express';
import type { Prisma } from '@wolff/database';
import type { Db } from '@wolff/core/context';
import { requestAiIndexing } from '@wolff/core/outbox';
import '../../../context';
import { requireScopes } from '../../../middleware/auth';
import type { LegacyRouteDeps } from '.';
import {
  EMAIL_PATTERN,
  INVALID_JSON,
  asObject,
  legacyError,
  legacyJson,
  pageParams,
  queryParam,
  readJsonBody,
  stripProtectedFields,
  param,
  isUniqueViolation,
  fieldTypeProblem,
} from './http';

const METADATA_LIMIT = 10_000;
const IMPORT_LIMIT = 500;

interface ClientRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  address: Prisma.JsonValue;
  billingAddress: Prisma.JsonValue;
  metadata: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

const formatClient = (c: ClientRow) => ({
  id: c.id,
  name: c.name,
  email: c.email,
  phone: c.phone,
  company: c.company,
  address: c.address,
  billingAddress: c.billingAddress,
  metadata: c.metadata,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

const json = (value: unknown) => value as Prisma.InputJsonValue;

interface ClientFields {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  address?: Record<string, string>;
  billingAddress?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

interface ImportRow {
  name: string;
  email: string;
  phone?: string;
  company?: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

/**
 * Writes a client, or answers 409 when the email is taken. The check before
 * the write skips deleted clients, but the unique index on (workspace,
 * email) does not, so the email of a deleted client used to end in a 500.
 */
async function createOrConflict<T>(res: Response, write: () => Promise<T>): Promise<T | null> {
  try {
    return await write();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    legacyError(res, 'A client with this email already exists', 409);
    return null;
  }
}

/**
 * `/v1/clients`, `/v1/clients/:id` and `/v1/clients/import`, ported from
 * apps/web/app/api/v1/clients/**. The workspace is always the API key's
 * (`req.ctx.workspaceId`), never one from the request.
 */
export function clientRoutes(db: Db, deps: LegacyRouteDeps): Router {
  const router = Router();

  router.get('/clients', requireScopes('clients:read'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const { page, limit } = pageParams(req);
    const search = queryParam(req, 'search');

    const where: Prisma.ClientWhereInput = { workspaceId, deletedAt: null };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { company: { contains: search, mode: 'insensitive' } },
      ];
    }
    const [clients, total] = await Promise.all([
      db.client.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.client.count({ where }),
    ]);

    legacyJson(res, {
      data: clients.map(formatClient),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  });

  router.post('/clients', requireScopes('clients:write'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const parsed = readJsonBody(req);
    if (parsed === INVALID_JSON) return legacyError(res, 'Invalid JSON body', 400);
    const fields = stripProtectedFields(parsed);
    const { name, email, phone, company, address, billingAddress, metadata } =
      fields as ClientFields;

    if (!name) return legacyError(res, 'name is required', 400);
    if (!email) return legacyError(res, 'email is required', 400);
    const wrongType = fieldTypeProblem(fields, {
      name: 'string',
      email: 'string',
      phone: 'string-or-null',
      company: 'string-or-null',
    });
    if (wrongType) return legacyError(res, wrongType, 400);
    if (!EMAIL_PATTERN.test(email)) return legacyError(res, 'Invalid email format', 400);
    if (metadata && JSON.stringify(metadata).length > METADATA_LIMIT) {
      return legacyError(res, 'Metadata too large (max 10KB)', 400);
    }

    const existing = await db.client.findFirst({ where: { workspaceId, email, deletedAt: null } });
    if (existing) return legacyError(res, 'A client with this email already exists', 409);

    const client = await createOrConflict(res, () =>
      db.client.create({
        data: {
          workspaceId,
          name,
          email,
          phone: phone || null,
          company: company || null,
          address: json(address || undefined),
          billingAddress: json(billingAddress || undefined),
          metadata: json(metadata || {}),
        },
      })
    );
    if (!client) return;

    const { updatedAt: _updatedAt, ...created } = formatClient(client);
    legacyJson(res, created, 201);
  });

  router.post('/clients/import', requireScopes('clients:write'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const parsed = readJsonBody(req);
    if (parsed === INVALID_JSON) return legacyError(res, 'Invalid JSON body', 400);
    const { clients, skipDuplicates = true } = asObject(parsed) as {
      clients?: ImportRow[];
      skipDuplicates?: boolean;
    };

    if (!clients || !Array.isArray(clients)) {
      return legacyError(res, 'clients array is required', 400);
    }
    if (clients.length === 0) return legacyError(res, 'clients array cannot be empty', 400);
    if (clients.length > IMPORT_LIMIT) {
      return legacyError(res, 'Maximum 500 clients per import', 400);
    }

    const result = {
      success: 0,
      failed: 0,
      skipped: 0,
      errors: [] as Array<{ row: number; message: string }>,
      created: [] as Array<{ id: string; name: string; email: string }>,
    };

    const seen = new Set<string>();
    if (skipDuplicates) {
      const existing = await db.client.findMany({
        where: {
          workspaceId,
          email: { in: clients.map((row) => row?.email).filter(Boolean) },
          deletedAt: null,
        },
        select: { email: true },
      });
      for (const c of existing) seen.add(c.email.toLowerCase());
    }

    const valid: Array<{ index: number; row: ImportRow }> = [];
    clients.forEach((row, i) => {
      // A row that is not an object (null) has no name; the Next route threw on it.
      if (
        !row ||
        typeof row !== 'object' ||
        !row.name ||
        typeof row.name !== 'string' ||
        row.name.trim().length === 0
      ) {
        result.failed++;
        result.errors.push({ row: i + 1, message: 'name is required' });
        return;
      }
      if (!row.email || !EMAIL_PATTERN.test(row.email)) {
        result.failed++;
        result.errors.push({ row: i + 1, message: 'Invalid email format' });
        return;
      }
      // An existing email (when skipping duplicates) or one repeated in the batch.
      if (seen.has(row.email.toLowerCase())) {
        result.skipped++;
        return;
      }
      seen.add(row.email.toLowerCase());
      valid.push({ index: i, row });
    });

    if (valid.length > 0) {
      try {
        const created = await db.$transaction(
          valid.map(({ row }) => {
            const hasAddress = row.street || row.city || row.state || row.postalCode || row.country;
            const address = hasAddress
              ? {
                  street: row.street,
                  city: row.city,
                  state: row.state,
                  postalCode: row.postalCode,
                  country: row.country,
                }
              : undefined;
            return db.client.create({
              data: {
                workspaceId,
                name: row.name.trim(),
                email: row.email.trim().toLowerCase(),
                phone: row.phone || null,
                company: row.company || null,
                address: json(address),
                metadata: json({
                  type: row.company ? 'company' : 'individual',
                  contacts: [],
                  tags: [],
                }),
              },
            });
          })
        );
        for (const client of created) {
          result.success++;
          result.created.push({ id: client.id, name: client.name, email: client.email });
        }
      } catch (error) {
        // The transaction failed: every valid row failed with it.
        const duplicate = (error as { code?: string })?.code === 'P2002';
        for (const { index } of valid) {
          result.failed++;
          result.errors.push({
            row: index + 1,
            message: duplicate ? 'Duplicate email' : 'Failed to create client',
          });
        }
      }
    }

    legacyJson(
      res,
      {
        message: `Import complete: ${result.success} created, ${result.skipped} skipped, ${result.failed} failed`,
        ...result,
      },
      201
    );
  });

  router.get('/clients/:id', requireScopes('clients:read'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const client = await db.client.findFirst({
      where: { id: param(req, 'id'), workspaceId, deletedAt: null },
    });
    if (!client) return legacyError(res, 'Client not found', 404);
    legacyJson(res, formatClient(client));
  });

  router.patch('/clients/:id', requireScopes('clients:write'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const id = param(req, 'id');

    const client = await db.client.findFirst({ where: { id, workspaceId, deletedAt: null } });
    if (!client) return legacyError(res, 'Client not found', 404);

    const parsed = readJsonBody(req);
    if (parsed === INVALID_JSON) return legacyError(res, 'Invalid JSON body', 400);
    const fields = stripProtectedFields(parsed);
    const { name, email, phone, company, address, billingAddress, metadata } =
      fields as ClientFields;
    const wrongType = fieldTypeProblem(fields, {
      name: 'string',
      email: 'string',
      phone: 'string-or-null',
      company: 'string-or-null',
      address: 'json',
      billingAddress: 'json',
      metadata: 'json',
    });
    if (wrongType) return legacyError(res, wrongType, 400);

    if (email !== undefined && !EMAIL_PATTERN.test(email)) {
      return legacyError(res, 'Invalid email format', 400);
    }
    if (email && email !== client.email) {
      const existing = await db.client.findFirst({
        where: { workspaceId, email, deletedAt: null, id: { not: id } },
      });
      if (existing) return legacyError(res, 'A client with this email already exists', 409);
    }
    if (name !== undefined && !name.trim()) {
      return legacyError(res, 'Client name cannot be empty', 400);
    }

    const data: Prisma.ClientUpdateInput = {};
    if (name !== undefined) data.name = name;
    if (email !== undefined) data.email = email;
    if (phone !== undefined) data.phone = phone;
    if (company !== undefined) data.company = company;
    if (address !== undefined) data.address = json(address);
    if (billingAddress !== undefined) data.billingAddress = json(billingAddress);
    if (metadata !== undefined) {
      if (JSON.stringify(metadata).length > METADATA_LIMIT) {
        return legacyError(res, 'Metadata too large (max 10KB)', 400);
      }
      data.metadata = json(metadata);
    }

    const updated = await createOrConflict(res, () =>
      db.client.update({ where: { id, workspaceId }, data })
    );
    if (!updated) return;
    legacyJson(res, formatClient(updated));
  });

  router.delete('/clients/:id', requireScopes('clients:write'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const id = param(req, 'id');

    const client = await db.client.findFirst({ where: { id, workspaceId, deletedAt: null } });
    if (!client) return legacyError(res, 'Client not found', 404);

    const outbox = await db.$transaction(async (tx) => {
      await tx.client.update({ where: { id, workspaceId }, data: { deletedAt: new Date() } });
      // The AI service drops the soft-deleted document from its index.
      return requestAiIndexing(tx, { workspaceId, sourceType: 'client_note', sourceId: id });
    });
    await deps.onOutboxEvents?.([outbox.id]);

    legacyJson(res, { message: 'Client deleted' });
  });

  return router;
}
