'use strict';

/**
 * ESLint 9 "flat config": one array of config objects, applied in order.
 * Run with `npm run lint`; CI (ci-dev.yml) fails the build on any error, so
 * style and obvious bugs are caught before code review even starts.
 */

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'coverage/'] },

  // ESLint's curated "recommended" rules: undefined variables, unreachable
  // code, duplicate keys, etc.
  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs', // matches "type": "commonjs" in package.json
      globals: { ...globals.node }, // process, Buffer, __dirname, ...
    },
    rules: {
      // Allow intentionally unused args/vars when prefixed with "_"
      // (e.g. Express error handlers must declare all four parameters).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
];
