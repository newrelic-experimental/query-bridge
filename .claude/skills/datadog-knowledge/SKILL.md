---
name: datadog-knowledge
description: Use when reading Datadog queries across any of its surfaces (Log Explorer filters, Log Analytics, metric queries, monitor DSL, widget JSON), mapping Datadog attributes to New Relic names, or translating Datadog queries to NRQL. Domain knowledge shared by the main thread and the datadog-expert agent.
---

# Datadog Knowledge

Datadog's query languages and data model across all four query surfaces (Log
Explorer filters, Log Analytics, metric queries, and monitor queries): what they
do, how to reassemble intent, and how to translate to NRQL.

## Knowledge Sources

1. Read `.claude/references/datadog-reference.md` for the full Datadog query reference with examples and translation gotchas
2. Read `docs/SPL_TO_NRQL.md` for current translation status (to understand the project's patterns)
3. Use web search to look up specific Datadog features when needed

### Documentation URLs

Use these for deeper research when the local reference isn't enough:
- https://docs.datadoghq.com/logs/explorer/search_syntax/ — Log search syntax
- https://docs.datadoghq.com/logs/explorer/analytics/ — Log analytics aggregations
- https://docs.datadoghq.com/dashboards/querying/ — Metric query syntax
- https://docs.datadoghq.com/dashboards/functions/ — Metric functions (timeshift, rate, anomaly, etc.)
- https://docs.datadoghq.com/monitors/configuration/ — Monitor query DSL
- https://docs.datadoghq.com/api/latest/logs/#aggregate-events — Log aggregate API
- https://docs.datadoghq.com/logs/log_configuration/processors/ — Pipeline processors
- https://docs.datadoghq.com/logs/log_configuration/attributes_naming_convention/ — Standard attributes

## The Structural Problem

Datadog does NOT have a single query language like SPL or NRQL. A "Datadog query" is split across multiple places:

1. **Filter string** — `service:checkout status:error @http.status_code:[500 TO 599]`
2. **Aggregation config** — JSON object with `compute`, `group_by` (in dashboard widgets or the Analytics API)
3. **Time range** — separate parameter, never in the query string
4. **Formulas** — multi-query arithmetic referencing named queries by letter

When analyzing a Datadog query, you must identify which surface it comes from and reassemble the full intent before translating.

## How to Analyze a Datadog Query

1. Identify which query surface the input comes from (filter, widget JSON, metric query, or monitor DSL)
2. Explain what the query does in plain English
3. If it's a widget JSON, describe the filter, aggregation, and group-by separately
4. Suggest the equivalent NRQL query
5. Flag any field name mapping issues (Datadog `@http.status_code` ≠ NR `http.statusCode`)

When responding, always include:
- Which Datadog query surface the input comes from
- What the query does in plain English
- The equivalent NRQL query
- Any field name mapping assumptions

## Key Datadog Concepts for Translation

- **Filter-only search bar**: No aggregation in the filter string — it's purely WHERE clause equivalent
- **Reserved vs custom attributes**: `service`, `status`, `host`, `source` are bare; everything else needs `@` prefix
- **`@` prefix disappears in translation**: `@http.status_code` → `http.statusCode` (drop the `@`, map the name)
- **Aggregation is config, not syntax**: Datadog `compute.aggregation: "count"` → NRQL `SELECT count(*)`
- **Formulas span queries**: `a / b * 100` where a and b are separate queries → NRQL `filter()` or subquery
- **Monitor DSL is self-contained**: `logs("filter").index("x").rollup(count).last("5m") > 100` — the only Datadog query that's a single string
- **Pipeline processors determine field names**: A customer's field names depend on their Grok parsers and remappers

## Datadog Standard Attributes

These are Datadog's "blessed" field names (like OTel semantic conventions). The customer's pipeline likely maps raw fields to these:

**HTTP**: `http.method`, `http.status_code`, `http.url`, `http.url_details.host`, `http.url_details.path`, `http.url_details.queryString`, `http.url_details.scheme`, `http.url_details.port`, `http.useragent`, `http.referer`, `http.request_id`, `http.version`

**Network**: `network.client.ip`, `network.client.port`, `network.destination.ip`, `network.destination.port`, `network.bytes_read`, `network.bytes_written`

**Error**: `error.kind`, `error.message`, `error.stack`

**User**: `usr.id`, `usr.name`, `usr.email`

**Syslog**: `syslog.hostname`, `syslog.appname`, `syslog.severity`, `syslog.timestamp`, `syslog.env`

**DNS**: `dns.id`, `dns.question.name`, `dns.question.type`, `dns.question.class`, `dns.question.size`, `dns.answer.name`, `dns.answer.type`, `dns.answer.class`, `dns.answer.size`

**Duration**: `duration` (nanoseconds by convention)

## Widget JSON Structure

Dashboard widgets are the most common source of Datadog queries. Key fields:

```json
{
  "search": { "query": "<filter string>" },
  "compute": {
    "aggregation": "<count|avg|sum|min|max|cardinality|pc75|pc90|pc95|pc98|pc99|median>",
    "facet": "<@attribute>",
    "interval": "<ms>"
  },
  "group_by": [{
    "facet": "<attribute>",
    "limit": 10,
    "sort": { "aggregation": "<func>", "facet": "<@attr>", "order": "desc" }
  }]
}
```

- `search.query` → NRQL `WHERE` clause
- `compute.aggregation` → NRQL `SELECT` function
- `compute.facet` → argument to the aggregation function
- `compute.interval` → `TIMESERIES` interval (convert ms to minutes/hours)
- `group_by[].facet` → `FACET` fields
- `group_by[].limit` → `LIMIT` value

## Multi-Query Formulas

Datadog widgets can have multiple named queries combined by a formula:

```json
{
  "queries": [
    { "name": "errors", "search": { "query": "status:error" }, "compute": { "aggregation": "count" } },
    { "name": "total", "search": { "query": "*" }, "compute": { "aggregation": "count" } }
  ],
  "formulas": [{ "formula": "errors / total * 100" }]
}
```

Translation approaches:
- **Same event type, different filters** → NRQL `filter()`: `SELECT filter(count(*), WHERE level = 'ERROR') / count(*) * 100`
- **Different event types** → NRQL subquery: `SELECT count(*) * 100.0 / (SELECT count(*) FROM OtherEvent)`
- **Different aggregations** → NRQL nested aggregation or multiple columns
