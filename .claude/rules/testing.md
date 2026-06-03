<!-- AI-DEV: This file is managed by nr-ai-standards via git subtree. Do NOT edit directly. To override a specific rule, ask Claude: "Override [rule name] from this file" and it will create a project-level override in .claude/rules/ -->

# Testing Standards

## Unit Tests

Fast, isolated, deterministic. One class or function. Mock external dependencies (databases, APIs, file systems) at the edge of the unit under test. Unit tests are 95% of your tests. The full suite should run in seconds, not minutes.

## Integration Tests

Verify that two things actually talk to each other. Slow, flaky, it is impossible to write enough of them (Rainsberger's math: 10 layers × 3 branches = 59,000 paths — you'll cover maybe 2.5%). Use them as spot-checks on your mocks, not as your safety net. If possible, move to a separate suite in your CI which runs in parallel.

Keep it to _only_ the things you would test if it was 2am and you got paged. Is the system working _enough_ that we can fix the problem in the morning? Good, we're done; no more integration tests.

**NOTE: It is allowed to have multiple assertions in an integration test.** When possible, if something is important see if you can combine with an existing integration test.

Reference: https://blog.thecodewhisperer.com/permalink/integrated-tests-are-a-scam

## E2E Tests

Real system, real flows. Expensive. Keep the number small — only flows that would wake someone up at 3am.

These are _really_ good candidates for Synthetics monitors. Prefer a Synthetics monitor over writing a new E2E test.

## What to Test (Sandi Metz)

Black-box the object. Test the interface, not the implementation.

| | Incoming | Outgoing |
|---|---|---|
| **Query** (returns something, changes nothing) | Assert return value | Don't test |
| **Command** (returns nothing, changes something) | Assert public side effect | Mock — verify it was sent |

Don't test private methods. Don't test outgoing queries. Don't mock third-party APIs directly. Write a thin wrapper around the third-party API, mock the wrapper in unit tests, and integration-test the wrapper against the real API.

Reference: https://www.youtube.com/watch?v=URSWYvyc42M

## Test Structure

- Behavior, not implementation
- One assertion per unit test, many assertions per integration test
- Test name describes what broke or the behavior, not what the method is called
