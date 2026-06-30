---
name: coverage-ratchet
description: Use when asked to raise the test-coverage floors, "increase the minimum numbers", or ratchet up the per-file coverage gate. Carries this repo's gate mechanics and the stability gotchas that make a naive bump flake CI.
---

# Coverage Ratchet

The gate is **per-file** (`perFile:true`, `all:true`) with statements/branches/functions/lines floors in each package's `vitest.config.js` (`packages/nr-query-bridge`, `packages/nr-dashboard-importer`). Raise it like this:

1. **Find the weakest per-file metric.** Run the whole package with coverage (`npm run test --workspace=<pkg>`). The text reporter prints a per-file table and **omits files that are 100% on all four metrics** — so a missing file is fully covered, not missing. The lowest cell per metric is what pins each floor.
2. **Fix the worst-outlier file, not broadly.** One file covered only incidentally (a pure-function module reached only through integration) drags a whole floor down. A dedicated unit test hitting every branch usually retires the outlier and unlocks a big bump (e.g. `nrqlEncoding.js` 50%→100% branch let the qb branch floor jump 45→72).
3. **Measure stability before raising.** Run the package coverage **3×** and compare the near-floor files. **v8 function coverage is nondeterministic here** — `enrichmentHandlers.js` funcs flapped 77.77↔83.33 on identical source (it miscounts arrow callbacks). **Never raise a metric you have seen flap**; hold it and say why in the config comment. The empirical floor is the *lowest* value seen across runs, not the typical one.
4. **Set each floor just under the stable minimum** (~3–5pt margin). The gate catches a file collapsing toward zero, not micro-jitter. Update the config comment's "weakest files" note so the next ratchet starts from truth.
5. **Verify the raised gate passes** (whole package, 3×) before committing.

## Gotchas

- A **single-file test run under-covers** and trips the per-file gate — iterate with `--coverage.enabled=false` and gate-check with the whole-package run.
- Before adding tests to lift a funcs gap, **confirm the "uncovered" function isn't already exercised**. The append filter/merge helpers (`wrapInFilter`/`exprsEqual`) are covered via the `append_filter_warning`/`append_merged` cases — a funcs shortfall there is v8 arrow-callback miscounting, not a real gap, and adding tests would just duplicate existing ones.
- Don't chase every metric in one PR. Raising the stable ones (branches, stmt/lines) substantially while honestly holding a flaky one (funcs) is a complete ratchet.
