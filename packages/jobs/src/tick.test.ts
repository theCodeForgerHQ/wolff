import { describe, expect, it } from 'vitest';
import { runTickSteps, tickSteps } from './tick';

describe('the hourly scheduled tick', () => {
  it('runs automations and recurring invoices every hour, and relays the outbox last', () => {
    for (const hour of [1, 7, 13, 23]) {
      expect(tickSteps(hour)).toEqual(['automations.tick', 'recurring.generate', 'outbox.sweep']);
    }
  });

  it('marks invoices overdue at 00:00 UTC and scans reminders at 03:00 UTC', () => {
    expect(tickSteps(0)).toEqual([
      'automations.tick',
      'recurring.generate',
      'invoices.mark_overdue',
      'outbox.sweep',
    ]);
    expect(tickSteps(3)).toContain('reminders.scan');
    expect(tickSteps(3).at(-1)).toBe('outbox.sweep');
  });

  it('runs every step even when one fails, then fails with all the errors', async () => {
    const ran: string[] = [];
    const run = async (type: string) => {
      ran.push(type);
      if (type === 'automations.tick') throw new Error('automations broke');
    };
    await expect(runTickSteps(tickSteps(0), run)).rejects.toThrow(/automations\.tick/);
    // The relay still ran, so the emails the other steps created went out.
    expect(ran).toEqual(tickSteps(0));
  });

  it('succeeds quietly when every step does', async () => {
    await expect(runTickSteps(tickSteps(5), async () => {})).resolves.toBeUndefined();
  });
});
