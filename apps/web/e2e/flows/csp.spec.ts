import { expect, test } from '@playwright/test';

/**
 * CSP: every page carries a nonce-based policy without
 * 'unsafe-inline' or 'unsafe-eval' scripts, and the app runs under it (no
 * violation reported while the login page hydrates and signs in).
 */
test('pages carry a nonce CSP and run without violations', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });

  const response = await page.goto('/login');
  const policy = response!.headers()['content-security-policy'] ?? '';
  const scriptSrc = policy.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';

  expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(scriptSrc).not.toContain("'unsafe-eval'");

  await page.getByLabel('Email').fill('demo@wolff.demo');
  await page.getByLabel('Password').fill('DemoPassword123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard/);
  await page.goto('/deals');
  await page.goto('/automations');

  expect(violations).toEqual([]);
});
