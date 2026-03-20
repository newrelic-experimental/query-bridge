# nr-query-bridge — Universal Query Translation via IR

**Date:** 2026-03-15
**Status:** Draft
**Branch:** `feat/spl-to-nrql-translator`
**Package:** `@datanerd/nr-query-bridge`

> **IMPORTANT for implementers:** Seriously, no bash/python/node. Use Read/Edit tools only. Work in chunks (or you'll time out if you do too many lines at a time).

## Vision

A multi-language query translator. Any observability query language in, any target query language out, with a shared IR in the middle:

```
Input languages:          Shared IR:              Output languages:
  SPL ──→ splToIR ──┐                            ┌──→ irToNrql  ──→ NRQL
  Lucene ─→ luceneToIR ─┼──→ Query IR ──→ optimize ──┼──→ irToTrino ──→ Trino SQL
  PromQL ─→ promqlToIR ─┤                            └──→ (future targets)
  PPL ──→ pplToIR ──┘
```

The IR is a relational algebra superset that both NRQL and Trino SQL can express. Each source language has its own parser and AST-to-IR translator. Each target language has its own emitter. The optimization pass is shared.

**Scope for V1:** SPL input → NRQL output. The IR and emitter are designed for multi-target from day one, but we only implement the SPL→NRQL path initially.

## Problem

The current translator (`spl.js`) uses a single-pass architecture: walk the SPL AST, mutate a flat string accumulator, done. This breaks down for commands that need context about what comes before or after them:

- `mvjoin` needs to know if it feeds into a FACET (skip it) or string concatenation (use concat)
- `eventstats` with multiple BY keys can't be expressed as a single JOIN
- `streamstats` / `transaction` need specific unsupported messages based on downstream usage
- Subquery wrapping (`wrapAsSubquery`) is a string-concatenation hack that's fragile and untestable
- Each new command needs more boolean flags (`_hasStatsAggregation`, `_hasAggregation`) to track pipeline state

## Goal

Replace the flat accumulator with a structured Intermediate Representation (IR) that mirrors NRQL's own query plan. This enables multi-pass processing: translate SPL to IR, optimize the IR, then emit NRQL.

## Design Principles

- **Relational algebra IR, informed by NRQL's query plan.** IR node types are inspired by NRQL's compiler query plan (Thrift types in `dirac-nrql`) but are a relational algebra superset — capable of emitting both NRQL and Trino SQL. This keeps the IR target-neutral while ensuring NRQL emission is trivial.
- **Self-contained package.** `@datanerd/nr-query-bridge` is a standalone npm package inside `packages/`. Zero coupling to React/NR1. Extractable to its own repo at any time.
- **Parallel migration.** V2 runs alongside V1. Tests compare output, categorize divergences. V1 stays as fallback until V2 is reviewed and trusted.
- **Plain objects with type discriminators.** Same pattern as the PEG.js AST. No TypeScript, no classes, no build step.
- **Language-agnostic IR.** Input parsers (SPL, Lucene, PromQL, PPL) each produce their own AST, then translate to the shared IR. Output emitters (NRQL, Trino) each serialize the IR to their target syntax. The optimization pass is shared.

## Architecture

```
SPL string
  │ PEG.js parser (unchanged)
  ▼
SPL AST (unchanged)
  │ Pass 1: splToIR.js — translate(ast) → IR
  │   Each SPL command → IR node(s)
  │   Subquery wrapping is structural
  ▼
NRQL IR (query plan tree)
  │ irOptimize.js — optimize(ir) → IR
  │   Pattern detection, simplification,
  │   mv* handling, dead code elimination
  ▼
Optimized NRQL IR
  │ Pass 2: irToNrql.js — emit(ir) → string
  ▼
NRQL string + warnings + unsupported + errors
```

## IR Node Types

### Query Level

Mirrors `TCompilerSelectQueryPlan` from dirac-nrql Thrift:

```js
SelectQuery {
  type: 'SelectQuery',
  dataSource:  DataSource,       // FROM
  bindings:    Binding[],        // WITH
  select:      Expression[],     // SELECT
  where:       Expression|null,  // WHERE
  facet:       Expression[],     // FACET
  join:        JoinClause|null,  // JOIN
  orderBy:     OrderBy|null,     // ORDER BY
  limit:       number|null,      // LIMIT
  timeseries:  string|null,      // TIMESERIES
  predict:     boolean,          // PREDICT
  since:       string|null,      // SINCE
  until:       string|null,      // UNTIL
  warnings:    string[],
  unsupported: string[],
  errors:      string[],
}
```

Top-level query plan alternatives:

```js
QueryPlan = SelectQuery | Union | NestedAggregation

Union { type: 'Union', queries: SelectQuery[] }
NestedAggregation { type: 'NestedAggregation', layers: SelectQuery[] }
```

### Data Source

```js
EventType   { type: 'EventType', names: string[] }     // FROM Log, FROM Metric
Lookup      { type: 'Lookup', name: string }            // FROM lookup(name)
SubquerySource { type: 'SubquerySource', query: SelectQuery }  // FROM (subquery)
```

### Expression Level

Mirrors `TCompilerExpressionPlan` from dirac-nrql Thrift:

```js
Identifier  { type: 'Identifier', name: string }
Literal     { type: 'Literal', value: any, kind: 'string'|'number'|'null'|'boolean' }
BinOp       { type: 'BinOp', op: string, left: Expression, right: Expression }
Not         { type: 'Not', child: Expression }
Function    { type: 'Function', name: string, args: Expression[] }
Alias       { type: 'Alias', expr: Expression, name: string }
IsNull      { type: 'IsNull', child: Expression }
Like        { type: 'Like', field: Expression, pattern: string }
In          { type: 'In', field: Expression, values: Expression[] }
Wildcard    { type: 'Wildcard' }
SubqueryExpr { type: 'SubqueryExpr', query: SelectQuery }
Regex       { type: 'Regex', pattern: string }
```

### Structural Nodes

```js
Binding     { name: string, expr: Expression }
JoinClause  { type: 'JoinClause', subquery: SelectQuery, onKey: Expression }
OrderBy     { field: Expression, descending: boolean }
```

### Pipeline Markers (resolved by optimization pass)

```js
Expand      { type: 'Expand', field: string }           // mvexpand boundary
UnsupportedIntent {
  type: 'UnsupportedIntent',
  command: string,        // original SPL command name
  intent: string,         // human-readable description
  context: object,        // parsed parameters for potential future handling
}
```

## Pass 1: SPL AST → IR (splToIR.js)

### Pipeline Model

SPL is a pipeline. Each command transforms the IR state:

```js
function translatePipeline(ast) {
  let ir = translateSearchClause(ast.search);
  for (const cmd of ast.commands) {
    ir = applyCommand(cmd, ir);
  }
  return ir;
}
```

### Command → IR Mapping

| SPL command | IR transformation |
|---|---|
| search clause | Build initial `SelectQuery` with `where` from search expressions |
| `stats fn() by field` | Set `ir.select`, `ir.facet`. If already aggregated → wrap as `NestedAggregation` |
| `where expr` | Append to `ir.where`. If after aggregation → wrap as subquery, filter outer |
| `eval x = expr` | Add `Binding` to `ir.bindings` |
| `table f1, f2` | Set `ir.select` to field list |
| `fields +/- f1` | Filter `ir.select` |
| `sort [-]field` | Set `ir.orderBy` |
| `head N` | Set `ir.limit` |
| `timechart span=X fn()` | Set `ir.select`, `ir.facet`, `ir.timeseries` |
| `eventstats fn() by f` | Add `ir.join` with subquery clone |
| `rename a as b` | Add `Alias` or transform existing expressions |
| `rex "pattern"` | Add `Function('capture', ...)` to `ir.bindings` |
| `dedup field` | Add to `ir.facet` with warning |
| `bin _time span=X` | Set `ir.timeseries` |
| `append [subsearch]` | Wrap as `Union` with subsearch as second query |
| `mvexpand field` | Insert `Expand` marker |
| `predict` | Set `ir.predict = true` |
| `streamstats` | Record as `UnsupportedIntent` with specific context |
| `transaction` | Record as `UnsupportedIntent` with specific context |

### Subquery Wrapping

When `stats` encounters an IR that already has aggregation, it creates a `NestedAggregation`:

```js
// Before: ir = SelectQuery { select: [count(*)], facet: [host] }
// Command: stats sum(count) by status
// After:
NestedAggregation {
  layers: [
    SelectQuery { select: [sum(count)], facet: [status] }  // outer
  ],
  dataQuery: SelectQuery { select: [count(*)], facet: [host] }  // inner
}
```

This is structural — no string concatenation, no `(FROM ... SELECT ...)` hack.

## Optimization Pass (irOptimize.js)

A series of `transform(ir) → ir` functions applied in sequence:

### Pattern Simplification
- `mvjoin(field, delim)` in binding context → just `field` reference
- `Expand` marker followed by aggregation → check if FACET handles it; remove Expand if so
- `mvsort(mvappend(a, b))` as grouping key → multi-field FACET

### Dead Code Elimination
- Bindings never referenced in select/where/facet → remove
- Redundant aliases (rename to same name) → remove

### Unsupported Intent Enrichment
- `streamstats count` → specific message about row numbering
- `transaction session_id maxpause=5m` → specific message about session grouping
- `delta field` → specific message about inter-row references

Each transform is independent and testable. New optimizations are added as new functions without touching existing transforms.

## Pass 2: IR → NRQL String (irToNrql.js)

Walk the IR tree, emit NRQL clauses:

```js
function emitQuery(node) {
  switch (node.type) {
    case 'SelectQuery': return emitSelectQuery(node);
    case 'Union': return emitUnion(node);
    case 'NestedAggregation': return emitNestedAggregation(node);
  }
}

function emitSelectQuery(q) {
  const parts = [];
  parts.push('FROM ' + emitDataSource(q.dataSource));
  if (q.join) parts.push('JOIN ' + emitJoin(q.join));
  if (q.bindings.length) parts.push('WITH ' + emitBindings(q.bindings));
  parts.push('SELECT ' + emitSelectList(q.select));
  if (q.where) parts.push('WHERE ' + emitExpr(q.where));
  if (q.facet.length) parts.push('FACET ' + emitFacetList(q.facet));
  if (q.orderBy) parts.push('ORDER BY ' + emitOrderBy(q.orderBy));
  if (q.limit != null) parts.push('LIMIT ' + q.limit);
  if (q.since) parts.push('SINCE ' + q.since);
  if (q.until) parts.push('UNTIL ' + q.until);
  if (q.timeseries) parts.push('TIMESERIES ' + q.timeseries);
  if (q.predict) parts.push('PREDICT');
  return parts.join(' ');
}

function emitExpr(node) {
  switch (node.type) {
    case 'Identifier': return escapeField(node.name);
    case 'Literal': return emitLiteral(node);
    case 'BinOp': return emitBinOp(node);
    case 'Function': return node.name + '(' + node.args.map(emitExpr).join(', ') + ')';
    case 'Alias': return emitExpr(node.expr) + " AS '" + escapeStringLiteral(node.name) + "'";
    // ... etc
  }
}
```

Escaping and formatting centralized here. One place to change if quoting rules change.

Returns: `{ nrql: string, warnings: string[], unsupported: string[], errors: string[] }`

## Cross-Grain Command Handling

Commands that don't fit the simple filter/project/aggregate model:

| Category | Commands | IR Strategy |
|---|---|---|
| **Row multiplication** | mvexpand, makemv | `Expand` marker; optimization pass resolves |
| **Set operations** | append, appendpipe, multisearch | `Union` node type |
| **Order-dependent** | streamstats, delta, autoregress, accum, trendline | `UnsupportedIntent` with specific context |
| **Session grouping** | transaction | `UnsupportedIntent` with specific context |
| **Correlated subquery** | map | `UnsupportedIntent` |
| **Dynamic reshaping** | transpose, xyseries, foreach | `UnsupportedIntent` |
| **Generators** | makeresults, gentimes | `UnsupportedIntent` |
| **Enrichment** | lookup, inputlookup, iplocation | `JoinClause` with lookup source + warning |

## File Structure

### Package: `packages/nr-query-bridge/`

```
packages/nr-query-bridge/
  package.json               — @datanerd/nr-query-bridge
  CLAUDE.md                  — translator-specific AI instructions
  .claude/
    rules/
      spl-reference.md       — moved from root .claude/rules/
      nrql-reference.md      — moved from root .claude/rules/
    agents/
      spl-expert.md          — moved from root .claude/agents/
      nrql-expert.md         — moved from root .claude/agents/
  src/
    index.js                 — public exports
    ir/
      nodes.js               — IR node constructors and helpers
      optimize.js            — optimization transforms (shared across targets)
    input/
      spl/
        spl.grammar          — moved from shared-component/helpers/
        splParser.js         — generated, moved
        spl.js               — V1 translator (moved, unchanged)
        splToIR.js            — NEW: Pass 1, SPL AST → IR
    output/
      nrql/
        irToNrql.js          — Pass 2: IR → NRQL string
        nrqlEncoding.js      — moved from shared-component/helpers/
      trino/                 — future: IR → Trino SQL
    util/
      encoding.js            — shared escaping utilities
  test/
    spl/
      spl.test.js            — moved from test/helpers/
      spl-real-world.json    — moved
      assembleNrql.js        — V1 NRQL assembly
    ir/
      nodes.test.js          — IR node construction tests
      optimize.test.js       — optimization transform tests
    output/
      irToNrql.test.js       — emitter unit tests
```

### Package CLAUDE.md

`packages/nr-query-bridge/CLAUDE.md` contains translator-specific instructions:

```markdown
# nr-query-bridge

Multi-language query translator. SPL/Lucene/PromQL/PPL → NRQL/Trino.

## Rules

* DO NOT USE bash/node/python! Use your Read/Edit tools.
* DO NOT COMMIT AUTOMATICALLY. Ask first.

## Build & Test

Requires Node 20: `ASDF_NODEJS_VERSION=20.19.0 <command>`

npm test                    # Unit tests (Jest)
npm run build:parsers       # Regenerate PEG.js parsers from grammars

## Conventions

- PEG.js v0.10.0 for parser generation
- All NRQL escaping via nrqlEncoding.js — don't add new encoding utils
- Generated parsers are checked in and CI-verified for freshness
- AI-DEV inline markers — see .claude/rules/ai-dev.md in root
- Conventional commits required (feat:, fix:, chore:)
- Seriously, work in small chunks (you timeout on large edits)
```

### Root CLAUDE.md changes

Add to root `CLAUDE.md`:
```markdown
## Query Translator

Query translator code lives in `packages/nr-query-bridge/` — see its own CLAUDE.md.
SPL/NRQL reference docs and expert agents are in that package's .claude/ directory.
```

Remove from root `CLAUDE.md`:
- "PEG.js v0.10.0 for parser generation" line
- "All NRQL escaping via nrqlEncoding.js" line
- "Generated parsers are checked in and CI-verified for freshness" line

### .claude/ file moves

Files that move from root `.claude/` to `packages/nr-query-bridge/.claude/`:

| File | Reason |
|---|---|
| `.claude/rules/spl-reference.md` | SPL domain knowledge — belongs with SPL translator |
| `.claude/rules/nrql-reference.md` | NRQL domain knowledge — belongs with NRQL emitter |
| `.claude/agents/spl-expert.md` | SPL expert agent — used by translator development |
| `.claude/agents/nrql-expert.md` | NRQL expert agent — used by translator development |

Files that stay in root `.claude/`:

| File | Reason |
|---|---|
| `rules/testing.md` | General testing standards — applies to all code |
| `rules/llm-test-verification.md` | General LLM test process |
| `rules/ai-dev.md` | AI-DEV marker standard — applies to all code |
| `rules/debugging.md` | Shared-component debugging guide |
| `rules/pr-review.md` | PR review checklist |
| `rules/security.md` | Security standards |
| `rules/engineering-standards.md` | NR engineering standards |
| `rules/cli-safety.md` | CLI safety rules |

### Thin re-export in shared-component:

```
shared-component/helpers/spl.js:
  export { translateSplToNrql, parseSplTime } from '@datanerd/nr-query-bridge';
```

Everything in the shared component that imports from `./spl` keeps working through the re-export.

### Extractability

The entire `packages/nr-query-bridge/` folder is a self-contained npm package with:
- Its own `package.json` with name, version, exports, test script
- Zero imports from outside the package (except `nrqlEncoding.js` which moves into it)
- Zero coupling to React, NR1, or the shared component UI
- Its own test suite that runs independently: `cd packages/nr-query-bridge && npm test`

To extract to a separate repo: move the folder, publish to npm, change the root `package.json` dependency from `file:./packages/nr-query-bridge` to `@datanerd/nr-query-bridge@^1.0.0`.

### Future language additions

Adding a new input language (e.g., PromQL):
1. Create `src/input/promql/` with parser and `promqlToIR.js`
2. IR and optimization pass are shared — no changes needed
3. Export from `index.js`

Adding a new output target (e.g., Trino):
1. Create `src/output/trino/irToTrino.js`
2. IR stays the same — only emission logic differs
3. Export from `index.js`

## Migration Plan

### Phase 0: Package Extraction
- Create `packages/nr-query-bridge/` with `package.json` and `CLAUDE.md`
- Create `packages/nr-query-bridge/.claude/` with `rules/` and `agents/`
- Move `spl-reference.md`, `nrql-reference.md` from root `.claude/rules/` to package `.claude/rules/`
- Move `spl-expert.md`, `nrql-expert.md` from root `.claude/agents/` to package `.claude/agents/`
- Move `spl.grammar`, `splParser.js`, `spl.js`, `nrqlEncoding.js` into `src/input/spl/` and `src/output/nrql/`
- Move `spl.test.js`, `spl-real-world.json`, `assembleNrql.js` into `test/spl/`
- Add thin re-export in `shared-component/helpers/spl.js`
- Add `file:./packages/nr-query-bridge` dependency to root `package.json`
- Update root `CLAUDE.md`: add query translator section, remove translator-specific conventions
- Verify: all 767+ existing tests pass unchanged
- This is a purely mechanical move — zero logic changes

### Phase 1: Foundation
- Define IR types in `splIR.js`
- Build `irToNrql.js` emitter
- Unit test emitter with hand-built IR nodes
- Build V2 test harness (runs V1 and V2, categorizes diffs)

### Phase 2: Simple Commands
- Implement Pass 1 for: search clause, stats, where, eval, table, fields, sort, head, rename, dedup
- V2 matches V1 on ~60% of real-world corpus

### Phase 3: Complex Commands
- Add: timechart, chart, eventstats, rex, bin/bucket, top/rare, join, append, spath, convert, replace, predict, tstats
- V2 matches V1 on ~95% of corpus

### Phase 4: Optimization
- Add `irOptimize.js` transforms: mv* patterns, subquery simplification, dead binding elimination
- V2 starts producing better output than V1 for some queries

### Phase 5: New Commands
- Implement streamstats, transaction, mstats with proper intent recording
- These go directly on V2, no V1 equivalent

### Phase 6: Cutover
- Review all divergences between V1 and V2
- User decides correct output for each
- Delete V1, rename V2

### Divergence Handling

Test harness categorizes each real-world query:

| Category | Meaning | Action |
|---|---|---|
| **Match** | V1 and V2 produce same NRQL | Green — no action |
| **V2 improvement** | V2 produces NRQL where V1 had parse error | Green — V2 is better |
| **Divergence** | Both produce NRQL but differ | Flag for human review |
| **V2 regression** | V2 errors but V1 worked | Red — must fix before cutover |

## What Survives Unchanged

- `spl.grammar` — 100% (moved to package, content unchanged)
- `splParser.js` — 100% (moved to package, content unchanged)
- `spl-real-world.json` — 100% (moved to package, content unchanged)
- `nrqlEncoding.js` — 100% (moved to package, content unchanged)
- `spl.test.js` test cases — 100% (moved to package, harness gets V2 additions)
- 767+ existing unit tests — 100%
- All shared-component imports — work via thin re-export

## Success Criteria

1. V2 produces valid NRQL for all queries V1 handles (zero regressions)
2. V2 handles mv* commands with pattern-aware optimization
3. V2 produces better unsupported messages (intent-specific, not generic)
4. V2 code is extractable to a standalone repo with no UI dependencies
5. Each IR node type is independently testable
6. New commands can be added by implementing one `applyCommand` case + one `emitExpr` case
