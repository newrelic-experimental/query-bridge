# Datadog → NRQL Translation Guide

Reference for translating Datadog queries into NRQL. Covers all four Datadog query surfaces: Log Explorer filters, Log Analytics aggregations, metric queries, and monitor alert queries.

## How Datadog Queries Work (The Mental Model)

Datadog splits what NRQL does in one statement across **two or three separate places**:

```
NRQL (one statement):
  SELECT count(*) FROM Log WHERE service = 'checkout' AND status = 'error' FACET host SINCE 1 hour ago

Datadog (split across UI/JSON):
  1. Filter bar:     service:checkout status:error
  2. Analytics UI:   measure = count, group by = host
  3. Time picker:    Past 1 Hour
```

In dashboard JSON, parts 1–3 are combined into a widget definition. In the Log Explorer UI, they're separate controls. A "Datadog query" is never a single string the way NRQL is — you always need to look at the filter + the aggregation config + the time range to get the full picture.

### The Four Query Surfaces

| Surface | What it looks like | Where you find it |
|---|---|---|
| **Log Explorer filter** | `service:checkout status:error` | Search bar in Log Explorer |
| **Log Analytics** | Filter + aggregation (count, avg, etc.) + group-by | "Analytics" tab in Log Explorer, or dashboard widget JSON |
| **Metric query** | `avg:system.cpu.user{env:prod} by {host}` | Dashboard metric widgets, Notebook cells |
| **Monitor query** | `logs("status:error").index("main").rollup(count).last("5m") > 100` | Monitor definitions |

---

## Log Explorer Filter Syntax

This is the search bar. It only filters — no aggregation, no projection.

### Reserved attributes (no `@` prefix)

These are first-class fields that Datadog treats specially:

| Datadog | NRQL | Notes |
|---|---|---|
| `service:checkout` | `WHERE service = 'checkout'` | Set by Service Remapper pipeline processor |
| `status:error` | `WHERE level = 'ERROR'` or `WHERE severity = 'ERROR'` | Set by Status Remapper |
| `host:web-01` | `WHERE hostname = 'web-01'` | |
| `source:nginx` | `WHERE source = 'nginx'` or `WHERE logtype = 'nginx'` | Depends on NR ingest config |

### Custom attributes (`@` prefix)

Anything parsed by a pipeline processor or sent as a structured field:

| Datadog | NRQL |
|---|---|
| `@http.status_code:404` | `WHERE http.status_code = 404` |
| `@http.url:/api/v1/users` | `WHERE http.url = '/api/v1/users'` |
| `@duration:>5000` | `WHERE duration > 5000` |
| `@http.status_code:[400 TO 499]` | `WHERE http.status_code >= 400 AND http.status_code <= 499` |
| `@user.email:*@example.com` | `WHERE user.email LIKE '%@example.com'` |
| `-@http.status_code:*` | `WHERE http.status_code IS NULL` |

### Boolean logic

| Datadog | NRQL |
|---|---|
| `service:web AND status:error` | `WHERE service = 'web' AND level = 'ERROR'` |
| `status:error OR status:warn` | `WHERE level IN ('ERROR', 'WARN')` |
| `-status:info` | `WHERE level != 'INFO'` |
| `(env:prod AND -version:beta)` | `WHERE env = 'prod' AND version != 'beta'` |

### Wildcards

| Datadog | NRQL | Notes |
|---|---|---|
| `service:web*` | `WHERE service LIKE 'web%'` | `*` = multi-char wildcard |
| `service:*mongo` | `WHERE service LIKE '%mongo'` | |
| `*NETWORK*` | `WHERE message LIKE '%NETWORK%'` | |
| `@attr:hello?world` | `WHERE attr LIKE 'hello_world'` | `?` = single-char wildcard (for spaces/special chars) |

### Escape characters

Special characters in Datadog filter values must be escaped with `\`: `= - ! ( ) { } [ ] " * ? : \ # space`. Example: `@http.url:\/api\/v1\/test` searches for literal `/api/v1/test`.

### Free-text search

| Datadog | NRQL | Notes |
|---|---|---|
| `authentication failure` | `WHERE message LIKE '%authentication failure%'` | DD searches `message`, `@title`, `@error.message`, `@error.stack` |
| `"exact phrase"` | `WHERE message LIKE '%exact phrase%'` | |
| `*:hello` | No single NRQL equivalent | DD `*:` searches ALL attributes. NRQL requires specifying which field to search. |

