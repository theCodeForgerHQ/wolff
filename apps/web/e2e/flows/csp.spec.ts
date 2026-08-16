import { expect, test } from '@playwright/test';

/**
 * CSP: every page carries a nonce-based policy without
 * 'unsafe-inline' or 'unsafe-eval' scripts, and the app runs under it (no
 * violation reported while the login page hydrates and signs in).
 */
test('pages carry a nonce CSP and run without violations', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|^CSP violation/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  // A blocked eval that the page catches (Zod 4 probes `Function('')`) logs
  // nothing to the console; the securitypolicyviolation event still fires.
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(
        `CSP violation: ${event.violatedDirective} ${event.blockedURI} at ${event.sourceFile}`
      );
    });
  });

  await page.goto('/register');

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
  for (const path of ['/deals', '/automations', '/settings/business', '/invoices/new']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
  }

  expect(violations).toEqual([]);
});
