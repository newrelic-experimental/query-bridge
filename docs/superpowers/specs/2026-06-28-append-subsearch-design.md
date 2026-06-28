# `append` / `appendcols` subsearch — design

**Date:** 2026-06-28 (rewrite of the 2026-06-27 draft, after live + doc verification)
**Status:** Draft for review.
**Scope:** `@newrelic/query-bridge` (translator).
**Source:** `known-issues-laundry-list` row `append-subsearch`. Behavior verified via `bin/spl2nrql.js`
(`cceb76a`), NRQL semantics via staging (accts 1, 10671289), Splunk semantics via docs.splunk.com
(`SearchReference/Append`, `Appendcols`), all 2026-06-28.

## Verdict

**Keep the faithful `filter()` merge; fix exactly two silent-wrong cases.** The current
`handleAppend` is largely correct — it translates the dominant `stats`-merge idiom to side-by-side
`filter()` aggregates, which is *more* faithful to real-world intent than a literal row-append
(see "Why the merge is faithful"). It already fails loud for the unmappable shapes (no
aggregation, facet mismatch, parse failure). Only two families emit silently-wrong NRQL, and both
become `unsupported`:

1. **Cross-source** — sides differ by a leading `index=`/`sourcetype=`/`source=`.
2. **Divergent per-side time windows** — the subsearch carries its own `earliest`/`latest`.

This **reverses** the earlier draft's "unsupported-by-default" verdict, which would have regressed
value-faithful translations (a violation of *unsupported-over-**wrong***, since the merge is not
wrong for the common case).

## Current behavior (verified, `cceb76a`, 2026-06-28)

`handleAppend` (`src/input/spl/enrichmentHandlers.js:126`) handles **both** `append` and
`appendcols` (routed together at `splToIR.js:720-725`; only the message label differs). Branches:

| input | output | verdict |
|---|---|---|
| `* \| stats count \| append [search payments \| stats count]` | `SELECT count(*), filter(count(*), WHERE message LIKE '%payments%')` | faithful |
| `status=200 \| stats count \| append [search status=500 \| stats count]` | `SELECT filter(count(*), WHERE status…200), filter(count(*), WHERE status…500)` | faithful (`ir.where` cleared, per-side filters) |
| `* \| stats count by host \| append [search error \| stats count by host]` | `SELECT count(*), filter(count(*), WHERE message LIKE '%error%') FACET host` | faithful (value-keyed per-host) |
| `error \| stats count \| append [search error \| stats avg(bytes)]` (same WHERE) | merges to `SELECT count(*), average(…)` (one row) | faithful (multi-agg, same set) |
| `* \| append [search * \| head 5]` (no agg) | `unsupported` (`append_no_agg`) | loud ✓ |
| `* \| stats count by host \| append [search * \| stats count by user]` (facet mismatch) | `unsupported` (`append_facet_mismatch`) | loud ✓ |
| **`index=web \| stats count \| append [search index=payments \| stats count]`** | `SELECT filter(count(*), WHERE index='web'), filter(count(*), WHERE index='payments')` | **silent-wrong** (defect 1) |
| **`earliest=-1d \| stats count \| append [search * earliest=-2d latest=-1d \| stats count]`** | `SELECT count(*), count(*) SINCE 1 day ago` | **silent-wrong** (defect 2) |

## Why the merge is faithful (and the row shape doesn't matter for the common case)

SPL `append` adds the subsearch's *rows* to the bottom (doc: "Appends the results of a subsearch
to the current results … as the last row"; columns align by name). The translator instead emits
one row with side-by-side `filter()` columns. For the dominant corpus form —
`stats X | append [… | stats Y]` with **different** column names (`Hits`/`Misses`,
`today`/`yesterday`) — the literal 2-row "staircase" is an *artifact the analyst does not want*;
their terminal intent is the one-row, multi-column shape (in SPL they reach it with a trailing
`stats`/`addtotals`, or they should have used `appendcols`). So the column-merge is the intended
end state. The `filter()`-shares-the-outer-batch hazard (an outer `WHERE` would narrow each
`filter()`, verified: `WHERE level='INFO'` + `filter(…, WHERE level='ERROR')` → 0) is **already
avoided** — the different-WHERE branch clears `ir.where` and pushes each side's full predicate into
its own `filter()` (verified: `status=200 … status=500` → two independent counts).

## The two defects (both → loud `unsupported`)

**Defect 1 — cross-source discriminator.** When the two sides differ only by a leading
`index=`/`sourcetype=`/`source=`, the translator maps both to `FROM Log` and renders the
discriminator as `filter(count(*), WHERE index='X')`. NR Log usually carries no `index` attribute,
so both columns silently return 0; even when it does, the two sides are genuinely different
datasets that one `FROM Log` query cannot read. There is no faithful single-query NRQL form (no
`UNION`, no multi-subquery `FROM` — `SELECT … FROM (sub), (sub)` is a syntax error, verified).
**Fix:** compare the leading `index=`/`sourcetype=`/`source=` tokens on each side; any differing
literal (or a `$token$`-driven index, unknown at translate time) → `unsupported`
(`append_cross_source`), replacing today's warn-and-emit.

