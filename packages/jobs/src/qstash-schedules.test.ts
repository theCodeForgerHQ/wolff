import { describe, expect, it } from 'vitest';
import { SCHEDULES } from './bullmq';
import { QSTASH_SCHEDULES, syncQStashSchedules, type QStashScheduleClient } from './qstash';
import { isJobType } from './types';

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
  it('covers every scheduled job type, within the free tier (10 schedules)', () => {
    const types = Object.values(QSTASH_SCHEDULES).map((s) => s.type);
    expect(new Set(types)).toEqual(new Set(Object.values(SCHEDULES).map((s) => s.type)));
    expect(Object.keys(QSTASH_SCHEDULES).length).toBeLessThanOrEqual(10);
    for (const type of types) expect(isJobType(type)).toBe(true);
  });

  it('fires at most every 15 minutes, and leaves most of 1,000 messages a day for jobs', () => {
    let perDay = 0;
    for (const { cron } of Object.values(QSTASH_SCHEDULES)) {
      expect(runsPerDay(cron)).toBeLessThanOrEqual(DAY_MINUTES / 15);
      perDay += runsPerDay(cron);
    }
    expect(perDay).toBeLessThanOrEqual(300);
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
          { scheduleId: 'wolff-outbox-sweep' },
          { scheduleId: 'wolff-retired' },
          { scheduleId: 'someone-else' },
        ],
        delete: async (id) => void deleted.push(id),
      },
    };

    const ids = await syncQStashSchedules(client, 'https://api.example.test/', 'wolff');

    expect(ids).toHaveLength(Object.keys(QSTASH_SCHEDULES).length);
    const outbox = created.find((c) => c.scheduleId === 'wolff-outbox-sweep')!;
    expect(outbox).toMatchObject({
      destination: 'https://api.example.test/jobs/run/outbox.sweep',
      cron: QSTASH_SCHEDULES['outbox-sweep']!.cron,
    });
    expect(JSON.parse(String(outbox.body))).toEqual({
      type: 'outbox.sweep',
      payload: {},
      jobId: 'scheduled:outbox-sweep',
    });
    // Ours that are no longer defined go; other projects' schedules stay.
    expect(deleted).toEqual(['wolff-retired']);
  });
});
