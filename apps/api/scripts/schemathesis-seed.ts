import { writeFileSync } from 'node:fs';
import { API_SCOPES } from '@wolff/contracts';
import { hashApiKey } from '@wolff/core/auth/api-keys';
import { encrypt } from '@wolff/core/encryption';
import { createPrisma } from '@wolff/database';
import { PARITY, seedParityData } from '../src/testing/parity/seed';

/**
 * Seeds the database Schemathesis runs against (`.github/workflows/ci.yml`
 * job `schemathesis`; locally, see docs/phase-6b.md): the parity suite's
 * fixed workspace, plus a key with every scope so the webhook-endpoint
 * routes are reachable too. The key is a fixed test value, not a secret.
 *
 * It also writes the Schemathesis config that pins each `{id}` operation to
 * a seeded resource, so generated requests reach the route's real work
 * instead of its 404. Operations that consume their resource (delete,
 * convert, send, from-quote) get one of their own, so they do not take
 * another operation's away mid-run.
 */
export const SCHEMATHESIS_KEY = 'qc_sk_schemathesis00000000000000000000001';

const id = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;

export const FIXTURES = {
  lead: id(1),
  leadToDelete: id(2),
  leadToConvert: id(3),
  pipeline: id(10),
  stages: [id(11), id(12), id(13)],
  deal: id(20),
  dealToDelete: id(21),
  endpoint: id(30),
  endpointToDelete: id(31),
  delivery: id(32),
  clientToDelete: id(40),
  quoteToDelete: id(41),
  invoiceToDelete: id(42),
  // Edited by the PATCH cases, so the send cases keep a sendable draft.
  quoteToPatch: id(43),
  invoiceToPatch: id(44),
} as const;

/** `[[operations]]` entries: path, method (all when absent) and the ids to use. */
const PINNED: Array<{
  path: string;
  method?: string;
  params: Record<string, string>;
  /** More TOML lines for the operation. */
  extra?: string[];
}> = [
  { path: '/v1/leads/{id}', method: 'DELETE', params: { id: FIXTURES.leadToDelete } },
  { path: '/v1/leads/{id}', method: 'GET', params: { id: FIXTURES.lead } },
  { path: '/v1/leads/{id}', method: 'PATCH', params: { id: FIXTURES.lead } },
  { path: '/v1/leads/{id}/convert', params: { id: FIXTURES.leadToConvert } },
  { path: '/v1/pipelines/{id}', params: { id: FIXTURES.pipeline } },
  { path: '/v1/pipelines/{id}/stages', params: { id: FIXTURES.pipeline } },
  { path: '/v1/deals/{id}', method: 'DELETE', params: { id: FIXTURES.dealToDelete } },
  { path: '/v1/deals/{id}', method: 'GET', params: { id: FIXTURES.deal } },
  { path: '/v1/deals/{id}', method: 'PATCH', params: { id: FIXTURES.deal } },
  { path: '/v1/deals/{id}/move', params: { id: FIXTURES.deal } },
  { path: '/v1/deals/{id}/quote', params: { id: FIXTURES.deal } },
  { path: '/v1/webhook-endpoints/{id}', params: { id: FIXTURES.endpointToDelete } },
  { path: '/v1/webhook-endpoints/{id}/test', params: { id: FIXTURES.endpoint } },
  { path: '/v1/webhook-endpoints/{id}/deliveries', params: { id: FIXTURES.endpoint } },
  { path: '/v1/webhook-deliveries/{id}/retry', params: { id: FIXTURES.delivery } },
  { path: '/v1/clients/{id}', method: 'DELETE', params: { id: FIXTURES.clientToDelete } },
  { path: '/v1/clients/{id}', method: 'GET', params: { id: PARITY.clients.acme } },
  { path: '/v1/clients/{id}', method: 'PATCH', params: { id: PARITY.clients.bharat } },
  { path: '/v1/quotes/{id}', method: 'DELETE', params: { id: FIXTURES.quoteToDelete } },
  { path: '/v1/quotes/{id}', method: 'GET', params: { id: PARITY.quotes.sent } },
  { path: '/v1/quotes/{id}', method: 'PATCH', params: { id: FIXTURES.quoteToPatch } },
  { path: '/v1/quotes/{id}/duplicate', params: { id: PARITY.quotes.sent } },
  { path: '/v1/quotes/{id}/send', params: { id: PARITY.quotes.draft } },
  { path: '/v1/invoices/from-quote/{quoteId}', params: { quoteId: PARITY.quotes.accepted } },
  { path: '/v1/invoices/{id}', method: 'DELETE', params: { id: FIXTURES.invoiceToDelete } },
  { path: '/v1/invoices/{id}', method: 'GET', params: { id: PARITY.invoices.sent } },
  { path: '/v1/invoices/{id}', method: 'PATCH', params: { id: FIXTURES.invoiceToPatch } },
  { path: '/v1/invoices/{id}/send', params: { id: PARITY.invoices.draft } },
  {
    path: '/v1/invoices/{id}/payment-links',
    params: { id: PARITY.invoices.sent },
    // The seeded workspace has no payment settings: the documented answer is
    // 501 not_configured (docs/API.md), not a server failure.
    extra: ['checks.not_a_server_error.expected-statuses = ["2XX", "3XX", "4XX", "501"]'],
  },
];

