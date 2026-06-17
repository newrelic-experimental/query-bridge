import { defineConfig } from 'vitest/config';

// Repo-level test runner. Covers tests that belong to the whole project rather
// than to a single package — currently the playground demo guard
// (playground/examples.test.js), which checks the playground examples stay
// honest as the translator evolves. Package suites run via their own workspace
// vitest configs.
export default defineConfig({
  test: {
    include: ['playground/**/*.test.js'],
    globals: true,
  },
});
