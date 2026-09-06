import type { JobType } from './types';

/**
 * On Vercel + QStash every scheduled run is a function invocation that wakes
 * the database (Neon suspends 5 minutes after the last query). Running the
 * frequent jobs as one hourly tick, in one invocation, wakes it once an hour
 * instead of every few minutes, which is what used up the free compute
 * quota in September 2026. A worker host keeps its own schedules (bullmq.ts).
 */
export type TickStep = Extract<
  JobType,
  | 'automations.tick'
  | 'recurring.generate'
  | 'invoices.mark_overdue'
  | 'reminders.scan'
  | 'outbox.sweep'
>;

/** What the tick at `hourUtc` runs, in order. */
export function tickSteps(hourUtc: number): TickStep[] {
  return [
    'automations.tick',
    'recurring.generate',
    ...(hourUtc === 0 ? (['invoices.mark_overdue'] as const) : []),
    ...(hourUtc === 3 ? (['reminders.scan'] as const) : []),
    // Last: it relays the emails and webhooks the steps above just created,
    // so they go out in this run rather than an hour later.
    'outbox.sweep',
  ];
}

/** Every step a scheduled tick can run, at some hour. */
export const ALL_TICK_STEPS: TickStep[] = [...new Set([0, 3].flatMap(tickSteps))];

/**
 * Runs the steps in order. A failing step does not stop the ones after it
 * (the relay must still run); the tick fails at the end with every error.
 */
export async function runTickSteps(
  steps: TickStep[],
  run: (type: TickStep) => Promise<void>
): Promise<void> {
  const failures: { type: TickStep; error: unknown }[] = [];
  for (const type of steps) {
    try {
      await run(type);
    } catch (error) {
      failures.push({ type, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `Scheduled tick: ${failures.map((f) => f.type).join(', ')} failed`
    );
  }
}
