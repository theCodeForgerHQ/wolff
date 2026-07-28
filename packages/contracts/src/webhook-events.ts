/** Event types a webhook endpoint can subscribe to. */
export const WEBHOOK_EVENT_TYPES = [
  'quote.created',
  'quote.sent',
  'quote.accepted',
  'quote.declined',
  'invoice.created',
  'invoice.sent',
  'invoice.paid',
  'invoice.voided',
  'payment.received',
  'payment.refunded',
  'client.created',
  'credit_note.issued',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}
