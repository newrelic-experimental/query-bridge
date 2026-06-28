# Render-time failures (clean NRQL the live widget rejects) — design

**Date:** 2026-06-27 (revised 2026-06-28 — open questions resolved; ORDER BY behavior re-verified)
**Status:** Draft for review.
**Scope:** `@newrelic/query-bridge` (translator) **and** `@newrelic/dashboard-importer`.
**Source:** `known-issues-laundry-list` → Render-time failures (all three **live-confirmed**).

## Problem

Three emitted-NRQL shapes pass the query console **and** the NerdGraph compiler but the live
dashboard **widget** rejects or mis-renders them. They are counted as "clean" everywhere, so a
migration looks successful in every pre-flight check and only breaks when the customer opens
the board — the true working-widget rate is below any reported clean percentage. All three are
verified at the widget layer (`project_nr_widget_engine_stricter`); none is reproducible via
NRDB/NerdGraph, which accept them.

| id | emitted shape | widget result |
|---|---|---|
| `order-by-aggregation` | `… FACET x ORDER BY count DESC` (from `top`/`sort`) | *"ORDER BY ASC/DESC is not supported on aggregation function queries"* |
| `template-var-in-subquery` | `{{var}}` inside `FROM (subquery …)` | *"Found undefined template variable(s)"* (not substituted in a subquery) |
| `select-star-in-chart` | `SELECT *` in a bar/line/billboard widget | blank widget, no error |

Verified the translator emits the first today (`cceb76a`):
`* | top limit=10 host` → `… FACET host ORDER BY count DESC LIMIT 10`;
`* | stats count by host | sort -count` → `… FACET host ORDER BY count DESC`.

## Sub-problem 1 — `order-by-aggregation` (translator)

NRQL faceted aggregations are **ordered and top-N-selected by the first aggregate, DESC**, and
**NRDB *ignores* an explicit `ORDER BY` on a faceted aggregation entirely — both direction AND
key** (live-verified, acct 1, 2026-06-28). Two proofs:
- **Direction ignored:** `FACET appName ORDER BY c ASC LIMIT 3` ≡ `… DESC LIMIT 3` (identical top-3
  by count — ASC does NOT give bottom-N).
- **Key ignored:** `SELECT count(*) AS c, min(duration) AS mn FACET appName ORDER BY mn DESC`
  returned rows ordered by **c**, not `mn` (the `mn` column came back non-monotonic), byte-identical
  to `ORDER BY c DESC`. The secondary-aggregate key is ignored too.

An **un-aliased** aggregate in ORDER BY is worse — a hard NRDB syntax error (`ORDER BY count(*)` →
`unexpected … ORDER BY count(`). So the explicit `ORDER BY count DESC` that `top`/`sort -count`
emit is **redundant** (NRDB ignores it) AND the widget rejects it.

**This is a faithful translation simplification, not a dashboard-only hack.** Because NRDB ignores
the clause, dropping it yields an identical result everywhere — console, NerdGraph, *and* widget —
so the **translator** drops it unconditionally; it just happens to also clear the widget reject.
The only purely dashboard-specific piece is the build-time lint (Open Q4).

**Fix:** drop the explicit `ORDER BY` when the requested sort matches the implicit order —
**DESC by the *first* aggregate**. `top N` and `sort -<first-agg>` → `FACET x LIMIT N`, no
`ORDER BY` — identical result (NRDB already returns top-N DESC by the first aggregate),
widget-renderable.

**The residual hard cases → `unsupported` (not emit-and-warn) — dropping `ORDER BY` there is
silent-wrong:**
- **Ascending** (`sort +<agg>`, unsigned `sort <agg>`) — NRDB returns top-N *descending*, the wrong
  rows, not the bottom-N requested.
- **Sort by a *secondary* aggregate** (`stats count, avg(x) | sort -avg`) — NRDB orders by the
  *first* aggregate (`count`), not `avg`, so rows come back in the wrong order (the `mn` proof).
- **Sort by a facet key** — likewise ignored; NRDB orders by the first aggregate.

