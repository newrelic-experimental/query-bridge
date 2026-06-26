---
name: nrql-knowledge
description: Use when writing or reviewing NRQL, finding the NRQL equivalent of an SPL/Datadog pattern, reasoning about NRQL operator precedence (OR binds tighter than AND), or using jparse/contains/lookup/subqueries. Domain knowledge shared by the main thread and the nrql-expert agent.
---

# NRQL Knowledge

New Relic Query Language (NRQL): finding NRQL equivalents for source-query
patterns, validating syntax, and choosing the most idiomatic approach.

## Knowledge Sources

1. Read `.claude/references/nrql-reference.md` for the full NRQL reference and translation gotchas
2. Use the New Relic documentation MCP tools to look up specific functions or features
3. Use `mcp__plugin_nr_nr-mcp-server__execute_nrql_query` to test queries against real data (when MCP is available in your context)

### Documentation URLs

Use these for deeper research when the local reference isn't enough:
- https://docs.newrelic.com/docs/nrql/nrql-syntax-clauses-functions/ — NRQL syntax and functions
- https://docs.newrelic.com/docs/nrql/nrql-syntax-clauses-functions/#func-capture — capture() regex syntax
- https://docs.newrelic.com/docs/nrql/nrql-syntax-clauses-functions/#sel-filter — filter() function
- https://docs.newrelic.com/docs/nrql/using-nrql/subqueries-in-nrql/ — subquery syntax and limits
- https://docs.newrelic.com/docs/nrql/using-nrql/nrql-math-using-select/ — math and operators
- https://docs.newrelic.com/docs/nrql/using-nrql/nrql-conditions-and-operators/ — WHERE operators

## Validate NRQL via MCP

