# SPL-to-NRQL Translation Reference

<!-- AI-DEV: Code blocks between spl-cases/spl-table sentinels are auto-generated from test cases in spl.test.js. Do NOT edit them manually. Edit the prose freely. -->

<!-- sort-order: status -->

<!-- AI-DEV: spl-table-tags declares doc: tags that intentionally have NO generated
     sentinel section — parser-leniency and regression-guard groupings, not
     command-doc sections. Every doc: tag in spl.test.js MUST either have a
     <!-- spl-cases: TAG --> sentinel OR be listed here, or the doc-currency test
     fails loudly. Do NOT remove a tag from this list to silence that failure
     without either adding a real sentinel section or deleting the tag from its
     test cases. -->
<!-- spl-table-tags: bin-as-alias, stats-agg, quoted-field-name, eval-plus-arithmetic-regression, where-comparison-rhs, where-bang-negation, where-bang-regression, where-leading-dot-decimal, where-mvcount, sort-leniency, sort-typehint, sort-space-multikey, sort-leading-zero-regression, top-multifield, top-multifield-regression, timechart-by-options, timechart-by-options-regression, tokenizer-empty-list-item, tokenizer-in-space-separated, tokenizer-in-comma-regression, tokenizer-where-no-space, tokenizer-where-space-regression, tokenizer-stats-stray-comma, tokenizer-stats-multi-fn-regression, tokenizer-quote-boundary, tokenizer-quote-boundary-token, tokenizer-quote-boundary-macro, tokenizer-quote-boundary-spaced-regression, tokenizer-quote-boundary-or-regression, tokenizer-quote-boundary-paren-regression, eval-like-apostrophe-regression, where-in-func-regression, regex-apostrophe-regression, regex-template-var-regression, compound-eval-eval, compound-eval-where, compound-eval-stats, compound-where-where, compound-stats-stats -->

See [CLI.md](CLI.md) for the command-line tool documentation.

