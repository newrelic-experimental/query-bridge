# Key Design Decisions

Architectural choices that affect how code should be written and modified.

> **This file is where shipped specs graduate.** When a `docs/superpowers/` spec/plan ships, its durable *invariants* (things a future edit could violate) move here as one-liners; the spec/plan is then deleted (git history is the archive). Before deleting any shipped spec/plan, confirm its invariants are captured below — distill, don't archive. The build narrative (alternatives weighed, corpus counts, "how we got here") dies with the spec; only the load-bearing rule survives. Retiring a spec is a good moment to run `/nr:reflect`.

## IR & Optimization
- **DualCheck IR node**: `SPL: status=500` → `DualCheck` node → expanded by optimizer to `status = '500' OR numeric(status) = 500`. Consolidates dual-check logic from 2 call sites into 1 expansion pass.
- **Subquery wrapping**: Stats-after-stats (and eval-after-stats) wraps the current query as a `SubquerySource` via `wrapAsSubquery` — inner takes `dataSource/bindings/select/where/facet/limit`; outer keeps `timeseries/orderBy/limit/since/until/_fieldReplacements`. Whether that inner/outer split is correct in every case has open questions — see `docs/superpowers/specs/2026-06-18-subquery-wrapping-design.md`.
- **WHERE as condition list**: `ir.where` is `IRNode[]`, not a single tree. Handlers `push()` conditions; emitter joins with AND. No null checks needed.
- **Field replacement scoping**: `applyFieldReplacements` only replaces in select/where/facet/orderBy — NOT in bindings/expand/dataSource. Prevents corrupting WITH/EXPAND source expressions.

## Expression Walking
- **Walker composition**: `walkExpr(node, ir, resolveFunc)` is the shared core. `walkEvalExpr` uses `resolveEvalFunc` (eval context — string ops, conditionals, multivalue functions), `walkStatsExpr` uses `resolveStatsFunc` (stats context — sum/count/avg are aggregation functions). Same tree walking, different function-call semantics.
- **Eval expression representation (SHIPPED)**: One unified typed ladder (`u_expr` and below in `spl.grammar`). All four call sites — eval func args, top-level eval assignment, stats function args, and stats `fn(eval(...))` inner — reference `u_expr` directly. The grammar produces typed `EvalArith`/`EvalBoolOp`/`EvalComparison`/`EvalNot` nodes; `walkEvalExpr` handles them in a switch. No flat-string round-trip; `buildArithmeticExpr` and `tryParseDotConcat` deleted. The `u_atom_stats_extra` rule handles stats wildcard tokens (`count(*)`, `app.*`) with a `![0-9]` guard to prevent `a*2` from being swallowed as a wildcard. **Known deferred (corpus demand confirmed):** infix `LIKE`, `IN`, and `if(cond,1,0)`→plain-predicate unwrap are not yet in the ladder — `LIKE`/`IN` inside `eval()` currently hard-error.
- **Stats vs eval `sum()`**: In stats context, `sum(x)` is aggregation (via `resolveStatsFunc`). In eval context, `sum(x)` is multivalue sum on one event (via `resolveEvalFunc`). The walker strategy parameter handles this.

## WHERE Comparison RHS
- **RHS eval tier**: `where_comparison` parses its RHS at the `u_add` tier (not `u_expr`); widening to `u_expr` would let `where a > b AND c < d` greedily swallow the `AND`. The `u_add` alternative must precede the bare `where_value` fallback, which stays last (reversing it breaks arithmetic RHS like `a > b + 1`).
- **Relative time → SINCE/UNTIL**: `_time`/`timestamp` compared to `relative_time()`/`now()` emits `ir.since`/`ir.until`, never inline WHERE (NRQL rejects relative-time in WHERE) — and produces no `BinOp`.
- **Numeric coercion both sides**: ordering ops (`> < >= <=`) wrap BOTH the LHS field and a bare-field RHS in `numeric()`, not just the LHS.
- **Unsupported over wrong**: a comparison RHS using a not-yet-row-wise NRQL function (`jparse`/`convert`/`cidrAddress`/`toTimestamp`/`decode`/`encode`/`mapKeys`/`mapValues`/`lookup`/`blob`/…) emits `unsupported` rather than non-compiling NRQL. `LIKE`/`RLIKE`/`IN` keep a literal-only RHS on the `where_value` fallback.

## Dashboard Time Tokens
- **Drop, never passthrough**: Splunk `$…$` tokens in `earliest=`/`latest=` are caught before `parseSplTime` and dropped with a warning; a `TemplateVariable` named `earliest`/`latest` (or `*.earliest`/`*.latest`) is likewise dropped — never emit `SINCE {{…}}`. No `$…$` or `{{…}}` may reach a SINCE/UNTIL/TIMESERIES clause; those accept only concrete literals.
- **Mixed window → unsupported**: a mixed literal+token window escalates to `unsupported` and clears any partial since/until (no half-window leaks). `span=$tok$` parses as a `SpanToken` and emits `span_token_unsupported`, with no TIMESERIES.
- **Per-call scope**: time-token flags are scoped per `translateSearchExpr` call — a subsearch's flags never escalate the outer query's window.

