# NRQL Reference

Quick reference for NRQL capabilities relevant to SPL-to-NRQL translation.

## Query Structure

```
FROM <event_type> [JOIN (subquery) ON key]
SELECT <functions/fields>
[WHERE <conditions>]
[FACET <fields>]
[LIMIT <n> | MAX]
[SINCE <time> [UNTIL <time>]]
[TIMESERIES <interval>]
[ORDER BY <field> [ASC|DESC]]
[WITH <alias expressions>]
```

## Aggregation Functions

| Function | Description |
|---|---|
| `count(*)` | Count events |
| `sum(field)` | Sum values |
| `average(field)` | Mean value |
| `min(field)` / `max(field)` | Extremes |
| `median(field)` | Median (50th percentile) |
| `stddev(field)` | Standard deviation |
| `percentile(field, N)` | Nth percentile |
| `uniqueCount(field)` | Count distinct values |
| `uniques(field [, N])` | List distinct values (default limit 1000) |
| `latest(field)` / `earliest(field)` | Most/least recent value |
| `rate(sum(field), 1 second)` | Rate per time unit |
| `percentage(count(*), WHERE cond)` | Percentage matching condition |
| `filter(func(field), WHERE cond)` | Conditional aggregation |
| `histogram(field, width [, count])` | Bucket distribution |
| `buckets(field, count)` | Auto-bucketed distribution |
| `apdex(field, threshold)` | Application performance index |
| `funnel(attr, WHERE step1, WHERE step2, ...)` | Funnel analysis |
| `cdfPercentage(field, val1, val2, ...)` | Cumulative distribution |
| `getCdfCount(field, val)` | Count below value |
| `bucketPercentile(field, p1, p2, ...)` | Percentiles by bucket |
| `dimensions()` | All attribute names as facets |
| `cardinality([field1, field2, ...])` | Estimated cardinality |

## Non-Aggregation Functions (usable in SELECT/WHERE/WITH)

| Function | Description |
|---|---|
| `numeric(field)` | Cast to number |
| `string(field)` | Cast to string |
| `if(cond, trueVal, falseVal)` | Conditional |
| `capture(field, r'regex')` | Regex capture group |
| `aparse(field, 'pattern*')` | Anchor parse (wildcard extraction) |
| `concat(a, b, ...)` | String concatenation |
| `lower(field)` / `upper(field)` | Case conversion |
| `length(field)` | String length |
| `substring(field, start [, end])` | Substring extraction |
| `position(field, substr [, occurrence])` | Find substring position |
| `replace(field, old, new)` | String replacement |
| `toDatetime(epoch)` | Epoch ms to ISO datetime string |
| `toTimestamp(datestr)` | Date string to epoch ms |
| `jparse(field, '$.path')` | JSON path extraction |
| `getField(map, 'key')` | Map field extraction |
| `mod(a, b)` | Modulo |
| `abs(n)` / `ceil(n)` / `floor(n)` / `round(n)` / `sqrt(n)` / `pow(n,e)` / `exp(n)` / `ln(n)` / `log(n,base)` / `log2(n)` / `log10(n)` | Math |
| `encode(field, 'base64')` / `decode(field, 'base64')` | Encoding |
| `cidrAddress(ip)` | CIDR network extraction |
| `eventType()` | Returns event type name |
| `blob(field)` | Blob reference |
| `convert(field, 'unit')` | Unit conversion |
| `mapKeys(field)` / `mapValues(field)` | Map operations |

## Subqueries

### In WHERE clause
```sql
SELECT count(*) FROM Transaction
WHERE duration > (SELECT average(duration) FROM Transaction)
```

### IN condition
```sql
SELECT * FROM Transaction
WHERE appName IN (SELECT uniques(appName) FROM Transaction WHERE error IS true)
```

### Nested aggregation (in FROM clause)
```sql
SELECT max(rpm) FROM (
  SELECT count(*) AS rpm FROM Transaction TIMESERIES 1 minute
)
```

### Filter aggregated results
```sql
SELECT average(duration), count(*) FROM (
  SELECT count(*) AS cnt FROM Transaction FACET appName
) WHERE cnt > 100
```

