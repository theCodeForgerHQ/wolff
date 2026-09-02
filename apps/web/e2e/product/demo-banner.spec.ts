import { expect, test } from '@playwright/test';

/**
 * The demo-mode banner must not cover the header: it used to be fixed at
 * the top of the viewport, over the header's buttons (assistant, theme,
 * notifications), which could not be clicked until it was dismissed.
 */
for (const width of [375, 1440]) {
  test(`the demo banner leaves the header usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dashboard');

    const banner = page.getByRole('complementary', { name: 'Demo mode' });
    const header = page.locator('header').first();
    await expect(banner).toBeVisible();

    const bannerBox = (await banner.boundingBox())!;
    const headerBox = (await header.boundingBox())!;
    const overlap =
      bannerBox.y < headerBox.y + headerBox.height && headerBox.y < bannerBox.y + bannerBox.height;
    expect(overlap, 'banner overlaps the header').toBe(false);

    // A click lands on the header button itself, not on the banner.
    await page.getByRole('button', { name: 'Notifications' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
  });
}
