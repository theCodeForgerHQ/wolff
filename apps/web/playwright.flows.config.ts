import { defineConfig, devices } from '@playwright/test';

/**
 * Phase 1 DoD flows: credentials login, Google login against a
 * mock OIDC server, and quote -> invoice -> Stripe payment against
 * stripe-mock. Everything outside the app is mocked at the network boundary;
 * see docs/phase-1.md for what that does and doesn't prove.
 *
 * Needs: a migrated + seeded DATABASE_URL, stripe-mock on :12111, and a
 * build made with NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_wolff_e2e.
 */
const port = Number(process.env.FLOWS_PORT ?? 3200);
const baseURL = `http://localhost:${port}`;

export const E2E_ENV = {
  // stripe-mock rejects keys with an underscore after sk_test_.
  STRIPE_SECRET_KEY: 'sk_test_wolffE2E',
  STRIPE_WEBHOOK_SECRET: 'whsec_wolff_e2e',
  STRIPE_API_BASE_URL: process.env.STRIPE_MOCK_URL ?? 'http://localhost:12111',
  GOOGLE_CLIENT_ID: 'wolff-e2e-google',
  GOOGLE_CLIENT_SECRET: 'wolff-e2e-google-secret',
  AUTH_GOOGLE_ISSUER: 'http://localhost:9099',
  ENCRYPTION_KEY: 'e2e0'.repeat(16),
} as const;

export default defineConfig({
  testDir: './e2e/flows',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 90_000,
  globalSetup: require.resolve('./e2e/flows/global-setup'),
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec next start -p ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...E2E_ENV,
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      NEXTAUTH_URL: baseURL,
      AUTH_URL: baseURL,
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? 'wolff-e2e-secret',
      NEXT_PUBLIC_APP_URL: baseURL,
      TRUST_HOST: 'true',
      AUTH_TRUST_HOST: 'true',
      TZ: 'UTC',
    },
  },
});
