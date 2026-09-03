import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';

// The API service and the worker. They run without
// Next.js or React, so those imports are errors here.
const FRAMEWORK_IMPORTS = [
  {
    group: ['next', 'next/*', 'next-auth', 'next-auth/*'],
    message: 'apps/api must not depend on Next.js. Do request work in the caller.',
  },
  {
    group: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    message: 'apps/api must not depend on React.',
  },
  {
    group: ['@/*', '@wolff/web', '@wolff/web/*', '**/apps/*'],
    message: 'apps/api must not import from an app.',
  },
];

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
    },
    rules: {
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-restricted-imports': ['error', { patterns: FRAMEWORK_IMPORTS }],
    },
  },
  {
    // k6 scripts run in k6's JavaScript runtime, not Node.
    files: ['load/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', console: 'readonly' },
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
];
