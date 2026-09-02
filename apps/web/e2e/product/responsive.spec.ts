import { expect, test } from '@playwright/test';

/**
 * No dashboard page may scroll sideways at the widths we support. Wide
 * content (tables, the Kanban board) scrolls inside its own container.
 * Before the fix, the main column grew with its widest child, so at 768
 * and 1024 px the whole page, header included, was up to 264 px wider than
 * the screen.
 */
const WIDTHS = [320, 375, 768, 1024, 1440, 1920];
const PAGES = [
  '/dashboard',
  '/quotes',
  '/invoices',
  '/clients',
  '/leads',
  '/deals',
  '/automations',
];

for (const path of PAGES) {
  test(`${path} has no horizontal page overflow`, async ({ page }) => {
    const overflow: string[] = [];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const extra = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      if (extra > 0) overflow.push(`${width}px: +${extra}px`);
    }
    expect(overflow).toEqual([]);
  });
}
