# Project Testing Standards

## Overrides
These replace conflicting guidance from the universal testing standards (`.claude/rules/testing.md`):

- "Mock external dependencies at the edge" → No mocking needed. The translator is pure functions (string in, object out).

## Project Config

- **Test runner:** Vitest (native ESM, `npm run test`)
- **Test location:** `test/` mirroring `src/` structure
- **Test style:** Data-driven `cases` arrays with fields: `spl`, `nrql`, `errorIncludes`, `warningFunc`, `unsupportedFunc`, `doc`, `verified`, `skip` (note: `warningIncludes`/`unsupportedIncludes` are NOT implemented by the runner — use the `*Func` message-key arrays)
- **Verification levels:** `false` → `'llm'` → `'human'`. Only humans can promote to `'human'`.
- **Message assertions:** `warningFunc` / `unsupportedFunc` arrays must list ALL message functions that fire (exhaustive, not partial)
- **Fuzz testing:** fast-check property-based tests in `test/spl/spl-fuzz.test.js`
- **Real-world corpus:** 339 queries in `test/spl/spl-real-world.json`
- **NRQL validation:** Use `validate-test-cases` skill to validate translated NRQL via MCP before accepting
- **No e2e tests:** This is a pure library — no UI, no Playwright

## LLM Test Verification

See `@.claude/rules/llm-test-verification.md` for the full verification process.
