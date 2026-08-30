import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmailMessage } from '@wolff/jobs';
import { request } from '../../../testing/request';
import { TEST_DATABASE_URL, issueKey, testApp, testDb } from '../../../testing/harness';
import { LEGACY_KEY_SCOPES } from '@wolff/contracts';

/**
 * The send routes may not be a cheaper way to send email than before. The
 * Next routes allowed 20 emails an hour per workspace, whatever the
 * document or the recipients. Here: two keys of one workspace, alternating
 * quotes and invoices and changing the recipients, still stop at 20; the
 * 21st request sends nothing, changes nothing and answers 429 (the Next
 * routes answered 502; see docs/phase-6b.md). The
 * per-key limiter also applies to these routes (429).
 */
describe.skipIf(!TEST_DATABASE_URL)('email limit on the ported send routes (Postgres)', () => {
  const { base, db } = testDb();
  const sent: EmailMessage[] = [];
  const app = testApp(db, { email: { send: async (m) => void sent.push(m) } });
  let workspaceId = '';
  const keys: string[] = [];
  const quotes: string[] = [];
  const invoices: string[] = [];

  beforeAll(async () => {
    const ws = await base.workspace.create({
      data: {
        name: 'Email limit',
        slug: `email-limit-${Date.now()}`,
        clients: { create: { name: 'C', email: 'c@limit.test' } },
      },
      include: { clients: true },
    });
    workspaceId = ws.id;
    for (let i = 0; i < 2; i++) {
      keys.push(
        (await issueKey(base, ws.id, { scopes: [...LEGACY_KEY_SCOPES], rateLimitPerMin: 100_000 }))
          .key
      );
    }
    for (let i = 0; i < 12; i++) {
      const common = { workspaceId, clientId: ws.clients[0]!.id, total: 100, subtotal: 100 };
      quotes.push((await base.quote.create({ data: { ...common, quoteNumber: `L-Q${i}` } })).id);
      invoices.push(
        (
          await base.invoice.create({
            data: {
              ...common,
              invoiceNumber: `L-I${i}`,
              amountDue: 100,
              dueDate: new Date('2026-12-01'),
            },
          })
        ).id
      );
    }
  });

  afterAll(async () => {
    await base.outboxEvent.deleteMany({ where: { workspaceId } });
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  it('stops at 20 sends an hour per workspace, across documents, recipients and keys', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const path =
        i % 2 === 0 ? `/v1/quotes/${quotes[i >> 1]}/send` : `/v1/invoices/${invoices[i >> 1]}/send`;
      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${keys[i % 2]}`)
        .send({ recipients: [`r${i}@limit.test`, `s${i}@limit.test`] });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    // Two recipients per accepted send; nothing for the refused ones.
    expect(sent).toHaveLength(40);
    const refused = await base.invoice.findFirstOrThrow({
      where: { id: invoices[10], workspaceId },
    });
    expect(refused.status).toBe('draft');
    const over = await request(app)
      .post(`/v1/quotes/${quotes[11]}/send`)
      .set('Authorization', `Bearer ${keys[0]}`);
    expect(over.body).toEqual({
      error: 'Email limit reached for this workspace. Try again later.',
    });
    // What is left of the hour's window, which opened with the first send.
    expect(Number(over.get('Retry-After'))).toBeGreaterThan(3500);
    expect(Number(over.get('Retry-After'))).toBeLessThanOrEqual(3600);
  });

  it('does not email a recipient twice when a partial send is retried', async () => {
    // Like Resend: a key it has seen is answered from its record.
    const delivered: string[] = [];
    const seen = new Set<string>();
    let failOnce = true;
    const flaky = testApp(db, {
      email: {
        send: async (m) => {
          if (seen.has(m.idempotencyKey)) return;
          if (m.to === 'two@limit.test' && failOnce) {
            failOnce = false;
            throw new Error('provider unavailable');
          }
          seen.add(m.idempotencyKey);
          delivered.push(m.to);
        },
      },
    });
    const key = (
      await issueKey(base, workspaceId, { scopes: [...LEGACY_KEY_SCOPES], rateLimitPerMin: 100 })
    ).key;
    const invoice = await base.invoice.create({
      data: {
        workspaceId,
        clientId: (await base.client.findFirstOrThrow({ where: { workspaceId } })).id,
        invoiceNumber: 'L-RETRY',
        total: 100,
        subtotal: 100,
        amountDue: 100,
        dueDate: new Date('2026-12-01'),
      },
    });
    // A new app has its own email counter, so the test above does not limit it.
    const send = () =>
      request(flaky)
        .post(`/v1/invoices/${invoice.id}/send`)
        .set('Authorization', `Bearer ${key}`)
        .send({ recipients: ['one@limit.test', 'two@limit.test'] });

    expect((await send()).status).toBe(502);
    expect((await send()).status).toBe(200);
    expect(delivered).toEqual(['one@limit.test', 'two@limit.test']);
  });

  it('is behind the per-key rate limit too', async () => {
    const slow = await issueKey(base, workspaceId, {
      scopes: [...LEGACY_KEY_SCOPES],
      rateLimitPerMin: 1,
    });
    const send = () =>
      request(app).post(`/v1/quotes/${quotes[11]}/send`).set('Authorization', `Bearer ${slow.key}`);
    await send();
    const second = await send();
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('rate_limited');
  });
});
