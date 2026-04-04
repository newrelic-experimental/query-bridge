---
name: quality-check
description: Run all quality checks (types, tests, linting) in sequence
disable-model-invocation: true
---

Run the project's quality checks in sequence. Stop on first failure.

## Commands (in order)

All commands require Node 24: prefix with `ASDF_NODEJS_VERSION=24.14.0`.

1. **Type check**: `npm run types:check`
2. **Unit tests**: `npm run test`
3. **Lint**: `npm run lint`
4. **Format check**: `npm run format:check`

On first failure: stop, print the failing command and its output, report which check failed and why. Do not attempt to fix it.

## Results summary

| Check | Status | Notes |
|-------|--------|-------|
| types:check | pass/FAIL | |
| test | pass/FAIL | |
| lint | pass/FAIL | |
| format:check | pass/FAIL | |

## Post-test verification

After tests pass, check:
- Test names match test contents (no misleading names)
- No trivially passing tests (asserting on mocks, `true === true`)
- No duplicate coverage (different names, same assertions)
- Tests with `// AI-DEV` markers have not been modified or removed
- No integration tests where unit tests would suffice (this is a pure-function library — no I/O needed)

## Testing philosophy

- Unit tests are 95% of the suite, fast and isolated
- No mocking needed — translator is pure functions (string in, object out)
- Sandi Metz rules: test the public interface, don't test private methods
