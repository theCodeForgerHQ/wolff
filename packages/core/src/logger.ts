import pino from 'pino';

/**
 * Logger for code that runs outside a request framework (core, api, worker).
 *
 * The redaction list is the one the design asks for: credentials and the personal
 * fields leads and clients carry. It is always on, because these processes
 * write to shared log stores in every environment that has one.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'email',
  'phone',
  'pan',
  '*.email',
  '*.phone',
  '*.pan',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  enabled: process.env.NODE_ENV !== 'test' || process.env.LOG_LEVEL !== undefined,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
});

export type Logger = typeof logger;
