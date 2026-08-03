# query-bridge

## Project Overview

Multi-language query translator. SPL/Lucene/PromQL/PPL → NRQL/Trino. Pure ESM JavaScript, no React, zero runtime dependencies *by default* (`@newrelic/query-bridge` stays dep-free unless a small vetted dep buys correctness that's impractical to hand-roll — e.g. an RE2 oracle; see `.claude/rules/design-decisions.md`). Publishable as `@newrelic/query-bridge`.

## Rules

* **Agent model for coding: use Opus.** Do NOT dispatch Sonnet or Haiku for any coding that needs judgment — on this codebase's subtle translator logic they produce plausible-but-wrong code and report false-greens (observed repeatedly). Reserve Sonnet/Haiku for purely mechanical tasks, and verify even those. Reviewers always run on the most capable model.
* For code analysis, use Read/Edit/Grep — do NOT shell out to node/python to inspect or transform source files. Work in chunks — you timeout over 200-300 lines.
* `node bin/spl2nrql.js "<query>"` IS allowed for translating ad-hoc SPL queries (see "Running ad-hoc SPL queries" below).
* When translating a list of queries, use v2-show.test.js.
* Commit messages: lowercase subject, max 72 chars; body lines ≤100 chars (commitlint). Use `git commit -F <file>` for multi-line bodies.
* Conventional commits required (`feat:`, `fix:`, `chore:`).
* Commit with `ASDF_NODEJS_VERSION=24.14.0 git commit` (hooks need Node 24).
* **Loud failure over silent wrong results.** If a command can't be translated correctly, emit `unsupported`, not a warning-and-skip. A user getting an error is better than a user getting wrong data.
* **Do not hand-zip / `tar` the working directory to share it.** It sweeps in `node_modules`, `.git`, and the gitignored `docs/local/` (private data that must not leave the repo). See "Packaging & distribution" in README.md.
* **OSS-bound — never commit customer identifiers** (names, hosts, indexes, customer-specific field names); use placeholders (`userId`, `region_north`). A pre-commit scan (`scripts/scan-customer-names.sh`) enforces this against a denylist whose canonical copy is **tracked in the private `../nr-query-bridge-corpus` repo** (a gitignored-only list gets lost — that's how the original `scrub-mappings.yml` vanished). The scan SKIPS when no denylist is present, so the rule stands even when it can't run. See CONTRIBUTING "Sensitive data".
* **Small PRs, and every spec/plan MUST plan them.** Keep each PR to one reviewable concern: separate refactor/rename/move from behavior change and land the refactor *first*, then cut along the pipeline seams (grammar + `build:parsers` → IR node + factory → optimizer pass → emitter + message keys → wiring + `spl.test.js` cases) so each step reviews in isolation. **Every spec/plan under `docs/superpowers/` MUST end with an ordered "PR breakdown" section** — a numbered list where each entry states that PR's scope, its dependency on the previous one, and roughly its size, smallest shippable slice first and scaffolding/plumbing before the feature that consumes it. Default target ≤~400 changed lines per PR; a slice that exceeds that gets split further. A spec that would land as one massive PR is incomplete — the PR breakdown is a required deliverable, not an afterthought.
* **Sidekick review waived for this repo (approved exception SLCREV-1164).** While this stays a private GHE (`source.datanerd.us`) repo built for a single customer, the S-5 sidekick-review / branch-protection requirement is waived per SLCREV-1164 (approved 2026-06-29 — Security review complete, Compliance approved, Legal not required). So merging a user-approved PR solo via `gh pr merge --admin --rebase` is sanctioned here, **not** a standards bypass — and the `sidekick:approved` label stays unnecessary (never apply it to fake a review). **Caveat: the exception does NOT cover the public-GitHub phase** — once this repo moves to public GitHub, a second collaborator is required to satisfy branch protection (per Compliance on SLCREV-1164).
* **NRQL validation: `execute_nrql_query` runs an older NRQL grammar — re-check failures via `run_nerdgraph_query` or the UI.** It falsely rejects 12 functions (`jparse`, `convert`, `cidrAddress`, `toTimestamp`, `toDatetime`, `encode`, `decode`, `mapKeys`, `mapValues`, `split`, `replace`, `aggregateFunnel`) AND the `PREDICT` clause → they error via `execute_nrql_query` but run fine via `run_nerdgraph_query` and the UI (verified acct 1, 2026-06-24). NOT affected: `blob`, `lookup`, `stddev`, `subnet`, `meta`, `hdrHistogram`/`hdrPercentile`/`hdrPercentiles`, `attributeCardinality`, `SLIDE BY`. The `nrql-validator` agent / `nrql-validation` + `nrql-knowledge` skills inherit this. (Note: `Unknown function count()` from wrapping an aggregate in a function that can't take one — e.g. `numeric(count(x))` — is NOT a tool bug; it's an invalid query, deterministic on both tools. `string()` can wrap an aggregate, `numeric()` can't.) Full classified list: `.claude/references/nrql-reference.md`.

## Build & Test

Dev requires **Node 24** (hooks, CI): prefix every command `ASDF_NODEJS_VERSION=24.14.0 <command>`. (Consumers only need Node 20+ — see README.) Standard scripts (`npm test`, lint, format) and end-user CLI usage are in the README; the agent-relevant extras:

```
npm run test -- spl             # filter to matching files (Vitest positional; NOT Jest --testPathPattern)
npm run test --workspace=@newrelic/dashboard-importer -- <f>   # run ONE package in isolation; root `npm test` chains --workspaces && vitest, so a failing package aborts later ones — use this when iterating one package (e.g. a cross-package mutant)
npm run lint:fix                # ESLint with auto-fix
npm run types:check             # TypeScript checkJs (no emit)
npm run build:parsers           # regenerate Peggy parser AFTER any grammar change
```

### Running ad-hoc SPL queries

`node bin/spl2nrql.js "<query>"` is the fastest way to translate a single SPL query and see its NRQL + warnings/unsupported. Use this rather than editing `test/spl/v2-show.test.js` for one-off translation checks — `v2-show.test.js` is for cases where you want test-runner output (multiple queries at once, JSON-stringified result fields).

## Architecture

```
SPL → Peggy parser → AST → splToIR → IR → optimize → irToNrql → NRQL
```

**Full pipeline, stage table, six-pass optimizer, file map, and a worked example: `docs/ARCHITECTURE.md`.** Read it before non-trivial pipeline work. The invariants below are the ones a casual edit could violate — they stay here so they're always loaded.

### Key Design Decisions
- **Smart backticking**: Only backtick identifiers with dots/dashes/spaces/colons/curlies. Simple names bare. Macros (`$name`) pass through.
- **DualCheck IR node**: `SPL: status=500` → `DualCheck` node → expanded by optimizer to `status = '500' OR numeric(status) = 500`. Consolidates dual-check logic from 2 call sites into 1 expansion pass.
- **Subquery wrapping**: Stats-after-stats wraps as `SubquerySource`, not string hack.
- **WHERE as condition list**: `ir.where` is `IRNode[]`, not a single tree. Handlers `push()` conditions; emitter joins with AND. No null checks needed.
- **Message catalog**: All user-facing messages in `src/messages.js`. Handlers call `messages.key()` — no inline template literals.

## Important Paths

> **Monorepo layout:** the translator package lives under `packages/nr-query-bridge/`. Every `src/…`, `test/…`, `bin/…`, `docs/ARCHITECTURE.md`, and `docs/SPL_TO_NRQL.md` path in this section is **relative to that package root** — prefix with `packages/nr-query-bridge/` for a repo-root path (e.g. `packages/nr-query-bridge/src/messages.js`). Repo-root paths that are NOT under the package: `.claude/…`, `docs/superpowers/…`, `docs/local/…`, root `README.md`. The dashboard CLI is `packages/nr-dashboard-importer/`.

### Source
Full file map (every handler file + what it owns) lives in `docs/ARCHITECTURE.md` → File Map. The two entry points worth memorizing: `packages/nr-query-bridge/src/translate.js` (top-level: parse → optimize → emit) and `packages/nr-query-bridge/src/messages.js` (the centralized warning/unsupported/error catalog — never inline a user-facing message).

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
- `.claude/rules/design-decisions.md` — architectural choices affecting how code should be written; also where shipped-spec invariants graduate to. Before deleting a shipped `docs/superpowers/` spec/plan, capture its durable invariants there first.

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