export function schemathesisConfig(): string {
  return PINNED.map(({ path, method, params, extra = [] }) =>
    [
      '[[operations]]',
      // Each include-* key is a filter of its own (any one matches), so a
      // method and a path are matched together through the operation name.
      method ? `include-name = "${method} ${path}"` : `include-path = "${path}"`,
      `parameters = { ${Object.entries(params)
        .map(([name, value]) => `"path.${name}" = "${value}"`)
        .join(', ')} }`,
      ...extra,
      '',
    ].join('\n')
  ).join('\n');
}

type Db = ReturnType<typeof createPrisma>;

async function seedFixtures(db: Db): Promise<void> {
  const workspaceId = PARITY.workspace;
  const clientId = PARITY.clients.acme;
  await db.lead.createMany({
    data: [
      { id: FIXTURES.lead, workspaceId, name: 'Fuzzed lead', email: 'lead@fuzz.test' },
      { id: FIXTURES.leadToDelete, workspaceId, name: 'Lead to delete' },
      {
        id: FIXTURES.leadToConvert,
        workspaceId,
        name: 'Lead to convert',
        email: 'convert@fuzz.test',
      },
    ],
  });
  await db.pipeline.create({
    data: {
      id: FIXTURES.pipeline,
      workspaceId,
      name: 'Fuzzed pipeline',
      isDefault: true,
      stages: {
        create: FIXTURES.stages.map((stageId, position) => ({
          id: stageId,
          workspaceId,
          name: `Stage ${position + 1}`,
          position,
        })),
      },
    },
  });
  for (const dealId of [FIXTURES.deal, FIXTURES.dealToDelete]) {
    await db.deal.create({
      data: {
        id: dealId,
        workspaceId,
        pipelineId: FIXTURES.pipeline,
        stageId: FIXTURES.stages[0],
        clientId,
        title: 'Fuzzed deal',
        value: 1000,
      },
    });
  }
  for (const endpointId of [FIXTURES.endpoint, FIXTURES.endpointToDelete]) {
    await db.webhookEndpoint.create({
      data: {
        id: endpointId,
        workspaceId,
        url: 'https://hooks.fuzz.test/receive',
        secret: encrypt('whsec_schemathesis'),
        events: ['invoice.paid'],
      },
    });
  }
  await db.webhookDelivery.create({
    data: {
      id: FIXTURES.delivery,
      endpointId: FIXTURES.endpoint,
      workspaceId,
      eventType: 'invoice.paid',
      payload: {},
      status: 'failed',
    },
  });
  await db.client.create({
    data: { id: FIXTURES.clientToDelete, workspaceId, name: 'Delete me', email: 'del@fuzz.test' },
  });
  for (const [n, quoteId] of [FIXTURES.quoteToDelete, FIXTURES.quoteToPatch].entries()) {
    await db.quote.create({
      data: { id: quoteId, workspaceId, clientId, quoteNumber: `FZ-Q${n + 1}`, total: 10 },
    });
  }
  for (const [n, invoiceId] of [FIXTURES.invoiceToDelete, FIXTURES.invoiceToPatch].entries()) {
    await db.invoice.create({
      data: {
        id: invoiceId,
        workspaceId,
        clientId,
        invoiceNumber: `FZ-I${n + 1}`,
        total: 10,
        dueDate: new Date('2026-12-31'),
      },
    });
  }
}

async function main() {
  const db = createPrisma(process.env.DATABASE_URL);
  try {
    await seedParityData(db);
    await db.apiKey.create({
      data: {
        workspaceId: PARITY.workspace,
        name: 'schemathesis',
        keyHash: hashApiKey(SCHEMATHESIS_KEY),
        keyPrefix: SCHEMATHESIS_KEY.slice(0, 10),
        scopes: [...API_SCOPES],
        rateLimitPerMin: 100_000,
      },
    });
    await seedFixtures(db);
    const configPath = process.env.SCHEMATHESIS_CONFIG;
    if (configPath) writeFileSync(configPath, schemathesisConfig());
    console.log('Seeded the Schemathesis workspace');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
