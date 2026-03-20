# Testing Standards

## Unit Tests

Fast, isolated, deterministic. One class or function. Mock at the boundary. This is 95% of your tests. The full suite should run in seconds, not minutes.

**This project**: Jest with Babel. Pure JavaScript, no React.

- Tests in `test/` mirroring `src/` structure
- No mocking needed — the translator is pure functions (string in, object out)
- V1 tests assert on result object fields (`where`, `select`, `facet`)
- V2 tests assert on NRQL string output via `v2nrql` field
- Validate V2 NRQL via MCP (`execute_nrql_query` on account 1) before accepting

## Integration Tests

Verify that two things actually talk to each other. Slow, flaky, it is impossible to write enough of them (Rainsberger's math: 10 layers × 3 branches = 59,000 paths — you'll cover maybe 2.5%). Use them as spot-checks on your mocks, not as your safety net. If possible, move to a separate suite in CI which runs in parallel.

Keep it to _only_ the things you would test if it was 2am and you got paged.

**NOTE: Multiple assertions per integration test are allowed.** Combine with existing integration tests when possible.

## E2E Tests

Real system, real flows. Expensive. Keep the number small — only flows that would wake someone up at 3am.

These are _really_ good candidates for Synthetics monitors. Please consider doing that instead!

**This project**: Playwright with NR1 CLI integration (staging only). Tests in `e2e/tests/` with `.chrome.spec.ts` naming. Page Object Models in `e2e/page-object-models/`. Helpers in `e2e/helpers/`.

- Use `test.step()` to organize test steps for better reporting
- Use `test.slow()` for UI-heavy tests that need more time
- Use `useSession()` for account selection in tests
- Tests run against staging only (never production)

## What to Test (Sandi Metz)

Black-box the object. Test the interface, not the implementation.

| | Incoming | Outgoing |
|---|---|---|
| **Query** (returns something, changes nothing) | Assert return value | Don't test |
| **Command** (returns nothing, changes something) | Assert public side effect | Mock — verify it was sent |

Don't test private methods. Don't test outgoing queries. Don't mock what you don't own — wrap it, mock the wrapper, integration-test the real thing.

Reference: https://www.youtube.com/watch?v=URSWYvyc42M

## LLM Test Verification

See @.claude/rules/llm-test-verification.md for the full verification process (generating tests, expanded red-green-refactor, AI-DEV markers, post-hoc review).
