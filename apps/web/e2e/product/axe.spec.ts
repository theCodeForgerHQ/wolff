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

/**
 * The main dashboard pages at a phone and a desktop width: no serious or
 * critical violations. Moderate and minor findings are listed
 * in docs/phase-7.md rather than asserted here.
 */
test.describe('Main pages, serious and critical only', () => {
  const PAGES = [
    '/dashboard',
    '/dashboard/analytics',
    '/quotes',
    '/invoices',
    '/clients',
    '/leads',
    '/settings',
  ];
  for (const path of PAGES) {
    for (const width of [375, 1440]) {
      test(`${path} at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const results = await new AxeBuilder({ page }).analyze();
        const blocking = results.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
        expect(blocking).toEqual([]);
      });
    }
  }
});