## SPL Grammar Leniency
- **Separator leniency scope**: comma/space/empty-interchangeable list separators apply only to stats/top/fields/by/IN lists — never to rename pairs or eval comma-chained assignments. Quote-as-token-boundary leniency is search-context only (do not generalize to eval/where).
- **`bin`/`bucket` `as X`** is a field rename, not the `min()` function — grammar and IR must never conflate them.
- **`!` as NOT** in `where` is guarded to match only before `(` or whitespace, never before `=` — preserving `!=` as a comparison operator.
- **`top` percent subquery** must inherit the outer query's WHERE clause (else the denominator diverges). `sort`/`timechart` `limit=0` → `LIMIT MAX`; `limit=N` → `LIMIT N`.

## Packaging & Monorepo
- **`@newrelic/` scope**: both packages publish under it (`@newrelic/query-bridge`, `@newrelic/dashboard-importer`); each scoped package needs `publishConfig.access: public`. Root `package.json` stays `private: true` — the workspace root is never published.
- **Dependency direction**: `@newrelic/query-bridge` carries zero runtime dependencies; all runtime deps (e.g. `fast-xml-parser`) live in `@newrelic/dashboard-importer`. The dependency is one-way — importer → translator, never the reverse.
- **Repolinter hard gate (newrelic-experimental ruleset)**: the root `README.md` must open with the experimental `<picture>` banner within its first 5 lines AND contain a `../../security/policy` link; a root `LICENSE` must exist; a local `CODE_OF_CONDUCT.md` must NOT exist (centralized in `newrelic/.github`). These four are the only ERROR-level rules — `THIRD_PARTY_NOTICES` is WARNING-level. `THIRD_PARTY_NOTICES.md` lives at the repo root (and per published package), regenerated via FOSSA/OSPO tooling before any `npm publish`. (Remaining publish runbook lives in Jira NR-578293.)

## Dashboard Importer
- **`DashboardModel` is the seam**: both parsers (Simple XML, Studio) produce it; all emitters (Terraform, NerdGraph, UI-paste) consume it; no stage downstream of the parsers branches on source format. The neutral `vizType` enum is the parser↔emitter contract — adding a viz type touches one map per side, never the pipeline.
- **`detectFormat` owns unwrapping**: it strips the REST envelope, CDATA, and XML entities, and throws a clear "not yet supported" for Studio/envelope shapes; downstream parsers each receive one clean single-format input and never re-unwrap.
- **Loud placeholders, never drops**: unsupported or errored widgets become `markdown` placeholder widgets in the same grid slot (title + fenced SPL + reason) — layout preserved. A placeholder emits `{ "text": … }` in `rawConfiguration`, never `{ "nrqlQueries": […] }` (the two shapes are not interchangeable).
- **Tokens emitted unquoted**: template-variable tokens go into NRQL bare (`category = {{tok}}`), never inside a string literal — NR substitutes an already-quoted value, so a quoted token matches nothing.
- **Splunk defaults**: a `<chart>` with no `charting.chart` option defaults to `line` (Splunk's default), or such panels wrongly become placeholders.
- **Terraform output**: three files — `<slug>.tf` (dashboard), `versions.tf` (provider pin `~> 3`), `variables.tf` (account_id + sensitive `newrelic_api_key`) — and no `backend` block (that is the consumer's). `variables.tf` never contains a literal API key.
- **Deterministic + safe identifiers**: re-running on the same input produces byte-identical output so `terraform apply` reconciles cleanly. `slugify` prefixes digit-leading names (Terraform identifiers can't start with a digit); `--account` validates numeric and rejects non-numeric loudly.
- **HCL escaping**: emitted HCL must escape Terraform `${…}`/`%{…}` as `$${…}`/`%%{…}` and any Splunk `$token$` delimiters, or the `.tf` is syntactically invalid.

## Emitter & Encoding
- **Smart backticking**: Only backtick identifiers with dots/dashes/spaces/colons/curlies. Simple names bare. Macros (`$name`) pass through.

## Messages & Pipeline
- **Message catalog**: All user-facing messages in `src/messages.js`. Handlers call `messages.key()` — no inline template literals. `splExprUtils.js` uses lazy getters for `resolveStatsFunc` warnings so spies work. Bidirectional consistency test in `test/messages.test.js`.
- **Pipeline-level detection**: `splToIR.js` tracks state across the pipeline loop (dedup seen, mvexpand fields) and emits warnings after the loop (capture count, FACET LIMIT default, cascading/cross-field mvexpand). Individual handlers don't have pipeline context.
