# Post-Aggregation & Time/Calendar Grouping Gaps — Design

## Problem

The compound-chain-collapse corpus sweep and whole-branch review (PR #44) surfaced five places where the SPL→NRQL translator emits **silent-wrong** or **invalid** NRQL for post-aggregation and time/calendar grouping. Each violates the project's prime directive — *loud failure over silent wrong*: a query must translate faithfully or emit a loud `unsupported`, never compiling-but-wrong NRQL and never NRQL that NRDB rejects at parse time.

The first five gaps (B–E) emit silent-wrong or invalid NRQL. A sixth, **F**, surfaced during the #44 review, differs in kind — its current output is *loud* (it already warns) but *lossy*; the fix upgrades it from loud-but-lossy to faithful. The gaps:

- **B — `dedup` between two aggregations** silently drops the dedup. `… stats count by host, region | dedup host | stats sum(count)` emits `FROM (… count by host, region) SELECT sum(count)` — the `dedup host` becomes a no-op, so the trailing aggregate sums every group. `head`/`tail` between aggregations is already loud (`head_between_aggregations`); `dedup` slips through.
- **C — an `eval` whose output alias equals a facet-key name** silently shadows. `stats count by host | eval host = count*2` emits `SELECT count(*)*2 AS host FACET host`; NRDB resolves `host` to the facet value, not the computed column, and drops `count(*)*2` (staging-confirmed on acct 10671289: `count(*)*2 AS appName FACET appName` returns the `appName` facet value, discarding the computed expression).
- **D1 — `_time`/`timestamp` regroup over a TIMESERIES inner** emits invalid NRQL. `timechart span=1m count by host | stats avg(count) by _time` emits `… SELECT average(count) FACET _time`; bare `_time` is not an NRDB attribute (parse error), and the per-bucket re-aggregation the author asked for is lost.
- **D2 — bare `stats … by _time`** (no upstream `bin`/`timechart`) emits the same invalid `FACET _time`.
- **E — `date_*` calendar fields** (`date_hour`, `date_wday`, …) emit `FACET date_hour`, but NR logs carry no Splunk-auto-extracted `date_*` attribute, so the facet returns empty — silent-wrong.
- **F — eval-fold drops source aggregate columns Splunk keeps** (loud-but-lossy, not silent-wrong). `stats count by host | eval pct = count*100` folds to `SELECT count(*)*100 AS pct FACET host` — Splunk keeps `count` *and* `pct`, but the fold drops `count`, announced via the existing `eval_after_agg_drops_source` warning. The fix makes the fold additive for **scalar** source columns.

B and C are post-aggregation-chain guards; F is a post-aggregation eval-fold fidelity fix sharing C's fold path. D1/D2/E are one coherent sub-area: how SPL time and calendar grouping maps to NRQL. The translator already handles the common, faithful time-bucketing idioms correctly (`bin/bucket _time span=X | stats … by _time` → `TIMESERIES X`; `timechart span=X` → `TIMESERIES X`); these five are the residual gaps.

## Verification method (and the tooling caveat)

Every NRQL claim below executed on staging via `run_nerdgraph_query` (the older `execute_nrql_query` parser is unreliable — see CLAUDE.md). Account 1 `Log` times out even on a 5-minute window, so validation ran on account **10671289 `Transaction`** with short windows; the syntax/semantics are event-type-independent. SINCE/UNTIL belong on the **outer** query only — a literal inner `SINCE` is a parse error.

## B — `dedup` between two aggregations → loud `unsupported`

**Mechanism.** Mirror the existing `head_between_aggregations` path. `handleHead`/`handleTail` set `ir._headBetweenAgg` when `ir._hasAggregation` (`rowHandlers.js:55,60`); the next `handleStats` consumes it and pushes `messages.head_between_aggregations()` (`aggregationHandlers.js:26`). `handleDedup` (`rowHandlers.js:99`) currently sets no such marker, so a trailing `stats` wraps it as an ordinary subquery and the dedup vanishes.

Fix: `handleDedup` sets a between-aggregations marker when `ir._hasAggregation`; the next `handleStats` consumes it and emits a new loud `unsupported`. Reuse `ir._headBetweenAgg` (rename it to a row-selection-neutral marker, e.g. `ir._rowSelectBetweenAgg`, shared by head/tail/dedup) or add a sibling `ir._dedupBetweenAgg` — implementation detail for the plan; the behavior is "any row-selection step between two aggregations is loud."

**Rationale.** `dedup field` keeps the first event per `field` value in stats order. A nested-subquery `FACET`/`LIMIT` cannot reproduce "first per key in arrival order" — the selection differs. No faithful NRQL; loud `unsupported`, never a silent no-op.

**Message.** New key, e.g. `dedup_between_aggregations` (or a generalized `row_select_between_aggregations` covering the head/tail/dedup family — the plan picks one and keeps the head/tail wording intact for those).

**Target case.** `* | stats count by host, region | dedup host | stats sum(count)` → `''`, `unsupportedFunc: ['<key>']`.

## C — `eval` output-alias equal to a facet-key name → loud `unsupported`

**Mechanism.** In the eval-after-stats projection (`evalHandlers.js`, where `Alias(expr, assignment.field)` is pushed onto the outer SELECT, ~line 154), guard: if `assignment.field` is the name of one of the aggregation's facet keys (`ir.facet`), push a loud `unsupported` instead of projecting the alias.

**Rationale.** `stats count by host | eval host = count*2` asks to overwrite the `host` group-by field with a computed value. The translator emits `SELECT count(*)*2 AS host FACET host`; NRDB resolves the output column `host` to the **facet value**, silently discarding `count(*)*2` (staging-confirmed on acct 10671289: `SELECT count(*)*2 AS appName FACET appName` returns the `appName` facet value, not the computed expression — the collision must be with a *real* attribute, and the post-`stats` `host` is one). Overwriting a `by` field has no faithful NRQL form, so this is loud `unsupported`. The collision is inherent to the SPL (it predates the fold and exists in the subquery form too), so the guard belongs at the point the alias is created, not in the fold pass.

**Message.** New key, e.g. `eval_shadows_facet_key`.

**Target case.** `* | stats count by host | eval host = count*2` → `''`, `unsupportedFunc: ['eval_shadows_facet_key']`. Negative control: `eval host2 = count*2` (distinct name) still folds flat.

## D1 — `_time`/`timestamp`/bin-alias regroup over a TIMESERIES inner → outer TIMESERIES (faithful)

**Semantics.** In `timechart span=1m count by host | stats avg(count) by _time`, the post-`timechart` `_time` is the **bucket boundary**, not a raw event timestamp. `stats avg(count) by _time` means "for each 1-minute bucket, average the per-host counts." That is a per-bucket re-aggregation — it keeps the time axis.

**The faithful NRQL needs TIMESERIES on BOTH levels** (staging-validated on 10671289):

```
FROM (FROM Log SELECT count(*) AS c FACET host TIMESERIES 1 minute) SELECT average(c) TIMESERIES 1 minute
```

The inner TIMESERIES builds per-host-per-bucket cells; the **outer** TIMESERIES re-aggregates back into per-bucket averages → one row per minute. Without the outer TIMESERIES (`SELECT average(c)` alone), NRDB averages across *all* cells → a single scalar, collapsing the time axis. So `by _time` is **not** redundant — it is exactly the difference between "per-bucket series" and "collapse to scalar." (An earlier reading that `by _time` could simply be stripped was wrong — stripping collapses the series.)

**Mechanism.** The trailing-stats regroup guard already identifies this case (`foldPostAggregation.js:593-601`): when `innerHasTimeseries` and the regroup facet key is a time-bucket field (`_time`/`timestamp`/`ir._timeBucketAliases`), it exempts the key from the regroup-unsupported check. The bug is that it then **passes the key through to the outer FACET**, emitting invalid `FACET _time`. The fix: in that exempted branch, **set the outer `ir.timeseries` to the inner's interval** (`collapsedInner.timeseries`) and **strip the time-bucket key from the outer facet**. This reuses the existing TIMESERIES emission (`ir.timeseries` → `TIMESERIES X`) — it does not reuse `stripTimeBucketFacets` alone (that strips without re-supplying the outer TIMESERIES, collapsing the series).

**Constraint preserved.** The inner subquery carries no SINCE/UNTIL (NRDB parse error); SINCE stays on the outer — the translator already does this. The outer TIMESERIES interval defaults to the inner's; a re-bucketing `bin _time span=Y` between the aggregations would set the outer to `Y` (rarer — the plan may defer the differing-span case).

**Target case.** `* | timechart span=1m count by host | stats avg(count) by _time` → `FROM (FROM Log SELECT count(*) FACET host LIMIT MAX TIMESERIES 1 minute) SELECT average(count) TIMESERIES 1 minute` (`verified: false`; confirm exact clause order via `node bin/spl2nrql.js`, and staging-re-validate before a human promotes it).

## D2 — bare `stats … by _time`/`timestamp` (no upstream bucket) → `TIMESERIES MAX` + warning

**Semantics.** `stats count by _time` with no prior `bin`/`timechart` groups events by their exact `_time` value at the source's native resolution. Splunk `_time` is whole-second for most sources, so this is commonly "count per second"; at sub-second precision it degenerates toward one row per event. The author wrote no bucket interval, so the granularity is implicit.

**Why `TIMESERIES MAX`, not `1 second` or `AUTO`** (all staging-validated, 10671289):

- `TIMESERIES 1 second` errors past **366 buckets** (`TIMESERIES supports a maximum of 366 buckets. Query has 3900` over a 65-minute window) — it breaks for any window longer than ~6 minutes. Window-fragile; unusable as a default.
- `FACET timestamp` groups by epoch-**milliseconds** (NRDB's resolution, ~1000× finer than Splunk's whole-second `_time`) — degenerate, wrong resolution. Do not emit.
- `TIMESERIES AUTO` picks a wide interval from the window (minutes/hours), fabricating a coarse granularity unrelated to native resolution.
- `TIMESERIES MAX` returns the **finest bucketing NRDB allows** (≤366 buckets), adapting to the window — sub-second over short windows, coarser over long ones, never erroring. It is the best-effort "native resolution" and the only robust choice.

**Mechanism.** A `stats … by _time`/`timestamp` whose query has **no** `ir.timeseries` set (no upstream bucketing) → emit `TIMESERIES MAX` (drop the `_time` facet key) + a warning. Distinguish from D1 (which has an inner TIMESERIES) and from the already-correct `bin|stats`/`timechart` paths (which set `ir.timeseries` to a concrete span).

**Warning, not silent.** A new warning states the bucketing was assumed (bare `by _time` read as the finest available time bucket via `TIMESERIES MAX`; the source's exact native resolution can't be reproduced, and sub-second data is coarsened). Loud about the approximation, consistent with the prime directive.

**Message.** New warning key, e.g. `bare_time_facet_assumed_timeseries`.

**Target case.** `* | stats count by _time` → `FROM Log SELECT count(*) TIMESERIES MAX`, `warningFunc: ['bare_time_facet_assumed_timeseries']`.

## E — `date_*` calendar fields → faithful `*Of(timestamp)` where a fold exists, else loud

**Semantics.** Splunk auto-extracts calendar-component fields from each event's time: `date_hour` (0–23), `date_minute` (0–59), `date_wday` (lowercase name, `sunday`…; per Splunk docs the matchable value is lowercase), `date_mday` (1–31), `date_month` (numeric `1`–`12` — Splunk docs show `date_month=1` for January, *not* a month name), `date_year` (4-digit), `date_second` (0–59), `date_zone` (UTC-offset minutes). These **fold** — every day's 9am collapses into one `date_hour=9` group. They are calendar components, not a time axis. NR logs have no such attribute, so the current `FACET date_hour` returns empty (silent-wrong).

**NR equivalents** (staging-validated; all execute in bare `FACET` position as single function calls):

| Splunk field | NR function | Faithful fold? | NR return shape |
|---|---|---|---|
| `date_hour` | `hourOf(timestamp)` | ✅ folds | `"13:00"` (string) |
| `date_minute` | `minuteOf(timestamp)` | ✅ folds | `"12"` (string) |
| `date_wday` | `weekdayOf(timestamp)` | ✅ folds | `"Friday"` (capitalized) |
| `date_mday` | `dayOfMonthOf(timestamp)` | ✅ folds | `"26"` (string) |
| `date_year` | `yearOf(timestamp)` | ✅ (year is period-specific) | `"2026"` (string) |
| `date_month` | `monthOf(timestamp)` | ❌ **pins the year** (`"June 2026"`) | — |
| `date_second` | (none) | ❌ no NR function | — |
| `date_zone` | (none) | ❌ no NR function | — |

**Mechanism.** A `stats … by date_<comp>` group-by — **exact field-name match against the table above, never a `date_*` prefix** (so a user field like `date_created`/`date_start` stays an ordinary facet, untouched) →
- For the five folding fields: rewrite the facet key to `FACET <fn>(timestamp)` + a **value-shape warning** (NR returns string labels — `"13:00"`, `"Friday"` — not Splunk's integers/lowercase names; downstream sorts or comparisons that assume the integer/lowercase shape will differ).
- For `date_month`, `date_second`, and `date_zone`: loud `unsupported` — `monthOf` pins the year (`"June 2025"` and `"June 2026"` are separate groups, so it can't fold every June together the way Splunk's `date_month` does), and NR has no second-of-minute or timezone-offset function. No faithful fold.

**Messages.** New warning key for the value-shape note (e.g. `date_field_label_shape`); a new `unsupported` key for the no-faithful-fold fields (e.g. `date_field_no_fold`).

**Target cases.** `* | stats count by date_hour` → `FROM Log SELECT count(*) FACET hourOf(timestamp)`, `warningFunc: ['date_field_label_shape']`. `* | stats count by date_month` → `''`, `unsupportedFunc: ['date_field_no_fold']`. Negative control: `* | stats count by date_created` (not a calendar field) → ordinary `FACET date_created`, no rewrite, no warning.

## F — eval-fold keeps the source aggregate columns Splunk keeps (additive fold)

**Character.** Unlike B–E, F is not silent-wrong — it is loud-but-lossy. The eval-after-stats flat fold already warns (`eval_after_agg_drops_source`) that it drops the raw aggregate columns. But Splunk's `eval` ADDS a column and keeps the originals, so `stats count by host | eval pct = count*100` yields `host, count, pct` in Splunk and only `host, pct` in our NRQL. The fix makes the fold faithful for **scalar** source columns (keeps the columns Splunk keeps); a non-scalar source (median/percentile/list) can't be re-projected as a scalar, so it stays dropped + warned.

**Mechanism.** In `foldEvalLayer` (`foldPostAggregation.js:336`), `keptInner` keeps only the inner's prior eval-derived `Alias`es and **drops every bare aggregate entry** (`isBareAggregateEntry`, lines 368–370), recording the dropped names for the `eval_after_agg_drops_source` warning (lines 371–381). Fix: also keep the **scalar** source aggregates, each re-aliased to its exposed name (`exposedNameOf`, line 315 — `count(*)`→`count`, `stddev`→`standarddeviation`, an already-`Alias`ed `sum(x) as s`→`s`), so they survive as named columns alongside the folded eval. **Scalar only:** a *non-scalar* source aggregate (`median`/`percentile`→keyed object `{50:v}`, `uniques`/`values`→list; detect with `extractNonScalar`, line 93) re-projects in the wrong shape — staging-verified that bare `median(duration) AS p50` returns `{"50":v}`, not Splunk's scalar `p50` — so those stay dropped, and `eval_after_agg_drops_source` is **narrowed** to them (reworded, not removed). **Dedupe is mandatory:** drop any kept scalar aggregate whose exposed name a folded eval also defines (the eval wins, matching Splunk's field overwrite) — a flat duplicate alias is silent-wrong (staging-verified `SELECT count(*) AS c, count(*)*2 AS c` returns the *first* `c`, the plain count, discarding the computed one). The dropped-name `orderBy` guard (`orderByRefsDropped`, line 696) still fires for the still-dropped non-scalar names; a now-kept scalar aggregate makes an `orderBy` on it legal.

**Verified target** (staging acct 10671289 — both columns returned):
`* | stats count by host | eval pct = count * 100` → `FROM Log SELECT count(*) AS count, count(*) * 100 AS pct FACET host LIMIT MAX`.

**Edge cases.**
- **Multi-aggregate stats re-projects ALL originals**, not just the one the eval references — Splunk keeps every aggregate: `stats count, avg(x) as a by host | eval pct = count*100` → `SELECT count(*) AS count, average(x) AS a, count(*)*100 AS pct FACET host LIMIT MAX`.
- **median/percentile/list sources are NOT re-projected** — bare `median(latency) AS p50` returns a keyed object `{"50":v}` (staging-verified), not Splunk's scalar `p50`, and `uniques`/`values` return lists; re-projecting would be shape-divergent. They stay dropped with the (narrowed) `eval_after_agg_drops_source` warning. The eval *result* still folds faithfully: `stats median(latency) as p50 by host | eval x = p50*2` → `SELECT median(latency)*2 AS x FACET host LIMIT MAX` (scalar `x`), unchanged from today — only the scalar-source cases gain a kept column.
- **`count` reserved-word risk** — the bare `count(*)` re-alias emits `AS count`; confirm the emitted form parses on staging (fall back to a quoted `AS 'count'` if NRDB rejects the bare alias).
- **Eval overwriting an aggregate output** (`stats count by host | eval count = count*2`) — the dedupe makes the eval win: `SELECT count(*)*2 AS count FACET host LIMIT MAX` (one `count`, matching Splunk's overwrite), never a silent-wrong duplicate column. This resolves the flat-fold half of the deferred "eval overwrites an aggregate-output column" item below.
- **List-valued aggregates (`uniques`/`values`) stay unsupported** — unchanged from the existing non-scalar guard; F does not re-open them.

**Interaction with C (load-bearing).** F narrows `eval_after_agg_drops_source` to non-scalar source drops — it does *not* delete the key. On HEAD that warning fires for both `eval host = count*2` (C's positive) and `eval host2 = count*2` (C's negative). After F: C's positive bails at the facet-key guard before the fold (clean `unsupported`, no warning), and C's `host2` negative — whose source `count` is **scalar** — folds additively with **no** warning. So set C's negative-control `warningFunc` to `[]`. (median/percentile-source cases still carry the narrowed warning.) This supersedes the C bullet under "Notes for the implementation plan" below.

**Target case.** `* | stats count by host | eval pct = count * 100` → the additive form above, `warningFunc: []`, `verified: false`.

## NRQL/SPL facts this design rests on (verified — do not re-derive)

- NRDB has **no `_time` attribute**. Bare `FACET _time` is a parse error (`unexpected '_'`); `` FACET `_time` `` (backticked) compiles but returns `[]` — so backticking is **silent-wrong**, never the fix. The real time attribute is `timestamp` (epoch-milliseconds).
- `FACET timestamp` groups by raw epoch-ms — degenerate (thousands of buckets), and finer than Splunk's typical whole-second `_time`.
- `TIMESERIES` caps at **366 buckets**; a fixed `TIMESERIES 1 second` exceeds it past ~6 minutes. `TIMESERIES MAX` returns the finest bucketing ≤366 buckets, adapting to the window (never errors).
- A nested per-bucket re-aggregation needs TIMESERIES on **both** inner and outer; the inner subquery must **not** carry SINCE/UNTIL (parse error) — SINCE goes on the outer.
- NR's `*Of` family splits into **folding** functions (`hourOf`, `minuteOf`, `weekdayOf`, `dayOfMonthOf`, `yearOf` — repeat across periods, matching Splunk `date_*`) and **pinning** functions (`monthOf` `"June 2026"`, `dateOf`, `weekOf`, `quarterOf` — embed the year, do not fold). They return **string labels**, not integers. NR has no second-of-minute function.
- SPL `stats` never buckets time on its own; implicit time-bucketing comes only from `bin`/`bucket _time span=` or `timechart`. The translator already maps those to `TIMESERIES` correctly — they are out of scope here.

## Test plan

Data-driven `cases` in `test/spl/spl.test.js` (the sanctioned exception), `verified: false` (a human promotes to `'llm'`/`'human'`). One case per fix plus the named negative controls:

- **B:** `stats count by host, region | dedup host | stats sum(count)` → unsupported. Negative: `stats count by host | dedup host` (dedup after a single stats, no trailing agg) unchanged.
- **C:** `stats count by host | eval host = count*2` → unsupported. Negative: `eval host2 = count*2` folds flat.
- **D1:** `timechart span=1m count by host | stats avg(count) by _time` → the both-levels-TIMESERIES form. Negative: `timechart span=1m count by host | stats avg(count)` (no `by _time`) still collapses to the scalar form (unchanged).
- **D2:** `stats count by _time` → `… TIMESERIES MAX` + warning. Negatives: `bin _time span=1h | stats count by _time` → `TIMESERIES 1 hour` (unchanged); `timechart span=1h count` → `TIMESERIES 1 hour` (unchanged).
- **E:** `stats count by date_hour` → `FACET hourOf(timestamp)` + warning; `stats count by date_month` → unsupported; `stats count by date_second` → unsupported; `stats count by date_zone` → unsupported. Negative control: `stats count by date_created` → ordinary `FACET date_created` (exact-set match, no rewrite, no warning).
- **F:** `stats count by host | eval pct = count*100` → additive `FROM Log SELECT count(*) AS count, count(*)*100 AS pct FACET host LIMIT MAX`, `warningFunc: []`. Multi-aggregate: `stats count, avg(x) as a by host | eval pct = count*100` → all three columns (`count`, `a`, `pct`). F narrows `eval_after_agg_drops_source` to non-scalar source drops, so the **scalar**-source cases (`pct`, C's `host2`) lose the warning; the median/percentile-source cases keep it (still dropped — re-projecting a keyed object is shape-divergent).

Every new message key needs a `warningFunc`/`unsupportedFunc` reference (validated against `messages` by the spy check in `spl.test.js`). Re-validate the D1/D2/E happy-path NRQL on staging via `run_nerdgraph_query` (acct 10671289 `Transaction`; acct 1 `Log` times out) before promoting past `verified: false`. Loop `spl-fuzz` 20× (it reseeds each run) after any IR/handler change.

## Notes for the implementation plan (verified subtleties — don't rediscover)

- **C bails loudly, but the wrap path already pushes `eval_after_agg_drops_source`.** On HEAD, both `eval host = count*2` and the `host2` negative fire that warning before the alias is projected. The plan must decide: move the facet-key-collision guard *before* the wrap (clean `unsupported`, no stray warning), or list `eval_after_agg_drops_source` in the positive case's `warningFunc`. The `host2` negative control's `warningFunc` must include it either way (exhaustive-message rule). **→ Resolved by F:** F narrows `eval_after_agg_drops_source` to non-scalar source drops and keeps scalar sources, so after F, C's `host2` negative (scalar `count`) carries `warningFunc: []` and C's positive is a clean `unsupported`. The key is not deleted — median/percentile sources still warn.
- **D2 mixed facet keys.** `stats count by host, _time` must keep `FACET host` and convert only `_time` → `TIMESERIES MAX` (i.e. `SELECT count(*) FACET host TIMESERIES MAX` + the warning), never drop the whole facet.
- **E exact-set membership** is the correctness boundary (see Mechanism): the table is a closed set matched by exact field name. The `date_created` negative control guards against a `date_*` prefix match.

## Reference-doc updates

`.claude/references/nrql-reference.md` currently lists `minuteOf`/`hourOf` for comparison-RHS but does not document the **fold-vs-pin split**, the **string-label return shapes**, the **366-bucket cap**, or `TIMESERIES MAX`. Add these so future translation work doesn't re-derive them.

## Out of scope / deferred

- **`dedup K | stats … by F` (dedup before a single aggregation) — faithful via a nested `latest()` subquery; deferred.** Distinct from Gap B (dedup *between* two aggregations, which has no faithful form). This case currently emits `compound_trailing_regroup_unsupported` because the `dedup`→`FACET K LIMIT MAX` inner does not expose `F`. It IS reachable: inner `SELECT latest(F) AS rn FACET K LIMIT MAX`, outer `SELECT count(*) FACET rn` (verified on staging acct 10671289 — outer FACET over an inner-projected column runs). Faithful only for **default** `dedup K` (keep-latest, one row per key); `dedup N K` or a `sortby` changes which event is kept, so `latest()` no longer matches. Blocked on the 5000-row inner-subquery cap (high-cardinality `K` silently undercounts). Note for a future enhancement, not built here; the loud `unsupported` stands as the interim.
- **`eval floor(_time/N)` manual bucketing** — semantically equivalent to `bin _time span=N`, but hard to pattern-match reliably. Leave as-is (or unsupported) rather than guess; revisit only if the corpus shows demand.
- **`SLIDE BY`** — overlapping windows; never emit for a plain `by _time` (tiling, not sliding).
- **Other Splunk-internal `_`-fields** (`_raw`, `_cd`, `_indextime`) in a grouping position — out of scope; only `_time`/`timestamp` are handled here. A general "Splunk-internal field has no NRDB equivalent" guard is a separate concern.
- **`date_*` fields outside a `stats … by` group-by** (in `where`/`eval`/`sort`/as a function arg) — E rewrites the group-by position only. A `date_hour` reference elsewhere is not handled here and currently passes through (the same separate-guard concern as the `_`-fields above).
- **`eval` overwriting an aggregate-output column** (`stats count by host | eval count = count*2`) — C guards an eval alias that collides with a *facet* key; an alias colliding with the *aggregate output* column (`count`) is a related class C does not catch. **The flat-fold case is resolved by F** (its additive-fold dedupe makes the eval win, emitting one `count(*)*2 AS count` — see F). The residual deferred case is a *non-foldable* overwrite (subquery path), which is unaffected by F and not separately guarded; revisit if the corpus shows demand.
- **Bare `_time` as the first aggregation of a chain** (`stats count by _time | stats avg(count)`) — here `_time` lands in the *inner* subquery FACET. D2 is scoped to the non-subquery case and D1 needs an inner TIMESERIES, so neither applies; the inner `FACET _time` parse-errors loudly at execution (not silent-wrong), so it is deferred rather than fixed.
- **Combined SINCE + D1 coverage** — the inner-carries-no-SINCE / SINCE-on-the-outer constraint (already enforced) is asserted but not exercised by a dedicated `earliest=… | timechart … | stats … by _time` test case; add one if the SINCE-placement path changes.
- **D1 differing-span re-bucketing** (a `bin _time span=Y` between two aggregations changing the outer interval) — the plan may emit `unsupported` for the differing-span case rather than infer it, if it proves fiddly.
