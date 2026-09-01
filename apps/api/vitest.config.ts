import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Postgres suites get this package's own copy of the test database
    // (packages/database/src/testing); its files share it, one after another.
    globalSetup: ['../../packages/database/src/testing/global-setup.ts'],
    setupFiles: ['../../packages/database/src/testing/setup.ts'],
    fileParallelism: false,
  },
});
