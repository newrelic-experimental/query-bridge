# nr-query-bridge Phase 2: SPL AST → IR Translation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

> **IMPORTANT:** Seriously, no bash/python/node. Use Read/Edit tools only. Work in small chunks (you timeout on large edits).

**Goal:** Implement the SPL AST → IR translator (Pass 1) for all major commands. Target: V2 matches or exceeds V1 on the majority of the real-world corpus with 0 regressions.

**Architecture:** `splToIR.js` walks the PEG.js AST and builds IR nodes. Each SPL command has an `applyCommand` handler that transforms the IR structurally.

**Tech Stack:** Node 20, Jest, plain JS

**Spec:** `docs/specs/2026-03-15-spl-ir-rearchitecture-design.md`

**Run tests:** `ASDF_NODEJS_VERSION=20.19.0 packages/nr-query-bridge/node_modules/.bin/jest --no-coverage --config packages/nr-query-bridge/jest.config.js`

---

## Status (as of 2026-03-16)

**Completed:**
- [x] Phase 0: Package extraction
- [x] Phase 1: IR node types (nodes.js) + NRQL emitter (irToNrql.js)
- [x] V2 entry point (translateV2.js) wired: parse → IR → emit
- [x] V1 vs V2 comparison harness with exact/semantic/divergence tracking
- [x] V2 unit tests (401 cases, 0 crashes)
- [x] Search clause translation (WHERE from search expressions)
- [x] Core commands: stats, eval, where, table, fields, sort, head, rename, dedup
- [x] Timechart, chart, bin/bucket, top, rare
- [x] Rex (capture with (?P<>) conversion), spath (jparse), regex (match)
- [x] Eventstats (JOIN for single BY, binding for global)
- [x] Append/appendcols (filter() merging), appendpipe (pattern detection)
- [x] Join (recursive subsearch translation)
- [x] Predict, tstats, macros, mvexpand, fillnull, inputlookup
- [x] Lookup, convert, replace, strcat
- [x] Smart backticking, NRQL boolean precedence fix
- [x] Eval expression walker: if, case, coalesce, lower/upper, round, substr, replace, isnull, match, tonumber, mvjoin, mvindex, split, etc.
- [x] Arithmetic expression parser with proper precedence
- [x] Self-reference detection for eval bindings
- [x] filter() for stats count(eval(...))
- [x] Subquery wrapping for chained stats and where-after-stats

**Metrics:** 167 effective matches (52%), 0 regressions, 172 divergences

## Remaining Work

### High Impact (reduces divergences significantly)

- [ ] **Test migration**: Migrate remaining ~80 semantic-match (backtick-only) unit tests from V1 to V2 assertions. Use nrql-validator agent to bulk-validate.

- [ ] **Convert command**: Full implementation (dur2sec, ctime, mktime, mstime, rmcomma, rmunit, memk, auto, num). Currently stubbed.

- [ ] **Top percent calculation**: V1 adds `count(*) * 100.0 / (SELECT count(*) FROM Log) AS 'percent'`. V2 just does `count(*)`.

- [ ] **Append filter() pattern**: V1 wraps SELECT expressions in `filter(func, WHERE cond)` when append subsearches have different WHERE clauses. V2 does this structurally but output format may differ.

### Medium Impact

- [ ] **Strcat/concat**: Full eval string concatenation (`.` operator). Currently stubbed.

- [ ] **Eventstats percentage pattern**: `eventstats sum(x) as total` → nested aggregation `FROM (inner) SELECT x / sum(x) * 100`.

- [ ] **Optimization pass (irOptimize.js)**: Dead binding elimination, mv* pattern simplification.

- [ ] **Where pipe with eval-style expressions**: Some where pipes use eval AST (EvalComparison), some use search AST (BooleanOp). Current fallback handles both but may miss edge cases.

### Low Impact (exotic/rare)

