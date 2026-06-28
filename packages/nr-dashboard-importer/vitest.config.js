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
      // Exclude bin/ explicitly. vitest matches `include` against the ABSOLUTE
      // path with picomatch `contains:true`, so when CI checks the repo out under
      // a path containing a `src/` segment (Grand Central uses /work/src/...),
      // `src/**/*.js` spuriously contains-matches bin/spl-dashboard.js — which the
      // cli/e2e/smoke tests execute — and it lands in the report at ~53%, tripping
      // the gate. Local paths without a `src/` segment don't hit this. Excluding
      // bin/ is correct regardless: the gate polices src/, not the CLI shim.
      exclude: ['bin/**'],
      reporter: ['text'],
      // Per-file gate (perFile:true checks EVERY file individually, not the
      // package aggregate). No file may regress below these floors. The numbers
      // sit just under today's weakest file so the gate passes now but catches a
      // file collapsing toward zero. Ratcheted up over time. Weakest file
      // 2026-06-28 (stable across runs):
      //   detectFormat.js 84.84% stmt, 79.41% branch, 87.09% line; functions
      //   are 100% everywhere.
      // vitest's perFile is a single global switch, so a stricter package-wide
      // aggregate floor can't coexist with this in one run.
      thresholds: {
        perFile: true,
        statements: 82,
        branches: 76,
        functions: 95,
        lines: 84,
      },
    },
  },
});
