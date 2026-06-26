# Trailing-projection fold — design

## Problem

A trailing column-projection (`table` / `fields`) after an otherwise-foldable
post-aggregation chain currently bails to `compound_collapse_unsupported`, even though
the projection only restricts (and, for `table`, reorders) the SELECT to columns that
already exist in the folded query.

Today (HEAD, staging-verified this session, acct 10671289):
- `* | stats count by status | eval pct = count*100` → folds clean:
  `FROM Log SELECT count(*) * 100 AS 'pct' FACET status LIMIT MAX`
  (+ `eval_after_agg_drops_source`, since the raw `count` is dropped).
- `* | stats count by status | eval pct = count*100 | table status pct` → **`unsupported`**
  (`compound_collapse_unsupported`): the `table` wraps the folded query as a subquery layer
  the fold can't collapse. Same for `| fields status pct`.

A 32,436-query corpus census (this session, private corpus repo) attributes **~316**
`emitted → unsupported` regressions to this trailing-projection shape — all recoverable:
the projected columns (`status`, `pct`) already exist in the folded output, so the
projection should reduce to `SELECT pct FACET status`.

## Goal

Fold a trailing `table`/`fields` keep-list projection into the aggregating SELECT —
restrict (and order, for `table`) the folded SELECT to the projected columns — converting
the ~316 from `unsupported` → `clean`, with no silent-wrong path.

## Scope — "clean cases only", independent of Gap F

**In scope:** a trailing `table <cols>` or `fields <cols>` (keep-list) whose every
referenced column is present in the folded output — a facet key, an eval-result alias, or
another surviving projected column. Fold = restrict the folded SELECT to those columns (in
listed order for `table`); facet keys stay FACET keys and are projected as listed.

**Out of scope — stays loud `unsupported` (never silent-wrong):**
- A projection referencing a column **absent** from the folded output → `unsupported`
  (a dangling ref resolves to null silently — staging-verified: `FACET`/`SELECT` on a
  non-exposed column returns empty, no error).
- A projection re-selecting a **raw scalar aggregate the additive eval-fold drops**
  (`… | eval pct=count*100 | table status count`): `count` is dropped today
  (`eval_after_agg_drops_source`), so it's absent → `unsupported`. This is recoverable
  **only after Gap F** (keep scalar source aggregates — Task 6 of the
  post-aggregation-grouping-gaps plan, currently unbuilt). **Documented as future scope**,
  gated on Gap F; not built here.
- `fields - <cols>` (drop-list form) — future scope; keep-list is the dominant corpus form.
- `dedup`-rooted chains — these are `unsupported` for the regroup reason (the dedup→FACET
  inner doesn't expose the regroup key), orthogonal to projection.
- Projections over a genuinely non-foldable chain (where the projection is already the
  legal outer SELECT over a subquery) — those already work; unchanged.

## Behavior

When a trailing `table`/`fields` keep-list sits over a foldable aggregation (the eval
folds flat), apply the projection as a SELECT column-restriction on that aggregation
instead of wrapping it as a subquery:
- Keep only the projected columns in the SELECT, in listed order (`table` is ordered;
  `fields` order is preserved but not semantically significant).
- Facet keys referenced by the projection remain FACET keys and are projected in the
  SELECT as listed (a faceted SELECT may list the facet key).
- Drop the columns the projection omits — this is the projection's purpose — but only
  eval-results / surviving projections. Never use this path to drop a column a later step
  needs: the post-fold legality guards still run and stay loud.

## Guards (loud failure over silent-wrong)

- A projected column absent from the folded output → `unsupported`. Extend/reuse the
  existing unexposed-reference detection so a `table`/`fields` ref to a non-folded column
  is caught, not emitted as a null-resolving dangling ref.
- Re-projection of a dropped raw aggregate → `unsupported` (the Gap-F-gated case above).
- The existing post-fold guards (`hasUnexposedReference`, `hasRowwiseInner`,
  `orderByRefsDropped`, the regroup and non-scalar guards) continue to run unchanged.

## Acceptance criteria

- `* | stats count by status | eval pct=count*100 | table status pct`
  → `FROM Log SELECT count(*) * 100 AS 'pct' FACET status LIMIT MAX` (clean; was
  `unsupported`). Match exact alias quoting to the emitter's actual output.
- `… | fields status pct` → same.
- `… | table status count` (re-projects the dropped `count`) → still `unsupported`
  (Gap-F future scope).
- `… | table status nonexistent` → `unsupported` (dangling ref).
- Corpus before/after (corpus-diagnostic.mjs, private repo): the trailing-projection slice
  (~316) moves `unsupported → clean`; no new `errors`/`thrown`. Re-measure the exact count
  on implementation — the ~316 is a skeleton-based estimate.

## Testing

Data-driven `cases` in `test/spl/spl.test.js`: the clean fold (`verified: false` →
`'llm'` after staging validation), the Gap-F-blocked re-projection staying `unsupported`,
the dangling-column staying `unsupported`. Whole-package + fuzz ×20. Staging-validate the
emitted NRQL on acct 10671289.

## Dependencies / sequencing

Independent of Gap F for the in-scope cases. The re-projection future scope is gated on
Gap F (post-aggregation-grouping-gaps Task 6). No grammar change — the parser already
produces `table`/`fields` nodes.

## PR breakdown

> Retrofit per CLAUDE.md "Small PRs" rule. Each PR below is independently reviewable and shippable; land in order.

1. **Fold trailing table/fields keep-list into aggregating SELECT** (~250 lines, behavior) — when a trailing `table`/`fields` keep-list sits over a foldable post-aggregation chain, apply it as a SELECT column-restriction (listed order for `table`) on the folded aggregation rather than bailing to `compound_collapse_unsupported`; facet keys stay FACET keys and project as listed. Reuse/extend the existing unexposed-reference detection so a column absent from the folded output → `unsupported`, and keep the existing post-fold guards (`hasUnexposedReference`, `hasRowwiseInner`, `orderByRefsDropped`, regroup/non-scalar) running unchanged. No grammar change — the parser already produces `table`/`fields` nodes. Add data-driven `spl.test.js` cases: the clean fold (`* | stats count by status | eval pct=count*100 | table status pct` → `FROM Log SELECT count(*) * 100 AS 'pct' FACET status LIMIT MAX`), `| fields status pct` same, the dangling-column case (`| table status nonexistent` → `unsupported`), and the Gap-F-blocked re-projection (`| table status count` → still `unsupported`) — all `verified: false` until staging-validated. Dependency: independent (Gap F is not required for the in-scope cases). This spec is a single cohesive, already-small change; no further split warranted (the guard reuse and the fold land together — splitting the guard from the fold it protects would ship a half-behavior).
