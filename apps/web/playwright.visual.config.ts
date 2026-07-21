import { defineConfig, devices } from '@playwright/test';

/**
 * Visual regression suite: 10 key pages x 3 viewports.
 *
 * Runs against a production build (`next start`) and a freshly seeded
 * database, separate from the main E2E config and its global setup.
 * Baselines are per platform (font rendering differs between macOS and
 * Linux) and are only regenerated with `--update-snapshots` in a commit that
 * states the reason.
 */
const port = Number(process.env.VISUAL_PORT ?? 3100);
const baseURL = `http://localhost:${port}`;

const viewport = (width: number, height: number) => ({ viewport: { width, height } });

export default defineConfig({
  testDir: './e2e/visual',
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{projectName}/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  use: {
    baseURL,
    timezoneId: 'UTC',
    locale: 'en-US',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  },
  webServer: {
    command: `pnpm exec next start -p ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      NEXTAUTH_URL: baseURL,
      AUTH_URL: baseURL,
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? 'wolff-visual-secret',
      NEXT_PUBLIC_APP_URL: baseURL,
      TRUST_HOST: 'true',
      AUTH_TRUST_HOST: 'true',
      // Server-rendered dates must match the browser's timezone.
      TZ: 'UTC',
    },
  },
  projects: [
    { name: 'mobile-375', use: { ...devices['Desktop Chrome'], ...viewport(375, 812) } },
    { name: 'tablet-768', use: { ...devices['Desktop Chrome'], ...viewport(768, 1024) } },
    { name: 'desktop-1440', use: { ...devices['Desktop Chrome'], ...viewport(1440, 900) } },
  ],
});
