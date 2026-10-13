/**
 * ESLint flat config: the default since ESLint 9, and the only format ESLint 10
 * (used here) still supports; the old .eslintrc files are gone.
 * Browser globals for the app code, Node globals for the config files.
 * Run with `npm run lint`; CI runs the same command on every push to dev.
 */
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  globalIgnores(['dist/', 'node_modules/']),

  js.configs.recommended,

  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
  },

  {
    files: ['*.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },

  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
]);
