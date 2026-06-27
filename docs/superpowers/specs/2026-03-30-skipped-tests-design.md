# Skipped Tests Design Spec

> **Problem tracking consolidated into** [`2026-06-27-known-issues-laundry-list-design.md`](./2026-06-27-known-issues-laundry-list-design.md) (`stats-count-by-array-field`, `stats-eval-grammar`, and the multivalue gaps). This file is kept for its fix-design detail.

5 skipped tests remain in spl.test.js. This spec covers the design for all 5, plus the broader EXPAND opportunity that affects ~15 existing tests.

## 1. Append edge cases (validation only — no code changes)

### 1a. Cross-index append
```
SPL:  index=web | stats count as web_count | append [search index=api | stats count as api_count]
NRQL: FROM Log SELECT filter(count(*), WHERE index = 'web') AS 'web_count',
                    filter(count(*), WHERE index = 'api') AS 'api_count'
```
**Status:** Already works. Un-skip, update test to match actual output. The warning `append_filter_warning` already fires.

### 1b. Pre-stats WHERE append
```
SPL:  * | where status=500 | stats avg(duration) as err_dur | append [search * | stats avg(duration) as all_dur]
```
**Status:** Already works. Actual output uses DualCheck for status (more correct than the test's `numeric(status) = 500`) and bare `average(duration)` instead of `filter(average(duration), WHERE 1=1)` (cleaner). Un-skip and update expected NRQL.

**Effort:** Trivial — test-only changes.

---

## 2. EXPAND support — `{}` fields, mvexpand, and array expansion

### Background: NRQL EXPAND (Limited Preview Q1 2026)

Source: Confluence page "Introducing NRQL EXPAND, Split, String Interpolation and Replace to Limited Preview" (QLD space, page 4423319618).

- **Syntax:** `FROM Event EXPAND listAttribute AS element SELECT ...`
- **Semantics:** Replays each row once per array element (like SQL UNNEST)
- **Works with FACET:** `EXPAND x AS el FACET el` — count frequency per element
- **Works with WHERE:** Can filter on expanded element values
- **1:100 limit:** Stops at 100th element silently, does not fail
- **Status:** Limited Preview — not GA. May not be available on all accounts.
- **Known bug:** EXPAND + JOIN combination
- **Also introduced:** `split(string, delimiter)` function (creates arrays from delimited strings), `replace()` function, string interpolation with `"Account: {account}"`

### The `{}` pattern across the codebase

`{}` in SPL field names means "this is an array — expand it." It appears in 4 contexts in the test suite:

#### Context 1: WHERE (search expressions) — 5 human-verified tests
```
lineItemList{}.status=active    → contains(jparse(message, 'lineItemList[*].status'), 'active')
items{}.status != pending       → NOT contains(...)
orders{}.shipping.carrier=fedex → contains(...)
containers{}.image=nginx*       → jparse(...) LIKE 'nginx%'
items{}.category IN (...)       → OR'd contains() calls
```
**Current approach:** `contains(jparse(field, 'path[*].sub'), value)` — checks if any array element matches. This is a scalar check (no row expansion).

**With EXPAND:** Could do `EXPAND jparse(items) AS item WHERE item[status] = 'active'` — row-level expansion + filter. More precise but heavier.

**Verdict:** Current `contains()` approach is correct and efficient for equality/LIKE checks. EXPAND is in limited preview — only use when no alternative exists. **No change needed.**

#### Context 2: WITH/SELECT (spath command) — 3 human-verified tests
```
spath path=errors{}.code output=error_code  → WITH jparse(message, 'errors[*].code') AS error_code
spath path=items{}.status                   → WITH jparse(message, 'items[*].status') AS status
```
**Current approach:** `WITH jparse(field, 'path[*].sub') AS alias` — extracts the array as a single value.

**With EXPAND:** If downstream commands need per-element access (mvexpand follows), EXPAND would be needed. But for bare spath (no mvexpand), the current WITH binding is correct.

**Verdict:** **No change needed** for standalone spath. But when spath is followed by mvexpand, the spath binding becomes the source for EXPAND (see Context 4).

#### Context 3: FACET (stats groupBy) — 1 broken test (skipped)
```
stats count by validations{}.code  → CURRENTLY BROKEN (backtick-escapes literally)
stats values(user.groups{}) by host → uniques(jparse(message, 'user.groups[*]')) ✅ (works via uniques())
```
**The broken case:** `stats count by validations{}.code` needs per-element grouping. `uniques()` works for `values()` because it natively handles arrays, but `count by` needs actual row expansion.

**With EXPAND:** `EXPAND jparse(validations) AS val FACET getField(val, 'code')` — correct translation.

**Verdict:** **EXPAND needed.** This is the primary use case.

#### Context 4: mvexpand — 4 tests (all unsupported)
```
spath path=cloudformation{}.stack_prefix | mvexpand stack_prefix  → unsupported
spath → mvexpand → spath → mvexpand (cascading)                   → unsupported
spath → mvexpand (cross-field, 2 different arrays)                → unsupported
```
**Current approach:** `mvexpand` fires `mvexpand_unsupported` — hard stop.

**With EXPAND:** `mvexpand fieldName` IS `EXPAND fieldName AS fieldName`. This is the direct semantic equivalent. Every `mvexpand` could potentially emit EXPAND.

**Verdict:** **EXPAND is the mvexpand translation.** This un-blocks all mvexpand tests. The `mvexpand_unsupported` message would change to `expand_limited_preview` warning (limited preview caveat) instead of a hard unsupported.

### Design: Grammar-level ArrayField detection (Option A)

The `{}` pattern appears across search expressions, spath, stats, and mvexpand — it's a cross-cutting concern. Grammar-level detection gives every handler access to structured `ArrayField` nodes for free.

#### Grammar change
Add `ArrayField` as a field name alternative in `spl.grammar`:
```peggy
field_reference
  = array:field_name '{}.' sub:field_path
    { return { type: 'ArrayField', array: array, subfield: sub }; }
  / array:field_name '{' idx:integer '}'
    { return { type: 'IndexedArrayField', array: array, index: idx }; }
  / array:field_name '{}'
    { return { type: 'ArrayField', array: array, subfield: null }; }
  / name:field_name
    { return name; }  // existing behavior — bare string
```

**AST output:**
- `validations{}.code` → `{ type: 'ArrayField', array: 'validations', subfield: 'code' }`
- `Items{}` → `{ type: 'ArrayField', array: 'Items', subfield: null }`
- `sourceIPs{0}` → `{ type: 'IndexedArrayField', array: 'sourceIPs', index: 0 }`

**Note:** This changes the existing behavior — currently `{}` fields pass through as literal strings. Existing handlers that already handle `{}` (search expression translator, spath handler) would need to be updated to accept `ArrayField` nodes instead of regex-matching strings. This is a moderate refactor but results in cleaner code.

#### New IR node
```javascript
// In nodes.js — new Expand node
Expand: { source: IRNode, alias: string }

// New field on SelectQuery:
expand: null | Expand
```

#### Handler changes

**`handleMvexpand` (rowHandlers.js):**
Currently fires `mvexpand_unsupported`. Change to:
```javascript
export function handleMvexpand(cmd, ir) {
  ir.expand = Expand(Identifier(cmd.field), cmd.field);
  ir.warnings.push(messages.expand_limited_preview());
}
```

**`handleStats` / `handleTimechart` (aggregationHandlers.js):**
When groupBy contains an `ArrayField`:
```javascript
for (const field of cmd.groupBy) {
  if (field.type === 'ArrayField') {
    const alias = `_${field.array}_elem`;
    ir.expand = Expand(Func('jparse', [Identifier(field.array)]), alias);
    ir.facet.push(field.subfield
      ? Func('getField', [Identifier(alias), Literal(field.subfield, 'string')])
      : Identifier(alias));
    ir.warnings.push(messages.expand_limited_preview());
  } else {
    ir.facet.push(Identifier(field));
  }
}
```

**Search expression translator (splToIR.js):**
Currently regex-matches `{}` and emits `contains(jparse(...))`. Would instead receive `ArrayField` nodes and use the same logic but with structured data instead of regex. Behavior stays the same — no EXPAND in WHERE context.

**spath handler (extractionHandlers.js):**
Currently regex-matches `{}` in path and emits `jparse(field, 'path[*].sub')`. Would receive the path as-is (spath paths aren't field_references — they're string arguments). **Probably no change needed here** since spath paths are parsed separately from field names.

#### Emitter change (irToNrql.js)
After FROM clause, before SELECT:
```javascript
if (q.expand) {
  parts.push(`EXPAND ${emitExpr(q.expand.source)} AS ${q.expand.alias}`);
}
```

#### Warning message
```javascript
expand_limited_preview: () =>
  'NRQL EXPAND is in limited preview and may not be available on all accounts',
```

### Impact on existing tests

Tests that currently fire `mvexpand_unsupported` would change to emit EXPAND + warning. This affects:
- `spath + mvexpand + search` (line ~2491) — would produce EXPAND instead of unsupported
- Cascading mvexpand tests — would produce nested EXPAND (see section 3)
- Cross-field mvexpand tests — would produce multiple EXPANDs

The `mvexpand_unsupported` message would still exist for edge cases where EXPAND can't help (e.g., `mvexpand` on a non-array field).

### Files
- `src/input/spl/spl.grammar` — add ArrayField to field_reference rule
- `src/input/spl/splParser.js` — regenerate via `npm run build:parsers`
- `src/ir/nodes.js` — add `expand` field to SelectQuery, add Expand node
- `src/input/spl/rowHandlers.js` — rewrite handleMvexpand to emit EXPAND
- `src/input/spl/aggregationHandlers.js` — detect ArrayField in groupBy
- `src/input/spl/splToIR.js` — update search expr translator for ArrayField nodes
- `src/output/nrql/irToNrql.js` — emit EXPAND clause
- `src/messages.js` — add `expand_limited_preview`, update `mvexpand_unsupported`
- `test/spl/spl.test.js` — un-skip tests, update mvexpand tests to expect EXPAND

**Effort:** Medium-Large — grammar change, new IR node, multiple handler updates, emitter change, test updates across ~10 cases.

---

## 3. Cascading mvexpand → nested FROM with EXPAND

### Problem
SPL chains: `spath → mvexpand → spath → mvexpand → spath` to drill into nested JSON arrays.

### NRQL target
```sql
FROM (FROM Log EXPAND jparse(message, 'Items') AS item
      SELECT item, getField(item, 'Channels') LIMIT MAX)
EXPAND jparse(Channels) AS channel
SELECT getField(channel, 'Name')
```

### Design
Builds directly on #2. Each `mvexpand` in the pipeline adds an EXPAND to the current query. When a second `mvexpand` appears, the current query (with its EXPAND) wraps as a SubquerySource, and the new EXPAND goes on the outer query.

**Pipeline loop tracking:**
```
mvexpand items    → ir.expand = Expand(Identifier('items'), 'items')
mvexpand channels → wrapAsSubquery(ir); ir.expand = Expand(Identifier('channels'), 'channels')
```

The existing `wrapAsSubquery` already handles moving the current IR into a subquery. The new wrinkle: it needs to carry the `expand` field into the inner query (same pattern as the timeseries fix we did earlier).

**wrapAsSubquery change:**
```javascript
const innerQuery = SelectQuery({
  // ...existing fields...
  expand: ir.expand,  // carry EXPAND into inner query
});
ir.expand = null;  // clear for outer query
```

### Dependencies
- Requires #2 (EXPAND IR + emitter + handleMvexpand rewrite)

### Files
- `src/input/spl/splExprUtils.js` — update wrapAsSubquery to carry expand
- `src/input/spl/rowHandlers.js` — handleMvexpand detects second expansion, wraps
- `test/spl/spl.test.js` — un-skip cascading test, update expected NRQL

**Effort:** Medium — once #2 is done, this is mainly wrapAsSubquery plumbing.

---

## 4. `timechart eval(...)` grammar

### Problem
Grammar recognizes `count(eval(status>=400))` but not bare `eval((sum(orders)*100)/sum(addtobags))` as a top-level stats_function.

### Grammar change
Add a second alternative to `stats_function` in `spl.grammar`:

```peggy
stats_function
  = _* name:function_name '(' _* 'eval'i _* '(' _* evalExpr:eval_inner_expr _* ')' _* ')' alias:as_clause?
    { return { name: name, args: [], alias: alias, evalFilter: evalExpr }; }
  / _* 'eval'i '(' _* expr:eval_inner_expr _* ')' alias:as_clause?
    { return { name: 'eval', args: [], alias: alias, evalFilter: expr }; }
  / _* name:function_name '(' _* args:function_args _* ')' alias:as_clause?
    { return { name: name, args: args, alias: alias }; }
  / _* ('count'i / 'c'i !([a-zA-Z0-9_])) alias:as_clause?
    { return { name: 'count', args: [], alias: alias }; }
```

The new alternative (second position) matches `eval(expr)` and produces `{ name: 'eval', evalFilter: '(sum(orders)*100)/sum(addtobags)' }`.

**Must be ordered before `name(args)`** — otherwise `eval` matches as a function name.

### Handler change
`handleStats` already processes `evalFilter` for the `name(eval(expr))` variant. The new variant produces `{ name: 'eval', evalFilter: expr }`.

The handler needs to:
1. Detect `fn.name === 'eval'` with `fn.evalFilter`
2. Parse the evalFilter string to find aggregation functions (`sum`, `count`, etc.)
3. Build IR: each agg function → `Func` node, arithmetic → `BinOp`

This is a mini eval-expression walker that recognizes stats function names as `Func` calls instead of field references. The existing `walkEvalExpr` could potentially be reused with a mode flag, or a simpler regex-based parser could handle the common `(sum(x)*100)/sum(y)` pattern.

### The full customer query
The test case combines: search → eval → dedup → eval → timechart eval(...). Even with the grammar fix, the dedup→timechart interaction needs nested subquery nesting. This is a multi-part fix — the grammar change enables parsing, but the full translation requires dedup subquery support too.

### Simpler test cases to start with
```
* | stats eval(sum(bytes)/count(*)) as avg_bytes
* | timechart eval(sum(errors)*100/sum(requests)) as error_rate span=5m
```
These don't involve dedup and would test the grammar + handler in isolation.

### Files
- `src/input/spl/spl.grammar` — add eval alternative to stats_function
- `src/input/spl/splParser.js` — regenerate via `npm run build:parsers`
- `src/input/spl/aggregationHandlers.js` — handle `name === 'eval'` with evalFilter
- `test/spl/spl.test.js` — add simpler eval-in-stats tests, update complex test

### Scope: which commands benefit?
The `stats_function` rule is shared by **stats**, **timechart**, **chart**, and **eventstats**. One grammar change covers all four. No other eval contexts need this — the regular `| eval` command already has its own full expression parser.

Real-world frequency: zero occurrences of `stats eval(...)` / `timechart eval(...)` in the 339-query corpus. Only known example is one customer migration query. Valid SPL, but rare.

**Effort:** Medium for grammar, medium-hard for handler. Full customer query is hard.

---

## Summary

| # | Item | Type | Effort | Dependencies |
|---|------|------|--------|-------------|
| 1a | Cross-index append | Validation only | Trivial | None |
| 1b | Pre-stats WHERE append | Validation only | Trivial | None |
| 2 | EXPAND support (`{}` + mvexpand) | Grammar + IR + handlers + emitter | Medium-Large | None |
| 3 | Cascading mvexpand nesting | Handler + wrapAsSubquery | Medium | #2 |
| 4 | `timechart eval(...)` | Grammar + handler | Medium-Hard | None |

### Recommended implementation order
1. **1a + 1b** — un-skip and fix expected NRQL (minutes)
2. **2** — EXPAND support (foundational — enables #3 and un-blocks mvexpand tests)
3. **4** — `timechart eval(...)` grammar (independent of #2/#3)
4. **3** — cascading mvexpand nesting (depends on #2)

## PR breakdown

> Retrofit per CLAUDE.md "Small PRs" rule. Each PR below is independently reviewable and shippable; land in order.

1. **Un-skip the two append cases** (~30 lines, tests) — Test-only fix for the two skipped append tests (§1): un-skip 1a (cross-index append → `filter(count(*), WHERE …)`) and 1b (pre-stats WHERE append → DualCheck + bare `average(duration)`), updating each expected NRQL to match current output and listing `append_filter_warning` in `warningFunc`. No `src/` changes. *Dependency: independent.*
2. **`timechart eval(...)` grammar + simple-case handler** (~250 lines, behavior) — Adds the bare `eval(expr)` alternative to the `stats_function` rule in `spl.grammar` (ordered before `name(args)`), regenerates the parser via `build:parsers`, and teaches `handleStats`/`handleTimechart` (aggregationHandlers.js) to handle `{ name: 'eval', evalFilter }` by walking the expr into `Func`/`BinOp` IR. Un-skips via the two simple isolation cases (`stats eval(sum(bytes)/count(*))`, `timechart eval(sum(errors)*100/sum(requests)) span=5m`); the full dedup→timechart customer query stays skipped (needs dedup subquery support, out of scope). Covers stats/timechart/chart/eventstats since they share the rule. *Dependency: independent.*
3. **EXPAND scaffolding: ArrayField grammar + Expand IR node + emitter** (~300 lines, scaffolding) — Lands the plumbing for §2 with no consumer yet: add the `ArrayField`/`IndexedArrayField` alternatives to `field_reference` in `spl.grammar` (regenerate parser); update the existing `{}`-aware sites (search-expr translator in splToIR.js; spath if affected) to accept `ArrayField` nodes instead of regex-matching strings, preserving identical `contains(jparse(...))`/`WITH` output (pure refactor — behavior unchanged); add the `Expand` factory + `expand` field on `SelectQuery` in nodes.js; emit the `EXPAND … AS …` clause in irToNrql.js; add `expand_limited_preview` to messages.js. No test un-skips here — refactor lands first and suite stays green. *Dependency: independent (foundation for PRs 4–5).*
4. **mvexpand → EXPAND + `count by {}` FACET** (~250 lines, behavior) — Rewrites `handleMvexpand` (rowHandlers.js) to emit `ir.expand = Expand(...)` + `expand_limited_preview` warning instead of `mvexpand_unsupported` (kept only for non-array edge cases), and updates `handleStats` to detect an `ArrayField` in groupBy and emit `EXPAND jparse(...) AS _elem FACET getField(...)`. Un-skips the §3-Context-3 `stats count by validations{}.code` test and the single-level mvexpand tests, flipping their `unsupportedFunc` to `warningFunc: [expand_limited_preview]`. *Dependency: needs PR 3.*
5. **Cascading + cross-field mvexpand → nested EXPAND** (~150 lines, behavior) — Updates `wrapAsSubquery` (splExprUtils.js) to carry the `expand` field into the inner query and clear it on the outer (mirrors the timeseries fix), and makes `handleMvexpand` wrap-then-re-expand on a second mvexpand. Un-skips the cascading (`spath→mvexpand→spath→mvexpand`) and cross-field mvexpand tests, asserting the nested `FROM (… EXPAND …) EXPAND …` output. *Dependency: needs PR 4.*
