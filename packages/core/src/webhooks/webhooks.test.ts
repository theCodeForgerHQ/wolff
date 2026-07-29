import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import { decrypt } from '../encryption';
import type { CoreContext } from '../context';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  retryWebhookDelivery,
} from './endpoints';
import {
  MAX_CONSECUTIVE_FAILURES,
  WebhookDeliveryError,
  deliverWebhook,
  fanOutDomainEvent,
  recordDeliveryExhausted,
  type WebhookTransport,
} from './deliver';
import { verifyWebhookSignature, webhookHeaderNames } from './signature';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('outbound webhooks (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID();
  const originalKey = process.env.ENCRYPTION_KEY;
  let a: CoreContext;
  let b: CoreContext;
  let ownerId = '';

  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  let respond: () => Promise<{ status: number; body: string }>;
  const transport: WebhookTransport = {
    post: async (target, request) => {
      sent.push({ url: target, headers: request.headers, body: request.body });
      return respond();
    },
  };
  const deps = { transport, requireHttps: true };
  const event = (workspaceId: string, type = 'invoice.paid') => ({
    id: randomUUID(),
    workspaceId,
    type,
    payload: { invoiceId: 'inv_1', workspaceId },
    createdAt: new Date('2026-09-30T12:00:00Z'),
  });

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
    const owner = await base.user.create({ data: { email: `owner-${run}@example.test` } });
    ownerId = owner.id;
    const [wa, wb] = await Promise.all(
      ['a', 'b'].map((name) =>
        base.workspace.create({
          data: { name: `Hooks ${name}`, slug: `hooks-${name}-${run}`, ownerId },
        })
      )
    );
    a = { db, workspaceId: wa!.id };
    b = { db, workspaceId: wb!.id };
  });

  beforeEach(() => {
    sent.length = 0;
    respond = async () => ({ status: 200, body: 'ok' });
  });

  afterEach(async () => {
    const ids = [a.workspaceId, b.workspaceId];
    await base.outboxEvent.deleteMany({ where: { workspaceId: { in: ids } } });
    await base.webhookEndpoint.deleteMany({ where: { workspaceId: { in: ids } } });
    await base.notification.deleteMany({ where: { workspaceId: { in: ids } } });
  });

  afterAll(async () => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
    await base.workspace.deleteMany({ where: { id: { in: [a.workspaceId, b.workspaceId] } } });
    await base.user.deleteMany({ where: { id: ownerId } });
    await base.$disconnect();
  });

  const endpoint = (ctx: CoreContext, events = ['invoice.paid']) =>
    createWebhookEndpoint(ctx, { url: 'https://hooks.example.com/in', events }, deps);

  describe('endpoints', () => {
    it('returns the secret once and stores it encrypted', async () => {
      const created = await endpoint(a);

      expect(created.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
      const row = await base.webhookEndpoint.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.secret.startsWith('enc:')).toBe(true);
      expect(decrypt(row.secret)).toBe(created.secret);
      const [listed] = await listWebhookEndpoints(a);
      expect(listed).not.toHaveProperty('secret');
    });

    it.each([
      ['http://hooks.example.com/in', /https/],
      ['https://10.0.0.5/in', /private/],
      ['https://localhost/in', /private/],
    ])('refuses %s', async (target, reason) => {
      await expect(
        createWebhookEndpoint(a, { url: target, events: ['invoice.paid'] }, deps)
      ).rejects.toThrow(reason);
    });

    it('refuses an endpoint with no known event type', async () => {
      await expect(
        createWebhookEndpoint(a, { url: 'https://hooks.example.com/in', events: ['nope'] }, deps)
      ).rejects.toThrow(/event/);
    });

    it("does not show or delete another workspace's endpoint", async () => {
      const created = await endpoint(a);

      expect(await listWebhookEndpoints(b)).toEqual([]);
      expect(await deleteWebhookEndpoint(b, created.id)).toBe(false);
      expect(await listWebhookEndpoints(a)).toHaveLength(1);
      expect(await deleteWebhookEndpoint(a, created.id)).toBe(true);
    });
  });

  describe('fan-out', () => {
    it('creates one delivery and one job per subscribed, active endpoint of that workspace', async () => {
      const subscribed = await endpoint(a);
      await endpoint(a, ['quote.sent']);
      await endpoint(b);
      const e = event(a.workspaceId);

      const ids = await fanOutDomainEvent(db, e);

      expect(ids).toHaveLength(1);
      const delivery = await base.webhookDelivery.findUniqueOrThrow({ where: { id: ids[0]! } });
      expect(delivery).toMatchObject({
        endpointId: subscribed.id,
        workspaceId: a.workspaceId,
        eventType: 'invoice.paid',
        status: 'pending',
      });
      expect(delivery.payload).toMatchObject({
        id: e.id,
        type: 'invoice.paid',
        apiVersion: '2026-10',
      });
      const jobs = await base.outboxEvent.findMany({ where: { aggregateId: ids[0]! } });
      expect(jobs.map((j) => j.type)).toEqual(['webhook.deliver']);
    });

    it('creates nothing new when the same event is fanned out again', async () => {
      await endpoint(a);
      const e = event(a.workspaceId);

      const first = await fanOutDomainEvent(db, e);
      const second = await fanOutDomainEvent(db, e);

      expect(second).toEqual([]);
      expect(await base.webhookDelivery.count({ where: { workspaceId: a.workspaceId } })).toBe(1);
      expect(await base.outboxEvent.count({ where: { aggregateId: first[0]! } })).toBe(1);
    });
  });

  describe('delivery', () => {
    const prepare = async () => {
      const created = await endpoint(a);
      const e = event(a.workspaceId);
      const [deliveryId] = await fanOutDomainEvent(db, e);
      return { created, e, job: { deliveryId: deliveryId!, workspaceId: a.workspaceId } };
    };

    it('posts a signed body with the event id and API version headers', async () => {
      const { created, e, job } = await prepare();

      expect(await deliverWebhook(db, job, deps)).toBe('delivered');

      expect(sent).toHaveLength(1);
      const request = sent[0]!;
      expect(request.url).toBe('https://hooks.example.com/in');
      expect(JSON.parse(request.body)).toMatchObject({ id: e.id, type: 'invoice.paid' });
      expect(request.headers[webhookHeaderNames.eventId]).toBe(e.id);
      expect(request.headers[webhookHeaderNames.apiVersion]).toBe('2026-10');
      expect(
        verifyWebhookSignature(
          created.secret,
          request.body,
          request.headers[webhookHeaderNames.signature]!
        )
      ).toBe(true);
      const delivery = await base.webhookDelivery.findUniqueOrThrow({
        where: { id: job.deliveryId },
      });
      expect(delivery).toMatchObject({ status: 'delivered', statusCode: 200, attempts: 1 });
    });

    it('does not post again once delivered', async () => {
      const { job } = await prepare();
      await deliverWebhook(db, job, deps);

      expect(await deliverWebhook(db, job, deps)).toBe('skipped');
      expect(sent).toHaveLength(1);
    });

    it('throws on a non-2xx answer so the job is retried, and records the attempt', async () => {
      const { job } = await prepare();
      respond = async () => ({ status: 503, body: 'down' });

      await expect(deliverWebhook(db, job, deps)).rejects.toBeInstanceOf(WebhookDeliveryError);

      const delivery = await base.webhookDelivery.findUniqueOrThrow({
        where: { id: job.deliveryId },
      });
      expect(delivery).toMatchObject({ status: 'pending', statusCode: 503, attempts: 1 });
    });

    it('does not follow a redirect', async () => {
      const { job } = await prepare();
      respond = async () => ({ status: 302, body: '' });

      await expect(deliverWebhook(db, job, deps)).rejects.toThrow(/302/);
      expect(sent).toHaveLength(1);
    });

    it('refuses to call a stored URL that is no longer acceptable', async () => {
      const { created, job } = await prepare();
      await base.webhookEndpoint.update({
        where: { id: created.id },
        data: { url: 'https://169.254.169.254/latest' },
      });

      await expect(deliverWebhook(db, job, deps)).rejects.toThrow(/private/);
      expect(sent).toHaveLength(0);
    });

    it("does not deliver for a workspace other than the delivery's own", async () => {
      const { job } = await prepare();

      expect(await deliverWebhook(db, { ...job, workspaceId: b.workspaceId }, deps)).toBe(
        'skipped'
      );
      expect(sent).toHaveLength(0);
    });

    it('resets the failure count on success', async () => {
      const { created, job } = await prepare();
      await base.webhookEndpoint.update({ where: { id: created.id }, data: { failureCount: 7 } });

      await deliverWebhook(db, job, deps);

      const row = await base.webhookEndpoint.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.failureCount).toBe(0);
    });

    it('disables the endpoint and tells the owner after 20 exhausted deliveries in a row', async () => {
      const { created, job } = await prepare();
      await base.webhookEndpoint.update({
        where: { id: created.id },
        data: { failureCount: MAX_CONSECUTIVE_FAILURES - 1 },
      });

      await recordDeliveryExhausted(db, job);

      const row = await base.webhookEndpoint.findUniqueOrThrow({ where: { id: created.id } });
      expect(row).toMatchObject({ failureCount: MAX_CONSECUTIVE_FAILURES, isActive: false });
      expect(row.disabledAt).not.toBeNull();
      const delivery = await base.webhookDelivery.findUniqueOrThrow({
        where: { id: job.deliveryId },
      });
      expect(delivery.status).toBe('failed');
      const notes = await base.notification.findMany({ where: { workspaceId: a.workspaceId } });
      expect(notes.map((n) => [n.userId, n.type])).toEqual([
        [ownerId, 'webhook_endpoint_disabled'],
      ]);

      // A disabled endpoint receives nothing further.
      expect(await fanOutDomainEvent(db, event(a.workspaceId))).toEqual([]);
    });

    it('queues a failed delivery again on request, only for its own workspace', async () => {
      const { job } = await prepare();
      await recordDeliveryExhausted(db, job);

      expect(await retryWebhookDelivery(b, job.deliveryId)).toBe(false);
      expect(await retryWebhookDelivery(a, job.deliveryId)).toBe(true);

      const delivery = await base.webhookDelivery.findUniqueOrThrow({
        where: { id: job.deliveryId },
      });
      expect(delivery.status).toBe('pending');
      expect(
        await base.outboxEvent.count({ where: { aggregateId: job.deliveryId, status: 'pending' } })
      ).toBe(2);
    });

    it('pages deliveries newest first with an opaque cursor, inside the workspace', async () => {
      const created = await endpoint(a);
      for (let i = 0; i < 3; i++) await fanOutDomainEvent(db, event(a.workspaceId));

      const first = await listWebhookDeliveries(a, created.id, { limit: 2 });
      const second = await listWebhookDeliveries(a, created.id, {
        limit: 2,
        cursor: first!.meta.nextCursor!,
      });

      expect(first!.data).toHaveLength(2);
      expect(first!.meta).toMatchObject({ hasMore: true });
      expect(second!.data).toHaveLength(1);
      expect(second!.meta).toEqual({ hasMore: false, nextCursor: null });
      expect(await listWebhookDeliveries(b, created.id, { limit: 2 })).toBeNull();
      vi.restoreAllMocks();
    });
  });
});
