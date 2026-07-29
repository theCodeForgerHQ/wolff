import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['src/generated/**', 'node_modules/**'],
    // The suites share one database; run files one after another.
    fileParallelism: false,
  },
});
