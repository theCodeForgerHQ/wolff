import type { Page } from '@playwright/test';

/**
 * Waits until dnd-kit's KeyboardSensor listens for the keys that move a
 * picked-up item.
 *
 * On pick-up (Space) the sensor starts the drag at once but adds its
 * keydown listener in a `setTimeout` (so the Space that activated it is not
 * also read as "drop"). While the page renders the drag, that timer fires
 * 10-30 ms later, after the pick-up is already announced; an arrow key
 * pressed in between is lost. Measured on 2026-10-06: in 8 of 8 failing
 * runs the arrow key arrived before the listener, in 2 of 2 passing runs
 * after it.
 *
 * A zero-delay timer queued now runs after the sensor's (timers with equal
 * or shorter delays run in the order they were set, HTML spec), so this
 * resolves once the listener is in place, without guessing a delay.
 */
export async function untilKeyboardSensorListens(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}
