import { expect, test } from '@playwright/test';

/**
 * No dashboard page may scroll sideways at the widths we support. Wide
 * content (tables, the Kanban board) scrolls inside its own container.
 * Before the fix, the main column grew with its widest child, so at 768
 * and 1024 px the whole page, header included, was up to 264 px wider than
 * the screen.
 *
 * Two measurements: the document, and the layout's <main>. <main> is
 * itself a scroll container (overflow: auto), so content too wide for the
 * page scrolls inside it and never widens the document; checking only the
 * document would miss it.
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
      const [page_, main] = await page.evaluate(() => {
        const doc = document.documentElement;
        const el = document.querySelector('main');
        return [doc.scrollWidth - doc.clientWidth, el ? el.scrollWidth - el.clientWidth : 0];
      });
      if (page_ > 0) overflow.push(`${width}px: page +${page_}px`);
      if (main > 0) overflow.push(`${width}px: main +${main}px`);
    }
    expect(overflow).toEqual([]);
  });
}
