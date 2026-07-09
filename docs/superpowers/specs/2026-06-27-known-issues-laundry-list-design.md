# Known Issues — Laundry List (problems only)

**Date:** 2026-06-27
**Status:** Living inventory. Problems only — **no fixes, no plan.**
**Scope:** the SPL→NRQL translator (`@newrelic/query-bridge`) and the dashboard
importer (`@newrelic/dashboard-importer`).

## What this is

A single consolidated catalog of *known problems* — bugs the tools get wrong on
handleable input, coverage gaps with no NRQL equivalent, and queries that translate
but fail at render time. It exists so the open problems live in one place instead of
scattered across design docs, and so we can watch the list shrink as fixes land.

It is deliberately **not** a plan. No fix is proposed here. When a problem gets
picked up, its fix design lives in its own spec; when it ships, the row moves to
`.claude/rules/design-decisions.md` (the graduation target) and is struck here.

### Conventions

- **Classification:**
  - **BUG** — handleable/parseable input the tool gets *wrong* (silent-wrong output,
    spurious parse failure, or a crash). These are defects.
  - **GAP** — a construct with no NRQL equivalent that *correctly* emits a loud
    `unsupported` placeholder. Coverage to add, not a defect.
  - **RENDER-FAIL** — the importer emits NRQL that passes the query console / NerdGraph
    compiler but the **live dashboard widget** rejects or mis-renders. The dangerous
    middle ground: pre-flight checks pass, only the widget fails.
- **Repros are 100% synthetic.** Every field/index/token name is invented
  (`web_logs`, `payments`, `checkout-service`, `pod`, `status`, `user_id`, `region`).
  They preserve the *structure* of real-world dashboards; no customer data appears here.
- **Prevalence** is qualitative (Very High / High / Medium / Low / Rare), judged from
  real-world dashboard exports. Exact counts are tracked privately and intentionally
  omitted here.
- **Sources:** `SQW` = subquery-wrapping (graduated to `design-decisions.md`) · `ISW` = importer-sweep-fixes spec ·
  `MVX` = mvexpand→EXPAND spec · `SKT` = skipped-tests spec · `corpus` = the private
  dashboard-import diagnostic (`nr-query-bridge-corpus`, run via `dashboard-diagnostic.mjs`).

---

## Translator bugs

| id | class | problem | synthetic repro | user sees | prevalence | source |
|---|---|---|---|---|---|---|
| `eval-after-stats` | BUG | An `eval` after an aggregation never wraps as a subquery; the eval becomes a *pre*-aggregation `WITH` binding referencing a post-stats column that doesn't exist, and the computed column is never selected. Emitted with no warning. | `… \| stats count by pod \| eval pct = count * 100` | Compiling NRQL, **wrong numbers**, no warning | High | SQW, corpus |
| `timechart-then-stats-timeseries` | BUG | `timechart … \| stats …` drops the timechart's TIMESERIES from the inner aggregation and bolts `TIMESERIES AUTO` onto the outer (non-time-bucketed) query. | `… \| timechart count by pod \| stats avg(count) as a` | Compiling NRQL, wrong time bucketing | Low | SQW |
| `head-between-stats` | BUG | `head N` between two aggregations lands on the outer query (a no-op without FACET) while the inner is forced to `LIMIT MAX`; the "top-N before aggregating" semantic is silently lost. | `… \| stats count by pod \| head 10 \| stats avg(count) as a` | Averages all groups instead of top 10 | Rare | SQW |
| `stats-count-by-array-field` | BUG | `stats count by arrayField{}.sub` does not row-expand; it backtick-escapes the `{}` name and groups on the literal field, giving wrong counts. (`uniques()`/`values()` are fine; `count by` needs real expansion.) | `… \| stats count by validations{}.code` | Wrong grouping / broken NRQL | Low | SKT, MVX |
| `stats-eval-grammar` | BUG | The grammar doesn't recognize a bare top-level `eval(...)` as a stats/timechart function (only `fn(eval(...))` parses), so it **silently drops** the computed metric and emits `SELECT *` — no error, no warning. (The resulting `SELECT * … TIMESERIES` then also render-fails per `select-star-in-chart`.) | `… \| timechart eval(sum(errors)*100/sum(reqs)) as rate span=5m` → `FROM … SELECT * TIMESERIES 5 minutes` | Metric silently gone; widget rejects `SELECT *`+TIMESERIES | Rare | SKT |
| `splunk-env-tokens` | BUG | Splunk **environment/global** tokens — Splunk's `$env:…$` namespace, which is *runtime context* (current app/page/user/locale + user-profile fields), **not** user-defined dashboard variables. The translator treats them like ordinary `$tok$` and emits `{{env:app}}` — an **undefined** NR template variable: no backing definition, and `:` isn't a valid NR variable character either. NR has no equivalent for runtime context, so these should be dropped or flagged `unsupported`, never turned into dead variables. (In `eval` string position they instead pass through as a literal `$env:user$` string — also wrong, and inconsistent.) Corpus-observed set (8): `$env:app$`, `$env:page$`, `$env:user$`, `$env:locale$`, `$env:user_timezone$`, `$env:user_realname$`, `$env:user_email$`, `$env:is_cloud$` (documented core is user/page/locale; the corpus shows the set is larger). | `app="$env:app$" \| stats count` → `… WHERE app = {{env:app}}` | Undefined/dead `{{env:…}}` variable (unbound at render) or literal `$env:…$` text | High | corpus |

