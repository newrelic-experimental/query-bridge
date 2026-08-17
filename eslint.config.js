/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import headers from 'eslint-plugin-headers';

// NR's Open Source Attribution Policy requires every source file in an
// open-sourced repo to carry a copyright line and SPDX identifier. `(year)` is a
// pattern, not a literal: any four-digit year validates, so a file keeps the year
// it was published and only new files get the default. node-newrelic enforces the
// same header through `@newrelic/eslint-config`, which pins eslint ^9.39.4 — move
// to that config once it supports the major we run.
const LICENSE_HEADER = {
  source: 'string',
  style: 'jsdoc',
  blockPrefix: '\n',
  content: [
    'Copyright (year) New Relic Corporation. All rights reserved.',
    'SPDX-License-Identifier: Apache-2.0',
  ].join('\n'),
  patterns: { year: { pattern: '\\d{4}', defaultValue: '2026' } },
};

// Single ESLint config for the whole monorepo. Flat config is glob-scoped, so
// one root config lints every package plus the repo-level playground — no
// per-package configs to keep in sync. `eslint .` from the root covers it all.
export default [
  {
    ignores: [
      'packages/nr-query-bridge/src/input/spl/splParser.js', // generated parser
      '**/node_modules/',
      '**/dist/',
      '**/tmp/',
      '**/coverage/',
      '**/types/',
    ],
  },
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
      },
    },
    plugins: { headers },
    rules: {
      'headers/header-format': ['error', LICENSE_HEADER],
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Test globals — package test suites and the repo-level playground guard.
    files: ['packages/*/test/**/*.js', 'playground/**/*.test.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
  },
  {
    // Browser globals — the playground demo runs in the browser.
    files: ['playground/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        clearTimeout: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
];
