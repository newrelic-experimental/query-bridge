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
| `substring(field, start [, length])` | Substring extraction. **0-based** (first char = position 0); 3rd arg is a character count, not an end position. (SPL `substr` is 1-based, so SPL start `N` → NRQL `N-1`.) |
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

## Functions on a WHERE comparison RHS

The RHS of a comparison operator (`=`, `!=`, `<`, `>`, `<=`, `>=`) accepts a literal, a field reference, an arithmetic expression, OR a function call — but **only some non-aggregator functions are valid there.** Functions that return a scalar (number/string/bool) work; functions that return a map, blob, or perform unit/encoding/timestamp conversion are rejected with `Not supported: Call <fn>`. Verified against account 1 (`FROM Transaction`/`FROM Log`, 30-min windows, 2026-06-10).

**`LIKE`, `RLIKE`, and `IN` are different** — their RHS is a literal-only slot (LIKE/RLIKE reject any function OR bare field with `unexpected '<token>'`; `IN` accepts a subquery but rejects a scalar function in the value list). Do NOT put functions there. See the SPL where-comparison-RHS spec for the full LIKE/RLIKE/IN findings.

| Function | Comparison RHS | Notes |
|---|---|---|
| `numeric` | ✓ | |
| `string` | ✓ | |
| `if(cond, a, b)` | ✓ | |
| `concat` / `lower` / `upper` | ✓ | string ops |
| `length` | ✓ | |
| `substring` | ✓ | |
| `position` | ✓ | |
| `mod` | ✓ | |
| `abs` / `ceil` / `floor` / `round` | ✓ | |
| `sqrt` / `pow` / `exp` / `ln` / `log` / `log2` / `log10` | ✓ | |
| `clamp_min` / `clamp_max` | ✓ | |
| `aparse` | ✓ | |
| `getField` | ✓ | |
| `getCdfCount` | ✓ | |
| `eventType()` | ✓ | |
| `accountId()` | ✓ | |
| `minuteOf` / `hourOf` (and siblings) | ✓ | |
| `contains` | ✓ | returns bool; rarely meaningful as a comparison RHS |
| `buckets` | ✓ | compiles; rarely meaningful as a comparison RHS |
| `dimensions()` | ✓ | compiles; normally a FACET helper |
| `capture` | ✓ (parses) | RHS position is accepted; the pattern must still satisfy capture's own named-group rule (`(?P<name>…)`) or you get `RegexCapture … must contain at least 1 named capture group` — that's a pattern error, not an RHS rejection |
| `jparse` | ✗ | `Not supported: Call jparse` |
| `convert` | ✗ | `Not supported: Call convert` |
| `cidrAddress` | ✗ | `Not supported: Call cidrAddress` |
| `toTimestamp` / `toDatetime` | ✗ | `Not supported: Call …` |
| `decode` / `encode` | ✗ | `Not supported: Call …` |
| `mapKeys` / `mapValues` | ✗ | `Not supported: Call …` |
| `lookup` | ✗ | `Not supported: Call lookup` |
| `stddev` | ✗ | `Not supported: Call stddev` — it's an aggregator, not a true non-aggregator |
| `blob` | ✗ | `Blob attribute access not allowed in this context` |

**Aggregator functions are NEVER allowed bare on a comparison RHS.** `average`, `sum`, `min`/`max`, `median`, `percentile`, `uniqueCount`, `uniques`, `latest`/`earliest`, `rate`, `stddev`, `percentage`, `filter`, `histogram`, `apdex`, `cardinality`, etc. all fail with `Not supported: Call <fn>` — a bare WHERE cannot aggregate. The **supported pattern is a subquery**: `WHERE duration > (SELECT average(duration) FROM Transaction)` ✓ (verified, returned rows). So an aggregator RHS must be emitted as `op (SELECT agg(...) FROM ...)`, never `op agg(...)`.

