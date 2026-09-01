import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['src/generated/**', 'node_modules/**'],
    // Postgres suites get this package's own copy of the test database
    // (packages/database/src/testing); its files share it, one after another.
    globalSetup: ['./src/testing/global-setup.ts'],
    setupFiles: ['./src/testing/setup.ts'],
    fileParallelism: false,
  },
});
