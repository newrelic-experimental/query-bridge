import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    globals: true,
    coverage: {
      provider: 'v8',
      // Report every source file, not only the ones a test happened to import,
      // so an entirely-untested new file counts against coverage.
      all: true,
      include: ['src/**/*.js'],
      reporter: ['text'],
      // Per-file gate (perFile:true checks EVERY file individually, not the
      // package aggregate). No file may regress below these floors. The numbers
      // sit just under today's weakest file so the gate passes now but catches a
      // file collapsing toward zero. Weakest file 2026-06-26:
      //   detectFormat.js 81.8% stmt/line, 78.6% branch (functions are 100% everywhere).
      // vitest's perFile is a single global switch, so a stricter package-wide
      // aggregate floor can't coexist with this in one run.
      thresholds: {
        perFile: true,
        statements: 78,
        branches: 72,
        functions: 90,
        lines: 78,
      },
    },
  },
});
