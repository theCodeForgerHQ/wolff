import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Suites that use Postgres share one database; run files one after another.
    fileParallelism: false,
  },
});
