# SPL-to-NRQL Translation Reference

<!-- AI-DEV: Code blocks between spl-cases/spl-table sentinels are auto-generated from test cases in spl.test.js. Do NOT edit them manually. Edit the prose freely. -->

<!-- sort-order: status -->

## CLI tool

The SPL-to-NRQL translator is available as a standalone command-line tool. It requires Node.js 20 or later.

### Quick start

```bash
# From the repo root, build the CLI bundle (one-time, or after spl.js changes):
npm run build:cli

# Translate a query:
node bin/spl2nrql.js "index=web status=500 | stats count by host"

# Pipe from stdin:
echo "index=web | stats count" | node bin/spl2nrql.js

# Interactive REPL:
node bin/spl2nrql.js -i
```

### Install globally (optional)

If you want the `spl2nrql` command available anywhere:

```bash
# From the repo root:
npm link

# Now you can run from any directory:
spl2nrql "index=web | stats count by host"
```

To unlink later: `npm unlink -g @datanerd/shared-component-logs`

### Output formats

By default the tool prints the assembled NRQL string to stdout. Warnings and errors go to stderr so they don't interfere with piping.

```bash
# NRQL string (default):
node bin/spl2nrql.js "index=web | stats count"
# → FROM Log SELECT count(*) WHERE `index` = 'web'

# Full result as JSON:
node bin/spl2nrql.js --json "index=web | stats count"
# → { "where": "`index` = 'web'", "select": ["count(*)"], ... }
```

### Interactive REPL

```
$ node bin/spl2nrql.js -i
SPL-to-NRQL translator. Type .quit or Ctrl-D to exit.
spl> index=web status=500 | stats count by host
FROM Log SELECT count(*) WHERE `index` = 'web' AND (`status` = '500' OR numeric(`status`) = 500) FACET `host`
spl> .quit
```

### Options reference

| Flag | Description |
|---|---|
| `-h`, `--help` | Show help |
| `-i`, `--interactive` | Start interactive REPL |
| `--nrql` | Output assembled NRQL string (default) |
| `--json` | Output full translation result as JSON |
| `--no-telemetry` | Disable usage telemetry for this invocation |

### Usage telemetry (optional)

If you want translated queries logged to NRDB so the team can see what SPL patterns people are translating, create a `.env` file in the repo root:

```bash
cp .env.example .env
# Then edit .env with your values:
```

```
NEW_RELIC_LICENSE_KEY=your_ingest_license_key_here
NEW_RELIC_ACCOUNT_ID=1
```

The license key is write-only (ingest) — it can only send events, not read anything. Translations are sent as `SplToNrqlTranslation` custom events. You can query them with:

```sql
FROM SplToNrqlTranslation SELECT spl, nrql, warningCount, unsupportedCount SINCE 1 week ago
```

To disable telemetry for a single run, use `--no-telemetry`. If no `.env` file exists, telemetry is silently skipped.

### Rebuilding the bundle

The CLI uses a pre-built bundle (`bin/spl2nrql-bundle.cjs`) checked into the repo. After editing `spl.js`, `spl.grammar`, or `nrqlEncoding.js`, rebuild it:

```bash
npm run build:cli
```

This uses `esbuild` (downloaded on demand via `npx`) to bundle the ESM translator into a single CJS file.

---

## How this document works

The code blocks in this document are **generated from the test suite** (`test/helpers/spl.test.js`). Every test case has a `doc: 'section-tag'` field that maps it to a section here. The `afterAll` hook runs the translator + assembler on each case and writes the results between sentinel markers.

**To update the examples:** add or modify test cases in `spl.test.js`, then run the tests. The doc updates automatically.

**To change sort order:** edit the `<!-- sort-order: status -->` comment above. Values: `status` (green → yellow → red → gray) or `alpha` (alphabetical by SPL).

## Legend

| Background | Meaning |
|---|---|
| 🟢 Green (`#d4edda`) | Supported — translates to valid NRQL |
| 🔴 Red (`#f8d7da`) | Not supported — has unsupported messages |
| 🟡 Yellow (`#fff3cd`) | Warning — on individual items within a green case |

| Label | Meaning |
|---|---|
| ✅ Confirmed by human | All of the below, plus human-checked the SPL and NRQL commands |
| 🤖 Confirmed by LLM | NRQL compiles (via MCP query against account 1), red-green-refactor per llm-test-verification.md, and LLM review of SPL/NRQL semantics and descriptions |
| 🔍 Confirmed by MCP | NRQL compiles (via MCP query against account 1) but no red-green-refactor or semantic review |
| ❓ Not confirmed | No explicit verification |

