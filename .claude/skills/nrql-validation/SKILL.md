---
name: nrql-validation
description: Use when validating that NRQL queries compile and execute against New Relic — running them via execute_nrql_query and classifying each result as SUCCESS or FAILURE (syntax/semantic/other) with the exact error. Shared by the main thread and the nrql-validator agent.
---

# NRQL Validation

Validate NRQL queries by executing them against New Relic and classifying each
result as success or failure with a clear explanation.

## How to Validate

Run every query using `mcp__plugin_nr_nr-mcp-server__execute_nrql_query` with `account_id: 1`. Use `FROM Log` as the default event type unless the caller specifies otherwise.

When validating many queries, run them in parallel where the tooling allows.

## Interpreting Responses

### Success

The response contains a nested `result.data.actor.account.nrql.results` array. This means the query compiled and executed. Report **SUCCESS** even if results are empty or zero — that just means no matching data, not a query problem.

Example success response:
```json
{"result":{"data":{"actor":{"account":{"nrql":{"results":[{"count":6402065898}]}}}}}}
```

### Failure — Syntax Error

The response has `"status":"failure"` and an `"error"` string starting with `"NRQL Syntax Error"`. This means the query could not be parsed at all. The error message includes the position and the unexpected token.

Example:
```json
{"error":"NRQL Syntax Error: Error at line 1 position 1, unexpected ';'","status":"failure"}
```

**Report**: FAILURE (syntax error) — quote the exact error message.

### Failure — Semantic Error

The response has `"status":"failure"` and an `"error"` string describing a logical/semantic problem. The query parsed but is structurally invalid. Common examples:
- `"FACET cannot be used when selecting on event fields"` — FACET requires an aggregation function in SELECT
- `"Invalid use of ..."` — function used in wrong context
- `"Unknown function ..."` — function doesn't exist
- Subquery nesting limit exceeded
- Invalid time range

Example:
```json
{"error":"FACET cannot be used when selecting on event fields","status":"failure"}
```

**Report**: FAILURE (semantic error) — quote the exact error message.

### Failure — Other

Any other shape with an error field or missing the expected `result.data` path is a failure. Quote whatever error information is available.

## Output Format

For each query validated, report:

```
QUERY: <the nrql query>
RESULT: SUCCESS | FAILURE (syntax error) | FAILURE (semantic error) | FAILURE (other)
DETAIL: <for success: row count or summary; for failure: exact error message>
```

If asked to validate multiple queries, validate them all (in parallel when possible) and report each result.

## Tips

- Zero rows returned is a SUCCESS — it means valid query, no matching data
- Fields that don't exist in the event type still produce a SUCCESS (with null values)
- The goal is to confirm NRQL compiles and executes, not that data exists
- If a query fails, suggest a fix when the error makes the problem obvious
- If a query times out or runs slowly against account 1, retry against account 10671289 (fewer logs)