### Array search

Datadog supports searching within array-valued attributes:

| Datadog | NRQL | Notes |
|---|---|---|
| `@user_perms:4` | `WHERE user_perms = 4` | Single value in array |
| `@user_perms:(4 6)` | `WHERE user_perms = 4 AND user_perms = 6` | Array contains BOTH values |
| `@user_perms:[2 TO 6]` | `WHERE user_perms >= 2 AND user_perms <= 6` | Any value in range |

### Tags

Datadog tags are `key:value` pairs attached at ingest. They map to NR attributes (often custom):

| Datadog | NRQL |
|---|---|
| `env:prod` | `WHERE env = 'prod'` or `WHERE environment = 'prod'` |
| `env:(prod OR staging)` | `WHERE env IN ('prod', 'staging')` |

### CIDR (special function)

| Datadog | NRQL |
|---|---|
| `CIDR(@network.client.ip, 13.0.0.0/8)` | `WHERE cidrAddress(network.client.ip, 8) = '13.0.0.0/8'` |

---

## Log Analytics (Aggregations)

This is where Datadog does what NRQL's `SELECT ... FACET` does. In the UI it's the "Analytics" tab. In dashboard JSON it's the `compute` + `group_by` fields.

### Count

**Datadog (UI):** Filter = `status:error`, Measure = Count, Group by = `service`

**Datadog (dashboard widget JSON):**
```json
{
  "search": { "query": "status:error" },
  "compute": { "aggregation": "count" },
  "group_by": [{ "facet": "service", "limit": 10, "sort": { "aggregation": "count", "order": "desc" } }]
}
```

**NRQL:**
```sql
SELECT count(*) FROM Log WHERE level = 'ERROR' FACET service LIMIT 10 SINCE 1 hour ago
```

### Average of a numeric field

**Datadog (UI):** Filter = `service:checkout`, Measure = avg of `@duration`, Group by = `@http.url_details.path`

**Datadog (widget JSON):**
```json
{
  "search": { "query": "service:checkout" },
  "compute": { "aggregation": "avg", "facet": "@duration" },
  "group_by": [{ "facet": "@http.url_details.path", "limit": 10, "sort": { "aggregation": "avg", "facet": "@duration", "order": "desc" } }]
}
```

**NRQL:**
```sql
SELECT average(duration) FROM Log WHERE service = 'checkout' FACET http.url_details.path LIMIT 10 SINCE 1 hour ago
```

### Percentiles

**Datadog (widget JSON):**
```json
{
  "search": { "query": "service:api" },
  "compute": { "aggregation": "pc95", "facet": "@duration" }
}
```

**NRQL:**
```sql
SELECT percentile(duration, 95) FROM Log WHERE service = 'api' SINCE 1 hour ago
```

Datadog aggregation → NRQL function mapping:

| Datadog | NRQL |
|---|---|
| `count` | `count(*)` |
| `cardinality` | `uniqueCount(field)` |
| `avg` | `average(field)` |
| `sum` | `sum(field)` |
| `min` | `min(field)` |
| `max` | `max(field)` |
| `median` | `median(field)` or `percentile(field, 50)` |
| `pc75` | `percentile(field, 75)` |
| `pc90` | `percentile(field, 90)` |
| `pc95` | `percentile(field, 95)` |
| `pc98` | `percentile(field, 98)` |
| `pc99` | `percentile(field, 99)` |

### Timeseries (with interval)

**Datadog (widget JSON):**
```json
{
  "search": { "query": "service:checkout status:error" },
  "compute": { "aggregation": "count", "interval": 300000 },
  "group_by": [{ "facet": "service", "limit": 10 }]
}
```

> **Note:** `compute.interval` is in **milliseconds** in the API (300000 = 5 min). The UI displays human-readable strings.

**NRQL:**
```sql
SELECT count(*) FROM Log WHERE service = 'checkout' AND level = 'ERROR' FACET service LIMIT 10 TIMESERIES 5 minutes SINCE 1 hour ago
```

### Multiple group-by dimensions

Datadog supports up to 4 `group_by` facets. NRQL supports multiple `FACET` attributes:

**Datadog:**
```json
{
  "group_by": [
    { "facet": "service" },
    { "facet": "@http.status_code" }
  ]
}
```

