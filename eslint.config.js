import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

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
    rules: {
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
