import { expect, test } from '@playwright/test';
import { prisma } from '@wolff/database';

const DEMO = { email: 'demo@wolff.demo', password: 'DemoPassword123!' };

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe('credentials login', () => {
  test('signs the demo user in and lands on the dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(DEMO.email);
    await page.getByLabel('Password').fill(DEMO.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();

    await page.waitForURL(/\/dashboard/);
    await expect(page.getByRole('link', { name: 'Quotes' }).first()).toBeVisible();
  });

  test('rejects a wrong password and stays on the login page', async ({ page }) => {
    await page.goto('/login');
    // A throwaway address, so the per-email login rate limit never affects the demo user.
    await page.getByLabel('Email').fill(`nobody-${Date.now()}@wolff.test`);
    await page.getByLabel('Password').fill('WrongPassword123!');
    await page.getByRole('button', { name: /^sign in$/i }).click();

    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('sends signed-out visitors to the login page', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  });
});

test.describe('Google login (mock OIDC provider)', () => {
  test('creates the user, links the account and encrypts its tokens', async ({ page }) => {
    const email = process.env.E2E_GOOGLE_EMAIL!;

    await page.goto('/login');
    await page.getByRole('button', { name: 'Google' }).click();

    // First sign-in: a new user lands in onboarding, and the wizard renders.
    // Waiting for the URL alone isn't enough: the page used to throw
    // "No workspace found" after the redirect.
    await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
    await expect(page.getByText('Welcome to Wolff')).toBeVisible();

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { accounts: true },
    });
    expect(user.name).toBe('Google E2E User');
    expect(user.avatarUrl).toBe('https://lh3.googleusercontent.com/a/e2e');

    const [account] = user.accounts;
    expect(account?.provider).toBe('google');
    expect(account?.providerAccountId).toBe(`google-${email}`);
    expect(account?.accessToken).toMatch(/^enc:/);

    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: user.id },
      include: { workspace: true },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('owner');
    expect(memberships[0]?.workspace.ownerId).toBe(user.id);
  });

  test('signs the same Google user in again without creating a duplicate', async ({ page }) => {
    const email = process.env.E2E_GOOGLE_EMAIL!;

    await page.goto('/login');
    await page.getByRole('button', { name: 'Google' }).click();
    await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
    await expect(page.getByText('Welcome to Wolff')).toBeVisible();

    expect(await prisma.user.count({ where: { email } })).toBe(1);
    expect(await prisma.account.count({ where: { user: { email } } })).toBe(1);
    expect(await prisma.workspaceMember.count({ where: { user: { email } } })).toBe(1);
  });

  test('refuses a deactivated account with an explanation', async ({ page }) => {
    const email = process.env.E2E_GOOGLE_EMAIL!;
    await prisma.user.update({ where: { email }, data: { deletedAt: new Date() } });

    try {
      await page.goto('/login');
      await page.getByRole('button', { name: 'Google' }).click();

      await page.waitForURL(/\/login\?error=AccountDeactivated/, { timeout: 30_000 });
      await expect(page.getByRole('alert').filter({ hasText: /deactivated/i })).toBeVisible();
      expect(await prisma.user.count({ where: { email } })).toBe(1);
    } finally {
      await prisma.user.update({ where: { email }, data: { deletedAt: null } });
    }
  });

  test('signed in as the demo user, a Google sign-in becomes its own user', async ({ page }) => {
    // Start from a Google identity the app has never seen, so this is the
    // first-sign-in path where Auth.js would link to the current session.
    const email = process.env.E2E_GOOGLE_EMAIL!;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      await prisma.workspace.deleteMany({ where: { ownerId: existing.id } });
      await prisma.user.delete({ where: { id: existing.id } });
    }

    await page.goto('/login');
    await page.getByLabel('Email').fill(DEMO.email);
    await page.getByLabel('Password').fill(DEMO.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL(/\/dashboard/);

    // /register shows the Google button to a signed-in visitor (/login would
    // redirect to the dashboard); a login page restored by the Back button does too.
    await page.goto('/register');
    await page.getByRole('button', { name: 'Google' }).click();
    await page.waitForURL(/\/onboarding/, { timeout: 30_000 });

    expect(await prisma.account.count({ where: { user: { email: DEMO.email } } })).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { accounts: true, workspaceMembers: true },
    });
    expect(user.accounts.map((a) => a.provider)).toEqual(['google']);
    expect(user.workspaceMembers).toHaveLength(1);
    const session = await page.request.get('/api/auth/session').then((r) => r.json());
    expect(session.user.email).toBe(email);
  });
});