- [ ] **Streamstats**: Record as UnsupportedIntent with specific context about what the user was trying to do.

- [ ] **Transaction**: Record as UnsupportedIntent with session grouping context.

- [ ] **Mstats**: Translate to FROM Metric (spec exists, not implemented).

- [ ] **Delta/autoregress/accum**: Order-dependent — unsupported with specific messages.

### V1 Bug Fixes to Port to V2

- [ ] **NRQL boolean precedence**: V1 parenthesizes OR inside AND (wrong for NRQL). V2 already fixed.

- [ ] **tonumber warning**: V1 emits misleading "no NRQL equivalent" for tonumber. V2 already fixed (maps to numeric() silently).

## Test Validation & V1 Stripping

Systematic validation of every test case, promotion to `verified: 'human'`, and removal of V1 fields. Detailed process: `../../.claude/plans/spl-test-validation.md`.

### Current State (as of 2026-03-18)

| Category | Count |
|---|---|
| Total test cases | ~410 |
| Have V2 assertions (v2nrql / v2errorIncludes) | ~277 |
| Need V2 assertions (V1-only or no assertions) | ~133 |
| Have both V1 and V2 fields (ready for validation) | ~77 |
| `verified: 'human'` | 4 |
| `verified: 'llm'` | 1 |
| Unverified | ~405 |

### Workflow (batches of 4 cases)

1. **SPL expert review** — confirm SPL is valid, describe intent, flag gotchas
2. **NRQL expert review** — confirm V2 NRQL achieves the same intent as the SPL (even if the mechanism differs entirely). Flag syntax issues, wrong functions, semantic differences
3. **MCP validation** — run each v2nrql (with `LIMIT 1`) against account 1 via `execute_nrql_query`. For template variables, substitute literals before running
4. **Handle issues** — if experts or MCP flag problems, STOP and ask the human. Do not autonomously fix translator code or change test expectations
5. **Ensure V2 assertions** — every case must have at least one of: `v2nrql`, `v2errorIncludes`, `v2warningIncludes`, `v2unsupportedIncludes`
6. **Strip V1 fields** — remove: `where`, `select`, `facet`, `from`, `limit`, `timeseries`, `orderBy`, `with`, `withLength`, `withIncludes`, `join`, `joinLength`, `joinIncludes`, `joinMatch`, `warnings`, `warningMatch`, `warningIncludes`, `warningCount`, `errorMatch`, `errorIncludes`, `errorCount`, `unsupported`, `unsupportedLength`, `unsupportedIncludes`, `unexpandedMacros`, `selectIncludes`, `facetIncludes`, `whereIncludes`, `nrql`, `since`, `until`, `untilNull`, `predict`
7. **Promote** — set `verified: 'human'`, run tests to confirm green

### Known Issues

- **round() precision**: SPL `round(val, 2)` = 2 decimal places. NRQL `round(val, 2)` = nearest multiple of 2. Fix needed: `round(val, N)` → `round(val, pow(10, -N))` in splToIR.js
- **capture() alias backticking**: multi-capture `AS (from, to)` needs individual backticks on reserved words only — `` AS (`from`, to) ``
- **OR precedence confusion**: NRQL OR binds tighter than AND (opposite of SQL/SPL). V2 handles this correctly but the expert agents consistently get confused when reviewing mixed AND/OR clauses

### Ordering

Work through doc groups roughly in order of the test file. Cases that already have V2 assertions and both V1+V2 fields (~77) are lowest friction — validate and strip those first. Cases needing V2 assertions (~133) require translator work or explicit error/warning/unsupported assertions before they can be validated.

## Success Criteria

1. V2 produces valid NRQL for all queries V1 handles (0 regressions)
2. V2 unit tests cover all ~400 cases with v2nrql assertions
3. V2 handles mv* commands with pattern-aware optimization
4. V2 produces better unsupported messages (intent-specific)
5. All V2 NRQL validated via nrql-validator agent against account 1