**NRQL:**
```sql
SELECT count(*) FROM Log FACET service, http.status_code SINCE 1 hour ago
```

---

## Full Widget Translation Examples

### Example 1: Error rate timeseries by service

**Datadog dashboard widget:**
```json
{
  "definition": {
    "type": "timeseries",
    "title": "Error count by service",
    "requests": [{
      "queries": [{
        "data_source": "logs",
        "name": "query1",
        "search": { "query": "status:error" },
        "indexes": ["main"],
        "compute": { "aggregation": "count" },
        "group_by": [{
          "facet": "service",
          "limit": 10,
          "sort": { "aggregation": "count", "order": "desc" }
        }]
      }],
      "formulas": [{ "formula": "query1" }],
      "response_format": "timeseries"
    }]
  }
}
```

**NRQL:**
```sql
SELECT count(*) FROM Log WHERE level = 'ERROR' FACET service LIMIT 10 TIMESERIES AUTO SINCE 1 hour ago
```

### Example 2: Top endpoints by p95 latency

**Datadog widget:**
```json
{
  "definition": {
    "type": "toplist",
    "title": "Slowest endpoints",
    "requests": [{
      "queries": [{
        "data_source": "logs",
        "name": "query1",
        "search": { "query": "service:api @http.method:GET" },
        "compute": { "aggregation": "pc95", "facet": "@duration" },
        "group_by": [{
          "facet": "@http.url_details.path",
          "limit": 25,
          "sort": { "aggregation": "pc95", "facet": "@duration", "order": "desc" }
        }]
      }],
      "formulas": [{ "formula": "query1" }],
      "response_format": "scalar"
    }]
  }
}
```

**NRQL:**
```sql
SELECT percentile(duration, 95) FROM Log WHERE service = 'api' AND http.method = 'GET' FACET http.url_details.path LIMIT 25 SINCE 1 hour ago
```

### Example 3: Multi-query formula (error rate %)

**Datadog widget:**
```json
{
  "requests": [{
    "queries": [
      {
        "data_source": "logs",
        "name": "errors",
        "search": { "query": "service:checkout status:error" },
        "compute": { "aggregation": "count" }
      },
      {
        "data_source": "logs",
        "name": "total",
        "search": { "query": "service:checkout" },
        "compute": { "aggregation": "count" }
      }
    ],
    "formulas": [{ "formula": "errors / total * 100", "alias": "error_rate_pct" }],
    "response_format": "timeseries"
  }]
}
```

**NRQL** (using `filter()`):
```sql
SELECT filter(count(*), WHERE level = 'ERROR') / count(*) * 100 AS 'error_rate_pct' FROM Log WHERE service = 'checkout' TIMESERIES AUTO SINCE 1 hour ago
```

**NRQL** (cleaner — using `percentage()`):
```sql
SELECT percentage(count(*), WHERE level = 'ERROR') AS 'error_rate_pct' FROM Log WHERE service = 'checkout' TIMESERIES AUTO SINCE 1 hour ago
```

> **Prefer `percentage()`** for simple rate calculations — it handles division-by-zero (returns 0 instead of null). Use `filter()` when you need the raw counts or more complex formulas.

### Example 4: Unique users affected by errors

**Datadog widget:**
```json
{
  "search": { "query": "status:error service:checkout" },
  "compute": { "aggregation": "cardinality", "facet": "@user.id" },
  "group_by": [{ "facet": "@error.kind", "limit": 10 }]
}
```

**NRQL:**
```sql
SELECT uniqueCount(user.id) FROM Log WHERE level = 'ERROR' AND service = 'checkout' FACET error.kind LIMIT 10 SINCE 1 hour ago
```

### Example 5: Compare to previous period

**Datadog:** Any timeseries widget with "Compare to: Previous week" toggle enabled.

**NRQL:**
```sql
SELECT count(*) FROM Log WHERE level = 'ERROR' TIMESERIES AUTO SINCE 1 hour ago COMPARE WITH 1 week ago
```

### Example 6: Category-based grouping

**Datadog:** Category Processor creates buckets (e.g., response time categories), then group by the category attribute.

**NRQL** (using `FACET CASES()`):
```sql
SELECT count(*) FROM Log
FACET CASES(
  WHERE duration < 100 AS 'fast',
  WHERE duration >= 100 AND duration < 500 AS 'medium',
  WHERE duration >= 500 AS 'slow'
)
SINCE 1 hour ago
```