<!-- toc -->
- [Heavily Used Commands (50+ occurrences)](#heavily-used-commands-50-occurrences)
- [Moderate Use Commands (20–49 occurrences)](#moderate-use-commands-20-49-occurrences)
- [Rare Use Commands (1–19 occurrences)](#rare-use-commands-1-19-occurrences)
- [No Observed Usage](#no-observed-usage)
- [Statistical and Charting Functions](#statistical-and-charting-functions)
- [Time Format Variables and Modifiers](#time-format-variables-and-modifiers)
- [Search Syntax](#search-syntax)
- [Graceful Degradation](#graceful-degradation)
- [Edge Cases & Real-World Queries](#edge-cases-real-world-queries)
<!-- /toc -->

---

# Heavily Used Commands (50+ occurrences)

Commands that appear in 50 or more real-world customer queries or security detections. These are the commands that matter most for migration.

---


## `append` — Supported

Appends the results of a subsearch to the current results. The translator merges the main query and subsearch into a single NRQL query — using `filter()` when the WHERE clauses differ, or a combined SELECT when they match.

<!-- spl-cases: correlation-append -->
```
✅ Confirmed by human
SPL:  index=main "Cache hit" | stats count as Hits | append [search index=main "Cache miss" | stats count as Misses]
NRQL: FROM Log SELECT filter(count(*), WHERE index = 'main' AND message LIKE '%Cache hit%') AS 'Hits', filter(count(*), WHERE index = 'main' AND message LIKE '%Cache miss%') AS 'Misses'
🟡 `append` translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log
```

```
✅ Confirmed by human
SPL:  * | stats avg(duration) | append [search * | stats max(duration)]
NRQL: FROM Log SELECT average(duration), max(duration)
🟡 `append` merged into a single query; SPL append runs the subsearch independently, but here both sides query the same events
```

```
✅ Confirmed by human
SPL:  error | stats count by host | append [search success | stats count by host]
NRQL: FROM Log SELECT filter(count(*), WHERE message LIKE '%error%'), filter(count(*), WHERE message LIKE '%success%') FACET host
🟡 `append` subsearch: NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🟡 `append` translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats count by host | append [search * | stats avg(duration) by host]
NRQL: FROM Log SELECT count(*), average(duration) FACET host
🟡 `append` subsearch: NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🟡 `append` merged into a single query; SPL append runs the subsearch independently, but here both sides query the same events
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  error | stats avg(duration) as err_dur | append [search success | stats avg(duration) as ok_dur]
NRQL: FROM Log SELECT filter(average(duration), WHERE message LIKE '%error%') AS 'err_dur', filter(average(duration), WHERE message LIKE '%success%') AS 'ok_dur'
🟡 `append` translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log
```

```
✅ Confirmed by human
SPL:  error | stats avg(duration) | append [search success | stats max(duration)]
NRQL: FROM Log SELECT filter(average(duration), WHERE message LIKE '%error%'), filter(max(duration), WHERE message LIKE '%success%')
🟡 `append` translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log
```

```
❓ Not confirmed
SPL:  status=200 | stats count | append [search status=500 | stats count]
NRQL: FROM Log SELECT filter(count(*), WHERE status = '200' OR numeric(status) = 200), filter(count(*), WHERE status = '500' OR numeric(status) = 500)
🟡 `append` translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log
```

```
❓ Not confirmed
SPL:  index=web error | stats count | append [search index=web success | stats count]
NRQL: FROM Log SELECT filter(count(*), WHERE index = 'web' AND message LIKE '%error%'), filter(count(*), WHERE index = 'web' AND message LIKE '%success%')
🟡 `append` translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log
```

```
❓ Not confirmed
SPL:  * | where status=500 | stats avg(duration) as err_dur | append [search * | stats avg(duration) as all_dur]
NRQL: FROM Log SELECT filter(average(duration), WHERE status = '500' OR numeric(status) = 500) AS 'err_dur', average(duration) AS 'all_dur'
🟡 `append` translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log
```

```
✅ Confirmed by human
SPL:  index=web | append [search index=api]
🔴 `append` with subsearch cannot be automatically translated; consider using filter() to compute multiple aggregations in a single query, or use separate widgets for each data source
```

```
✅ Confirmed by human
SPL:  * | stats count as total | append [search * | stats avg(duration) by host]
🟡 `append` subsearch: NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 `append` with subsearch has mismatched FACET: main groups by (none), subsearch groups by host
```

```
❓ Not confirmed
SPL:  index=web | stats count as web_count | append [search index=api | stats count as api_count]
🔴 `append` subsearch reads a different index/sourcetype/source than the main search; NR Log has no UNION or multi-source FROM, so one FROM Log query cannot read both datasets
```

```
🤖 Confirmed by LLM
SPL:  * | append [search * | table host]
🔴 `append` with subsearch cannot be automatically translated; consider using filter() to compute multiple aggregations in a single query, or use separate widgets for each data source
```
<!-- /spl-cases -->

## `appendcols` — Supported

Adds subsearch results as new columns. Uses the same merge logic as `append` — merges into a single SELECT or uses `filter()` when WHERE clauses differ.

<!-- spl-cases: correlation-appendcols -->
```
✅ Confirmed by human
SPL:  index=main | stats count as total_requests | appendcols [search index=main level=error | stats count as errors]
NRQL: FROM Log SELECT filter(count(*), WHERE index = 'main') AS 'total_requests', filter(count(*), WHERE index = 'main' AND level = 'error') AS 'errors'
🟡 `appendcols` translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log
```

```
✅ Confirmed by human
SPL:  * | stats count as total | appendcols [search * | stats count by host]
🟡 `appendcols` subsearch: NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 `appendcols` with subsearch has mismatched FACET: main groups by (none), subsearch groups by host
```
<!-- /spl-cases -->

## `appendpipe` — Supported

Runs a subpipeline and appends results. In practice, used for zero-fill fallbacks which are a no-op in NRQL (dashboards handle empty results natively). Ignored with a warning.

<!-- spl-cases: correlation-appendpipe -->
```
✅ Confirmed by human
SPL:  * | stats count as search_count | appendpipe [stats count | where count=0]
NRQL: FROM Log SELECT count(*) AS 'search_count'
🟡 `appendpipe` adds summary rows to results; NRQL cannot append rows to a query. The sub-pipeline aggregation is available as a nested query, but the "append as new row" behavior must be handled by the UI.
```
<!-- /spl-cases -->

## `bin` / `bucket` — Supported

Groups continuous numeric values into discrete buckets. `bin _time span=X` translates to `TIMESERIES X`. `bin field span=N` translates to `FACET histogram(field, N)`.

<!-- spl-cases: reports-bin -->
```
✅ Confirmed by human
SPL:  * | bin _time span=5m
NRQL: FROM Log SELECT count(*) TIMESERIES 5 minutes
```

```
✅ Confirmed by human
SPL:  * | bucket _time span=5m
NRQL: FROM Log SELECT count(*) TIMESERIES 5 minutes
```

```
✅ Confirmed by human
SPL:  * | bucket span=5m _time | stats count by _time
NRQL: FROM Log SELECT count(*) TIMESERIES 5 minutes
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | bin size span=10
NRQL: FROM Log SELECT histogram(size, 10)
```
<!-- /spl-cases -->

## `chart` — Supported

Creates a data table suitable for charting. Translates to NRQL `SELECT ... FACET ... TIMESERIES`.

<!-- spl-cases: reports-chart -->
```
✅ Confirmed by human
SPL:  * | chart count by status
NRQL: FROM Log SELECT count(*) FACET status
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | chart count as c over dow by hod
NRQL: FROM Log SELECT count(*) AS 'c' WHERE index = 'web' FACET dow, hod
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | chart count by a, b limit=0
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET a, b LIMIT MAX
```

```
❓ Not confirmed
SPL:  index=web | chart first(count) OVER host BY ver
NRQL: FROM Log SELECT latest(count) WHERE index = 'web' FACET host, ver
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | chart count over _time span=1h by host
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host TIMESERIES 1 hour
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | chart count over host span=1
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 `chart` span=1 bins the 'over' field into numeric ranges; only 'over _time' maps to NRQL TIMESERIES — use bin/histogram() for a numeric field
```
<!-- /spl-cases -->

## `convert` — Partial support

Converts field values between formats. Translates to NRQL `WITH` expressions. Not supported: `rmunit()`, `memk()`, `auto()`.

| Function | Example input → output | NRQL |
|---|---|---|
| `num(field)` | `'1234567'` → `1234567` | `numeric(field)` |
| `rmcomma(field)` | `'1,234,567'` → `1234567` | `numeric(replace(field, ',', ''))` |
| `ctime(field)` | `1741916927007` → `'2026-03-13T23:48:47.007Z'` | `toDatetime(field)` |
| `mktime(field)` | `'2026-03-13T23:48:47.007Z'` → `1741916927007` | `toTimestamp(field)` |
| `dur2sec(field)` | `'346.319ms'` → `0.346`, `'5.47s'` → `5.47`, `'01:30:45'` → `5445` | multi-branch `if()` |
| `mstime(field)` | `'02:30.500'` → `150.5` | `substring()`/`position()` arithmetic |

<!-- spl-cases: fields-convert -->
```
✅ Confirmed by human
SPL:  * | convert num(bytes)
NRQL: FROM Log WITH numeric(bytes) AS bytes_converted SELECT *
🟡 `convert` num(bytes): NRQL cannot overwrite a field in-place; aliased to bytes_converted
```

```
✅ Confirmed by human
SPL:  * | convert rmcomma(total)
NRQL: FROM Log WITH numeric(replace(total, ',', '')) AS total_converted SELECT *
🟡 `convert` rmcomma(total): NRQL cannot overwrite a field in-place; aliased to total_converted
```

```
✅ Confirmed by human
SPL:  * | convert ctime(timestamp) AS readable
NRQL: FROM Log WITH toDatetime(timestamp) AS readable SELECT *
```

```
✅ Confirmed by human
SPL:  * | convert mktime(timestr)
NRQL: FROM Log WITH toTimestamp(timestr) AS timestr_converted SELECT *
🟡 `convert` mktime(timestr): NRQL cannot overwrite a field in-place; aliased to timestr_converted
```

```
❓ Not confirmed
SPL:  * | convert num(status), rmcomma(total)
NRQL: FROM Log WITH numeric(status) AS status_converted, numeric(replace(total, ',', '')) AS total_converted SELECT *
🟡 `convert` num(status): NRQL cannot overwrite a field in-place; aliased to status_converted
🟡 `convert` rmcomma(total): NRQL cannot overwrite a field in-place; aliased to total_converted
```

```
🤖 Confirmed by LLM
SPL:  * | convert dur2sec(duration)
🔴 `convert` dur2sec(duration) is not supported; NRQL has no duration string parser
```

```
🤖 Confirmed by LLM
SPL:  * | convert mstime(elapsed)
🔴 `convert` mstime(elapsed) is not supported; NRQL has no mm:ss.ms parser
```

```
🤖 Confirmed by LLM
SPL:  * | convert auto(field)
🔴 `convert` auto(field) is not supported; NRQL has no auto-type-detection function
```

```
✅ Confirmed by human
SPL:  * | convert rmunit(field)
🔴 `convert` rmunit(field) not supported in NRQL
```

```
✅ Confirmed by human
SPL:  * | convert memk(field)
🔴 `convert` memk(field) not supported in NRQL
```
<!-- /spl-cases -->

## `dedup` — Supported

Removes duplicate events based on field values. Translates to NRQL `FACET` with `LIMIT MAX`, which groups results by unique field combinations. Add `latest(field)` for each field you want to keep from the original events.

<!-- spl-cases: results-dedup -->
```
✅ Confirmed by human
SPL:  * | dedup host
NRQL: FROM Log SELECT latest(timestamp) FACET host LIMIT MAX
🟡 `dedup` translated to FACET; add latest(field) for each field you want to keep
```

```
✅ Confirmed by human
SPL:  * | dedup host, status
NRQL: FROM Log SELECT latest(timestamp) FACET host, status LIMIT MAX
🟡 `dedup` translated to FACET; add latest(field) for each field you want to keep
```

```
✅ Confirmed by human
SPL:  * | stats count by host | dedup host
NRQL: FROM Log SELECT count(*) FACET host LIMIT MAX
🟡 `dedup` translated to FACET; add latest(field) for each field you want to keep
```

```
❓ Not confirmed
SPL:  * | dedup userId | stats count by routeName
NRQL: FROM Log SELECT uniqueCount(userId) AS 'count' FACET routeName
🟡 `dedup` userId followed by count translated to uniqueCount(userId) (no nesting, no 5,000-key cap). Differences: uniqueCount is approximate at high cardinality; a userId value seen in several groups or time buckets counts once in each (dedup keeps one row); a filter after dedup tests every event with that value, not only the one dedup kept. Exact when duplicate events are copies of one event
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | dedup id | eval s=if(status>=500,"err","ok") | stats count by s
NRQL: FROM Log WITH if(numeric(status) >= 500, 'err', 'ok') AS s SELECT uniqueCount(id) AS 'count' WHERE index = 'web' FACET s
🟡 `dedup` id followed by count translated to uniqueCount(id) (no nesting, no 5,000-key cap). Differences: uniqueCount is approximate at high cardinality; a id value seen in several groups or time buckets counts once in each (dedup keeps one row); a filter after dedup tests every event with that value, not only the one dedup kept. Exact when duplicate events are copies of one event
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | dedup id | where status>=500 | stats count by host
NRQL: FROM Log SELECT uniqueCount(id) AS 'count' WHERE index = 'web' AND numeric(status) >= 500 FACET host
🟡 `dedup` id followed by count translated to uniqueCount(id) (no nesting, no 5,000-key cap). Differences: uniqueCount is approximate at high cardinality; a id value seen in several groups or time buckets counts once in each (dedup keeps one row); a filter after dedup tests every event with that value, not only the one dedup kept. Exact when duplicate events are copies of one event
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | dedup id | timechart count by status
NRQL: FROM Log SELECT uniqueCount(id) AS 'count' WHERE index = 'web' FACET status TIMESERIES AUTO
🟡 `dedup` id followed by count translated to uniqueCount(id) (no nesting, no 5,000-key cap). Differences: uniqueCount is approximate at high cardinality; a id value seen in several groups or time buckets counts once in each (dedup keeps one row); a filter after dedup tests every event with that value, not only the one dedup kept. Exact when duplicate events are copies of one event
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  * | dedup userId | stats count as users
NRQL: FROM Log SELECT uniqueCount(userId) AS 'users'
🟡 `dedup` userId followed by count translated to uniqueCount(userId) (no nesting, no 5,000-key cap). Differences: uniqueCount is approximate at high cardinality; a userId value seen in several groups or time buckets counts once in each (dedup keeps one row); a filter after dedup tests every event with that value, not only the one dedup kept. Exact when duplicate events are copies of one event
```

```
❓ Not confirmed
SPL:  * | dedup userId | stats count(routeName)
NRQL: FROM (FROM Log SELECT latest(routeName) AS 'routeName' FACET userId LIMIT MAX) SELECT count(routeName) LIMIT MAX
🟡 `dedup` translated to FACET with latest() of routeName: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
```

```
❓ Not confirmed
SPL:  * | dedup userId | eval userId=lower(userId) | stats count
NRQL: FROM (FROM Log SELECT latest(timestamp) FACET userId LIMIT MAX) SELECT count(*) LIMIT MAX
🟡 `dedup` translated to FACET; add latest(field) for each field you want to keep
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
```

```
❓ Not confirmed
SPL:  (routeName="AddItem" OR routeName="Submit") msg="Processed Server Request.  Status: 200" | eval orders=if(routeName=="Submit",1,0) | dedup userId | eval addtobags=if(routeName=="AddItem",1,0) | timechart eval((sum(orders)*100)/sum(addtobags)) as completionRate span=1m
NRQL: FROM (FROM Log WITH if(routeName = 'Submit', 1, 0) AS orders SELECT latest(routeName) AS 'routeName', latest(orders) AS 'orders', if(latest(routeName) = 'AddItem', 1, 0) AS 'addtobags' WHERE routeName = 'AddItem' OR routeName = 'Submit' AND msg = 'Processed Server Request.  Status: 200' FACET userId LIMIT MAX) SELECT sum(orders) * 100 / sum(addtobags) AS 'completionRate' LIMIT MAX TIMESERIES 1 minute
🟡 `dedup` translated to FACET with latest() of routeName, orders: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
🟡 `dedup` with timechart: TIMESERIES on a nested subquery only populates the first time bucket; remaining buckets return null. Consider using uniqueCount() per time bucket instead of nested dedup.
```

```
❓ Not confirmed
SPL:  index=web | dedup 1 a
NRQL: FROM Log SELECT latest(timestamp) WHERE index = 'web' FACET a LIMIT MAX
🟡 `dedup` translated to FACET; add latest(field) for each field you want to keep
```

```
❓ Not confirmed
SPL:  index=web | dedup orderId | stats sum(amount) as amount by hour
NRQL: FROM (FROM Log SELECT latest(amount) AS 'amount', latest(hour) AS 'hour' WHERE index = 'web' FACET orderId LIMIT MAX) SELECT sum(amount) AS 'amount' FACET hour LIMIT MAX
🟡 `dedup` translated to FACET with latest() of amount, hour: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
```

```
❓ Not confirmed
SPL:  index=web | dedup orderId | eval region=upper(region) | stats sum(amount) by region
NRQL: FROM (FROM Log SELECT latest(region) AS 'region', latest(amount) AS 'amount' WHERE index = 'web' FACET orderId LIMIT MAX) SELECT sum(amount) FACET upper(region) AS 'region' LIMIT MAX
🟡 `dedup` translated to FACET with latest() of region, amount: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
```

```
❓ Not confirmed
SPL:  index=web | dedup orderId | where region="au" | stats sum(amount)
NRQL: FROM (FROM Log SELECT latest(region) AS 'region', latest(amount) AS 'amount' WHERE index = 'web' FACET orderId LIMIT MAX) SELECT sum(amount) WHERE region = 'au' LIMIT MAX
🟡 `dedup` translated to FACET with latest() of region, amount: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
```

```
❓ Not confirmed
SPL:  index=web | dedup orderId | eval h=strftime(_time,"%H") | stats sum(amount) by h
NRQL: FROM (FROM Log SELECT latest(timestamp) AS 'timestamp', latest(amount) AS 'amount' WHERE index = 'web' FACET orderId LIMIT MAX) SELECT sum(amount) FACET toDatetime(timestamp, 'HH') AS 'h' LIMIT MAX
🟡 `dedup` translated to FACET with latest() of timestamp, amount: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
```

```
❓ Not confirmed
SPL:  index=web | table a b | dedup k
NRQL: FROM Log SELECT latest(a) AS 'a', latest(b) AS 'b' WHERE index = 'web' FACET k LIMIT MAX
🟡 `dedup` translated to FACET with latest() of a, b: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
```

```
❓ Not confirmed
SPL:  index=web | dedup k | eval x=amount*2 | stats sum(x) by region
NRQL: FROM (FROM Log SELECT latest(amount) AS 'amount', latest(region) AS 'region', latest(amount) * 2 AS 'x' WHERE index = 'web' FACET k LIMIT MAX) SELECT sum(x) FACET region LIMIT MAX
🟡 `dedup` translated to FACET with latest() of amount, region: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
```

```
❓ Not confirmed
SPL:  index=web | dedup 3 a
🔴 `dedup` 3 keeps 3 events per key; NRQL FACET returns one row per key, so there is no equivalent (dedup 1 translates)
```
<!-- /spl-cases -->

## `eval` — Supported

Calculates an expression and puts the result into a field. Translates to NRQL `WITH ... AS` expressions.

<!-- spl-cases: fields-eval-arithmetic -->
```
✅ Confirmed by human
SPL:  * | eval d = bytes / 1024, m = price * quantity, a = sent + received, s = end_time - start_time, r = x % 10
NRQL: FROM Log WITH numeric(bytes) / 1024 AS d, numeric(price) * numeric(quantity) AS m, numeric(sent) + numeric(received) AS a, numeric(end_time) - numeric(start_time) AS s, mod(numeric(x), 10) AS r SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval p1 = a * b + c, p2 = a + b / c, p3 = (a + b) / c, p4 = (a + b) * (c - d)
NRQL: FROM Log WITH numeric(a) * numeric(b) + numeric(c) AS p1, numeric(a) + numeric(b) / numeric(c) AS p2, (numeric(a) + numeric(b)) / numeric(c) AS p3, (numeric(a) + numeric(b)) * (numeric(c) - numeric(d)) AS p4 SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval pct = count / 100.0, chain = a + b + c + d, mul = a * b * c, kb = bytes / 1024, mb = bytes / 1048576, gb = bytes / 1073741824
NRQL: FROM Log WITH numeric(count) / 100 AS pct, numeric(a) + numeric(b) + numeric(c) + numeric(d) AS chain, numeric(a) * numeric(b) * numeric(c) AS mul, numeric(bytes) / 1024 AS kb, numeric(bytes) / 1048576 AS mb, numeric(bytes) / 1073741824 AS gb SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval size_mb = bytes / 1048576 | eval size_gb = size_mb / 1024 | stats avg(size_mb) by host
NRQL: FROM Log WITH numeric(bytes) / 1048576 AS size_mb, numeric(size_mb) / 1024 AS size_gb SELECT average(size_mb) FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  status=200 | eval duration_sec = duration / 1000 | table host, duration_sec
NRQL: FROM Log WITH numeric(duration) / 1000 AS duration_sec SELECT host, duration_sec WHERE status = '200' OR numeric(status) = 200
```

```
✅ Confirmed by human
SPL:  * | eval x=a+b, alias = original, lit = 42, parens = ((a + b)), hyph = http-status / 100, col = aws:region, dot = http.status / 100
NRQL: FROM Log WITH numeric(a) + numeric(b) AS x, original AS alias, 42 AS lit, numeric(a) + numeric(b) AS parens, numeric(`http-status`) / 100 AS hyph, `aws:region` AS col, numeric(`http.status`) / 100 AS dot SELECT *
```

```
✅ Confirmed by human
SPL:  * | spath input=payload path=user.id output=uid | eval uid_num = uid / 1
NRQL: FROM Log WITH jparse(payload, 'user.id') AS uid, numeric(uid) / 1 AS uid_num SELECT *
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
✅ Confirmed by human
SPL:  * | fillnull value=0 bytes | eval kb = bytes / 1024
NRQL: FROM Log WITH numeric(bytes OR 0) / 1024 AS kb SELECT *
```

```
❓ Not confirmed
SPL:  * | stats count by host | eval pct = count * 100
NRQL: FROM Log SELECT count(*) * 100 AS 'pct' FACET host LIMIT MAX
🟡 `eval` after stats: the source aggregate column(s) count are not in the output — only facet keys and eval results are projected, though Splunk's eval would keep the originals too.
```

```
❓ Not confirmed
SPL:  * | stats median(latency) as p50 by host | eval x = p50 * 2
NRQL: FROM Log SELECT median(latency) * 2 AS 'x' FACET host LIMIT MAX
🟡 `eval` after stats: the source aggregate column(s) p50 are not in the output — only facet keys and eval results are projected, though Splunk's eval would keep the originals too.
```

```
❓ Not confirmed
SPL:  * | stats median(duration) as med by service | eval x = med * 2
NRQL: FROM Log SELECT median(duration) * 2 AS 'x' FACET service LIMIT MAX
🟡 `eval` after stats: the source aggregate column(s) med are not in the output — only facet keys and eval results are projected, though Splunk's eval would keep the originals too.
```

```
❓ Not confirmed
SPL:  * | stats p95(duration) as p95 by service | eval x = p95 * 2
NRQL: FROM Log SELECT percentile(duration, 95) * 2 AS 'x' FACET service LIMIT MAX
🟡 `eval` after stats: the source aggregate column(s) p95 are not in the output — only facet keys and eval results are projected, though Splunk's eval would keep the originals too.
```

```
❓ Not confirmed
SPL:  * | stats count by host | eval rps = count/3600
NRQL: FROM Log SELECT count(*) / 3600 AS 'rps' FACET host LIMIT MAX
🟡 `eval` after stats: the source aggregate column(s) count are not in the output — only facet keys and eval results are projected, though Splunk's eval would keep the originals too.
```

```
❓ Not confirmed
SPL:  * | stats count by host | eval band = if(count > 100, "hi", "lo")
NRQL: FROM Log SELECT if(count(*) > 100, 'hi', 'lo') AS 'band' FACET host LIMIT MAX
🟡 `eval` after stats: the source aggregate column(s) count are not in the output — only facet keys and eval results are projected, though Splunk's eval would keep the originals too.
```

```
❓ Not confirmed
SPL:  * | stats sum(bytes) as b, count as c by host | eval avg_size = b / c
NRQL: FROM Log SELECT sum(bytes) / count(*) AS 'avg_size' FACET host LIMIT MAX
🟡 `eval` after stats: the source aggregate column(s) b, c are not in the output — only facet keys and eval results are projected, though Splunk's eval would keep the originals too.
```

```
❓ Not confirmed
SPL:  * | stats count by host | eval count = count + 1
NRQL: FROM Log SELECT count(*) + 1 AS 'count' FACET host LIMIT MAX
🟡 `eval` after stats: the source aggregate column(s) count are not in the output — only facet keys and eval results are projected, though Splunk's eval would keep the originals too.
```

```
❓ Not confirmed
SPL:  * | timechart count by host | eval rps = count/60
NRQL: FROM Log SELECT count(*) / 60 AS 'rps' FACET host LIMIT MAX TIMESERIES AUTO
🟡 `eval` after stats: the source aggregate column(s) count are not in the output — only facet keys and eval results are projected, though Splunk's eval would keep the originals too.
```

```
✅ Confirmed by human
SPL:  * | eval rate = count / duration | sort -rate | head 10
NRQL: FROM Log WITH numeric(count) / numeric(duration) AS rate SELECT * ORDER BY rate DESC LIMIT 10
```

```
✅ Confirmed by human
SPL:  * | eval kb = bytes / 1024 | rename kb as kilobytes
NRQL: FROM Log WITH numeric(bytes) / 1024 AS kb SELECT kb AS 'kilobytes', *
🟡 NRQL rename keeps original field names alongside aliases
```

```
🤖 Confirmed by LLM
SPL:  * | eval parts = split(field, "},{")
NRQL: FROM Log WITH split(field, '},{') AS parts SELECT *
🟡 `split()` with multi-character delimiter '},{' not supported; NRQL split() accepts single characters only
```

```
🤖 Confirmed by LLM
SPL:  * | eval combined = coalesce(msg, message)
NRQL: FROM Log WITH (msg OR message) AS combined SELECT *
```

```
❓ Not confirmed
SPL:  * | eval last = mvindex(result, -1)
NRQL: FROM Log WITH getField(result, -1) AS last SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval hi = status >= 400
NRQL: FROM Log WITH numeric(status) >= 400 AS hi SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval r = a*2+b
NRQL: FROM Log WITH numeric(a) * 2 + numeric(b) AS r SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval r = (a+b)*c
NRQL: FROM Log WITH (numeric(a) + numeric(b)) * numeric(c) AS r SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval r = field + 5
NRQL: FROM Log WITH numeric(field) + 5 AS r SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval r = f + g
NRQL: FROM Log WITH numeric(f) + numeric(g) AS r SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval r = a % b
NRQL: FROM Log WITH mod(numeric(a), numeric(b)) AS r SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval r = round(a) + 1
NRQL: FROM Log WITH round(a) + 1 AS r SELECT *
```

```
❓ Not confirmed
SPL:  * | stats count, sum(throughput) as count by host | eval x = count * 2
🔴 `eval` after stats: two aggregates resolve to the same subquery column 'count', which NRQL would silently collapse to one. Give them distinct aliases before the eval.
```

```
🤖 Confirmed by LLM
SPL:  * | eval paired = mvzip(nodes, skus)
🔴 `mvzip()` has no NRQL equivalent; cannot zip two arrays element-wise into paired tuples
```
<!-- /spl-cases -->

## `eventstats` — Supported

Computes aggregation statistics and adds them as new fields to every event (without collapsing rows). With a BY clause, translates to a NRQL subquery JOIN. Without BY, uses an inline scalar subquery.

<details>
<summary>What customers actually do with <code>eventstats</code> (three main patterns)</summary>

1. **Add a grand total for percentage/threshold calculation** (~47% of usage) — compute per-app counts, add the namespace total, then calculate share or filter by threshold:
   ```
   SPL: index=k8s_main namespace=ns001
        | stats count as appCount by app
        | eventstats sum(appCount) as namespaceCount
        | eval pct = round(appCount / namespaceCount * 100, 2)
   ```
   **NRQL:** No single-query equivalent for the full percentage pattern (eventstats without BY adds a global scalar). For threshold filtering on the grand total, use nested aggregation:
   ```
   FROM (SELECT count(*) AS appCount FROM Log WHERE namespace = 'ns001' FACET app)
   SELECT sum(appCount)
   ```
   For per-app percentages, NRQL's `percentage()` handles the most common case directly:
   ```
   FROM Log SELECT percentage(count(*), WHERE app = 'myapp') FACET namespace
   ```

2. **Add count for filtering** (~43%) — count events per group, keep only rows from groups above a threshold:
   ```
   SPL: index=web | eventstats count by host | where count > 100
   ```
   **NRQL:** Use a subquery JOIN to preserve original rows (nested aggregation collapses rows):
   ```
   FROM Log JOIN (FROM Log SELECT count(*) AS cnt FACET host LIMIT MAX) ON host
   SELECT * WHERE cnt > 100
   ```
   If you only need the group names (not original rows), nested aggregation is simpler:
   ```
   FROM (SELECT count(*) AS cnt FROM Log FACET host) SELECT * WHERE cnt > 100
   ```

3. **Add max(_time) to get the latest record per group** (~10%) — find the most recent event per source:
   ```
   SPL: index=imports | eventstats max(_time) as lastImport by source | where _time=lastImport
   ```
   **NRQL:** Use a subquery JOIN with a WHERE filter on the enriched field:
   ```
   FROM Log JOIN (FROM Log SELECT max(timestamp) AS lastImport FACET source LIMIT MAX) ON source
   SELECT * WHERE timestamp = lastImport
   ```
   If you only need the latest values per group (collapsed):
   ```
   FROM Log SELECT latest(message), latest(level), latest(timestamp) FACET source
   ```

</details>

<!-- spl-cases: reports-eventstats -->
```
✅ Confirmed by human
SPL:  * | eventstats count by host
NRQL: FROM Log JOIN (FROM Log SELECT count(*) AS 'count' FACET host LIMIT MAX) ON host = host SELECT *
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
✅ Confirmed by human
SPL:  * | eventstats avg(duration) AS avg_dur BY host
NRQL: FROM Log JOIN (FROM Log SELECT average(duration) AS 'avg_dur' FACET host LIMIT MAX) ON host = host SELECT *
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
✅ Confirmed by human
SPL:  * | eventstats count AS total
NRQL: FROM Log SELECT *, (FROM Log SELECT count(*)) AS 'total'
🟡 `eventstats` without BY translated as scalar subquery in SELECT; for percentage calculations, use the subquery result in downstream eval
```

```
❓ Not confirmed
SPL:  * | stats count as appCount by app | eventstats sum(appCount) as namespaceCount
NRQL: FROM Log SELECT count(*) AS 'appCount', (FROM (FROM Log SELECT count(*) AS 'appCount' FACET app LIMIT MAX) SELECT sum(appCount)) AS 'namespaceCount' FACET app
🟡 `eventstats` without BY translated as scalar subquery in SELECT; for percentage calculations, use the subquery result in downstream eval
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | eventstats max(timestamp) as lastImport BY source
NRQL: FROM Log JOIN (FROM Log SELECT max(timestamp) AS 'lastImport' FACET source LIMIT MAX) ON source = source SELECT *
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
✅ Confirmed by human
SPL:  * | eventstats avg(duration) AS avg_dur, max(duration) AS max_dur BY host
NRQL: FROM Log JOIN (FROM Log SELECT average(duration) AS 'avg_dur', max(duration) AS 'max_dur' FACET host LIMIT MAX) ON host = host SELECT *
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  index=web | rex "c=(?<cid>\w+)" | eventstats count as n by cid | stats sum(n)
NRQL: FROM Log JOIN (FROM Log WITH capture(message, r'(?s:.*?)c=(?P<cid>\w+)(?s:.*)') AS (cid) SELECT count(*) AS 'n' WHERE index = 'web' FACET cid LIMIT MAX) ON parsed_cid = cid WITH capture(message, r'(?s:.*?)c=(?P<cid>\w+)(?s:.*)') AS (parsed_cid) SELECT sum(n) WHERE index = 'web'
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  index=web | eventstats avg(x) as a by host | where x > a
NRQL: FROM Log JOIN (FROM Log SELECT average(x) AS 'a' WHERE index = 'web' FACET host LIMIT MAX) ON host = host SELECT * WHERE index = 'web' AND numeric(x) > numeric(a)
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  index=web | eventstats values(src) as src by cid | timechart count by status
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET status TIMESERIES AUTO
🟡 `eventstats` values()/list() column(s) src dropped: nothing later reads them, and New Relic cannot carry a list through a JOIN
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | eventstats sum(bytes) AS total BY host, status
🔴 `eventstats` with multiple BY fields (host, status) cannot be translated; NRQL subquery JOIN only supports a single ON key
```

```
❓ Not confirmed
SPL:  index=web | eventstats values(src) as srcs by cid | stats count by srcs
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 `eventstats` values()/list() column(s) srcs cannot be translated: the value is a list, and New Relic cannot carry a list through a JOIN
```
<!-- /spl-cases -->

## `extract` (`kv`) — Not supported

Extracts key-value pairs using automatic field discovery. NRQL has no equivalent to automatic key-value extraction. Use `rex` (capture()) for regex-based extraction or `spath` (jparse()) for structured data.

<!-- spl-cases: fields-extract -->
```
✅ Confirmed by human
SPL:  * | extract pairdelim=","
🔴 Key=value extraction from unstructured text has no NRQL equivalent; use Grok parsing rules to extract fields at ingest time, or restructure logs as JSON
```

```
🤖 Confirmed by LLM
SPL:  * | extract
🔴 Key=value extraction from unstructured text has no NRQL equivalent; use Grok parsing rules to extract fields at ingest time, or restructure logs as JSON
```
<!-- /spl-cases -->

## `table` / `fields` — Partial support

Selects which fields to include in the results. Both `table` and `fields` translate to NRQL `SELECT field1, field2, ...`. The exclude syntax (`fields - field1, field2`) is not supported — NRQL cannot exclude specific fields from `SELECT *`.

<!-- spl-cases: results-table -->
```
✅ Confirmed by human
SPL:  * | table _time, host, status, bytes, url
NRQL: FROM Log SELECT timestamp, host, status, bytes, url
```

```
✅ Confirmed by human
SPL:  * | table *
NRQL: FROM Log SELECT *
```

```
✅ Confirmed by human
SPL:  * | fields host, status
NRQL: FROM Log SELECT host, status
```

```
✅ Confirmed by human
SPL:  * | fields _time, host, status
NRQL: FROM Log SELECT timestamp, host, status
```

```
✅ Confirmed by human
SPL:  * | fields + host, status
NRQL: FROM Log SELECT host, status
```

```
✅ Confirmed by human
SPL:  * | fields - _raw, _time
NRQL: FROM Log SELECT *
🟡 `fields` - (exclude mode) has limited NRQL support
```

```
❓ Not confirmed
SPL:  index=web | stats count as c by a | table a, c
NRQL: FROM Log SELECT count(*) AS 'c' WHERE index = 'web' FACET a
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | stats count as c, max(b) by a | table a, max(b)
NRQL: FROM Log SELECT max(b) WHERE index = 'web' FACET a
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | stats count as c, sum(b) as s by a | fields a, s
NRQL: FROM Log SELECT sum(b) AS 's' WHERE index = 'web' FACET a
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | stats count as c by a, b | table a, c
NRQL: FROM Log SELECT count(*) AS 'c' WHERE index = 'web' FACET a, b
🟡 `table` omits FACET key(s) b, but NRQL always returns FACET keys; they remain in the output
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | stats count by a | table a
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET a
🟡 `table` lists no aggregate column, but NRQL needs at least one alongside FACET; the aggregate column(s) are still returned
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | stats count as c by a | table a, c, missing
NRQL: FROM Log SELECT count(*) AS 'c' WHERE index = 'web' FACET a
🟡 `table` column(s) missing are not produced by the preceding aggregation (Splunk shows them empty); skipped
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | stats count as c by a | where c>5 | table a c
NRQL: FROM (FROM Log SELECT count(*) AS 'c' WHERE index = 'web' FACET a LIMIT MAX) SELECT a, c WHERE numeric(c) > 5
```

```
❓ Not confirmed
SPL:  index=web | table _time, _raw
NRQL: FROM Log SELECT * WHERE index = 'web'
🟡 `table` _raw shows the whole raw event; translated as SELECT * (every attribute of the event — display it as a log table), which may include more columns than the other fields listed
```

```
❓ Not confirmed
SPL:  index=web | table a "B C" Totals*
🔴 `table` wildcard field 'Totals*' has no NRQL equivalent; NRQL SELECT cannot match attributes by name pattern — list the fields explicitly
```

```
❓ Not confirmed
SPL:  index=web | table a, max(b)
🔴 `table` field 'max(b)' names a stats output column, but no stats/chart/timechart precedes it
```
<!-- /spl-cases -->

## `fillnull` — Supported

Replaces null values with a specified value. Each downstream reference to a listed field is inlined as `field OR default` — NRQL's `OR` on non-boolean operands returns the first non-null value (the same null-coalescing form `coalesce()` uses).

<!-- spl-cases: fields-fillnull -->
```
✅ Confirmed by human
SPL:  * | fillnull value=N/A host status
NRQL: FROM Log SELECT host OR 'N/A', status OR 'N/A', *
```

```
✅ Confirmed by human
SPL:  * | fillnull value=0 bytes duration
NRQL: FROM Log SELECT bytes OR 0, duration OR 0, *
```

```
✅ Confirmed by human
SPL:  * | fillnull bytes
NRQL: FROM Log SELECT bytes OR '0', *
```

```
✅ Confirmed by human
SPL:  * | fillnull value="unknown" host
NRQL: FROM Log SELECT host OR 'unknown', *
```

```
✅ Confirmed by human
SPL:  * | fillnull value=0 bytes | stats sum(bytes) by host
NRQL: FROM Log SELECT sum(bytes OR 0) FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | fillnull value=0 field1, field2, field3
NRQL: FROM Log SELECT field1 OR 0, field2 OR 0, field3 OR 0, *
```

```
❓ Not confirmed
SPL:  index=web | fillnull name value="-" | stats count by name
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET name OR '-'
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | timechart count(eval(status="ok")) as success | fillnull value=0 success
NRQL: FROM Log SELECT filter(count(*), WHERE status = 'ok') AS 'success' WHERE index = 'web' TIMESERIES AUTO
🟡 `fillnull` on 'success' dropped: it is a count/sum column, and New Relic already reports an empty bucket as 0
```

```
✅ Confirmed by human
SPL:  * | fillnull value=0
🔴 `fillnull` without field list not supported — NRQL requires explicit field names
```

```
❓ Not confirmed
SPL:  index=web | stats avg(x) as a by host | fillnull value=0 a
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 `fillnull` on aggregate column 'a' has no NRQL equivalent: NRQL cannot re-read an aggregate column in the same query, and only count/sum report an empty bucket as 0
```
<!-- /spl-cases -->

## `foreach` — Not supported

Runs a template expression over a set of fields matching a wildcard pattern. NRQL has no iterator construct — each field must be referenced explicitly.

<!-- spl-cases: fields-foreach -->
```
✅ Confirmed by human
SPL:  * | foreach count_* [eval total=total+<<FIELD>>]
🔴 SPL command 'foreach' has no known NRQL equivalent
```
<!-- /spl-cases -->

## `head` — Supported

Returns the first N results. Translates to NRQL `LIMIT N`.

<!-- spl-cases: results-head -->
```
✅ Confirmed by human
SPL:  * | head 10
NRQL: FROM Log SELECT * LIMIT 10
```

```
✅ Confirmed by human
SPL:  * | head
NRQL: FROM Log SELECT * LIMIT 10
```

```
❓ Not confirmed
SPL:  * | stats count by host | head 10 | stats avg(count) as a
🔴 Head/tail between two aggregations has no NRQL equivalent: SPL keeps the first N rows in stats order, but a nested-subquery LIMIT N keeps the top N by aggregate value. Reorder so the head/tail is not between aggregations.
```

```
❓ Not confirmed
SPL:  * | stats count by host | tail 10 | stats avg(count) as a
🔴 Head/tail between two aggregations has no NRQL equivalent: SPL keeps the first N rows in stats order, but a nested-subquery LIMIT N keeps the top N by aggregate value. Reorder so the head/tail is not between aggregations.
```
<!-- /spl-cases -->

## `join` — Supported

Combines results from a subsearch with current results using a shared field. Translates to NRQL `JOIN ... ON`.

<!-- spl-cases: correlation-join -->
```
✅ Confirmed by human
SPL:  * | join host [search index=other | stats count by host]
NRQL: FROM Log JOIN (FROM Log SELECT count(*) WHERE index = 'other' FACET host LIMIT MAX) ON host = host SELECT *
🟡 `join` subsearch: NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
✅ Confirmed by human
SPL:  * | join type=left src_ip [search index=geo | table src_ip, country]
NRQL: FROM Log LEFT JOIN (FROM Log SELECT src_ip, country WHERE index = 'geo' LIMIT MAX) ON src_ip = src_ip SELECT *
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
🟡 `join` max=1 joins each row to at most 1 subsearch match(es), but NRQL JOIN returns every match (up to 100); if the subsearch can repeat a key, rows will multiply — aggregate the subsearch by the key (e.g. stats latest(x) by key) or use max=0 if every match is intended
```

```
✅ Confirmed by human
SPL:  * | join host [search status=500 | table host, message]
NRQL: FROM Log JOIN (FROM Log SELECT host, message WHERE status = '500' OR numeric(status) = 500 LIMIT MAX) ON host = host SELECT *
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
🟡 `join` max=1 joins each row to at most 1 subsearch match(es), but NRQL JOIN returns every match (up to 100); if the subsearch can repeat a key, rows will multiply — aggregate the subsearch by the key (e.g. stats latest(x) by key) or use max=0 if every match is intended
```

```
✅ Confirmed by human
SPL:  * | join src_ip [search * | stats count, avg(bytes) by src_ip]
NRQL: FROM Log JOIN (FROM Log SELECT count(*), average(bytes) FACET src_ip LIMIT MAX) ON src_ip = src_ip SELECT *
🟡 `join` subsearch: NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
✅ Confirmed by human
SPL:  * | join host [search * | stats count by host | head 100]
NRQL: FROM Log JOIN (FROM Log SELECT count(*) FACET host LIMIT 100) ON host = host SELECT *
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
✅ Confirmed by human
SPL:  status=500 | join host [search * | stats count by host]
NRQL: FROM Log JOIN (FROM Log SELECT count(*) FACET host LIMIT MAX) ON host = host SELECT * WHERE status = '500' OR numeric(status) = 500
🟡 `join` subsearch: NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  * | stats count by host | join host [search * | stats avg(cpu) by host]
NRQL: FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) JOIN (FROM Log SELECT average(cpu) FACET host LIMIT MAX) ON host = host SELECT * LIMIT MAX
🟡 `join` subsearch: NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
✅ Confirmed by human
SPL:  * | join user [search * | table user, role]
NRQL: FROM Log JOIN (FROM Log SELECT user, role LIMIT MAX) ON user = user SELECT *
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
🟡 `join` max=1 joins each row to at most 1 subsearch match(es), but NRQL JOIN returns every match (up to 100); if the subsearch can repeat a key, rows will multiply — aggregate the subsearch by the key (e.g. stats latest(x) by key) or use max=0 if every match is intended
```

```
❓ Not confirmed
SPL:  index=web "failed" | join type=inner requestId [ search index=web "Raising in-doubt" ] | timechart count span=1d
NRQL: FROM Log JOIN (FROM Log SELECT count(*) WHERE index = 'web' AND message LIKE '%Raising in-doubt%' FACET requestId LIMIT MAX) ON requestId = requestId SELECT count(*) WHERE index = 'web' AND message LIKE '%failed%' TIMESERIES 1 day
🟡 `join` subsearch names no fields and nothing later reads one, so it joins on requestId alone as an existence filter; subsearch fields Splunk would overwrite (_time, host, …) are not carried
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  index=web "failed" | dedup requestId | join type=inner requestId [ search index=web "Raising in-doubt" ] | timechart count span=1d
NRQL: FROM Log JOIN (FROM Log SELECT count(*) WHERE index = 'web' AND message LIKE '%Raising in-doubt%' FACET requestId LIMIT MAX) ON requestId = requestId SELECT uniqueCount(requestId) AS 'count' WHERE index = 'web' AND message LIKE '%failed%' TIMESERIES 1 day
🟡 `dedup` requestId followed by count translated to uniqueCount(requestId) (no nesting, no 5,000-key cap). Differences: uniqueCount is approximate at high cardinality; a requestId value seen in several groups or time buckets counts once in each (dedup keeps one row); a filter after dedup tests every event with that value, not only the one dedup kept. Exact when duplicate events are copies of one event
🟡 `join` subsearch names no fields and nothing later reads one, so it joins on requestId alone as an existence filter; subsearch fields Splunk would overwrite (_time, host, …) are not carried
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  index=web | join type=left max=0 id [ search index=other | fields id owner ]
NRQL: FROM Log LEFT JOIN (FROM Log SELECT id, owner WHERE index = 'other' LIMIT MAX) ON id = id SELECT * WHERE index = 'web'
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  index=web | join left=L right=R where L.id=R.id [ search index=other | fields id owner ]
NRQL: FROM Log JOIN (FROM Log SELECT id, owner WHERE index = 'other' LIMIT MAX) ON id = id SELECT * WHERE index = 'web'
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
🟡 `join` max=1 joins each row to at most 1 subsearch match(es), but NRQL JOIN returns every match (up to 100); if the subsearch can repeat a key, rows will multiply — aggregate the subsearch by the key (e.g. stats latest(x) by key) or use max=0 if every match is intended
```

```
❓ Not confirmed
SPL:  index=web | join id [search index=other | stats latest(owner) as owner by id]
NRQL: FROM Log JOIN (FROM Log SELECT latest(owner) AS 'owner' WHERE index = 'other' FACET id LIMIT MAX) ON id = id SELECT * WHERE index = 'web'
🟡 `join` subsearch: NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  index=web | rex "(?<a>\w+)" | join type=inner a [search index=api | rex "(?<a>\w+)" | fields a b] | stats count by a
NRQL: FROM Log JOIN (FROM Log WITH capture(message, r'(?s:.*?)(?P<a>\w+)(?s:.*)') AS (a) SELECT a, b WHERE index = 'api' LIMIT MAX) ON parsed_a = a WITH capture(message, r'(?s:.*?)(?P<a>\w+)(?s:.*)') AS (parsed_a) SELECT count(*) WHERE index = 'web' FACET parsed_a AS 'a'
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
🟡 `join` max=1 joins each row to at most 1 subsearch match(es), but NRQL JOIN returns every match (up to 100); if the subsearch can repeat a key, rows will multiply — aggregate the subsearch by the key (e.g. stats latest(x) by key) or use max=0 if every match is intended
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | join type=inner requestId [ search index=api | fields requestId ] | stats count
NRQL: FROM Log JOIN (FROM Log SELECT count(*) WHERE index = 'api' FACET requestId LIMIT MAX) ON requestId = requestId SELECT count(*) WHERE index = 'web'
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  index=web type="req" | dedup s | table s | join type=left s [ search index=web type="error" | dedup s | table s, detail.message ] | table s, detail.message | rename detail.message AS Err | where isNotNull(Err) | stats count BY Err
NRQL: FROM (FROM Log SELECT latest(timestamp) WHERE index = 'web' AND type = 'req' FACET s LIMIT MAX) LEFT JOIN (FROM Log SELECT latest(`detail.message`) AS 'detail.message' WHERE index = 'web' AND type = 'error' FACET s LIMIT MAX) ON s = s SELECT count(*) WHERE `detail.message` IS NOT NULL FACET `detail.message` AS 'Err' LIMIT MAX
🟡 `dedup` translated to FACET; add latest(field) for each field you want to keep
🟡 `table` lists no aggregate column, but NRQL needs at least one alongside FACET; the aggregate column(s) are still returned
🟡 `join` subsearch: dedup translated to FACET with latest() of detail.message: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
🟡 NRQL rename keeps original field names alongside aliases
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
```

```
❓ Not confirmed
SPL:  index=web type="req" | dedup s | join type=left s [search index=web type="error" | dedup s | table s, m] | table s, m, region
NRQL: FROM (FROM Log SELECT latest(region) AS 'region' WHERE index = 'web' AND type = 'req' FACET s LIMIT MAX) LEFT JOIN (FROM Log SELECT latest(m) AS 'm' WHERE index = 'web' AND type = 'error' FACET s LIMIT MAX) ON s = s SELECT s, m, region LIMIT MAX
🟡 `join` subsearch: dedup translated to FACET with latest() of m: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 `dedup` translated to FACET with latest() of region: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  index=web | dedup s | table s, region | join s [search index=web | dedup s | table s, m] | stats count by region, m
NRQL: FROM (FROM Log SELECT latest(region) AS 'region' WHERE index = 'web' FACET s LIMIT MAX) JOIN (FROM Log SELECT latest(m) AS 'm' WHERE index = 'web' FACET s LIMIT MAX) ON s = s SELECT count(*) FACET region, m LIMIT MAX
🟡 `dedup` translated to FACET with latest() of region: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 `join` subsearch: dedup translated to FACET with latest() of m: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
```

```
❓ Not confirmed
SPL:  index=web | stats count by s | dedup s | join s [search index=web | dedup s | table s, m] | table s, count, m
NRQL: FROM (FROM Log SELECT count(*) WHERE index = 'web' FACET s LIMIT MAX) JOIN (FROM Log SELECT latest(m) AS 'm' WHERE index = 'web' FACET s LIMIT MAX) ON s = s SELECT s, count, m LIMIT MAX
🟡 `dedup` translated to FACET; add latest(field) for each field you want to keep
🟡 `join` subsearch: dedup translated to FACET with latest() of m: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  index=web | stats count by host | join type=left host [search index=db | stats sum(bytes) as b by host] | where b > 100 | eval r=b/count | table host, count, b, r
NRQL: FROM (FROM Log SELECT count(*) WHERE index = 'web' FACET host LIMIT MAX) LEFT JOIN (FROM Log SELECT sum(bytes) AS 'b' WHERE index = 'db' FACET host LIMIT MAX) ON host = host WITH numeric(b) / numeric(count) AS r SELECT host, count, b, r WHERE numeric(b) > 100 LIMIT MAX
🟡 `join` subsearch: NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  index=web | stats count by host | join host [search index=web error | fields host] | table host, count
NRQL: FROM (FROM Log SELECT count(*) WHERE index = 'web' FACET host LIMIT MAX) JOIN (FROM Log SELECT count(*) AS 'joinMatches' WHERE index = 'web' AND message LIKE '%error%' FACET host LIMIT MAX) ON host = host SELECT host, count LIMIT MAX
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  index=web | dedup s | join s [search index=web error | fields s] | table s, region
NRQL: FROM (FROM Log SELECT latest(region) AS 'region' WHERE index = 'web' FACET s LIMIT MAX) JOIN (FROM Log SELECT count(*) WHERE index = 'web' AND message LIKE '%error%' FACET s LIMIT MAX) ON s = s SELECT s, region LIMIT MAX
🟡 `dedup` translated to FACET with latest() of region: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
❓ Not confirmed
SPL:  index=web | stats count by host | join host [search index=db | stats sum(bytes) as b by host] | stats sum(b) as total
NRQL: FROM (FROM Log SELECT count(*) WHERE index = 'web' FACET host LIMIT MAX) JOIN (FROM Log SELECT sum(bytes) AS 'b' WHERE index = 'db' FACET host LIMIT MAX) ON host = host SELECT sum(b) AS 'total' LIMIT MAX
🟡 `join` subsearch: NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
```

```
✅ Confirmed by human
SPL:  * | join type=outer host [search * | stats count by host]
🔴 NRQL does not support full outer join; only INNER and LEFT joins are available
```

```
✅ Confirmed by human
SPL:  * | join host [search status=200 host=web*]
🔴 Subsearch joins require explicit fields. Add a table or fields command to specify which fields to bring over
```

```
❓ Not confirmed
SPL:  index=web | join requestId [ search index=web "x" ] | stats count by host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 Subsearch joins require explicit fields. Add a table or fields command to specify which fields to bring over
```

```
❓ Not confirmed
SPL:  index=web | join type=left a, b [search index=b | table a b]
🔴 `join` on multiple keys (a, b) has no NRQL equivalent; NRQL JOIN … ON supports a single key
```

```
❓ Not confirmed
SPL:  index=web | join left=L right=R where L.id=R.uid [ search index=other | fields uid ]
🔴 `join` where L.id=R.uid compares differently-named fields; NRQL JOIN … ON only supports the same field name on both sides here
```

```
❓ Not confirmed
SPL:  index=web | join [search index=other | fields id owner]
🔴 `join` without a key list joins on every shared field; NRQL JOIN needs a single explicit key — name the key field
```

```
❓ Not confirmed
SPL:  index=web | join max=0 requestId [ search index=api | fields requestId ] | stats count
🔴 `join` on requestId: the subsearch returns a single column, but a NRQL JOIN subquery must select at least 2 values; with max=0 (or a non-key column) there is no faithful key-only form — add another field to the subsearch's fields/table
```

```
❓ Not confirmed
SPL:  index=web | dedup s | join s [search index=web | dedup s | table s, m] | table *
🟡 `dedup` translated to FACET; add latest(field) for each field you want to keep
🟡 `join` subsearch: dedup translated to FACET with latest() of m: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
🔴 `join` on s after a dedup: the fields read after the join can't be enumerated, so the dedup can't carry the ones the subsearch doesn't supply
🔴 Post-aggregation step references '*', which the aggregation does not output (only its BY fields and aggregate columns survive stats)
```
<!-- /spl-cases -->

## `lookup` — Supported

Enriches events with fields from a lookup table. Translates to NRQL `JOIN` with `lookup()`.

<!-- spl-cases: correlation-lookup -->
```
✅ Confirmed by human
SPL:  * | lookup geo_table src_ip
NRQL: FROM Log JOIN (FROM lookup(geo_table) SELECT * FACET src_ip LIMIT MAX) ON src_ip = src_ip SELECT *
🟡 Ensure lookup table 'geo_table' is uploaded via the Lookups UI
```

```
✅ Confirmed by human
SPL:  * | lookup ip_to_country src_ip OUTPUT country
NRQL: FROM Log JOIN (FROM lookup(ip_to_country) SELECT country FACET src_ip LIMIT MAX) ON src_ip = src_ip SELECT *
🟡 Ensure lookup table 'ip_to_country' is uploaded via the Lookups UI
```

```
✅ Confirmed by human
SPL:  * | lookup users_lookup username AS user OUTPUT department
NRQL: FROM Log JOIN (FROM lookup(users_lookup) SELECT department FACET username LIMIT MAX) ON user = username SELECT *
🟡 Ensure lookup table 'users_lookup' is uploaded via the Lookups UI
```
<!-- /spl-cases -->

## `mvcombine` — Not supported

Combines multivalue field entries into a single multivalue field. NRQL does not have a multivalue field concept.

**Why this exists in Splunk:** Splunk's data model stores everything as flat text. When you use `stats values(field)` or similar commands, the result is a "multivalue field" — essentially an array packed into a single cell. `mvcombine` merges rows that differ only in one field into a single row with a multivalue field. This is Splunk working around its flat data model.

**In New Relic:** Attributes can natively store arrays and nested objects (JSON). There's no need to "combine" rows into multivalue fields — use `uniques()` or `latest()` aggregation functions to collect values, or query the structured data directly.

<!-- spl-cases: fields-mvcombine -->
```
✅ Confirmed by human
SPL:  * | mvcombine delim="," values
🔴 SPL command 'mvcombine' has no known NRQL equivalent
```
<!-- /spl-cases -->

## `mvexpand` — Partial support

Expands a multivalue field into separate events, one per value. NRQL has no row multiplication (`unnest`/`explode`), but most real-world `mvexpand` patterns achieve goals that NRQL handles differently.

**Why this matters:** `mvexpand` is the 3rd most-used unsupported command. Understanding what customers are *actually trying to do* is key to helping them migrate.

<details>
<summary>What customers actually do with <code>mvexpand</code> — and NRQL alternatives</summary>

## Pattern 1: Expand-then-filter ("is this value in the array?") — ~40% of usage

The most common pattern. Customers expand an array just to filter for a specific value.

```
SPL:  index=main sourcetype=nimbus-json level_name=ERROR
      | spath path=cloudformation{}.stack_prefix output=stack_prefix
      | mvexpand stack_prefix
      | search stack_prefix="fff000-gitlabrole"
```

**NRQL alternative:** You don't need to expand the array — just search within it:
```
FROM Log SELECT * WHERE message LIKE '%fff000-gitlabrole%'
```
Or if the field is already extracted:
```
FROM Log SELECT * WHERE `stack_prefix` LIKE '%fff000-gitlabrole%'
```
Or with `jparse()` for precise JSON access:
```
FROM Log WITH jparse(message, 'cloudformation') AS cf
SELECT * WHERE cf LIKE '%fff000-gitlabrole%'
```

Another real example — finding apps where "power" role has write access:
```
SPL:  | rest /services/apps/local | rename eai:acl.perms.* as *
      | table label title read write
      | mvexpand write | search write="power"
```
**NRQL alternative:** `WHERE write LIKE '%power%'` — no expansion needed.

## Pattern 2: Dedup round-trip (aggregate then re-expand) — ~30% of usage

Customers collapse data with `stats values()` then immediately expand it back. In NRQL, skip the round-trip entirely.

```
SPL:  | rest /services/data/inputs/http
      | stats values(title) as title
      | mvexpand title
      | join type=outer title [...]
```

**NRQL alternative:** Just query the raw data with `FACET`:
```
FROM Log SELECT count(*) FACET title
```
Or use `uniques()` to get the distinct list directly.

## Pattern 3: Symmetric counting (mvappend + mvexpand) — ~10% of usage

This is the one pattern that truly needs row multiplication. It creates new rows that didn't exist in the source data.

```
SPL:  | eval notable_asset=mvappend(notable_src, notable_dest)
      | mvexpand notable_asset
      | stats count by notable_asset tactic_name
```

One event with `src=A, dest=B` becomes two rows (one for A, one for B), then counted independently.

**NRQL workaround:** Run two queries and combine:
```
FROM Log SELECT count(*) FACET notable_src AS 'asset', tactic_name
```
```
FROM Log SELECT count(*) FACET notable_dest AS 'asset', tactic_name
```
There is no single-query NRQL equivalent.

## Pattern 4: Expand split results — ~15% of usage

After splitting a delimited string, iterate over each piece.

```
SPL:  index=main | eval perms=split(permissions, ",") | mvexpand perms | stats count by perms
```

**NRQL alternative:** If you know the maximum number of elements, use `aparse()`:
```
FROM Log WITH aparse(permissions, '*,*,*') AS (p1, p2, p3)
SELECT count(*) FACET p1, p2, p3
```
Or restructure at ingest to send one event per value.

## Pattern 5: No-op on single-value field — ~5% of usage

Sometimes `mvexpand` is applied to a field that is already single-value (defensive coding). This is a no-op in both SPL and NRQL.

</details>

**Migration advice:** Before flagging `mvexpand` as a blocker, identify which pattern the customer is using. Most (~70%) are expand-then-filter or dedup round-trips that NRQL handles without row expansion. The truly unsupported cases are symmetric counting and per-element aggregation across events.

<!-- spl-cases: unsupported-mvexpand -->
```
🤖 Confirmed by LLM
SPL:  * | spath path=cloudformation{}.stack_prefix output=stack_prefix | mvexpand stack_prefix | search stack_prefix="fff000-gitlabrole"
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
🔴 `mvexpand` is not supported; NRQL cannot expand multivalue fields into separate rows
```

```
🤖 Confirmed by LLM
SPL:  * | mvexpand list(orderNumber)
🔴 `mvexpand` is not supported; NRQL cannot expand multivalue fields into separate rows
```

```
🤖 Confirmed by LLM
SPL:  * | stats values(title) as title | mvexpand title
🔴 `mvexpand` is not supported; NRQL cannot expand multivalue fields into separate rows
```

```
🤖 Confirmed by LLM
SPL:  * | eval perms=split(permissions, ",") | mvexpand perms | stats count by perms
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 `mvexpand` is not supported; NRQL cannot expand multivalue fields into separate rows
```

```
🤖 Confirmed by LLM
SPL:  * | eval notable_asset=mvappend(notable_src, notable_dest) | mvexpand notable_asset | stats count by notable_asset
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 `eval` function mvappend() has no NRQL equivalent
🔴 `mvexpand` is not supported; NRQL cannot expand multivalue fields into separate rows
```

```
🤖 Confirmed by LLM
SPL:  index=k8s_main bopus orderType=BOPUS storeNumber=* orderNumber=* | stats list(orderNumber) AS orderNumber BY orderStatus storeNumber | mvexpand orderNumber | sort -orderNumber
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 SPL list() keeps every value including duplicates, in event order; NRQL uniques() de-duplicates and does not preserve order. Use values() if distinct values are acceptable
🔴 `mvexpand` is not supported; NRQL cannot expand multivalue fields into separate rows
```

```
🤖 Confirmed by LLM
SPL:  * | spath input=body path=Items{} output=items | mvexpand items | spath input=items path=Channels{} output=channels | mvexpand channels
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
🔴 `mvexpand` is not supported; NRQL cannot expand multivalue fields into separate rows
🔴 `cascading` mvexpand (expand-then-expand) not directly supported; use nested FROM with EXPAND at each level as a workaround
```

```
🤖 Confirmed by LLM
SPL:  * | spath input=_raw output=validation path=validations{} | mvexpand validation | spath input=_raw output=sku_data path=items{} | mvexpand sku_data
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
🔴 `mvexpand` is not supported; NRQL cannot expand multivalue fields into separate rows
🔴 `cascading` mvexpand (expand-then-expand) not directly supported; use nested FROM with EXPAND at each level as a workaround
```

```
❓ Not confirmed
SPL:  * | spath input=body path=Items{} output=items | mvexpand items | spath input=items path=Channels{} output=channels | mvexpand channels | spath input=channels path=Name output=channelName
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
🔴 `mvexpand` is not supported; NRQL cannot expand multivalue fields into separate rows
🔴 `cascading` mvexpand (expand-then-expand) not directly supported; use nested FROM with EXPAND at each level as a workaround
```
<!-- /spl-cases -->

## `rename` — Supported

Renames fields. Translates to NRQL `AS` aliases.

<!-- spl-cases: fields-rename -->
```
✅ Confirmed by human
SPL:  * | rename src_ip AS source_address
NRQL: FROM Log SELECT src_ip AS 'source_address', *
🟡 NRQL rename keeps original field names alongside aliases
```

```
✅ Confirmed by human
SPL:  * | stats avg(bytes) as avg_bytes by host | rename avg_bytes AS average_bytes
NRQL: FROM Log SELECT average(bytes) AS 'average_bytes' FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | rename _time AS "Time"
NRQL: FROM Log SELECT timestamp AS 'Time', *
🟡 NRQL rename keeps original field names alongside aliases
```

```
❓ Not confirmed
SPL:  * | rename properties.* as *
NRQL: FROM Log SELECT *
🟡 Wildcard rename (properties.* as *) dropped: no downstream field references it, so fields keep their original names.
```

```
❓ Not confirmed
SPL:  * | rename log.* as * | stats count by level
NRQL: FROM Log SELECT count(*) FACET `log.level` AS 'level'
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  * | rename log.* as * | where level="error" | stats count
NRQL: FROM Log SELECT count(*) WHERE `log.level` = 'error'
```

```
❓ Not confirmed
SPL:  * | rename log.* as * | eval flag = "high" | table flag
NRQL: FROM Log WITH 'high' AS flag SELECT flag
🟡 Wildcard rename (log.* as *) dropped: no downstream field references it, so fields keep their original names.
```

```
❓ Not confirmed
SPL:  * | rename log.* as *
NRQL: FROM Log SELECT *
🟡 Wildcard rename (log.* as *) dropped: no downstream field references it, so fields keep their original names.
```

```
✅ Confirmed by human
SPL:  * | rename src_ip as src user_name as user
NRQL: FROM Log SELECT src_ip AS 'src', user_name AS 'user', *
🟡 NRQL rename keeps original field names alongside aliases
```

```
❓ Not confirmed
SPL:  index=web | rename x AS e | stats count by e
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET x AS 'e'
🟡 NRQL rename keeps original field names alongside aliases
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | rename x AS e | where e=1 | table e
NRQL: FROM Log SELECT x AS 'e' WHERE index = 'web' AND x = '1' OR numeric(x) = 1
🟡 NRQL rename keeps original field names alongside aliases
```

```
❓ Not confirmed
SPL:  index=web | stats count by Task | rename Task AS "Detail"
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET Task AS 'Detail'
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | stats count by status | table status count | rename count as Count
NRQL: FROM Log SELECT count(*) AS 'Count' WHERE index = 'web' FACET status
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  * | where level="x" | rename log.* as * | stats count by level
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 Wildcard rename is ambiguous for "level": it is referenced both before and after the rename, so it cannot be safely attributed to the prefix. Rename the specific field instead.
```

```
❓ Not confirmed
SPL:  * | rename log.* as * | rename app.* as * | stats count by level
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 More than one wildcard rename in the pipeline; a bare field cannot be attributed to a single prefix. Rename the specific fields instead.
```

```
❓ Not confirmed
SPL:  * | rename a.*.b as * | stats count by level
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 Wildcard rename (a.*.b as *) not supported in NRQL; rename specific fields
```

```
✅ Confirmed by human
SPL:  * | rename "IsOutlier(count)" as isOutlier
🔴 Cannot rename field with parentheses in name: "IsOutlier(count)"
```
<!-- /spl-cases -->

## `replace` — Partial support

Replaces field values using wildcards or exact matches. NRQL has no in-place field value replacement command.

<details>
<summary>What customers actually do with <code>replace</code></summary>

1. **Strip units from strings for numeric comparison** — the most common pattern by far:
   ```
   SPL: | rex "Time taken: (?<execution_time>\d+\s?ms)"
        | eval numeric_time = tonumber(replace(execution_time, " ms", ""))
        | where numeric_time > 2000
   ```
   **NRQL approximation:** Use `numeric()` with `capture()` to extract just the number:
   ```
   FROM Log SELECT * WHERE numeric(capture(message, r'Time taken: (?P<ms>\d+)')) > 2000
   ```

2. **Normalize values for grouping** — e.g., strip prefixes from sourcetypes:
   ```
   SPL: | eval appName = replace(sourcetype, "kube:container:", "")
        | stats count by appName
   ```
   **NRQL approximation:** This specific pattern isn't directly translatable in a single NRQL expression. Consider adding a parsing rule at ingest to extract the clean `appName`, or use `capture()`:
   ```
   FROM Log SELECT count(*) FACET capture(sourcetype, r'kube:container:(?P<appName>.*)') AS appName
   ```

3. **Fix quoting in extracted JSON** — replace single quotes with double quotes before parsing:
   ```
   SPL: | eval json_content = replace(json_content, "'", "\"") | spath input=json_content
   ```
   **In New Relic:** Fix the JSON at the source. If logs emit malformed JSON, add a parsing rule at ingest rather than fixing it at query time.

</details>

<!-- spl-cases: fields-replace -->
```
✅ Confirmed by human
SPL:  * | replace "error" WITH "warning" IN message
NRQL: FROM Log SELECT replace(message, 'error', 'warning'), *
```

```
✅ Confirmed by human
SPL:  * | replace "kube:container:" WITH "" IN sourcetype | stats count by sourcetype
NRQL: FROM Log SELECT count(*) FACET replace(sourcetype, 'kube:container:', '')
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | replace "%%14674" WITH "Value Added", "%%14675" WITH "Value Deleted" IN OperationType
NRQL: FROM Log SELECT replace(replace(OperationType, '%%14674', 'Value Added'), '%%14675', 'Value Deleted'), *
```
<!-- /spl-cases -->

## `rex` — Supported

Extracts fields using regular expressions. Translates to NRQL `capture()` or `aparse()`.

<!-- spl-cases: fields-rex -->
```
❓ Not confirmed
SPL:  * | rex field=message "(?<ip>\d+\.\d+\.\d+\.\d+)"
NRQL: FROM Log WITH capture(message, r'(?s:.*?)(?P<ip>\d+\.\d+\.\d+\.\d+)(?s:.*)') AS (ip) SELECT *
```

```
❓ Not confirmed
SPL:  * | rex "user=(?<username>\w+)"
NRQL: FROM Log WITH capture(message, r'(?s:.*?)user=(?P<username>\w+)(?s:.*)') AS (username) SELECT *
```

```
❓ Not confirmed
SPL:  * | rex field=_raw "From: <(?<from>.*)> To: <(?<to>.*)>"
NRQL: FROM Log WITH capture(message, r'(?s:.*?)From: <(?P<from>.*)> To: <(?P<to>.*)>(?s:.*)') AS (from, to) SELECT *
```

```
❓ Not confirmed
SPL:  * | rex field=_raw ".*dlq\/(?P<dlq_key>\d+),"
NRQL: FROM Log WITH capture(message, r'.*dlq\/(?P<dlq_key>\d+),(?s:.*)') AS (dlq_key) SELECT *
```

```
❓ Not confirmed
SPL:  * | rex "status=(?<code>\d+)" | stats count by code
NRQL: FROM Log WITH capture(message, r'(?s:.*?)status=(?P<code>\d+)(?s:.*)') AS (code) SELECT count(*) FACET code
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  * | rex field=message "\"orderId\":\"(?<orderId>[A-Z0-9-]+)\""
NRQL: FROM Log WITH capture(message, r'(?s:.*?)\"orderId\":\"(?P<orderId>[A-Z0-9-]+)\"(?s:.*)') AS (orderId) SELECT *
```

```
❓ Not confirmed
SPL:  index=web | rex \"t4\"\:\"(?<T4>.+?)\"
NRQL: FROM Log WITH capture(message, r'(?s:.*?)\"t4\"\:\"(?P<T4>.+?)\"(?s:.*)') AS (T4) SELECT * WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | rex max_match=1 "a=(?<a>\d+)"
NRQL: FROM Log WITH capture(message, r'(?s:.*?)a=(?P<a>\d+)(?s:.*)') AS (a) SELECT * WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | rex "(?<timestamp>\S+)\s+(?<msg>.*)" | stats count by msg
NRQL: FROM Log WITH capture(message, r'(?s:.*?)(?P<timestamp>\S+)\s+(?P<msg>.*)(?s:.*)') AS (parsed_timestamp, msg) SELECT count(*) WHERE index = 'web' FACET msg
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web "REPORT" | rex field=message "\"message\":\"(?<message>.*?)\"" | stats count by message
NRQL: FROM Log WITH capture(message, r'(?s:.*?)\"message\":\"(?P<message>.*?)\"(?s:.*)') AS (parsed_message) SELECT count(*) WHERE index = 'web' AND message LIKE '%REPORT%' FACET parsed_message AS 'message'
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | rex "(?<m>\w+)" | rex field=uri "(?<m>\d+)" | stats count by m
NRQL: FROM Log WITH capture(message, r'(?s:.*?)(?P<m>\w+)(?s:.*)') AS (m), capture(uri, r'(?s:.*?)(?P<m>\d+)(?s:.*)') AS (parsed_m) SELECT count(*) WHERE index = 'web' FACET parsed_m AS 'm'
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | rex "a\"(?<a>[^\"]+)\"" | rex "b\"(?<b>[^\"]+)\"" | rex "c=(?<c>\d+)" | rex "d=(?<d>\d+)" | rex "e=(?<e>\d+)" | rex "f=(?<f>\d+)" | table a b c d e f
NRQL: FROM Log WITH capture(message, r'(?s:.*?)a\"(?P<a>[^\"]+)\"(?s:.*)') AS (a), aparse(message, '%b"*"%') AS (b), capture(message, r'(?s:.*?)c=(?P<c>\d+)(?s:.*)') AS (c), capture(message, r'(?s:.*?)d=(?P<d>\d+)(?s:.*)') AS (d), capture(message, r'(?s:.*?)e=(?P<e>\d+)(?s:.*)') AS (e), capture(message, r'(?s:.*?)f=(?P<f>\d+)(?s:.*)') AS (f) SELECT a, b, c, d, e, f WHERE index = 'web'
🟡 `rex` extraction(s) b translated as aparse() to stay within NRQL's 5 capture() calls; aparse matches the anchor text case-insensitively, where Splunk's rex is case-sensitive
```

```
✅ Confirmed by human
SPL:  * | rex field=message "\d+"
🔴 `rex` pattern has no named capture groups; nothing to extract
```

```
✅ Confirmed by human
SPL:  * | rex field=message "(?<skus>\d{6,})" max_match=0
🔴 `rex` max_match=0 not supported; NRQL capture() returns only the first match per event
```

```
❓ Not confirmed
SPL:  * | rex field=f1 "(?<a>\w+)" | rex field=f2 "(?<b>\w+)" | rex field=f3 "(?<c>\w+)" | rex field=f4 "(?<d>\w+)" | rex field=f5 "(?<e>\w+)" | rex field=f6 "(?<f>\w+)"
🔴 `query` uses 6 capture() extractions that cannot be rewritten as aparse() (only literal-anchored patterns can), but NRQL allows 5 capture() calls per query
```

```
❓ Not confirmed
SPL:  index=web | rex "\"cur\":\"(?<cur>[^\"]+)"\"
🔴 `rex` regex is malformed in the source query (its quoted string ends early and is followed by stray characters): "\"cur\":\"(?<cur>[^\"]+)"\"
```

```
❓ Not confirmed
SPL:  index=web | rex field=_raw "a=(?<a>\w+)" $extraFilter$
🔴 `rex` is followed by the dashboard token $extraFilter$ with no pipe; the token carries a search clause resolved only at run time, so the query cannot be translated until it is expanded
```

```
❓ Not confirmed
SPL:  index=web | rex "a=(?<a>\d+)" | rex "b=(?<b>\d+)" | rex "c=(?<c>\d+)" | rex "d=(?<d>\d+)" | rex "e=(?<e>\d+)" | rex "f=(?<f>\d+)" | table a b c d e f
🔴 `query` uses 6 capture() extractions that cannot be rewritten as aparse() (only literal-anchored patterns can), but NRQL allows 5 capture() calls per query
```
<!-- /spl-cases -->

## `rex` (sed mode) — Not supported

Uses sed-like syntax for in-line string substitution. Limited NRQL support via string functions.

<!-- spl-cases: fields-rex-sed -->
```
❓ Not confirmed
SPL:  * | rex mode=sed field=message "s/old/new/g"
NRQL: FROM Log WITH replace(message, 'old', 'new') AS parsed_message SELECT *
```

```
❓ Not confirmed
SPL:  index=web | rex field=msg mode=sed "s/a/b/g"
NRQL: FROM Log WITH replace(msg, 'a', 'b') AS parsed_msg SELECT * WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | rex field=uri mode=sed "s#/v1/booking/[A-Za-z0-9]+#/v1/booking#" | stats count by uri
NRQL: FROM Log WITH capture(uri, r'^(?P<sed1_pre>(?s:.*?))(?P<sed1_m>/v1/booking/[A-Za-z0-9]+)(?P<sed1_post>(?s:.*))$') AS (sed1_pre, sed1_m, sed1_post), if(sed1_m IS NULL, uri, concat(sed1_pre, '/v1/booking', sed1_post)) AS parsed_uri SELECT count(*) WHERE index = 'web' FACET parsed_uri AS 'uri'
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | rex field=host mode=sed "s/^(.+api-)(\w+)(-[\w-]+)$/\2/" | stats count by host
NRQL: FROM Log WITH capture(host, r'^(?P<sed1_m>(?P<sed1_g1>.+api-)(?P<sed1_g2>\w+)(?P<sed1_g3>-[\w-]+))$') AS (sed1_m, sed1_g1, sed1_g2, sed1_g3), if(sed1_m IS NULL, host, sed1_g2) AS parsed_host SELECT count(*) WHERE index = 'web' FACET parsed_host AS 'host'
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | rex field=uri mode=sed "s#/v1/booking/[A-Za-z0-9]+#/v1/booking#g" | stats count by uri
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 `rex` mode=sed on uri (sed script 's#/v1/booking/[A-Za-z0-9]+#/v1/booking#g') cannot be translated exactly: the substitution is global and the pattern can match more than once; capture() rebuilds only the first match. NRQL replace() is literal-only; capture() can rebuild one anchored or non-global substitution
```

```
❓ Not confirmed
SPL:  index=web | rex field=m mode=sed "s/a/[&]/" | table m
🔴 `rex` mode=sed on m (sed script 's/a/[&]/') cannot be translated exactly: & (the whole match) in the replacement. NRQL replace() is literal-only; capture() can rebuild one anchored or non-global substitution
```
<!-- /spl-cases -->

## `rex` (PCRE-only features) — Partial support

PCRE features like lookaheads/lookbehinds and backreferences. NRQL's RE2 regex engine does not support these.

<!-- spl-cases: fields-rex-pcre -->
```
❓ Not confirmed
SPL:  * | rex field=message "(?<=prefix)(?<val>\w+)"
NRQL: FROM Log WITH capture(message, r'(?s:.*?)(?:prefix)(?P<val>\w+)(?s:.*)') AS (val) SELECT *
```

```
❓ Not confirmed
SPL:  * | rex field=x "user=(?<user_id>\w+)"
NRQL: FROM Log WITH capture(x, r'(?s:.*?)user=(?P<user_id>\w+)(?s:.*)') AS (user_id) SELECT *
```

```
❓ Not confirmed
SPL:  * | rex field=x "(?<a>\w+) (?<b>\w+)"
NRQL: FROM Log WITH capture(x, r'(?s:.*?)(?P<a>\w+) (?P<b>\w+)(?s:.*)') AS (a, b) SELECT *
```

```
❓ Not confirmed
SPL:  * | rex field=x "(?i:foo)(?<a>\w+)"
NRQL: FROM Log WITH capture(x, r'(?s:.*?)(?i:foo)(?P<a>\w+)(?s:.*)') AS (a) SELECT *
```

```
❓ Not confirmed
SPL:  index=web | rex "(?<=orderId=)(?<oid>\d+)" | stats count by oid
NRQL: FROM Log WITH capture(message, r'(?s:.*?)(?:orderId=)(?P<oid>\d+)(?s:.*)') AS (oid) SELECT count(*) WHERE index = 'web' FACET oid
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | rex "(?<code>\d+)(?=\s*; Interface code)" | stats count by code
NRQL: FROM Log WITH capture(message, r'(?s:.*?)(?P<code>\d+)(?:\s*; Interface code)(?s:.*)') AS (code) SELECT count(*) WHERE index = 'web' FACET code
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  * | rex field=message "(?<!prefix)(?<val>\w+)"
🔴 `rex` pattern uses lookahead/lookbehind assertions which NRQL capture() does not support; rewrite the regex without lookaround
```

```
❓ Not confirmed
SPL:  * | rex field=x "(?<a>\w+)=\1"
🔴 `rex` pattern uses a backreference (\1, \k<name>, or (?P=name)), which NRQL capture() does not support; rewrite the regex without backreferences
```

```
❓ Not confirmed
SPL:  * | rex field=x "x[\1]y(?<a>\w+)"
🔴 `rex` pattern uses a backreference (\1, \k<name>, or (?P=name)), which NRQL capture() does not support; rewrite the regex without backreferences
```

```
❓ Not confirmed
SPL:  * | rex field=x "(?>(?<a>\w+))"
🔴 `rex` pattern uses an atomic group (?>...), which NRQL capture() (RE2) does not support; rewrite the regex without atomic groups
```

```
❓ Not confirmed
SPL:  * | rex field=x "(?<a>\w++)"
🔴 `rex` pattern uses a possessive quantifier (*+, ++, ?+, {n,m}+), which NRQL capture() (RE2) does not support; use a greedy quantifier instead
```

```
❓ Not confirmed
SPL:  * | rex field=x "(?<a>\w+)(?1)"
🔴 `rex` pattern uses recursion or a subroutine reference ((?R), (?1), \g<name>), which NRQL capture() (RE2) does not support
```

```
❓ Not confirmed
SPL:  * | rex field=x "(?(1)yes|no)(?<a>\w+)"
🔴 `rex` pattern uses a conditional ((?(1)...)), which NRQL capture() (RE2) does not support
```

```
❓ Not confirmed
SPL:  * | rex field=x "(?<a>a{3,1})"
🔴 `rex` pattern is not compatible with NRQL capture() (RE2): error parsing regexp: invalid repeat count: `{3,1}`; rewrite the regex without the unsupported construct
```

```
❓ Not confirmed
SPL:  index=web | rex "a(?=b)(?<a>\d+)" | stats count by a
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 `rex` pattern uses lookahead/lookbehind assertions which NRQL capture() does not support; rewrite the regex without lookaround
```
<!-- /spl-cases -->

## `search` (pipe) — Supported

Filters results with search criteria (same as implicit search). Translates to additional NRQL `WHERE` conditions.

<!-- spl-cases: results-search -->
```
✅ Confirmed by human
SPL:  index=web | stats count by status | search status=200
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND status = '200' OR numeric(status) = 200 FACET status
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  status=500 | search error
NRQL: FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND message LIKE '%error%'
```

```
✅ Confirmed by human
SPL:  * | search status=200 OR status=301
NRQL: FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 OR status = '301' OR numeric(status) = 301
```

```
✅ Confirmed by human
SPL:  | search host=web01
NRQL: FROM Log SELECT * WHERE host = 'web01'
```

```
❓ Not confirmed
SPL:  index=web | stats count as c by a | search c=5
NRQL: FROM (FROM Log SELECT count(*) AS 'c' WHERE index = 'web' FACET a LIMIT MAX) SELECT * WHERE c = '5' OR numeric(c) = 5
```

```
❓ Not confirmed
SPL:  index=web | stats count as c by a | search a=x
NRQL: FROM Log SELECT count(*) AS 'c' WHERE index = 'web' AND a = 'x' FACET a
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```
<!-- /spl-cases -->

## `spath` — Partial support

Extracts fields from structured data (JSON, XML). Translates to NRQL `jparse()` for JSON paths.

<!-- spl-cases: fields-spath -->
```
✅ Confirmed by human
SPL:  * | spath input=payload path=user.name output=username
NRQL: FROM Log WITH jparse(payload, 'user.name') AS username SELECT *
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
✅ Confirmed by human
SPL:  * | spath path=response.status
NRQL: FROM Log WITH jparse(message, 'response.status') AS status SELECT *
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
✅ Confirmed by human
SPL:  * | spath input=_raw path=data.id output=id
NRQL: FROM Log WITH jparse(message, 'data.id') AS id SELECT *
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
❓ Not confirmed
SPL:  * | spath | stats count by status
NRQL: FROM Log WITH jparse(message, 'status') AS status SELECT count(*) FACET status
🟡 `spath` without path= auto-extracts all fields; rewrote downstream reference(s) status as jparse(<source>, '<field>') — confirm each is a JSON property of the source
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  * | spath input=payload | where code="500" | stats count
NRQL: FROM Log WITH jparse(payload, 'code') AS code SELECT count(*) WHERE code = '500' OR numeric(code) = 500
🟡 `spath` without path= auto-extracts all fields; rewrote downstream reference(s) code as jparse(<source>, '<field>') — confirm each is a JSON property of the source
```

```
✅ Confirmed by human
SPL:  * | spath path=response.code output=code | stats count by code
NRQL: FROM Log WITH jparse(message, 'response.code') AS code SELECT count(*) FACET code
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | spath path=user.name output=name | spath path=user.email output=email
NRQL: FROM Log WITH jparse(message, 'user.name') AS name, jparse(message, 'user.email') AS email SELECT *
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
❓ Not confirmed
SPL:  * | spath path=request.url output=url | rex field=url "(?<domain>[^/]+)"
NRQL: FROM Log WITH jparse(message, 'request.url') AS url, capture(url, r'(?s:.*?)(?P<domain>[^/]+)(?s:.*)') AS (domain) SELECT *
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
✅ Confirmed by human
SPL:  * | spath "AppID"
NRQL: FROM Log WITH jparse(message, 'AppID') AS AppID SELECT *
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
✅ Confirmed by human
SPL:  * | spath source_name
NRQL: FROM Log WITH jparse(message, 'source_name') AS source_name SELECT *
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
✅ Confirmed by human
SPL:  * | spath path=errors{}.code output=error_code | search error_code=404
NRQL: FROM Log WITH jparse(message, 'errors[*].code') AS error_code SELECT * WHERE error_code = '404' OR numeric(error_code) = 404
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
✅ Confirmed by human
SPL:  * | spath path=items{}.status
NRQL: FROM Log WITH jparse(message, 'items[*].status') AS status SELECT *
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
✅ Confirmed by human
SPL:  * | spath input=request_body path=user.preferences{}.key output=pref_key
NRQL: FROM Log WITH jparse(request_body, 'user.preferences[*].key') AS pref_key SELECT *
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
✅ Confirmed by human
SPL:  * | eval user_id = json_extract(payload, "$.user.id")
NRQL: FROM Log WITH jparse(payload, 'user.id') AS user_id SELECT *
```

```
❓ Not confirmed
SPL:  index=web | spath input=j | search tenant="x" | stats count
NRQL: FROM Log WITH jparse(j, 'tenant') AS tenant SELECT count(*) WHERE index = 'web' AND tenant = 'x'
🟡 `spath` without path= auto-extracts all fields; rewrote downstream reference(s) tenant as jparse(<source>, '<field>') — confirm each is a JSON property of the source
```

```
❓ Not confirmed
SPL:  index=web | spath input=j | eval z=tenant | stats count by z
NRQL: FROM Log WITH jparse(j, 'tenant') AS tenant, tenant AS z SELECT count(*) WHERE index = 'web' FACET z
🟡 `spath` without path= auto-extracts all fields; rewrote downstream reference(s) tenant as jparse(<source>, '<field>') — confirm each is a JSON property of the source
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | spath input=j | table tenant region
NRQL: FROM Log WITH jparse(j, 'tenant') AS tenant, jparse(j, 'region') AS region SELECT tenant, region WHERE index = 'web'
🟡 `spath` without path= auto-extracts all fields; rewrote downstream reference(s) tenant, region as jparse(<source>, '<field>') — confirm each is a JSON property of the source
```

```
❓ Not confirmed
SPL:  index=web | spath input=j | where tenant="x" | top limit=2 "a{}.c"
NRQL: FROM Log WITH jparse(j, 'tenant') AS tenant, jparse(j, 'a[*].c') AS `a{}.c` SELECT count(*), count(*) * 100.0 / (FROM Log WITH jparse(j, 'tenant') AS tenant, jparse(j, 'a[*].c') AS `a{}.c` SELECT count(*) WHERE index = 'web' AND tenant = 'x') AS 'percent' WHERE index = 'web' AND tenant = 'x' FACET `a{}.c` ORDER BY count DESC LIMIT 2
🟡 `spath` without path= auto-extracts all fields; rewrote downstream reference(s) tenant, a{}.c as jparse(<source>, '<field>') — confirm each is a JSON property of the source
```

```
❓ Not confirmed
SPL:  index=web | spath input=j | where tenant="x" | stats sum(bytes) by host
NRQL: FROM Log WITH jparse(j, 'tenant') AS tenant, jparse(j, 'bytes') AS bytes SELECT sum(bytes) WHERE index = 'web' AND tenant = 'x' FACET host
🟡 `spath` without path= auto-extracts all fields; rewrote downstream reference(s) tenant, bytes as jparse(<source>, '<field>') — confirm each is a JSON property of the source
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | spath input=r path=body."Some Name{}" output=s
NRQL: FROM Log WITH jparse(r, '["body"]["Some Name"][*]') AS s SELECT * WHERE index = 'web'
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
❓ Not confirmed
SPL:  index=web | spath "meta.responseTime" output=responseTime
NRQL: FROM Log WITH jparse(message, 'meta.responseTime') AS responseTime SELECT * WHERE index = 'web'
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
❓ Not confirmed
SPL:  index=web | spath input=json orderRef output=orderRef
NRQL: FROM Log WITH jparse(json, 'orderRef') AS orderRef SELECT * WHERE index = 'web'
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
❓ Not confirmed
SPL:  index=web | spath input=j path=csp-report.blocked-uri output=u | table u
NRQL: FROM Log WITH jparse(j, '["csp-report"]["blocked-uri"]') AS u SELECT u WHERE index = 'web'
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
❓ Not confirmed
SPL:  index=web | spath input=j path=x-region{}.a-b.c output=v | table v
NRQL: FROM Log WITH jparse(j, '["x-region"][*]["a-b"]["c"]') AS v SELECT v WHERE index = 'web'
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
❓ Not confirmed
SPL:  index=web | spath input=j path=reservations{}.system output=s | table s
NRQL: FROM Log WITH jparse(j, 'reservations[*].system') AS s SELECT s WHERE index = 'web'
🟡 `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
```

```
✅ Confirmed by human
SPL:  * | spath
🔴 `spath` without path= does auto-extraction, which has no NRQL equivalent; specify path= to extract a specific JSON field
```

```
❓ Not confirmed
SPL:  * | spath | table *
🔴 `spath` without path= does auto-extraction, which has no NRQL equivalent; specify path= to extract a specific JSON field
```

```
✅ Confirmed by human
SPL:  * | spath input=payload
🔴 `spath` without path= does auto-extraction, which has no NRQL equivalent; specify path= to extract a specific JSON field
```
<!-- /spl-cases -->

## `stats` — Supported

Computes aggregate statistics over events. Translates to NRQL `SELECT aggregate(...) FACET ...`.

<!-- spl-cases: reports-stats -->
```
✅ Confirmed by human
SPL:  index=web | stats count by status
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET status
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats avg(response_time) as avg_response_time by host
NRQL: FROM Log SELECT average(response_time) AS 'avg_response_time' FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  index=web | stats count, dc(clientip) AS unique_clients BY status
NRQL: FROM Log SELECT count(*), uniqueCount(clientip) AS 'unique_clients' WHERE index = 'web' FACET status
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats count min(_time) as firstTime max(_time) as lastTime BY user dest
NRQL: FROM Log SELECT count(*), min(timestamp) AS 'firstTime', max(timestamp) AS 'lastTime' FACET user, dest
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats count(status) by host
NRQL: FROM Log SELECT count(status) FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats count as "totalFailure"
NRQL: FROM Log SELECT count(*) AS 'totalFailure'
```

```
✅ Confirmed by human
SPL:  * | stats count as 'my count'
NRQL: FROM Log SELECT count(*) AS 'my count'
```

```
✅ Confirmed by human
SPL:  * | stats count(eval(status>=400)) as errors
NRQL: FROM Log SELECT filter(count(*), WHERE numeric(status) >= 400) AS 'errors'
```

```
✅ Confirmed by human
SPL:  * | stats count(eval(EventCode=4648)) as attempts, count(eval(EventCode=4624)) as successes
NRQL: FROM Log SELECT filter(count(*), WHERE EventCode = '4648' OR numeric(EventCode) = 4648) AS 'attempts', filter(count(*), WHERE EventCode = '4624' OR numeric(EventCode) = 4624) AS 'successes'
```

```
🤖 Confirmed by LLM
SPL:  * | stats count by host
NRQL: FROM Log SELECT count(*) FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  * | stats count by validations{}.code
NRQL: FROM Log SELECT count(*) FACET `validations{}.code`
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  * | stats list(eventType) by orderId
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 SPL list() keeps every value including duplicates, in event order; NRQL uniques() de-duplicates and does not preserve order. Use values() if distinct values are acceptable
```
<!-- /spl-cases -->

## Multiple chained aggregations

When multiple `| stats` commands are chained, the first aggregation is wrapped as a subquery and the second aggregation operates on its output.

<!-- spl-cases: reports-chained-agg -->
_No test cases for this section._
<!-- /spl-cases -->

<!-- spl-cases: reports-chained-agg-no-outer-facet -->
```
✅ Confirmed by human
SPL:  * | stats count by host | stats avg(count)
NRQL: FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT average(count)
```
<!-- /spl-cases -->

<!-- spl-cases: reports-chained-agg-aliased -->
```
✅ Confirmed by human
SPL:  index=web | stats count as cnt by host | stats max(cnt)
NRQL: FROM (FROM Log SELECT count(*) AS 'cnt' WHERE index = 'web' FACET host LIMIT MAX) SELECT max(cnt)
```
<!-- /spl-cases -->

## `streamstats` — Not supported

Computes running statistics over events in stream order. Like `eventstats`, NRQL cannot add per-row running calculations. NRQL aggregation always collapses the result set.

<details>
<summary>What customers actually do with <code>streamstats</code></summary>

`streamstats` adds running calculations (cumulative sums, previous-row values, running counts) to each event in order. Real-world patterns:

1. **Gap detection** — find days with no events by comparing each row's timestamp to the previous row:
   ```
   SPL: index=k8s_main pod="wmi-harvester*"
        | timechart span=1d count
        | where count=0
        | streamstats current=f last(_time) as prev_time
        | eval gap_days = (_time - prev_time) / 86400
        | where gap_days >= 2
   ```
   **NRQL approximation:** Use `TIMESERIES` and look for zero-count buckets in the visualization. For alerting on gaps, use a NRQL alert condition with `count(*) = 0`.

2. **Running totals** — cumulative sum for tracking progress toward a goal:
   ```
   SPL: index=nui eventTag="place-order-success"
        | sort +_time
        | streamstats sum(orderInfo.total) as order_total
   ```
   **NRQL approximation:** NRQL has no cumulative sum. For goal tracking, use `SELECT sum(total)` over the full time range, or use a dashboard with a threshold line.

3. **Consecutive event counting with reset** — count consecutive minutes above a threshold, reset when it drops:
   ```
   SPL: | streamstats reset_after=total_errors<10 c as running_count
        | stats latest(running_count) as last_count
        | search last_count > 29
   ```
   **NRQL approximation:** This stateful pattern has no NRQL equivalent. Use a NRQL alert condition with a sliding window instead:
   ```
   FROM Log SELECT count(*) WHERE ... TIMESERIES 1 minute
   ```
   Then set the alert to trigger when the condition holds for 30+ consecutive minutes.

</details>

<!-- spl-cases: reports-streamstats -->
```
✅ Confirmed by human
SPL:  * | streamstats count by host
🔴 `streamstats` has no NRQL equivalent; NRQL does not support row-to-row references (LAG/LEAD) or running aggregations
```

```
🤖 Confirmed by LLM
SPL:  * | streamstats count as row_num
🔴 `streamstats` has no NRQL equivalent; NRQL does not support row-to-row references (LAG/LEAD) or running aggregations
```
<!-- /spl-cases -->

## `strcat` — Supported

Concatenates string values. Translates to NRQL `concat()` in a WITH clause.

<!-- spl-cases: fields-strcat -->
```
✅ Confirmed by human
SPL:  * | strcat host ":" port address
NRQL: FROM Log WITH concat(host, ':', port) AS address SELECT *
```

```
✅ Confirmed by human
SPL:  * | strcat first_name last_name full_name
NRQL: FROM Log WITH concat(first_name, last_name) AS full_name SELECT *
```

```
✅ Confirmed by human
SPL:  * | strcat protocol "://" host ":" port url
NRQL: FROM Log WITH concat(protocol, '://', host, ':', port) AS url SELECT *
```

```
✅ Confirmed by human
SPL:  * | strcat host ":" port address | stats count by address
NRQL: FROM Log WITH concat(host, ':', port) AS address SELECT count(*) FACET address
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```
<!-- /spl-cases -->

## `table` — Supported

Formats results as a table with the specified columns. Translates identically to `fields` — both produce `SELECT field1, field2, ...` in NRQL.

See [Fields > `table` / `fields`](#table--fields--partial-support) — `table` and `fields` are functionally equivalent in NRQL translation.

## `timechart` — Supported

Creates time series charts by bucketing events into time intervals. Translates to NRQL `SELECT ... TIMESERIES span`.

<!-- spl-cases: reports-timechart -->
```
✅ Confirmed by human
SPL:  * | timechart count
NRQL: FROM Log SELECT count(*) TIMESERIES AUTO
```

```
✅ Confirmed by human
SPL:  sourcetype=access_* | timechart span=1h count by status
NRQL: FROM Log SELECT count(*) WHERE sourcetype LIKE 'access_%' FACET status TIMESERIES 1 hour
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | timechart span=5m count BY host
NRQL: FROM Log SELECT count(*) FACET host TIMESERIES 5 minutes
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | timechart span=1d sum(price) by productName
NRQL: FROM Log SELECT sum(price) FACET productName TIMESERIES 1 day
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | timechart count span=5m
NRQL: FROM Log SELECT count(*) TIMESERIES 5 minutes
```

```
✅ Confirmed by human
SPL:  * | timechart count(POS) span=5m as "TPOS"
NRQL: FROM Log SELECT count(POS) AS 'TPOS' TIMESERIES 5 minutes
```

```
✅ Confirmed by human
SPL:  * | timechart c span=1m
NRQL: FROM Log SELECT count(*) TIMESERIES 1 minute
```

```
✅ Confirmed by human
SPL:  * | timechart span=30m count | predict count as predict_count
NRQL: FROM Log SELECT count(*) TIMESERIES 30 minutes PREDICT
```

```
✅ Confirmed by human
SPL:  * | stats count | predict count
NRQL: FROM Log SELECT count(*) TIMESERIES AUTO PREDICT
🟡 PREDICT requires TIMESERIES; added TIMESERIES AUTO automatically
```

```
❓ Not confirmed
SPL:  * | timechart span=1m count | stats count by _time
NRQL: FROM (FROM Log SELECT count(*) TIMESERIES 1 minute) SELECT count(*) FACET _time
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  * | timechart span=5m count | stats sum(count)
NRQL: FROM (FROM Log SELECT count(*) TIMESERIES 5 minutes) SELECT sum(count)
```

```
❓ Not confirmed
SPL:  * | timechart count by host | stats avg(count) as a
NRQL: FROM (FROM Log SELECT count(*) FACET host LIMIT MAX TIMESERIES AUTO) SELECT average(count) AS 'a'
```

```
❓ Not confirmed
SPL:  * | bin _time span=1h | stats count by _time | stats avg(count)
NRQL: FROM (FROM Log SELECT count(*) TIMESERIES 1 hour) SELECT average(count)
```

```
❓ Not confirmed
SPL:  * | dedup userId | timechart count span=1m
NRQL: FROM Log SELECT uniqueCount(userId) AS 'count' TIMESERIES 1 minute
🟡 `dedup` userId followed by count translated to uniqueCount(userId) (no nesting, no 5,000-key cap). Differences: uniqueCount is approximate at high cardinality; a userId value seen in several groups or time buckets counts once in each (dedup keeps one row); a filter after dedup tests every event with that value, not only the one dedup kept. Exact when duplicate events are copies of one event
```

```
❓ Not confirmed
SPL:  * | dedup userId routeName | timechart count span=1m
NRQL: FROM (FROM Log SELECT latest(timestamp) FACET userId, routeName LIMIT MAX) SELECT count(*) LIMIT MAX TIMESERIES 1 minute
🟡 `dedup` translated to FACET; add latest(field) for each field you want to keep
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
🟡 `dedup` with timechart: TIMESERIES on a nested subquery only populates the first time bucket; remaining buckets return null. Consider using uniqueCount() per time bucket instead of nested dedup.
```

```
❓ Not confirmed
SPL:  index=web | timechart span=d count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' TIMESERIES 1 day
```

```
❓ Not confirmed
SPL:  index=web | timechart span=1mon count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' TIMESERIES 1 month
```

```
❓ Not confirmed
SPL:  index=web | timechart span=1q count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' TIMESERIES 3 months
```

```
❓ Not confirmed
SPL:  index=web | timechart eval(round(avg(dur), 2)) as avgDur by endpoint
NRQL: FROM Log SELECT round(average(dur), 0.01) AS 'avgDur' WHERE index = 'web' FACET endpoint TIMESERIES AUTO
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | timechart span=90ms count
🔴 Span=90ms is not a time span NRQL TIMESERIES can express (use s, m, h, d, w, mon, q, or y units)
```
<!-- /spl-cases -->

## `timewrap` — Not supported

Overlays time series data from different time periods. NRQL has no time-wrapping. Use `COMPARE WITH` to compare the current time range against a prior period.

<!-- spl-cases: reports-timewrap -->
```
✅ Confirmed by human
SPL:  * | timechart count | timewrap 1d
🔴 SPL command 'timewrap' has no known NRQL equivalent
```
<!-- /spl-cases -->

## `top` — Supported

Shows the most common values of a field. Translates to NRQL `SELECT count(*) FACET field LIMIT N`. Supports `limit=N` (keyword form), `countfield=X` (rename count column), `showperc=false` (suppress percent column), and `useother=true` (warned as unsupported). `limit=0` maps to `LIMIT MAX` (capped at 5,000 results).

> **Note:** SPL `top` also outputs a `percent` column. The NRQL translation approximates this with a scalar subquery (`count(*) * 100.0 / (SELECT count(*) FROM Log)`), but the result may differ from SPL's built-in percentage in edge cases (e.g., when combined with WHERE clauses or groupBy).

<!-- spl-cases: reports-top -->
```
✅ Confirmed by human
SPL:  * | top categoryId
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET categoryId ORDER BY count DESC LIMIT 10
```

```
✅ Confirmed by human
SPL:  * | top 20 host
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET host ORDER BY count DESC LIMIT 20
```

```
✅ Confirmed by human
SPL:  * | top limit=20 host
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET host ORDER BY count DESC LIMIT 20
```

```
✅ Confirmed by human
SPL:  * | top limit=0 status
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET status ORDER BY count DESC LIMIT MAX
```

```
✅ Confirmed by human
SPL:  * | top limit=5 countfield=total host
NRQL: FROM Log SELECT count(*) AS 'total', count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET host ORDER BY count DESC LIMIT 5
```

```
✅ Confirmed by human
SPL:  * | top 10 showperc=false host
NRQL: FROM Log SELECT count(*) FACET host ORDER BY count DESC LIMIT 10
```

```
✅ Confirmed by human
SPL:  * | top 5 useother=true status
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET status ORDER BY count DESC LIMIT 5
🟡 `useother`: NRQL pie chart automatically shows an "Other" category for values outside LIMIT
```

```
✅ Confirmed by human
SPL:  * | top 5 percentfield=pct host
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'pct' FACET host ORDER BY count DESC LIMIT 5
```

```
✅ Confirmed by human
SPL:  * | top delay limit=10
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET delay ORDER BY count DESC LIMIT 10
```

```
✅ Confirmed by human
SPL:  error | top 5 status
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*) WHERE message LIKE '%error%') AS 'percent' WHERE message LIKE '%error%' FACET status ORDER BY count DESC LIMIT 5
```

```
❓ Not confirmed
SPL:  index=web | top limit=2 "a{}.b"
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*) WHERE index = 'web') AS 'percent' WHERE index = 'web' FACET `a{}.b` ORDER BY count DESC LIMIT 2
```

```
❓ Not confirmed
SPL:  index=web | top limit=2 "Full Name"
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*) WHERE index = 'web') AS 'percent' WHERE index = 'web' FACET `Full Name` ORDER BY count DESC LIMIT 2
```
<!-- /spl-cases -->

## `top` with `groupby` — Partial support

Top values per group. SPL `top 5 status by host` returns the top 5 statuses **per host** (partitioned top-N). NRQL has no windowing/ranking functions, so this is approximated as a global `FACET status, host` which returns the top 5 (status, host) pairs overall — different semantics.

<!-- spl-cases: reports-top-groupby -->
```
✅ Confirmed by human
SPL:  * | top 5 status by host
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET status, host ORDER BY count DESC LIMIT 5
🟡 `top` with groupBy: NRQL FACET groups all fields together; SPL groups within each by-field value
```
<!-- /spl-cases -->

## `transaction` — Not supported

Groups events into transactions based on shared fields and time constraints. NRQL has no session/transaction grouping primitive — there's no way to group arbitrary events into sequences within a single query.

<details>
<summary>What customers actually do with <code>transaction</code></summary>

Splunk's `transaction` groups a sequence of events that share a field value (like an order ID or session ID) into a single "transaction" row with combined fields and a computed duration. Real-world patterns:

1. **Group by ID and compute duration** — e.g., track an order through multiple processing stages:
   ```
   SPL: index=sample | transaction fields=qid | timechart avg(duration)
   ```
   **NRQL approximation:** Use `FACET` with min/max timestamps:
   ```
   FROM Log SELECT max(timestamp) - min(timestamp) AS 'duration' FACET qid
   ```
   Or for the average across all transactions:
   ```
   FROM (FROM Log SELECT max(timestamp) - min(timestamp) AS duration FACET qid)
   SELECT average(duration)
   ```

2. **Group related events to see all fields together** — e.g., see all fields from an order's lifecycle:
   ```
   SPL: index=k8s_main name="inventory*" | transaction id | table id itemId msg
   ```
   **NRQL approximation:** Use `FACET` to group and `uniques()` to collect values:
   ```
   FROM Log WHERE name LIKE 'inventory%'
   SELECT uniques(itemId), uniques(msg) FACET id
   ```

3. **Session boundaries with `startswith`/`endswith`** — these define where a transaction begins and ends. NRQL has no equivalent; consider using distributed tracing spans instead, where each span naturally captures start/end times and parent-child relationships.

</details>

<!-- spl-cases: correlation-transaction -->
```
❓ Not confirmed
SPL:  * | transaction clientip maxspan=10m
🔴 SPL 'transaction' groups loglines into per-key sessions and the 'maxspan' arg splits them on a time gap/boundary; NRQL has no sessionization primitive (FACET groups globally, TIMESERIES buckets by wall-clock), so it has no equivalent
```

```
❓ Not confirmed
SPL:  * | transaction user_id
🔴 SPL 'transaction' groups loglines into per-key sessions; NRQL has no sessionization primitive, and even bare 'transaction' is not a plain FACET (Splunk's maxevents=1000 splits high-cardinality keys and connected=true groups by stream connectivity), so it has no equivalent
```

```
❓ Not confirmed
SPL:  * | transaction
🔴 SPL 'transaction' groups loglines into per-key sessions; NRQL has no sessionization primitive, and even bare 'transaction' is not a plain FACET (Splunk's maxevents=1000 splits high-cardinality keys and connected=true groups by stream connectivity), so it has no equivalent
```

```
❓ Not confirmed
SPL:  * | transaction user_id startswith="login" endswith="logout"
🔴 SPL 'transaction' groups loglines into per-key sessions and the 'startswith' arg splits them on a time gap/boundary; NRQL has no sessionization primitive (FACET groups globally, TIMESERIES buckets by wall-clock), so it has no equivalent
```
<!-- /spl-cases -->

## `where` — Supported

Filters results using boolean expressions. Supports comparison operators, `isnull()`, `isnotnull()`, `like()`, `match()`, `cidrmatch()`, and `isint()`.

<!-- spl-cases: results-where -->
```
✅ Confirmed by human
SPL:  * | where isint(orderId)
NRQL: FROM Log SELECT * WHERE numeric(orderId) IS NOT NULL
```

```
✅ Confirmed by human
SPL:  * | where name like "test%"
NRQL: FROM Log SELECT * WHERE name LIKE 'test%'
```

```
✅ Confirmed by human
SPL:  index=web | stats count BY status | where count > 100
NRQL: FROM (FROM Log SELECT count(*) WHERE index = 'web' FACET status LIMIT MAX) SELECT * WHERE numeric(count) > 100
```

```
✅ Confirmed by human
SPL:  status=500 | where bytes > 1024
NRQL: FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND numeric(bytes) > 1024
```

```
✅ Confirmed by human
SPL:  * | where isnull(status)
NRQL: FROM Log SELECT * WHERE status IS NULL
```

```
✅ Confirmed by human
SPL:  * | where isnotnull(status)
NRQL: FROM Log SELECT * WHERE status IS NOT NULL
```

```
✅ Confirmed by human
SPL:  * | where host = "web01"
NRQL: FROM Log SELECT * WHERE host = 'web01'
```

```
✅ Confirmed by human
SPL:  * | where count > 100
NRQL: FROM Log SELECT * WHERE numeric(count) > 100
```

```
✅ Confirmed by human
SPL:  * | where like(host, "web*")
NRQL: FROM Log SELECT * WHERE host LIKE 'web%'
```

```
✅ Confirmed by human
SPL:  * | where name like "%test%"
NRQL: FROM Log SELECT * WHERE name LIKE '%test%'
```

```
🤖 Confirmed by LLM
SPL:  * | where like(message, "%error%")
NRQL: FROM Log SELECT * WHERE message LIKE '%error%'
```

```
🤖 Confirmed by LLM
SPL:  * | where NOT like(message, "%debug%")
NRQL: FROM Log SELECT * WHERE message NOT LIKE '%debug%'
```

```
🤖 Confirmed by LLM
SPL:  * | where like(message, "%timeout%") AND status=500
NRQL: FROM Log SELECT * WHERE message LIKE '%timeout%' AND status = '500' OR numeric(status) = 500
```

```
🤖 Confirmed by LLM
SPL:  * | where NOT like(message, "%debug%") AND status=200
NRQL: FROM Log SELECT * WHERE message NOT LIKE '%debug%' AND status = '200' OR numeric(status) = 200
```

```
✅ Confirmed by human
SPL:  * | where match(host, "^web[0-9]+$")
NRQL: FROM Log SELECT * WHERE host RLIKE r'^web[0-9]+$'
```

```
✅ Confirmed by human
SPL:  * | where cidrmatch("10.0.0.0/8", src_ip)
NRQL: FROM Log SELECT * WHERE cidrAddress(src_ip, 8) = '10.0.0.0/8'
```

```
✅ Confirmed by human
SPL:  * | where status >= 400 AND status < 500
NRQL: FROM Log SELECT * WHERE numeric(status) >= 400 AND numeric(status) < 500
```

```
✅ Confirmed by human
SPL:  * | where NOT status = 200
NRQL: FROM Log SELECT * WHERE NOT (status = '200' OR numeric(status) = 200)
```

```
❓ Not confirmed
SPL:  index=web | where "$region$"="*" OR region="$region$"
NRQL: FROM Log SELECT * WHERE index = 'web' AND region = {{region}}
🟡 `where` "$region$"="*" (the dashboard "all values" guard) was dropped: New Relic substitutes {{region}} directly into the field comparison, so a literal * would match nothing. To offer "all values", enable the New Relic variable's multi-value / include-all option instead of a * choice.
```

```
❓ Not confirmed
SPL:  index=web | where region="$region$" OR "$region$"="*"
NRQL: FROM Log SELECT * WHERE index = 'web' AND region = {{region}}
🟡 `where` "$region$"="*" (the dashboard "all values" guard) was dropped: New Relic substitutes {{region}} directly into the field comparison, so a literal * would match nothing. To offer "all values", enable the New Relic variable's multi-value / include-all option instead of a * choice.
```

```
❓ Not confirmed
SPL:  index=web | where "$region$"!="*" AND region="$region$"
NRQL: FROM Log SELECT * WHERE index = 'web' AND region = {{region}}
🟡 `where` "$region$"="*" (the dashboard "all values" guard) was dropped: New Relic substitutes {{region}} directly into the field comparison, so a literal * would match nothing. To offer "all values", enable the New Relic variable's multi-value / include-all option instead of a * choice.
```

```
❓ Not confirmed
SPL:  index=web | where "a"="a"
NRQL: FROM Log SELECT * WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | where 1=1
NRQL: FROM Log SELECT * WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | where "a"="b" OR region="x"
NRQL: FROM Log SELECT * WHERE index = 'web' AND region = 'x'
```

```
❓ Not confirmed
SPL:  index=web | where NOT "a"="b"
NRQL: FROM Log SELECT * WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | where like (src,"%x%")
NRQL: FROM Log SELECT * WHERE index = 'web' AND src LIKE '%x%'
```

```
❓ Not confirmed
SPL:  index=web | where searchmatch("foo")
NRQL: FROM Log SELECT * WHERE index = 'web' AND message LIKE '%foo%'
🟡 `searchmatch()` translated as a search on the message attribute; Splunk matched bare terms against the whole raw event, so terms that only appear in other attributes won't match
```

```
❓ Not confirmed
SPL:  index=web | where searchmatch("status=500 timeout")
NRQL: FROM Log SELECT * WHERE index = 'web' AND status = '500' OR numeric(status) = 500 AND message LIKE '%timeout%'
🟡 `searchmatch()` translated as a search on the message attribute; Splunk matched bare terms against the whole raw event, so terms that only appear in other attributes won't match
```

```
❓ Not confirmed
SPL:  index=web | where like(_raw, "%x%") | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND message LIKE '%x%'
🟡 `_raw` is not a valid NRQL field; mapped to message
```

```
❓ Not confirmed
SPL:  index=web | where 'a.b'>5 | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND numeric(`a.b`) > 5
```

```
❓ Not confirmed
SPL:  index=web | where code == "rex"
NRQL: FROM Log SELECT * WHERE index = 'web' AND code = 'rex'
```

```
❓ Not confirmed
SPL:  index=web | where match(host, "web")
NRQL: FROM Log SELECT * WHERE index = 'web' AND host RLIKE r'(?s:.*)web(?s:.*)'
```

```
❓ Not confirmed
SPL:  index=web | where match(msg, "(?i)nomatchalt01|nomatchalt02|nomatchalt03|nomatchalt04|nomatchalt05|nomatchalt06|nomatchalt07|nomatchalt08|nomatchalt09|nomatchalt10|nomatchalt11|nomatchalt12|nomatchalt13|nomatchalt14|nomatchalt15|nomatchalt16|nomatchalt17|nomatchalt18|nomatchalt19|nomatchalt20|nomatchalt21|nomatchalt22|nomatchalt23|nomatchalt24|nomatchalt25|handling event")
NRQL: FROM Log SELECT * WHERE index = 'web' AND msg RLIKE r'(?i)(?s:.*)nomatchalt01(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt02(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt03(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt04(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt05(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt06(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt07(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt08(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt09(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt10(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt11(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt12(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt13(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt14(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt15(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt16(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt17(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt18(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt19(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt20(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt21(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt22(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt23(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt24(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)nomatchalt25(?s:.*)' OR msg RLIKE r'(?i)(?s:.*)handling event(?s:.*)'
```

```
❓ Not confirmed
SPL:  index=web | where "a"="b"
🔴 `where` condition is always false (a comparison between two different literals), so the query would return no rows; remove or fix the condition
```

```
❓ Not confirmed
SPL:  index=web | where "$env$"="prod"
🔴 `where` "$env$"="prod" compares a dashboard token with a literal; the result depends on the value chosen at run time and cannot be translated
```

```
❓ Not confirmed
SPL:  index=web | where "1"=1
🔴 `where` "1"=1 compares a string literal with a number literal; Splunk's coercion for this cannot be reproduced reliably
```

```
❓ Not confirmed
SPL:  index=web | where Grp!="A" Grp!="B"
🔴 `where`: implicit AND is not valid in where (it is search syntax); join the conditions with AND — this is a defect in the source query
```
<!-- /spl-cases -->

## `where` on aggregation result — Supported

Filters aggregation results (equivalent to SQL HAVING). Translates to NRQL `WHERE` on aggregate expressions.

<!-- spl-cases: results-where-on-agg -->
```
❓ Not confirmed
SPL:  * | stats count by host, region | where region = "us-east"
NRQL: FROM (FROM Log SELECT count(*) FACET host, region LIMIT MAX) SELECT * WHERE region = 'us-east'
```

```
❓ Not confirmed
SPL:  * | stats count as c, dc(host) as hosts by region | where c > hosts
NRQL: FROM (FROM Log SELECT count(*) AS 'c', uniqueCount(host) AS 'hosts' FACET region LIMIT MAX) SELECT * WHERE numeric(c) > numeric(hosts)
```

```
❓ Not confirmed
SPL:  * | timechart count by host | where count > 100
NRQL: FROM (FROM Log SELECT count(*) FACET host LIMIT MAX TIMESERIES AUTO) SELECT * WHERE numeric(count) > 100
```

```
❓ Not confirmed
SPL:  * | stats dc(user) as users by host | where users > 100
NRQL: FROM (FROM Log SELECT uniqueCount(user) AS 'users' FACET host LIMIT MAX) SELECT * WHERE numeric(users) > 100
```

```
✅ Confirmed by human
SPL:  * | stats count by host | where NOT count = 0
NRQL: FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT * WHERE NOT (count = '0' OR numeric(count) = 0)
```

```
✅ Confirmed by human
SPL:  * | stats count by host | where count > 100 AND count < 1000
NRQL: FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT * WHERE numeric(count) > 100 AND numeric(count) < 1000
```

```
✅ Confirmed by human
SPL:  * | stats count | where count > 0
NRQL: FROM (FROM Log SELECT count(*)) SELECT * WHERE numeric(count) > 0
```

```
❓ Not confirmed
SPL:  index=web | stats count by host | where "a"="a"
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```
<!-- /spl-cases -->

## `xmlkv` — Not supported

Extracts key-value pairs from XML data. NRQL has no XML parser; consider using `spath` (jparse()) if the data can be converted to JSON at ingest time.

<!-- spl-cases: fields-xmlkv -->
```
✅ Confirmed by human
SPL:  * | xmlkv
🔴 SPL command 'xmlkv' has no known NRQL equivalent
```
<!-- /spl-cases -->

## Eval Functions

Evaluation functions are used inside `eval`, `where`, and `case` expressions.

## Comparison and Conditional

## `case()`, `if()`, `validate()`, `null()`, `true()`, `false()`, `isnull()`, `isnotnull()`, `like()`, `match()`, `cidrmatch()`, `in()`, `searchmatch()` — Partial support

Most conditional functions translate to NRQL equivalents: `if()` → `if()`, `case()` → nested `if()`, `isnull()` → `IS NULL`, `isnotnull()` → `IS NOT NULL`, `like()` → `LIKE`, `match()` → `RLIKE`, `in()` → `IN`. Functions without equivalents: `validate()`, `searchmatch()`.

<!-- spl-cases: eval-conditional -->
```
✅ Confirmed by human
SPL:  * | eval x = if(status=200, "ok", "err")
NRQL: FROM Log WITH if(status = '200' OR numeric(status) = 200, 'ok', 'err') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x = if(a>1, "y", "n")
NRQL: FROM Log WITH if(numeric(a) > 1, 'y', 'n') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval FLSQuantity=if(channelName=="FLS", availableQuantityInChannel, 0)
NRQL: FROM Log WITH if(channelName = 'FLS', availableQuantityInChannel, 0) AS FLSQuantity SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=if(a > 0 and b > 0, "both", "nope")
NRQL: FROM Log WITH if(numeric(a) > 0 AND numeric(b) > 0, 'both', 'nope') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval level = case(status<300, "ok", status<500, "warn", 1=1, "err")
NRQL: FROM Log WITH if(numeric(status) < 300, 'ok', if(numeric(status) < 500, 'warn', 'err')) AS level SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=case(a=1, "one", b=2, "two", 1=1, "other")
NRQL: FROM Log WITH if(a = '1' OR numeric(a) = 1, 'one', if(b = '2' OR numeric(b) = 2, 'two', 'other')) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=case(a=1, "one", b=2, "two")
NRQL: FROM Log WITH if(a = '1' OR numeric(a) = 1, 'one', if(b = '2' OR numeric(b) = 2, 'two', NULL)) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=if(a > 0 or b > 0, "yes", "no")
NRQL: FROM Log WITH if(numeric(a) > 0 OR numeric(b) > 0, 'yes', 'no') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=if((a > 0) or (b > 0), "yes", "no")
NRQL: FROM Log WITH if(numeric(a) > 0 OR numeric(b) > 0, 'yes', 'no') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=if(count > (a + b), "over", "under")
NRQL: FROM Log WITH if(numeric(count) > numeric(a) + numeric(b), 'over', 'under') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=if(skuCount > FCQuantity, "yes", "no")
NRQL: FROM Log WITH if(numeric(skuCount) > numeric(FCQuantity), 'yes', 'no') AS x SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval x = if(a > b+1, "hi", "lo")
NRQL: FROM Log WITH if(numeric(a) > numeric(b) + 1, 'hi', 'lo') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=if(isnull(field), "missing", field)
NRQL: FROM Log WITH if(field IS NULL, 'missing', field) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=if(isnotnull(field), field, "default")
NRQL: FROM Log WITH if(field IS NOT NULL, field, 'default') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=if(like(name, "test%"), "match", "no")
NRQL: FROM Log WITH if(name LIKE 'test%', 'match', 'no') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval match=if(a==b, "same", "diff")
NRQL: FROM Log WITH if(a = b, 'same', 'diff') AS match SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=if(a > 0, "yes")
NRQL: FROM Log WITH if(numeric(a) > 0, 'yes') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=case("only")
NRQL: FROM Log WITH 'only' AS x SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval r = if(a*2 > b AND c < 3, "y", "n")
NRQL: FROM Log WITH if(numeric(a) * 2 > numeric(b) AND numeric(c) < 3, 'y', 'n') AS r SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval r = if(NOT isnull(x), 1, 0)
NRQL: FROM Log WITH if(x IS NOT NULL, 1, 0) AS r SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval r = if(NOT (a AND b), 1, 0)
NRQL: FROM Log WITH if(NOT (a AND b), 1, 0) AS r SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval r = if(x==1, "y", "n")
NRQL: FROM Log WITH if(x = '1' OR numeric(x) = 1, 'y', 'n') AS r SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval r = if(status=500, 1, 0)
NRQL: FROM Log WITH if(status = '500' OR numeric(status) = 500, 1, 0) AS r SELECT *
```

```
❓ Not confirmed
SPL:  * | stats count | eval x = round(total/count, 2)
🔴 Post-aggregation step references 'total', which the aggregation does not output (only its BY fields and aggregate columns survive stats)
```
<!-- /spl-cases -->

## String Functions

## `lower()`, `upper()`, `len()`, `substr()`, `trim()`, `ltrim()`, `rtrim()`, `replace()`, `split()`, `mvjoin()`, `urldecode()` — Partial support

String functions translate to NRQL equivalents where available: `lower()` → `lower()`, `upper()` → `upper()`, `len()` → `length()`, `substr()` → `substring()`, `replace()` → `replace()`. Some functions like `urldecode()` have no direct equivalent.

<!-- spl-cases: eval-string -->
```
✅ Confirmed by human
SPL:  * | eval name = lower(username)
NRQL: FROM Log WITH lower(username) AS name SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval full = first . " " . last
NRQL: FROM Log WITH concat(first, ' ', last) AS full SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=upper(name)
NRQL: FROM Log WITH upper(name) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=substr(name, 1, 3)
NRQL: FROM Log WITH substring(name, 0, 3) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=substr(name, -3)
NRQL: FROM Log WITH substring(name, -3) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=trim(name)
NRQL: FROM Log WITH capture(name, r'^\s*(?P<x>.*\S)\s*$') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=ltrim(name)
NRQL: FROM Log WITH capture(name, r'^\s*(?P<x>.*)$') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "a", "b")
NRQL: FROM Log WITH replace(name, 'a', 'b') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "SKU:", "")
NRQL: FROM Log WITH replace(name, 'SKU:', '') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "]", "")
NRQL: FROM Log WITH replace(name, ']', '') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "old.host.com", "new.host.com")
NRQL: FROM Log WITH replace(name, 'old.host.com', 'new.host.com') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "foo-bar", "baz")
NRQL: FROM Log WITH replace(name, 'foo-bar', 'baz') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(uri, "https://old.com/api?key=val", "https://new.com/api")
NRQL: FROM Log WITH replace(uri, 'https://old.com/api?key=val', 'https://new.com/api') AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(uri, "/path/to+file", "/path/to_file")
NRQL: FROM Log WITH replace(uri, '/path/to+file', '/path/to_file') AS x SELECT *
```

```
❓ Not confirmed
SPL:  * | eval d = strftime(_time, "%Y-%m-%d")
NRQL: FROM Log WITH toDatetime(timestamp, 'yyyy-MM-dd') AS d SELECT *
```

```
❓ Not confirmed
SPL:  * | eval t = strptime(ds, "%Y-%m-%d %H:%M:%S")
NRQL: FROM Log WITH toTimestamp(ds, 'yyyy-MM-dd HH:mm:ss') / 1000 AS t SELECT *
🟡 `strptime()` result divided by 1000: NRQL toTimestamp() returns milliseconds, Splunk strptime() returns seconds
```

```
❓ Not confirmed
SPL:  * | eval d = strftime(epoch_field, "%Y-%m-%d")
NRQL: FROM Log WITH toDatetime(epoch_field, 'yyyy-MM-dd') AS d SELECT *
🟡 `strftime()` on a non-_time epoch field assumes milliseconds (NRQL timestamp unit); a seconds-epoch field yields a 1970 date — multiply by 1000 to match
```

```
🤖 Confirmed by LLM
SPL:  index=x | eval z = businessDate + " "
NRQL: FROM Log WITH concat(businessDate, ' ') AS z SELECT * WHERE index = 'x'
```

```
🤖 Confirmed by LLM
SPL:  index=x | eval z = a + " " + b
NRQL: FROM Log WITH concat(a, ' ', b) AS z SELECT * WHERE index = 'x'
```

```
🤖 Confirmed by LLM
SPL:  * | eval z = businessDate + " "
NRQL: FROM Log WITH concat(businessDate, ' ') AS z SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval full = a + " " + b
NRQL: FROM Log WITH concat(a, ' ', b) AS full SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval r = a . " " . b
NRQL: FROM Log WITH concat(a, ' ', b) AS r SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval z = lower(a) + b
NRQL: FROM Log WITH concat(lower(a), b) AS z SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | eval z = tostring(cost) + suffix
NRQL: FROM Log WITH concat(string(cost), suffix) AS z SELECT *
```

```
❓ Not confirmed
SPL:  index=web | eval s=a."|".b
NRQL: FROM Log WITH concat(a, '|', b) AS s SELECT * WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | eval s=a.":".b
NRQL: FROM Log WITH concat(a, ':', b) AS s SELECT * WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | eval l=len(_raw) | stats avg(l)
NRQL: FROM Log WITH length(message) AS l SELECT average(l) WHERE index = 'web'
🟡 `_raw` is not a valid NRQL field; mapped to message
🟡 `length()` returns string length in NRQL, not multivalue count; results may differ for non-array fields
```

```
❓ Not confirmed
SPL:  index=web | eval s=tostring(x, "commas") | table s
NRQL: FROM Log WITH string(x, 2) AS s SELECT s WHERE index = 'web'
🟡 `tostring(x, "commas")` translated as string(x, 2): rounded to 2 decimal places like Splunk, but without the thousands separators
```

```
❓ Not confirmed
SPL:  index=web | eval s=tostring(x) | table s
NRQL: FROM Log WITH string(x) AS s SELECT s WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | eval u=replace(uri, "\?.*$", "") | stats count by u
NRQL: FROM Log WITH capture(uri, r'^(?P<repl1_pre>(?s:.*?))(?P<repl1_m>\?.*)$') AS (repl1_pre, repl1_m), if(repl1_m IS NULL, uri, repl1_pre) AS u SELECT count(*) WHERE index = 'web' FACET u
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "\\d+", "")
🔴 `replace()` with regex pattern '\d+' not supported — NRQL replace() is literal-only, and SPL replace() is global, so only an anchored (^…/…$) pattern can be rebuilt exactly with capture()
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "[abc]", "")
🔴 `replace()` with regex pattern '[abc]' not supported — NRQL replace() is literal-only, and SPL replace() is global, so only an anchored (^…/…$) pattern can be rebuilt exactly with capture()
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "test.*end", "")
🔴 `replace()` with regex pattern 'test.*end' not supported — NRQL replace() is literal-only, and SPL replace() is global, so only an anchored (^…/…$) pattern can be rebuilt exactly with capture()
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "\d+", "")
🔴 `replace()` with regex pattern '\d+' not supported — NRQL replace() is literal-only, and SPL replace() is global, so only an anchored (^…/…$) pattern can be rebuilt exactly with capture()
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "foo+", "")
🔴 `replace()` with regex pattern 'foo+' not supported — NRQL replace() is literal-only, and SPL replace() is global, so only an anchored (^…/…$) pattern can be rebuilt exactly with capture()
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "x?y", "")
🔴 `replace()` with regex pattern 'x?y' not supported — NRQL replace() is literal-only, and SPL replace() is global, so only an anchored (^…/…$) pattern can be rebuilt exactly with capture()
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "foo|bar", "")
🔴 `replace()` with regex pattern 'foo|bar' not supported — NRQL replace() is literal-only, and SPL replace() is global, so only an anchored (^…/…$) pattern can be rebuilt exactly with capture()
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "\s+", " ")
🔴 `replace()` with regex pattern '\s+' not supported — NRQL replace() is literal-only, and SPL replace() is global, so only an anchored (^…/…$) pattern can be rebuilt exactly with capture()
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(uri, "https://example.com/.*", "")
🔴 `replace()` with regex pattern 'https://example.com/.*' not supported — NRQL replace() is literal-only, and SPL replace() is global, so only an anchored (^…/…$) pattern can be rebuilt exactly with capture()
```

```
❓ Not confirmed
SPL:  * | eval x = strftime(_time, "%s")
🔴 Strftime/strptime format code '%s' has no Java DateTimeFormatter equivalent; remove it or reformat the field another way
```

```
❓ Not confirmed
SPL:  * | eval x = strftime(_time, "%Q %c %s")
🔴 Strftime/strptime format code '%Q' has no Java DateTimeFormatter equivalent; remove it or reformat the field another way
🔴 Strftime/strptime format code '%c' has no Java DateTimeFormatter equivalent; remove it or reformat the field another way
🔴 Strftime/strptime format code '%s' has no Java DateTimeFormatter equivalent; remove it or reformat the field another way
```

```
❓ Not confirmed
SPL:  * | eval d = strftime(_time, myfmt)
🔴 `strftime()` needs a quoted string format literal; a field or expression format can't be precompiled to a Java DateTimeFormatter pattern
```

```
❓ Not confirmed
SPL:  * | stats count by host | eval d = strftime(_time, "%Y-%m-%d")
🔴 Post-aggregation step references _time, but _time is not in the grouped output (the stats has no 'by _time'; Splunk's own value here is empty) — group by _time (or use timechart) to keep it
```

```
✅ Confirmed by human
SPL:  * | eval json_content=replace(json_content, "'", "\"") | spath input=json_content
🔴 `spath` without path= does auto-extraction, which has no NRQL equivalent; specify path= to extract a specific JSON field
```

```
❓ Not confirmed
SPL:  index=web | eval u=replace(msg, "\d+", "N") | stats count by u
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 `replace()` with regex pattern '\d+' not supported — NRQL replace() is literal-only, and SPL replace() is global, so only an anchored (^…/…$) pattern can be rebuilt exactly with capture()
```

```
❓ Not confirmed
SPL:  index=web | eval s=tostring(x, "hex") | table s
🔴 `tostring()` format "hex" has no NRQL equivalent; NRQL string() takes only a numeric precision
```
<!-- /spl-cases -->

## Math Functions

## `abs()`, `ceil()`, `floor()`, `round()`, `log()`, `ln()`, `exp()`, `pow()`, `sqrt()`, `pi()` — Supported

Math functions map directly: `abs()` → `abs()`, `ceil()` → `ceil()`, `floor()` → `floor()`, `round()` → `round()`, `log()` → `log()`, `ln()` → `ln()`, `exp()` → `exp()`, `pow()` → `pow()`, `sqrt()` → `sqrt()`.

<!-- spl-cases: eval-math -->
```
✅ Confirmed by human
SPL:  * | eval x=abs(val)
NRQL: FROM Log WITH abs(val) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=ceil(val)
NRQL: FROM Log WITH ceil(val) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=floor(val)
NRQL: FROM Log WITH floor(val) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=sqrt(val)
NRQL: FROM Log WITH sqrt(val) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=round(val, 2)
NRQL: FROM Log WITH round(val, 0.01) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=pow(base, exp)
NRQL: FROM Log WITH pow(base, exp) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=ceiling(val)
NRQL: FROM Log WITH ceiling(val) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=log(val)
NRQL: FROM Log WITH log10(val) AS x SELECT *
```

```
❓ Not confirmed
SPL:  index=web | eval s=sum(a,b)
NRQL: FROM Log WITH numeric(a) + numeric(b) AS s SELECT * WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | eval d=round('duration_avg_ms' / 1000, 2) | stats avg(d)
NRQL: FROM Log WITH round(numeric(duration_avg_ms) / 1000, 0.01) AS d SELECT average(d) WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | eval t=relative_time(now(),"-1d")
🔴 `relative_time()` in eval computes a per-event time and has no NRQL equivalent; to bound the time range use earliest=/latest= or where _time >= relative_time(now(), "<offset>")
```
<!-- /spl-cases -->

## Type Conversion

## `coalesce()`, `tonumber()`, `tostring()`, `typeof()`, `isbool()`, `isint()`, `isnum()`, `isstr()` — Partial support

Type and coercion functions: `coalesce()` → nested `if(IS NOT NULL)`, `tonumber()` → `numeric()`, `tostring()` → `string()`. Type-checking functions (`typeof()`, `isbool()`, etc.) have limited or no NRQL equivalents.

<!-- spl-cases: eval-type -->
```
✅ Confirmed by human
SPL:  * | eval val = coalesce(field1, field2, "default")
NRQL: FROM Log WITH (field1 OR field2 OR 'default') AS val SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=tonumber(val)
NRQL: FROM Log WITH numeric(val) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=tostring(val)
NRQL: FROM Log WITH string(val) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x=typeof(val)
🔴 `eval` function typeof() has no NRQL equivalent
```

```
✅ Confirmed by human
SPL:  * | eval x=isbool(val)
🔴 `eval` function isbool() has no NRQL equivalent
```

```
✅ Confirmed by human
SPL:  * | eval x=isstr(val)
🔴 `eval` function isstr() has no NRQL equivalent
```
<!-- /spl-cases -->

## Multivalue Functions

## `mvindex()`, `mvcount()`, `split()`, `mvjoin()`, `mvappend()`, `mvdedup()`, `mvfind()`, `mvsort()`, `mvzip()` — Partial support

NRQL does not have multivalue fields. However, some patterns translate: `split()` is used in combination with `mvindex()` to extract substrings, which can translate to NRQL string functions.
(mvindex: 3,221 · split: 2,643 · mvcount: 1,607 · mvzip: 1,437 · mvfind: 426 · mvjoin: 426 · mvdedup: 328 · mvappend: 205 · mvfilter: 182 · mvsort: 59 · mvrange: 3)

**Why the entire mv\* family exists in Splunk:**

Splunk's data model is fundamentally flat text. There are no arrays, no nested objects, no structured attributes. When Splunk users need to work with anything list-like — a comma-separated field, JSON array elements, multiple regex matches — they must first convert it to a "multivalue field" (Splunk's internal array type), then manipulate it with mv\* functions. This is the single biggest source of complexity in Splunk queries.

**In New Relic**, attributes can natively store JSON arrays and nested objects. Most mv\* patterns simply disappear because the data is already structured.

**Real-world patterns and NRQL equivalents:**

- **`split()` + `mvindex()`** (85% of mvindex usage) — extract the Nth element from a delimited string:
  ```
  SPL: | eval fields=split(correlationId, "--") | eval root_id=mvindex(fields, 0)
  ```
  This is string splitting — customers extract a prefix from an ID like `"abc123--suffix"`. In NRQL, if the data can be restructured at ingest to store `root_id` as a separate attribute, do that. Otherwise, the translator converts this to `substring()`/`position()` calls.

- **`mvcount()`** — count elements in an array. Used to count regex matches or JSON array lengths:
  ```
  SPL: | rex field=message "(?<skus>\d{6,})" max_match=0 | eval sku_count = mvcount(skus)
  ```
  **In New Relic:** If the array is a JSON attribute, query its length with `length()` on the serialized form, or count events after restructuring to one-event-per-element at ingest.

- **`mvjoin()`** — join array elements into a display string:
  ```
  SPL: | stats values(dlq_key) as dlqKeys by app | eval dlqKeys = mvjoin(dlqKeys, ", ")
  ```
  **In New Relic:** Use `uniques()` in NRQL — the result is already a list in the UI. No string joining needed.

- **`mvzip()`** — create composite labels by zipping two arrays together:
  ```
  SPL: | eval BrandCount = mvzip(Num404Brand, brand, " - ")
  ```
  **In New Relic:** Use `FACET brand` and include the count in the SELECT. The visualization handles the label/value pairing.

- **`mvappend()`** — combine multiple fields into one array:
  ```
  SPL: | eval notable_asset = mvappend(notable_src, notable_dest)
       | mvexpand notable_asset
  ```
  **In New Relic:** Query both fields separately, or restructure at ingest to normalize into a single `asset` attribute.

- **`mvdedup()`, `mvsort()`, `mvfind()`, `mvfilter()`** — array dedup/sort/search/filter. In New Relic, use `uniques()` for dedup, `FACET` for grouping, and `WHERE` for filtering. These operations apply to events, not to arrays within a single event.

<!-- spl-cases: eval-multivalue -->
```
✅ Confirmed by human
SPL:  * | eval first = mvindex(values, 0)
NRQL: FROM Log WITH getField(values, 0) AS first SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval x = mvcount(lines)
NRQL: FROM Log WITH length(lines) AS x SELECT *
🟡 `length()` returns string length in NRQL, not multivalue count; results may differ for non-array fields
```

```
✅ Confirmed by human
SPL:  * | eval x=mvindex(values)
NRQL: FROM Log WITH values AS x SELECT *
🟡 `mvindex()` requires at least 2 arguments (field, index)
```

```
❓ Not confirmed
SPL:  * | eval x=mvindex(split(data, ","), 0)
NRQL: FROM Log WITH capture(data, r'^(?:[^,]*,){0}(?P<item>[^,]*)(?s:.*)$') AS x SELECT *
```

```
❓ Not confirmed
SPL:  index=web | eval n=mvcount(split(body, ",")) | stats sum(n)
NRQL: FROM Log WITH length(split(body, ',')) AS n SELECT sum(n) WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | eval ID=mvindex(split(s, ":"), 1), L=mvindex(split(s, ","), -1) | table ID L
NRQL: FROM Log WITH capture(s, r'^(?:[^:]*:){1}(?P<item>[^:]*)(?s:.*)$') AS ID, capture(s, r'^(?:(?s:.*),)?(?P<item>[^,]*)(?:,[^,]*){0}$') AS L SELECT ID, L WHERE index = 'web'
```

```
✅ Confirmed by human
SPL:  * | eval joined = mvjoin(tags, ", ")
🔴 `mvjoin()` has no NRQL equivalent — NRQL cannot join array elements into a delimited string
```

```
❓ Not confirmed
SPL:  index=web | eval p=mvappend(a, b) | stats count by p
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 `eval` function mvappend() has no NRQL equivalent
```

```
❓ Not confirmed
SPL:  index=web | eval p=mvsort(a) | table p
🔴 `eval` function mvsort() has no NRQL equivalent
```
<!-- /spl-cases -->

## Date/Time Functions — Not supported

## `now()`, `time()`, `strftime()`, `strptime()`, `relative_time()` — Not supported

NRQL handles time through `SINCE`, `UNTIL`, and `TIMESERIES` clauses rather than per-row time functions. There is no equivalent of formatting timestamps within query results.

---

# Moderate Use Commands (20–49 occurrences)

---


## `iplocation` — Not supported

Extracts geographic information from IP addresses. New Relic performs GeoIP enrichment at ingest time — use attributes like `city`, `regionName`, `countryCode` that are already on the event.

## `regex` — Supported

Filters results by matching a field against a regular expression. Translates to NRQL `WHERE field RLIKE 'pattern'`.

<!-- spl-cases: results-regex -->
```
❓ Not confirmed
SPL:  * | regex message="error\\d+"
NRQL: FROM Log SELECT * WHERE message RLIKE r'(?s:.*)error\\d+(?s:.*)'
```

```
✅ Confirmed by human
SPL:  * | regex status!="^2\\d{2}$"
NRQL: FROM Log SELECT * WHERE status NOT RLIKE r'^2\\d{2}$'
```

```
❓ Not confirmed
SPL:  * | regex "fatal|critical"
NRQL: FROM Log SELECT * WHERE message RLIKE r'(?s:.*)(?:fatal|critical)(?s:.*)'
```

```
❓ Not confirmed
SPL:  status=500 | regex message="timeout"
NRQL: FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND message RLIKE r'(?s:.*)timeout(?s:.*)'
```

```
❓ Not confirmed
SPL:  * | regex uri_path="^/api/v[0-9]+"
NRQL: FROM Log SELECT * WHERE uri_path RLIKE r'^/api/v[0-9]+(?s:.*)'
```
<!-- /spl-cases -->

## `sort` — Supported

Sorts results by field values. Translates to NRQL `ORDER BY field ASC|DESC`.

<!-- spl-cases: results-sort -->
```
✅ Confirmed by human
SPL:  * | sort - count
NRQL: FROM Log SELECT * ORDER BY count DESC
```

```
✅ Confirmed by human
SPL:  * | sort + name
NRQL: FROM Log SELECT * ORDER BY name ASC
```

```
✅ Confirmed by human
SPL:  * | sort name
NRQL: FROM Log SELECT * ORDER BY name ASC
```

```
✅ Confirmed by human
SPL:  * | sort 0 host
NRQL: FROM Log SELECT * ORDER BY host ASC
```

```
✅ Confirmed by human
SPL:  * | sort count desc
NRQL: FROM Log SELECT * ORDER BY count DESC
```

```
✅ Confirmed by human
SPL:  * | sort 0 - firstTime
NRQL: FROM Log SELECT * ORDER BY firstTime DESC
```

```
🤖 Confirmed by LLM
SPL:  * | sort host, -duration
NRQL: FROM Log SELECT * ORDER BY host ASC
🟡 NRQL ORDER BY supports only one field; additional sort fields ignored
```

```
❓ Not confirmed
SPL:  index=web | stats count by uri | sort limit=20 -count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET uri ORDER BY count DESC LIMIT 20
```

```
❓ Not confirmed
SPL:  index=web | sort -"Time"
NRQL: FROM Log SELECT * WHERE index = 'web' ORDER BY Time DESC
```

```
❓ Not confirmed
SPL:  index=web | sort - "Time"
NRQL: FROM Log SELECT * WHERE index = 'web' ORDER BY Time DESC
```

```
❓ Not confirmed
SPL:  index=web | stats dc(requestId) by host | sort -dc(requestId)
NRQL: FROM Log SELECT uniqueCount(requestId) WHERE index = 'web' FACET host ORDER BY uniqueCount DESC
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | sort -dc(requestId)
🔴 `sort` field 'dc(requestId)' names a stats output column that no preceding aggregation produces
```
<!-- /spl-cases -->

---

# Rare Use Commands (1–19 occurrences)

### Unsupported

| Command | Workaround |
|---|---|
| `accum` | None — NRQL has no running/cumulative aggregation |
| `addtotals` | Subquery for column totals; `eval a+b+c` for row totals |
| `delta` | None — no row-over-row difference; requires client-side processing |
| `format` | None — NRQL subqueries don't need explicit formatting |
| `from` | Use `FROM <EventType>` directly |
| `highlight` | None — presentation-layer concern |
| `makemv` | `capture()` for regex extraction or `aparse()` for delimiter splitting |
| `map` | None — NRQL has no per-row dynamic subquery execution |
| `mstats` | Query `FROM Metric` directly: `FROM Metric SELECT average(cpu.percent) FACET host` |
| `multikv` | `capture()` or `aparse()` to extract key-value pairs from structured text |
| `nomv` | N/A — NRQL doesn't have multivalue fields |
| `outlier` | `WHERE x BETWEEN avg-N*stddev AND avg+N*stddev` via subquery for thresholds |
| `outputlookup` | None — NRQL is read-only; use NerdGraph API |
| `selfjoin` | `JOIN` subquery: `FROM Event JOIN (FROM Event SELECT ... FACET key LIMIT MAX) ON key` |
| `set` | Union: multiple types in `FROM`; intersect/diff: `WHERE x IN (subquery)` |
| `tail` | `ORDER BY timestamp ASC LIMIT N` |
| `transpose` | None — restructure the query to FACET on the desired axis |
| `uniq` | `FACET` with `latest()` on all fields |
| `xyseries` | None — use `FACET` which produces separate series natively |

### Supported

## `inputlookup` — Supported

Loads events from a lookup table. Translates to NRQL `FROM lookup(tablename)`.

<!-- spl-cases: results-inputlookup -->
```
✅ Confirmed by human
SPL:  * | inputlookup geo_ips
NRQL: FROM lookup(geo_ips) SELECT *
🟡 Ensure lookup table 'geo_ips' is uploaded via the Lookups UI
```

```
✅ Confirmed by human
SPL:  * | inputlookup append=true geo_ips
NRQL: FROM lookup(geo_ips) SELECT *
🟡 Ensure lookup table 'geo_ips' is uploaded via the Lookups UI
```

```
✅ Confirmed by human
SPL:  * | inputlookup my_table
NRQL: FROM lookup(my_table) SELECT *
🟡 Ensure lookup table 'my_table' is uploaded via the Lookups UI
```

```
✅ Confirmed by human
SPL:  | inputlookup users.csv where role="admin"
NRQL: FROM lookup(users.csv) SELECT * WHERE role = 'admin'
🟡 Ensure lookup table 'users.csv' is uploaded via the Lookups UI
🟡 `inputlookup` WHERE condition translated as-is; verify field names match the lookup table schema
```

```
❓ Not confirmed
SPL:  | inputlookup shops.csv where Grp!="A" Grp!="B"
NRQL: FROM lookup(shops.csv) SELECT * WHERE Grp != 'A' AND Grp != 'B'
🟡 Ensure lookup table 'shops.csv' is uploaded via the Lookups UI
🟡 `inputlookup` WHERE condition translated as-is; verify field names match the lookup table schema
```

```
✅ Confirmed by human
SPL:  * | join host [inputlookup servers.csv]
🟡 `join` subsearch: Ensure lookup table 'servers.csv' is uploaded via the Lookups UI
🔴 Subsearch joins require explicit fields. Add a table or fields command to specify which fields to bring over
```
<!-- /spl-cases -->

## `rare` — Supported

Shows the least common values of a field. Translates to NRQL `SELECT count(*) ... FACET field ORDER BY count(*) ASC`.

<!-- spl-cases: reports-rare -->
```
✅ Confirmed by human
SPL:  * | rare status
NRQL: FROM Log SELECT count(*) FACET status ORDER BY count ASC LIMIT 10
```

```
✅ Confirmed by human
SPL:  * | rare 5 uri_path
NRQL: FROM Log SELECT count(*) FACET uri_path ORDER BY count ASC LIMIT 5
```

```
✅ Confirmed by human
SPL:  * | rare status by host
NRQL: FROM Log SELECT count(*) FACET status, host ORDER BY count ASC LIMIT 10
```

```
✅ Confirmed by human
SPL:  status>=400 | rare 20 uri_path
NRQL: FROM Log SELECT count(*) WHERE numeric(status) >= 400 FACET uri_path ORDER BY count ASC LIMIT 20
```

```
✅ Confirmed by human
SPL:  * | rare app limit=20
NRQL: FROM Log SELECT count(*) FACET app ORDER BY count ASC LIMIT 20
```

```
✅ Confirmed by human
SPL:  * | rare limit=20 "details.error"
NRQL: FROM Log SELECT count(*) FACET `details.error` ORDER BY count ASC LIMIT 20
```
<!-- /spl-cases -->

## `return` — Not supported

Returns field values from a subsearch. NRQL subqueries return scalar values directly.

## `reverse` — Supported

Reverses the order of results. Translates to NRQL `ORDER BY timestamp ASC`.

<!-- spl-cases: results-reverse -->
```
✅ Confirmed by human
SPL:  * | reverse
NRQL: FROM Log SELECT * ORDER BY timestamp ASC
```

```
✅ Confirmed by human
SPL:  error | table message | reverse
NRQL: FROM Log SELECT message WHERE message LIKE '%error%' ORDER BY timestamp ASC
```

```
❓ Not confirmed
SPL:  * | stats count by host | reverse
NRQL: FROM Log SELECT count(*) FACET host ORDER BY timestamp ASC
🟡 `reverse` after aggregation may not produce correct results; NRQL ORDER BY timestamp ASC does not match SPL row-order reversal
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```
<!-- /spl-cases -->

# No Observed Usage

Commands with zero occurrences in customer query data and security detection rules.

| Command | Workaround |
|---|---|
| `abstract` | None — Splunk-specific text summarization |
| `addcoltotals` | Subquery: `FROM (inner FACET x) SELECT sum(col)` |
| `addinfo` | None — query metadata not available in NRQL |
| `analyzefields` | None — Splunk ML toolkit feature |
| `anomalies` | Use NR Applied Intelligence alert conditions |
| `anomalydetection` | Use NR alert conditions with baseline thresholds |
| `anomalousvalue` | None — Splunk ML toolkit feature |
| `arules` | None — Splunk ML toolkit feature |
| `associate` | None — Splunk ML toolkit feature |
| `autoregress` | `TIMESERIES` with `slidingWindow()` for moving averages |
| `bucketdir` | None — Splunk-specific path manipulation |
| `cluster` | NR Logs pattern detection in UI (not via NRQL) |
| `cofilter` | None — Splunk ML toolkit feature |
| `collect` | None — NRQL is read-only; use Events API for writes |
| `concurrency` | `TIMESERIES` with `count(*)` for approximate concurrency |
| `contingency` / `ctable` | `SELECT count(*) FACET field1, field2` |
| `correlate` | None — no built-in correlation functions |
| `datamodel` / `datamodelsimple` | Query event types directly with `FROM <EventType>` |
| `dbinspect` | NerdGraph API or platform UI for index metadata |
| `dbxquery` | None — NRQL only queries NR telemetry |
| `delete` | Retention policies and drop rules at ingest |
| `diff` | None — no result-set comparison |
| `entitymerge` | None — Splunk ITSI-specific |
| `erex` | Use `capture()` or `aparse()` with explicit patterns |
| `eventcount` | `SELECT count(*) FROM Log` |
| `fieldformat` | None — formatting handled by visualization layer |
| `filldown` | None — no row-ordering carry-forward |
| `findtypes` | None — Splunk-specific type inference |
| `folderize` | None — Splunk UI-specific |
| `fromjson` | `jparse()` for JSON field extraction |
| `gauge` | NR dashboard chart types handle visualization |

| `geom` / `geomfilter` / `geostats` | None — Splunk-specific geo visualization |
| `gentimes` | `TIMESERIES` for time bucketing |
| `history` | NerdGraph or NR UI for query history |
| `iconify` | None — presentation-layer feature |
| `ingestpreview` / `inputintelligence` | None — Splunk admin features |
| `inputcsv` | Lookup tables or NerdGraph for external data |
| `kmeans` | None — Splunk ML toolkit feature |
| `kvform` | None — use `capture()` or `aparse()` |
| `loadjob` | Re-run the query or use dashboards |
| `localize` | `TIMESERIES` with filtering |
| `localop` | None — Splunk distributed architecture internal |
| `makecontinuous` | `TIMESERIES` for time-based continuity |
| `makeresults` | Hardcoded values in `SELECT` |
| `mcatalog` | NerdGraph or Metric Explorer UI |
| `mcollect` | None — NRQL is read-only |
| `metadata` / `metasearch` | NerdGraph or Data Explorer UI |
| `mpreview` | None |
| `multisearch` | Multiple types in `FROM` (no true UNION) |
| `outputcsv` / `outputtext` | NR export features (UI, NerdGraph, streaming) |
| `overlap` | None — no interval-overlap analysis |
| `pivot` | None — Splunk data model feature |
| `rangemap` | `cases(WHERE val < 10, 'low', WHERE val < 50, 'med', ...)` |
| `reltime` | None — visualization layer handles time display |
| `require` | `WHERE field IS NOT NULL` |
| `rest` | None — use NerdGraph for platform API access |
| `rtorder` | None — Splunk real-time search internal |
| `run` / `script` | None — NRQL has no external execution |
| `savedsearch` | Dashboard widget queries or NerdGraph |
| `scrub` | Drop rules or obfuscation rules at ingest |
| `searchtxn` | None — no transaction grouping |
| `sendemail` | NR alert notifications or scheduled exports |


| `setfields` | `WITH` clause to assign constants |
| `sichart` / `sitimechart` / `sirare` / `sistats` / `sitop` | Events-to-metrics rules for precomputation |
| `tags` | NR entity tags and attribute-based filtering |
| `tojson` | None — no JSON serialization in NRQL |
| `trendline` | `TIMESERIES` with `COMPARE WITH` for trend comparison |
| `tscollect` | None — NR handles performance via storage engine |
| `tstats` | Query event types directly; identify which sourcetypes populate the data model |
| `union` | Multiple types in `FROM` (no true UNION) |
| `untable` | None — visualization layer controls format |
| `walklex` | None — Splunk index introspection |
| `x11` | None — Splunk ML toolkit feature |
| `xmlunescape` | Preprocess at ingest |
| `xpath` | Convert to JSON at ingest, use `jparse()` |

### Partially supported

## `predict` — Partial support

Forecasts future values. NRQL supports `PREDICT` but requires `TIMESERIES` — the translator adds it automatically if missing.

<!-- spl-cases: prediction-predict -->
```
✅ Confirmed by human
SPL:  * | predict count
NRQL: FROM Log SELECT count(*) TIMESERIES AUTO PREDICT
🟡 PREDICT requires TIMESERIES; added TIMESERIES AUTO automatically
```
<!-- /spl-cases -->

### Subsearch commands

| Command | Workaround |
|---|---|
| `format` | NRQL subqueries don't need explicit formatting |
| `return` | NRQL subqueries return scalar values directly |
| `set` | See `set` in Rare Use table above |

### Internal / 3rd-Party

Splunk internal and 3rd-party commands. None have NRQL equivalents.

`collapse`, `dump`, `findkeywords`, `makejson`, `noop`, `prjob`, `redistribute`, `runshellscript` — Splunk search pipeline internals.

`awssnsalert`, `sendalert` — Use NR alert notification channels. `snowincident`, `snowevent` — Use NR ServiceNow integration. `typeahead`, `typelearner`, `typer` — Splunk-specific.

### Unknown commands

Commands not recognized by the translator produce a generic unsupported message.


---


---

# Statistical and Charting Functions

## Stats Function Mapping

<!-- spl-table: stats-functions -->
| SPL function | NRQL function | Notes |
|---|---|---|
| `dc(field)` | `uniqueCount(field), average(bytes), sum(bytes), median(latency), average(latency), uniqueCount(user), uniques(status), percentile(field, 95), percentile(latency, 99), stddev(latency)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `min(field)` | `min(field), max(duration)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `stdevp(field)` | `stddev(field)` | stdevp() is population stddev; mapped to NRQL stddev() which is sample stddev. Results may differ. |
| `earliest(field)` | `earliest(field), latest(timestamp)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `first(field)` | `latest(field)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `last(field)` | `earliest(field)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `rate(field)` | `rate(sum(field), 1 second)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `list(field)` | `—` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `xyzfunc(field)` | `—` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `estdc(field)` | `uniqueCount(field)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `exactperc95(field)` | `percentile(field, 95)` | exactperc95() mapped to NRQL percentile(); precision may differ |
| `upperperc99(field)` | `percentile(field, 99)` | upperperc99() mapped to NRQL percentile(); precision may differ |
| `per_second(field)` | `rate(sum(field), 1 second)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `per_minute(field)` | `rate(sum(field), 1 minute)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `per_hour(field)` | `rate(sum(field), 1 hour)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `per_day(field)` | `—` |  |
| `max(field)` | `max(numeric(field) / 1000)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `perc95(field)` | `—` |  |
| `range(field)` | `max(field) - min(x)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `perc99.9(field)` | `percentile(d, 99.9)` |  |
| `round(avg(field)` | `round(average(field), 0.01)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `round(field)` | `—` |  |
| `count(eval(tonumber(field)` | `filter(count(*),` |  |
| `count(eval(field)` | `—` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
<!-- /spl-table -->

<!-- spl-cases: stats-functions -->
```
✅ Confirmed by human
SPL:  * | stats dc(clientip), avg(bytes), sum(bytes), median(latency), mean(latency), distinct_count(user), values(status), perc95(latency), p99(latency), stdev(latency) by host
NRQL: FROM Log SELECT uniqueCount(clientip), average(bytes), sum(bytes), median(latency), average(latency), uniqueCount(user), uniques(status), percentile(latency, 95), percentile(latency, 99), stddev(latency) FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats min(duration), max(duration) by host
NRQL: FROM Log SELECT min(duration), max(duration) FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats stdevp(latency) by host
NRQL: FROM Log SELECT stddev(latency) FACET host
🟡 SPL stdevp() is population stddev; mapped to NRQL stddev() which is sample stddev. Results may differ.
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats earliest(timestamp), latest(timestamp) by host
NRQL: FROM Log SELECT earliest(timestamp), latest(timestamp) FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats first(status) by host
NRQL: FROM Log SELECT latest(status) FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats last(status) by host
NRQL: FROM Log SELECT earliest(status) FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats rate(bytes) by host
NRQL: FROM Log SELECT rate(sum(bytes), 1 second) FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats estdc(clientip) as approx_unique by host
NRQL: FROM Log SELECT uniqueCount(clientip) AS 'approx_unique' FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats exactperc95(latency) as exact_p95 by service
NRQL: FROM Log SELECT percentile(latency, 95) AS 'exact_p95' FACET service
🟡 SPL exactperc95() mapped to NRQL percentile(); precision may differ
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats upperperc99(response_time) by endpoint
NRQL: FROM Log SELECT percentile(response_time, 99) FACET endpoint
🟡 SPL upperperc99() mapped to NRQL percentile(); precision may differ
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats per_second(bytes) as bps by host
NRQL: FROM Log SELECT rate(sum(bytes), 1 second) AS 'bps' FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats per_minute(requests) as rpm by service
NRQL: FROM Log SELECT rate(sum(requests), 1 minute) AS 'rpm' FACET service
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats per_hour(errors) as errors_per_hour by host
NRQL: FROM Log SELECT rate(sum(errors), 1 hour) AS 'errors_per_hour' FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats per_day(signups) as daily_signups
NRQL: FROM Log SELECT rate(sum(signups), 1 day) AS 'daily_signups'
```

```
✅ Confirmed by human
SPL:  * | stats max(a / 1000) as div, min(b * 8) as mul, sum(c + d) as add, avg(e - f) as sub, count(g % 3) as mod, max((h + i) * j) as parens, avg(response.time / 1000) as dotfield, sum(a + b + c) as chained by host
NRQL: FROM Log SELECT max(numeric(a) / 1000) AS 'div', min(numeric(b) * 8) AS 'mul', sum(numeric(c) + numeric(d)) AS 'add', average(numeric(e) - numeric(f)) AS 'sub', count(mod(numeric(g), 3)) AS 'mod', max((numeric(h) + numeric(i)) * numeric(j)) AS 'parens', average(numeric(`response.time`) / 1000) AS 'dotfield', sum(numeric(a) + numeric(b) + numeric(c)) AS 'chained' FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | timechart span=1h avg(bytes * 8 / 1024)
NRQL: FROM Log SELECT average(numeric(bytes) * 8 / 1024) TIMESERIES 1 hour
```

```
✅ Confirmed by human
SPL:  * | stats perc95(duration / 1000) as p95_sec
NRQL: FROM Log SELECT percentile(numeric(duration) / 1000, 95) AS 'p95_sec'
```

```
❓ Not confirmed
SPL:  index=web | stats range(x) by host
NRQL: FROM Log SELECT max(x) - min(x) WHERE index = 'web' FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | stats first(x) as f by a
NRQL: FROM Log SELECT latest(x) AS 'f' WHERE index = 'web' FACET a
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | stats perc99.9(d)
NRQL: FROM Log SELECT percentile(d, 99.9) WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | stats round(avg(dur), 2) as avgDur by endpoint
NRQL: FROM Log SELECT round(average(dur), 0.01) AS 'avgDur' WHERE index = 'web' FACET endpoint
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | stats count(eval(tonumber('response.status')>=500)) as c
NRQL: FROM Log SELECT filter(count(*), WHERE numeric(`response.status`) >= 500) AS 'c' WHERE index = 'web'
```

```
❓ Not confirmed
SPL:  index=web | stats count(eval(status="success")) as ok by h
NRQL: FROM Log SELECT filter(count(*), WHERE status = 'success') AS 'ok' WHERE index = 'web' FACET h
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  * | stats list(user) by host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 SPL list() keeps every value including duplicates, in event order; NRQL uniques() de-duplicates and does not preserve order. Use values() if distinct values are acceptable
```

```
❓ Not confirmed
SPL:  * | stats xyzfunc(field) by host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 SPL function xyzfunc() has no known NRQL equivalent
```

```
❓ Not confirmed
SPL:  index=web | sort x | stats first(x) as f by a
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 `first()` after a sort/reverse/tail depends on the re-ordered row order; NRQL latest()/earliest() pick by timestamp, so the result would differ
```

```
❓ Not confirmed
SPL:  index=web | stats round(dur, 2) as x
🔴 `field` 'dur' is used outside an aggregate in a stats expression; each group needs one value, so wrap it in an aggregate (e.g. avg(dur))
```

```
❓ Not confirmed
SPL:  index=web | stats count(eval(status=success)) as ok by h
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 Count(eval(…)) compares two fields (status with success); NRQL filter() needs a constant on one side of each comparison. In SPL eval an unquoted word is a field name — if 'success' was meant as text, quote it ("success")
```
<!-- /spl-cases -->

## Stats Functions with No NRQL Equivalent

<!-- spl-table: stats-no-equiv -->
| SPL function | Notes |
|---|---|
| `mode(field)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `earliest_time(field)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `rate_avg(field)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
<!-- /spl-table -->

<!-- spl-cases: stats-no-equiv -->
```
❓ Not confirmed
SPL:  * | stats mode(status) by host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 SPL mode() (most common value) has no NRQL aggregate equivalent; use a separate query with FACET field LIMIT 1
```

```
❓ Not confirmed
SPL:  * | stats earliest_time(message) as first_seen by host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 SPL earliest_time() has no NRQL equivalent; earliest() returns the value, not the timestamp
```

```
❓ Not confirmed
SPL:  * | stats rate_avg(cpu) by host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🔴 SPL rate_avg() is Splunk metrics-specific; no NRQL equivalent
```
<!-- /spl-cases -->

---

# Time Format Variables and Modifiers

## Time constraints (earliest/latest)

SPL time modifiers like `earliest=-24h` and `latest=now` translate to NRQL `SINCE` and `UNTIL` clauses.

<!-- spl-cases: time-constraints -->
```
✅ Confirmed by human
SPL:  earliest=-24h
NRQL: FROM Log SELECT * SINCE 24 hours ago
```

```
✅ Confirmed by human
SPL:  latest=now
NRQL: FROM Log SELECT *
```

```
✅ Confirmed by human
SPL:  earliest=@d
NRQL: FROM Log SELECT * SINCE today
```

```
✅ Confirmed by human
SPL:  error earliest=-24h latest=now
NRQL: FROM Log SELECT * WHERE message LIKE '%error%' SINCE 24 hours ago
```

```
✅ Confirmed by human
SPL:  earliest=-2h latest=-1h status=200
NRQL: FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 SINCE 2 hours ago UNTIL 1 hour ago
```

```
✅ Confirmed by human
SPL:  earliest=-24h@h latest=now
NRQL: FROM Log SELECT * SINCE 24 hours ago
🟡 SPL snap-to time '@h' ignored; NRQL SINCE/UNTIL does not support rounding to unit boundaries. Use 'today', 'this week', etc. for snap-only expressions.
```

```
✅ Confirmed by human
SPL:  status=500 earliest=-24h host=web
NRQL: FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND host = 'web' SINCE 24 hours ago
```

```
✅ Confirmed by human
SPL:  earliest=-24h earliest=-1h
NRQL: FROM Log SELECT * SINCE 1 hour ago
```

```
🤖 Confirmed by LLM
SPL:  latest=-1h
🔴 Latest= without earliest= has no lower time bound, so there is no safe NRQL time range to produce. Add an explicit earliest= (e.g. earliest=-24h) or a literal datetime range (e.g. earliest="01/01/2024:00:00:00").
```

```
🤖 Confirmed by LLM
SPL:  latest=-2d
🔴 Latest= without earliest= has no lower time bound, so there is no safe NRQL time range to produce. Add an explicit earliest= (e.g. earliest=-24h) or a literal datetime range (e.g. earliest="01/01/2024:00:00:00").
```
<!-- /spl-cases -->

## Dashboard time tokens

Splunk dashboard time tokens (`$tok.earliest$`, bare `$earliest$`/`$latest$`, custom `$x$` in `earliest=`/`latest=`, and `$timespan$` in `span=`) resolve only at dashboard run time, so they carry no static value to translate. Time-bound tokens are dropped with a warning; `$timespan$` and mixed literal+token windows are unsupported. Use literal datetime/duration values instead.

<!-- spl-cases: dashboard-time-tokens -->
```
🤖 Confirmed by LLM
SPL:  index=web earliest=$tok.earliest$ latest=$tok.latest$ | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web'
🟡 Earliest=$tok.earliest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
🟡 Latest=$tok.latest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
```

```
🤖 Confirmed by LLM
SPL:  index=web latest=$tok.latest$ | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web'
🟡 Latest=$tok.latest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
```

```
🤖 Confirmed by LLM
SPL:  index=web earliest=$myStart$ latest=$myEnd$ | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web'
🟡 Earliest=$myStart$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
🟡 Latest=$myEnd$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
```

```
🤖 Confirmed by LLM
SPL:  index=web earliest=$earliest$ latest=$latest$ | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web'
🟡 Earliest=$earliest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
🟡 Latest=$latest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
```

```
🤖 Confirmed by LLM
SPL:  index=web $tok.earliest$ | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web'
🟡 Earliest=$tok.earliest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
```

```
🤖 Confirmed by LLM
SPL:  index=web $earliest$ | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web'
🟡 Earliest=$earliest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
```

```
🤖 Confirmed by LLM
SPL:  index=web $latest$ | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web'
🟡 Latest=$latest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
```

```
🤖 Confirmed by LLM
SPL:  index=web earliest=-24h latest=-1h | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' SINCE 24 hours ago UNTIL 1 hour ago
```

```
❓ Not confirmed
SPL:  index=web status=$sev$ | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND lower(string(status)) = lower(string({{sev}}))
```

```
❓ Not confirmed
SPL:  index=web earliestSeen=$earliestSeen$ | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND lower(string(earliestSeen)) = lower(string({{earliestSeen}}))
```

```
❓ Not confirmed
SPL:  index=$idx$ | stats count
NRQL: FROM Log SELECT count(*) WHERE index = {{idx}}
```

```
❓ Not confirmed
SPL:  index="$env$" | stats count
NRQL: FROM Log SELECT count(*) WHERE index = {{env}}
```

```
❓ Not confirmed
SPL:  index="*$env$*" | stats count
NRQL: FROM Log SELECT count(*) WHERE index LIKE {{env}}
🟡 A wildcard dashboard token became index LIKE {{env}}. For a substring match, the dashboard variable env's values must include % wildcards (e.g. %value%); New Relic substitutes the value as-is and does not add wildcards.
```

```
❓ Not confirmed
SPL:  index="$env$*" | stats count
NRQL: FROM Log SELECT count(*) WHERE index LIKE {{env}}
🟡 A wildcard dashboard token became index LIKE {{env}}. For a substring match, the dashboard variable env's values must include % wildcards (e.g. %value%); New Relic substitutes the value as-is and does not add wildcards.
```

```
❓ Not confirmed
SPL:  index="*$env$" | stats count
NRQL: FROM Log SELECT count(*) WHERE index LIKE {{env}}
🟡 A wildcard dashboard token became index LIKE {{env}}. For a substring match, the dashboard variable env's values must include % wildcards (e.g. %value%); New Relic substitutes the value as-is and does not add wildcards.
```

```
🤖 Confirmed by LLM
SPL:  index=web $timespan$ | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND {{timespan}}
```

```
🤖 Confirmed by LLM
SPL:  index=web | timechart span=5m count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' TIMESERIES 5 minutes
```

```
🤖 Confirmed by LLM
SPL:  index=web | timechart span=hour count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' TIMESERIES 1 hour
```

```
🤖 Confirmed by LLM
SPL:  index=web [ search index=auth earliest=$tok.earliest$ ] | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND index = 'auth'
🟡 `subsearch`: earliest=$tok.earliest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
```

```
🤖 Confirmed by LLM
SPL:  index=web earliest=-24h [ search index=auth latest=$tok.latest$ ] | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND index = 'auth' SINCE 24 hours ago
🟡 `subsearch`: latest=$tok.latest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
```

```
🤖 Confirmed by LLM
SPL:  index=web [ search index=auth earliest=-1h latest=$tok.latest$ ] | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND index = 'auth'
🟡 `subsearch`: latest=$tok.latest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
```

```
🤖 Confirmed by LLM
SPL:  index=web earliest=$tok.earliest$ latest=$tok.latest$
NRQL: FROM Log SELECT * WHERE index = 'web'
🟡 Earliest=$tok.earliest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
🟡 Latest=$tok.latest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
```

```
🤖 Confirmed by LLM
SPL:  index=web earliest=-24h latest=$tok.latest$ | stats count
🟡 Latest=$tok.latest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
🔴 This search mixes a literal time bound with a dashboard time variable. Dropping only the variable would widen or invert the window, so the whole time range is unsupported. Make both bounds literal datetimes (e.g. earliest=-24h latest=now).
```

```
🤖 Confirmed by LLM
SPL:  index=web earliest=$tok.earliest$ latest=-2h | stats count
🟡 Earliest=$tok.earliest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
🔴 This search mixes a literal time bound with a dashboard time variable. Dropping only the variable would widen or invert the window, so the whole time range is unsupported. Make both bounds literal datetimes (e.g. earliest=-24h latest=now).
```

```
🤖 Confirmed by LLM
SPL:  index=web $tok.latest$ earliest=-24h | stats count
🟡 Latest=$tok.latest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
🔴 This search mixes a literal time bound with a dashboard time variable. Dropping only the variable would widen or invert the window, so the whole time range is unsupported. Make both bounds literal datetimes (e.g. earliest=-24h latest=now).
```

```
❓ Not confirmed
SPL:  app="$env:app$" | stats count
🔴 $env:app$ is a Splunk runtime-context token (the $env:…$ namespace — current app/page/user/locale). New Relic dashboards have no equivalent runtime-context variable, and the colon cannot appear in an NRQL {{…}} template variable, so this filter cannot be translated. Remove the env-scoped filter or re-scope the widget with a New Relic template variable.
```

```
❓ Not confirmed
SPL:  app=$env:user$ | stats count
🔴 $env:user$ is a Splunk runtime-context token (the $env:…$ namespace — current app/page/user/locale). New Relic dashboards have no equivalent runtime-context variable, and the colon cannot appear in an NRQL {{…}} template variable, so this filter cannot be translated. Remove the env-scoped filter or re-scope the widget with a New Relic template variable.
```

```
❓ Not confirmed
SPL:  index=web $env:page$ | stats count
🔴 $env:page$ is a Splunk runtime-context token (the $env:…$ namespace — current app/page/user/locale). New Relic dashboards have no equivalent runtime-context variable, and the colon cannot appear in an NRQL {{…}} template variable, so this filter cannot be translated. Remove the env-scoped filter or re-scope the widget with a New Relic template variable.
```

```
❓ Not confirmed
SPL:  app="$env:app$" page="$env:page$" | stats count
🔴 $env:app$ is a Splunk runtime-context token (the $env:…$ namespace — current app/page/user/locale). New Relic dashboards have no equivalent runtime-context variable, and the colon cannot appear in an NRQL {{…}} template variable, so this filter cannot be translated. Remove the env-scoped filter or re-scope the widget with a New Relic template variable.
🔴 $env:page$ is a Splunk runtime-context token (the $env:…$ namespace — current app/page/user/locale). New Relic dashboards have no equivalent runtime-context variable, and the colon cannot appear in an NRQL {{…}} template variable, so this filter cannot be translated. Remove the env-scoped filter or re-scope the widget with a New Relic template variable.
```

```
❓ Not confirmed
SPL:  app="*$env:app$*" | stats count
🔴 $env:app$ is a Splunk runtime-context token (the $env:…$ namespace — current app/page/user/locale). New Relic dashboards have no equivalent runtime-context variable, and the colon cannot appear in an NRQL {{…}} template variable, so this filter cannot be translated. Remove the env-scoped filter or re-scope the widget with a New Relic template variable.
```

```
❓ Not confirmed
SPL:  host="$my-var$" | stats count
🔴 $my-var$ is a dashboard token whose name contains ':' or '-', which New Relic's {{…}} template-variable syntax does not allow (a hard NRQL parse error). Rename the dashboard variable to use only letters, digits, '_', and '.', or remove the filter.
```

```
❓ Not confirmed
SPL:  host="$a:b$" | stats count
🔴 $a:b$ is a dashboard token whose name contains ':' or '-', which New Relic's {{…}} template-variable syntax does not allow (a hard NRQL parse error). Rename the dashboard variable to use only letters, digits, '_', and '.', or remove the filter.
```

```
❓ Not confirmed
SPL:  host=$my-var$ | stats count
🔴 $my-var$ is a dashboard token whose name contains ':' or '-', which New Relic's {{…}} template-variable syntax does not allow (a hard NRQL parse error). Rename the dashboard variable to use only letters, digits, '_', and '.', or remove the filter.
```

```
❓ Not confirmed
SPL:  index="*fps-$env$*" | stats count
🔴 Index="*fps-$env$*" embeds a dashboard token inside literal text. New Relic substitutes a dashboard variable only in value position, never inside a string, so this cannot be translated. Use a standalone token (field=$tok$) or a wildcard-only token (field="*$tok$*").
```

```
❓ Not confirmed
SPL:  index="$env$-suffix" | stats count
🔴 Index="$env$-suffix" embeds a dashboard token inside literal text. New Relic substitutes a dashboard variable only in value position, never inside a string, so this cannot be translated. Use a standalone token (field=$tok$) or a wildcard-only token (field="*$tok$*").
```

```
🤖 Confirmed by LLM
SPL:  index=web | timechart span=$timespan$ count
🔴 Span=$timespan$ is a dashboard time variable resolved only at run time; NRQL TIMESERIES needs a concrete duration (TIMESERIES AUTO would silently pick its own bucket size). Specify a literal span (e.g. span=5m) or leave the span empty.
```

```
🤖 Confirmed by LLM
SPL:  index=web | bin _time span=$timespan$ | stats count
🔴 Span=$timespan$ is a dashboard time variable resolved only at run time; NRQL TIMESERIES needs a concrete duration (TIMESERIES AUTO would silently pick its own bucket size). Specify a literal span (e.g. span=5m) or leave the span empty.
```

```
🤖 Confirmed by LLM
SPL:  index=web | bin span=$timespan$ bytes
🔴 Span=$timespan$ is a dashboard time variable resolved only at run time; NRQL TIMESERIES needs a concrete duration (TIMESERIES AUTO would silently pick its own bucket size). Specify a literal span (e.g. span=5m) or leave the span empty.
```

```
🤖 Confirmed by LLM
SPL:  index=web | bin bytes span=$timespan$ as size
🔴 Span=$timespan$ is a dashboard time variable resolved only at run time; NRQL TIMESERIES needs a concrete duration (TIMESERIES AUTO would silently pick its own bucket size). Specify a literal span (e.g. span=5m) or leave the span empty.
```

```
🤖 Confirmed by LLM
SPL:  index=web | timechart span=$time-span$ count
🔴 Span=$time-span$ is a dashboard time variable resolved only at run time; NRQL TIMESERIES needs a concrete duration (TIMESERIES AUTO would silently pick its own bucket size). Specify a literal span (e.g. span=5m) or leave the span empty.
```

```
🤖 Confirmed by LLM
SPL:  index=web | timechart span=$ns:span$ count
🔴 Span=$ns:span$ is a dashboard time variable resolved only at run time; NRQL TIMESERIES needs a concrete duration (TIMESERIES AUTO would silently pick its own bucket size). Specify a literal span (e.g. span=5m) or leave the span empty.
```
<!-- /spl-cases -->

## Macros

SPL time macros and shorthand.

<!-- spl-cases: macros -->
```
✅ Confirmed by human
SPL:  `sysmon` EventCode=10
NRQL: FROM Log SELECT * WHERE $sysmon AND EventCode = '10' OR numeric(EventCode) = 10
🟡 SPL macro `sysmon` translated to NRQL macro $sysmon; ensure a matching NRQL macro exists
```

```
✅ Confirmed by human
SPL:  `my_macro(arg1, arg2)` status=200
NRQL: FROM Log SELECT * WHERE $my_macro(arg1, arg2) AND status = '200' OR numeric(status) = 200
🟡 SPL macro `my_macro` translated to NRQL macro $my_macro(arg1, arg2); ensure a matching NRQL macro exists
```

```
✅ Confirmed by human
SPL:  * | `my_macro`
NRQL: FROM Log SELECT * WHERE $my_macro
🟡 SPL macro `my_macro` translated to NRQL macro $my_macro; ensure a matching NRQL macro exists
```

```
✅ Confirmed by human
SPL:  * | `my_macro(field1, field2)`
NRQL: FROM Log SELECT * WHERE $my_macro(field1, field2)
🟡 SPL macro `my_macro` translated to NRQL macro $my_macro(field1, field2); ensure a matching NRQL macro exists
```

```
✅ Confirmed by human
SPL:  `my_base_macro` | stats count
NRQL: FROM Log SELECT count(*) WHERE $my_base_macro
🟡 SPL macro `my_base_macro` translated to NRQL macro $my_base_macro; ensure a matching NRQL macro exists
```
<!-- /spl-cases -->

---

# Search Syntax

## Field Comparisons

Field-value comparisons in the implicit search clause.

<!-- spl-cases: field-comparisons -->
```
✅ Confirmed by human
SPL:  status>=400 status!=500 action=purchase
NRQL: FROM Log SELECT * WHERE numeric(status) >= 400 AND status != '500' AND numeric(status) != 500 AND action = 'purchase'
```

```
✅ Confirmed by human
SPL:  status=200 offset=-10 score=3.14
NRQL: FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 AND `offset` = '-10' OR numeric(`offset`) = -10 AND score = '3.14' OR numeric(score) = 3.14
```

```
✅ Confirmed by human
SPL:  status=OK code=4xx zip=00123
NRQL: FROM Log SELECT * WHERE status = 'OK' AND code = '4xx' AND zip = '00123'
```

```
❓ Not confirmed
SPL:  _raw=*error*
NRQL: FROM Log SELECT * WHERE dimensions() LIKE '%error%'
🟡 `_raw` search translated as dimensions() LIKE, which matches across all attribute values of the event (the closest NRQL form of a raw-event search); match counts can differ where Splunk tokenizes the raw text differently
```

```
❓ Not confirmed
SPL:  index=web _raw!=*debug* | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND dimensions() NOT LIKE '%debug%'
🟡 `_raw` search translated as dimensions() LIKE, which matches across all attribute values of the event (the closest NRQL form of a raw-event search); match counts can differ where Splunk tokenizes the raw text differently
```

```
✅ Confirmed by human
SPL:  action=OR action=AND action=NOT action=by action=search action=stats group=by
NRQL: FROM Log SELECT * WHERE action = 'OR' AND action = 'AND' AND action = 'NOT' AND action = 'by' AND action = 'search' AND action = 'stats' AND group = 'by'
```

```
✅ Confirmed by human
SPL:  "log.annotations.node"=NOSTORE
NRQL: FROM Log SELECT * WHERE `log.annotations.node` = 'NOSTORE'
```

```
✅ Confirmed by human
SPL:  "details.error"="*"
NRQL: FROM Log SELECT * WHERE `details.error` LIKE '%'
```

```
✅ Confirmed by human
SPL:  status = 500
NRQL: FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500
```

```
✅ Confirmed by human
SPL:  level = "ERROR"
NRQL: FROM Log SELECT * WHERE level = 'ERROR'
```
<!-- /spl-cases -->

## JSON Array Access

Splunk's `{}` notation for JSON array fields translates to `jparse()` + `contains()` in NRQL.

<!-- spl-cases: json-array-access -->
```
✅ Confirmed by human
SPL:  lineItemList{}.status=active
NRQL: FROM Log SELECT * WHERE contains(jparse(message, 'lineItemList[*].status'), 'active')
```

```
✅ Confirmed by human
SPL:  items{}.status != pending
NRQL: FROM Log SELECT * WHERE NOT contains(jparse(message, 'items[*].status'), 'pending')
```

```
✅ Confirmed by human
SPL:  orders{}.shipping.carrier=fedex
NRQL: FROM Log SELECT * WHERE contains(jparse(message, 'orders[*].shipping.carrier'), 'fedex')
```

```
✅ Confirmed by human
SPL:  containers{}.image=nginx*
NRQL: FROM Log SELECT * WHERE jparse(message, 'containers[*].image') LIKE 'nginx%'
```

```
✅ Confirmed by human
SPL:  items{}.category IN (electronics, clothing)
NRQL: FROM Log SELECT * WHERE contains(jparse(message, 'items[*].category'), 'electronics') OR contains(jparse(message, 'items[*].category'), 'clothing')
```

```
✅ Confirmed by human
SPL:  sourceIPs{0}=10.0.0.1
NRQL: FROM Log SELECT * WHERE jparse(message, 'sourceIPs[0]') = '10.0.0.1'
```
<!-- /spl-cases -->

## Boolean Operators (AND, OR, NOT)

Boolean logic in search expressions.

<!-- spl-cases: boolean-operators -->
```
✅ Confirmed by human
SPL:  EventCode=4720 OR EventCode=4732
NRQL: FROM Log SELECT * WHERE EventCode = '4720' OR numeric(EventCode) = 4720 OR EventCode = '4732' OR numeric(EventCode) = 4732
```

```
🤖 Confirmed by LLM
SPL:  NOT debug
NRQL: FROM Log SELECT * WHERE message NOT LIKE '%debug%'
```

```
🤖 Confirmed by LLM
SPL:  (error OR warning) NOT debug
NRQL: FROM Log SELECT * WHERE message LIKE '%error%' OR message LIKE '%warning%' AND message NOT LIKE '%debug%'
```

```
✅ Confirmed by human
SPL:  `macro_a` AND `macro_b`
NRQL: FROM Log SELECT * WHERE $macro_a AND $macro_b
🟡 SPL macro `macro_a` translated to NRQL macro $macro_a; ensure a matching NRQL macro exists
🟡 SPL macro `macro_b` translated to NRQL macro $macro_b; ensure a matching NRQL macro exists
```

```
✅ Confirmed by human
SPL:  `macro_a` AND status=200
NRQL: FROM Log SELECT * WHERE $macro_a AND status = '200' OR numeric(status) = 200
🟡 SPL macro `macro_a` translated to NRQL macro $macro_a; ensure a matching NRQL macro exists
```

```
✅ Confirmed by human
SPL:  a=1 OR b=2 c=3
NRQL: FROM Log SELECT * WHERE a = '1' OR numeric(a) = 1 OR (b = '2' OR numeric(b) = 2 AND c = '3' OR numeric(c) = 3)
```

```
✅ Confirmed by human
SPL:  (a=1 OR b=2) AND c=3
NRQL: FROM Log SELECT * WHERE a = '1' OR numeric(a) = 1 OR b = '2' OR numeric(b) = 2 AND c = '3' OR numeric(c) = 3
```

```
✅ Confirmed by human
SPL:  a=1 b=2 OR c=3 d=4
NRQL: FROM Log SELECT * WHERE (a = '1' OR numeric(a) = 1 AND b = '2' OR numeric(b) = 2) OR (c = '3' OR numeric(c) = 3 AND d = '4' OR numeric(d) = 4)
```

```
✅ Confirmed by human
SPL:  NOT status=500 host=web
NRQL: FROM Log SELECT * WHERE NOT (status = '500' OR numeric(status) = 500) AND host = 'web'
```

```
✅ Confirmed by human
SPL:  NOT (status=500 host=web)
NRQL: FROM Log SELECT * WHERE NOT (status = '500' OR numeric(status) = 500 AND host = 'web')
```

```
✅ Confirmed by human
SPL:  error NOT(level=debug OR level=trace)
NRQL: FROM Log SELECT * WHERE message LIKE '%error%' AND NOT (level = 'debug' OR level = 'trace')
```

```
✅ Confirmed by human
SPL:  NOT() error
NRQL: FROM Log SELECT * WHERE message LIKE '%error%'
```
<!-- /spl-cases -->

## IN Operator

The `IN()` operator for matching against a list of values.

<!-- spl-cases: in-operator -->
```
✅ Confirmed by human
SPL:  code IN (200, error, 404)
NRQL: FROM Log SELECT * WHERE code IN (200, 'error', 404)
```

```
✅ Confirmed by human
SPL:  ScriptBlockText IN (*mimikatz*, *dumpcr*)
NRQL: FROM Log SELECT * WHERE ScriptBlockText LIKE '%mimikatz%' OR ScriptBlockText LIKE '%dumpcr%'
```

```
✅ Confirmed by human
SPL:  * NOT [|inputlookup exclude.csv] | stats count
NRQL: FROM Log SELECT count(*) WHERE {{column}} NOT IN (FROM lookup(exclude) SELECT {{column}} LIMIT MAX)
🟡 NOT [|inputlookup exclude.csv] translated to NOT IN lookup subquery. Replace {{column}} with the exclusion field name from exclude.csv. Upload the CSV to New Relic Lookup tables as 'exclude'.
```

```
✅ Confirmed by human
SPL:  "parameters.doc_title" IN ("*dhl*", "*invoice*")
NRQL: FROM Log SELECT * WHERE `parameters.doc_title` LIKE '%dhl%' OR `parameters.doc_title` LIKE '%invoice%'
```

```
❓ Not confirmed
SPL:  index=web | where country IN ("za","us")
NRQL: FROM Log SELECT * WHERE index = 'web' AND country IN ('za', 'us')
```

```
❓ Not confirmed
SPL:  index=web | where NOT (country IN ("za","us"))
NRQL: FROM Log SELECT * WHERE index = 'web' AND NOT country IN ('za', 'us')
```
<!-- /spl-cases -->

## Wildcards

Wildcard patterns in field values.

<!-- spl-cases: wildcards -->
```
✅ Confirmed by human
SPL:  host=*server host=web* message=*error* path=/api/*/users
NRQL: FROM Log SELECT * WHERE host LIKE '%server' AND host LIKE 'web%' AND message LIKE '%error%' AND path LIKE '/api/%/users'
```

```
✅ Confirmed by human
SPL:  host=*
NRQL: FROM Log SELECT * WHERE host LIKE '%'
```

```
🤖 Confirmed by LLM
SPL:  host!=test*
NRQL: FROM Log SELECT * WHERE host NOT LIKE 'test%'
```
<!-- /spl-cases -->

## Quoted Strings and Escaping

Handling of quoted strings and special characters.

<!-- spl-cases: quoted-strings -->
```
✅ Confirmed by human
SPL:  message="it's"
NRQL: FROM Log SELECT * WHERE message = 'it\'s'
```

```
✅ Confirmed by human
SPL:  path="C:\\Windows\\System32"
NRQL: FROM Log SELECT * WHERE path = 'C:\\Windows\\System32'
```

```
🤖 Confirmed by LLM
SPL:  msg="line1\nline2"
NRQL: FROM Log SELECT * WHERE msg = 'line1\\nline2'
```

```
✅ Confirmed by human
SPL:  a="error in module" b="error | fatal" c="key=value" d="" e="日本語エラー" f="error, fatal"
NRQL: FROM Log SELECT * WHERE a = 'error in module' AND b = 'error | fatal' AND c = 'key=value' AND d = '' AND e = '日本語エラー' AND f = 'error, fatal'
```

```
✅ Confirmed by human
SPL:  message="error in module"
NRQL: FROM Log SELECT * WHERE message = 'error in module'
```

```
✅ Confirmed by human
SPL:  index=web user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64)" | stats count by host
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```
<!-- /spl-cases -->

## NRQL Reserved Words as Field Names

Fields that collide with NRQL reserved words are backtick-escaped.

<!-- spl-cases: nrql-keywords -->
```
✅ Confirmed by human
SPL:  my-field=value
NRQL: FROM Log SELECT * WHERE `my-field` = 'value'
```

```
✅ Confirmed by human
SPL:  app:version=1.2.3
NRQL: FROM Log SELECT * WHERE `app:version` = '1.2.3'
```

```
✅ Confirmed by human
SPL:  kubernetes.labels.app:name=myapp
NRQL: FROM Log SELECT * WHERE `kubernetes.labels.app:name` = 'myapp'
```

```
✅ Confirmed by human
SPL:  * | stats count by container-name
NRQL: FROM Log SELECT count(*) FACET `container-name`
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats values(user.groups{}) as user_groups by host
NRQL: FROM Log SELECT uniques(jparse(message, 'user.groups[*]')) AS 'user_groups' FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | table k8s:namespace, k8s:pod
NRQL: FROM Log SELECT `k8s:namespace`, `k8s:pod`
```

```
✅ Confirmed by human
SPL:  log-level IN (error, warn, info)
NRQL: FROM Log SELECT * WHERE `log-level` IN ('error', 'warn', 'info')
```

```
✅ Confirmed by human
SPL:  x-forwarded-for=10.0.0.1
NRQL: FROM Log SELECT * WHERE `x-forwarded-for` = '10.0.0.1'
```

```
✅ Confirmed by human
SPL:  SELECT=200
NRQL: FROM Log SELECT * WHERE `SELECT` = '200' OR numeric(`SELECT`) = 200
```

```
✅ Confirmed by human
SPL:  search_term=hello NOT_FOUND=true top_secret=classified earliest_time=noon where=production table=users stats=enabled
NRQL: FROM Log SELECT * WHERE search_term = 'hello' AND NOT_FOUND = 'true' AND top_secret = 'classified' AND earliest_time = 'noon' AND `where` = 'production' AND table = 'users' AND stats = 'enabled'
```

```
✅ Confirmed by human
SPL:  bytecount=1024
NRQL: FROM Log SELECT * WHERE bytecount = '1024' OR numeric(bytecount) = 1024
```
<!-- /spl-cases -->

## Metadata Fields (index, sourcetype, source, host)

SPL metadata fields that have no direct NRQL equivalent are translated as attribute filters with a warning.

<!-- spl-cases: metadata-fields -->
```
✅ Confirmed by human
SPL:  index=web
NRQL: FROM Log SELECT * WHERE index = 'web'
```

```
✅ Confirmed by human
SPL:  sourcetype=access_*
NRQL: FROM Log SELECT * WHERE sourcetype LIKE 'access_%'
```
<!-- /spl-cases -->

---

# Graceful Degradation

## Empty and Invalid Input

How the translator handles empty strings, null, and malformed SPL.

<!-- spl-cases: empty-invalid -->
```
✅ Confirmed by human
SPL:  (empty)
NRQL: FROM Log SELECT *
```

```
✅ Confirmed by human
SPL:  (empty)
NRQL: FROM Log SELECT *
```

```
✅ Confirmed by human
SPL:  |||
NRQL: FROM Log SELECT *
```

```
✅ Confirmed by human
SPL:  back`tick=value
```

```
✅ Confirmed by human
SPL:     
NRQL: FROM Log SELECT *
```

```
✅ Confirmed by human
SPL:  message=
```

```
✅ Confirmed by human
SPL:  message=fn(x)
```

```
✅ Confirmed by human
SPL:  status IN ()
```

```
✅ Confirmed by human
SPL:  https://example.com/path?q=1
```
<!-- /spl-cases -->

## Bare Keywords (full-text search)

Bare keywords without field assignments translate to `message LIKE '%keyword%'`. SPL bare keywords search `_raw` (the raw log line), so `message LIKE` is the correct NRQL equivalent — not `allColumnSearch()`, which searches every column and is extremely expensive.

<!-- spl-cases: bare-keywords -->
```
✅ Confirmed by human
SPL:  error
NRQL: FROM Log SELECT * WHERE message LIKE '%error%'
```

```
✅ Confirmed by human
SPL:  "connection timeout"
NRQL: FROM Log SELECT * WHERE message LIKE '%connection timeout%'
```

```
✅ Confirmed by human
SPL:  error warning
NRQL: FROM Log SELECT * WHERE message LIKE '%error%' AND message LIKE '%warning%'
```

```
✅ Confirmed by human
SPL:  *
NRQL: FROM Log SELECT *
```

```
✅ Confirmed by human
SPL:  100%cpu
NRQL: FROM Log SELECT * WHERE message LIKE '%100\%cpu%'
```

```
✅ Confirmed by human
SPL:  * Operation=\"Add member\"
NRQL: FROM Log SELECT * WHERE Operation = 'Add member'
```

```
🤖 Confirmed by LLM
SPL:  * $global_time.earliest$ $global_time.latest$
NRQL: FROM Log SELECT *
🟡 Earliest=$global_time.earliest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
🟡 Latest=$global_time.latest$ is a dashboard time variable resolved only at run time; it has no static value to translate. This has been dropped — the query will use the dashboard's default time range. To set a fixed bound, use a literal datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").
```

```
✅ Confirmed by human
SPL:  TERM("control-connection-state-change") | stats count
NRQL: FROM Log SELECT count(*) WHERE message LIKE '%control-connection-state-change%'
```

```
✅ Confirmed by human
SPL:  TERM("*peer-system-ip:*") | stats count
NRQL: FROM Log SELECT count(*) WHERE message LIKE '%%peer-system-ip:%%'
```

```
❓ Not confirmed
SPL:  index=web !!Title!!! | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND message LIKE '%!!Title!!!%'
```

```
❓ Not confirmed
SPL:  index=web "brandCode\":\"$brand$" | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND position(lower(message), lower(concat('brandCode":"', {{brand}}))) >= 0
```

```
❓ Not confirmed
SPL:  index=web NOT "code=$c$" | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND position(lower(message), lower(concat('code=', {{c}}))) IS NULL OR position(lower(message), lower(concat('code=', {{c}}))) < 0
```

```
❓ Not confirmed
SPL:  index=web "a":"b" | stats count
🔴 `search` term "a":"b" is a JSON fragment (quoted pieces joined by ':'); Splunk matches it by breaking it into terms, which a text match cannot reproduce — rewrite it as a field comparison (e.g. status=500 after spath) or a single quoted phrase
```

```
❓ Not confirmed
SPL:  index=web "x*$id$" | stats count
🔴 Message="x*$id$" embeds a dashboard token inside literal text. New Relic substitutes a dashboard variable only in value position, never inside a string, so this cannot be translated. Use a standalone token (field=$tok$) or a wildcard-only token (field="*$tok$*").
```
<!-- /spl-cases -->

---

# Edge Cases & Real-World Queries

## Edge Cases

Boundary conditions, unusual syntax, and tricky translations.

<!-- spl-cases: edge-cases -->
```
✅ Confirmed by human
SPL:  * || stats count
NRQL: FROM Log SELECT count(*)
```

```
✅ Confirmed by human
SPL:  * | stats count |
NRQL: FROM Log SELECT count(*)
```

```
✅ Confirmed by human
SPL:  [search index=web | fields host]
NRQL: FROM Log SELECT * WHERE index = 'web'
```

```
✅ Confirmed by human
SPL:  search error
NRQL: FROM Log SELECT * WHERE message LIKE '%error%'
```

```
✅ Confirmed by human
SPL:  | stats count
NRQL: FROM Log SELECT count(*)
```

```
✅ Confirmed by human
SPL:  * | stats count by host | sort - count | head 5
NRQL: FROM Log SELECT count(*) FACET host ORDER BY count DESC LIMIT 5
```

```
✅ Confirmed by human
SPL:  OR status=200
NRQL: FROM Log SELECT * WHERE message LIKE '%OR%' AND status = '200' OR numeric(status) = 200
```

```
🤖 Confirmed by LLM
SPL:  NOT NOT error
NRQL: FROM Log SELECT * WHERE message LIKE '%error%'
```

```
✅ Confirmed by human
SPL:  -500
NRQL: FROM Log SELECT * WHERE message LIKE '%-500%'
```

```
✅ Confirmed by human
SPL:  cpu_usage=95%
NRQL: FROM Log SELECT * WHERE cpu_usage = '95%'
```

```
✅ Confirmed by human
SPL:  host=web,01
NRQL: FROM Log SELECT * WHERE host = 'web,01'
```

```
✅ Confirmed by human
SPL:  path=C:\
NRQL: FROM Log SELECT * WHERE path = 'C:\\'
```

```
✅ Confirmed by human
SPL:  field=***
NRQL: FROM Log SELECT * WHERE field LIKE '%%%'
```

```
✅ Confirmed by human
SPL:  host=*web*server*prod*
NRQL: FROM Log SELECT * WHERE host LIKE '%web%server%prod%'
```

```
✅ Confirmed by human
SPL:  error|stats count
NRQL: FROM Log SELECT count(*) WHERE message LIKE '%error%'
```

```
✅ Confirmed by human
SPL:  status=200	status=300
NRQL: FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 AND status = '300' OR numeric(status) = 300
```

```
✅ Confirmed by human
SPL:  index=web
| stats count by host
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  (a=1 OR (b=2 AND (c=3 OR d=4)))
NRQL: FROM Log SELECT * WHERE a = '1' OR numeric(a) = 1 OR (b = '2' OR numeric(b) = 2 AND c = '3' OR numeric(c) = 3 OR d = '4' OR numeric(d) = 4)
```

```
✅ Confirmed by human
SPL:  status IN (200)
NRQL: FROM Log SELECT * WHERE status IN (200)
```

```
❓ Not confirmed
SPL:  * | head 0
NRQL: FROM Log SELECT * LIMIT 0
```

```
✅ Confirmed by human
SPL:  * error
NRQL: FROM Log SELECT * WHERE message LIKE '%error%'
```

```
✅ Confirmed by human
SPL:  * | where a>1 | where b<2
NRQL: FROM Log SELECT * WHERE numeric(a) > 1 AND numeric(b) < 2
```

```
✅ Confirmed by human
SPL:  * | where (status >= 400 AND status < 500)
NRQL: FROM Log SELECT * WHERE numeric(status) >= 400 AND numeric(status) < 500
```

```
✅ Confirmed by human
SPL:  * | sort -count, +name, host
NRQL: FROM Log SELECT * ORDER BY count DESC
🟡 NRQL ORDER BY supports only one field; additional sort fields ignored
```

```
✅ Confirmed by human
SPL:  * | STATS COUNT BY host
NRQL: FROM Log SELECT count(*) FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | Stats Count By Host
NRQL: FROM Log SELECT count(*) FACET Host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats count() by host
NRQL: FROM Log SELECT count(*) FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats avg(response.time) by host
NRQL: FROM Log SELECT average(`response.time`) FACET host
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  index=web | sort -dc(requestId
```

```
❓ Not confirmed
SPL:  index=web | where "a" LIKE b c
🔴 SPL 'where' arguments could not be parsed near 'LIKE b c' (column 11 of 'where "a" LIKE b c'): Expected "!=", "=", "==", or whitespace but "L" found
```
<!-- /spl-cases -->

## Real-World Queries

Real-world query regression tests are in `test/helpers/spl-real-world.json` (339 queries from customer usage and Splunk security detections).
