import { test, expect } from '@playwright/test';

/**
 * End-to-end smoke test for the Phase 3 CRM + payment flow.
 *
 * Because the Razorpay provider requires live test credentials and an external
 * webhook reconcile worker, this test exercises the user-facing path up to a
 * paid invoice via manual payment recording. The Razorpay webhook acceptance
 * and reconcile logic are covered by API unit tests in
 * apps/api/src/webhooks/webhooks.test.ts.
 */
test.describe('Lead to paid flow', () => {
  test('creates a widget lead, converts to deal, creates a quote and records payment', async ({
    page,
  }) => {
    const run = Date.now();
    const leadName = `E2E Lead ${run}`;
    const company = `E2E Corp ${run}`;

    // 1. Create a lead from the widget/source manual path
    await page.goto('/leads');
    await page.getByTestId('add-lead-button').click();

    const dialog = page.getByRole('dialog', { name: 'Add Lead' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Name *').fill(leadName);
    await dialog.getByLabel('Email').fill(`lead-${run}@example.com`);
    await dialog.getByLabel('Company').fill(company);
    await dialog.getByLabel('Score').fill('75');

    // Source = widget to match the spec language
    await dialog.getByRole('combobox', { name: 'Source' }).click();
    await page.getByRole('option', { name: 'Widget' }).click();

    await dialog.getByRole('button', { name: 'Create Lead' }).click();
    await expect(dialog).not.toBeVisible();

    // 2. Verify lead appears and convert it to a deal
    await expect(page.getByText(leadName)).toBeVisible();

    const row = page.locator('tr', { hasText: leadName });
    await row.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('menuitem', { name: 'Convert to Deal' }).click();

    const confirmDialog = page.getByRole('alertdialog');
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Convert' }).click();

    // 3. Verify deal appears on the board and create a quote from it
    await page.waitForURL('/deals');
    await expect(page.getByText(leadName)).toBeVisible();

    const card = page.locator('[data-testid="deal-card"]', { hasText: leadName }).first();
    await expect(card).toBeVisible();
    await card.locator('[data-testid="create-quote-button"]').click();

    // Should land on the quote editor for the new draft quote
    await page.waitForURL(/\/quotes\/[0-9a-f-]+\/edit/);
    await expect(page.getByRole('heading', { name: 'Edit Quote' })).toBeVisible();

    // 4. Record payment against an existing unpaid invoice
    await page.goto('/invoices');
    const unpaidStatuses = /Sent|Overdue|Partially Paid|Partial/i;
    const invoiceRow = page.locator('tr', { hasText: unpaidStatuses }).first();
    await expect(invoiceRow).toBeVisible();
    // The table is server-rendered: a click that lands before hydration
    // opens nothing (seen in 2 of 7 runs, the trigger still carrying its
    // server-rendered id). Click again until the menu is there.
    const recordPayment = page.getByRole('menuitem', { name: /record payment/i });
    await expect(async () => {
      await invoiceRow.getByRole('button', { name: 'Open menu' }).click();
      await expect(recordPayment).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await recordPayment.click();

    const paymentDialog = page.getByRole('dialog');
    await expect(paymentDialog).toBeVisible();

    // Fill amount with a small positive value
    const amountInput = paymentDialog.getByLabel(/amount/i);
    await amountInput.fill('1');
    await paymentDialog.getByRole('button', { name: /record|save|confirm/i }).click();

    // Payment dialog should close and a success toast appears
    await expect(paymentDialog).not.toBeVisible();
    await expect(page.getByText(/payment recorded|success/i).first()).toBeVisible();
  });
});
