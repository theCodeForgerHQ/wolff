import { test, expect } from '@playwright/test';

test.describe('Widget performance', () => {
  test('lead form interaction stays under 300 ms on a throttled profile', async ({ page }) => {
    // Throttle CPU to emulate a low-end device.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    await page.goto('/');
    const input = page.locator('[data-wolff-widget="lead-form"] input').first();
    await input.waitFor({ state: 'visible', timeout: 10000 });

    const duration = await page.evaluate(async () => {
      const start = performance.now();
      const el = document.querySelector('[data-wolff-widget="lead-form"] input') as HTMLElement;
      el?.focus();
      // Force a style/layout flush so the browser processes the interaction.
      document.body.offsetHeight;
      return performance.now() - start;
    });

    expect(duration).toBeLessThan(300);
  });
});
