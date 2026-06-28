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

> ⚠️ **TOOL CAVEAT — do NOT trust `execute_nrql_query` for function support.** The `nr-mcp-server` `execute_nrql_query` (and `natural_language_to_nrql_query`) tool routes NRQL through an older parser that returns `Unknown function <fn>()` / `Not supported: Call <fn>` for a set of valid row-wise functions the real engine (UI / NerdGraph) runs fine. It is an OLDER NRQL grammar, so it misses recent **functions AND clauses**. Confirmed exec gaps (all main-thread-verified, account 1, 2026-06-24) — **functions (12):** `jparse`, `convert`, `cidrAddress`, `toTimestamp`, `toDatetime`, `encode`, `decode`, `mapKeys`, `mapValues`, `split`, `replace`, `aggregateFunnel`; **clause:** `PREDICT` (→ `unexpected 'PREDICT'`). Re-validate any of these via `run_nerdgraph_query` (`query($id:Int!,$q:Nrql!){actor{account(id:$id){nrql(query:$q){results}}}}`) before marking it unsupported.
>
> **NOT affected (recognized by `execute_nrql_query`):** `blob`, `lookup`, `stddev`, `subnet`, `meta`, `hdrHistogram`, `hdrPercentile`, `hdrPercentiles`, `attributeCardinality`, the `SLIDE BY` clause, and all core/common functions.
>
> **In dirac source but NOT deployed anywhere (both tools return `Unknown function`):** `trim`, `substringCount`, `valueType`, `eventSize`, `funnelWithValues`, `eventRecords`, `jsonSizeEstimate`, `deterministicSample`, `newCatMap`, `columns` (special token). The translator must not emit these.
>
> **Method note:** a parallel-agent swarm produced a first-pass sweep of all ~131 functions, but ~⅓ of its `unknown` verdicts were false (aggregate timeouts on high-volume Log, and non-`Unknown function` errors like `Unknown meta() attribute`, misclassified as "unknown"). Every entry above is re-verified on the main thread. Rule: an exec **timeout** on an aggregate means **recognized** (it parsed and started crunching), not unknown.
>
> **Function-classification ground truth:** the NRQL compiler is `dirac-nrql` — registry in `DefaultNRQLProvider.java`: `getDistributedFunctionFactories()` = aggregate, `getEvaluableFactories()` = evaluable/row-wise. That source is a SUPERSET of what's deployed (e.g. `trim` is in source but not live), so it answers "agg vs evaluable" and "does the function exist in source," but deployment/runnability must be confirmed live via `run_nerdgraph_query`.
>
> ⚠️ **Lookalike that is NOT a tool bug:** wrapping an aggregate in a row-wise function that can't take one (e.g. `numeric(count(host))`) errors as `Unknown function count()` (NerdGraph) / `Not supported: Call{count}` (execute_nrql_query) — but this is NRDB correctly rejecting an INVALID query (deterministic, identical on both tools, verified acct 1 2026-06-24). `string(count(x))` works on both tools; `numeric(count(x))` fails on both. `string()` can wrap an aggregate; `numeric()` cannot. Don't misread these as corruption.
>
> **Can a function wrap an aggregate in a flat SELECT?** (the `f(count(*))` "fold" question; verified vs BOTH factory lists 2026-06-25. A function can iff it has a *distributed* form — many are registered in both lists.) **YES (distributed):** arithmetic operators, `mod`, `round`, `abs`, `ceil`, `floor`, `sqrt`, `exp`, `ln`, `log10`/`log2`/`log`, `pow`, `if`/`case`, `string`, `convert`, `getField`/`extractfield` (incl. its `col['…']` bracket alias). **NO (Evaluable-only):** `numeric`, `concat`, `jparse` (`jsonparse`), `split`, `encode`/`decode`, `cidrAddress`, `mapKeys`/`mapValues`, `lower`/`upper`/`substring`/`replace`. Lookalikes to keep straight: `string` wraps an aggregate but `numeric` does not; `getField`/`extractfield` does but `jparse` does **not** (don't conflate — `getField`=`extractfield` is dual-registered, `jparse`=`jsonparse` is Evaluable-only).
>
> **Extracting a non-scalar aggregate across a subquery boundary:** `median`/`percentile`/`uniques` expose as keyed objects (`median(x)` → `{50: v}`), not scalars. Pull the scalar with `getField(col,'<N>')` (median → `'50'`, `percN` → `'N'`). To use it in BOTH SELECT and WHERE, bind once with `WITH`: `WITH getField(md,'50') AS md50 SELECT md50 FROM (…) WHERE md50 > 10` ✓ — a `WITH` binding is visible to SELECT+WHERE, but a SELECT alias is **not** visible in WHERE (returns empty silently). Verified acct 1 / 10671289, 2026-06-25.

## Non-Aggregation Functions (usable in SELECT/WHERE/WITH)

| Function | Description |
|---|---|
| `numeric(field)` | Cast a numeric-format string to a number. Returns **null** when the string is not fully numeric (`'abc'`, `'12abc'`, `''` → null). On an already-numeric field it returns the value and arithmetic works (`numeric(timestamp)+1` is fine), so it's a safe no-op wrapper — it does NOT error on numeric fields. Exception: gauge-format metrics, where `numeric()` won't work — use `latest()`/`min()`/`max()`. Validation note: a `numeric()`-wrapped query is satisfiable, not impossible — it just nulls against non-numeric-string data. |
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
| `jparse` | ✓ | row-wise; SELECT + comparison-RHS verified via `run_nerdgraph_query` 2026-06-24. Prior `✗ Not supported: Call jparse` = `execute_nrql_query` bug (A) |
| `convert` | ✓ | registered; real sig `convert(<function>, <fromUnit>, <toUnit>)`. Prior `✗` = bug (A) |
| `cidrAddress` | ✓ | SELECT verified (null on non-CIDR input). Prior `✗` = bug (A) |
| `toTimestamp` / `toDatetime` | ✓ | SELECT verified; `toTimestamp` also comparison-RHS verified. Prior `✗` = bug (A) |
| `decode` / `encode` | ✓ | `encode('hello','base64')`→`aGVsbG8=`; `decode(...)`→`hello`. Prior `✗` = bug (A) |
| `mapKeys` / `mapValues` | ✓ | `mapKeys/mapValues(jparse('{...}'))`→keys/values arrays. Prior `✗` = bug (A) |
| `lookup` | ✓ | `FROM lookup(t)` runs via BOTH tools — the original `✗` (lookup on a comparison RHS) was a category error, not a support gap |
| `stddev` | ✗ (bare on RHS) | genuinely an aggregator — `SELECT stddev(x)` runs via both tools; only a *bare* aggregator on a comparison RHS is rejected (real restriction, not a tool bug) |
| `blob` | context | `SELECT blob(field)` runs via `execute_nrql_query` (returns null); `Blob attribute access not allowed in this context` is a real positional restriction, not a tool bug |

**Aggregator functions are NEVER allowed bare on a comparison RHS.** `average`, `sum`, `min`/`max`, `median`, `percentile`, `uniqueCount`, `uniques`, `latest`/`earliest`, `rate`, `stddev`, `percentage`, `filter`, `histogram`, `apdex`, `cardinality`, etc. all fail with `Not supported: Call <fn>` — a bare WHERE cannot aggregate. The **supported pattern is a subquery**: `WHERE duration > (SELECT average(duration) FROM Transaction)` ✓ (verified, returned rows). So an aggregator RHS must be emitted as `op (SELECT agg(...) FROM ...)`, never `op agg(...)`.

**The old "rule of thumb" here was WRONG — it rested on `execute_nrql_query` false negatives (bug A above).** `SELECT jparse(x)` returning `Unknown function` via `execute_nrql_query` does NOT mean jparse is unsupported — it runs fine via `run_nerdgraph_query` and the UI. **Never decide a function is unsupported from an `execute_nrql_query` error; re-run the identical query via `run_nerdgraph_query` and trust THAT.** For an aggregator on a comparison RHS, the real restriction still holds — wrap it as a subquery: `op (SELECT fn(...) FROM <source>)`.

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

**Rule:** `{{var}}` goes anywhere a value, identifier, or expression goes — but NOT in the time/interval clauses (`SINCE`, `UNTIL`, `TIMESERIES`), which accept only concrete literals (relative `N units ago`, epoch ms, or datetime string). This is why an SPL dashboard time token (`$tok.earliest$`) has no valid `{{...}}` passthrough into SINCE/UNTIL — see **Dashboard Time Tokens** in `.claude/rules/design-decisions.md`.

### How the dashboard substitutes a `{{var}}`

Mechanics verified via `dashboardCreate` + NRQL execution on staging account 1 (2026-06-22):

- **Value position only.** A `{{var}}` is replaced only where it stands as a whole value/identifier/expression — it is **not** interpolated inside a string literal. `WHERE f LIKE '%{{v}}%'` does not substitute (the literal `{{v}}` survives), and you cannot prepend/append query-side literal text to a substitution.
- **`replacementStrategy` controls wrapping:** `STRING` → single-quoted (`f = {{v}}` → `f = 'web'`), `NUMBER` → raw (`f = {{v}}` → `f = 5`), `IDENTIFIER` → backticked (for event/facet/attribute names). Default is `STRING`.
- **`LIKE`/`RLIKE` with a variable:** put the `%` wildcards in the variable's **value** and write `WHERE f LIKE {{v}}` (bare, unquoted). `dashboardCreate` accepted all three value shapes — `%v%` (substring), `v%` (prefix), `%v` (suffix) — and `f NOT LIKE {{v}}`.
- **Multi-select:** an `ENUM` variable with `isMultiSelection: true` expands to a comma list, so `WHERE f IN ({{v}})` is the idiomatic form (the singular `account_id` for widgets; the plural `account_ids` list for `nrql`-type variables).
- **`dashboardCreate` acceptance (acct 1):** value-position `f = {{tok}}`, `f IN ({{tok}})`, and `f LIKE {{tok}}` (with `%`-bearing values) all created with zero errors; the corresponding substituted concrete forms (`f = 'x'`, `f LIKE '%x%'`, `f IN ('a','b')`) all execute.

**Translation consequence (SPL `$tok$`):** a wildcard-only Splunk token (`"*$tok$*"`, `"$tok$*"`, `"*$tok$"`) → `f LIKE {{tok}}` (the `%` must live in the variable's values); a literal-affixed token (`"*fps-$tok$*"`, `"$tok$-suffix"`) has no faithful translation and is emitted as `unsupported`. See the **Dashboard tokens** bullet in `.claude/rules/design-decisions.md`.

### Markdown (text) widgets — a second `{{var}}` context, and what they support

A dashboard **markdown widget** (NerdGraph `viz.markdown`, single `text` field = "Markdown content of the widget"; Terraform `widget_markdown { text = … }`) is a second `{{var}}` substitution context **beyond NRQL**: New Relic substitutes a template variable directly inside the markdown body, so `Current: {{products}}` renders with the selected value ([NR docs](https://docs.newrelic.com/docs/query-your-data/explore-query-data/dashboards/dashboard-template-variables/): "when you save and view the dashboard, the variables are replaced with their actual values"; the editor preview shows the literal `{{var}}`). So `{{var}}` is live in markdown text, not just in NRQL queries.

Content is **GitHub-flavored Markdown** ([NR docs](https://docs.newrelic.com/docs/query-your-data/explore-query-data/dashboards/manage-your-dashboard/#markdown), which points to GitHub's guide): formatted text, checklists, images, code snippets, hyperlinks, tables, and **Mermaid diagrams**. A documented use is "direct links to specific UI pages or dashboards," so internal/relative links are intended.

**Links — two distinct things, don't conflate:**
- **Inline body links** use GFM `[text](url)`. All schemes can be emitted as-is — `http(s)`, `mailto:`, relative/internal NR links, even `javascript:` — because NR's markdown renderer is the display-time sanitizer (standard practice; NR renders GitHub-flavored Markdown, which neutralizes `javascript:`/`data:`). Not separately render-verified here. So a tool emitting NR markdown needn't filter schemes itself.
- The widget's separate **`link` field** makes the widget *title* clickable — NOT an inline body link. It must be `http://`/`https://` and ≤2,048 chars ([NerdGraph docs](https://docs.newrelic.com/docs/apis/nerdgraph/examples/create-widgets-dashboards-api/)). (The web claim that "markdown links must be http(s)/≤2048" comes from confusing this title `link` field with body links — verified false against the source.)

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

**Limits**: `MAXIMUM_SUB_QUERIES = 3` (`QueryConstants`, enforced in `QueryPlanInterpreter`) caps **expression subqueries** — `WHERE … IN (…)`, scalar-in-SELECT, function-arg subqueries — counted *after* duplicate-subquery dedup. It does **NOT** limit FROM-clause nesting depth: an all-aggregating `FROM (FROM (…))` nest runs 5+ levels (verified via `run_nerdgraph_query`, 2026-06-25 — the old "up to 3 nested levels" wording was wrong; FROM-nesting is a `CompilerSelectQueryPlan` source, not a counted `CompilerSubQueryPlan`). Subquery results capped at 5000 rows. JOIN has 1:100 cardinality limit.

### Column names a subquery exposes to its outer (verified vs staging + the NRDB engine source `dirac-nrql`)
- An inner aggregate is exposed under its **bare function name** (`count`, `average`, `sum`, `min`, `max`, `latest`, `earliest`, `uniqueCount`) — NOT the dotted top-level form (`average.duration`). `stddev` exposes as **`standarddeviation`** (class-name-derived). An explicit `AS alias` re-keys it cleanly.
- Two inner columns resolving to the same exposed name **silently collide — last wins, no error** (`count(*), sum(x) AS count` → one `count` holding the sum). So to reference an inner aggregate reliably, alias every one uniquely.
- `median` / `percentile(…,N)` expose **keyed objects** (`{50:v}` / `{N:v}`) and `uniques` / `values` a **list** — non-scalar. `numeric(...)` over them yields null, so a row-wise outer eval over such a column can't be faithful (emit `unsupported`).
- A **row-wise (non-aggregating) outer over a subquery is legal**: `FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT host, numeric(count)*100 AS pct` ✓. But **re-wrapping a row-wise outer as a nested-aggregation inner fails**: `Inner queries in nested aggregations must use aggregation functions`. So a second post-aggregation transform (`stats|eval|eval`, `stats|eval|where`, `stats|where|where`) emits non-compiling NRQL unless guarded.
- **Visibility crosses the boundary ONE-WAY — outward, via output columns only.** A FROM-subquery is an **isolated scope** (like a CTE), not a closure: an **outer `WITH` binding is NOT visible inside the inner subquery.** `WITH 5 AS lim SELECT latest(innerlim) AS out FROM (FROM Log SELECT latest(numeric(duration)) AS innerlim WHERE numeric(duration) > lim)` → `out: null` (inside the inner, `lim` is unbound → nonexistent attr → null → no rows), whereas the identical inner with a literal `> 5` → `out: 6.32`. Only the inner's **output columns** reach the outer. Verified acct 1, 2026-06-25 (literal-controlled).
- **An outer `WITH` shadows a same-named inner output column.** When an outer `WITH <name>` collides with a column the subquery exposes under the same name, the outer binding wins: `WITH 999 AS n SELECT latest(n) AS out FROM (FROM Log SELECT count(*) AS n WHERE 1=0)` → `out: 999`, not the inner `count`. Bearing on cross-aggregation rename: a rename target equal to an inner output-column name silently shadows that column on the outer. Verified acct 1, 2026-06-25.

### Referencing a computed value in the outer: WITH chains, sibling SELECT aliases do NOT (verified vs staging acct 1)
- A `SELECT` item **cannot reference a sibling alias** defined in the same `SELECT`. When the alias is a **function arg** (e.g. `numeric(rpm)`) the reference resolves to an unknown attribute → `null`, **silently, no error**: `SELECT numeric(count)/60 AS rpm, numeric(rpm)/60 AS rps` returns `rps: null` on every row. (A **bare** alias operand like `rpm + 1` instead **errors loudly** — `Value must be constant`; see "Renaming & relabeling" for the surface-by-surface rule.) Either way, stacking derived columns in one `SELECT` is wrong — use `WITH`.
- `WITH` bindings **chain**: a later binding may reference an earlier one, and bindings are visible to `SELECT`, `WHERE`, and outer aggregates. `WITH numeric(count)/60 AS rpm, numeric(rpm)/60 AS rps SELECT host, rpm, rps` ✓; `WITH … AS rpm SELECT average(rpm)` ✓; `WITH … AS rpm SELECT host, rpm WHERE rpm > 100` ✓. So a chain of row-wise derivations over a subquery needs `WITH`, not stacked `SELECT` aliases.
- Aggregation-wrapping each row-wise stage (`max(col)/60`, `latest(col)/60` — one row per group, so the agg is a passthrough) also makes a deeper nest legal, but adds a subquery level (FROM-nesting isn't depth-capped — see Limits above — but each level is slower, and `latest` needs a timestamp the subquery row may lack) — `WITH` is the cleaner tool.

## Renaming & relabeling (aliases) — every mechanism NRQL gives you

There is no single "rename" in NRQL. Each clause can introduce or reuse a name, and
they differ in **whether the new name is a real, referenceable attribute or just an
output-column label.** This is the table to consult when translating any SPL rename
(`rename`, `eval … AS`, `stats … as`, `… by <alias>`). Status: verified live unless noted.

| Clause | Form | What the name is | Referenceable downstream? |
|---|---|---|---|
| **SELECT** | `expr AS 'label'` | **display-only** output-column label | ✗ not referenceable elsewhere, and **mostly silent** when referenced anyway: WHERE, FACET, and an alias used as a **function arg** read it as a nonexistent attribute → null/empty, **no error**; only a **bare alias operand in a scalar SELECT expression** (e.g. `a + 1`) **errors loudly** (`Value must be constant`). `ORDER BY <alias>` works. (Verified acct 1, 2026-06-25, fake-name controlled — see note below) |
| **WITH** | `expr AS name` | a **real, referenceable** binding | ✓ visible to SELECT, WHERE, FACET, ORDER BY, and outer aggregates; bindings **chain** (a later one may reference an earlier) |
| **FACET** | `<source> AS 'label'` | groups on the **real** `<source>` attr, relabels the output column only | the group key (this is the faithful relabel) |
| **ORDER BY** | `<select-alias>` **or** `<expr>` | sorts by a SELECT alias or a bare expression | n/a (terminal) |
| **subquery** | inner `agg AS alias` | re-keys the column the **outer** query sees | ✓ outer references it by `alias` (else the bare fn name — see "Column names a subquery exposes") |

**Load-bearing rules:**
- A SELECT `AS` label is **display-only** — NOT an attribute. To create a name other
  clauses (or another derived column) can reference within one query level, use **`WITH`**, not SELECT-AS.
- **`FACET <source> AS 'label'`** is the only faithful way to relabel a grouping column.
  Verified acct 1: `FROM Log SELECT count(*) FACET level AS 'Severity'` returns both a
  `facet` key and a relabeled `Severity` column. A bare `FACET <alias>` where `<alias>`
  is not a real attribute **silently** groups on the nonexistent attribute (with `count`
  it returns an empty result set, no error) — never use a SELECT alias as a FACET key.
- **`ORDER BY` accepts a SELECT alias.** Verified acct 10671289:
  `SELECT count(*) AS cnt FACET level ORDER BY cnt DESC` sorts by the alias correctly.
- **SELECT-alias scope is surface-dependent and mostly SILENT (do not assume NRQL errors
  loudly).** Verified acct 1, 2026-06-25, with a guaranteed-fake alias `xqv`:
  `… AS xqv WHERE xqv > 5` → `{xqv:0}`, `… AS xqv FACET xqv` → `[]`, `latest(x) AS d, latest(d) AS e`
  → `e:null` — all **silent, no error**. Only a bare alias operand in a scalar SELECT
  (`… AS xqv, xqv + 1 AS xqv2`) → loud `Value must be constant`. **Confound:** acct 1 Log has
  real short-named fields (`c` → NETWORK/ACCESS/WTCHKPT), so aliasing to `c` silently tests
  the real field — always verify alias scope with a nonsense name. Mechanism (dirac
  `CompilerExpressionPlan`): WHERE/FACET/func-arg compile the bare name as an event-field ref
  (unknown → null, silent); only a scalar value position (`compileAsTaggedValue`) raises
  `unsupportedNonConstant`. **Implication for translation:** a bare-emitted rename in WHERE or
  FACET is silent wrong data — NRQL will not catch it; resolve-at-consumer is the only defense.
- **A WITH binding works as a FACET key** (compiles; `FACET <withName>`), per the WITH-visibility rule above.
- **Renaming across an aggregation boundary** (relabeling a `stats` result) puts the new
  name in the **outer** scope — wrap the aggregation as a subquery and project/rename in
  the outer. You cannot define a stats alias and reference it at the same query level.
- **No in-place name reuse:** a `WITH` binding must not reuse an existing source field's
  name (the `eval X = f(X)` reassignment trap — see CONFIRMED-15). Alias to a fresh name.
  (The emitter has no collision guard today.)
- **A duplicate output alias in ONE flat SELECT silently keeps the FIRST column.**
  `SELECT count(*) AS c, count(*)*2 AS c` returns `c` = the plain count (the first), dropping
  the second, no error (verified acct 10671289, 2026-06-26). This is the **opposite** of a
  subquery-exposed name collision (**last** wins — see "Column names a subquery exposes"): the
  two surfaces resolve a collision in opposite directions, so never assume either. Alias every
  output column uniquely.

**SPL-translation mapping (consequence):**
- `rename A as B` (display-only) → `A AS 'B'` in SELECT, `FACET A AS 'B'` in facet, bare `A` in ORDER BY/WHERE — **never a bare `B`** (B is not an attribute).
- `eval B = expr` → `WITH expr AS B` (referenceable downstream).
- `stats f(x) as Y` → SELECT `f(x) AS Y`; any **downstream** use of `Y` (another transform/sort/filter) requires a **subquery wrap** so `Y` exists in the outer.

## FACET

Groups results by field values. Multiple fields: `FACET field1, field2`.

- `FACET CASES(WHERE cond1, WHERE cond2, ...)` — custom buckets
- `LIMIT <n>` after FACET controls number of groups (default 10, max 5000, or MAX)
- **`LIMIT N` after FACET selects the top N groups by aggregate value; `ORDER BY` does NOT change which groups are kept** — it only reorders the returned rows. Verified acct 10671289, 2026-06-26: `SELECT count(*) AS c FACET appName ORDER BY c ASC LIMIT 3` returns the same three highest-count appNames as a bare `LIMIT 3` (not the three lowest), with 36 distinct appNames present. There is no "bottom-N" or "first-N-in-stats-order" selection via FACET — only top-N-by-aggregate. (This is why a `head N` between two aggregations has no faithful NRQL form — see `design-decisions.md`.)

## WITH clause

Aliases computed expressions:
```sql
FROM Log SELECT * WITH numeric(duration) / 1000 AS durationSec
```

**`WITH` is row-wise (pre-aggregation) — it CANNOT compute an aggregate.** `WITH count(*) AS t`,
`WITH average(x) AS t`, `WITH latest(x) AS t` all fail with `Unknown function …()` (a real
rejection, not the arg-strip tool bug — `WITH duration*2 AS x` works, so the position is fine).
Consequences (verified acct 10671289, 2026-06-25): a grand-total / global aggregate attached to
rows needs a **scalar subquery** (`SELECT *, (SELECT average(x) FROM …) AS a`), not `WITH`; and
`top`-style percent-of-grand-total can't use `WITH count(*)` either. What `WITH` CAN do is row-wise
ops on an aggregate **column a subquery already exposes** (a row value), e.g.
`WITH getField(md,'50') AS md50 SELECT md50 FROM (… median(d) AS md …) WHERE md50 > 10` ✓ — and a
`WITH` binding is visible to both SELECT and WHERE, where a SELECT alias is not.

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
