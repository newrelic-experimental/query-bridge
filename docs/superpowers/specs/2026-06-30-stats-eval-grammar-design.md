# Bare `eval(...)` as a stats/timechart function — design

**Date:** 2026-06-30
**Status:** Draft for review.
**Scope:** `@newrelic/query-bridge` (translator) — **grammar change**.
**Source:** `known-issues-laundry-list` row `stats-eval-grammar` (BUG). SPL semantics verified via docs.splunk.com (`SearchReference/Timechart`, 2026-06-30); NRQL target verified live (staging acct 1, 2026-06-30).

**Summary:** Parse a bare `eval(<expr>)` in stats/timechart function position and translate it to the equivalent NRQL aggregate expression (`stats eval(sum(errors)*100/sum(reqs))` → `SELECT sum(errors)*100/sum(reqs) AS rate`); emit a precise `unsupported` when there's no aggregate or a non-fold-safe function wraps one. Today the metric is silently dropped to `SELECT *` under a false "no equivalent" warning. Load-bearing constraint: the translation needs a **new** stats-context expression walk — there is no `walkStatsExpr` to reuse, and the existing `walkEvalExpr` rejects `avg()` outright.

## Problem

A bare `eval(EXPR)` in stats/timechart **function** position does not parse as a stats function — only `fn(eval(...))` (e.g. `count(eval(cond))`) parses today. So the metric is **silently dropped**: the translator emits `SELECT *` plus a **misleading** `eval() has no known NRQL equivalent` warning.

Verified today (`bin/spl2nrql.js`):
- `* | timechart eval(sum(errors)*100/sum(reqs)) as rate span=5m` → `FROM Log SELECT * TIMESERIES 5 minutes` + `eval() has no known NRQL equivalent` ← **wrong**: the metric vanished, and the warning is false.
- The downstream `SELECT *` + `TIMESERIES` then *also* render-fails (`select-star-in-chart`).

**The warning is false** — NRQL expresses arithmetic over aggregates natively. Verified live (staging acct 1): `FROM Log SELECT (count(*)*100.0)/count(*) AS pct …` → `pct: 100`; `sum(numeric(timestamp))/count(*)` returns a value. So `sum(errors)*100/sum(reqs)` → `SELECT sum(errors)*100/sum(reqs) AS rate` is faithful and renderable.

`eval()` as a bare stats/timechart function is valid, idiomatic SPL — the Splunk Timechart doc's own examples: `timechart span=1m eval(avg(CPU) * avg(MEM)) BY host` and `timechart eval(round(avg(cpu_seconds),2)) BY processor`.

## Approaches considered

- **A (recommended): parse `eval(EXPR)` as a stats function; translate the aggregate expression.** The grammar recognizes a bare `eval(u_expr)` stats function; the handler translates the expression with a **stats-context walk** — routing each aggregate call (`sum`/`avg`/`count`/…) through `mapFunction` (`splExprUtils.js`, the same aggregate mapper `handleStats` uses for normal functions: `avg`→`average`, etc.), with arithmetic and fold-safe scalar functions walked structurally. Faithful for the dominant case (aggregate arithmetic, fold-safe functions over aggregates); a precise `unsupported` for the rest. **This is new logic, NOT a drop-in reuse:** there is no `walkStatsExpr`, and the only existing walker, `walkEvalExpr`, is eval-context — it emits `unsupported` for a bare `avg()` (verified: `eval x = avg(a)` → `unsupported`) and does not map aggregate names to NRQL aggregates. The eval-after-stats fold is the precedent for *emitting* arithmetic-over-aggregates, not a walker to call.
- **B: `unsupported` all bare-`eval()`** (just replace the misleading "no equivalent" warning with a precise `unsupported`). Simpler, but leaves the *faithful* cases (`avg(CPU)*avg(MEM)`, `round(avg(x),2)`) on the table — the same over-conservative "no faithful form" error corrected elsewhere this project. **Rejected.**
- **C: handle in the importer post-hoc.** Wrong layer — this is a translator grammar/semantics gap.

## Design (Approach A)

