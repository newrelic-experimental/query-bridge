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
<!-- spl-table-tags: bin-as-alias, stats-agg, quoted-field-name, eval-plus-arithmetic-regression, where-comparison-rhs, where-bang-negation, where-bang-regression, where-leading-dot-decimal, where-mvcount, sort-leniency, sort-typehint, sort-space-multikey, sort-leading-zero-regression, top-multifield, top-multifield-regression, timechart-by-options, timechart-by-options-regression, tokenizer-empty-list-item, tokenizer-in-space-separated, tokenizer-in-comma-regression, tokenizer-where-no-space, tokenizer-where-space-regression, tokenizer-stats-stray-comma, tokenizer-stats-multi-fn-regression, tokenizer-quote-boundary, tokenizer-quote-boundary-token, tokenizer-quote-boundary-macro, tokenizer-quote-boundary-spaced-regression, tokenizer-quote-boundary-or-regression, tokenizer-quote-boundary-paren-regression, eval-like-apostrophe-regression, where-in-func-regression, regex-apostrophe-regression, regex-template-var-regression -->

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
SPL:  index=web | stats count as web_count | append [search index=api | stats count as api_count]
NRQL: FROM Log SELECT filter(count(*), WHERE index = 'web') AS 'web_count', filter(count(*), WHERE index = 'api') AS 'api_count'
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
🤖 Confirmed by LLM
SPL:  * | dedup userId | stats count by routeName
NRQL: FROM (FROM Log SELECT latest(timestamp) FACET userId LIMIT MAX) SELECT count(*) FACET routeName LIMIT MAX
🟡 `dedup` translated to FACET; add latest(field) for each field you want to keep
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
```

```
❓ Not confirmed
SPL:  (routeName="AddItem" OR routeName="Submit") msg="Processed Server Request.  Status: 200" | eval orders=if(routeName=="Submit",1,0) | dedup userId | eval addtobags=if(routeName=="AddItem",1,0) | timechart eval((sum(orders)*100)/sum(addtobags)) as completionRate span=1m
NRQL: FROM (FROM Log WITH if(routeName = 'Submit', 1, 0) AS orders, if(routeName = 'AddItem', 1, 0) AS addtobags SELECT latest(timestamp) WHERE routeName = 'AddItem' OR routeName = 'Submit' AND msg = 'Processed Server Request.  Status: 200' FACET userId LIMIT MAX) SELECT * LIMIT MAX TIMESERIES 1 minute
🟡 `dedup` translated to FACET; add latest(field) for each field you want to keep
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
🟡 `dedup` with timechart: TIMESERIES on a nested subquery only populates the first time bucket; remaining buckets return null. Consider using uniqueCount() per time bucket instead of nested dedup.
🟡 SPL function eval() has no known NRQL equivalent
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
✅ Confirmed by human
SPL:  * | eventstats sum(bytes) AS total BY host, status
🔴 `eventstats` with multiple BY fields (host, status) cannot be translated; NRQL subquery JOIN only supports a single ON key
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
<!-- /spl-cases -->

## `fillnull` — Supported