### Example 7: Latest value (Query Value widget)

**Datadog:** Query Value widget showing most recent metric.

**NRQL:**
```sql
SELECT latest(cpuPercent) FROM SystemSample WHERE hostname = 'web-01'
```

### Example 8: List distinct values

**Datadog:** Log Explorer "Top Values" facet panel.

**NRQL:**
```sql
SELECT uniques(service, 10000) FROM Log SINCE 1 hour ago
```

> **Warning:** `uniques()` silently truncates at 1000 by default. Always pass an explicit limit.

---

## Metric Queries

Datadog metric queries use a completely different syntax from log queries. These appear in metric-type dashboard widgets.

### Basic syntax

```
aggregation:metric.name{tag_filters} by {group_tag}
```

| Datadog | NRQL |
|---|---|
| `avg:system.cpu.user{*}` | `SELECT average(cpuPercent) FROM SystemSample` |
| `avg:system.cpu.user{host:web-01}` | `SELECT average(cpuPercent) FROM SystemSample WHERE hostname = 'web-01'` |
| `avg:system.cpu.user{env:prod} by {host}` | `SELECT average(cpuPercent) FROM SystemSample WHERE env = 'prod' FACET hostname` |
| `sum:requests{service:api}` | `SELECT sum(requests) FROM Metric WHERE service = 'api'` |
| `max:system.disk.used{*} by {device}` | `SELECT max(diskUsedPercent) FROM StorageSample FACET device` |

### Tag filters

| Datadog | NRQL |
|---|---|
| `{env:prod,region:us-east-1}` | `WHERE env = 'prod' AND region = 'us-east-1'` |
| `{!env:staging}` | `WHERE env != 'staging'` |
| `{env:prod OR env:staging}` | `WHERE env IN ('prod', 'staging')` |

### Rollup (time aggregation)

| Datadog | NRQL |
|---|---|
| `avg:metric{*}.rollup(avg, 60)` | `TIMESERIES 1 minute` |
| `avg:metric{*}.rollup(sum, 300)` | `TIMESERIES 5 minutes` (with `sum` aggregation) |
| `avg:metric{*}.rollup(max, 3600)` | `TIMESERIES 1 hour` (with `max` aggregation) |

### Formulas

Datadog assigns each query a letter and lets you write arithmetic:

**Datadog:**
```
a: sum:requests{status:error}
b: sum:requests{*}
formula: a / b * 100
```

**NRQL:**
```sql
SELECT filter(count(*), WHERE status = 'error') / count(*) * 100 FROM Transaction
```

Or for pre-aggregated metrics:
```sql
SELECT sum(requests.error) / sum(requests.total) * 100 FROM Metric
```

### Custom metrics (general pattern)

The examples above map DD infra metrics to NR event types (`SystemSample`, `StorageSample`). For custom/application metrics, use the general `Metric` event type:

```sql
SELECT average(value) FROM Metric WHERE metricName = 'custom.requests.count' FACET service SINCE 1 hour ago
```

### Metric functions

| Datadog | NRQL | Notes |
|---|---|---|
| `.rollup(method, interval)` | `TIMESERIES interval` | |
| `.as_count()` | Use `sum()` or `count()` | Converts rate-stored metrics to raw counts |
| `.as_rate()` | `rate(sum(field), 1 second)` | |
| `.fill(zero)` | No direct equivalent | Gaps remain in NRQL timeseries |
| `top(metric{*}, 10, 'mean', 'desc')` | `FACET tag LIMIT 10` | |
| `timeshift(metric{*}, -1w)` | `COMPARE WITH 1 week ago` | |
| `per_second(metric{*})` | `rate(sum(field), 1 second)` | |
| `anomalies(metric{*}, 'basic', 2)` | Use NRQL baseline alerts | |
| `forecast(metric{*}, 'linear', 1w)` | `PREDICT` clause (limited) | |
| `diff(metric{*})` | No direct equivalent | |
| `derivative(metric{*})` | `derivative(field)` | Limited contexts |
| `monotonic_diff(metric{*})` | No direct equivalent | |
| `cumsum(metric{*})` | No direct equivalent | No running totals in NRQL |

---

## Monitor Alert Queries

