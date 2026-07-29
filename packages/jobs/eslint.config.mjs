import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';

// Job processors run in the worker and in the API's job endpoint, without
// Next.js or React, so those imports are errors here.
const FRAMEWORK_IMPORTS = [
  {
    group: ['next', 'next/*', 'next-auth', 'next-auth/*'],
    message: 'packages/jobs must not depend on Next.js. Do request work in the caller.',
  },
  {
    group: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    message: 'packages/jobs must not depend on React.',
  },
  {
    group: ['@/*', '@wolff/web', '@wolff/web/*', '@wolff/api', '@wolff/api/*', '**/apps/*'],
    message: 'packages/jobs must not import from an app.',
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
    ignores: ['dist/**', 'node_modules/**'],
  },
];