1. **Grammar** (`spl.grammar`, `stats_function`, ~line 111): add an alternative recognizing `eval(u_expr)` as a top-level stats function (distinct from `fn(eval(...))`), producing a function node carrying the parsed `u_expr` (e.g. `{ evalExpr: <u_expr>, alias }`). The `as <name>` alias is the existing `as_clause` (optional — the Splunk examples omit it). MUST NOT disturb `count(eval(...))`/`sum(eval(...))` (the `fn(eval(...))` form stays an aggregate-of-an-eval-predicate). `build:parsers` after the change.
2. **Handler** (`handleStats` in `aggregationHandlers.js`; `handleTimechart` delegates): for an `evalExpr` stats function, translate the parsed `u_expr` with a **new stats-context walk** (`walkStatsExpr` does NOT exist today). It walks the `EvalArith`/… tree structurally — like `walkEvalExpr` — but resolves each aggregate call (`sum`/`avg`/`count`/…) via `mapFunction` (`splExprUtils.js:120`) so they become NRQL aggregates (`avg`→`average`, `count`→`count(*)`). **Do not call `walkEvalExpr` directly: it is eval-context and emits `unsupported` for `avg()` (verified), not the aggregate.** Then:
   - **Translatable** — the walked expression contains ≥1 aggregate AND every function is fold-safe (arithmetic + the existing `FOLD_SAFE_FUNCS`: `round abs ceil floor sqrt exp ln log … getField …`, the dirac distributed set the eval-after-stats fold already uses) → push `Alias(expr, name)` (or the bare expr when no `as`). Emits `SELECT <expr> AS <name>`.
   - **Not translatable** — no aggregate at all (a constant/row-wise eval is not a meaningful stats metric; note a pure constant like `eval(2*3)` *is* renderable as `SELECT 2*3`, but we reject it rather than best-effort a degenerate non-aggregation — conscious choice), or a non-fold-safe function over the aggregate (`concat`, `numeric`, string ops like `lower`/`upper`/`substring`/`replace`/`split` — note `if`/`case` ARE fold-safe), or the stats-context walk returns null → push a **precise** `unsupported` (`stats_eval_unsupported`), never the old "no equivalent" + `SELECT *`.
3. **Message:** add `stats_eval_unsupported(expr)`; remove the misleading bare-`eval()` "no known NRQL equivalent" path for this position. The existing `eval()` eval-function-unsupported message stays for genuine eval-context misuse.

## Acceptance criteria (synthetic; confirm exact NRQL via `bin/spl2nrql.js`)

- `* | timechart eval(avg(CPU) * avg(MEM)) by host span=5m` → `FROM Log SELECT average(CPU) * average(MEM) FACET host TIMESERIES 5 minutes` (renderable; metric preserved). Today: `SELECT *` + false warning.
- `* | timechart eval(round(avg(cpu_seconds), 2)) by processor` → `FROM Log SELECT round(average(cpu_seconds), 2) FACET processor TIMESERIES AUTO`.
- `* | stats eval(sum(errors)*100/sum(reqs)) as rate` → `FROM Log SELECT sum(errors) * 100 / sum(reqs) AS rate` (confirm operator/precedence formatting against the emitter).
- `* | stats eval(upper(host)) as h` (no aggregate) → `unsupported` (`stats_eval_unsupported`) — not a valid stats metric.
- `* | stats eval(mvjoin(values(x), ",")) as j` (non-fold-safe over an aggregate) → `unsupported`.
- **Regression:** `* | stats count(eval(status>=500)) as errors` → unchanged `filter(count(*), WHERE numeric(status) >= 500) AS 'errors'` (the `fn(eval(...))` form must not change).

## Testing

Data-driven `cases` in `test/spl/spl.test.js`: the translatable forms (agg arithmetic, fold-safe-func-over-agg, with/without `as`, with/without `by`/`span`), the `unsupported` forms (no aggregate; non-fold-safe), and the `count(eval(...))` regression. (No `test/messages.test.js` exists — message-key consistency is the forward-only spy loop in `test/spl/spl.test.js`; the new key is exercised by its consumer's `unsupportedFunc` cases.) Grammar: `npm run build:parsers` after the `.grammar` edit; a parser-level unit confirming `eval(u_expr)` parses as a stats function and `count(eval(...))` still parses as an aggregate-of-eval. Fuzz ×20 (the grammar change is the risk — a bare `eval(` must not mis-parse adjacent constructs). Staging: the translatable outputs execute (arithmetic-over-aggregates already confirmed; spot-check one `eval()`-derived query).

## PR breakdown

1. **Grammar: parse a bare `eval(...)` stats function** (~150–200 lines incl. generated parser, behavior — the stats-context walk is new logic, not a reuse, so size reflects that) — add the `stats_function` alternative + `build:parsers`; the handler translates a fold-safe aggregate expression via the new stats-context walk (aggregate calls through `mapFunction`, arithmetic/fold-safe scalars structurally), else `stats_eval_unsupported`. Add the translatable + unsupported + `count(eval())`-regression cases. Dependency: none (off master). The whole fix is one reviewable slice — grammar, handler, and message move together (a grammar change with no handler is inert; splitting buys no isolation).
2. **(Optional) graduate** (~20 lines, docs) — once on master, graduate the invariant (`eval()` as a stats function → fold-safe aggregate expr or `stats_eval_unsupported`; `fn(eval())` is the distinct aggregate-of-predicate form) into `.claude/rules/design-decisions.md` and strike the laundry-list row. Dependency: PR 1 + staging.
