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
- **Fuzz testing:** fast-check property-based tests in `test/spl/spl-fuzz.test.js`. It **reseeds each run — a single green is a false-green**; loop it (~20×) before trusting a translator change (`for i in $(seq 1 20); do npx vitest run spl-fuzz || break; done`).
- **Real-world corpus:** 339 queries in `test/spl/spl-real-world.json`
- **NRQL validation:** Use `validate-test-cases` skill to validate translated NRQL via MCP before accepting
- **No e2e tests:** This is a pure library — no UI, no Playwright

## Test authoring style (explicit over clever)

Applies to functional/integration and new behavior tests. (The translator's data-driven `cases` array in `spl.test.js` is the sanctioned exception — it predates this and is documented in CLAUDE.md; don't retrofit it.)

- **No fixture loops.** Do NOT iterate a directory/array of fixtures to generate one test per entry, and do NOT precompute a shared `results`-for-all-fixtures array and assert against it. Write each test explicitly, one scenario per `it()`.
- **Duplication is fine — preferred over clever DRY.** A little copy-paste beats a shared helper that hides what the test does.
- **Relevant setup goes in the test body.** If the thing under test (the XML, the query, the model) is the point of the test, write it inline in the test body. Only boilerplate that merely *gets you to* the test (auth/login, resolving a fixtures dir) belongs in a common block (top-of-file const / `beforeEach`).

## LLM Test Verification

See `@.claude/rules/llm-test-verification.md` for the full verification process. **AI-DEV markers go on a test ONLY after it has passed the full red-green (or mutation) cycle — never cargo-culted onto fresh, unverified tests.**