> ⚠️ **`execute_nrql_query` runs an older NRQL grammar — re-check failures via `run_nerdgraph_query` (verified acct 1, 2026-06-24).** It falsely rejects 12 functions — `jparse`, `convert`, `cidrAddress`, `toTimestamp`, `toDatetime`, `encode`, `decode`, `mapKeys`, `mapValues`, `split`, `replace`, `aggregateFunnel` — AND the `PREDICT` clause (`unexpected 'PREDICT'`). These DO work — re-run via `run_nerdgraph_query` (`run_nerdgraph_query(query: "query($id:Int!,$q:Nrql!){actor{account(id:$id){nrql(query:$q){results}}}}", variables: {id:1, q:"<NRQL>"})`) or the UI. NOT affected: `blob`, `lookup`, `stddev`, `subnet`, `meta`, `hdrHistogram`/`hdrPercentile`/`hdrPercentiles`, `attributeCardinality`, `SLIDE BY`. NOTE: `Unknown function count()` from `numeric(count(x))`-style queries is NOT a tool bug — it's NRDB rejecting an invalid query (a row-wise function wrapping an aggregate it can't take); deterministic on both tools (`string()` can wrap an aggregate, `numeric()` can't). Account 1 Log: max 1-hour windows or queries time out. Full classified list: `.claude/references/nrql-reference.md`.

When `mcp__plugin_nr_nr-mcp-server__execute_nrql_query` is available, **validate every NRQL query you produce or review** by running it against account 1. Even if the fields don't exist in the target event type, this confirms the query compiles (valid syntax). A query that returns zero rows is fine — a query that returns an error is not.

Use `FROM Log` as the default event type for validation. If the query uses fields that don't exist, that's OK — the goal is to confirm NRQL syntax is valid, not that data exists.

Example validation:
```
execute_nrql_query(account_id=1, nrql_query="FROM Log SELECT count(*) * 100.0 / (SELECT count(*) FROM Log) AS 'percent' FACET `host` LIMIT 10")
```

If the query fails to compile, report the exact error and suggest a fix. For the full success/failure classification procedure, see the `nrql-validation` skill.

## How to Translate

1. First check the NRQL reference for the function/feature
2. If not found, search New Relic docs via `mcp__plugin_nr_nr-mcp-server__search_new_relic_documentation`
3. Suggest the most idiomatic NRQL approach
4. Run the query against account 1 to confirm it compiles (if MCP is available)
5. Note any limitations (row limits, cardinality limits, nesting limits)

When responding, always include:
- The NRQL query
- The MCP validation result (compiled OK / error + message), if MCP was available
- Any limitations or caveats

## jparse() Path Syntax

`jparse(field, 'path')` extracts values from JSON stored in a field. Uses **bare paths** (NOT JSONPath `$.` prefix — that will fail).

Reference: https://docs.newrelic.com/docs/nrql/nrql-syntax-clauses-functions/#json-parse-path-syntax-reference

Key syntax:
- `valueA` — scalar value at key
- `valueB.nestedValue2` — nested object access
- `valueC[0]` — array index
- `valueC[0,2]` — multiple indices
- `valueC[0:2]` — range (exclusive end)
- `valueC[*]` — all array elements
- `valueC[*].id` — specific key from all array elements → returns `[1, 2, 3]`
- `valueC[*]["label", "other"]` — multiple keys from all array elements

For array element filtering (e.g., SPL `lineItemList{}.status=active`), combine with `contains()`:
```sql
WHERE contains(jparse(message, 'lineItemList[*].status'), 'active')
```

## contains() Function

Checks if an element exists in an array. Takes two args: the array attribute and the element to find.

```sql
-- Check if array contains element
SELECT contains(guids, '5555-3456-555') FROM Foo

-- Filter using contains
SELECT count(*) FROM Transaction WHERE contains(guids, '9999-1234-9999')
```

Works with `jparse()` output when jparse returns an array (e.g., from `[*]` paths).

## Lookup Tables

NRQL supports lookup tables uploaded via the Logs UI or REST API. Useful for exclusion/inclusion patterns.

- `FROM lookup(tableName) SELECT *` — returns rows from the lookup table
- `WHERE field NOT IN (FROM lookup(tableName) SELECT field LIMIT MAX)` — exclusion subquery
- Non-existent tables return empty results (no error), so `NOT IN` silently returns all events
- For examples with real data, try: `SELECT * FROM lookup(topAccountsStaging)`

## CRITICAL: NRQL Operator Precedence (OR binds TIGHTER than AND)

In NRQL, OR has HIGHER precedence than AND. This is the OPPOSITE of SQL/SPL.

```
NRQL:  A AND B OR C  =  A AND (B OR C)
SQL:   A AND B OR C  =  (A AND B) OR C
```

The SPL-to-NRQL translator DELIBERATELY exploits this. The "numeric dual-check" pattern produces `field = 'val' OR numeric(field) = val` — and because OR binds tighter, these two checks naturally group together WITHOUT parentheses.

### Worked Examples — study these before reviewing

1. `status = '200' OR numeric(status) = 200 AND host = 'web'`
   Parses as: `(status = '200' OR numeric(status) = 200) AND host = 'web'`
   THIS IS CORRECT. Do NOT flag missing parens.

2. `a = '1' OR numeric(a) = 1 AND b = '2' OR numeric(b) = 2`
   Parses as: `(a = '1' OR numeric(a) = 1) AND (b = '2' OR numeric(b) = 2)`
   THIS IS CORRECT. Do NOT flag missing parens.

3. `a = '1' OR numeric(a) = 1 OR b = '2' OR numeric(b) = 2 AND c = '3' OR numeric(c) = 3`
   Parses as: `(a = '1' OR numeric(a) = 1 OR b = '2' OR numeric(b) = 2) AND (c = '3' OR numeric(c) = 3)`
   Meaning: (a=1 OR b=2) AND c=3. THIS IS CORRECT.

4. `(X AND Y) OR (Z AND W)` where X, Y, Z, W are each dual-check pairs:
   Inside each paren group, OR pairs bind first, then AND joins them.
   THIS IS CORRECT.

**DO NOT flag dual-check pairs as needing parentheses.** If you think you found a precedence bug, work through the parsing step by step using NRQL rules (OR tighter) before flagging it.

## Key NRQL Capabilities for SPL Translation

- **Subqueries**: Nested in WHERE, FROM, or JOIN — up to 3 levels, 5000-row limit
- **Subquery JOINs**: `FROM Event JOIN (subquery) ON key` — enriches rows with aggregated data
- **Nested aggregation**: `FROM (SELECT ... FACET ...) SELECT ...` — aggregate over aggregates
- **percentage()**: Percentage of dataset matching a condition
- **filter()**: Conditional aggregation within SELECT
- **WITH clause**: Computed field aliases. WITH aliases CAN reference earlier WITH aliases in the same query (chaining works).
- **OR as coalesce in expressions**: `field OR default` in expression context (WITH, if()) returns the field value if non-null, else the default. This is NOT the boolean OR — it's null-coalescing. `numeric(bytes OR 0)` is valid and means "numeric value of bytes, or 0 if null".
- **histogram()/buckets()**: Bucketing functions
- **Subquery arithmetic**: `count(*) * 100.0 / (SELECT count(*) FROM Event)` — per-facet percentages

## NRQL Reserved Words

**Clause keywords** — must be backtick-escaped when used as attribute names:

```
SELECT, FROM, WHERE, AND, OR, NOT, AS, FACET, LIMIT, SINCE, UNTIL,
TIMESERIES, COMPARE, WITH, IN, IS, LIKE, RLIKE, ORDER, BY, ASC, DESC,
JOIN, ON, NULL, TRUE, FALSE, PREDICT, RAW, EXTRAPOLATE, SHOW, AUTO,
MAX, OFFSET, SLIDE
```

**Function names** (rate, filter, average, count, etc.) do NOT need backticking — NRQL distinguishes them by context (parens = function call, bare = field reference).

**Special attribute names** — these have meaning in NRQL but can be used as field names without backticking:

```
timestamp, eventType, appId, appName, entity.guid, entity.name,
nr.guid, nr.entity.type
```

Case-insensitive — `select`, `Select`, and `SELECT` all need backticking as field names.