Replaces null values with a specified value. Translates to NRQL `WITH if(field IS NULL, default, field) AS field`.

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
✅ Confirmed by human
SPL:  * | fillnull value=0
🔴 `fillnull` without field list not supported — NRQL requires explicit field names
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
```

```
✅ Confirmed by human
SPL:  * | join host [search status=500 | table host, message]
NRQL: FROM Log JOIN (FROM Log SELECT host, message WHERE status = '500' OR numeric(status) = 500 LIMIT MAX) ON host = host SELECT *
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
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
✅ Confirmed by human
SPL:  * | stats count by host | join host [search * | stats avg(cpu) by host]
NRQL: FROM Log JOIN (FROM Log SELECT average(cpu) FACET host LIMIT MAX) ON host = host SELECT count(*) FACET host
🟡 `join` subsearch: NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
🟡 NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | join user [search * | table user, role]
NRQL: FROM Log JOIN (FROM Log SELECT user, role LIMIT MAX) ON user = user SELECT *
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
🔴 `mvexpand` is not supported; NRQL cannot expand multivalue fields into separate rows
```

```
🤖 Confirmed by LLM
SPL:  index=k8s_main bopus orderType=BOPUS storeNumber=* orderNumber=* | stats list(orderNumber) AS orderNumber BY orderStatus storeNumber | mvexpand orderNumber | sort -orderNumber
🟡 SPL list() mapped to NRQL uniques(); duplicates are removed and insertion order is not preserved
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
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
✅ Confirmed by human
SPL:  * | rename src_ip as src user_name as user
NRQL: FROM Log SELECT src_ip AS 'src', user_name AS 'user', *
🟡 NRQL rename keeps original field names alongside aliases
```

```
✅ Confirmed by human
SPL:  * | rename properties.* as *
🔴 Wildcard rename (properties.* as *) not supported in NRQL; rename specific fields
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
✅ Confirmed by human
SPL:  * | rex field=message "(?<ip>\d+\.\d+\.\d+\.\d+)"
NRQL: FROM Log WITH capture(message, r'.*(?P<ip>\d+\.\d+\.\d+\.\d+).*') AS (ip) SELECT *
```

```
✅ Confirmed by human
SPL:  * | rex "user=(?<username>\w+)"
NRQL: FROM Log WITH capture(message, r'.*user=(?P<username>\w+).*') AS (username) SELECT *
```

```
✅ Confirmed by human
SPL:  * | rex field=_raw "From: <(?<from>.*)> To: <(?<to>.*)>"
NRQL: FROM Log WITH capture(message, r'.*From: <(?P<from>.*)> To: <(?P<to>.*)>.*') AS (from, to) SELECT *
```

```
✅ Confirmed by human
SPL:  * | rex field=_raw ".*dlq\/(?P<dlq_key>\d+),"
NRQL: FROM Log WITH capture(message, r'.*dlq\/(?P<dlq_key>\d+),.*') AS (dlq_key) SELECT *
```

```
✅ Confirmed by human
SPL:  * | rex "status=(?<code>\d+)" | stats count by code
NRQL: FROM Log WITH capture(message, r'.*status=(?P<code>\d+).*') AS (code) SELECT count(*) FACET code
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | rex field=message "\"orderId\":\"(?<orderId>[A-Z0-9-]+)\""
NRQL: FROM Log WITH capture(message, r'.*\"orderId\":\"(?P<orderId>[A-Z0-9-]+)\".*') AS (orderId) SELECT *
```

```
🤖 Confirmed by LLM
SPL:  * | rex field=f1 "(?<a>\w+)" | rex field=f2 "(?<b>\w+)" | rex field=f3 "(?<c>\w+)" | rex field=f4 "(?<d>\w+)" | rex field=f5 "(?<e>\w+)" | rex field=f6 "(?<f>\w+)"
NRQL: FROM Log WITH capture(f1, r'.*(?P<a>\w+).*') AS (a), capture(f2, r'.*(?P<b>\w+).*') AS (b), capture(f3, r'.*(?P<c>\w+).*') AS (c), capture(f4, r'.*(?P<d>\w+).*') AS (d), capture(f5, r'.*(?P<e>\w+).*') AS (e), capture(f6, r'.*(?P<f>\w+).*') AS (f) SELECT *
🟡 `query` uses 6 rex extractions but NRQL capture() is limited to 5 per query; consider using aparse() for anchor-based patterns
```

```
✅ Confirmed by human
SPL:  * | rex field=message "\d+"
🔴 `rex` pattern has no named capture groups; nothing to extract
```

```
✅ Confirmed by human
SPL:  * | rex field=message "(?<skus>\d{6,})" max_match=0
🔴 `rex` max_match not supported; NRQL capture() returns first match only
```
<!-- /spl-cases -->

## `rex` (sed mode) — Not supported

Uses sed-like syntax for in-line string substitution. Limited NRQL support via string functions.

<!-- spl-cases: fields-rex-sed -->
```
✅ Confirmed by human
SPL:  * | rex mode=sed field=message "s/old/new/g"
🔴 `rex` mode=sed has no NRQL equivalent
```
<!-- /spl-cases -->

## `rex` (PCRE-only features) — Partial support

PCRE features like lookaheads/lookbehinds and backreferences. NRQL's RE2 regex engine does not support these.

<!-- spl-cases: fields-rex-pcre -->
```
✅ Confirmed by human
SPL:  * | rex field=message "(?<=prefix)(?<val>\w+)"
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
✅ Confirmed by human
SPL:  * | spath path=request.url output=url | rex field=url "(?<domain>[^/]+)"
NRQL: FROM Log WITH jparse(message, 'request.url') AS url, capture(url, r'.*(?P<domain>[^/]+).*') AS (domain) SELECT *
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
✅ Confirmed by human
SPL:  * | spath
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
SPL:  * | stats list(eventType) by orderId
NRQL: FROM Log SELECT uniques(eventType) FACET orderId
🟡 SPL list() mapped to NRQL uniques(); duplicates are removed and insertion order is not preserved
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
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
NRQL: FROM (FROM Log SELECT count(*)) SELECT count(*) TIMESERIES 1 minute
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
❓ Not confirmed
SPL:  * | timechart span=5m count | stats sum(count)
NRQL: FROM (FROM Log SELECT count(*)) SELECT sum(count) TIMESERIES 5 minutes
```

```
🤖 Confirmed by LLM
SPL:  * | dedup userId | timechart count span=1m
NRQL: FROM (FROM Log SELECT latest(timestamp) FACET userId LIMIT MAX) SELECT count(*) LIMIT MAX TIMESERIES 1 minute
🟡 `dedup` translated to FACET; add latest(field) for each field you want to keep
🟡 `dedup` translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields
🟡 `dedup` with timechart: TIMESERIES on a nested subquery only populates the first time bucket; remaining buckets return null. Consider using uniqueCount() per time bucket instead of nested dedup.
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
✅ Confirmed by human
SPL:  * | transaction clientip maxspan=10m
🔴 SPL command 'transaction' has no known NRQL equivalent
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
<!-- /spl-cases -->