Monitor queries are a single string DSL — the only Datadog query type that is self-contained.

### Log monitors

**Syntax:** `logs(filter).index(idx).rollup(method[, facet]).last(window) op threshold`

| Datadog monitor query | NRQL alert condition |
|---|---|
| `logs("status:error").index("main").rollup(count).last("5m") > 100` | `SELECT count(*) FROM Log WHERE level = 'ERROR' SINCE 5 minutes ago` with threshold > 100 |
| `logs("@http.status_code:[500 TO 599]").index("*").rollup(count).last("15m") > 50` | `SELECT count(*) FROM Log WHERE http.status_code >= 500 AND http.status_code <= 599 SINCE 15 minutes ago` with threshold > 50 |
| `logs("service:api @duration:>5000").index("main").rollup(avg, @duration).last("10m") > 8000` | `SELECT average(duration) FROM Log WHERE service = 'api' AND duration > 5000 SINCE 10 minutes ago` with threshold > 8000 |
| `logs("status:error").index("main").rollup(cardinality, @user.id).last("1h") > 500` | `SELECT uniqueCount(user.id) FROM Log WHERE level = 'ERROR' SINCE 1 hour ago` with threshold > 500 |

### Metric monitors

**Datadog:**
```
avg(last_5m):avg:system.cpu.user{env:prod} by {host} > 90
```

**NRQL alert:**
```sql
SELECT average(cpuPercent) FROM SystemSample WHERE env = 'prod' FACET hostname SINCE 5 minutes ago
```
With threshold > 90.

The `avg(last_5m):` prefix is the evaluation window — how Datadog collapses the window to a single number:

| Datadog window function | NRQL equivalent |
|---|---|
| `avg(last_Xm)` | Default behavior (NRQL averages over the window) |
| `max(last_Xm)` | `SELECT max(...)` |
| `min(last_Xm)` | `SELECT min(...)` |
| `sum(last_Xm)` | `SELECT sum(...)` |
| `change(...)` | Partial: `COMPARE WITH` for visual; baseline alerts for thresholds |
| `pct_change(...)` | Partial: `COMPARE WITH` for visual; baseline alerts for thresholds |

### Composite monitors

**Datadog:** `12345 && 67890` or `12345 \|\| !67890` (referencing monitor IDs)

