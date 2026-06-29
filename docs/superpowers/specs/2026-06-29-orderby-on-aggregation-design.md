# `ORDER BY` on a faceted aggregation — design

**Date:** 2026-06-29
**Status:** Draft for review.
**Scope:** `@newrelic/query-bridge` (translator).
**Source:** ORDER BY root-cause investigation (this session) → `.claude/references/nrql-reference.md` (ORDER BY mechanism) + engine `../dirac/dirac-nrql`. Generalizes the `rare` double-check finding to the whole `ORDER BY`-on-aggregation family.

## Problem

NRQL `ORDER BY` is honored **only on event-record (non-aggregation) results**. It compiles to an `EventRecords.Order` (`CompilerOrderByPlan.compileAsEventOrder`) and is structurally ignored on every aggregation; a faceted result is ordered and top-N-selected by `FacetedBase`'s built-in comparator (the first aggregate, descending). So any `ORDER BY` the translator emits onto an aggregation is:

1. **ignored by NRDB** — and **silently returns the wrong rows whenever a `LIMIT` truncates the set** (FACET defaults to `LIMIT 10`, so this is the common case, not the exception); and
2. **rejected by the dashboard widget engine** (a render-fail the console/NerdGraph silently accept).

PR #95 fixed the faceted `top`/`sort` cases by **dropping** the redundant implicit-order clause and marking everything else **`unsupported`**. But `unsupported` is too conservative — a faithful form exists (the same over-confident "no faithful form" call the `rare` double-check just corrected).

## The faithful form — subquery-restructure

Wrap the aggregation in a subquery and order on a **non-aggregating outer projection** (`SELECT <keys>, <aliases>` — no aggregate, no FACET). `ORDER BY` is honored on any non-aggregating result, so the outer does the real ordering AND selection:

```nrql
FROM (FROM Log SELECT <aggs> FACET <keys> LIMIT MAX)
SELECT <keys>, <aggs> ORDER BY <sortKey> <dir> LIMIT N
```

The inner returns all groups (`LIMIT MAX`); the outer does the real ordering and selection. **The outer MUST NOT re-aggregate** — if it is itself a faceted aggregation, its `ORDER BY` is ignored exactly as in the flat case (live-tested: a faceted outer `ORDER BY aa ASC` came back unsorted). The deciding property is "the outer does not aggregate," not "the rows are events." **Verified live (staging acct 1, 2026-06-29):**

| shape | result |
|---|---|
| flat `FACET x ORDER BY c ASC` (today) | top-N by count, **descending** — clause ignored (the bug) |
| subquery, outer `ORDER BY c ASC` (bottom-N / `rare`) | least-common — **correct** |
| subquery, outer `ORDER BY <secondary-agg> DESC` | ordered by the secondary aggregate — **correct** |
| subquery, outer `ORDER BY <facet-key> ASC` | alphabetical by the key — **correct** |
| event-record `SELECT attr ORDER BY attr ASC` vs `DESC` (control) | different rows (smallest vs largest) — **honored** |

**Caveat (warnable):** the inner `FACET … LIMIT MAX` caps at 5000 groups, kept **by the first aggregate, descending**. So for >5000 distinct values, any order other than first-aggregate-DESC keeps the *wrong* 5000 — worst for ascending / `rare`, where the cap discards exactly the least-common rows the query wants (it returns the rarest of the 5000 *most*-common — wrong, not merely approximate; live-confirmed: `min(c)` = 2 on a capped set whose true min is 1). Faithful for cardinality ≤5000 (the overwhelming majority); emit a specific warning above. Residual policy choice (see PR breakdown): if we'd rather never risk it, ascending / `rare` could stay `unsupported` instead of subquery-restructured.

**Output wart (accepted — no action):** the non-aggregating outer carries a synthetic `timestamp` column (the query-execution time, identical across rows). Cosmetic; we ignore it, not worth a warning.

## The rule — three outcomes

For an `ORDER BY` that lands on an aggregation:

