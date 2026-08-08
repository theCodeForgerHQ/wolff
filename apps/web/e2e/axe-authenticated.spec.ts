import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function expectAxeClean(page: typeof test.prototype.page, selector?: string) {
  const builder = new AxeBuilder({ page });
  if (selector) builder.include(selector);
  const results = await builder.analyze();
  if (results.violations.length > 0) {
    console.log(
      JSON.stringify(
        results.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({ html: n.html, target: n.target })),
        })),
        null,
        2
      )
    );
  }
  expect(results.violations).toEqual([]);
}

test.describe('Authenticated axe checks', () => {
  test('quote builder is axe clean', async ({ page }) => {
    await page.goto('/quotes/new/builder');
    await page.waitForLoadState('networkidle');
    await expectAxeClean(page, '[data-testid="quote-builder"]');
  });

  test('deals Kanban is axe clean', async ({ page }) => {
    await page.goto('/deals');
    await page.waitForLoadState('networkidle');
    await expectAxeClean(page);
  });

  test('automations page is axe clean', async ({ page }) => {
    await page.goto('/automations');
    await page.waitForLoadState('networkidle');
    await expectAxeClean(page);
  });
});