**Defect 2 — divergent per-side time windows.** A subsearch may carry its own `earliest`/`latest`
(doc: the `extendtimerange` option exists precisely to fold a subsearch's wider range into the
job). `handleAppend` merges only `select`/`facet`/`where` and **ignores `subIR.since`/`subIR.until`**,
so the subsearch's window is dropped and both aggregates run over the main window — the
"this period vs last period" idiom returns the main count twice. NRQL cannot apply two different
time windows in one query. **Fix:** if the subsearch sets its own `since`/`until`, or they differ
from the main query's → `unsupported` (`append_divergent_timerange`).

## Non-defects (do NOT "fix" — they are already correct)

- **`appendcols` sharing `handleAppend`.** `append` and `appendcols` diverge only on multi-row
  results (append stacks rows; appendcols joins by *row position* — doc: "the first subsearch
  result is merged with the first main result, the second with the second"). Every shape that
  reaches the merge is single-row (append-merge ≡ appendcols ≡ our output) or same-facet grouped
  (we emit a value-keyed FACET join — the sensible reading of both). The genuinely-divergent
  positional shapes are already `unsupported` via the no-agg / facet-mismatch guards, and NRQL has
  no positional join anyway. The conflation is benign; splitting it out buys no correctness.
- **The total-row pattern** (`stats … BY x | append [… | stats … | eval x="TOTAL"]`). Already
  caught loud by the facet-mismatch guard (main `BY x`, sub no-`by` = mismatch), and untranslatable
  regardless — NRQL has no rollup/total-row on a faceted result. No action.

## Behavior (recommended)

- `stats`-merge, same source, same window → unchanged (faithful `filter()` merge; keep the
  existing `append_merged` / `append_filter_warning`).
- Sides differ by a leading `index=`/`sourcetype=`/`source=` → `unsupported`
  (`append_cross_source`).
- Subsearch carries its own / a differing `earliest`/`latest` → `unsupported`
  (`append_divergent_timerange`).
- No aggregation / facet mismatch / parse failure → `unsupported` (unchanged).
- `appendcols` → continues through `handleAppend` (unchanged; benign, per "Non-defects").

## Acceptance criteria (synthetic)

- `index=web | stats count | append [search index=payments | stats count]` → `unsupported`
  (`append_cross_source`). Today emits `filter(…, WHERE index='web'), filter(…, WHERE
  index='payments')` → silently 0.
- `earliest=-1d latest=now | stats count | append [search * earliest=-2d latest=-1d | stats count]`
  → `unsupported` (`append_divergent_timerange`). Today emits `count(*), count(*) SINCE 1 day ago`.
- `status=200 | stats count | append [search status=500 | stats count]` → **unchanged**:
  `SELECT filter(count(*), WHERE status…200), filter(count(*), WHERE status…500)` (faithful; must
  not regress to `unsupported`).
- `* | stats count by host | append [search error | stats count by host]` → **unchanged** faithful
  per-host merge.
- `* | append [search * | head 5]` → `unsupported` (unchanged).

## Testing

Data-driven `cases` in `test/spl/spl.test.js`: the two new `unsupported` cases (cross-source,
divergent-window) and **regression cases pinning the faithful merges** (same-source different-WHERE,
faceted, same-WHERE multi-agg) so the fix cannot over-reach into them. `test/messages.test.js`
references for the two new keys. The `filter()` merge shape is already staging-validated; the new
behavior is detection only (no new NRQL). Fuzz ×20. Corpus before/after via
`dashboard-diagnostic.mjs` — expect a small number of current lossy outputs to move to
`unsupported` (deliberate loud-over-wrong, not a regression); confirm no faithful merge flips.

## PR breakdown

1. **Cross-source `append`/`appendcols` → `unsupported`** (~130 lines, behavior) — compare the
   leading `index=`/`sourcetype=`/`source=` tokens on each side; differing literal or `$token$`
   index → `append_cross_source` (replacing the warn-and-emit `filter()`). Add the cross-source
   `unsupported` case and the same-source faithful regression cases. Dependency: none. Highest
   value — this is a silent-wrong fix and the warning text already half-admits the gap.
2. **Divergent per-side time window → `unsupported`** (~100 lines, behavior) — detect a subsearch
   `since`/`until` that is set or differs from the main query's; emit `append_divergent_timerange`.
   Add the divergent-window `unsupported` case and a same-window regression case. Dependency: none
   (independent of PR 1).
3. **(Optional) graduate** (~30 lines, docs) — promote validated cases, graduate the invariant
   (faithful merge + the two `unsupported` guards + the appendcols/total-row non-defects, so a
   future edit doesn't regress them), update the laundry-list row. Dependency: PRs 1–2 + staging.