All three → `unsupported` (`order_on_aggregation_unsupported`). *(Possible future enhancement, the
secondary-aggregate DESC case only: reorder the SELECT so the sort-key is the first aggregate, so
NRDB's first-aggregate-DESC order matches the request — needs a check that NRDB keys on
first-SELECT-position, not `count` specifically.)*

## Sub-problem 2 — `template-var-in-subquery` (translator + importer)

When post-aggregation wrapping produces `FROM (FROM … WHERE region = {{region}} …) SELECT …`,
the dashboard variable interpolator does not substitute `{{region}}` **inside** the subquery,
so the token reaches NRDB unbound. Per Open Q2 (resolved): **hoist the `{{var}}` predicate to the
outer query when semantically valid** (a pre-aggregation WHERE filter can usually move out), else
**`unsupported`** (loud) rather than a render-failing widget.

## Sub-problem 3 — `select-star-in-chart` (importer)

A bare SPL `search` translates to `SELECT *` (raw events). Only a **table** widget can render
raw events; a bar/line/billboard shows blank. Per Open Q3 (resolved): when a panel's translated
NRQL is `SELECT *` (no aggregate), **route it to a table viz regardless of the Splunk viz type**.
This is at least as faithful as Splunk (see Q3).

## Open Questions — all resolved

1. **`order-by-aggregation` residual — RESOLVED to `unsupported` (live-verified 2026-06-28).** A
   non-implicit order — ascending (`sort +count`, unsigned `sort count`), **sort by a secondary
   aggregate**, or sort by a facet key — has no faithful drop: NRDB ignores ORDER BY's direction
   AND key and returns top-N ordered by the *first* aggregate, so emitting it returns the wrong
   rows. All → `unsupported`. (Verified: ASC≡DESC, and `ORDER BY <secondary-agg> DESC` came back
   ordered by the first aggregate.)
2. **`template-var-in-subquery` — RESOLVED (user): hoist where feasible, `unsupported` otherwise.**
   Hoist the `{{var}}` filter to the outer query when the predicate is a pre-aggregation WHERE that
   legally moves out (most are); `unsupported` (`template_var_in_subquery`) when it can't. Needs the
   subquery-fold code to expose where the var lands.
3. **`select-star-in-chart` — RESOLVED (user): force a table viz.** A no-aggregate `SELECT *`
   panel renders as a table regardless of the Splunk viz type. This is at least as faithful as
   Splunk: per Splunk's viz doc, charts "require a search using transforming commands (`stats`,
   `chart`, `timechart`)" and plot "data series" — raw events go to Splunk's Events-list viz, and a
   `<chart>` panel fed a non-transforming search renders empty/"not chartable," not a meaningful
   line. Forcing a table shows the data Splunk's chart could not. (doc:
   `Viz/Datastructurerequirementsforvisualizations`.)
4. **Widget-renderability lint — RESOLVED (user): yes, add it.** The importer gains a post-emit
   lint that flags ORDER-BY-on-aggregation / `{{var}}`-in-subquery / `SELECT *`-in-non-table and
   converts a render-fail to a loud placeholder/warning at build time. The structural catch-all —
   it catches future render-fails the per-case fixes miss.

## Behavior (recommended)

- **Translator:** `top`/`sort -<first-agg>` emit `FACET x LIMIT N` with **no `ORDER BY`** (the
  implicit DESC-by-first-aggregate order is identical, and NRDB ignores an explicit ORDER BY anyway
  — a faithful simplification, not dashboard-specific). A non-implicit order (`sort +<agg>`
  ascending, unsigned `sort <agg>`, **sort by a secondary aggregate**, or sort-by-facet-key) →
  `unsupported` (`order_on_aggregation_unsupported`) — dropping ORDER BY there returns the wrong
  rows.
- **Translator:** a `{{var}}` that would land inside a `SubquerySource` → hoist to the outer
  WHERE when legal; else `unsupported` (`template_var_in_subquery`).
