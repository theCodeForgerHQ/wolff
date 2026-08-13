import { expect, test as setup } from '@playwright/test';
import path from 'node:path';

/**
 * Signs the seeded demo user in once and saves the session for the product
 * specs (CRM, automations, axe), which need a signed-in dashboard.
 */
export const PRODUCT_AUTH_FILE = path.join(__dirname, '../.auth/product-user.json');

setup('sign in as the demo user', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('demo@wolff.demo');
  await page.getByLabel('Password').fill('DemoPassword123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByRole('link', { name: 'Quotes' }).first()).toBeVisible();
  await page.context().storageState({ path: PRODUCT_AUTH_FILE });
});
