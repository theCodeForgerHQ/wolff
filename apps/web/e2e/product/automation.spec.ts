import { test, expect } from '@playwright/test';
import { prisma } from '@wolff/database';

test.afterAll(async () => {
  await prisma.automation.deleteMany({ where: { name: { startsWith: 'E2E ' } } });
  await prisma.$disconnect();
});

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

    const card = page.getByTestId('automation-card').filter({ hasText: name });
    await expect(card).toBeVisible();

    // Open edit and pause
    await card.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('switch').click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).not.toBeVisible();

    await expect(card.getByText('Paused')).toBeVisible();
  });
  test('reorders steps with the keyboard and refuses an email step without a template', async ({
    page,
  }) => {
    await page.goto('/automations');
    await page.getByRole('button', { name: 'New automation' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(`E2E Reorder ${Date.now()}`);
    await dialog.getByRole('button', { name: 'Approval' }).click();

    // Steps are [Wait, Approval]; move the approval to the top.
    const steps = dialog.getByTestId('automation-step');
    const announced = page.locator('[id^="DndLiveRegion"]').first();
    await dialog.getByRole('button', { name: 'Reorder step 2' }).focus();
    await page.keyboard.press('Space');
    await expect(announced).toContainText('at position 2');
    await page.keyboard.press('ArrowUp');
    await expect(announced).toContainText('at position 1');
    await page.keyboard.press('Space');
    await expect(announced).toContainText('dropped at position 1');
    await expect(steps.nth(0)).toContainText('Approval');
    await expect(steps.nth(1)).toContainText('Wait');

    // An email step needs a template: the form refuses to save without one.
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText('Choose one')).toBeVisible();
    await expect(dialog).toBeVisible();
  });
});