**Rule of thumb (one test, no list lookup):** the ✗ non-aggregator functions are not RHS-rejected for being on the RHS — they are **not implemented in the row-wise evaluator at all.** `SELECT jparse(x)`, `SELECT convert(x,..)`, `SELECT cidrAddress(x)` each return `Unknown function <fn>()`, while `SELECT round(x, 2)` returns a value. The same gap shows up in WHERE as `Not supported: Call <fn>`. So:

> **If `SELECT fn(x)` returns a value per row, `fn` is safe on a comparison RHS. If `SELECT fn(x)` returns `Unknown function`, it won't work in WHERE either** — emit `unsupported`.

For an aggregator, neither holds — wrap it: `op (SELECT fn(...) FROM <source>)`. (The table above is the cached answer for the common functions so you don't have to run the probe every time.)

## Placeholders: `$macro$` vs `{{var}}` — two different systems resolve them

NRQL text can carry two unrelated placeholder syntaxes, each resolved by a
*different* upstream system **before** the query reaches NRDB (the engine that
parses/runs NRQL). NRDB itself rejects both — neither is NRDB-grammar syntax — so
where they're "allowed" is a question of which upstream resolver handles them.

- **`$macro$`** (dollar-delimited) — resolved by **NQG** (the NRQL Query Gateway).
  Its compiler does text substitution of saved NRQL macros before forwarding to
  NRDB. So `$mymacro$` is valid *if* it reaches NQG; tested directly against NRDB
  it fails (`unexpected '='`/parser error) because NRDB never sees the expansion.
  Verified: NQG source (`dirac/nrql-query-gateway`) has a `macros/` expander; it
  has **no** `{{}}` handling. So emit `$macro$` only when the consumer routes
  through NQG.
- **`{{var}}`** (double-brace, "moustache") — resolved by the **dashboard
  platform**, NOT NQG. A dashboard substitutes a variable's scalar value into the
  query, wrapping strings in quotes (`x = {{v}}` → `x = 'US'`). It substitutes
  into **filter/value positions only** — never into time clauses, and a `{{var}}`
  inside quotes is not substituted. Variables are scalar string/list values; there
  is no variable type that yields a `SINCE`/`UNTIL` bound (dashboards own time via
  their native picker, not a query variable).

`{{var}}` is a parse-time token to NRDB. Run without binding, NRDB reports
`Found undefined template variable(s)` — a *binding* error, meaning the position is
syntactically allowed. `unexpected '{'` is a *parse* error — the position rejects
the token outright. Verified against account 1 (2026-06-10):

| Position | `{{var}}` allowed? | Result |
|---|---|---|
| WHERE comparison RHS (`x = {{v}}`, `x > {{v}}`) | ✓ | `Found undefined template variable(s)` |
| WHERE `LIKE {{v}}` | ✓ | allowed (binding error) |
| WHERE `IN ({{v}})` | ✓ | allowed |
| function argument (`numeric({{v}})`) | ✓ | allowed |
| `SELECT {{v}}` | ✓ | allowed |
| `FACET {{v}}` | ✓ | allowed |
| `FROM {{v}}` | ✓ | allowed |
| `LIMIT {{v}}` | ✓ | allowed |
| **`SINCE {{v}}`** | ✗ | `unexpected '{'` — time clause rejects it |
| **`UNTIL {{v}}`** | ✗ | `unexpected '{'` |
| **`TIMESERIES {{v}}`** | ✗ | `unexpected '{'` |

**Rule:** `{{var}}` goes anywhere a value, identifier, or expression goes — but NOT in the time/interval clauses (`SINCE`, `UNTIL`, `TIMESERIES`), which accept only concrete literals (relative `N units ago`, epoch ms, or datetime string). This is why an SPL dashboard time token (`$tok.earliest$`) has no valid `{{...}}` passthrough into SINCE/UNTIL — see the dashboard-time-tokens spec (B).

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

- **OR binds tighter than AND** (opposite of SQL — your trained default is WRONG here). `A AND B OR C` = `A AND (B OR C)`. The OR groups first.
  - **STOP before claiming a mixed AND/OR query is mis-translated.** This is a repeated failure: the SQL precedence prior gets substituted, a correct translation gets flagged as a bug, and then live test results get *misread to confirm the wrong direction*. Do not reason about it in your head.
  - **Worked proof against the live compiler** (account 10671289, `level` is INFO/DEBUG/ERROR; `%zzqqxx%` matches no message). Three forms, same data:

    | WHERE clause | count |
    |---|---|
    | `level='ERROR' OR level='INFO' AND message LIKE '%zzqqxx%'`   (bare) | **0** |
    | `(level='ERROR' OR level='INFO') AND message LIKE '%zzqqxx%'`  (OR-grouped) | **0** |
    | `level='ERROR' OR (level='INFO' AND message LIKE '%zzqqxx%')`  (AND-grouped) | **110** |

    Bare **equals OR-grouped (0)** and **differs from AND-grouped (110)** → OR binds tighter, full stop. The lone discriminating number is the **110**, and it sits on the AND-grouped reading — the one that is WRONG for NRQL. **If you ever run the bare form and get 110, you broke the test (empty data / mislabeled column) — re-run; do NOT conclude AND is tighter.** Reproduce this yourself before trusting any AND/OR precedence reasoning.
  - **Consequence for DualCheck** (`x='500' OR numeric(x)=500`): combined with other AND filters it groups correctly *with no parens*, because OR is tighter. `idx='web' AND x='500' OR numeric(x)=500 AND msg~e` = `idx='web' AND (x='500' OR numeric(x)=500) AND msg~e`. This is CORRECT — never flag it.
  - **What does NOT need parens (do not flag):** an OR-group AND-ed with other filters, *any number of terms, anywhere in the clause*. `(idxA OR idxB OR idxC) AND msg AND (host1 OR host2)` translates bare to `idxA OR idxB OR idxC AND msg AND host1 OR host2` and OR-tighter regroups it back to exactly the intent — because all the OR-groups are joined by AND. Proven on the live compiler: bare and parenthesized return identical counts. This is the overwhelmingly common SPL shape and it is ALWAYS fine bare. (I repeatedly hand-derived a bogus "regroup" for this and was wrong every time — the compiler does not do it.)
  - **The ONE shape that genuinely needs parens** (and the only real defect to hunt): an **AND-run used as a branch of an OR** — i.e. a source `OR` sitting *between two adjacency-AND runs*. SPL `(a AND b) OR (c AND d)` (or SPL adjacency `a b OR c d`). Without parens, `a AND b OR c AND d` parses under OR-tighter as `a AND (b OR c) AND d` — wrong. Compiler-proven discriminator (account 10671289): `(level='ERROR' AND hostname='H1') OR (level='DEBUG' AND hostname='H2')` = **13**, but unparenthesized `level='ERROR' AND hostname='H1' OR level='DEBUG' AND hostname='H2'` = **0**. The translator currently DOES emit these parens correctly (verified via `bin/spl2nrql.js`), so this is the thing to *spot-check*, not assume broken. Rare from SPL because it needs an explicit OR between two AND-runs.
- **NRQL is typed, SPL is not — but type mismatch is silent, not a compile error.** NRQL NEVER rejects a comparison or `LIKE`/`RLIKE` at compile time based on operand type; any operand types compile. The effect is behavioral (verified account 1, 2026-06-10):
  - **Comparison ops** (`=` `!=` `<` `>` `<=` `>=`) compare by the operands' ACTUAL types. Two strings → lexicographic, NOT numeric: `'10' < '9'` is **true** (string order). A numeric field vs a string literal (`duration = '0.5'`) → type mismatch → **0 matches** (no error). This silent zero is exactly why `status=500` needs the DualCheck `status = '500' OR numeric(status) = 500` — neither half alone is guaranteed to match.
  - **`LIKE`/`RLIKE` are string-pattern operators.** On a non-string operand they silently match nothing: `duration LIKE '%'` (match-everything pattern, numeric field) → **0 rows**, no error. So a `LIKE` against a numeric field is meaningless unless wrapped: `string(field) LIKE ...`.
  - So "comparison needs numbers, LIKE needs strings" is FALSE as a *validity* rule (everything compiles) but roughly TRUE as a *behavior* rule (mismatched types just don't match).
- **Regex (`RLIKE` and `capture()`) — escaping, anchoring, capture maps** (verified live, account 1, 2026-06-16):
  - **Backslash escaping**: in a regex literal `r'…'` backslashes stay single (`\d`, `\.`); in a plain `'…'` string every backslash must be doubled (`\\d`). An un-doubled `\d` in a plain string is the classic `Invalid NRQL … unterminated '` ("Invalid Syntax") error. `RLIKE` accepts EITHER form; `capture()` requires `r'…'`.
  - **Both are full-string anchored** — the pattern must match the ENTIRE field value, not a substring. `RLIKE '2026'` → **0 rows**, `RLIKE '.*2026.*'` → matches; bare `capture(msg, r'(?P<ts>\d{4})')` → **null**, wrapped `r'.*(?P<ts>\d{4}).*'` → extracts. Always wrap a substring pattern in `.*` on both ends.
  - **`capture()` named groups**: Python `(?P<name>…)`, not PCRE `(?<name>)` — SPL `rex` groups must be converted. Requires ≥1 named group or `RegexCapture … must contain at least 1 named capture group`.
  - **Multiple named groups → a map**, indexed with **brackets** `capture(...)['month']` (dot `capture(...).month` errors `unexpected '.'`). Works inline in SELECT *and* WHERE: `WHERE numeric(capture(msg, r'.*(?P<m>\d{2}).*')['m']) > 6`. `numeric()` on the whole multi-group map is meaningless — index to a single group first. A single-named-group capture returns a scalar (no index needed).
- **No UNION keyword.** SPL `append` cannot become `UNION`. Use multiple FROM types or subqueries.
- **No cross join** (`ON 1 = 1` invalid). For global aggregation enrichment (SPL `eventstats` without BY), use nested aggregation.
- **`filter(func, WHERE cond)`** — the WHERE keyword inside filter is required, not just a boolean expression.
- **`LIMIT MAX` required on subquery FACETs** or you silently get only 10 results. Default FACET limit is 10.
- **`WITH` aliases CAN be used in WHERE and FACET** — provided the aliased expression is **row-wise** (`numeric()`, `capture()`, `aparse()`, arithmetic on attributes). NR's own docs example: `FROM Log WITH aparse(...) AS (itemId, unitPrice), numeric(unitPrice) AS unitPriceNum SELECT sum(unitPriceNum) FACET itemId WHERE unitPriceNum < 100` — the WITH variables appear in SELECT, FACET, *and* WHERE. Aggregate-valued aliases (`average()`, `count()`, …) cannot be facet keys or WHERE conditions, but that's a general FACET/WHERE restriction, not a WITH limitation. (Two independent Opus NRQL experts confirmed via NR docs `nrql-syntax-clauses-functions`; **live-compiler check still pending** — the NR MCP was not connected when this was written. Verify with: `FROM Log SELECT count(*) WITH numeric(timestamp) AS d FACET d SINCE 1 day ago LIMIT 1`.)
- **FACET takes inline expressions and an `AS` relabel.** `FACET <expr> AS <label>` (e.g. `FACET response.headers.contentType AS 'content type'`) groups on the real attribute/expr and only relabels the output column — it does NOT create a new groupable name. `FACET concat(a,b)`, `FACET mod(hostId,10)`, `FACET if(...)`, `FACET numeric(x)` all work. A bare `` FACET `aliasName` `` where no such attribute exists groups on null — to honor an SPL `rename … | … by alias`, emit `FACET <source> AS <alias>`, never a bare alias. You still cannot reference a **SELECT-output aggregate alias** in FACET (facet keys must be row-wise).
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
