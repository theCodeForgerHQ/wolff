import { describe, expect, it } from 'vitest';
import { SCHEDULES } from './bullmq';
import { QSTASH_SCHEDULES, syncQStashSchedules, type QStashScheduleClient } from './qstash';
import { isJobType } from './types';
import { ALL_TICK_STEPS } from './tick';

const DAY_MINUTES = 24 * 60;

/** Runs per day of a cron with a minute field and an hour field (the forms used here). */
function runsPerDay(cron: string): number {
  const [minute, hour] = cron.split(' ');
  const count = (field: string, size: number) =>
    field === '*'
      ? size
      : field.startsWith('*/')
        ? size / Number(field.slice(2))
        : field.split(',').length;
  return count(minute!, 60) * count(hour!, 24);
}

describe('QStash schedules', () => {
  it('covers every job the worker schedules, directly or in the tick, within 10 schedules', () => {
    const types = Object.values(QSTASH_SCHEDULES).map((s) => s.type);
    const covered = new Set<string>([...types, ...ALL_TICK_STEPS]);
    for (const { type } of Object.values(SCHEDULES)) expect(covered).toContain(type);
    expect(Object.keys(QSTASH_SCHEDULES).length).toBeLessThanOrEqual(10);
    for (const type of types) expect(isJobType(type)).toBe(true);
  });

  it('backs up the database once a week, after the nightly reports', () => {
    expect(QSTASH_SCHEDULES.backup).toEqual({ type: 'db.backup', cron: '0 21 * * 0' });
  });

  it('wakes the database at most once an hour: every schedule fires at minute 0', () => {
    // Neon suspends 5 minutes after the last query. Schedules spread across
    // the hour kept it awake most of the day and used up the free compute
    // quota (2026-10-24); runs that share a minute share one wake-up.
    for (const { cron } of Object.values(QSTASH_SCHEDULES)) {
      expect(cron.split(' ')[0]).toBe('0');
      expect(runsPerDay(cron)).toBeLessThanOrEqual(24);
    }
  });

  it('uses a small part of the 1,000 messages a day', () => {
    const perDay = Object.values(QSTASH_SCHEDULES).reduce((n, { cron }) => n + runsPerDay(cron), 0);
    expect(perDay).toBeLessThanOrEqual(30);
  });

  it('does not retry a scheduled run: the next run comes within 30 minutes', async () => {
    const created: Record<string, unknown>[] = [];
    const client: QStashScheduleClient = {
      schedules: {
        create: async (request) => {
          created.push(request);
          return { scheduleId: request.scheduleId! };
        },
        list: async () => [],
        delete: async () => undefined,
      },
    };

    await syncQStashSchedules(client, 'https://api.example.test', 'wolff');

    expect(created.length).toBeGreaterThan(0);
    for (const request of created) expect(request.retries).toBe(0);
  });

  it('creates or updates each schedule under a stable id with a signed job body', async () => {
    const created: Record<string, unknown>[] = [];
    const deleted: string[] = [];
    const client: QStashScheduleClient = {
      schedules: {
        create: async (request) => {
          created.push(request);
          return { scheduleId: request.scheduleId! };
        },
        list: async () => [
          { scheduleId: 'wolff-tick' },
          // Retired by the hourly tick.
          { scheduleId: 'wolff-outbox-sweep' },
          { scheduleId: 'someone-else' },
        ],
        delete: async (id) => void deleted.push(id),
      },
    };

    const ids = await syncQStashSchedules(client, 'https://api.example.test/', 'wolff');

    expect(ids).toHaveLength(Object.keys(QSTASH_SCHEDULES).length);
    const tick = created.find((c) => c.scheduleId === 'wolff-tick')!;
    expect(tick).toMatchObject({
      destination: 'https://api.example.test/jobs/run/scheduled.tick',
      cron: '0 * * * *',
    });
    expect(JSON.parse(String(tick.body))).toEqual({
      type: 'scheduled.tick',
      payload: {},
      jobId: 'scheduled:tick',
    });
    // Ours that are no longer defined go; other projects' schedules stay.
    expect(deleted).toEqual(['wolff-outbox-sweep']);
  });
});
