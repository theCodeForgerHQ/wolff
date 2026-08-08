import { test, expect } from '@playwright/test';

test.describe('Automation builder', () => {
  test('creates and edits a follow-up automation', async ({ page }) => {
    const run = Date.now();
    const name = `E2E Automation ${run}`;

    await page.goto('/automations');
    await page.getByRole('button', { name: 'New automation' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Name').fill(name);
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Invoice overdue' }).click();

    // Add an approval step
    await dialog.getByRole('button', { name: 'Approval' }).click();
    await expect(dialog.getByText('Step 2')).toBeVisible();

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).not.toBeVisible();

    await expect(page.getByText(name)).toBeVisible();

    // Open edit and pause
    await page.getByText(name).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('switch').click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).not.toBeVisible();

    await expect(page.getByText(name).locator('..').getByText('Paused')).toBeVisible();
  });
});