### Subquery joins (enrich rows with aggregated data)
```sql
FROM Transaction JOIN (
  FROM Transaction SELECT average(duration) AS avgDur FACET appName LIMIT MAX
) ON appName
SELECT *, avgDur
```

**Limits**: Up to 3 nested levels. Subquery results capped at 5000 rows. JOIN has 1:100 cardinality limit.

## FACET

Groups results by field values. Multiple fields: `FACET field1, field2`.

- `FACET CASES(WHERE cond1, WHERE cond2, ...)` — custom buckets
- `LIMIT <n>` after FACET controls number of groups (default 10, max 5000, or MAX)

## WITH clause

Aliases computed expressions:
```sql
FROM Log SELECT * WITH numeric(duration) / 1000 AS durationSec
```

## WHERE operators

- Comparison: `=`, `!=`, `<`, `>`, `<=`, `>=`
- String: `LIKE '%pattern%'`, `NOT LIKE`, `RLIKE 'regex'`
- Null: `IS NULL`, `IS NOT NULL`
- Set: `IN ('a', 'b')`, `NOT IN`
- Boolean: `AND`, `OR`, `NOT`
- Existence: `field IS NOT NULL` (field exists)

## TIMESERIES

`TIMESERIES [AUTO | <interval>]` — interval examples: `1 minute`, `5 minutes`, `1 hour`, `1 day`.

## Time ranges

- `SINCE 1 hour ago`, `SINCE '2024-01-01'`
- `UNTIL now`, `UNTIL 30 minutes ago`
- `COMPARE WITH 1 week ago` — overlay comparison

## Translation Gotchas

These are non-obvious NRQL behaviors that cause silent bugs in SPL-to-NRQL translation.

- **OR binds tighter than AND** (opposite of SQL). `A AND B OR C` = `A AND (B OR C)`. Parenthesize AND groups inside OR expressions.
- **NRQL is typed, SPL is not.** `status=500` in SPL matches string or number. In NRQL: `status = '500' OR numeric(status) = 500`.
- **`capture()` uses Python regex** `(?P<name>)`, not PCRE `(?<name>)`. SPL `rex` named groups must be converted.
- **No UNION keyword.** SPL `append` cannot become `UNION`. Use multiple FROM types or subqueries.
- **No cross join** (`ON 1 = 1` invalid). For global aggregation enrichment (SPL `eventstats` without BY), use nested aggregation.
- **`filter(func, WHERE cond)`** — the WHERE keyword inside filter is required, not just a boolean expression.
- **`LIMIT MAX` required on subquery FACETs** or you silently get only 10 results. Default FACET limit is 10.
- **`WITH` aliases cannot be used in WHERE or FACET.** Only usable in SELECT output. To filter on a computed value, repeat the expression or use a subquery.
- **`SINCE`/`UNTIL` override WHERE time filters.** SPL `_time` comparisons should translate to `SINCE`/`UNTIL`, not WHERE.
- **Subquery result cap is 5000 rows** regardless of LIMIT MAX. High-cardinality FACET joins silently drop rows.
- **`uniques(field)` silently truncates at 1000.** Pass explicit limit: `uniques(field, 10000)`.
- **`latest(field)` returns the field value, not the whole row.** For dedup-like behavior, need `latest(field)` for each field individually.
- **Percentage of total pattern**: `FROM (inner FACET x) SELECT cnt / sum(cnt) * 100 FACET x` — no simpler way.
- **`LIKE` underscore is literal, not a wildcard.** Unlike SQL, `_` in NRQL LIKE is a literal character, not a single-char wildcard. `LIKE 'access_combined'` matches only `access_combined`, not `access1combined`. No need to escape underscores.

## Special event types

- `Log` — log events
- `Transaction` — APM transactions
- `TransactionError` — APM errors
- `Metric` — dimensional metrics (use `FROM Metric SELECT ...`)
- `ProcessSample`, `SystemSample`, `NetworkSample` — infrastructure
- `SyntheticCheck` — synthetic monitors
- `NrAuditEvent` — audit events
- `NrConsumption` — usage data
