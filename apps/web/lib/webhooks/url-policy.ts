import { checkWebhookUrl, createHttpTransport, PRIVATE_ADDRESS } from '@wolff/core/webhooks';

export { PRIVATE_ADDRESS };

/**
 * The web app's rules for workspace webhook URLs, the same as the API's
 * (packages/core/src/webhooks): https in production, never a private,
 * loopback or link-local address. Returns the reason a URL is refused, or
 * null.
 */
export function webhookUrlProblem(url: string): string | null {
  return checkWebhookUrl(url.trim(), { requireHttps: process.env.NODE_ENV === 'production' });
}

/**
 * Sends one POST without following redirects, and resolves the host with a
 * lookup that refuses private addresses at connect time, so a host name that
 * resolves (or later re-resolves) to one is refused too.
 */
export const webhookTransport = createHttpTransport({
  allowPrivateAddresses: process.env.NODE_ENV === 'development',
});
