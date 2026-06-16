# nr-query-bridge

> **Do not hand-zip / `tar` the working directory to share it.** It sweeps in `node_modules`, `.git`, and the gitignored `docs/local/` (private data that must not leave the repo). Use `npm pack` or `git archive` — see "Packaging & distribution" in README.md.

## Project Overview

Multi-language query translator. SPL/Lucene/PromQL/PPL → NRQL/Trino. Pure ESM JavaScript, no React, zero runtime dependencies. Publishable as `@datanerd/nr-query-bridge`.

## Rules

* For code analysis, use Read/Edit/Grep — do NOT shell out to node/python to inspect or transform source files. Work in chunks — you timeout over 200-300 lines.
* `node bin/spl2nrql.js "<query>"` IS allowed for translating ad-hoc SPL queries (see "Running ad-hoc SPL queries" below).
* DO NOT COMMIT AUTOMATICALLY. Ask first.
* Commit messages: lowercase subject, max 72 chars.
* Conventional commits required (`feat:`, `fix:`, `chore:`).
* Commit with `ASDF_NODEJS_VERSION=24.14.0 git commit` (hooks need Node 24).
* **Loud failure over silent wrong results.** If a command can't be translated correctly, emit `unsupported`, not a warning-and-skip. A user getting an error is better than a user getting wrong data.

## Build & Test

Requires Node 24: `ASDF_NODEJS_VERSION=24.14.0 <command>`

```
npm run test                    # unit tests (vitest)
npm run test -- spl             # filter to matching files (Vitest positional; NOT Jest --testPathPattern)
npm run lint                    # ESLint
npm run lint:fix                # ESLint with auto-fix
npm run format                  # Prettier write
npm run format:check            # Prettier check
npm run types:check             # TypeScript checkJs (no emit)
npm run build:parsers           # regenerate Peggy parser after grammar changes
```

CLI:
```
node bin/spl2nrql.js "index=web status=500 | stats count by host"
echo "index=web | stats count" | node bin/spl2nrql.js
node bin/spl2nrql.js -i   # interactive REPL
```

### Running ad-hoc SPL queries

`node bin/spl2nrql.js "<query>"` is the fastest way to translate a single SPL query and see its NRQL + warnings/unsupported. Use this rather than editing `test/spl/v2-show.test.js` for one-off translation checks — `v2-show.test.js` is for cases where you want test-runner output (multiple queries at once, JSON-stringified result fields).

## Architecture

See `docs/ARCHITECTURE.md` for full pipeline overview with worked example.

```
SPL → Peggy parser → AST → splToIR → IR → optimize → irToNrql → NRQL
```

### IR Nodes (src/ir/nodes.js)
Plain objects with `type` field. `SelectQuery` at query level. `Identifier`, `Literal`, `BinOp`, `Func`, `Alias`, `DualCheck`, etc. at expression level.

### IR Optimization (src/ir/optimize.js)
Six-pass pipeline using `transformTree` (generic bottom-up walker in `transform.js`):
1. Double-NOT elimination
2. Constant folding (arithmetic on number literals)
3. Tautology elimination (`x AND true` → `x`)
4. DualCheck expansion (`DualCheck(field, =, 500)` → `field = '500' OR numeric(field) = 500`)
5. Fillnull substitution (apply `_fillnullMap` entries)
6. Field replacement substitution (apply `_fieldReplacements` entries)

### Key Design Decisions
- **Smart backticking**: Only backtick identifiers with dots/dashes/spaces/colons/curlies. Simple names bare. Macros (`$name`) pass through.
- **DualCheck IR node**: `SPL: status=500` → `DualCheck` node → expanded by optimizer to `status = '500' OR numeric(status) = 500`. Consolidates dual-check logic from 2 call sites into 1 expansion pass.
- **Subquery wrapping**: Stats-after-stats wraps as `SubquerySource`, not string hack.
- **WHERE as condition list**: `ir.where` is `IRNode[]`, not a single tree. Handlers `push()` conditions; emitter joins with AND. No null checks needed.
- **Message catalog**: All user-facing messages in `src/messages.js`. Handlers call `messages.key()` — no inline template literals.

## Important Paths

