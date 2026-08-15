import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { prisma } from '@wolff/database';
import { ensureVisualFixtures, VISUAL } from './fixtures';

/**
 * The 10 key pages (docs/baseline.md explains the choice):
 * the two public auth pages, the three portal views a client sees, and the
 * five dashboard pages that carry the quote-to-cash flow.
 */
const DEMO = { email: 'demo@wolff.demo', password: 'DemoPassword123!' };

// Wall-clock text (greeting, relative times, seed-relative dates), the
// activity feed (portal visits append "viewed" events) and charts change
// between runs; mask them so the diff measures layout and styling.
const volatile = (page: Page): Locator[] => [
  page.locator('time, .recharts-wrapper, [data-sonner-toaster]'),
  page.getByText(/^Good (morning|afternoon|evening)/),
  // The sticky demo banner lands at a different offset in full-page captures on narrow viewports.
  page
    .getByText('Demo Mode', { exact: true })
    .locator('xpath=ancestor::div[contains(@class, "container")]/..'),
  // Unread count: every portal visit in the run adds a notification.
  page.getByRole('button', { name: 'Notifications' }).locator('span'),
  page.getByText(/^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, /),
  page
    .getByText('Recent Activity', { exact: true })
    .locator('xpath=ancestor::*[contains(@class, "h-full")][1]'),
];

const AUTH_FILE = path.join(__dirname, '../.auth/visual-demo.json');

const AUTH_USER_FILE = `${AUTH_FILE}.user`;

// Sign in once per run: the credentials provider allows 5 attempts per email per 15 min.
// The saved session is reused only for the same demo user: after the visual
// database is re-seeded the user (and workspace) ids change, and a session
// for the old ones renders an error instead of the dashboard.
async function ensureStorageState(browser: Browser) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: DEMO.email },
    select: { id: true },
  });
  const savedFor = fs.existsSync(AUTH_USER_FILE) ? fs.readFileSync(AUTH_USER_FILE, 'utf8') : '';
  if (
    savedFor === user.id &&
    fs.existsSync(AUTH_FILE) &&
    Date.now() - fs.statSync(AUTH_FILE).mtimeMs < 60 * 60 * 1000
  )
    return;
  const page = await browser.newPage({
    baseURL: test.info().project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  await page.goto('/login');
  await page.getByLabel('Email').fill(DEMO.email);
  await page.getByLabel('Password').fill(DEMO.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
  fs.writeFileSync(AUTH_USER_FILE, user.id);
  await page.close();
}

async function snap(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    mask: volatile(page),
  });
}

test.beforeAll(async () => {
  await ensureVisualFixtures();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe('public pages', () => {
  test('login', async ({ page }) => {
    await page.goto('/login');
    await snap(page, '01-login');
  });

  test('register', async ({ page }) => {
    await page.goto('/register');
    await snap(page, '02-register');
  });

  test('client portal: quote and invoice', async ({ page }) => {
    await page.goto(`/q/${VISUAL.portalQuoteToken}`);
    await snap(page, '03-portal-quote');
    await page.goto(`/i/${VISUAL.portalInvoiceToken}`);
    await snap(page, '04-portal-invoice');
  });
});

test.describe('dashboard pages', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureStorageState(browser);
  });
  test.use({ storageState: AUTH_FILE });

  test('dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    await snap(page, '05-dashboard');
  });

  test('quotes list and detail', async ({ page }) => {
    await page.goto('/quotes');
    await snap(page, '06-quotes');
    await page.goto(`/quotes/${VISUAL.quoteId}`);
    await snap(page, '07-quote-detail');
  });

  test('invoices list and detail', async ({ page }) => {
    await page.goto('/invoices');
    await snap(page, '08-invoices');
    await page.goto(`/invoices/${VISUAL.invoiceId}`);
    await snap(page, '09-invoice-detail');
  });

  test('payment settings', async ({ page }) => {
    await page.goto('/settings/payments');
    await snap(page, '10-settings-payments');
  });
});
