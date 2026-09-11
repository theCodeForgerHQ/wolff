import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// eslint-config-next 16 ships flat configs, so FlatCompat is no longer needed.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/triple-slash-reference': 'off',
      'react/no-unescaped-entities': 'off',
      '@next/next/no-html-link-for-pages': 'warn',
      'prefer-const': 'warn',
      // React Compiler rules (eslint-plugin-react-hooks 7). Every finding was
      // fixed or carries a disable comment with its reason, so a new one fails
      // the lint instead of piling up as a warning.
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/refs': 'error',
      'react-hooks/purity': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/error-boundaries': 'error',
      'react-hooks/preserve-manual-memoization': 'error',
      'react-hooks/incompatible-library': 'error',
      '@next/next/no-img-element': 'error',
    },
  },
  globalIgnores(['.next/**', 'node_modules/**', 'dist/**', 'e2e/**', 'coverage/**', 'next-env.d.ts']),
]);
