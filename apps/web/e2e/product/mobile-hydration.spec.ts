import { expect, test } from '@playwright/test';

/**
 * On a phone-sized screen the dashboard pages used to fail hydration: the
 * sidebar arrives in a streamed Suspense boundary, and by then the client
 * already knew it was on mobile and rendered the drawer where the server had
 * rendered the desktop sidebar. React reported error #418, and the global
 * error handler showed every user an "An unexpected error occurred" toast.
 */
for (const path of ['/dashboard', '/quotes', '/invoices']) {
  test(`${path} hydrates without an error at 375px`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && /418|[Hh]ydration/.test(message.text())) {
        errors.push(message.text().slice(0, 200));
      }
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(path);
    await page.waitForLoadState('networkidle');

    expect(errors).toEqual([]);
    await expect(page.getByText('An unexpected error occurred.')).toHaveCount(0);
  });
}

test('the mobile menu still opens the sidebar drawer after hydration', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Invoices' })).toBeVisible();
});
