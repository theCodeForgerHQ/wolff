const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 8 attempts, waiting 1m, 5m, 30m, 2h, 6h, 12h, 24h between them. */
export const WEBHOOK_RETRY_DELAYS_MS = [
  MINUTE,
  5 * MINUTE,
  30 * MINUTE,
  2 * HOUR,
  6 * HOUR,
  12 * HOUR,
  24 * HOUR,
];
