import { describe, expect, it } from 'vitest';
import { DRAIN_SCHEDULE, SCHEDULES } from './bullmq';

describe('the drain schedule', () => {
  it('runs every job the scheduler would have fired, including automations.tick', () => {
    const scheduled = Object.values(SCHEDULES).map((s) => s.type);

    expect([...DRAIN_SCHEDULE].sort()).toEqual([...scheduled].sort());
    expect(DRAIN_SCHEDULE).toContain('automations.tick');
  });
});
