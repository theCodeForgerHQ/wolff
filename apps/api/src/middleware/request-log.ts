import type { IncomingMessage } from 'node:http';
import { pinoHttp, type Options } from 'pino-http';
import { REDACT_PATHS, type Logger } from '@wolff/core/logger';

/**
 * Headers that carry credentials of the platform rather than the caller:
 * Vercel's deployment-protection bypass and the per-request OIDC token.
 */
const REQUEST_REDACT_PATHS = [
  ...REDACT_PATHS,
  'req.headers["x-vercel-protection-bypass"]',
  'req.headers["x-vercel-oidc-token"]',
  'req.headers["x-api-key"]',
  'req.headers["upstash-signature"]',
];

/**
 * The path only. Query strings carry tokens: Vercel's protection bypass on
 * Stripe and Razorpay webhook URLs, and anything a client puts there. No
 * route of this API needs its query string in the access log.
 */
export function pathOnly(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

type SerializedRequest = { url?: string; query?: unknown } & Record<string, unknown>;

/** pino-http with credentials and query strings kept out of the log. */
export function requestLogger(logger: Logger, options: { autoLogging: boolean }) {
  const config: Options<IncomingMessage> = {
    logger,
    redact: { paths: REQUEST_REDACT_PATHS, censor: '[REDACTED]' },
    autoLogging: options.autoLogging,
    serializers: {
      // Express also exposes the parsed query, which pino-http logs as `query`.
      req: ({ query: _query, ...req }: SerializedRequest) => ({ ...req, url: pathOnly(req.url) }),
    },
  };
  return pinoHttp(config);
}
