import { expect, test } from '@playwright/test';

/**
 * Phase 5 DoD: a drafted quote opens in the builder and saves.
 * Runs against the real web app, apps/api and the AI service (offline
 * model), so the draft goes web -> ai -> api /internal/quotes/draft.
 */
test('a drafted quote opens in the builder and saves', async ({ page }) => {
  await page.goto('/dashboard');
  // The demo-mode banner is fixed over the top of the header (a known
  // layout issue, see docs/phase-5.md); dismiss it as a user would.
  await page.getByRole('button', { name: 'Dismiss banner' }).click();
  await page.getByRole('button', { name: 'Open the assistant' }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant' });

  // A question first: the chat streams an answer from the SQL tools.
  await panel.getByLabel('Ask the assistant').fill('Which invoices are overdue?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByRole('log')).toContainText('Here is what I found', { timeout: 30_000 });

  await panel.getByRole('tab', { name: 'Draft a quote' }).click();
  await panel
    .getByLabel('Quote brief')
    .fill('Draft a quote for TechStart Inc.: brand identity and a logo design package');
  await panel.getByRole('button', { name: 'Draft' }).click();
  const draft = panel.getByRole('region', { name: 'Drafted quote' });
  await expect(draft).toBeVisible({ timeout: 30_000 });
  await expect(draft.getByRole('listitem').filter({ hasText: 'Brand Identity' })).toBeVisible();

  await draft.getByRole('link', { name: 'Open in builder' }).click();
  await page.waitForURL(/\/quotes\/[^/]+\/builder$/);
  const quoteUrl = page.url();
  await expect(page.getByText('Brand Identity').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Logo Design Package').first()).toBeVisible();

  await expect(panel).toBeHidden();

  // Change a quantity so the builder has something to save, then save.
  const quantity = () =>
    page
      .locator('div.space-y-2', { has: page.getByText('Quantity', { exact: true }) })
      .locator('input[type="number"]')
      .first();
  await page.getByRole('heading', { name: 'Brand Identity', level: 4 }).click();
  await quantity().fill('2');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator('[data-sonner-toast]').first()).toContainText(/saved/i, {
    timeout: 15_000,
  });

  await page.goto(quoteUrl);
  await page.getByRole('heading', { name: 'Brand Identity', level: 4 }).click();
  await expect(quantity()).toHaveValue('2');
});