## `where` on aggregation result — Supported

Filters aggregation results (equivalent to SQL HAVING). Translates to NRQL `WHERE` on aggregate expressions.

<!-- spl-cases: results-where-on-agg -->
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
❓ Not confirmed
SPL:  * | stats count | eval x = round(total/count, 2)
NRQL: FROM Log WITH round(numeric(total) / numeric(count), 0.01) AS x SELECT count(*)
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
✅ Confirmed by human
SPL:  * | eval x=replace(name, "\\d+", "")
🔴 `replace()` with regex pattern '\d+' not supported — NRQL replace() is literal-only
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "[abc]", "")
🔴 `replace()` with regex pattern '[abc]' not supported — NRQL replace() is literal-only
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "test.*end", "")
🔴 `replace()` with regex pattern 'test.*end' not supported — NRQL replace() is literal-only
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "\d+", "")
🔴 `replace()` with regex pattern '\d+' not supported — NRQL replace() is literal-only
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "foo+", "")
🔴 `replace()` with regex pattern 'foo+' not supported — NRQL replace() is literal-only
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "x?y", "")
🔴 `replace()` with regex pattern 'x?y' not supported — NRQL replace() is literal-only
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "foo|bar", "")
🔴 `replace()` with regex pattern 'foo|bar' not supported — NRQL replace() is literal-only
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "\s+", " ")
🔴 `replace()` with regex pattern '\s+' not supported — NRQL replace() is literal-only
```

```
✅ Confirmed by human
SPL:  * | eval x=replace(uri, "https://example.com/.*", "")
🔴 `replace()` with regex pattern 'https://example.com/.*' not supported — NRQL replace() is literal-only
```

```
✅ Confirmed by human
SPL:  * | eval json_content=replace(json_content, "'", "\"") | spath input=json_content
🔴 `spath` without path= does auto-extraction, which has no NRQL equivalent; specify path= to extract a specific JSON field
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
✅ Confirmed by human
SPL:  * | eval x=mvindex(split(data, ","), 0)
NRQL: FROM Log WITH getField(split(data, ','), 0) AS x SELECT *
```

```
✅ Confirmed by human
SPL:  * | eval joined = mvjoin(tags, ", ")
🔴 `mvjoin()` has no NRQL equivalent — NRQL cannot join array elements into a delimited string
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
✅ Confirmed by human
SPL:  * | regex message="error\\d+"
NRQL: FROM Log SELECT * WHERE message RLIKE r'error\\d+'
```

```
✅ Confirmed by human
SPL:  * | regex status!="^2\\d{2}$"
NRQL: FROM Log SELECT * WHERE status NOT RLIKE r'^2\\d{2}$'
```

```
✅ Confirmed by human
SPL:  * | regex "fatal|critical"
NRQL: FROM Log SELECT * WHERE message RLIKE r'fatal|critical'
```

```
✅ Confirmed by human
SPL:  status=500 | regex message="timeout"
NRQL: FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND message RLIKE r'timeout'
```

```
✅ Confirmed by human
SPL:  * | regex uri_path="^/api/v[0-9]+"
NRQL: FROM Log SELECT * WHERE uri_path RLIKE r'^/api/v[0-9]+'
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
| `list(field)` | `uniques(field)` | list() mapped to NRQL uniques(); duplicates are removed and insertion order is not preserved |
| `xyzfunc(field)` | `*` | function xyzfunc() has no known NRQL equivalent |
| `estdc(field)` | `uniqueCount(field)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `exactperc95(field)` | `percentile(field, 95)` | exactperc95() mapped to NRQL percentile(); precision may differ |
| `upperperc99(field)` | `percentile(field, 99)` | upperperc99() mapped to NRQL percentile(); precision may differ |
| `per_second(field)` | `rate(sum(field), 1 second)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `per_minute(field)` | `rate(sum(field), 1 minute)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `per_hour(field)` | `rate(sum(field), 1 hour)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `per_day(field)` | `—` |  |
| `max(field)` | `max(numeric(field) / 1000)` | NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups. |
| `perc95(field)` | `—` |  |
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
SPL:  * | stats list(user) by host
NRQL: FROM Log SELECT uniques(user) FACET host
🟡 SPL list() mapped to NRQL uniques(); duplicates are removed and insertion order is not preserved
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats xyzfunc(field) by host
NRQL: FROM Log SELECT * FACET host
🟡 SPL function xyzfunc() has no known NRQL equivalent
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
<!-- /spl-cases -->

