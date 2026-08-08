import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Widget accessibility', () => {
  test('lead form is axe clean', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector(
      '[data-wolff-widget="lead-form"] input, [data-wolff-widget="lead-form"] button',
      {
        timeout: 10000,
      }
    );

    const results = await new AxeBuilder({ page })
      .include('[data-wolff-widget="lead-form"]')
      .analyze();

    expect(results.violations).toEqual([]);
  });
});
