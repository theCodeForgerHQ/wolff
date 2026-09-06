import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A webhook delivery gets 8 attempts over about two days. On QStash
 * a failed job is retried 3 times within about half an hour, so a receiver
 * down for longer lost the event. On the push runtime the processor
 * schedules the next attempt itself, with the design's delay.
 */
const core = vi.hoisted(() => {
  class WebhookDeliveryError extends Error {}
  return {
    WebhookDeliveryError,
    deliverWebhook: vi.fn(),
    recordDeliveryExhausted: vi.fn(),
  };
});
vi.mock('@wolff/core/webhooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...core,
}));

import { processors } from './processors';
import { WEBHOOK_RETRY_DELAYS_MS } from './run';
import type { Job, JobContext } from './types';

const job = { deliveryId: 'd-1', workspaceId: 'ws-1' };
const NOW = new Date('2026-11-07T10:00:00Z');

function context(attempts: number, selfScheduledRetries = true) {
  const dispatched: Job[] = [];
  const update = vi.fn();
  const ctx = {
    selfScheduledRetries,
    now: () => NOW,
    dispatch: async (j: Job) => void dispatched.push(j),
    db: {
      webhookDelivery: {
        findFirst: vi.fn().mockResolvedValue({ attempts }),
        updateMany: update,
      },
    },
  } as unknown as JobContext;
  return { ctx, dispatched, update };
}

describe('webhook delivery retries on the push runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    core.deliverWebhook.mockRejectedValue(new core.WebhookDeliveryError('Endpoint answered 503'));
  });

  it.each(WEBHOOK_RETRY_DELAYS_MS.map((delay, i) => [i + 1, delay]))(
    'after attempt %i schedules the next one in %i ms, and answers success',
    async (attempts, delay) => {
      const { ctx, dispatched, update } = context(attempts);
      await expect(processors['webhooks.deliver'](ctx, job)).resolves.toBeUndefined();
      expect(dispatched).toEqual([
        {
          type: 'webhooks.deliver',
          payload: job,
          jobId: `webhook-retry:d-1:${attempts}`,
          delayMs: delay,
        },
      ]);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'd-1', workspaceId: 'ws-1' },
        data: { nextRetry: new Date(NOW.getTime() + delay) },
      });
      expect(core.recordDeliveryExhausted).not.toHaveBeenCalled();
    }
  );

  it('records the delivery as exhausted after the last attempt, and schedules nothing', async () => {
    const { ctx, dispatched } = context(WEBHOOK_RETRY_DELAYS_MS.length + 1);
    await processors['webhooks.deliver'](ctx, job);
    expect(dispatched).toEqual([]);
    expect(core.recordDeliveryExhausted).toHaveBeenCalledWith(ctx.db, job);
  });

  it('leaves retries to the queue on a worker host', async () => {
    const { ctx, dispatched } = context(1, false);
    await expect(processors['webhooks.deliver'](ctx, job)).rejects.toThrow('503');
    expect(dispatched).toEqual([]);
  });

  it('still throws an error that is not a failed attempt', async () => {
    core.deliverWebhook.mockRejectedValue(new Error('database down'));
    const { ctx, dispatched } = context(1);
    await expect(processors['webhooks.deliver'](ctx, job)).rejects.toThrow('database down');
    expect(dispatched).toEqual([]);
  });
});