## Stats Functions with No NRQL Equivalent

<!-- spl-table: stats-no-equiv -->
| SPL function | Notes |
|---|---|
| `mode(field)` | Has no direct NRQL equivalent; consider FACET field LIMIT 1 to find most common value |
| `earliest_time(field)` | Has no NRQL equivalent; earliest() returns the value, not the timestamp |
| `rate_avg(field)` | Is Splunk metrics-specific; no NRQL equivalent |
<!-- /spl-table -->

<!-- spl-cases: stats-no-equiv -->
```
✅ Confirmed by human
SPL:  * | stats mode(status) by host
NRQL: FROM Log SELECT * FACET host
🟡 SPL mode() has no direct NRQL equivalent; consider FACET field LIMIT 1 to find most common value
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats earliest_time(message) as first_seen by host
NRQL: FROM Log SELECT * FACET host
🟡 SPL earliest_time() has no NRQL equivalent; earliest() returns the value, not the timestamp
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
```

```
✅ Confirmed by human
SPL:  * | stats rate_avg(cpu) by host
NRQL: FROM Log SELECT * FACET host
🟡 SPL rate_avg() is Splunk metrics-specific; no NRQL equivalent
🟡 NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.
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
🤖 Confirmed by LLM
SPL:  index=web status=$sev$ | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND status = '$sev$'
```

```
🤖 Confirmed by LLM
SPL:  index=web earliestSeen=$earliestSeen$ | stats count
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND earliestSeen = '$earliestSeen$'
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
✅ Confirmed by human
SPL:  _raw=*error*
NRQL: FROM Log SELECT * WHERE message LIKE '%error%'
🟡 `_raw` is not a valid NRQL field; mapped to message
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
<!-- /spl-cases -->

## Real-World Queries

Real-world query regression tests are in `test/helpers/spl-real-world.json` (339 queries from customer usage and Splunk security detections).
