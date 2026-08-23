/**
 * Creates or updates the QStash schedules of the deployed API
 * (QSTASH_SCHEDULES in @wolff/jobs/qstash). Run once after a deploy that
 * changes them:
 *
 *   QSTASH_TOKEN=... PUBLIC_API_URL=https://<api> pnpm --filter @wolff/api schedules:sync
 *
 * Idempotent. SCHEDULE_PREFIX (default "wolff") names this deployment's
 * schedules; only those are touched.
 */
import { Client } from '@upstash/qstash';
import { syncQStashSchedules } from '@wolff/jobs/qstash';

const token = process.env.QSTASH_TOKEN;
const apiUrl = process.env.PUBLIC_API_URL;
if (!token || !apiUrl) {
  console.error('QSTASH_TOKEN and PUBLIC_API_URL are required');
  process.exit(1);
}

// No top-level await: tsx runs this package's scripts as CommonJS.
syncQStashSchedules(
  new Client({ token, baseUrl: process.env.QSTASH_URL }),
  apiUrl,
  process.env.SCHEDULE_PREFIX ?? 'wolff'
).then(
  (ids) => console.log(`Synced ${ids.length} schedules: ${ids.join(', ')}`),
  (error: unknown) => {
    console.error('Schedule sync failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
