import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // Integration suites get this package's own copy of the test database
    // (packages/database/src/testing), not the one the other packages use.
    globalSetup: ['../../packages/database/src/testing/global-setup.ts'],
    setupFiles: ['./vitest.setup.ts', '../../packages/database/src/testing/setup.ts'],
    include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['node_modules', '.next', 'dist', 'e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'text-summary', 'json-summary'],
      // Every source file counts, not only the ones a test imports.
      include: ['app/**', 'components/**', 'lib/**', 'hooks/**'],
      exclude: [
        'node_modules/**',
        '.next/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/types/**',
        '**/*.test.*',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './'),
    },
  },
});
