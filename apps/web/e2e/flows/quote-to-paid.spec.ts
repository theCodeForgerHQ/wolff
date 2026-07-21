import { expect, test, type Page } from '@playwright/test';
import Stripe from 'stripe';
import { prisma } from '@wolff/database';
import { E2E_ENV } from '../../playwright.flows.config';
import { STRIPE_JS_STUB } from './stripe-js-stub';

/**
 * Quote -> invoice -> Stripe payment (Phase 1 DoD).
 *
 * Real: the dashboard conversion, the portal, the checkout API route, the
 * server's PaymentIntent request (sent to stripe-mock, which validates it
 * against Stripe's OpenAPI spec) and the webhook handler with signature
 * verification. Mocked: Stripe.js in the browser (stub) and Stripe's webhook
 * delivery (a payment_intent.succeeded event signed with the endpoint secret).
 */
const QUOTE_ID = '00000000-0000-4000-8000-0000000e2e01';
const DEMO = { email: 'demo@wolff.demo', password: 'DemoPassword123!' };

async function resetFixtures() {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: 'demo-workspace' } });

  // A fresh accepted quote with a UUID id (seeded ids don't open on detail pages).
  const old = await prisma.invoice.findMany({ where: { quoteId: QUOTE_ID }, select: { id: true } });
  const oldIds = old.map((i) => i.id);
  await prisma.payment.deleteMany({ where: { invoiceId: { in: oldIds } } });
  await prisma.invoiceEvent.deleteMany({ where: { invoiceId: { in: oldIds } } });
  await prisma.invoiceLineItem.deleteMany({ where: { invoiceId: { in: oldIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: oldIds } } });
  await prisma.quoteEvent.deleteMany({ where: { quoteId: QUOTE_ID } });
  await prisma.quoteLineItem.deleteMany({ where: { quoteId: QUOTE_ID } });
  await prisma.quote.deleteMany({ where: { id: QUOTE_ID } });
  await prisma.$executeRawUnsafe(
    `INSERT INTO quotes
       SELECT (jsonb_populate_record(NULL::quotes, to_jsonb(q) || jsonb_build_object(
         'id', $1::text, 'quote_number', 'Q-E2E1', 'access_token', gen_random_uuid()::text,
         'converted_to_invoice_id', NULL))).*
       FROM quotes q WHERE q.id = 'demo-quote-4'`,
    QUOTE_ID
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO quote_line_items
       SELECT (jsonb_populate_record(NULL::quote_line_items, to_jsonb(li)
         || jsonb_build_object('id', gen_random_uuid()::text, 'quote_id', $1::text))).*
       FROM quote_line_items li WHERE li.quote_id = 'demo-quote-4'`,
    QUOTE_ID
  );

  // Stripe Connect as if onboarding had finished (the account id is stripe-mock's concern).
  await prisma.paymentSettings.upsert({
    where: { workspaceId: workspace.id },
    update: {
      stripeAccountId: 'acct_wolffE2E',
      stripeOnboardingComplete: true,
      chargesEnabled: true,
    },
    create: {
      workspaceId: workspace.id,
      stripeAccountId: 'acct_wolffE2E',
      stripeOnboardingComplete: true,
      chargesEnabled: true,
    },
  });
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(DEMO.email);
  await page.getByLabel('Password').fill(DEMO.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard/);
}

test.beforeAll(resetFixtures);
test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an accepted quote becomes an invoice that the client pays by card', async ({
  page,
  browser,
  request,
}) => {
  // 1. The business converts the accepted quote into an invoice.
  await signIn(page);
  await page.goto(`/quotes/${QUOTE_ID}`);
  await page.getByRole('button', { name: 'Convert to Invoice' }).click();
  await page.getByRole('button', { name: 'Create Invoice' }).click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);

  const invoice = await prisma.invoice.findFirstOrThrow({ where: { quoteId: QUOTE_ID } });
  expect(Number(invoice.total)).toBeGreaterThan(0);

  // 2. The client opens the portal link and pays with the (stubbed) Payment Element.
  const client = await browser.newContext();
  const portal = await client.newPage();
  await portal.route('https://js.stripe.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: STRIPE_JS_STUB })
  );
  await portal.goto(`/i/${invoice.accessToken}`);
  await portal.getByRole('button', { name: /^pay /i }).click();

  await expect(portal.getByTestId('stripe-payment-element')).toBeVisible();
  const elementsOptions = await portal.evaluate(
    () =>
      (window as unknown as { __stripeStub: { elementsOptions: { clientSecret: string } } })
        .__stripeStub.elementsOptions
  );
  expect(elementsOptions.clientSecret).toMatch(/^pi_\w+_secret_\w+$/);

  await portal.getByRole('button', { name: /^pay /i }).click();
  await expect(portal.getByRole('status')).toContainText('Payment received');

  // The server recorded a pending payment for the PaymentIntent stripe-mock created.
  const payment = await prisma.payment.findFirstOrThrow({ where: { invoiceId: invoice.id } });
  expect(payment.status).toBe('pending');
  expect(payment.stripePaymentIntentId).toMatch(/^pi_/);

  // 3. Stripe tells the app the payment succeeded (signed webhook).
  const event = JSON.stringify({
    id: `evt_e2e_${Date.now()}`,
    object: 'event',
    type: 'payment_intent.succeeded',
    api_version: '2026-08-26.dahlia',
    data: {
      object: {
        id: payment.stripePaymentIntentId,
        object: 'payment_intent',
        status: 'succeeded',
        latest_charge: 'ch_wolffE2E',
        metadata: { invoiceId: invoice.id },
      },
    },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: event,
    secret: E2E_ENV.STRIPE_WEBHOOK_SECRET,
  });
  const forged = await request.post('/api/webhooks/stripe', {
    headers: { 'content-type': 'application/json', 'stripe-signature': 'bogus' },
    data: event,
  });
  expect(forged.status()).toBe(400);
  const delivered = await request.post('/api/webhooks/stripe', {
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    data: event,
  });
  expect(delivered.ok()).toBe(true);

  // 4. The invoice is paid, in the database and on the business's screen.
  const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  expect(paid.status).toBe('paid');
  expect(Number(paid.amountDue)).toBe(0);

  await page.goto(`/invoices/${invoice.id}`);
  await expect(page.getByText(/^paid$/i).first()).toBeVisible();

  await client.close();
});