**NR equivalent:** Use [workflow conditions](https://docs.newrelic.com/docs/alerts-applied-intelligence/new-relic-alerts/alert-conditions/create-nrql-alert-conditions/) with multiple conditions in a single policy, or use the Decisions feature to correlate alerts.

> **Note:** The monitor DSL is the serialized format stored in monitor definitions. Users don't typically write these by hand — they're generated by the UI or API. But they appear in `GET /api/v1/monitor` exports, so translators need to parse them.

---

## Field Name Mapping Gotchas

Datadog field names won't match NR field names. This is the hardest part of translation — it depends entirely on how each side ingests and parses logs.

### Common mappings

| Datadog field | NR field | Notes |
|---|---|---|
| `service` | `service` or `service.name` | Depends on NR ingest config |
| `status` | `level` or `severity` | DD Status Remapper → NR log level |
| `host` | `hostname` or `host` | |
| `source` | `logtype` or `source` | |
| `@duration` | `duration` | If parsed similarly |
| `@http.status_code` | `http.statusCode` or `response.status` | Varies by instrumentation |
| `@http.method` | `http.method` or `request.method` | |
| `@http.url` | `http.url` or `request.uri` | |
| `@error.message` | `error.message` | |
| `@error.stack` | `error.stack` or `stackTrace` | |
| `@usr.id` | `user.id` or `enduser.id` | |
| `@trace_id` | `trace.id` | Log-to-trace correlation |
| `message` (reserved) | `message` | Raw log body; DD's `message` is what free-text search hits |
| `@duration` | `duration` | **Units differ**: DD convention is nanoseconds, NR varies (often ms for APM) |

### Pipeline processors affect field names

Datadog's Log Pipelines rename, remap, and restructure fields at ingest time. A customer's `@http.status_code` might actually come from a raw field called `statusCode` or `response_code` that was remapped by a Grok parser + attribute remapper. When translating, you need to understand what the pipeline does — the query-time field names are pipeline outputs, not raw log fields.

**Export pipelines for reference:**
```bash
curl "${DD_SITE:-https://api.datadoghq.com}/api/v1/logs/config/pipelines" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}"
```

This returns the full pipeline configuration including Grok parsers, remappers, category processors, etc. Essential context for understanding why fields are named what they are.

---

## Building a Query Corpus

To get real-world Datadog queries for translation practice:

### 1. Export all dashboard widget queries

```bash
# Get all dashboard IDs
IDS=$(curl -s "${DD_SITE:-https://api.datadoghq.com}/api/v1/dashboard" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  | jq -r '.dashboards[].id')

# Extract just the queries from each dashboard
for ID in $IDS; do
  curl -s "${DD_SITE:-https://api.datadoghq.com}/api/v1/dashboard/${ID}" \
    -H "DD-API-KEY: ${DD_API_KEY}" \
    -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
    | jq '[.widgets[].definition |
      if .requests then
        .requests[] |
        if .queries then
          .queries[] | {data_source, query: (.query // .search.query), compute, group_by}
        else
          {legacy_query: (.q // .log_query // .apm_query)}
        end
      else empty end]'
  sleep 0.5
done
```

### 2. Export monitor definitions

```bash
curl -s "${DD_SITE:-https://api.datadoghq.com}/api/v1/monitor" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  | jq '[.[] | {name, type, query}]'
```

### 3. Audit trail for ad-hoc queries

```bash
curl -X POST "${DD_SITE:-https://api.datadoghq.com}/api/v2/audit/events/search" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": {
      "from": "now-30d",
      "to": "now",
      "query": "@evt.name:\"Log Management\" @asset.type:logs_query"
    },
    "page": { "limit": 1000 }
  }'
```

---

## NRQL Gotcha: Operator Precedence

**NRQL's `OR` binds tighter than `AND`** — the opposite of SQL and Datadog.

```
NRQL:    A AND B OR C  =  A AND (B OR C)
SQL/DD:  A AND B OR C  =  (A AND B) OR C
```

When translating Datadog boolean logic, always add explicit parentheses around `OR` groups that should be isolated from `AND`:

```sql
-- Datadog: status:error OR status:warn AND service:web
-- Datadog evaluates as: (status:error OR status:warn) AND service:web  (AND binds tighter)
-- Naive NRQL would be: level = 'ERROR' OR level = 'WARN' AND service = 'web'
-- NRQL evaluates as:   level = 'ERROR' OR (level = 'WARN' AND service = 'web')  ← WRONG

-- Correct NRQL:
WHERE (level = 'ERROR' OR level = 'WARN') AND service = 'web'
```

When in doubt, parenthesize.

---

## Translation Checklist

When translating a Datadog query → NRQL:

1. **Identify the query surface** — is it a filter, analytics, metric, or monitor query?
2. **Extract the filter** — translate `service:X status:Y @field:Z` into `WHERE` clauses
3. **Check boolean logic** — parenthesize `OR` groups (NRQL OR binds tighter than AND)
4. **Extract the aggregation** — translate `compute.aggregation` into `SELECT` function
5. **Extract the group-by** — translate `group_by[].facet` into `FACET`
6. **Extract the time range** — translate to `SINCE`/`UNTIL` or `TIMESERIES`
7. **Map field names** — Datadog `@http.status_code` → NR `http.statusCode` (customer-specific)
8. **Map reserved attributes** — `status:error` → `level = 'ERROR'`, `host` → `hostname`
9. **Handle formulas** — multi-query arithmetic → `percentage()`, `filter()`, or subqueries
10. **Check units** — DD `duration` is nanoseconds; NR varies by event type

## References

- [Datadog Log Search Syntax](https://docs.datadoghq.com/logs/explorer/search_syntax/)
- [Datadog Log Analytics](https://docs.datadoghq.com/logs/explorer/analytics/)
- [Datadog Dashboard Querying](https://docs.datadoghq.com/dashboards/querying/)
- [Datadog Monitors API](https://docs.datadoghq.com/api/latest/monitors/)
- [Datadog Log Pipeline Processors](https://docs.datadoghq.com/logs/log_configuration/processors/)
- [Datadog Logs Aggregate API](https://docs.datadoghq.com/api/latest/logs/#aggregate-events)
- [NRQL Reference](https://docs.newrelic.com/docs/nrql/get-started/introduction-nrql-new-relics-query-language/)
