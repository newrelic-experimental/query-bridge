# Subquery Wrapping — inner-vs-outer field placement (reconciliation)

**Date:** 2026-06-18
**Status:** Reconciliation + open questions. The feature (stats-after-stats / eval-after-stats subquery wrapping) **is shipped and tests pass**; this spec corrects a stale `design-decisions.md` claim and frames the field-placement questions it exposed. No behavior change yet.

## Why this spec exists

`design-decisions.md` recorded: "Subquery wrapping: … `wrapAsSubquery` carries expand/timeseries into inner query and clears `_fieldReplacements`." Verified against the actual body (`src/input/spl/splExprUtils.js:265`), all three specifics are wrong:

- **`expand`** — there is no `expand` field on the IR (`src/ir/nodes.js`). Phantom, tied to the unbuilt EXPAND work (see `2026-06-18-mvexpand-to-expand-design.md`).
- **`timeseries` into the inner query** — `wrapAsSubquery` does not copy `timeseries`; it stays on the OUTER query. Nesting TIMESERIES is itself fragile (see `messages.dedup_timeseries_warning`: "TIMESERIES on a nested subquery only populates the first time bucket"), so carrying it inward would likely be *wrong*, not merely missing.
- **clears `_fieldReplacements`** — `wrapAsSubquery` never touches `_fieldReplacements`; substitution happens later in the optimizer's `applyFieldReplacements` pass.

The fix is not a one-line doc edit, because *which* fields belong on the inner vs outer query in a wrapped stats-after-stats is a real design question. Capturing it here rather than asserting an unverified replacement rule.

## Actual behavior (shipped)

`wrapAsSubquery(ir)` (`splExprUtils.js:265`), called from `aggregationHandlers.js:25` (stats after an aggregation) and `evalHandlers.js:35` (eval after an aggregation):

- Builds `innerQuery = SelectQuery({ dataSource, bindings, select, where, facet, limit })` — inner `limit` is `MAX` when the inner has a FACET, else the current `ir.limit`.
- Sets `ir.dataSource = SubquerySource{ innerQuery }`, then clears `ir.select / facet / bindings / where`.
- **Leaves on the outer query:** `timeseries`, `orderBy`, `limit`, `since`, `until`, `join`, `predict`, `_fieldReplacements`, `_timeBucketAliases`.

So: projection / grouping / filtering move INNER; time window, ordering, limit, time-bucketing, and field renames stay OUTER.

## Open questions (the actual work)

1. **Time-window placement.** Is leaving `timeseries` / `since` / `until` on the OUTER query correct for every stats-after-stats and eval-after-stats input? Construct targeted cases — `timechart … | stats …`, `stats … | sort … | stats …`, time-bounded `… earliest=-24h | stats | stats` — and confirm the emitted NRQL is semantically right. The `dedup_timeseries_warning` shows nested TIMESERIES is known-fragile, so "TIMESERIES stays outer" should be a deliberate rule, not an accident.
2. **Field replacements reaching the inner query.** `design-decisions.md` ("Field replacement scoping") says `applyFieldReplacements` does NOT substitute inside `dataSource` — but after wrapping, the inner query lives under `dataSource` (`SubquerySource`). So a `rename` established before the wrap may not reach the inner projection. Correct (renames apply only to outer output) or latent bug? Needs a `rename`-before-second-`stats` test.
3. **Outer `limit` double-application.** The inner takes `limit` (or `MAX`) and the outer also retains `limit`. Confirm a limit is not applied twice in a way that changes results.

## Decision / next step

Verify-then-reconcile, not a blind fix:
1. Write targeted tests for Q1–Q3 and confirm whether current output is correct.
2. If a case is wrong, fix `wrapAsSubquery`'s field placement; if correct, re-graduate an **accurate** "Subquery wrapping" bullet to `design-decisions.md` stating the verified inner/outer split.

Until then the `design-decisions.md` bullet is reduced to the verified fact (wraps as `SubquerySource` via `wrapAsSubquery`, with the observed inner/outer split) plus a pointer here; it no longer asserts the false expand / inner-timeseries / `_fieldReplacements`-clearing specifics.

## Non-goals

- Building EXPAND field carrying (separate spec: `2026-06-18-mvexpand-to-expand-design.md`).
- Changing the `contains(jparse())` membership path.