1. **DESC by the first aggregate** (what `top` and `sort -<first-agg>` want) → **drop** the clause. The implicit top-N-by-first-aggregate-descending order is identical. Faithful, no warning. *(PR #95 already does this.)*
2. **Any other order on a faceted aggregation** — ascending, by a secondary aggregate, by a facet key, or `rare` (bottom-N) → **subquery-restructure** + the 5000-cap warning. Correct data and order.
3. **No faithful NRDB form** → **`unsupported`**:
   - `tail` after an aggregation — "the last N rows in *stats order*"; NRDB has no stable stats order to slice or reverse.
   - `reverse` after an aggregation — reverses a Splunk-specific result order NRDB does not define (reviewer-approved; drop the wrong `timestamp` clause it emits today).
   - A **non-faceted, single-row** aggregation sort (`stats count | sort -count`) has nothing to order → **drop** the no-op clause (faithful; also clears the widget reject).

## Affected sites (audit, against master)

| site | today | rule |
|---|---|---|
| `handleTop` | `ORDER BY count DESC` on faceted agg | drop ✅ (PR #95) |
| `handleSort`, faceted, DESC-by-first-agg | `ORDER BY c DESC` | drop ✅ (PR #95) |
| `handleSort`, faceted, other order | `unsupported` (PR #95) | **subquery-restructure** (this spec) |
| `handleSort`, non-faceted single-row agg | `ORDER BY c DESC` (no-op) | drop |
| `handleRare` | `ORDER BY count ASC` (returns most-common) | **subquery-restructure** (bottom-N) |
| `handleTail` after agg | `ORDER BY timestamp ASC LIMIT N` | `unsupported` |
| `handleReverse` after agg | `ORDER BY timestamp ASC` + warning | **`unsupported`** (drop the wrong timestamp clause) |
| `handleSort`/`reverse` on event records | `ORDER BY <field>` | unchanged ✅ (honored) |

## Resolved decisions (reviewer, 2026-06-29)

- **`reverse` after an aggregation → `unsupported`** (approved). It reverses a Splunk-specific result order NRDB does not define; today's `ORDER BY timestamp ASC` is both ignored and semantically wrong. Drop the clause and fail loud. Revisit only if the corpus shows demand.
- **The outer's spurious `timestamp` column → ignore it** (approved). No warning; it's cosmetic.
- **Residual (open):** for ascending / `rare` over a possibly-high-cardinality field, subquery-restructure-with-warning vs `unsupported` (the 5000-cap discards the requested rows above 5000). Default in this spec: restructure + a specific cap warning; flip to `unsupported` for those two shapes if you prefer never-wrong over best-effort.

## Implementation note

The restructure produces a `SubquerySource`; it must emit **legal, fold-stable IR** so `foldPostAggregationPass` does not re-nest or collapse it incorrectly. The cleanest seam is likely a single late pass (or a shared `restructureForOrderBy` helper) that runs after the fold and owns outcomes 1–3 uniformly, rather than per-handler logic — this also lets PR #95's handler rules collapse into one place.

Two engine guards the restructure MUST respect (both live-tested):
- **The outer must be a plain non-aggregating projection** (`SELECT <facetKeys>, <aliases>`). A re-aggregating outer silently re-ignores `ORDER BY` — straight back to the flat bug.
- **Alias every inner aggregate uniquely.** Bare aggregates expose under their NRQL function name (`count`, `average`, …; `stddev`→`standarddeviation`) and a name collision silently keeps the **last** one. (Aside: `ORDER BY count(*)` is a hard syntax error on a flat faceted query, while `ORDER BY <alias>` parses-but-is-silently-ignored — the flat failure mode is loud only for the bare-aggregate form.)

## Testing

Data-driven `cases` in `test/spl/spl.test.js`: the restructured forms (rare, ascending, secondary-aggregate, facet-key) each with the 5000-cap warning; the drop cases (top, `sort -<first-agg>`, non-faceted single-row); the `unsupported` cases (`tail`). Regression: event-record sorts unchanged; the four restructured shapes are staging-validated (above). `test/messages.test.js` references for any new keys. Fuzz ×20. Widget-layer (`dashboardCreate`) validation of one restructured form before graduating.

## PR breakdown

1. **Unified `ORDER BY`-on-aggregation handling: drop-if-implicit, else `unsupported`** (~150 lines, refactor + behavior) — consolidate the scattered emission rules (PR #95's `handleTop` drop + `handleSort` faceted rule, plus `handleTail`-after-agg → unsupported, `handleReverse`-after-agg → unsupported, and the non-faceted single-row no-op drop) into one place so the rule is applied uniformly. Either revise PR #95 in place or stack on it. *Loud, correct baseline; no wrong data; smallest shippable slice.* Dependency: PR #95 (revise or stack).
2. **Subquery-restructure for non-implicit faceted sorts** (~200 lines, behavior) — turn PR 1's `unsupported` (ascending / secondary-aggregate / facet-key) into the faithful subquery form + the 5000-cap warning; ensure fold-stable IR. Add the staging-validated cases. Dependency: PR 1.
3. **`rare` via the subquery-restructure** (~80 lines, behavior) — reuse PR 2's machinery for bottom-N; update the six `rare` cases (→ `verified: false`). Dependency: PR 2.
4. **(Optional) graduate** (~30 lines, docs) — promote validated cases, graduate the invariant into `.claude/rules/design-decisions.md`, strike the laundry-list rows. Dependency: PRs 1–3 + widget-layer validation.