### Source
- `src/translate.js` — Top-level entry: parse → optimize → emit
- `src/ir/` — IR node types (`nodes.js`), tree walker (`transform.js`), optimization pipeline (`optimize.js`)
- `src/input/spl/splToIR.js` — Entry point + search expr translation + command dispatch table
- `src/input/spl/*Handlers.js` — Command handlers split by theme: aggregation, enrichment, extraction, eval, row
- `src/input/spl/splExprUtils.js` — Shared utilities: field/function mapping, comparison builders, arithmetic parsing
- `src/output/nrql/` — IR→NRQL emitter and encoding utilities
- `src/messages.js` — Centralized catalog of all user-facing warning/unsupported/error messages

### Tests
- `test/spl/spl.test.js` — Unit tests + real-world regression suite
- `test/spl/spl-real-world.json` — small SYNTHETIC stub corpus (real-world regression path). The full real customer corpus + its generator and `corpus-diagnostic.mjs` harness live in the private sibling repo `nr-query-bridge-corpus` (kept out of this repo for open-sourcing; run the diagnostic from there)
- `test/spl/spl-fuzz.test.js` — Property-based fuzz tests (fast-check): combinatorial, corpus, mutation
- `test/spl/v2-show.test.js` — Quick output viewer: edit queries array, run, see NRQL + warnings
- `test/ir/` and `test/output/` — IR and emitter unit tests

### Docs & References
- `docs/ARCHITECTURE.md` — pipeline overview, file map, worked example
- `docs/SPL_TO_NRQL.md` — translation status doc and divergence analysis
- `.claude/references/nrql-reference.md` — NRQL syntax, functions, and translation gotchas (on-demand, read by agents)
- `.claude/references/spl-reference.md` — SPL syntax, commands, and translation gotchas (on-demand, read by agents)
- `.claude/references/datadog-reference.md` — Datadog query syntax, field mappings, translation patterns (on-demand, read by datadog-expert)
- `.claude/rules/design-decisions.md` — architectural choices affecting how code should be written

### Style & Lint
ESLint (flat config), Prettier, TypeScript checkJs. Husky pre-commit runs lint-staged; pre-push runs full lint + types:check. commitlint enforces conventional commits. Generated parser (`splParser.js`) excluded from all checks.

### Test Case Fields
- `spl` — input SPL query
- `nrql` — expected NRQL output
- `errorIncludes` — substring expected in errors
- `warningFunc` — exhaustive array of message keys (from `src/messages.js`) expected in warnings
- `unsupportedFunc` — exhaustive array of message keys expected in unsupported messages
- `doc` — tag linking to SPL_TO_NRQL.md sentinel section (optional for table-ified commands)
- `verified` — verification level (see below)
- `skip` — skip this test case

### Test Verification Levels
- `verified: 'human'` — reviewed and approved by human
- `verified: 'llm'` — reviewed by expert agents + MCP validation, not yet human-approved
- `verified: false` — unverified or has known FIXME

## Translation Analysis Process

When analyzing a new SPL command:
1. Grep real-world JSON for queries using it
2. SPL expert: determine intent, log structure, why it's used
3. NRQL expert: simplest NRQL for each intent
4. Identify distinct usage patterns
5. Compare to translator output — correct, close, or wrong?

## Expert Agents

Four custom agents in `.claude/agents/`. Invoke via the Agent tool with `subagent_type: "general-purpose"` and the agent file as context, or use Claude Code's `/agent` command:
- **spl-expert** — SPL query intent, syntax edge cases, command semantics. Research-only (no edits).
- **nrql-expert** — NRQL equivalents, syntax validation, optimal query approaches. Research-only (no edits).
- **nrql-validator** — Executes NRQL against account 1 via MCP (`execute_nrql_query`), classifies as SUCCESS/FAILURE with exact error messages. Use to bulk-validate translated queries.
- **datadog-expert** - Datadog query expert, query intent, syntax. Research-only (no edits).

The domain knowledge behind each agent lives in a matching skill (`spl-knowledge`, `nrql-knowledge`, `nrql-validation`, `datadog-knowledge`). Each agent is a thin wrapper — persona, tools, and a pointer to its skill. The main thread can load a skill directly (e.g. invoke `spl-knowledge` to explain an SPL query) instead of booting an agent, or dispatch the agent when it wants the work done in a separate context.