## Importer bugs

| id | class | problem | synthetic repro | user sees | prevalence | source |
|---|---|---|---|---|---|---|
| `detectformat-aborts-envelope` | BUG | `detectFormat` runs *before* `runImport`'s per-entry try/catch and throws on the first malformed entry, so one non-conforming entry aborts the **entire** REST export. The bulk-isolation guarantee has a hole at the detect stage. | A REST export where one Studio entry's `eai:data` doesn't match the assumed `<definition><![CDATA[…]]>` shape | **Zero dashboards** produced from the whole export | Critical (structural) | corpus |
| `supported-command-reported-unsupported` | BUG | On real exports, *supported* commands (`search`/`where`/`timechart`/`top`/`sort`/`rename`) are sometimes reported as "no known NRQL equivalent" — the parser produced an unknown-command node, poisoning the panel. **One trigger isolated (2026-06-27):** a `$token$` in a comparison **LHS/field position** fails to parse and poisons the whole command — the multiselect means-all idiom `($tok$="*" OR field="$tok$")`, or a bare `$tok$="*"`. Reproduced deterministically on the CLI for `search`/`where`/`timechart`. Likely the dominant cause (heavy corpus prevalence) but maybe not the only one — the previously-ruled-out shapes (time-token head, bare-leading, multi-command, early-unsupported) are unrelated. | `... \| search ($tok$="*" OR category="$tok$")` → `unsupported: SPL command 'search' …` | A supported command wrongly reported unsupported → placeholder | High | corpus |
| `time-picker-token-dropped` | BUG | Dashboard time-picker tokens (`$tr.earliest$`/`$tr.latest$`) are silently **dropped** (with a warning); the panel loses its intended time window and falls back to the dashboard default — a silent semantic change. (A literal `earliest=-24h` translates correctly to `SINCE 24 hours ago`.) | `earliest=$tr.earliest$ latest=$tr.latest$ web_logs \| timechart count` | Panel silently loses its time scoping (warned, easy to miss) | High | corpus |
| `rex-regex-robustness` | BUG | The translator frequently can't parse real `rex` patterns — general parse failures, `max_match`, and lookahead/lookbehind. Field extraction is the backbone of log dashboards. | `… \| rex field=message "user=(?<user_id>\w+)" max_match=0` | Placeholder; extraction lost | Medium | corpus |
| `html-panel-not-markdown` | BUG | A Simple XML `<html>` panel is static text but becomes a *placeholder* instead of a clean NR markdown widget (Studio's `splunk.markdown` already converts cleanly). | `<panel><html><h2>Overview</h2></html></panel>` | Placeholder instead of rendered text | Very High | corpus |

## Detection robustness

| id | class | problem | synthetic repro | user sees | prevalence | source |
|---|---|---|---|---|---|---|
| `unrecognized-export-format` | BUG | Real exports vary more than `detectFormat` assumes; some inputs are classified "unrecognized format" at detection and skipped entirely. | An export whose envelope/wrapper isn't one of the assumed Simple XML / Studio forms | Input skipped, no dashboard | Medium | corpus |
| `studio-v2-no-cdata` | BUG | Some Studio v2 entries don't carry the assumed `<definition><![CDATA[…]]>` wrapper and are skipped at detection. | A Studio v2 entry whose `eai:data` is pure JSON with no `<definition>` CDATA | Input skipped, no dashboard | Low | corpus |

## Coverage gaps (correct loud placeholders — no NRQL equivalent)

These fail loudly and *correctly*; they are coverage to add, not defects. Listed
because a placeholder is still a panel the customer loses.

| id | class | problem | synthetic repro | user sees | prevalence | source |
|---|---|---|---|---|---|---|
| `wildcard-rename` | GAP | `rename meta.* as *` (wildcard rename) has no NRQL equivalent. The single largest placeholder reason in real exports — deserves at minimum a dedicated message, possibly partial handling. | `… \| rename meta.* as *` | Placeholder | Very High | corpus |
| `mvexpand-unsupported` | GAP | `mvexpand` (row expansion) has no emitted NRQL form — the `EXPAND` design is unbuilt. | `… \| spath path=items{}.status \| mvexpand status` | Placeholder | High | MVX, SKT, corpus |
| `mvexpand-cascading` | GAP | Cascading `mvexpand` (expand→expand) needs nested EXPAND + a subquery `expand` field that doesn't exist. | `… \| mvexpand items \| spath path=ch{} \| mvexpand ch` | Placeholder | Medium | MVX, SKT |
| `mvexpand-cross-field` | GAP | `mvexpand` across two different arrays in one pipeline. | `… \| mvexpand items \| mvexpand tags` | Placeholder | Medium | MVX, SKT |
| `mvzip-unsupported` | GAP | `mvzip` (element-wise pairing of two multivalue fields) has no NRQL equivalent. | `… \| eval pairs = mvzip(user_id, region)` | Placeholder | High | corpus |
| `strftime-strptime` | GAP | `eval strftime(...)` / `strptime(...)` time-format conversions have no NRQL equivalent. | `… \| eval ts = strftime(_time, "%Y-%m-%d")` | Placeholder | High | corpus |
| `affixed-token` | GAP | A dashboard `$tok$` fused to literal text in a string value — NR substitutes a variable in value position only, never inside a literal. | `pod="checkout-$region$-node"` | Placeholder | High | corpus, ISW |
| `wildcard-token-like` | GAP | A wildcard-only token (`"*$tok$*"`) emits `field LIKE {{tok}}`, but the `%` must live in the variable's values; for free-text/search-backed variables the importer can't inject them. | `pod="*$region$*"` | `LIKE {{region}}` + warning; may not match as intended | Medium | ISW, corpus |
| `spath-auto-extract` | GAP | `spath` with no `path=` (auto-extract all fields) has no NRQL equivalent. | `… \| spath` | Placeholder | Medium | corpus |
| `transaction-unsupported` | GAP | `transaction` (session grouping by field + time window) has no NRQL primitive. | `… \| transaction user_id maxspan=30s` | Placeholder | Medium | corpus |
| `rest-unsupported` | GAP | `rest` (queries the Splunk REST API) has no NRQL equivalent. | `\| rest /services/server/info` | Placeholder | Medium | corpus |
| `tstats-unsupported` | GAP | `tstats` (CIM accelerated data models) has no NRQL equivalent. | `\| tstats count from datamodel=Web by status` | Placeholder | Medium | corpus |
| `append-subsearch` | GAP/LOSSY | The simple stats-merge form translates to `filter()` (lossy — a warning notes both sides now read the same source, so a different-index subsearch is silently conflated); `append` forms beyond stats-merge have no equivalent → placeholder. | `… \| stats count \| append [search payments \| stats count]` → `filter()` + warning | `filter()` (lossy) or placeholder, by form | Medium | corpus |
| `filldown-unsupported` | GAP | `filldown` (carry-forward null fill) has no NRQL equivalent. | `… \| filldown status` | Placeholder | Medium | corpus |
| `timewrap-unsupported` | GAP | `timewrap` (period-over-period overlay) has no faithful NRQL equivalent: it tiles the search window into N non-overlapping periods, one series per period, whereas `COMPARE WITH … AGO` overlays only a **single** prior period (live-confirmed, staging acct 10671289), and a `FACET weekdayOf(timestamp), …` time-fold is a lossy approximation (silently omits empty buckets, unordered, can truncate on FACET cardinality). Currently emits the generic `unsupported_command`; a dedicated message explaining the mismatch would be an improvement. | `… \| timechart span=1h count \| timewrap 1d` | Placeholder (`unsupported: SPL command 'timewrap' has no known NRQL equivalent`) | Low | corpus |
| `span-token-unsupported` | GAP | `span=$tok$` (a token in the span position) can't become a concrete TIMESERIES span. | `… \| timechart count span=$timespan$` | Placeholder, no TIMESERIES | Medium | corpus, ISW |
| `token-lhs-idiom` | GAP | The `($tok$="*" OR field="$tok$")` multiselect "match-all-or-filter" idiom — a dashboard token in comparison FIELD position. **Real: 124 corpus occurrences, ALWAYS this OR-idiom shape, never standalone** (`$tok_category$`, `$tok_class_name$`, `$tok_channel$`, …). Faithful path: collapse the idiom to `WHERE field LIKE {{tok}}` with the migrator setting the All value = `%` (All→`field LIKE '%'` = present; a specific value → `LIKE 'v'` = exact match). Token stays in VALUE position throughout, dodging the identifier-vs-value strategy conflict that a literal two-branch translation hits. (Standalone `IS NOT NULL`/identifier and the operand-flip were explored and rejected — no standalone cases exist, and the flip mis-reads the semantics.) | `($tok_category$="*" OR category="$tok_category$")` | Parse error (master) / wrong flip on `feat/token-in-lhs-flip` (`'*' = {{tok}}`) — neither faithful | Medium (124×) | corpus |
| `bare-token-search` | GAP | A bare dashboard token as a search term (`search $tok$`, no `field=`) is a substring search of the log body; today it emits a dangling `{{tok}}`. Faithful: `message LIKE {{tok}}` + `wildcard_token_like` warning (a bare LITERAL keyword already → `message LIKE '%term%'`, splToIR:598 — correct, not a gap). **`allColumnSearch` is deliberately NOT used**: a Splunk bare term matches `_raw`/index-time tokens, not search-time-extracted field values, so ACS over-matches (invents hits from derived attributes a Splunk user never sees); `message LIKE` is the faithful, cheaper target. | `search $tok$` | dangling `{{tok}}` | Low | corpus |

## Render-time failures (emitted NRQL the live widget rejects)

The dangerous middle: these pass the query console and the NerdGraph compiler but the
**dashboard widget** rejects or mis-renders them — so a migration looks successful in
every pre-flight check and only breaks once the customer opens the board. They are
**not** counted as placeholders anywhere, so the true working-widget rate is lower than
any "clean" tally suggests.

| id | class | problem | synthetic repro | user sees | source |
|---|---|---|---|---|---|
| `order-by-aggregation` | RENDER-FAIL | `top`/`sort` emit `… FACET x ORDER BY count DESC`. Faceted aggregations are already implicitly ordered; the widget engine rejects an explicit `ORDER BY` on them — but the console and NerdGraph accept it. | `FROM web_logs SELECT count(*) FACET pod ORDER BY count DESC` | Widget banner: *"ORDER BY ASC/DESC is not supported on aggregation function queries"* | live-confirmed |
| `template-var-in-subquery` | RENDER-FAIL | A `{{var}}` inside `FROM (subquery …)` is not reliably substituted by the dashboard's variable interpolator, so the token reaches NRDB unbound — even when the variable is defined. | `FROM (FROM web_logs SELECT count(*) WHERE region = {{region}} FACET pod) SELECT max(count)` | Widget banner: *"NRQL Syntax Error: Found undefined template variable(s)"* | live-confirmed |
| `select-star-in-chart` | RENDER-FAIL | A `SELECT *` (raw events) query in a bar/line/billboard widget has no aggregate to plot; only a table can render it. SPL bare `search` translates to `SELECT *`. | `FROM web_logs SELECT *` placed in a bar/line/billboard | Blank widget, no error | live-confirmed |

---

## Consolidation

This list is the master tracker. The following are **superseded for problem tracking**
by the rows above. The on-disk specs carry a pointer header and remain (they hold
fix-design detail this catalog omits); subquery-wrapping has already graduated:

- subquery-wrapping problems (`eval-after-stats`, `timechart-then-stats-timeseries`, `head-between-stats`) — graduated to `.claude/rules/design-decisions.md`; no standalone spec on master
- `2026-06-22-importer-sweep-fixes-design.md` → its residual deferred items (`affixed-token`, `wildcard-token-like`, `span-token-unsupported`); its eight numbered bugs are recorded as **shipped** in that spec's close-out and are excluded here. If any regress, `dashboard-diagnostic.mjs` will resurface them.
- `2026-06-18-mvexpand-to-expand-design.md` → the `mvexpand-*` / `mvzip` family
- `2026-03-30-skipped-tests-design.md` → `stats-count-by-array-field`, `stats-eval-grammar`, and the multivalue gaps

Kept as-is (not problem catalogs): `2026-06-12-dashboard-importer-design.md` (foundational
architecture), `2026-06-25-simplexml-base-delegate-design.md` (a proposed fix approach).

## Caveat on "clean" counts

Throughout the corpus diagnostic, "clean" means *the importer emitted NRQL* — **not**
that the widget renders. The three render-fails above are emitted as "clean" yet fail
live, so the true working-widget rate is below any reported clean percentage. Closing
the render-fails matters as much as closing the placeholders.