- **Importer:** a `SELECT *` (no-aggregate) translated query → table viz, regardless of the Splunk
  viz type.
- **Importer:** a post-emit widget-renderability lint as the structural catch-all (ORDER-BY-on-agg
  / `{{var}}`-in-subquery / `SELECT *`-in-non-table → loud placeholder/warning).

## Acceptance criteria (synthetic)

- `web_logs | top limit=10 host` → `FROM Log SELECT count(*) … FACET host LIMIT 10` (no
  `ORDER BY`; renders in the widget). Today emits `… ORDER BY count DESC LIMIT 10` (render-fail).
- `web_logs | stats count by host | sort -count` → `… FACET host` (no `ORDER BY`).
- `web_logs | stats count by host | sort +count` (ascending) → `unsupported`
  (`order_on_aggregation_unsupported`) — emitting `ORDER BY c ASC` returns the top-N descending
  (wrong rows; ASC≡DESC verified live), not the bottom-N requested.
- `web_logs | stats count, avg(duration) by host | sort -avg` (sort by a **secondary** aggregate)
  → `unsupported` (`order_on_aggregation_unsupported`) — NRDB orders by the first aggregate
  (`count`), not `avg` (verified live: secondary-key ORDER BY ignored).
- A subquery query carrying `{{region}}` in the inner WHERE → `{{region}}` hoisted to the outer,
  or `unsupported`. No `{{var}}` left inside `FROM (…)`.
- A bare `search` panel (`SELECT *`) in a Splunk `line` chart → emitted as a **table** widget.

## Testing

Translator: data-driven `cases` in `test/spl/spl.test.js` for the ORDER-BY suppression (including
the secondary-aggregate and ascending `unsupported` cases) and the subquery-var handling. Importer:
integration cases for `SELECT *` → table routing and the widget-renderability lint; regen
`GAP_INVENTORY.md`. **These are widget-layer failures — NRDB/NerdGraph accept them — so the
real validation is a `dashboardCreate` + open-the-widget check (per
`project_nr_widget_engine_stricter`), not an `execute_nrql_query` run.** Fuzz ×20.

## PR breakdown

1. **Suppress redundant ORDER BY on faceted aggregations; unsupported for the rest** (~150
   lines, behavior) — `top` and `sort -<first-agg>` drop the explicit `ORDER BY <agg> DESC` (NRDB
   ignores it and the widget rejects it), keeping `FACET x LIMIT N`. A non-implicit order
   (`sort +<agg>` ascending, unsigned `sort <agg>`, **sort by a secondary aggregate**,
   sort-by-facet-key) → `unsupported` (`order_on_aggregation_unsupported`) — dropping ORDER BY
   there returns the wrong rows (NRDB ignores key AND direction; verified live 2026-06-28). Add
   `spl.test.js` cases. Dependency: none. Highest-value: `top`/`sort` are ubiquitous.
2. **Template var in subquery → hoist or unsupported** (~180 lines, behavior) — detect a
   `{{var}}` landing inside a `SubquerySource`; hoist a pre-aggregation WHERE filter to the
   outer query when legal, else `template_var_in_subquery` unsupported. Add cases. Dependency:
   touches the subquery-fold path (`foldPostAggregation`); sequence after the fold work is on
   master.
3. **Importer: route `SELECT *` to a table viz** (~120 lines, behavior) — a no-aggregate
   translated query renders as a table regardless of the Splunk viz type; importer integration
   test + `GAP_INVENTORY.md` regen. Dependency: none (importer-only).
4. **Post-emit widget-renderability lint** (~150 lines, behavior) — the structural catch-all
   (Q4, approved): flag ORDER-BY-on-agg / `{{var}}`-in-subquery / `SELECT *`-in-non-table at
   build time → placeholder/warning. Dependency: PRs 1–3 (subsumes their ad-hoc checks).
5. **(Optional) graduate** (~30 lines, docs) — promote cases, graduate invariants, strike the
   three render-fail rows in the laundry list. Dependency: PRs 1–4 + widget-layer validation.
