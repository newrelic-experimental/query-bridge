# Subquery Wrapping — inner-vs-outer field placement (reconciliation)

**Date:** 2026-06-18
**Status:** Verified 2026-06-18 via targeted probes through `bin/spl2nrql.js` (see Verified findings). Q1/Q2/Q3 answered. The stats-after-stats / where-after-stats inner/outer split is correct; **three real bugs** surfaced (eval-after-stats never wraps, `head N` between stats is silently dropped, `timechart … | stats …` puts TIMESERIES on the wrong query). No code change made yet — the fixes are behavior changes pending review.

## Why this spec exists

`design-decisions.md` recorded: "Subquery wrapping: … `wrapAsSubquery` carries expand/timeseries into inner query and clears `_fieldReplacements`." Verified against the actual body (`src/input/spl/splExprUtils.js:265`), all three specifics are wrong:

- **`expand`** — there is no `expand` field on the IR (`src/ir/nodes.js`). Phantom, tied to the unbuilt EXPAND work (see `2026-06-18-mvexpand-to-expand-design.md`).
- **`timeseries` into the inner query** — `wrapAsSubquery` does not copy `timeseries`; it stays on the OUTER query. Nesting TIMESERIES is itself fragile (see `messages.dedup_timeseries_warning`: "TIMESERIES on a nested subquery only populates the first time bucket"), so carrying it inward would likely be *wrong*, not merely missing.
- **clears `_fieldReplacements`** — `wrapAsSubquery` never touches `_fieldReplacements`; substitution happens later in the optimizer's `applyFieldReplacements` pass.

The fix is not a one-line doc edit, because *which* fields belong on the inner vs outer query in a wrapped stats-after-stats is a real design question. Capturing it here rather than asserting an unverified replacement rule.

## Actual behavior (shipped)

`wrapAsSubquery(ir)` (`splExprUtils.js:265`), called from `aggregationHandlers.js:25` (`handleStats` — stats after an aggregation) and `evalHandlers.js:35` (`handleWhere` — **WHERE** after an aggregation). The earlier "eval after an aggregation" label was wrong: `handleEval` (`evalHandlers.js:46`) does **not** wrap — see Finding 0.

- Builds `innerQuery = SelectQuery({ dataSource, bindings, select, where, facet, limit })` — inner `limit` is `MAX` when the inner has a FACET, else the current `ir.limit`.
- Sets `ir.dataSource = SubquerySource{ innerQuery }`, then clears `ir.select / facet / bindings / where`.
- **Leaves on the outer query:** `timeseries`, `orderBy`, `limit`, `since`, `until`, `join`, `predict`, `_fieldReplacements`, `_timeBucketAliases`.

So: projection / grouping / filtering move INNER; time window, ordering, limit, time-bucketing, and field renames stay OUTER.

## Verified findings (2026-06-18)

Each probe below was run through `bin/spl2nrql.js`; the emitted NRQL is quoted. Time-window/order semantics cross-checked against `.claude/references/nrql-reference.md` § Subqueries (the canonical nested-aggregation pattern: `SELECT max(rpm) FROM ( SELECT count(*) AS rpm FROM T TIMESERIES 1 minute )` — TIMESERIES on the **inner**, max on the outer).

**Finding 0 — eval-after-stats never wraps (🔴 silent wrong result).** `* | stats count by host | eval pct = count * 100` →
`FROM Log WITH numeric(count) * 100 AS pct SELECT count(*) WHERE … FACET host`. `handleEval` does not call `wrapAsSubquery`, so the eval becomes a **pre-aggregation** `WITH` binding referencing a raw-event `count` that doesn't exist post-stats; `pct` is also never selected. Emitted with no warning/unsupported — violates "loud failure over silent wrong." The shipped test `spl.test.js:993` (`* | stats count | eval x = round(total/count, 2)`, `verified: 'llm'`) encodes exactly this unwrapped output as "expected": it compiles (so MCP validation passed it) but is semantically wrong. Fix: wrap like `handleWhere`, or emit `unsupported`.

**Q1 — time-window placement: SINCE/UNTIL correct on outer; TIMESERIES wrong on outer.**
- `… earliest=-24h | stats count by host | stats avg(count) as a` → `FROM ( … FACET host LIMIT MAX) SELECT average(count) AS 'a' SINCE 24 hours ago`. SINCE on the outer is the query-global window and scopes the inner scan — **correct** (not independently re-confirmed against live execution, but consistent with NRQL window semantics).
- `… | timechart count by host | stats avg(count) as a` → `FROM ( … FACET host LIMIT MAX) SELECT average(count) AS 'a' TIMESERIES AUTO`. 🔴 **Wrong.** The reference's canonical pattern puts TIMESERIES on the **inner** aggregation; here the timechart's time-bucketing is dropped from the inner and `TIMESERIES AUTO` is bolted onto the outer (a non-time-bucketed average). So "leave timeseries outer" is NOT a safe blanket rule — TIMESERIES must travel with the aggregation that owned it (inner), unlike the global SINCE/UNTIL window.