<!-- toc -->
- [Heavily Used Commands (50+ occurrences)](#heavily-used-commands-50-occurrences)
  - [Pipe Commands](#pipe-commands)
  - [Eval Functions](#eval-functions)
  - [Comparison and Conditional](#comparison-and-conditional)
  - [String Functions](#string-functions)
  - [Math Functions](#math-functions)
  - [Type Conversion](#type-conversion)
  - [Multivalue Functions](#multivalue-functions)
  - [Date/Time Functions — Not supported](#date-time-functions-not-supported)
- [Moderate Use Commands (20–49 occurrences)](#moderate-use-commands-20-49-occurrences)
  - [Pipe Commands](#pipe-commands)
- [Rare Use Commands (1–19 occurrences)](#rare-use-commands-1-19-occurrences)
  - [Pipe Commands](#pipe-commands)
- [No Observed Usage](#no-observed-usage)
  - [Pipe Commands](#pipe-commands)
  - [Subsearch](#subsearch)
  - [Internal](#internal)
  - [3rd-Party and Custom Commands](#3rd-party-and-custom-commands)
  - [Unknown commands](#unknown-commands)
- [Statistical and Charting Functions](#statistical-and-charting-functions)
  - [Stats Function Mapping](#stats-function-mapping)
  - [Stats Functions with No NRQL Equivalent](#stats-functions-with-no-nrql-equivalent)
- [Time Format Variables and Modifiers](#time-format-variables-and-modifiers)
  - [Time constraints (earliest/latest)](#time-constraints-earliest-latest)
  - [Macros](#macros)
- [Search Syntax](#search-syntax)
  - [Field Comparisons](#field-comparisons)
  - [JSON Array Access](#json-array-access)
  - [Boolean Operators (AND, OR, NOT)](#boolean-operators-and-or-not)
  - [IN Operator](#in-operator)
  - [Wildcards](#wildcards)
  - [Quoted Strings and Escaping](#quoted-strings-and-escaping)
  - [NRQL Reserved Words as Field Names](#nrql-reserved-words-as-field-names)
  - [Metadata Fields (index, sourcetype, source, host)](#metadata-fields-index-sourcetype-source-host)
- [Graceful Degradation](#graceful-degradation)
  - [Empty and Invalid Input](#empty-and-invalid-input)
  - [Bare Keywords (full-text search)](#bare-keywords-full-text-search)
- [Edge Cases & Real-World Queries](#edge-cases-real-world-queries)
  - [Edge Cases](#edge-cases)
  - [Real-World Queries](#real-world-queries)
<!-- /toc -->

---

## Heavily Used Commands (50+ occurrences)

Commands that appear in 50 or more real-world customer queries or security detections. These are the commands that matter most for migration.

---

### Pipe Commands

#### `append` — Supported

Appends the results of a subsearch to the current results. The translator merges the main query and subsearch into a single NRQL query — using `filter()` when the WHERE clauses differ, or a combined SELECT when they match.

<!-- spl-cases: correlation-append -->
```
🤖 Confirmed by LLM
SPL:  index=main "Cache hit" | stats count as Hits | append [search index=main "Cache miss" | stats count as Misses]
NRQL: FROM Log SELECT filter(count(*), WHERE index = 'main' AND message LIKE '%Cache hit%') AS 'Hits', filter(count(*), WHERE index = 'main' AND message LIKE '%Cache miss%') AS 'Misses'
```

> [!WARNING]
> `append` translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log

---

```
🤖 Confirmed by LLM
SPL:  * | stats avg(duration) | append [search * | stats max(duration)]
NRQL: FROM Log SELECT average(duration), max(duration)
```

> [!WARNING]
> `append` merged into a single query; SPL append runs the subsearch independently, but here both sides query the same events

---

```
🤖 Confirmed by LLM
SPL:  error | stats count by host | append [search success | stats count by host]
NRQL: FROM Log SELECT filter(count(*), WHERE message LIKE '%error%'), filter(count(*), WHERE message LIKE '%success%') FACET host
```

> [!WARNING]
> `append` translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log

---

```
🤖 Confirmed by LLM
SPL:  * | stats count by host | append [search * | stats avg(duration) by host]
NRQL: FROM Log SELECT count(*), average(duration) FACET host
```

> [!WARNING]
> `append` merged into a single query; SPL append runs the subsearch independently, but here both sides query the same events

---

```
🤖 Confirmed by LLM
SPL:  error | stats avg(duration) as err_dur | append [search success | stats avg(duration) as ok_dur]
NRQL: FROM Log SELECT filter(average(duration), WHERE message LIKE '%error%') AS 'err_dur', filter(average(duration), WHERE message LIKE '%success%') AS 'ok_dur'
```

> [!WARNING]
> `append` translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log

---

```
🤖 Confirmed by LLM
SPL:  error | stats avg(duration) | append [search success | stats max(duration)]
NRQL: FROM Log SELECT filter(average(duration), WHERE message LIKE '%error%'), filter(max(duration), WHERE message LIKE '%success%')
```

> [!WARNING]
> `append` translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log

---

```
🤖 Confirmed by LLM
SPL:  * | append [search error]
NRQL: 
```

> [!CAUTION]
> `append` with subsearch cannot be automatically translated; consider using filter() to compute multiple aggregations in a single query

---

```
🤖 Confirmed by LLM
SPL:  * | stats count as total | append [search * | stats avg(duration) by host]
NRQL: 
```

> [!CAUTION]
> `append` with subsearch cannot be automatically translated; the main query and subsearch group by different fields

---
<!-- /spl-cases -->

#### `appendcols` — Supported

Adds subsearch results as new columns. Uses the same merge logic as `append` — merges into a single SELECT or uses `filter()` when WHERE clauses differ.

<!-- spl-cases: correlation-appendcols -->
```
🤖 Confirmed by LLM
SPL:  index=main | stats count as total_requests | appendcols [search index=main level=error | stats count as errors]
NRQL: FROM Log SELECT filter(count(*), WHERE index = 'main') AS 'total_requests', filter(count(*), WHERE index = 'main' AND level = 'error') AS 'errors'
```

> [!WARNING]
> `appendcols` translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log

---

```
🤖 Confirmed by LLM
SPL:  * | stats count as total | appendcols [search * | stats count by host]
NRQL: 
```

> [!CAUTION]
> `appendcols` with subsearch cannot be automatically translated; the main query and subsearch group by different fields

---
<!-- /spl-cases -->

#### `appendpipe` — Supported

Runs a subpipeline and appends results. In practice, used for zero-fill fallbacks which are a no-op in NRQL (dashboards handle empty results natively). Ignored with a warning.

<!-- spl-cases: correlation-appendpipe -->
```
🤖 Confirmed by LLM
SPL:  * | stats count as search_count | appendpipe [stats count | where count=0]
NRQL: FROM Log SELECT count(*) AS 'search_count'
```

> [!WARNING]
> `appendpipe` adds summary rows to results; NRQL cannot append rows to a query. The sub-pipeline aggregation is available as a nested query, but the "append as new row" behavior must be handled by the UI.

---
<!-- /spl-cases -->

#### `bin` / `bucket` — Supported

Groups continuous numeric values into discrete buckets. `bin _time span=X` translates to `TIMESERIES X`. `bin field span=N` translates to `FACET histogram(field, N)`.

<!-- spl-cases: reports-bin -->
```
✅ Confirmed by human
SPL:  * | bin _time span=5m
NRQL: FROM Log SELECT count(*) TIMESERIES 5 minutes
```

---

```
✅ Confirmed by human
SPL:  * | bucket _time span=5m
NRQL: FROM Log SELECT count(*) TIMESERIES 5 minutes
```

---

```
🤖 Confirmed by LLM
SPL:  * | bucket span=5m _time | stats count by _time
NRQL: FROM Log SELECT count(*) TIMESERIES 5 minutes
```

---

```
🤖 Confirmed by LLM
SPL:  * | bin size span=10
NRQL: FROM Log SELECT histogram(size, 10)
```

---
<!-- /spl-cases -->

#### `chart` — Supported

Creates a data table suitable for charting. Translates to NRQL `SELECT ... FACET ... TIMESERIES`.

<!-- spl-cases: reports-chart -->
```
✅ Confirmed by human
SPL:  * | chart count by status
NRQL: FROM Log SELECT count(*) FACET status
```

---
<!-- /spl-cases -->

#### `convert` — Partial support

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
🤖 Confirmed by LLM
SPL:  * | convert num(bytes)
NRQL: FROM Log WITH numeric(bytes) AS bytes_converted SELECT *
```

> [!WARNING]
> `convert` num(bytes): NRQL cannot overwrite a field in-place; aliased to bytes_converted

---

```
🤖 Confirmed by LLM
SPL:  * | convert rmcomma(total)
NRQL: FROM Log WITH numeric(replace(total, ',', '')) AS total_converted SELECT *
```

> [!WARNING]
> `convert` rmcomma(total): NRQL cannot overwrite a field in-place; aliased to total_converted

---

```
🤖 Confirmed by LLM
SPL:  * | convert ctime(timestamp) AS readable
NRQL: FROM Log WITH toDatetime(timestamp) AS readable SELECT *
```

---

```
🤖 Confirmed by LLM
SPL:  * | convert mktime(timestr)
NRQL: FROM Log WITH toTimestamp(timestr) AS timestr_converted SELECT *
```

> [!WARNING]
> `convert` mktime(timestr): NRQL cannot overwrite a field in-place; aliased to timestr_converted

---

```
🤖 Confirmed by LLM
SPL:  * | convert dur2sec(duration)
NRQL: FROM Log WITH numeric(duration) AS duration_converted SELECT *
```

> [!WARNING]
> `convert` dur2sec(duration): NRQL has no duration parser; using numeric(duration) as approximation — verify data format
>
> `convert` dur2sec(duration): NRQL cannot overwrite a field in-place; aliased to duration_converted

---

```
🤖 Confirmed by LLM
SPL:  * | convert mstime(elapsed)
NRQL: FROM Log WITH numeric(elapsed) AS elapsed_converted SELECT *
```

> [!WARNING]
> `convert` mstime(elapsed): NRQL has no mm:ss.ms parser; using numeric(elapsed) as approximation — verify data format
>
> `convert` mstime(elapsed): NRQL cannot overwrite a field in-place; aliased to elapsed_converted

---

```
🤖 Confirmed by LLM
SPL:  * | convert num(status), rmcomma(total)
NRQL: FROM Log WITH numeric(status) AS status_converted, numeric(replace(total, ',', '')) AS total_converted SELECT *
```

> [!WARNING]
> `convert` num(status): NRQL cannot overwrite a field in-place; aliased to status_converted
>
> `convert` rmcomma(total): NRQL cannot overwrite a field in-place; aliased to total_converted

---

```
🤖 Confirmed by LLM
SPL:  * | convert auto(field)
NRQL: FROM Log WITH numeric(field) AS field_converted SELECT *
```

> [!WARNING]
> `convert` auto(field): NRQL cannot overwrite a field in-place; aliased to field_converted

---

```
🤖 Confirmed by LLM
SPL:  * | convert rmunit(field)
NRQL: 
```

> [!CAUTION]
> `convert` rmunit(field) not supported in NRQL

---

```
🤖 Confirmed by LLM
SPL:  * | convert memk(field)
NRQL: 
```

> [!CAUTION]
> `convert` memk(field) not supported in NRQL

---
<!-- /spl-cases -->

#### `dedup` — Supported

Removes duplicate events based on field values. Translates to NRQL `FACET` with `LIMIT MAX`, which groups results by unique field combinations. Add `latest(field)` for each field you want to keep from the original events.

<!-- spl-cases: results-dedup -->
```
🤖 Confirmed by LLM
SPL:  * | dedup host
NRQL: FROM Log SELECT latest(timestamp) FACET host LIMIT MAX
```

> [!WARNING]
> `dedup` translated to FACET; add latest(field) for each field you want to keep

---

```
🤖 Confirmed by LLM
SPL:  * | dedup host, status
NRQL: FROM Log SELECT latest(timestamp) FACET host, status LIMIT MAX
```

> [!WARNING]
> `dedup` translated to FACET; add latest(field) for each field you want to keep

---

```
🤖 Confirmed by LLM
SPL:  * | stats count by host | dedup host
NRQL: FROM Log SELECT count(*) FACET host LIMIT MAX
```

> [!WARNING]
> `dedup` translated to FACET; add latest(field) for each field you want to keep

---
<!-- /spl-cases -->

#### `eval` — Supported

Calculates an expression and puts the result into a field. Translates to NRQL `WITH ... AS` expressions.

<!-- spl-cases: fields-eval-arithmetic -->
```
✅ Confirmed by human
SPL:  * | eval d = bytes / 1024, m = price * quantity, a = sent + received, s = end_time - start_time, r = x % 10
NRQL: FROM Log WITH numeric(bytes) / 1024 AS d, numeric(price) * numeric(quantity) AS m, numeric(sent) + numeric(received) AS a, numeric(end_time) - numeric(start_time) AS s, mod(numeric(x), 10) AS r SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval p1 = a * b + c, p2 = a + b / c, p3 = (a + b) / c, p4 = (a + b) * (c - d)
NRQL: FROM Log WITH numeric(a) * numeric(b) + numeric(c) AS p1, numeric(a) + numeric(b) / numeric(c) AS p2, (numeric(a) + numeric(b)) / numeric(c) AS p3, (numeric(a) + numeric(b)) * (numeric(c) - numeric(d)) AS p4 SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval pct = count / 100.0, chain = a + b + c + d, mul = a * b * c, kb = bytes / 1024, mb = bytes / 1048576, gb = bytes / 1073741824
NRQL: FROM Log WITH numeric(count) / 100 AS pct, numeric(a) + numeric(b) + numeric(c) + numeric(d) AS chain, numeric(a) * numeric(b) * numeric(c) AS mul, numeric(bytes) / 1024 AS kb, numeric(bytes) / 1048576 AS mb, numeric(bytes) / 1073741824 AS gb SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval size_mb = bytes / 1048576 | eval size_gb = size_mb / 1024 | stats avg(size_mb) by host
NRQL: FROM Log WITH numeric(bytes) / 1048576 AS size_mb, numeric(size_mb) / 1024 AS size_gb SELECT average(size_mb) FACET host
```

---

```
✅ Confirmed by human
SPL:  status=200 | eval duration_sec = duration / 1000 | table host, duration_sec
NRQL: FROM Log WITH numeric(duration) / 1000 AS duration_sec SELECT host, duration_sec WHERE status = '200' OR numeric(status) = 200
```

---

```
✅ Confirmed by human
SPL:  * | eval x=a+b, alias = original, lit = 42, parens = ((a + b)), hyph = http-status / 100, col = aws:region, dot = http.status / 100
NRQL: FROM Log WITH numeric(a) + numeric(b) AS x, original AS alias, 42 AS lit, numeric(a) + numeric(b) AS parens, numeric(`http-status`) / 100 AS hyph, `aws:region` AS col, numeric(`http.status`) / 100 AS dot SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | spath input=payload path=user.id output=uid | eval uid_num = uid / 1
NRQL: FROM Log WITH jparse(payload, 'user.id') AS uid, numeric(uid) / 1 AS uid_num SELECT *
```

> [!WARNING]
> `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead

---

```
✅ Confirmed by human
SPL:  * | fillnull value=0 bytes | eval kb = bytes / 1024
NRQL: FROM Log WITH numeric(bytes OR 0) / 1024 AS kb SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval rate = count / duration | sort -rate | head 10
NRQL: FROM Log WITH numeric(count) / numeric(duration) AS rate SELECT * ORDER BY rate DESC LIMIT 10
```

---

```
❓ Not confirmed
SPL:  * | eval kb = bytes / 1024 | rename kb as kilobytes
NRQL: FROM Log WITH numeric(bytes) / 1024 AS kb SELECT kb AS 'kilobytes', *
```

> [!WARNING]
> NRQL rename keeps original field names alongside aliases

---
<!-- /spl-cases -->

#### `eventstats` — Supported

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
   SPL: index=infra | eventstats max(_time) as lastImport by source | where _time=lastImport
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
🤖 Confirmed by LLM
SPL:  * | eventstats count by host
NRQL: FROM Log JOIN (FROM Log SELECT count(*) AS 'count' FACET host LIMIT MAX) ON host = host SELECT *
```

> [!WARNING]
> NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit

---

```
🤖 Confirmed by LLM
SPL:  * | eventstats avg(duration) AS avg_dur BY host
NRQL: FROM Log JOIN (FROM Log SELECT average(duration) AS 'avg_dur' FACET host LIMIT MAX) ON host = host SELECT *
```

> [!WARNING]
> NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit

---

```
🤖 Confirmed by LLM
SPL:  * | eventstats count AS total
NRQL: FROM Log SELECT *, (FROM Log SELECT count(*)) AS 'total'
```

> [!WARNING]
> `eventstats` without BY translated as scalar subquery in SELECT; for percentage calculations, use the subquery result in downstream eval

---

```
❓ Not confirmed
SPL:  * | stats count as appCount by app | eventstats sum(appCount) as namespaceCount
NRQL: FROM Log SELECT count(*) AS 'appCount', (FROM (FROM Log SELECT count(*) AS 'appCount' FACET app LIMIT MAX) SELECT sum(appCount)) AS 'namespaceCount' FACET app
```

> [!WARNING]
> `eventstats` without BY translated as scalar subquery in SELECT; for percentage calculations, use the subquery result in downstream eval

---

```
🤖 Confirmed by LLM
SPL:  * | eventstats max(timestamp) as lastImport BY source
NRQL: FROM Log JOIN (FROM Log SELECT max(timestamp) AS 'lastImport' FACET source LIMIT MAX) ON source = source SELECT *
```

> [!WARNING]
> NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit

---

```
🤖 Confirmed by LLM
SPL:  * | eventstats avg(duration) AS avg_dur, max(duration) AS max_dur BY host
NRQL: FROM Log JOIN (FROM Log SELECT average(duration) AS 'avg_dur', max(duration) AS 'max_dur' FACET host LIMIT MAX) ON host = host SELECT *
```

> [!WARNING]
> NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit

---

```
🤖 Confirmed by LLM
SPL:  * | eventstats sum(bytes) AS total BY host, status
NRQL: 
```

> [!CAUTION]
> `eventstats` with multiple BY fields (host, status) cannot be translated; NRQL subquery JOIN only supports a single ON key

---
<!-- /spl-cases -->

#### `extract` (`kv`) — Not supported

Extracts key-value pairs using automatic field discovery. NRQL has no equivalent to automatic key-value extraction. Use `rex` (capture()) for regex-based extraction or `spath` (jparse()) for structured data.

<!-- spl-cases: fields-extract -->
```
🤖 Confirmed by LLM
SPL:  * | extract pairdelim=","
NRQL: 
```

> [!CAUTION]
> SPL command 'extract' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `table` / `fields` — Partial support

Selects which fields to include in the results. Both `table` and `fields` translate to NRQL `SELECT field1, field2, ...`. The exclude syntax (`fields - field1, field2`) is not supported — NRQL cannot exclude specific fields from `SELECT *`.

<!-- spl-cases: results-table -->
```
🤖 Confirmed by LLM
SPL:  * | table _time, host, status, bytes, url
NRQL: FROM Log SELECT timestamp, host, status, bytes, url
```

---

```
🤖 Confirmed by LLM
SPL:  * | table *
NRQL: FROM Log SELECT *
```

---

```
🤖 Confirmed by LLM
SPL:  * | fields host, status
NRQL: FROM Log SELECT host, status
```

---

```
🤖 Confirmed by LLM
SPL:  * | fields _time, host, status
NRQL: FROM Log SELECT timestamp, host, status
```

---

```
🤖 Confirmed by LLM
SPL:  * | fields + host, status
NRQL: FROM Log SELECT host, status
```

---

```
🤖 Confirmed by LLM
SPL:  * | fields - _raw, _time
NRQL: FROM Log SELECT *
```

> [!WARNING]
> `fields` - (exclude mode) has limited NRQL support

---
<!-- /spl-cases -->

#### `fillnull` — Supported

Replaces null values with a specified value. Translates to NRQL `WITH if(field IS NULL, default, field) AS field`.

<!-- spl-cases: fields-fillnull -->
```
✅ Confirmed by human
SPL:  * | fillnull value=N/A host status
NRQL: FROM Log SELECT host OR 'N/A', status OR 'N/A', *
```

---

```
✅ Confirmed by human
SPL:  * | fillnull value=0 bytes duration
NRQL: FROM Log SELECT bytes OR 0, duration OR 0, *
```

---

```
✅ Confirmed by human
SPL:  * | fillnull bytes
NRQL: FROM Log SELECT bytes OR '0', *
```

---

```
✅ Confirmed by human
SPL:  * | fillnull value="unknown" host
NRQL: FROM Log SELECT host OR 'unknown', *
```

---

```
✅ Confirmed by human
SPL:  * | fillnull value=0 bytes | stats sum(bytes) by host
NRQL: FROM Log SELECT sum(bytes OR 0) FACET host
```

---

```
✅ Confirmed by human
SPL:  * | fillnull value=0 field1, field2, field3
NRQL: FROM Log SELECT field1 OR 0, field2 OR 0, field3 OR 0, *
```

---

```
🤖 Confirmed by LLM
SPL:  * | fillnull value=0
NRQL: 
```

> [!CAUTION]
> `fillnull` without field list not supported — NRQL requires explicit field names

---
<!-- /spl-cases -->

#### `foreach` — Not supported

Runs a template expression over a set of fields matching a wildcard pattern. NRQL has no iterator construct — each field must be referenced explicitly.

<!-- spl-cases: fields-foreach -->
```
🤖 Confirmed by LLM
SPL:  * | foreach count_* [eval total=total+<<FIELD>>]
NRQL: 
```

> [!CAUTION]
> SPL command 'foreach' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `head` — Supported

Returns the first N results. Translates to NRQL `LIMIT N`.

<!-- spl-cases: results-head -->
```
✅ Confirmed by human
SPL:  * | head 10
NRQL: FROM Log SELECT * LIMIT 10
```

---

```
✅ Confirmed by human
SPL:  * | head
NRQL: FROM Log SELECT * LIMIT 10
```

---
<!-- /spl-cases -->

#### `join` — Supported

Combines results from a subsearch with current results using a shared field. Translates to NRQL `JOIN ... ON`.

<!-- spl-cases: correlation-join -->
```
🤖 Confirmed by LLM
SPL:  * | join host [search index=other | stats count by host]
NRQL: FROM Log JOIN (FROM Log SELECT count(*) WHERE index = 'other' FACET host LIMIT MAX) ON host = host SELECT *
```

> [!WARNING]
> NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit

---

```
🤖 Confirmed by LLM
SPL:  * | join type=left src_ip [search index=geo | table src_ip, country]
NRQL: FROM Log LEFT JOIN (FROM Log SELECT country WHERE index = 'geo' FACET src_ip LIMIT MAX) ON src_ip = src_ip SELECT *
```

> [!WARNING]
> NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit

---

```
🤖 Confirmed by LLM
SPL:  * | join host [search status=500 | table host, message]
NRQL: FROM Log JOIN (FROM Log SELECT message WHERE status = '500' OR numeric(status) = 500 FACET host LIMIT MAX) ON host = host SELECT *
```

> [!WARNING]
> NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit

---

```
🤖 Confirmed by LLM
SPL:  * | join src_ip [search * | stats count, avg(bytes) by src_ip]
NRQL: FROM Log JOIN (FROM Log SELECT count(*), average(bytes) FACET src_ip LIMIT MAX) ON src_ip = src_ip SELECT *
```

> [!WARNING]
> NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit

---

```
🤖 Confirmed by LLM
SPL:  * | join host [search * | stats count by host | head 100]
NRQL: FROM Log JOIN (FROM Log SELECT count(*) FACET host LIMIT 100) ON host = host SELECT *
```

> [!WARNING]
> NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit

---

```
❓ Not confirmed
SPL:  * | join host [search status=200 host=web*]
NRQL: FROM Log JOIN (FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 AND host LIKE 'web%' FACET host LIMIT MAX) ON host = host SELECT *
```

> [!WARNING]
> NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit

---

```
🤖 Confirmed by LLM
SPL:  status=500 | join host [search * | stats count by host]
NRQL: FROM Log JOIN (FROM Log SELECT count(*) FACET host LIMIT MAX) ON host = host SELECT * WHERE status = '500' OR numeric(status) = 500
```

> [!WARNING]
> NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit

---

```
🤖 Confirmed by LLM
SPL:  * | stats count by host | join host [search * | stats avg(cpu) by host]
NRQL: FROM Log JOIN (FROM Log SELECT average(cpu) FACET host LIMIT MAX) ON host = host SELECT count(*) FACET host
```

> [!WARNING]
> NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit

---

```
❓ Not confirmed
SPL:  * | join user [search * | table user, role]
NRQL: FROM Log JOIN (FROM Log SELECT role FACET user LIMIT MAX) ON user = user SELECT *
```

> [!WARNING]
> NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit

---

```
🤖 Confirmed by LLM
SPL:  * | join type=outer host [search * | stats count by host]
NRQL: 
```

> [!CAUTION]
> NRQL does not support full outer join; only INNER and LEFT joins are available

---
<!-- /spl-cases -->

#### `lookup` — Supported

Enriches events with fields from a lookup table. Translates to NRQL `JOIN` with `lookup()`.

<!-- spl-cases: correlation-lookup -->
```
❓ Not confirmed
SPL:  * | lookup geo_table src_ip
NRQL: FROM Log JOIN (FROM lookup(geo_table) SELECT * FACET src_ip LIMIT MAX) ON src_ip = src_ip SELECT *
```

> [!WARNING]
> Ensure lookup table 'geo_table' is uploaded via the Lookups UI

---

```
🤖 Confirmed by LLM
SPL:  * | lookup ip_to_country src_ip OUTPUT country
NRQL: FROM Log JOIN (FROM lookup(ip_to_country) SELECT country FACET src_ip LIMIT MAX) ON src_ip = src_ip SELECT *
```

> [!WARNING]
> Ensure lookup table 'ip_to_country' is uploaded via the Lookups UI

---

```
🤖 Confirmed by LLM
SPL:  * | lookup users_lookup username AS user OUTPUT department
NRQL: FROM Log JOIN (FROM lookup(users_lookup) SELECT department FACET username LIMIT MAX) ON user = username SELECT *
```

> [!WARNING]
> Ensure lookup table 'users_lookup' is uploaded via the Lookups UI

---
<!-- /spl-cases -->

#### `mvcombine` — Not supported

Combines multivalue field entries into a single multivalue field. NRQL does not have a multivalue field concept.

**Why this exists in Splunk:** Splunk's data model stores everything as flat text. When you use `stats values(field)` or similar commands, the result is a "multivalue field" — essentially an array packed into a single cell. `mvcombine` merges rows that differ only in one field into a single row with a multivalue field. This is Splunk working around its flat data model.

**In New Relic:** Attributes can natively store arrays and nested objects (JSON). There's no need to "combine" rows into multivalue fields — use `uniques()` or `latest()` aggregation functions to collect values, or query the structured data directly.

<!-- spl-cases: fields-mvcombine -->
```
🤖 Confirmed by LLM
SPL:  * | mvcombine delim="," values
NRQL: 
```

> [!CAUTION]
> SPL command 'mvcombine' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `mvexpand` — Partial support

Expands a multivalue field into separate events, one per value. NRQL has no row multiplication (`unnest`/`explode`), but most real-world `mvexpand` patterns achieve goals that NRQL handles differently.

**Why this matters:** `mvexpand` is the 3rd most-used unsupported command. Understanding what customers are *actually trying to do* is key to helping them migrate.

<details>
<summary>What customers actually do with <code>mvexpand</code> — and NRQL alternatives</summary>

#### Pattern 1: Expand-then-filter ("is this value in the array?") — ~40% of usage

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

#### Pattern 2: Dedup round-trip (aggregate then re-expand) — ~30% of usage

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

#### Pattern 3: Symmetric counting (mvappend + mvexpand) — ~10% of usage

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

#### Pattern 4: Expand split results — ~15% of usage

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

#### Pattern 5: No-op on single-value field — ~5% of usage

Sometimes `mvexpand` is applied to a field that is already single-value (defensive coding). This is a no-op in both SPL and NRQL.

</details>

**Migration advice:** Before flagging `mvexpand` as a blocker, identify which pattern the customer is using. Most (~70%) are expand-then-filter or dedup round-trips that NRQL handles without row expansion. The truly unsupported cases are symmetric counting and per-element aggregation across events.

<!-- spl-cases: unsupported-mvexpand -->
```
🤖 Confirmed by LLM
SPL:  * | spath path=cloudformation{}.stack_prefix output=stack_prefix | mvexpand stack_prefix | search stack_prefix="fff000-gitlabrole"
NRQL: FROM Log WITH jparse(message, 'cloudformation[*].stack_prefix') AS stack_prefix SELECT * WHERE stack_prefix = 'fff000-gitlabrole'
```

> [!WARNING]
> `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead
>
> `mvexpand` stack_prefix skipped; NRQL does not expand multivalue fields into rows, but filtering and selection on the field still work

---

```
🤖 Confirmed by LLM
SPL:  * | mvexpand list(orderNumber)
NRQL: FROM Log SELECT *
```

> [!WARNING]
> `mvexpand` list(orderNumber) skipped; NRQL does not expand multivalue fields into rows, but filtering and selection on the field still work

---

```
🤖 Confirmed by LLM
SPL:  * | stats values(title) as title | mvexpand title
NRQL: FROM Log SELECT uniques(title) AS 'title'
```

> [!WARNING]
> `mvexpand` title skipped; NRQL does not expand multivalue fields into rows, but filtering and selection on the field still work

---

```
🤖 Confirmed by LLM
SPL:  * | eval perms=split(permissions, ",") | mvexpand perms | stats count by perms
NRQL: FROM Log WITH split(permissions, ',') AS perms SELECT count(*) FACET perms
```

> [!WARNING]
> `mvexpand` perms skipped; NRQL does not expand multivalue fields into rows, but filtering and selection on the field still work

---

```
🤖 Confirmed by LLM
SPL:  * | eval notable_asset=mvappend(notable_src, notable_dest) | mvexpand notable_asset | stats count by notable_asset
NRQL: FROM Log WITH mvappend(notable_src, notable_dest) AS notable_asset SELECT count(*) FACET notable_asset
```

> [!WARNING]
> `mvexpand` notable_asset skipped; NRQL does not expand multivalue fields into rows, but filtering and selection on the field still work

---

```
🤖 Confirmed by LLM
SPL:  index=k8s_main bopus orderType=BOPUS storeNumber=* orderNumber=* | stats list(orderNumber) AS orderNumber BY orderStatus storeNumber | mvexpand orderNumber | sort -orderNumber
NRQL: FROM Log SELECT uniques(orderNumber) AS 'orderNumber' WHERE index = 'k8s_main' AND message LIKE '%bopus%' AND orderType = 'BOPUS' AND storeNumber LIKE '%' AND orderNumber LIKE '%' FACET orderStatus, storeNumber ORDER BY orderNumber DESC
```

> [!WARNING]
> SPL list() mapped to NRQL uniques(); duplicates will be removed
>
> `mvexpand` orderNumber skipped; NRQL does not expand multivalue fields into rows, but filtering and selection on the field still work

---
<!-- /spl-cases -->

#### `rename` — Supported

Renames fields. Translates to NRQL `AS` aliases.

<!-- spl-cases: fields-rename -->
```
❓ Not confirmed
SPL:  * | rename src_ip AS source_address
NRQL: FROM Log SELECT src_ip AS 'source_address', *
```

> [!WARNING]
> NRQL rename keeps original field names alongside aliases

---

```
❓ Not confirmed
SPL:  * | stats avg(bytes) as avg_bytes by host | rename avg_bytes AS average_bytes
NRQL: FROM Log SELECT average(bytes) AS 'average_bytes' FACET host
```

---

```
❓ Not confirmed
SPL:  * | rename _time AS "Time"
NRQL: FROM Log SELECT timestamp AS 'Time', *
```

> [!WARNING]
> NRQL rename keeps original field names alongside aliases

---

```
❓ Not confirmed
SPL:  * | rename src_ip as src user_name as user
NRQL: FROM Log SELECT src_ip AS 'src', user_name AS 'user', *
```

> [!WARNING]
> NRQL rename keeps original field names alongside aliases

---

```
✅ Confirmed by human
SPL:  * | rename properties.* as *
NRQL: 
```

> [!CAUTION]
> Wildcard rename (properties.* as *) not supported in NRQL; rename specific fields

---

```
❓ Not confirmed
SPL:  * | rename "IsOutlier(count)" as isOutlier
NRQL: 
```

> [!CAUTION]
> Cannot rename field with parentheses in name: "IsOutlier(count)"

---
<!-- /spl-cases -->

#### `replace` — Partial support

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
🤖 Confirmed by LLM
SPL:  * | replace "error" WITH "warning" IN message
NRQL: FROM Log SELECT replace(message, 'error', 'warning'), *
```

---

```
🤖 Confirmed by LLM
SPL:  * | replace "kube:container:" WITH "" IN sourcetype | stats count by sourcetype
NRQL: FROM Log SELECT count(*) FACET replace(sourcetype, 'kube:container:', '')
```

---

```
🤖 Confirmed by LLM
SPL:  * | replace "%%14674" WITH "Value Added", "%%14675" WITH "Value Deleted" IN OperationType
NRQL: FROM Log SELECT replace(replace(OperationType, '%%14674', 'Value Added'), '%%14675', 'Value Deleted'), *
```

---
<!-- /spl-cases -->

#### `rex` — Supported

Extracts fields using regular expressions. Translates to NRQL `capture()` or `aparse()`.

<!-- spl-cases: fields-rex -->
```
✅ Confirmed by human
SPL:  * | rex field=message "(?<ip>\d+\.\d+\.\d+\.\d+)"
NRQL: FROM Log WITH capture(message, r'.*(?P<ip>\d+\.\d+\.\d+\.\d+).*') AS (ip) SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | rex "user=(?<username>\w+)"
NRQL: FROM Log WITH capture(message, r'.*user=(?P<username>\w+).*') AS (username) SELECT *
```

---

```
❓ Not confirmed
SPL:  * | rex field=_raw "From: <(?<from>.*)> To: <(?<to>.*)>"
NRQL: FROM Log WITH capture(message, r'.*From: <(?P<from>.*)> To: <(?:.*)>.*') AS `from`, capture(message, r'.*From: <(?:.*)> To: <(?P<to>.*)>.*') AS to SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | rex field=_raw ".*dlq\/(?P<dlq_key>\d+),"
NRQL: FROM Log WITH capture(message, r'.*dlq\/(?P<dlq_key>\d+),.*') AS (dlq_key) SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | rex "status=(?<code>\d+)" | stats count by code
NRQL: FROM Log WITH capture(message, r'.*status=(?P<code>\d+).*') AS (code) SELECT count(*) FACET code
```

---

```
✅ Confirmed by human
SPL:  * | rex field=message "\"orderId\":\"(?<orderId>[A-Z0-9-]+)\""
NRQL: FROM Log WITH capture(message, r'.*\"orderId\":\"(?P<orderId>[A-Z0-9-]+)\".*') AS (orderId) SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | rex field=message "\d+"
NRQL: 
```

> [!CAUTION]
> `rex` pattern has no named capture groups; nothing to extract

---

```
✅ Confirmed by human
SPL:  * | rex field=message "(?<skus>\d{6,})" max_match=0
NRQL: 
```

> [!CAUTION]
> `rex` max_match not supported; NRQL capture() returns first match only

---
<!-- /spl-cases -->

#### `rex` (sed mode) — Not supported

Uses sed-like syntax for in-line string substitution. Limited NRQL support via string functions.

<!-- spl-cases: fields-rex-sed -->
```
✅ Confirmed by human
SPL:  * | rex mode=sed field=message "s/old/new/g"
NRQL: 
```

> [!CAUTION]
> `rex` mode=sed has no NRQL equivalent

---
<!-- /spl-cases -->

#### `rex` (PCRE-only features) — Partial support

PCRE features like lookaheads/lookbehinds and backreferences. NRQL's RE2 regex engine does not support these.

<!-- spl-cases: fields-rex-pcre -->
```
🤖 Confirmed by LLM
SPL:  * | rex field=message "(?<=prefix)(?<val>\w+)"
NRQL: 
```

> [!CAUTION]
> `rex` pattern uses lookahead/lookbehind assertions which NRQL capture() does not support; rewrite the regex without lookaround

---
<!-- /spl-cases -->

#### `search` (pipe) — Supported

Filters results with search criteria (same as implicit search). Translates to additional NRQL `WHERE` conditions.

<!-- spl-cases: results-search -->
```
🤖 Confirmed by LLM
SPL:  index=web | stats count by status | search status=200
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND status = '200' OR numeric(status) = 200 FACET status
```

---

```
🤖 Confirmed by LLM
SPL:  status=500 | search error
NRQL: FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND message LIKE '%error%'
```

---

```
🤖 Confirmed by LLM
SPL:  * | search status=200 OR status=301
NRQL: FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 OR status = '301' OR numeric(status) = 301
```

---

```
🤖 Confirmed by LLM
SPL:  | search host=web01
NRQL: FROM Log SELECT * WHERE host = 'web01'
```

---
<!-- /spl-cases -->

#### `spath` — Partial support

Extracts fields from structured data (JSON, XML). Translates to NRQL `jparse()` for JSON paths.

<!-- spl-cases: fields-spath -->
```
✅ Confirmed by human
SPL:  * | spath input=payload path=user.name output=username
NRQL: FROM Log WITH jparse(payload, 'user.name') AS username SELECT *
```

> [!WARNING]
> `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead

---

```
✅ Confirmed by human
SPL:  * | spath path=response.status
NRQL: FROM Log WITH jparse(message, 'response.status') AS status SELECT *
```

> [!WARNING]
> `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead

---

```
✅ Confirmed by human
SPL:  * | spath input=_raw path=data.id output=id
NRQL: FROM Log WITH jparse(message, 'data.id') AS id SELECT *
```

> [!WARNING]
> `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead

---

```
✅ Confirmed by human
SPL:  * | spath path=response.code output=code | stats count by code
NRQL: FROM Log WITH jparse(message, 'response.code') AS code SELECT count(*) FACET code
```

> [!WARNING]
> `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead

---

```
✅ Confirmed by human
SPL:  * | spath path=user.name output=name | spath path=user.email output=email
NRQL: FROM Log WITH jparse(message, 'user.name') AS name, jparse(message, 'user.email') AS email SELECT *
```

> [!WARNING]
> `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead

---

```
✅ Confirmed by human
SPL:  * | spath path=request.url output=url | rex field=url "(?<domain>[^/]+)"
NRQL: FROM Log WITH jparse(message, 'request.url') AS url, capture(url, r'.*(?P<domain>[^/]+).*') AS (domain) SELECT *
```

> [!WARNING]
> `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead

---

```
✅ Confirmed by human
SPL:  * | spath "AppID"
NRQL: FROM Log WITH jparse(message, 'AppID') AS AppID SELECT *
```

> [!WARNING]
> `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead

---

```
✅ Confirmed by human
SPL:  * | spath source_name
NRQL: FROM Log WITH jparse(message, 'source_name') AS source_name SELECT *
```

> [!WARNING]
> `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead

---

```
✅ Confirmed by human
SPL:  * | spath path=errors{}.code output=error_code | search error_code=404
NRQL: FROM Log WITH jparse(message, 'errors[*].code') AS error_code SELECT * WHERE error_code = '404' OR numeric(error_code) = 404
```

> [!WARNING]
> `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead

---

```
✅ Confirmed by human
SPL:  * | spath path=items{}.status
NRQL: FROM Log WITH jparse(message, 'items[*].status') AS status SELECT *
```

> [!WARNING]
> `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead

---

```
✅ Confirmed by human
SPL:  * | spath input=request_body path=user.preferences{}.key output=pref_key
NRQL: FROM Log WITH jparse(request_body, 'user.preferences[*].key') AS pref_key SELECT *
```

> [!WARNING]
> `jparse()` only works on JSON data; if the input is XML, use capture() with a regex pattern instead

---

```
✅ Confirmed by human
SPL:  * | eval user_id = json_extract(payload, "$.user.id")
NRQL: FROM Log WITH jparse(payload, 'user.id') AS user_id SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | spath
NRQL: 
```

> [!CAUTION]
> `spath` without path= does auto-extraction, which has no NRQL equivalent; specify path= to extract a specific JSON field

---

```
✅ Confirmed by human
SPL:  * | spath input=payload
NRQL: 
```

> [!CAUTION]
> `spath` without path= does auto-extraction, which has no NRQL equivalent; specify path= to extract a specific JSON field

---
<!-- /spl-cases -->

#### `stats` — Supported

Computes aggregate statistics over events. Translates to NRQL `SELECT aggregate(...) FACET ...`.

<!-- spl-cases: reports-stats -->
```
✅ Confirmed by human
SPL:  index=web | stats count by status
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET status
```

---

```
✅ Confirmed by human
SPL:  * | stats avg(response_time) as avg_response_time by host
NRQL: FROM Log SELECT average(response_time) AS 'avg_response_time' FACET host
```

---

```
✅ Confirmed by human
SPL:  index=web | stats count, dc(clientip) AS unique_clients BY status
NRQL: FROM Log SELECT count(*), uniqueCount(clientip) AS 'unique_clients' WHERE index = 'web' FACET status
```

---

```
✅ Confirmed by human
SPL:  * | stats count min(_time) as firstTime max(_time) as lastTime BY user dest
NRQL: FROM Log SELECT count(*), min(timestamp) AS 'firstTime', max(timestamp) AS 'lastTime' FACET user, dest
```

---

```
✅ Confirmed by human
SPL:  * | stats count(status) by host
NRQL: FROM Log SELECT count(status) FACET host
```

---

```
✅ Confirmed by human
SPL:  * | stats count as "totalFailure"
NRQL: FROM Log SELECT count(*) AS 'totalFailure'
```

---

```
✅ Confirmed by human
SPL:  * | stats count as 'my count'
NRQL: FROM Log SELECT count(*) AS 'my count'
```

---

```
❓ Not confirmed
SPL:  * | stats count(eval(status>=400)) as errors
NRQL: FROM Log SELECT filter(count(*), WHERE numeric(status) >= 400) AS 'errors'
```

---

```
❓ Not confirmed
SPL:  * | stats count(eval(EventCode=4648)) as attempts, count(eval(EventCode=4624)) as successes
NRQL: FROM Log SELECT filter(count(*), WHERE EventCode = '4648' OR numeric(EventCode) = 4648) AS 'attempts', filter(count(*), WHERE EventCode = '4624' OR numeric(EventCode) = 4624) AS 'successes'
```

---
<!-- /spl-cases -->

#### Multiple chained aggregations

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

---
<!-- /spl-cases -->

<!-- spl-cases: reports-chained-agg-aliased -->
```
✅ Confirmed by human
SPL:  index=web | stats count as cnt by host | stats max(cnt)
NRQL: FROM (FROM Log SELECT count(*) AS 'cnt' WHERE index = 'web' FACET host LIMIT MAX) SELECT max(cnt)
```

---
<!-- /spl-cases -->

#### `streamstats` — Not supported

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
🤖 Confirmed by LLM
SPL:  * | streamstats count by host
NRQL: 
```

> [!CAUTION]
> SPL command 'streamstats' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `strcat` — Supported

Concatenates string values. Translates to NRQL `concat()` in a WITH clause.

<!-- spl-cases: fields-strcat -->
```
🤖 Confirmed by LLM
SPL:  * | strcat host ":" port address
NRQL: FROM Log WITH concat(host, ':', port) AS address SELECT *
```

---

```
🤖 Confirmed by LLM
SPL:  * | strcat first_name last_name full_name
NRQL: FROM Log WITH concat(first_name, last_name) AS full_name SELECT *
```

---

```
🤖 Confirmed by LLM
SPL:  * | strcat protocol "://" host ":" port url
NRQL: FROM Log WITH concat(protocol, '://', host, ':', port) AS url SELECT *
```

---

```
🤖 Confirmed by LLM
SPL:  * | strcat host ":" port address | stats count by address
NRQL: FROM Log WITH concat(host, ':', port) AS address SELECT count(*) FACET address
```

---
<!-- /spl-cases -->

#### `table` — Supported

Formats results as a table with the specified columns. Translates identically to `fields` — both produce `SELECT field1, field2, ...` in NRQL.

See [Fields > `table` / `fields`](#table--fields--partial-support) — `table` and `fields` are functionally equivalent in NRQL translation.

#### `timechart` — Supported

Creates time series charts by bucketing events into time intervals. Translates to NRQL `SELECT ... TIMESERIES span`.

<!-- spl-cases: reports-timechart -->
```
✅ Confirmed by human
SPL:  * | timechart count
NRQL: FROM Log SELECT count(*) TIMESERIES AUTO
```

---

```
✅ Confirmed by human
SPL:  sourcetype=access_* | timechart span=1h count by status
NRQL: FROM Log SELECT count(*) WHERE sourcetype LIKE 'access_%' FACET status TIMESERIES 1 hour
```

---

```
✅ Confirmed by human
SPL:  * | timechart span=5m count BY host
NRQL: FROM Log SELECT count(*) FACET host TIMESERIES 5 minutes
```

---

```
✅ Confirmed by human
SPL:  * | timechart span=1d sum(price) by productName
NRQL: FROM Log SELECT sum(price) FACET productName TIMESERIES 1 day
```

---

```
✅ Confirmed by human
SPL:  * | timechart count span=5m
NRQL: FROM Log SELECT count(*) TIMESERIES 5 minutes
```

---

```
✅ Confirmed by human
SPL:  * | timechart count(POS) span=5m as "TPOS"
NRQL: FROM Log SELECT count(POS) AS 'TPOS' TIMESERIES 5 minutes
```

---

```
✅ Confirmed by human
SPL:  * | timechart c span=1m
NRQL: FROM Log SELECT count(*) TIMESERIES 1 minute
```

---

```
✅ Confirmed by human
SPL:  * | timechart span=30m count | predict count as predict_count
NRQL: FROM Log SELECT count(*) TIMESERIES 30 minutes PREDICT
```

---

```
🤖 Confirmed by LLM
SPL:  * | stats count | predict count
NRQL: FROM Log SELECT count(*) TIMESERIES AUTO PREDICT
```

> [!WARNING]
> PREDICT requires TIMESERIES; added TIMESERIES AUTO automatically

---
<!-- /spl-cases -->

#### `timewrap` — Not supported

Overlays time series data from different time periods. NRQL has no time-wrapping. Use `COMPARE WITH` to compare the current time range against a prior period.

<!-- spl-cases: reports-timewrap -->
```
🤖 Confirmed by LLM
SPL:  * | timechart count | timewrap 1d
NRQL: 
```

> [!CAUTION]
> SPL command 'timewrap' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `top` — Supported

Shows the most common values of a field. Translates to NRQL `SELECT count(*) FACET field LIMIT N`. Supports `limit=N` (keyword form), `countfield=X` (rename count column), `showperc=false` (suppress percent column), and `useother=true` (warned as unsupported). `limit=0` maps to `LIMIT MAX` (capped at 5,000 results).

> **Note:** SPL `top` also outputs a `percent` column. The NRQL translation approximates this with a scalar subquery (`count(*) * 100.0 / (SELECT count(*) FROM Log)`), but the result may differ from SPL's built-in percentage in edge cases (e.g., when combined with WHERE clauses or groupBy).

<!-- spl-cases: reports-top -->
```
🤖 Confirmed by LLM
SPL:  * | top categoryId
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET categoryId ORDER BY count DESC LIMIT 10
```

---

```
🤖 Confirmed by LLM
SPL:  * | top 20 host
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET host ORDER BY count DESC LIMIT 20
```

---

```
🤖 Confirmed by LLM
SPL:  * | top limit=20 host
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET host ORDER BY count DESC LIMIT 20
```

---

```
🤖 Confirmed by LLM
SPL:  * | top limit=0 status
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET status ORDER BY count DESC LIMIT MAX
```

---

```
🤖 Confirmed by LLM
SPL:  * | top limit=5 countfield=total host
NRQL: FROM Log SELECT count(*) AS 'total', count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET host ORDER BY count DESC LIMIT 5
```

---

```
✅ Confirmed by human
SPL:  * | top 10 showperc=false host
NRQL: FROM Log SELECT count(*) FACET host ORDER BY count DESC LIMIT 10
```

---

```
🤖 Confirmed by LLM
SPL:  * | top 5 useother=true status
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET status ORDER BY count DESC LIMIT 5
```

> [!WARNING]
> `useother`: NRQL pie chart automatically shows an "Other" category for values outside LIMIT

---

```
🤖 Confirmed by LLM
SPL:  * | top 5 percentfield=pct host
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'pct' FACET host ORDER BY count DESC LIMIT 5
```

---

```
🤖 Confirmed by LLM
SPL:  * | top delay limit=10
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET delay ORDER BY count DESC LIMIT 10
```

---

```
🤖 Confirmed by LLM
SPL:  error | top 5 status
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*) WHERE message LIKE '%error%') AS 'percent' WHERE message LIKE '%error%' FACET status ORDER BY count DESC LIMIT 5
```

---
<!-- /spl-cases -->

#### `top` with `groupby` — Partial support

Top values per group. SPL `top 5 status by host` returns the top 5 statuses **per host** (partitioned top-N). NRQL has no windowing/ranking functions, so this is approximated as a global `FACET status, host` which returns the top 5 (status, host) pairs overall — different semantics.

<!-- spl-cases: reports-top-groupby -->
```
🤖 Confirmed by LLM
SPL:  * | top 5 status by host
NRQL: FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET status, host ORDER BY count DESC LIMIT 5
```

> [!WARNING]
> `top` with groupBy: NRQL FACET groups all fields together; SPL groups within each by-field value

---
<!-- /spl-cases -->

#### `transaction` — Not supported

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
🤖 Confirmed by LLM
SPL:  * | transaction clientip maxspan=10m
NRQL: 
```

> [!CAUTION]
> SPL command 'transaction' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `where` — Supported

Filters results using boolean expressions. Supports comparison operators, `isnull()`, `isnotnull()`, `like()`, `match()`, `cidrmatch()`, and `isint()`.

<!-- spl-cases: results-where -->
```
✅ Confirmed by human
SPL:  * | where isint(orderId)
NRQL: FROM Log SELECT * WHERE numeric(orderId) IS NOT NULL
```

> [!WARNING]
> Unknown search node type: FunctionCall

---

```
✅ Confirmed by human
SPL:  * | where name like "test%"
NRQL: FROM Log SELECT * WHERE name LIKE 'test%'
```

---

```
✅ Confirmed by human
SPL:  index=web | stats count BY status | where count > 100
NRQL: FROM (FROM Log SELECT count(*) WHERE index = 'web' FACET status LIMIT MAX) SELECT * WHERE numeric(count) > 100
```

---

```
✅ Confirmed by human
SPL:  status=500 | where bytes > 1024
NRQL: FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND numeric(bytes) > 1024
```

---

```
✅ Confirmed by human
SPL:  * | where isnull(status)
NRQL: FROM Log SELECT * WHERE status IS NULL
```

> [!WARNING]
> Unknown search node type: FunctionCall

---

```
✅ Confirmed by human
SPL:  * | where isnotnull(status)
NRQL: FROM Log SELECT * WHERE status IS NOT NULL
```

> [!WARNING]
> Unknown search node type: FunctionCall

---

```
✅ Confirmed by human
SPL:  * | where host = "web01"
NRQL: FROM Log SELECT * WHERE host = 'web01'
```

---

```
✅ Confirmed by human
SPL:  * | where count > 100
NRQL: FROM Log SELECT * WHERE numeric(count) > 100
```

---

```
🤖 Confirmed by LLM
SPL:  * | where like(host, "web*")
NRQL: FROM Log SELECT * WHERE host LIKE 'web%'
```

> [!WARNING]
> Unknown search node type: FunctionCall

---

```
✅ Confirmed by human
SPL:  * | where name like "%test%"
NRQL: FROM Log SELECT * WHERE name LIKE '%test%'
```

---

```
🤖 Confirmed by LLM
SPL:  * | where match(host, "^web[0-9]+$")
NRQL: FROM Log SELECT * WHERE host RLIKE r'^web[0-9]+$'
```

> [!WARNING]
> Unknown search node type: FunctionCall

---

```
🤖 Confirmed by LLM
SPL:  * | where cidrmatch("10.0.0.0/8", src_ip)
NRQL: FROM Log SELECT * WHERE cidrAddress(src_ip, 8) = '10.0.0.0/8'
```

> [!WARNING]
> Unknown search node type: FunctionCall

---

```
✅ Confirmed by human
SPL:  * | where status >= 400 AND status < 500
NRQL: FROM Log SELECT * WHERE numeric(status) >= 400 AND numeric(status) < 500
```

---

```
✅ Confirmed by human
SPL:  * | where NOT status = 200
NRQL: FROM Log SELECT * WHERE NOT (status = '200' OR numeric(status) = 200)
```

---
<!-- /spl-cases -->

#### `where` on aggregation result — Supported

Filters aggregation results (equivalent to SQL HAVING). Translates to NRQL `WHERE` on aggregate expressions.

<!-- spl-cases: results-where-on-agg -->
```
✅ Confirmed by human
SPL:  * | stats count by host | where NOT count = 0
NRQL: FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT * WHERE NOT (count = '0' OR numeric(count) = 0)
```

---

```
✅ Confirmed by human
SPL:  * | stats count by host | where count > 100 AND count < 1000
NRQL: FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT * WHERE numeric(count) > 100 AND numeric(count) < 1000
```

---

```
✅ Confirmed by human
SPL:  * | stats count | where count > 0
NRQL: FROM (FROM Log SELECT count(*)) SELECT * WHERE numeric(count) > 0
```

---
<!-- /spl-cases -->

#### `xmlkv` — Not supported

Extracts key-value pairs from XML data. NRQL has no XML parser; consider using `spath` (jparse()) if the data can be converted to JSON at ingest time.

<!-- spl-cases: fields-xmlkv -->
```
🤖 Confirmed by LLM
SPL:  * | xmlkv
NRQL: 
```

> [!CAUTION]
> SPL command 'xmlkv' has no known NRQL equivalent

---
<!-- /spl-cases -->

### Eval Functions

Evaluation functions are used inside `eval`, `where`, and `case` expressions.

### Comparison and Conditional

#### `case()`, `if()`, `validate()`, `null()`, `true()`, `false()`, `isnull()`, `isnotnull()`, `like()`, `match()`, `cidrmatch()`, `in()`, `searchmatch()` — Partial support

Most conditional functions translate to NRQL equivalents: `if()` → `if()`, `case()` → nested `if()`, `isnull()` → `IS NULL`, `isnotnull()` → `IS NOT NULL`, `like()` → `LIKE`, `match()` → `RLIKE`, `in()` → `IN`. Functions without equivalents: `validate()`, `searchmatch()`.

<!-- spl-cases: eval-conditional -->
```
❓ Not confirmed
SPL:  * | eval x = if(status=200, "ok", "err")
NRQL: FROM Log WITH if(status = '200' OR numeric(status) = 200, 'ok', 'err') AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x = if(a>1, "y", "n")
NRQL: FROM Log WITH if(numeric(a) > 1, 'y', 'n') AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval FLSQuantity=if(channelName=="FLS", availableQuantityInChannel, 0)
NRQL: FROM Log WITH if(channelName = 'FLS', availableQuantityInChannel, 0) AS FLSQuantity SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=if(a > 0 and b > 0, "both", "nope")
NRQL: FROM Log WITH if(numeric(a) > 0 AND numeric(b) > 0, 'both', 'nope') AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval level = case(status<300, "ok", status<500, "warn", 1=1, "err")
NRQL: FROM Log WITH if(numeric(status) < 300, 'ok', if(numeric(status) < 500, 'warn', 'err')) AS level SELECT *
```

---

```
❓ Not confirmed
SPL:  * | eval x=case(a=1, "one", b=2, "two", 1=1, "other")
NRQL: FROM Log WITH if(a = '1' OR numeric(a) = 1, 'one', if(b = '2' OR numeric(b) = 2, 'two', 'other')) AS x SELECT *
```

---

```
❓ Not confirmed
SPL:  * | eval x=case(a=1, "one", b=2, "two")
NRQL: FROM Log WITH if(a = '1' OR numeric(a) = 1, 'one', if(b = '2' OR numeric(b) = 2, 'two', NULL)) AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=if(a > 0 or b > 0, "yes", "no")
NRQL: FROM Log WITH if(numeric(a) > 0 OR numeric(b) > 0, 'yes', 'no') AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=if((a > 0) or (b > 0), "yes", "no")
NRQL: FROM Log WITH if(numeric(a) > 0 OR numeric(b) > 0, 'yes', 'no') AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=if(count > (a + b), "over", "under")
NRQL: FROM Log WITH if(numeric(count) > numeric(a) + numeric(b), 'over', 'under') AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=if(skuCount > FCQuantity, "yes", "no")
NRQL: FROM Log WITH if(numeric(skuCount) > numeric(FCQuantity), 'yes', 'no') AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=if(isnull(field), "missing", field)
NRQL: FROM Log WITH if(field IS NULL, 'missing', field) AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=if(isnotnull(field), field, "default")
NRQL: FROM Log WITH if(field IS NOT NULL, field, 'default') AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=if(like(name, "test%"), "match", "no")
NRQL: FROM Log WITH if(name LIKE 'test%', 'match', 'no') AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval match=if(a==b, "same", "diff")
NRQL: FROM Log WITH if(a = b, 'same', 'diff') AS match SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=if(a > 0, "yes")
NRQL: FROM Log WITH if(numeric(a) > 0, 'yes') AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=case("only")
NRQL: FROM Log WITH 'only' AS x SELECT *
```

---
<!-- /spl-cases -->

### String Functions

#### `lower()`, `upper()`, `len()`, `substr()`, `trim()`, `ltrim()`, `rtrim()`, `replace()`, `split()`, `mvjoin()`, `urldecode()` — Partial support

String functions translate to NRQL equivalents where available: `lower()` → `lower()`, `upper()` → `upper()`, `len()` → `length()`, `substr()` → `substring()`, `replace()` → `replace()`. Some functions like `urldecode()` have no direct equivalent.

<!-- spl-cases: eval-string -->
```
✅ Confirmed by human
SPL:  * | eval name = lower(username)
NRQL: FROM Log WITH lower(username) AS name SELECT *
```

---

```
❓ Not confirmed
SPL:  * | eval full = first . " " . last
NRQL: FROM Log WITH concat(first, ' ', last) AS full SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=upper(name)
NRQL: FROM Log WITH upper(name) AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=substr(name, 1, 3)
NRQL: FROM Log WITH substring(name, 0, 3) AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=substr(name, -3)
NRQL: FROM Log WITH substring(name, -3) AS x SELECT *
```

---

```
❓ Not confirmed
SPL:  * | eval x=trim(name)
NRQL: FROM Log WITH capture(name, r'^\s*(?P<x>.*\S)\s*$') AS x SELECT *
```

---

```
❓ Not confirmed
SPL:  * | eval x=ltrim(name)
NRQL: FROM Log WITH capture(name, r'^\s*(?P<x>.*)$') AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "a", "b")
NRQL: FROM Log WITH replace(name, 'a', 'b') AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "SKU:", "")
NRQL: FROM Log WITH replace(name, 'SKU:', '') AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=replace(name, "]", "")
NRQL: FROM Log WITH replace(name, ']', '') AS x SELECT *
```

---

```
❓ Not confirmed
SPL:  * | eval x=replace(name, "old.host.com", "new.host.com")
NRQL: FROM Log WITH replace(name, 'old.host.com', 'new.host.com') AS x SELECT *
```

---

```
❓ Not confirmed
SPL:  * | eval x=replace(name, "foo-bar", "baz")
NRQL: FROM Log WITH replace(name, 'foo-bar', 'baz') AS x SELECT *
```

---

```
❓ Not confirmed
SPL:  * | eval x=replace(uri, "https://old.com/api?key=val", "https://new.com/api")
NRQL: FROM Log WITH replace(uri, 'https://old.com/api?key=val', 'https://new.com/api') AS x SELECT *
```

---

```
❓ Not confirmed
SPL:  * | eval x=replace(uri, "/path/to+file", "/path/to_file")
NRQL: FROM Log WITH replace(uri, '/path/to+file', '/path/to_file') AS x SELECT *
```

---

```
🤖 Confirmed by LLM
SPL:  * | eval x=replace(name, "\\d+", "")
NRQL: 
```

> [!CAUTION]
> `replace()` with regex pattern '\d+' not supported — NRQL replace() is literal-only

---

```
🤖 Confirmed by LLM
SPL:  * | eval x=replace(name, "[abc]", "")
NRQL: 
```

> [!CAUTION]
> `replace()` with regex pattern '[abc]' not supported — NRQL replace() is literal-only

---

```
🤖 Confirmed by LLM
SPL:  * | eval x=replace(name, "test.*end", "")
NRQL: 
```

> [!CAUTION]
> `replace()` with regex pattern 'test.*end' not supported — NRQL replace() is literal-only

---

```
❓ Not confirmed
SPL:  * | eval x=replace(name, "\d+", "")
NRQL: 
```

> [!CAUTION]
> `replace()` with regex pattern 'd+' not supported — NRQL replace() is literal-only

---

```
❓ Not confirmed
SPL:  * | eval x=replace(name, "foo+", "")
NRQL: 
```

> [!CAUTION]
> `replace()` with regex pattern 'foo+' not supported — NRQL replace() is literal-only

---

```
❓ Not confirmed
SPL:  * | eval x=replace(name, "x?y", "")
NRQL: 
```

> [!CAUTION]
> `replace()` with regex pattern 'x?y' not supported — NRQL replace() is literal-only

---

```
❓ Not confirmed
SPL:  * | eval x=replace(name, "foo|bar", "")
NRQL: 
```

> [!CAUTION]
> `replace()` with regex pattern 'foo|bar' not supported — NRQL replace() is literal-only

---

```
❓ Not confirmed
SPL:  * | eval x=replace(name, "\s+", " ")
NRQL: 
```

> [!CAUTION]
> `replace()` with regex pattern 's+' not supported — NRQL replace() is literal-only

---

```
❓ Not confirmed
SPL:  * | eval x=replace(uri, "https://example.com/.*", "")
NRQL: 
```

> [!CAUTION]
> `replace()` with regex pattern 'https://example.com/.*' not supported — NRQL replace() is literal-only

---

```
🤖 Confirmed by LLM
SPL:  * | eval json_content=replace(json_content, "'", "\"") | spath input=json_content
NRQL: 
```

> [!CAUTION]
> `spath` without path= does auto-extraction, which has no NRQL equivalent; specify path= to extract a specific JSON field

---
<!-- /spl-cases -->

### Math Functions

#### `abs()`, `ceil()`, `floor()`, `round()`, `log()`, `ln()`, `exp()`, `pow()`, `sqrt()`, `pi()` — Supported

Math functions map directly: `abs()` → `abs()`, `ceil()` → `ceil()`, `floor()` → `floor()`, `round()` → `round()`, `log()` → `log()`, `ln()` → `ln()`, `exp()` → `exp()`, `pow()` → `pow()`, `sqrt()` → `sqrt()`.

<!-- spl-cases: eval-math -->
```
✅ Confirmed by human
SPL:  * | eval x=abs(val)
NRQL: FROM Log WITH abs(val) AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=ceil(val)
NRQL: FROM Log WITH ceil(val) AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=floor(val)
NRQL: FROM Log WITH floor(val) AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=sqrt(val)
NRQL: FROM Log WITH sqrt(val) AS x SELECT *
```

---

```
🤖 Confirmed by LLM
SPL:  * | eval x=round(val, 2)
NRQL: FROM Log WITH round(val, 0.01) AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=pow(base, exp)
NRQL: FROM Log WITH pow(base, exp) AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=ceiling(val)
NRQL: FROM Log WITH ceiling(val) AS x SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=log(val)
NRQL: FROM Log WITH log10(val) AS x SELECT *
```

---
<!-- /spl-cases -->

### Type Conversion

#### `coalesce()`, `tonumber()`, `tostring()`, `typeof()`, `isbool()`, `isint()`, `isnum()`, `isstr()` — Partial support

Type and coercion functions: `coalesce()` → nested `if(IS NOT NULL)`, `tonumber()` → `numeric()`, `tostring()` → `string()`. Type-checking functions (`typeof()`, `isbool()`, etc.) have limited or no NRQL equivalents.

<!-- spl-cases: eval-type -->
```
✅ Confirmed by human
SPL:  * | eval val = coalesce(field1, field2, "default")
NRQL: FROM Log WITH (field1 OR field2 OR 'default') AS val SELECT *
```

---

```
✅ Confirmed by human
SPL:  * | eval x=tonumber(val)
NRQL: FROM Log WITH numeric(val) AS x SELECT *
```

---

```
🤖 Confirmed by LLM
SPL:  * | eval x=tostring(val)
NRQL: FROM Log WITH string(val) AS x SELECT *
```

---

```
🤖 Confirmed by LLM
SPL:  * | eval x=typeof(val)
NRQL: 
```

> [!CAUTION]
> `eval` function typeof() has no NRQL equivalent

---

```
🤖 Confirmed by LLM
SPL:  * | eval x=isbool(val)
NRQL: 
```

> [!CAUTION]
> `eval` function isbool() has no NRQL equivalent

---

```
🤖 Confirmed by LLM
SPL:  * | eval x=isstr(val)
NRQL: 
```

> [!CAUTION]
> `eval` function isstr() has no NRQL equivalent

---
<!-- /spl-cases -->

### Multivalue Functions

#### `mvindex()`, `mvcount()`, `split()`, `mvjoin()`, `mvappend()`, `mvdedup()`, `mvfind()`, `mvsort()`, `mvzip()` — Partial support

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

---

```
✅ Confirmed by human
SPL:  * | eval x = mvcount(lines)
NRQL: FROM Log WITH length(lines) AS x SELECT *
```

> [!WARNING]
> `length()` returns string length in NRQL, not multivalue count; results may differ for non-array fields

---

```
🤖 Confirmed by LLM
SPL:  * | eval x=mvindex(values)
NRQL: FROM Log WITH values AS x SELECT *
```

> [!WARNING]
> `mvindex()` requires at least 2 arguments (field, index)

---

```
✅ Confirmed by human
SPL:  * | eval x=mvindex(split(data, ","), 0)
NRQL: FROM Log WITH getField(split(data, ','), 0) AS x SELECT *
```

---

```
🤖 Confirmed by LLM
SPL:  * | eval joined = mvjoin(tags, ", ")
NRQL: 
```

> [!CAUTION]
> `mvjoin()` has no NRQL equivalent — NRQL cannot join array elements into a delimited string

---
<!-- /spl-cases -->

### Date/Time Functions — Not supported

#### `now()`, `time()`, `strftime()`, `strptime()`, `relative_time()` — Not supported

NRQL handles time through `SINCE`, `UNTIL`, and `TIMESERIES` clauses rather than per-row time functions. There is no equivalent of formatting timestamps within query results.

---

## Moderate Use Commands (20–49 occurrences)

---

### Pipe Commands

#### `iplocation` — Not supported

Extracts geographic information from IP addresses. New Relic performs GeoIP enrichment at ingest time — use attributes like `city`, `regionName`, `countryCode` that are already on the event.

#### `regex` — Supported

Filters results by matching a field against a regular expression. Translates to NRQL `WHERE field RLIKE 'pattern'`.

<!-- spl-cases: results-regex -->
```
❓ Not confirmed
SPL:  * | regex message="error\\d+"
NRQL: FROM Log SELECT * WHERE message RLIKE r'error\\d+'
```

---

```
❓ Not confirmed
SPL:  * | regex status!="^2\\d{2}$"
NRQL: FROM Log SELECT * WHERE status NOT RLIKE r'^2\\d{2}$'
```

---

```
🤖 Confirmed by LLM
SPL:  * | regex "fatal|critical"
NRQL: FROM Log SELECT * WHERE message RLIKE r'fatal|critical'
```

---

```
🤖 Confirmed by LLM
SPL:  status=500 | regex message="timeout"
NRQL: FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND message RLIKE r'timeout'
```

---

```
🤖 Confirmed by LLM
SPL:  * | regex uri_path="^/api/v[0-9]+"
NRQL: FROM Log SELECT * WHERE uri_path RLIKE r'^/api/v[0-9]+'
```

---
<!-- /spl-cases -->

#### `sort` — Supported

Sorts results by field values. Translates to NRQL `ORDER BY field ASC|DESC`.

<!-- spl-cases: results-sort -->
```
🤖 Confirmed by LLM
SPL:  * | sort - count
NRQL: FROM Log SELECT * ORDER BY count DESC
```

---

```
🤖 Confirmed by LLM
SPL:  * | sort + name
NRQL: FROM Log SELECT * ORDER BY name ASC
```

---

```
🤖 Confirmed by LLM
SPL:  * | sort name
NRQL: FROM Log SELECT * ORDER BY name ASC
```

---

```
🤖 Confirmed by LLM
SPL:  * | sort 0 host
NRQL: FROM Log SELECT * ORDER BY host ASC
```

---

```
🤖 Confirmed by LLM
SPL:  * | sort count desc
NRQL: FROM Log SELECT * ORDER BY count DESC
```

---

```
🤖 Confirmed by LLM
SPL:  * | sort 0 - firstTime
NRQL: FROM Log SELECT * ORDER BY firstTime DESC
```

---
<!-- /spl-cases -->

---

## Rare Use Commands (1–19 occurrences)

---

### Pipe Commands

#### `accum` — Not supported

Computes running totals over events. NRQL has no running/cumulative aggregation. Each row in NRQL results is independent — there's no concept of row-order-dependent calculations.

<!-- spl-cases: reports-accum -->
```
🤖 Confirmed by LLM
SPL:  * | accum bytes as running_total
NRQL: 
```

> [!CAUTION]
> SPL command 'accum' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `addtotals` — Not supported

Adds row or column totals to results. NRQL has no built-in total rows. Use a separate query for totals.

#### `delta` — Not supported

Computes the difference between consecutive field values. NRQL has no row-over-row computation; use `derivative()` for time-series rate of change.

#### `format` — Not supported

Formats subsearch results into a search string. NRQL subqueries use a different syntax and don't require explicit formatting.

#### `from` — Not supported

Retrieves data from a dataset, report, or data model. In NRQL, `FROM` is the standard clause to specify the event type. The SPL `from` command's dataset/report abstraction layer has no counterpart.

#### `highlight` — Not supported

Highlights search terms in results. This is a Splunk UI display feature with no NRQL equivalent. New Relic's log viewer handles highlighting in the presentation layer.

<!-- spl-cases: results-highlight -->
```
🤖 Confirmed by LLM
SPL:  * | highlight error warning
NRQL: 
```

> [!CAUTION]
> SPL command 'highlight' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `inputlookup` — Supported

Loads events from a lookup table. Translates to NRQL `FROM lookup(tablename)`.

<!-- spl-cases: results-inputlookup -->
```
✅ Confirmed by human
SPL:  * | inputlookup geo_ips
NRQL: FROM lookup(geo_ips) SELECT *
```

> [!WARNING]
> Ensure lookup table 'geo_ips' is uploaded via the Lookups UI

---

```
✅ Confirmed by human
SPL:  * | inputlookup append=true geo_ips
NRQL: FROM lookup(geo_ips) SELECT *
```

> [!WARNING]
> Ensure lookup table 'geo_ips' is uploaded via the Lookups UI

---

```
✅ Confirmed by human
SPL:  * | inputlookup my_table
NRQL: FROM lookup(my_table) SELECT *
```

> [!WARNING]
> Ensure lookup table 'my_table' is uploaded via the Lookups UI

---

```
❓ Not confirmed
SPL:  | inputlookup users.csv where role="admin"
NRQL: FROM lookup(users.csv) SELECT * WHERE role = 'admin'
```

> [!WARNING]
> Ensure lookup table 'users.csv' is uploaded via the Lookups UI
>
> `inputlookup` WHERE condition translated as-is; verify field names match the lookup table schema

---
<!-- /spl-cases -->

#### `makemv` — Not supported

Splits a single-value field into a multivalue field. NRQL does not have multivalue fields; consider sending separate events at ingest time.

**Why this exists in Splunk:** Splunk stores everything as raw text strings. When a field contains comma-separated values like `"web,mobile,api"`, `makemv` splits it into an array so other commands (`mvexpand`, `mvcount`, `mvindex`) can iterate over the values. This is Splunk's way of handling structured data within its flat text model.

**In New Relic:** If your data arrives as JSON, arrays are already arrays — no splitting needed. If data arrives as CSV-in-a-string, use the `capture()` function or restructure the data at ingest to send proper JSON arrays.

#### `map` — Not supported

Runs a search for each result of a previous search (like a for-each loop). NRQL has no iterative execution — each query is a single pass over the data.

#### `mstats` — Not supported

Performs statistical queries against the Splunk metrics store. For New Relic metrics, query the `Metric` event type directly: `FROM Metric SELECT average(cpu.percent) FACET host`.

<!-- spl-cases: metrics-mstats -->
```
🤖 Confirmed by LLM
SPL:  | mstats avg(cpu.percent) by host
NRQL: 
```

> [!CAUTION]
> SPL command 'mstats' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `multikv` — Not supported

Extracts fields from table-formatted events (like command output with headers and columns). NRQL has no structured-text parsing; preprocess at ingest time.

#### `nomv` — Not supported

Converts a multivalue field to a single value. NRQL does not have multivalue fields.

<!-- spl-cases: fields-nomv -->
```
🤖 Confirmed by LLM
SPL:  * | nomv values
NRQL: 
```

> [!CAUTION]
> SPL command 'nomv' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `outlier` — Not supported

Removes outliers from results based on mean/standard deviation. NRQL can filter using `stddev()` in a subquery pattern, but has no single-command outlier removal.

#### `outputlookup` — Not supported

Writes results to a lookup table. No NRQL equivalent. Lookup tables in New Relic are managed via NerdGraph API.

#### `rare` — Supported

Shows the least common values of a field. Translates to NRQL `SELECT count(*) ... FACET field ORDER BY count(*) ASC`.

<!-- spl-cases: reports-rare -->
```
✅ Confirmed by human
SPL:  * | rare status
NRQL: FROM Log SELECT count(*) FACET status ORDER BY count ASC LIMIT 10
```

---

```
✅ Confirmed by human
SPL:  * | rare 5 uri_path
NRQL: FROM Log SELECT count(*) FACET uri_path ORDER BY count ASC LIMIT 5
```

---

```
✅ Confirmed by human
SPL:  * | rare status by host
NRQL: FROM Log SELECT count(*) FACET status, host ORDER BY count ASC LIMIT 10
```

---

```
✅ Confirmed by human
SPL:  status>=400 | rare 20 uri_path
NRQL: FROM Log SELECT count(*) WHERE numeric(status) >= 400 FACET uri_path ORDER BY count ASC LIMIT 20
```

---

```
✅ Confirmed by human
SPL:  * | rare app limit=20
NRQL: FROM Log SELECT count(*) FACET app ORDER BY count ASC LIMIT 20
```

---

```
✅ Confirmed by human
SPL:  * | rare limit=20 "details.error"
NRQL: FROM Log SELECT count(*) FACET `details.error` ORDER BY count ASC LIMIT 20
```

---
<!-- /spl-cases -->

#### `return` — Not supported

Returns field values from a subsearch. NRQL subqueries return scalar values directly.

#### `reverse` — Supported

Reverses the order of results. Translates to NRQL `ORDER BY timestamp ASC`.

<!-- spl-cases: results-reverse -->
```
🤖 Confirmed by LLM
SPL:  * | reverse
NRQL: FROM Log SELECT * ORDER BY timestamp ASC
```

---

```
🤖 Confirmed by LLM
SPL:  error | table message | reverse
NRQL: FROM Log SELECT message WHERE message LIKE '%error%' ORDER BY timestamp ASC
```

---
<!-- /spl-cases -->

#### `selfjoin` — Not supported

Joins results with themselves on a shared field. NRQL JOIN requires two different event types; self-joins are not supported.

<!-- spl-cases: correlation-selfjoin -->
```
🤖 Confirmed by LLM
SPL:  * | selfjoin host
NRQL: 
```

> [!CAUTION]
> SPL command 'selfjoin' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `set` — Not supported

Performs set operations (union, diff, intersect) on subsearch results. NRQL has no set algebra operators.

<!-- spl-cases: correlation-set -->
```
🤖 Confirmed by LLM
SPL:  * | set union
NRQL: 
```

> [!CAUTION]
> SPL command 'set' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `tail` — Not supported

Returns the last N results. NRQL has no reverse-order limit — results are always ordered newest-first by default, and `LIMIT` takes from the top.

<!-- spl-cases: results-tail -->
```
🤖 Confirmed by LLM
SPL:  * | tail 10
NRQL: 
```

> [!CAUTION]
> SPL command 'tail' has no known NRQL equivalent

---

```
🤖 Confirmed by LLM
SPL:  * | tail 20
NRQL: 
```

> [!CAUTION]
> SPL command 'tail' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `transpose` — Not supported

Transposes rows and columns in results. NRQL has no pivot/transpose operation. Result reshaping is handled by the visualization layer.

<!-- spl-cases: results-transpose -->
```
🤖 Confirmed by LLM
SPL:  * | stats count by host | transpose
NRQL: 
```

> [!CAUTION]
> SPL command 'transpose' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `uniq` — Not supported

Removes consecutive duplicate events. Translates similarly to `dedup`.

<!-- spl-cases: results-uniq -->
```
🤖 Confirmed by LLM
SPL:  * | sort host | uniq
NRQL: 
```

> [!CAUTION]
> `uniq` has no direct NRQL equivalent

---
<!-- /spl-cases -->

#### `xyseries` — Not supported

Converts results to a format suitable for graphing. No NRQL equivalent — chart formatting is handled by the visualization layer.

---

## No Observed Usage

Commands with zero occurrences in customer query data and security detection rules. Brief descriptions only.

---

### Pipe Commands

#### `abstract` — Not supported

Generates a summary of each event's text. Splunk-specific text summarization feature with no NRQL equivalent.

#### `addcoltotals` — Not supported

Adds a summary row with column totals to the results. NRQL has no mechanism to add synthetic summary rows to query output.

#### `addinfo` — Not supported

Adds search metadata fields (search time range, search ID) to each event. NRQL has no concept of adding query metadata to result rows.

#### `analyzefields` — Not supported

Analyzes fields for their ability to predict another field. Splunk ML toolkit feature with no NRQL equivalent.

#### `anomalies` — Not supported

Identifies anomalous events using statistical analysis. NRQL has no built-in anomaly detection at query time. New Relic provides anomaly detection through Applied Intelligence and alert conditions, not the query language.

<!-- spl-cases: anomalies-anomalies -->
```
🤖 Confirmed by LLM
SPL:  * | anomalies field=count
NRQL: 
```

> [!CAUTION]
> SPL command 'anomalies' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `anomalydetection` — Not supported

Detects anomalies in time-series data using machine learning. NRQL has no built-in ML; New Relic provides anomaly detection through alert conditions with baseline thresholds.

#### `anomalousvalue` — Not supported

Finds fields with unusual values. Splunk ML toolkit feature with no NRQL equivalent.

#### `arules` — Not supported

Discovers association rules between field values (market basket analysis). Splunk ML toolkit feature.

#### `associate` — Not supported

Identifies correlations between fields. Splunk ML toolkit feature.

#### `autoregress` — Not supported

Computes moving averages and autoregressive values by referencing previous event values. NRQL has no row-ordering or lag/lead functions; use `TIMESERIES` with `slidingWindow()` for moving averages.

#### `bucketdir` — Not supported

Replaces directory paths with higher-level groupings. Splunk-specific path manipulation.

#### `cluster` — Not supported

Clusters similar events together based on field values. NRQL has no clustering algorithm. New Relic Logs provides pattern detection in the UI, but it's not accessible via NRQL.

<!-- spl-cases: anomalies-cluster -->
```
🤖 Confirmed by LLM
SPL:  * | cluster showcount=true
NRQL: 
```

> [!CAUTION]
> SPL command 'cluster' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `cofilter` — Not supported

Finds associations between field values using co-occurrence analysis. Splunk ML toolkit feature with no NRQL equivalent.

#### `collect` — Not supported

Writes results to a Splunk index. No NRQL equivalent.

#### `concurrency` — Not supported

Computes the number of concurrent events over time. NRQL has no overlapping-interval analysis; use `TIMESERIES` with `count(*)` for approximate concurrency.

#### `contingency` — Not supported

Builds a contingency table showing the frequency of field value pairs. NRQL can approximate this with `SELECT count(*) FACET field1, field2`, but has no formal contingency/chi-squared analysis.

#### `correlate` — Not supported

Calculates correlations between fields. NRQL has no built-in correlation or statistical relationship functions.

#### `ctable` — Not supported

Alias for `contingency`. See [Reports > contingency](#contingency--not-supported).

#### `datamodel` — Not supported

Accesses Splunk's data model acceleration. Data models are a Splunk-specific abstraction layer; New Relic uses event types and attributes directly.

#### `datamodelsimple` — Not supported

Simplified access to data model objects. Same Splunk-specific limitation as `datamodel`.

<!-- spl-cases: data-datamodel -->
```
🤖 Confirmed by LLM
SPL:  | datamodel Authentication
NRQL: 
```

> [!CAUTION]
> SPL command 'datamodel' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `dbinspect` — Not supported

Returns information about Splunk indexes (bucket counts, sizes, time ranges). No NRQL equivalent — New Relic index metadata is accessed through the platform UI and NerdGraph API, not query language.

#### `dbxquery` — Not supported

Runs SQL queries against external databases. NRQL only queries New Relic's telemetry database — external database access requires application-level integrations.

#### `delete` — Not supported

Deletes events from a Splunk index. NRQL is read-only — data lifecycle is managed by retention policies and drop rules, not query commands.

#### `diff` — Not supported

Compares two search results. NRQL has no result-set comparison operator.

#### `entitymerge` — Not supported

Merges entities in IT Service Intelligence. Splunk ITSI-specific feature.

#### `erex` — Not supported

Automatically generates extraction rules from example values. NRQL has no machine-learning-based field extraction; use `rex` (capture()) or `spath` (jparse()) instead.

#### `eventcount` — Not supported

Returns the count of events in indexes. NRQL provides `SELECT count(*) FROM Log` for event counts, but `eventcount` is about Splunk index-level metadata, not query results.

#### `fieldformat` — Not supported

Sets the display format for a field without changing its underlying value. NRQL has no display-formatting layer — formatting is handled by the visualization/UI.

#### `filldown` — Not supported

Fills null values with the last non-null value from a previous event. NRQL processes each event independently — there's no row-ordering or carry-forward mechanism.

#### `findtypes` — Not supported

Identifies field value types from event data. Splunk-specific type inference.

#### `folderize` — Not supported

Creates a folder hierarchy from search results. Splunk UI-specific feature.

#### `fromjson` — Not supported

Extracts fields from a JSON string field. Use `spath` / `jparse()` in NRQL for JSON field extraction.

#### `gauge` — Not supported

Displays a single numeric value in a gauge visualization. This is a Splunk visualization command; NRQL visualization is handled by New Relic dashboards and chart types.

#### `geom` — Not supported

Adds geographic polygons for choropleth map visualization. Splunk-specific visualization feature.

#### `geomfilter` — Not supported

Filters geographic data to a bounding box for map visualizations. Splunk-specific visualization feature.

#### `geostats` — Not supported

Generates statistics for geographic coordinates for map overlays. NRQL can FACET by geographic attributes but has no built-in geospatial aggregation functions.

#### `gentimes` — Not supported

Generates time-range events. NRQL has no synthetic event generation; use `TIMESERIES` for time bucketing.

#### `history` — Not supported

Returns the search history. NRQL has no query history command; use the New Relic UI or NerdGraph for query history.

#### `iconify` — Not supported

Adds icons to field values in Splunk's UI. Presentation-layer feature.

#### `ingestpreview` — Not supported

Previews data ingestion settings. Splunk admin feature.

#### `inputcsv` — Not supported

Reads search results from a CSV file on the Splunk server. NRQL has no file system access; use lookup tables or NerdGraph for external data.

#### `inputintelligence` — Not supported

Provides intelligence about data inputs. Splunk admin feature.

#### `kmeans` — Not supported

Performs k-means clustering on search results. Splunk ML toolkit feature with no NRQL equivalent.

#### `kvform` — Not supported

Extracts fields using predefined extraction templates. NRQL has no template-based extraction mechanism.

#### `loadjob` — Not supported

Loads results from a previously completed search job. NRQL has no job persistence; re-run the query or use dashboards to save query configurations.

#### `localize` — Not supported

Returns time ranges where events occur. NRQL can approximate with `TIMESERIES` and filtering.

#### `localop` — Not supported

Forces a search to run on the local search head only. Internal to Splunk's distributed architecture.

#### `makecontinuous` — Not supported

Makes a numeric field continuous by filling gaps with zero-count bins. NRQL `TIMESERIES` provides time-based continuity, but there's no general-purpose gap-filling for arbitrary numeric fields.

#### `makeresults` — Not supported

Generates a specified number of empty result rows. NRQL has no synthetic row generation. Use hardcoded values in `SELECT` if you need constants.

#### `mcatalog` — Not supported

Returns metadata about metrics in the Splunk metrics store. New Relic metric metadata is accessed via NerdGraph or the Metric Explorer UI.

#### `mcollect` — Not supported

Writes results to the Splunk metrics store. No NRQL equivalent.

<!-- spl-cases: results-mcollect -->
```
🤖 Confirmed by LLM
SPL:  * | mcollect index=metrics_idx
NRQL: 
```

> [!CAUTION]
> SPL command 'mcollect' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `metadata` — Not supported

Returns metadata about sources, sourcetypes, or hosts in an index. New Relic attribute cardinality and metadata are accessed via NerdGraph or the Data Explorer UI.

#### `metasearch` — Not supported

Searches index metadata rather than events. NRQL queries events directly; index metadata is managed through the New Relic platform.

<!-- spl-cases: data-metadata -->
```
🤖 Confirmed by LLM
SPL:  | metadata type=sources
NRQL: 
```

> [!CAUTION]
> SPL command 'metadata' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `mpreview` — Not supported

Previews data from a metrics index. No NRQL equivalent.

#### `multisearch` — Not supported

Runs multiple searches simultaneously and combines the results. NRQL has no UNION operator to merge result sets from separate queries into a single output.

#### `outputcsv` — Not supported

Writes results to a CSV file on the Splunk server. No NRQL equivalent. Use New Relic's export features (UI export, NerdGraph, or streaming).

<!-- spl-cases: results-outputcsv -->
```
🤖 Confirmed by LLM
SPL:  * | outputcsv results.csv
NRQL: 
```

> [!CAUTION]
> SPL command 'outputcsv' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `outputtext` — Not supported

Converts results to plain text format. NRQL output formatting is handled by the platform (JSON, CSV export, etc.).

#### `overlap` — Not supported

Finds events that overlap in time based on start/end fields. NRQL has no interval-overlap analysis.

#### `pivot` — Not supported

References a data model dataset and creates a pivot table. Pivot is built on Splunk's data model layer which has no NRQL counterpart.

<!-- spl-cases: data-pivot -->
```
🤖 Confirmed by LLM
SPL:  | pivot Web_Traffic count
NRQL: 
```

> [!CAUTION]
> SPL command 'pivot' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `predict` — Not supported

Forecasts future values using time series algorithms. NRQL has no built-in forecasting. New Relic provides baseline alerting through Applied Intelligence, but forecasting is not available in the query language.

<!-- spl-cases: prediction-predict -->
```
🤖 Confirmed by LLM
SPL:  * | predict count
NRQL: FROM Log SELECT count(*) TIMESERIES AUTO PREDICT
```

> [!WARNING]
> PREDICT requires TIMESERIES; added TIMESERIES AUTO automatically

---
<!-- /spl-cases -->

#### `rangemap` — Not supported

Maps numeric field values to named ranges (like "low", "medium", "high"). Use `cases()` in NRQL for equivalent range classification: `cases(WHERE value < 10, 'low', WHERE value < 50, 'medium', WHERE value >= 50, 'high')`.

#### `reltime` — Not supported

Converts a timestamp field to a human-readable relative time string (e.g., "2 hours ago"). NRQL handles time display in the visualization layer.

#### `require` — Not supported

Filters events to those containing specific fields. Use `WHERE field IS NOT NULL` in NRQL.

#### `rest` — Not supported

Accesses Splunk's internal REST API from within a search. NRQL queries run against telemetry data only — platform API access uses NerdGraph, not the query language.

<!-- spl-cases: data-rest -->
```
🤖 Confirmed by LLM
SPL:  | rest /services/server/info
NRQL: 
```

> [!CAUTION]
> SPL command 'rest' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `rtorder` — Not supported

Buffers real-time search results to enforce time ordering. Internal to Splunk's real-time search.

#### `run` / `script` — Not supported

Executes an external script or command. NRQL is a pure query language with no external execution.

#### `savedsearch` — Not supported

Runs a saved search by name. NRQL queries are stored in dashboards and alerts, not as named saved searches. Use dashboard widget queries or NerdGraph to retrieve stored queries.

#### `scrub` — Not supported

Anonymizes search results by replacing field values with hashed or randomized equivalents. NRQL has no data masking at query time; use drop rules or obfuscation rules at ingest.

#### `searchtxn` — Not supported

Searches within transaction results. NRQL has no transaction grouping; see [Correlation > transaction](#transaction--not-supported).

#### `sendemail` — Not supported

Sends results via email. No NRQL equivalent. Use New Relic alert notifications or scheduled query exports.

<!-- spl-cases: results-sendemail -->
```
🤖 Confirmed by LLM
SPL:  * | sendemail to="admin@example.com"
NRQL: 
```

> [!CAUTION]
> SPL command 'sendemail' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `setfields` — Not supported

Sets field values to a literal value. Use `eval` / `WITH` in NRQL to assign constants to fields.

#### `sichart` / `sitimechart` — Not supported

Summary indexing commands that write precomputed aggregations back to Splunk indexes. New Relic handles precomputation through events-to-metrics rules and Metric data types, not query-time commands.

<!-- spl-cases: data-sichart -->
```
🤖 Confirmed by LLM
SPL:  * | sichart count by host
NRQL: 
```

> [!CAUTION]
> SPL command 'sichart' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `sirare` — Not supported

Summary indexing variant of `rare`. Writes precomputed rare-value results back to an index. See [Data and Indexes > sichart](#sichart--sitimechart--not-supported).

#### `sistats` — Not supported

Summary indexing variant of `stats`. Writes precomputed statistics back to an index. See [Data and Indexes > sichart](#sichart--sitimechart--not-supported).

#### `sitimechart` — Not supported

Summary indexing variant of `timechart`. See [Data and Indexes > sichart](#sichart--sitimechart--not-supported).

#### `sitop` — Not supported

Summary indexing variant of `top`. See [Data and Indexes > sichart](#sichart--sitimechart--not-supported).

#### `tags` — Not supported

Adds tags to events based on field values and tag definitions. New Relic uses entity tags and attribute-based filtering instead of a tag command.

#### `tojson` — Not supported

Converts field values to JSON format. NRQL has no built-in JSON serialization function.

#### `trendline` — Not supported

Computes moving averages over time series data. NRQL has no moving average function. For trend analysis, use `TIMESERIES` with `COMPARE WITH` to compare time periods.

<!-- spl-cases: prediction-trendline -->
```
🤖 Confirmed by LLM
SPL:  * | trendline sma5(count) as trend
NRQL: 
```

> [!CAUTION]
> SPL command 'trendline' has no known NRQL equivalent

---
<!-- /spl-cases -->

#### `tscollect` — Not supported

Writes results to a time-series collection (tsidx) for accelerated access. Splunk-specific acceleration; New Relic handles query performance through its storage engine, not user-managed indexes.

#### `tstats` — Not supported

Performs statistical queries on indexed fields or data model datasets. This is Splunk's acceleration layer; NRQL queries all data directly without a separate accelerated path.

<!-- spl-cases: data-tstats -->
```
🤖 Confirmed by LLM
SPL:  | tstats count FROM datamodel=Endpoint.Processes
NRQL: 
```

> [!CAUTION]
> `tstats` queries target Splunk CIM data models which normalize events from multiple sourcetypes into a standard schema. To translate, identify which sourcetypes populate the data model in your Splunk deployment, then query those events directly using their raw field names.

---
<!-- /spl-cases -->

#### `union` — Not supported

Merges results from two or more datasets. NRQL has no UNION operator — you can query multiple event types with `FROM Type1, Type2`, but cannot merge arbitrary result sets.

#### `untable` — Not supported

Converts results from a tabular format to a list format. No NRQL equivalent — result format is controlled by the visualization layer.

#### `walklex` — Not supported

Returns the terms in the index lexicon. This is a Splunk index-level introspection command with no NRQL equivalent.

#### `x11` — Not supported

Performs seasonal decomposition on time series data. Splunk ML toolkit feature with no NRQL equivalent.

#### `xmlunescape` — Not supported

Unescapes XML-encoded characters in field values. NRQL has no string unescaping functions; preprocess at ingest time.

#### `xpath` — Not supported

Extracts values from XML data using XPath expressions. NRQL has no XML or XPath support; convert to JSON at ingest and use `jparse()`.


### Subsearch

Subsearch lets you use the results of one search as an argument to another.


#### `format` — Not supported

Formats subsearch results into a search string. NRQL subqueries use a different syntax and don't require explicit formatting.

#### `return` — Not supported

Returns field values from a subsearch. NRQL subqueries return scalar values directly.

#### `set` — Not supported

See [Correlation > `set`](#set--not-supported).

SPL subsearches translate partially to NRQL subqueries and JOINs. See [Correlation > `join`](#join) for the closest equivalent.

---

### Internal

Splunk internal commands used by the search pipeline. These are implementation details of Splunk's distributed search architecture.

#### `collapse` — Not supported

Collapses events from distributed search. Internal to Splunk's distributed search processing.

#### `dump` — Not supported

Exports raw data for debugging. Internal diagnostic command.

#### `findkeywords` — Not supported

Identifies distinguishing keywords between two sets of events. Internal analysis command.

#### `makejson` — Not supported

Creates a JSON string from field values. NRQL has no JSON serialization functions.

#### `noop` — Not supported

A no-operation command used for testing or disabling parts of a search pipeline. No NRQL equivalent needed.

#### `prjob` — Not supported

Internal command for managing parallel reduce jobs in distributed search.

#### `redistribute` — Not supported

Redistributes data across search processors for load balancing. Internal to Splunk's distributed architecture.

#### `runshellscript` — Not supported

Executes a shell script from within a search. NRQL is a pure query language with no system-level execution.

---

### 3rd-Party and Custom Commands

Add-on commands provided by Splunk apps and technology add-ons.

#### `awssnsalert` — Not supported

Sends alerts via Amazon SNS (Splunk Add-on for AWS). Use New Relic alert notification channels instead.

#### `sendalert` — Not supported

Triggers a custom alert action. Use New Relic alert policies and notification workflows.

#### `snowincident` / `snowincidentstream` — Not supported

Creates ServiceNow incidents (Splunk Add-on for ServiceNow). Use New Relic's ServiceNow integration for incident creation.

#### `snowevent` / `snoweventstream` — Not supported

Creates ServiceNow events (Splunk Add-on for ServiceNow). Use New Relic's ServiceNow integration.

#### `typeahead` — Not supported

Provides search term suggestions. This is a Splunk UI feature; New Relic has its own query autocomplete.

#### `typelearner` — Not supported

Learns event types from data patterns. Splunk-specific type inference.

#### `typer` — Not supported

Assigns event types to events. Splunk-specific event classification.

---

### Unknown commands

Commands not recognized by the translator produce a generic unsupported message.

<!-- spl-cases: unsupported-unknown -->
```
🤖 Confirmed by LLM
SPL:  * | xyzcommand foo bar
NRQL: 
```

> [!CAUTION]
> SPL command 'xyzcommand' has no known NRQL equivalent

---
<!-- /spl-cases -->

---


---

## Statistical and Charting Functions

### Stats Function Mapping

<!-- spl-table: stats-functions -->
| SPL function | NRQL function | Notes |
|---|---|---|
| `dc(field)` | `uniqueCount(field), average(bytes), sum(bytes), median(latency), average(latency), uniqueCount(user), uniques(status), percentile(field, 95), percentile(latency, 99), stddev(latency)` |  |
| `min(field)` | `min(field), max(duration)` |  |
| `stdevp(field)` | `stddev(field)` | stdevp() is population stddev; mapped to NRQL stddev() which is sample stddev. Results may differ. |
| `earliest(field)` | `earliest(field), latest(timestamp)` |  |
| `first(field)` | `latest(field)` |  |
| `last(field)` | `earliest(field)` |  |
| `rate(field)` | `rate(sum(field), 1 second)` |  |
| `list(field)` | `uniques(field)` | list() mapped to NRQL uniques(); duplicates will be removed |
| `xyzfunc(field)` | `*` | function xyzfunc() has no known NRQL equivalent |
| `estdc(field)` | `uniqueCount(field)` |  |
| `exactperc95(field)` | `percentile(field, 95)` | exactperc95() mapped to NRQL percentile(); precision may differ |
| `upperperc99(field)` | `percentile(field, 99)` | upperperc99() mapped to NRQL percentile(); precision may differ |
| `per_second(field)` | `rate(sum(field), 1 second)` |  |
| `per_minute(field)` | `rate(sum(field), 1 minute)` |  |
| `per_hour(field)` | `rate(sum(field), 1 hour)` |  |
| `per_day(field)` | `—` |  |
| `max(field)` | `max(numeric(field) / 1000)` |  |
| `perc95(field)` | `—` |  |
<!-- /spl-table -->

<!-- spl-cases: stats-functions -->
```
✅ Confirmed by human
SPL:  * | stats dc(clientip), avg(bytes), sum(bytes), median(latency), mean(latency), distinct_count(user), values(status), perc95(latency), p99(latency), stdev(latency) by host
NRQL: FROM Log SELECT uniqueCount(clientip), average(bytes), sum(bytes), median(latency), average(latency), uniqueCount(user), uniques(status), percentile(latency, 95), percentile(latency, 99), stddev(latency) FACET host
```

---

```
✅ Confirmed by human
SPL:  * | stats min(duration), max(duration) by host
NRQL: FROM Log SELECT min(duration), max(duration) FACET host
```

---

```
✅ Confirmed by human
SPL:  * | stats stdevp(latency) by host
NRQL: FROM Log SELECT stddev(latency) FACET host
```

> [!WARNING]
> SPL stdevp() is population stddev; mapped to NRQL stddev() which is sample stddev. Results may differ.

---

```
✅ Confirmed by human
SPL:  * | stats earliest(timestamp), latest(timestamp) by host
NRQL: FROM Log SELECT earliest(timestamp), latest(timestamp) FACET host
```

---

```
✅ Confirmed by human
SPL:  * | stats first(status) by host
NRQL: FROM Log SELECT latest(status) FACET host
```

---

```
✅ Confirmed by human
SPL:  * | stats last(status) by host
NRQL: FROM Log SELECT earliest(status) FACET host
```

---

```
✅ Confirmed by human
SPL:  * | stats rate(bytes) by host
NRQL: FROM Log SELECT rate(sum(bytes), 1 second) FACET host
```

---

```
✅ Confirmed by human
SPL:  * | stats list(user) by host
NRQL: FROM Log SELECT uniques(user) FACET host
```

> [!WARNING]
> SPL list() mapped to NRQL uniques(); duplicates will be removed

---

```
✅ Confirmed by human
SPL:  * | stats xyzfunc(field) by host
NRQL: FROM Log SELECT * FACET host
```

> [!WARNING]
> SPL function xyzfunc() has no known NRQL equivalent

---

```
✅ Confirmed by human
SPL:  * | stats estdc(clientip) as approx_unique by host
NRQL: FROM Log SELECT uniqueCount(clientip) AS 'approx_unique' FACET host
```

---

```
✅ Confirmed by human
SPL:  * | stats exactperc95(latency) as exact_p95 by service
NRQL: FROM Log SELECT percentile(latency, 95) AS 'exact_p95' FACET service
```

> [!WARNING]
> SPL exactperc95() mapped to NRQL percentile(); precision may differ

---

```
✅ Confirmed by human
SPL:  * | stats upperperc99(response_time) by endpoint
NRQL: FROM Log SELECT percentile(response_time, 99) FACET endpoint
```

> [!WARNING]
> SPL upperperc99() mapped to NRQL percentile(); precision may differ

---

```
✅ Confirmed by human
SPL:  * | stats per_second(bytes) as bps by host
NRQL: FROM Log SELECT rate(sum(bytes), 1 second) AS 'bps' FACET host
```

---

```
✅ Confirmed by human
SPL:  * | stats per_minute(requests) as rpm by service
NRQL: FROM Log SELECT rate(sum(requests), 1 minute) AS 'rpm' FACET service
```

---

```
✅ Confirmed by human
SPL:  * | stats per_hour(errors) as errors_per_hour by host
NRQL: FROM Log SELECT rate(sum(errors), 1 hour) AS 'errors_per_hour' FACET host
```

---

```
✅ Confirmed by human
SPL:  * | stats per_day(signups) as daily_signups
NRQL: FROM Log SELECT rate(sum(signups), 1 day) AS 'daily_signups'
```

---

```
✅ Confirmed by human
SPL:  * | stats max(a / 1000) as div, min(b * 8) as mul, sum(c + d) as add, avg(e - f) as sub, count(g % 3) as mod, max((h + i) * j) as parens, avg(response.time / 1000) as dotfield, sum(a + b + c) as chained by host
NRQL: FROM Log SELECT max(numeric(a) / 1000) AS 'div', min(numeric(b) * 8) AS 'mul', sum(numeric(c) + numeric(d)) AS 'add', average(numeric(e) - numeric(f)) AS 'sub', count(mod(numeric(g), 3)) AS 'mod', max((numeric(h) + numeric(i)) * numeric(j)) AS 'parens', average(numeric(`response.time`) / 1000) AS 'dotfield', sum(numeric(a) + numeric(b) + numeric(c)) AS 'chained' FACET host
```

---

```
✅ Confirmed by human
SPL:  * | timechart span=1h avg(bytes * 8 / 1024)
NRQL: FROM Log SELECT average(numeric(bytes) * 8 / 1024) TIMESERIES 1 hour
```

---

```
✅ Confirmed by human
SPL:  * | stats perc95(duration / 1000) as p95_sec
NRQL: FROM Log SELECT percentile(numeric(duration) / 1000, 95) AS 'p95_sec'
```

---
<!-- /spl-cases -->

### Stats Functions with No NRQL Equivalent

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
```

> [!WARNING]
> SPL mode() has no direct NRQL equivalent; consider FACET field LIMIT 1 to find most common value

---

```
✅ Confirmed by human
SPL:  * | stats earliest_time(message) as first_seen by host
NRQL: FROM Log SELECT * FACET host
```

> [!WARNING]
> SPL earliest_time() has no NRQL equivalent; earliest() returns the value, not the timestamp

---

```
✅ Confirmed by human
SPL:  * | stats rate_avg(cpu) by host
NRQL: FROM Log SELECT * FACET host
```

> [!WARNING]
> SPL rate_avg() is Splunk metrics-specific; no NRQL equivalent

---
<!-- /spl-cases -->

---

## Time Format Variables and Modifiers

### Time constraints (earliest/latest)

SPL time modifiers like `earliest=-24h` and `latest=now` translate to NRQL `SINCE` and `UNTIL` clauses.

<!-- spl-cases: time-constraints -->
```
✅ Confirmed by human
SPL:  earliest=-24h
NRQL: FROM Log SELECT * SINCE 24 hours ago
```

---

```
✅ Confirmed by human
SPL:  latest=-1h
NRQL: FROM Log SELECT * SINCE 24 hours ago UNTIL 1 hour ago
```

> [!WARNING]
> SPL latest without earliest defaults to 24h lookback in Splunk; added SINCE 24 hours ago to match

---

```
✅ Confirmed by human
SPL:  latest=now
NRQL: FROM Log SELECT *
```

---

```
✅ Confirmed by human
SPL:  earliest=@d
NRQL: FROM Log SELECT * SINCE today
```

---

```
✅ Confirmed by human
SPL:  error earliest=-24h latest=now
NRQL: FROM Log SELECT * WHERE message LIKE '%error%' SINCE 24 hours ago
```

---

```
✅ Confirmed by human
SPL:  earliest=-2h latest=-1h status=200
NRQL: FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 SINCE 2 hours ago UNTIL 1 hour ago
```

---

```
✅ Confirmed by human
SPL:  earliest=-24h@h latest=now
NRQL: FROM Log SELECT * SINCE 24 hours ago
```

> [!WARNING]
> SPL snap-to time '@h' ignored; NRQL SINCE/UNTIL does not support rounding to unit boundaries. Use 'today', 'this week', etc. for snap-only expressions.

---

```
✅ Confirmed by human
SPL:  status=500 earliest=-24h host=web
NRQL: FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND host = 'web' SINCE 24 hours ago
```

---

```
✅ Confirmed by human
SPL:  earliest=-24h earliest=-1h
NRQL: FROM Log SELECT * SINCE 1 hour ago
```

---
<!-- /spl-cases -->

### Macros

SPL time macros and shorthand.

<!-- spl-cases: macros -->
```
✅ Confirmed by human
SPL:  `sysmon` EventCode=10
NRQL: FROM Log SELECT * WHERE $sysmon AND EventCode = '10' OR numeric(EventCode) = 10
```

> [!WARNING]
> SPL macro `sysmon` translated to NRQL macro $sysmon; ensure a matching NRQL macro exists

---

```
✅ Confirmed by human
SPL:  `my_macro(arg1, arg2)` status=200
NRQL: FROM Log SELECT * WHERE $my_macro(arg1, arg2) AND status = '200' OR numeric(status) = 200
```

> [!WARNING]
> SPL macro `my_macro` translated to NRQL macro $my_macro(arg1, arg2); ensure a matching NRQL macro exists

---

```
✅ Confirmed by human
SPL:  * | `my_macro`
NRQL: FROM Log SELECT * WHERE $my_macro
```

> [!WARNING]
> SPL macro `my_macro` translated to NRQL macro $my_macro; ensure a matching NRQL macro exists

---

```
✅ Confirmed by human
SPL:  * | `my_macro(field1, field2)`
NRQL: FROM Log SELECT * WHERE $my_macro(field1, field2)
```

> [!WARNING]
> SPL macro `my_macro` translated to NRQL macro $my_macro(field1, field2); ensure a matching NRQL macro exists

---

```
✅ Confirmed by human
SPL:  `my_base_macro` | stats count
NRQL: FROM Log SELECT count(*) WHERE $my_base_macro
```

> [!WARNING]
> SPL macro `my_base_macro` translated to NRQL macro $my_base_macro; ensure a matching NRQL macro exists

---
<!-- /spl-cases -->

---

## Search Syntax

### Field Comparisons

Field-value comparisons in the implicit search clause.

<!-- spl-cases: field-comparisons -->
```
✅ Confirmed by human
SPL:  status>=400 status!=500 action=purchase
NRQL: FROM Log SELECT * WHERE numeric(status) >= 400 AND status != '500' AND numeric(status) != 500 AND action = 'purchase'
```

---

```
✅ Confirmed by human
SPL:  status=200 offset=-10 score=3.14
NRQL: FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 AND `offset` = '-10' OR numeric(`offset`) = -10 AND score = '3.14' OR numeric(score) = 3.14
```

---

```
✅ Confirmed by human
SPL:  status=OK code=4xx zip=00123
NRQL: FROM Log SELECT * WHERE status = 'OK' AND code = '4xx' AND zip = '00123'
```

---

```
✅ Confirmed by human
SPL:  _raw=*error*
NRQL: FROM Log SELECT * WHERE message LIKE '%error%'
```

> [!WARNING]
> `_raw` is not a valid NRQL field; mapped to message

---

```
✅ Confirmed by human
SPL:  action=OR action=AND action=NOT action=by action=search action=stats group=by
NRQL: FROM Log SELECT * WHERE action = 'OR' AND action = 'AND' AND action = 'NOT' AND action = 'by' AND action = 'search' AND action = 'stats' AND group = 'by'
```

---

```
✅ Confirmed by human
SPL:  "log.annotations.node"=NOSTORE
NRQL: FROM Log SELECT * WHERE `log.annotations.node` = 'NOSTORE'
```

---

```
✅ Confirmed by human
SPL:  "details.error"="*"
NRQL: FROM Log SELECT * WHERE `details.error` LIKE '%'
```

---

```
✅ Confirmed by human
SPL:  status = 500
NRQL: FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500
```

---

```
✅ Confirmed by human
SPL:  level = "ERROR"
NRQL: FROM Log SELECT * WHERE level = 'ERROR'
```

---
<!-- /spl-cases -->

### JSON Array Access

Splunk's `{}` notation for JSON array fields translates to `jparse()` + `contains()` in NRQL.

<!-- spl-cases: json-array-access -->
```
✅ Confirmed by human
SPL:  lineItemList{}.status=active
NRQL: FROM Log SELECT * WHERE contains(jparse(message, 'lineItemList[*].status'), 'active')
```

---

```
✅ Confirmed by human
SPL:  items{}.status != pending
NRQL: FROM Log SELECT * WHERE NOT contains(jparse(message, 'items[*].status'), 'pending')
```

---

```
✅ Confirmed by human
SPL:  orders{}.shipping.carrier=fedex
NRQL: FROM Log SELECT * WHERE contains(jparse(message, 'orders[*].shipping.carrier'), 'fedex')
```

---

```
✅ Confirmed by human
SPL:  containers{}.image=nginx*
NRQL: FROM Log SELECT * WHERE jparse(message, 'containers[*].image') LIKE 'nginx%'
```

---

```
✅ Confirmed by human
SPL:  items{}.category IN (electronics, clothing)
NRQL: FROM Log SELECT * WHERE contains(jparse(message, 'items[*].category'), 'electronics') OR contains(jparse(message, 'items[*].category'), 'clothing')
```

---

```
✅ Confirmed by human
SPL:  sourceIPs{0}=10.0.0.1
NRQL: FROM Log SELECT * WHERE jparse(message, 'sourceIPs[0]') = '10.0.0.1'
```

---
<!-- /spl-cases -->

### Boolean Operators (AND, OR, NOT)

Boolean logic in search expressions.

<!-- spl-cases: boolean-operators -->
```
✅ Confirmed by human
SPL:  EventCode=4720 OR EventCode=4732
NRQL: FROM Log SELECT * WHERE EventCode = '4720' OR numeric(EventCode) = 4720 OR EventCode = '4732' OR numeric(EventCode) = 4732
```

---

```
✅ Confirmed by human
SPL:  NOT debug
NRQL: FROM Log SELECT * WHERE NOT message LIKE '%debug%'
```

---

```
✅ Confirmed by human
SPL:  (error OR warning) NOT debug
NRQL: FROM Log SELECT * WHERE message LIKE '%error%' OR message LIKE '%warning%' AND NOT message LIKE '%debug%'
```

---

```
✅ Confirmed by human
SPL:  `macro_a` AND `macro_b`
NRQL: FROM Log SELECT * WHERE $macro_a AND $macro_b
```

> [!WARNING]
> SPL macro `macro_a` translated to NRQL macro $macro_a; ensure a matching NRQL macro exists
>
> SPL macro `macro_b` translated to NRQL macro $macro_b; ensure a matching NRQL macro exists

---

```
✅ Confirmed by human
SPL:  `macro_a` AND status=200
NRQL: FROM Log SELECT * WHERE $macro_a AND status = '200' OR numeric(status) = 200
```

> [!WARNING]
> SPL macro `macro_a` translated to NRQL macro $macro_a; ensure a matching NRQL macro exists

---

```
✅ Confirmed by human
SPL:  a=1 OR b=2 c=3
NRQL: FROM Log SELECT * WHERE a = '1' OR numeric(a) = 1 OR (b = '2' OR numeric(b) = 2 AND c = '3' OR numeric(c) = 3)
```

---

```
✅ Confirmed by human
SPL:  (a=1 OR b=2) AND c=3
NRQL: FROM Log SELECT * WHERE a = '1' OR numeric(a) = 1 OR b = '2' OR numeric(b) = 2 AND c = '3' OR numeric(c) = 3
```

---

```
✅ Confirmed by human
SPL:  a=1 b=2 OR c=3 d=4
NRQL: FROM Log SELECT * WHERE (a = '1' OR numeric(a) = 1 AND b = '2' OR numeric(b) = 2) OR (c = '3' OR numeric(c) = 3 AND d = '4' OR numeric(d) = 4)
```

---

```
✅ Confirmed by human
SPL:  NOT status=500 host=web
NRQL: FROM Log SELECT * WHERE NOT (status = '500' OR numeric(status) = 500) AND host = 'web'
```

---

```
✅ Confirmed by human
SPL:  NOT (status=500 host=web)
NRQL: FROM Log SELECT * WHERE NOT (status = '500' OR numeric(status) = 500 AND host = 'web')
```

---

```
✅ Confirmed by human
SPL:  error NOT(level=debug OR level=trace)
NRQL: FROM Log SELECT * WHERE message LIKE '%error%' AND NOT (level = 'debug' OR level = 'trace')
```

---

```
✅ Confirmed by human
SPL:  NOT() error
NRQL: FROM Log SELECT * WHERE message LIKE '%error%'
```

---
<!-- /spl-cases -->

### IN Operator

The `IN()` operator for matching against a list of values.

<!-- spl-cases: in-operator -->
```
✅ Confirmed by human
SPL:  code IN (200, error, 404)
NRQL: FROM Log SELECT * WHERE code IN (200, 'error', 404)
```

---

```
✅ Confirmed by human
SPL:  ScriptBlockText IN (*mimikatz*, *dumpcr*)
NRQL: FROM Log SELECT * WHERE ScriptBlockText LIKE '%mimikatz%' OR ScriptBlockText LIKE '%dumpcr%'
```

---

```
✅ Confirmed by human
SPL:  * NOT [|inputlookup exclude.csv] | stats count
NRQL: FROM Log SELECT count(*) WHERE {{column}} NOT IN (FROM lookup(exclude) SELECT {{column}} LIMIT MAX)
```

> [!WARNING]
> NOT [|inputlookup exclude.csv] translated to NOT IN lookup subquery. Replace {{column}} with the exclusion field name from exclude.csv. Upload the CSV to New Relic Lookup tables as 'exclude'.

---

```
✅ Confirmed by human
SPL:  "parameters.doc_title" IN ("*dhl*", "*invoice*")
NRQL: FROM Log SELECT * WHERE `parameters.doc_title` LIKE '%dhl%' OR `parameters.doc_title` LIKE '%invoice%'
```

---
<!-- /spl-cases -->

### Wildcards

Wildcard patterns in field values.

<!-- spl-cases: wildcards -->
```
✅ Confirmed by human
SPL:  host=*server host=web* message=*error* path=/api/*/users
NRQL: FROM Log SELECT * WHERE host LIKE '%server' AND host LIKE 'web%' AND message LIKE '%error%' AND path LIKE '/api/%/users'
```

---

```
✅ Confirmed by human
SPL:  host=*
NRQL: FROM Log SELECT * WHERE host LIKE '%'
```

---

```
✅ Confirmed by human
SPL:  host!=test*
NRQL: FROM Log SELECT * WHERE NOT host LIKE 'test%'
```

---
<!-- /spl-cases -->

### Quoted Strings and Escaping

Handling of quoted strings and special characters.

<!-- spl-cases: quoted-strings -->
```
✅ Confirmed by human
SPL:  message="it's"
NRQL: FROM Log SELECT * WHERE message = 'it\'s'
```

---

```
✅ Confirmed by human
SPL:  path="C:\\Windows\\System32"
NRQL: FROM Log SELECT * WHERE path = 'C:\\Windows\\System32'
```

---

```
✅ Confirmed by human
SPL:  msg="line1\nline2"
NRQL: FROM Log SELECT * WHERE msg = 'line1\nline2'
```

---

```
✅ Confirmed by human
SPL:  a="error in module" b="error | fatal" c="key=value" d="" e="日本語エラー" f="error, fatal"
NRQL: FROM Log SELECT * WHERE a = 'error in module' AND b = 'error | fatal' AND c = 'key=value' AND d = '' AND e = '日本語エラー' AND f = 'error, fatal'
```

---

```
✅ Confirmed by human
SPL:  message="error in module"
NRQL: FROM Log SELECT * WHERE message = 'error in module'
```

---

```
✅ Confirmed by human
SPL:  index=web user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64)" | stats count by host
NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' FACET host
```

---
<!-- /spl-cases -->

### NRQL Reserved Words as Field Names

Fields that collide with NRQL reserved words are backtick-escaped.

<!-- spl-cases: nrql-keywords -->
```
✅ Confirmed by human
SPL:  my-field=value
NRQL: FROM Log SELECT * WHERE `my-field` = 'value'
```

---

```
✅ Confirmed by human
SPL:  app:version=1.2.3
NRQL: FROM Log SELECT * WHERE `app:version` = '1.2.3'
```

---

```
✅ Confirmed by human
SPL:  kubernetes.labels.app:name=myapp
NRQL: FROM Log SELECT * WHERE `kubernetes.labels.app:name` = 'myapp'
```

---

```
✅ Confirmed by human
SPL:  * | stats count by container-name
NRQL: FROM Log SELECT count(*) FACET `container-name`
```

---

```
✅ Confirmed by human
SPL:  * | stats values(user.groups{}) as user_groups by host
NRQL: FROM Log SELECT uniques(jparse(message, 'user.groups[*]')) AS 'user_groups' FACET host
```

---

```
✅ Confirmed by human
SPL:  * | table k8s:namespace, k8s:pod
NRQL: FROM Log SELECT `k8s:namespace`, `k8s:pod`
```

---

```
✅ Confirmed by human
SPL:  log-level IN (error, warn, info)
NRQL: FROM Log SELECT * WHERE `log-level` IN ('error', 'warn', 'info')
```

---

```
✅ Confirmed by human
SPL:  x-forwarded-for=10.0.0.1
NRQL: FROM Log SELECT * WHERE `x-forwarded-for` = '10.0.0.1'
```

---

```
✅ Confirmed by human
SPL:  SELECT=200
NRQL: FROM Log SELECT * WHERE `SELECT` = '200' OR numeric(`SELECT`) = 200
```

---

```
✅ Confirmed by human
SPL:  search_term=hello NOT_FOUND=true top_secret=classified earliest_time=noon where=production table=users stats=enabled
NRQL: FROM Log SELECT * WHERE search_term = 'hello' AND NOT_FOUND = 'true' AND top_secret = 'classified' AND earliest_time = 'noon' AND `where` = 'production' AND table = 'users' AND stats = 'enabled'
```

---

```
✅ Confirmed by human
SPL:  bytecount=1024
NRQL: FROM Log SELECT * WHERE bytecount = '1024' OR numeric(bytecount) = 1024
```

---
<!-- /spl-cases -->

### Metadata Fields (index, sourcetype, source, host)

SPL metadata fields that have no direct NRQL equivalent are translated as attribute filters with a warning.

<!-- spl-cases: metadata-fields -->
```
✅ Confirmed by human
SPL:  index=web
NRQL: FROM Log SELECT * WHERE index = 'web'
```

---

```
✅ Confirmed by human
SPL:  sourcetype=access_*
NRQL: FROM Log SELECT * WHERE sourcetype LIKE 'access_%'
```

---
<!-- /spl-cases -->

---

## Graceful Degradation

### Empty and Invalid Input

How the translator handles empty strings, null, and malformed SPL.

<!-- spl-cases: empty-invalid -->
```
🤖 Confirmed by LLM
SPL:  (empty)
NRQL: FROM Log SELECT *
```

---

```
✅ Confirmed by human
SPL:  (empty)
NRQL: FROM Log SELECT *
```

---

```
🤖 Confirmed by LLM
SPL:  |||
NRQL: 
```

---

```
🤖 Confirmed by LLM
SPL:  back`tick=value
NRQL: 
```

---

```
✅ Confirmed by human
SPL:     
NRQL: FROM Log SELECT *
```

---

```
🤖 Confirmed by LLM
SPL:  message=
NRQL: 
```

---

```
🤖 Confirmed by LLM
SPL:  message=fn(x)
NRQL: 
```

---

```
🤖 Confirmed by LLM
SPL:  [search index=web | fields host]
NRQL: 
```

---

```
🤖 Confirmed by LLM
SPL:  status IN ()
NRQL: 
```

---

```
🤖 Confirmed by LLM
SPL:  * || stats count
NRQL: 
```

---

```
🤖 Confirmed by LLM
SPL:  * | stats count |
NRQL: 
```

---

```
🤖 Confirmed by LLM
SPL:  https://example.com/path?q=1
NRQL: 
```

---

```
🤖 Confirmed by LLM
SPL:  `mymacro`status=200
NRQL: 
```

---
<!-- /spl-cases -->

### Bare Keywords (full-text search)

Bare keywords without field assignments translate to `message LIKE '%keyword%'`. SPL bare keywords search `_raw` (the raw log line), so `message LIKE` is the correct NRQL equivalent — not `allColumnSearch()`, which searches every column and is extremely expensive.

<!-- spl-cases: bare-keywords -->
```
✅ Confirmed by human
SPL:  error
NRQL: FROM Log SELECT * WHERE message LIKE '%error%'
```

---

```
✅ Confirmed by human
SPL:  "connection timeout"
NRQL: FROM Log SELECT * WHERE message LIKE '%connection timeout%'
```

---

```
✅ Confirmed by human
SPL:  error warning
NRQL: FROM Log SELECT * WHERE message LIKE '%error%' AND message LIKE '%warning%'
```

---

```
✅ Confirmed by human
SPL:  *
NRQL: FROM Log SELECT *
```

---

```
✅ Confirmed by human
SPL:  100%cpu
NRQL: FROM Log SELECT * WHERE message LIKE '%100\%cpu%'
```

---

```
✅ Confirmed by human
SPL:  * Operation=\"Add member\"
NRQL: FROM Log SELECT * WHERE Operation = 'Add member'
```

---

```
✅ Confirmed by human
SPL:  * $global_time.earliest$ $global_time.latest$
NRQL: FROM Log SELECT * SINCE {{global_time.earliest}} UNTIL {{global_time.latest}}
```

---

```
✅ Confirmed by human
SPL:  TERM("control-connection-state-change") | stats count
NRQL: FROM Log SELECT count(*) WHERE message LIKE '%control-connection-state-change%'
```

---

```
✅ Confirmed by human
SPL:  TERM("*peer-system-ip:*") | stats count
NRQL: FROM Log SELECT count(*) WHERE message LIKE '%%peer-system-ip:%%'
```

---
<!-- /spl-cases -->

---

## Edge Cases & Real-World Queries

### Edge Cases

Boundary conditions, unusual syntax, and tricky translations.

<!-- spl-cases: edge-cases -->
```
🤖 Confirmed by LLM
SPL:  search error
NRQL: FROM Log SELECT * WHERE message LIKE '%error%'
```

---

```
🤖 Confirmed by LLM
SPL:  | stats count
NRQL: FROM Log SELECT count(*)
```

---

```
🤖 Confirmed by LLM
SPL:  * | stats count by host | sort - count | head 5
NRQL: FROM Log SELECT count(*) FACET host ORDER BY count DESC LIMIT 5
```

---

```
🤖 Confirmed by LLM
SPL:  OR status=200
NRQL: FROM Log SELECT * WHERE message LIKE '%OR%' AND status = '200' OR numeric(status) = 200
```

---

```
🤖 Confirmed by LLM
SPL:  NOT NOT error
NRQL: FROM Log SELECT * WHERE NOT message LIKE '%NOT%' AND message LIKE '%error%'
```

---

```
🤖 Confirmed by LLM
SPL:  -500
NRQL: FROM Log SELECT * WHERE message LIKE '%-500%'
```

---

```
🤖 Confirmed by LLM
SPL:  cpu_usage=95%
NRQL: FROM Log SELECT * WHERE cpu_usage = '95%'
```

---

```
🤖 Confirmed by LLM
SPL:  host=web,01
NRQL: FROM Log SELECT * WHERE host = 'web,01'
```

---

```
🤖 Confirmed by LLM
SPL:  path=C:\
NRQL: FROM Log SELECT * WHERE path = 'C:\\'
```

---

```
🤖 Confirmed by LLM
SPL:  field=***
NRQL: FROM Log SELECT * WHERE field LIKE '%%%'
```

---

```
🤖 Confirmed by LLM
SPL:  host=*web*server*prod*
NRQL: FROM Log SELECT * WHERE host LIKE '%web%server%prod%'
```

---

```
🤖 Confirmed by LLM
SPL:  error|stats count
NRQL: FROM Log SELECT count(*) WHERE message LIKE '%error%'
```

---

```
🤖 Confirmed by LLM
SPL:  status=200	status=300
NRQL: FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 AND status = '300' OR numeric(status) = 300
```

---

```
🤖 Confirmed by LLM
SPL:  index=web
| stats count by host
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
```

---

```
🤖 Confirmed by LLM
SPL:  (a=1 OR (b=2 AND (c=3 OR d=4)))
NRQL: FROM Log SELECT * WHERE a = '1' OR numeric(a) = 1 OR (b = '2' OR numeric(b) = 2 AND c = '3' OR numeric(c) = 3 OR d = '4' OR numeric(d) = 4)
```

---

```
🤖 Confirmed by LLM
SPL:  status IN (200)
NRQL: FROM Log SELECT * WHERE status IN (200)
```

---

```
🤖 Confirmed by LLM
SPL:  * | head 0
NRQL: FROM Log SELECT * LIMIT 0
```

---

```
🤖 Confirmed by LLM
SPL:  * error
NRQL: FROM Log SELECT * WHERE message LIKE '%error%'
```

---

```
🤖 Confirmed by LLM
SPL:  * | where a>1 | where b<2
NRQL: FROM Log SELECT * WHERE numeric(a) > 1 AND numeric(b) < 2
```

---

```
🤖 Confirmed by LLM
SPL:  * | where (status >= 400 AND status < 500)
NRQL: FROM Log SELECT * WHERE numeric(status) >= 400 AND numeric(status) < 500
```

---

```
🤖 Confirmed by LLM
SPL:  * | sort -count, +name, host
NRQL: FROM Log SELECT * ORDER BY count DESC
```

> [!WARNING]
> NRQL ORDER BY supports only one field; additional sort fields ignored

---

```
🤖 Confirmed by LLM
SPL:  * | STATS COUNT BY host
NRQL: FROM Log SELECT count(*) FACET host
```

---

```
🤖 Confirmed by LLM
SPL:  * | Stats Count By Host
NRQL: FROM Log SELECT count(*) FACET Host
```

---

```
🤖 Confirmed by LLM
SPL:  * | stats count() by host
NRQL: FROM Log SELECT count(*) FACET host
```

---

```
🤖 Confirmed by LLM
SPL:  * | stats avg(response.time) by host
NRQL: FROM Log SELECT average(`response.time`) FACET host
```

---
<!-- /spl-cases -->

### Real-World Queries

Real-world query regression tests are in `test/helpers/spl-real-world.json` (339 queries from customer usage and Splunk security detections).
