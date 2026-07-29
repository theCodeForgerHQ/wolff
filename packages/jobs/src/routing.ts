import { isWebhookEventType } from '@wolff/contracts';
import type { RelayedOutboxEvent } from '@wolff/core/outbox';
import { isJobType, jobPayloads, type Job, type JobType } from './types';

/** Outbox event types that are themselves a job, with the same name. */
const DIRECT: Record<string, JobType> = {
  'payment.reconcile': 'payments.reconcile',
  'webhook.deliver': 'webhooks.deliver',
  'email.send': 'email.send',
  'email.payment_received': 'email.payment_received',
  'pdf.render': 'pdf.render',
};

/**
 * Decides which job works off an outbox event. Domain events (`invoice.paid`
 * and the like) become a webhook fan-out. Returns null for a type nothing
 * handles; the relay records that on the event instead of dropping it.
 *
 * The job id is `outbox:<event id>`, so an event relayed twice is queued once.
 */
export function jobForOutboxEvent(event: RelayedOutboxEvent): Job | null {
  const base = {
    jobId: `outbox:${event.id}`,
    outboxEventId: event.id,
    traceId: event.traceId ?? undefined,
  };
  const stored =
    typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
      ? event.payload
      : {};

  const direct = DIRECT[event.type];
  if (direct && isJobType(direct)) {
    // The workspace is taken from the event row, never from the payload alone.
    const candidate = {
      ...stored,
      ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
    };
    const parsed = jobPayloads[direct].safeParse(candidate);
    if (!parsed.success) return null;
    return { ...base, type: direct, payload: parsed.data } as Job;
  }
  if (isWebhookEventType(event.type) && event.workspaceId) {
    return { ...base, type: 'webhooks.fanout', payload: { outboxEventId: event.id } };
  }
  return null;
}
