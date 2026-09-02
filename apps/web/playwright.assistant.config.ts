import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { E2E_DEVICE, E2E_ENV } from './playwright.flows.config';

/**
 * The assistant end to end (Phase 5): the built web app, apps/api
 * and the AI service with the offline model (LLM_PROVIDER=fake), on one
 * database. Needs: DATABASE_URL migrated and seeded (`pnpm db:seed`),
 * infra/db/bootstrap.sql applied with AI_DB_PASSWORD, `pnpm build`, and
 * uv. The AI service runs `alembic upgrade head` before it starts.
 */
const port = Number(process.env.ASSISTANT_PORT ?? 3300);
const baseURL = `http://localhost:${port}`;
const API_PORT = 4300;
const AI_PORT = 8300;
const SECRETS = {
  SVC_JWT_SECRET_WEB: 'e2e-web-'.repeat(8),
  SVC_JWT_SECRET_AI: 'e2e-ai--'.repeat(8),
  SVC_JWT_SECRET_WORKER: 'e2e-wrk-'.repeat(8),
};
const databaseUrl = process.env.DATABASE_URL ?? '';
const aiDatabaseUrl =
  process.env.AI_E2E_DATABASE_URL ??
  databaseUrl.replace(/\/\/[^@]*@/, `//ai_service:${process.env.AI_DB_PASSWORD ?? 'ai_dev_only'}@`);
const AUTH_FILE = path.join(__dirname, 'e2e/.auth/product-user.json');

export default defineConfig({
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 120_000,
  // The app's Google provider points at the mock OIDC server it starts.
  globalSetup: require.resolve('./e2e/flows/global-setup'),
  use: { ...E2E_DEVICE, baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'setup', testDir: './e2e/product', testMatch: /auth\.setup\.ts/ },
    {
      name: 'assistant',
      testDir: './e2e/assistant',
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },
  ],
  webServer: [
    {
      command: `pnpm exec next start -p ${port}`,
      url: `${baseURL}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...E2E_ENV,
        ...SECRETS,
        AI_URL: `http://127.0.0.1:${AI_PORT}`,
        DATABASE_URL: databaseUrl,
        NEXTAUTH_URL: baseURL,
        AUTH_URL: baseURL,
        NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? 'wolff-e2e-secret',
        NEXT_PUBLIC_APP_URL: baseURL,
        TRUST_HOST: 'true',
        AUTH_TRUST_HOST: 'true',
        TZ: 'UTC',
      },
    },
    {
      command: 'pnpm --filter @wolff/api exec tsx src/server.ts',
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...SECRETS,
        NODE_ENV: 'test',
        PORT: String(API_PORT),
        DATABASE_URL: databaseUrl,
        WEB_ORIGIN: baseURL,
        APP_URL: baseURL,
      },
    },
    {
      command: `uv run --project ../../services/ai --frozen sh -c "cd ../../services/ai && alembic upgrade head && uvicorn app.main:get_app --factory --port ${AI_PORT}"`,
      url: `http://127.0.0.1:${AI_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        ...SECRETS,
        ENVIRONMENT: 'test',
        LLM_PROVIDER: 'fake',
        AI_DATABASE_URL: aiDatabaseUrl,
        API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`,
        AI_PUBLIC_URL: `http://127.0.0.1:${AI_PORT}`,
        AI_REPORTS_DIR: path.join(__dirname, 'test-results/ai-reports'),
      },
    },
  ],
});