**Q2 — field replacements reaching the inner: no correctness bug.** `… | rename src as host | stats count by host | stats avg(count) as a` and `… | stats count by src | rename src as host | stats avg(count) as a` both emit correct NRQL. Renames are materialized as `X AS Y` select columns *when the rename is processed* (before the second stats wraps), so the wrap carries them into the inner query; the trailing grouping field is then aggregated away by the outer stats, so the rename can't affect the final scalar. The vestigial `_fieldReplacements` map left on the outer is harmless. Cost: a dead `src AS 'host'` column in the inner and a sometimes-spurious "rename keeps original field names" warning. Not a bug.

**Q3 — `head N` between stats is silently dropped (🔴 wrong result).** `… | stats count by host | head 10 | stats avg(count) as a` → `FROM ( … FACET host LIMIT MAX) SELECT average(count) AS 'a' LIMIT 10`. The `head 10` limit lands on the **outer** (a no-op: the outer avg has no FACET, so it's one row), while the inner is forced to `LIMIT MAX` because it has a FACET. Net: the "top 10 hosts before averaging" semantic is lost — the average covers all hosts. Fix: a `limit` set between aggregations must apply to the inner query, or emit `unsupported`.

**Non-finding — sort between stats compiles, vacuous.** `… | stats count by host | sort -count | stats avg(count) as a` → `… SELECT average(count) AS 'a' ORDER BY count DESC`. `count` is the inner's output column so `ORDER BY count` is valid, but ordering a single-row aggregate is a no-op (matching Splunk, where sort-before-avg is also pointless). Not a bug.

## Blast radius (customer corpus, 2026-06-18)

Counts from the private corpus (`nr-query-bridge-corpus/spl-real-world.json`, 32,436 queries) via count-only `grep` proxies — **upper bounds** (regex matches the command order, not translate-time outcome). The corpus repo already ships `diag-stats-eval-errors.mjs` / `count-eval-unsup.mjs`, which would refine these to exact translate-time classifications:

| Bug | Proxy | Matches | Share |
|---|---|---|---|
| eval-after-stats (Finding 0) | `(stats\|timechart\|chart\|eventstats) … \| eval` | **~3,333** | ~10% |
| TIMESERIES placement (Q1) | `(timechart\|chart) … \| stats` | ~48 | ~0.15% |
| limit between aggregations (Q3) | `stats … \| head … \| stats` | **0** | 0% |
| where-after-stats (correct path) | `stats … \| where` | ~1,157 | ~3.6% |

So eval-after-stats dominates; Q1 is marginal; Q3 has zero real-world incidence (the probe was contrived).

## Fix plan (buildable, prioritized by blast radius)

Each fix is a behavior change with its own red-green test. **None done yet.** Verification note: NRQL compile-validation (MCP) will NOT catch these — all three buggy outputs compile. Each fix needs a golden-NRQL test asserting the *wrapped* output, plus a human reading it against SPL intent.

**Fix 1 — eval-after-stats (~10% of corpus, do first).**
- Locus: `handleEval` (`evalHandlers.js:46`). Today it calls `translateEvalExpr` unconditionally.
- Change: when `ir._hasAggregation`, call `wrapAsSubquery(ir)` first (mirror `handleWhere` at `evalHandlers.js:34`), so the eval binds on the outer query over the aggregated result. If wrapping can't express the eval correctly, emit `unsupported` — never the silent pre-aggregation `WITH`.
- Test (red first): `* | stats count by host | eval pct = count * 100` → expect `FROM (FROM Log SELECT count(*) … FACET host LIMIT MAX) WITH numeric(count) * 100 AS pct SELECT …` (or `unsupported`), NOT today's pre-agg `WITH`.
- Also: drop `spl.test.js:993` to `verified: false` (it asserts the buggy output; only a human re-promotes).

**Fix 2 — TIMESERIES placement (~0.15%, low).**
- Locus: `wrapAsSubquery` (`splExprUtils.js:265`) + its callers. `timeseries` currently stays on the outer.
- Change: a `timeseries` set by an inner `timechart`/`bin _time` must move INTO the inner `SelectQuery`. SINCE/UNTIL correctly stay outer (global window).
- Test: `* | timechart count by host | stats avg(count) as a` → expect TIMESERIES on the inner, none on the outer.

**Fix 3 — limit between aggregations (0%, lowest / optional).**
- Locus: `wrapAsSubquery` — inner is forced to `LIMIT MAX` when it has a FACET, discarding a pre-wrap `head N`.
- Change: carry the pre-wrap `limit` to the inner query, or emit `unsupported`. Zero corpus incidence — safe to defer or just `unsupported`.

Until fixed, the `design-decisions.md` "Subquery wrapping" bullet states only the verified fact (wraps as `SubquerySource` via `wrapAsSubquery`, with the observed inner/outer split) plus a pointer here — and its call-site label is corrected to "where-after-stats."

## Non-goals

- Building EXPAND field carrying (separate spec: `2026-06-18-mvexpand-to-expand-design.md`).
- Changing the `contains(jparse())` membership path.
