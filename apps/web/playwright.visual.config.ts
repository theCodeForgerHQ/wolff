import { defineConfig, devices } from '@playwright/test';

/**
 * Visual regression suite: 10 key pages x 3 viewports.
 *
 * Runs against a production build (`next start`) seeded with
 * `pnpm db:seed`, so it stays separate from the main E2E config and its
 * global setup. Baselines live next to the spec and are only regenerated
 * with `--update-snapshots` in a commit that states the reason.
 */
const baseURL = process.env.VISUAL_BASE_URL ?? 'http://localhost:3100';

const viewport = (width: number, height: number) => ({ viewport: { width, height } });

export default defineConfig({
  testDir: './e2e/visual',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
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
  projects: [
    { name: 'mobile-375', use: { ...devices['Desktop Chrome'], ...viewport(375, 812) } },
    { name: 'tablet-768', use: { ...devices['Desktop Chrome'], ...viewport(768, 1024) } },
    { name: 'desktop-1440', use: { ...devices['Desktop Chrome'], ...viewport(1440, 900) } },
  ],
});
