# Bare `eval(...)` as a stats/timechart function — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate a bare `eval(<expr>)` in stats/timechart **function** position to the equivalent NRQL aggregate expression (e.g. `stats eval(sum(errors)*100/sum(reqs))` → `SELECT sum(errors)*100/sum(reqs) AS rate`), and emit a precise `unsupported` when the expression has no aggregate or wraps one in a non-fold-safe function — instead of today's silent `SELECT *` + false "no equivalent" warning.

**Architecture:** Three layers, wired inert-then-active so each carries its own end-to-end tests. (1) A new `stats_eval_unsupported` message. (2) A grammar alternative that parses bare `eval(u_expr)` as a distinct stats function (`{statsEval:true, evalExpr, rawText, alias}`) plus a handler branch that — at first — emits `stats_eval_unsupported` for every such metric (this alone removes the silent-wrong `SELECT *`). (3) A new stats-context walk (`walkStatsEvalExpr`) that translates aggregate arithmetic + fold-safe scalar functions over aggregates, which the handler branch calls; non-translatable expressions keep failing loud.

**Tech Stack:** Pure ESM JavaScript; Peggy grammar (`spl.grammar` → `npm run build:parsers`); IR node factories in `src/ir/nodes.js`; Vitest data-driven `cases` in `test/spl/spl.test.js`; message catalog in `src/messages.js`.

**Branch:** `feat/stats-eval-grammar` (already cut off `master`).

## Global Constraints

- Dev requires **Node 24**: prefix every command (including `git commit`) with `ASDF_NODEJS_VERSION=24.14.0`. Hooks need it.
- Conventional commits, lowercase subject ≤72 chars, body lines ≤100. Use `git commit -F <file>` for multi-line bodies. Push with `git push origin HEAD`.
- **Loud failure over silent wrong:** any expression that can't translate faithfully pushes `messages.stats_eval_unsupported(...)`, never compiling-but-wrong NRQL and never a silent `SELECT *`.
- All user-facing messages live in `src/messages.js`; handlers call `messages.key()` — no inline strings. `test/messages.test.js` enforces bidirectional key consistency, so every new key needs a matching test reference.
- New/changed translations land at `verified: 'llm'` at most; only a human promotes to `'human'`.
- Translator tests are data-driven `cases` in `test/spl/spl.test.js` (the sanctioned exception to the explicit-test rule). Each case lists `warningFunc`/`unsupportedFunc` **exhaustively** (every message key that fires).
- Run one package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl`. Regenerate the parser after any grammar edit: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`.
- Paths below are relative to the package root `packages/nr-query-bridge/`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/messages.js` | message catalog | add `stats_eval_unsupported(expr)` |
| `test/messages.test.js` | message-key consistency | reference the new key |
| `src/input/spl/spl.grammar` | SPL → AST | add a bare-`eval(u_expr)` alternative to `stats_function` (line 111) |
| `src/input/spl/splParser.js` | generated parser | regenerated via `build:parsers` (never hand-edited) |
| `src/input/spl/aggregationHandlers.js` | `handleStats`/`handleTimechart` | add a `fn.statsEval` branch in the function loop |
| `src/input/spl/statsEvalHandlers.js` | **new** — stats-context expression walk | `walkStatsEvalExpr(node, ir)` + `isNrqlAggregate(expr)` |
| `src/ir/foldPostAggregation.js` | fold pass + agg helpers | export `NRQL_AGG_FUNCS` (currently module-private) |
| `test/spl/spl.test.js` | end-to-end cases | unsupported cases (Task 2), translatable cases (Task 3), `count(eval())` regression |
| `.claude/rules/design-decisions.md` | shipped invariants | graduate the invariant (Task 4, optional) |

---

### Task 1: Add the `stats_eval_unsupported` message

**Files:**
- Modify: `src/messages.js`
- Test: `test/messages.test.js`

**Interfaces:**
- Produces: `messages.stats_eval_unsupported(expr: string) => string` — consumed by the handler branch in Task 2/3.

- [ ] **Step 1: Add a failing reference** in `test/messages.test.js`. Find the existing list/array of referenced message keys (the test asserts every `messages` key is referenced and vice-versa) and add `'stats_eval_unsupported'` to it.

- [ ] **Step 2: Run, confirm red.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- messages`
Expected: FAIL — `stats_eval_unsupported` referenced but not defined (or the reciprocal "defined but not referenced" once Step 3 lands first; either direction proves the link).

- [ ] **Step 3: Add the message** to `src/messages.js` (place it near the other stats/eval messages):

```js
stats_eval_unsupported: (expr) =>
  `'${expr}' has no faithful NRQL form as a stats/timechart metric — a bare eval() metric must reduce to arithmetic over aggregates with fold-safe functions; an expression with no aggregate, or a non-fold-safe function over an aggregate, is unsupported`,
```

- [ ] **Step 4: Run, confirm green.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- messages`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git commit -am "feat: add stats_eval_unsupported message"
```

---

### Task 2: Parse bare `eval(...)` as a stats function; emit loud `unsupported` (kills the silent `SELECT *`)

This lands the grammar + a safe handler branch that fails loud for every bare-`eval()` metric. It does not yet translate — Task 3 does — but it already replaces today's silent-wrong `SELECT *` + false warning with a precise `unsupported`. (This is the spec's rejected "Approach B" used as a safe intermediate state.)

**Files:**
- Modify: `src/input/spl/spl.grammar` — `stats_function` rule (line 111)
- Regenerate: `src/input/spl/splParser.js` (via `build:parsers`)
- Modify: `src/input/spl/aggregationHandlers.js` — `handleStats` loop (line 43) and `handleEventstats` loop (line 149)
- Test: `test/spl/spl.test.js`

**Interfaces:**
- Consumes: `messages.stats_eval_unsupported` (Task 1).
- Produces: a parsed stats function of shape `{ statsEval: true, evalExpr: <u_expr AST>, rawText: string, alias: string|null, args: [] }`, consumed by the handler branches here and upgraded in Task 3.

- [ ] **Step 1: Add failing cases** to `test/spl/spl.test.js` (find the `cases` array; add these objects). These assert the *permanently*-unsupported shapes plus the `count(eval())` regression — translatable cases come in Task 3:

```js
{
  spl: '* | stats eval(upper(host)) as h',
  unsupportedFunc: ['stats_eval_unsupported'],
  doc: 'stats-eval-grammar', verified: false,
},
{
  // non-fold-safe function OVER an aggregate (distinct path from upper(host),
  // which has no aggregate at all) — both → unsupported.
  spl: '* | stats eval(mvjoin(values(x), ",")) as j',
  unsupportedFunc: ['stats_eval_unsupported'],
  doc: 'stats-eval-grammar', verified: false,
},
{
  spl: '* | eventstats eval(sum(bytes)) by host',
  unsupportedFunc: ['stats_eval_unsupported'],
  doc: 'stats-eval-grammar', verified: false,
},
{
  // Regression: count(eval(...)) is the DISTINCT fn(eval()) form and must not change.
  spl: '* | stats count(eval(status>=500)) as errors',
  nrql: "FROM Log SELECT filter(count(*), WHERE numeric(status) >= 500) AS 'errors'",
  warningFunc: [], unsupportedFunc: [],
  doc: 'stats-eval-grammar', verified: false,
},
```

- [ ] **Step 2: Run, confirm red.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl`
Expected: the two `eval(...)` cases FAIL (today they emit `SELECT *` + `no_equiv_func`, not `stats_eval_unsupported`). The `count(eval())` regression should already PASS.

- [ ] **Step 3: Add the grammar alternative.** In `src/input/spl/spl.grammar`, insert a new alternative in `stats_function` **between** the `name(eval(...))` alternative (the one returning `evalFilter`) and the generic `name(args)` alternative. Order matters: after the `evalFilter` form so `count(eval(...))` still matches it; before the generic form so `eval(...)` isn't parsed as a function literally named "eval".

```
  / _* 'eval'i !([a-zA-Z0-9_]) _* '(' _* evalExpr:u_expr _* ')' alias:as_clause?
    {
      return { statsEval: true, evalExpr: evalExpr, rawText: text().trim(), alias: alias, args: [] };
    }
```

The `!([a-zA-Z0-9_])` guard stops `eval` from matching the prefix of a longer function name (e.g. `evaluate(`). `text()` returns the full matched source; `.trim()` drops the leading `_*` whitespace.

- [ ] **Step 4: Regenerate the parser.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
Expected: `splParser.js` rewritten, no errors.

- [ ] **Step 5: Add the handler guard in `handleStats`.** In `src/input/spl/aggregationHandlers.js`, make the `fn.statsEval` check the FIRST statement inside the `for (const fn of cmd.functions)` loop (line 43), before the `fn.evalFilter` check:

```js
  for (const fn of cmd.functions) {
    if (fn.statsEval) {
      // Bare eval() stats metric. Task 3 upgrades this to faithful translation;
      // for now fail loud rather than silently drop the metric to SELECT *.
      ir.unsupported.push(messages.stats_eval_unsupported(fn.rawText));
      continue;
    }
    if (fn.evalFilter) {
      // ... existing count(eval()) handling, unchanged ...
```

- [ ] **Step 6: Add the same guard in `handleEventstats`.** `handleEventstats` (line 149) has its OWN loop that calls `mapFunction(fn.name, ...)` — a `statsEval` fn has no `name`, so guard it first:

```js
  for (const fn of cmd.functions) {
    if (fn.statsEval) {
      ir.unsupported.push(messages.stats_eval_unsupported(fn.rawText));
      continue;
    }
    const mapped = mapFunction(fn.name, fn.args);
    // ... unchanged ...
```

(`ChartCommand` dispatches to `handleStats` per `splToIR.js:672`, so chart is already covered by Step 5. `stats`, `timechart` (delegates to `handleStats`), and `chart` all share the Step-5 guard; `eventstats` needs its own here.)

- [ ] **Step 7: Run, confirm green.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl`
Expected: all three new cases PASS. Then run the whole package — `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge` — and confirm no regressions (existing `count(eval())`/stats/timechart/chart/eventstats cases unchanged).

- [ ] **Step 8: Verify the silent-`SELECT *` is gone for the aggregate case (CLI).**

Run: `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "* | timechart eval(sum(errors)*100/sum(reqs)) as rate span=5m"`
Expected: `unsupported: ...stats_eval_unsupported...` — NOT `FROM Log SELECT * TIMESERIES 5 minutes` + `no_equiv_func`. (Task 3 makes this case translate; here we only confirm it no longer silently drops the metric.)

- [ ] **Step 9: Fuzz the grammar change (×20).** A new `eval(` alternative is the risk — it must not mis-parse adjacent constructs.

Run: `for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done`
Expected: 20 green runs (fast-check reseeds each run; one green is a false-green).

- [ ] **Step 10: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git commit -am "feat: parse bare eval() stats metric, fail loud (no silent SELECT *)"
```

---

### Task 3: Translate faithful aggregate expressions (stats-context walk)

Upgrade the `handleStats` branch from loud-unsupported to faithful translation via a new stats-context walk. `eventstats` stays at the loud guard (bare-`eval()` in `eventstats` is out of scope — rare, and loud-safe).

**Files:**
- Create: `src/input/spl/statsEvalHandlers.js` — `walkStatsEvalExpr(node, ir)`, `isNrqlAggregate(expr)`
- Modify: `src/ir/foldPostAggregation.js` — export `NRQL_AGG_FUNCS` (line 34)
- Modify: `src/input/spl/aggregationHandlers.js` — upgrade the `fn.statsEval` branch in `handleStats` (the branch added in Task 2 Step 5); import the new helpers
- Test: `test/spl/spl.test.js`

**Interfaces:**
- Consumes: `mapFunction` (`splExprUtils.js:120`), `isFoldSafe` + `NRQL_AGG_FUNCS` (`foldPostAggregation.js`), `walkEvalExpr` (`evalHandlers.js`), IR factories (`nodes.js`), the `{statsEval, evalExpr, rawText, alias}` shape (Task 2).
- Produces: `walkStatsEvalExpr(node, ir) => IRNode | null` and `isNrqlAggregate(expr) => boolean`.

- [ ] **Step 1: Export `NRQL_AGG_FUNCS`.** In `src/ir/foldPostAggregation.js` line 34, change `const NRQL_AGG_FUNCS = new Set([` to `export const NRQL_AGG_FUNCS = new Set([`. (No other change; `isFoldSafe` is already exported.)

- [ ] **Step 2: Add failing translatable cases** to the `cases` array in `test/spl/spl.test.js`. Expected NRQL strings below are the target shape; **confirm the exact emitter formatting (operator spacing, alias quoting) in Step 6 and paste the verbatim CLI output** — the emitter's format is canonical:

```js
{
  spl: '* | timechart eval(avg(CPU) * avg(MEM)) by host span=5m',
  nrql: 'FROM Log SELECT average(CPU) * average(MEM) FACET host TIMESERIES 5 minutes',
  warningFunc: [], unsupportedFunc: [],
  doc: 'stats-eval-grammar', verified: false,
},
{
  spl: '* | timechart eval(round(avg(cpu_seconds), 2)) by processor',
  nrql: 'FROM Log SELECT round(average(cpu_seconds), 2) FACET processor TIMESERIES AUTO',
  warningFunc: [], unsupportedFunc: [],
  doc: 'stats-eval-grammar', verified: false,
},
{
  spl: '* | stats eval(sum(errors)*100/sum(reqs)) as rate',
  nrql: "FROM Log SELECT sum(errors) * 100 / sum(reqs) AS 'rate'",
  warningFunc: [], unsupportedFunc: [],
  doc: 'stats-eval-grammar', verified: false,
},
{
  // no alias, no by, constant operand — still translatable (has an aggregate)
  spl: '* | stats eval(avg(cpu) + 1)',
  nrql: 'FROM Log SELECT average(cpu) + 1',
  warningFunc: [], unsupportedFunc: [],
  doc: 'stats-eval-grammar', verified: false,
},
```

- [ ] **Step 3: Run, confirm red.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl`
Expected: the four new cases FAIL with `stats_eval_unsupported` (Task 2's loud branch still fires; the walk isn't wired yet). The Task 2 `upper(host)` / `eventstats` / `count(eval())` cases stay green.

- [ ] **Step 4: Create the walk** at `src/input/spl/statsEvalHandlers.js`:

```js
/**
 * Stats-context translation of a bare eval() metric's expression.
 *
 * Distinct from walkEvalExpr (eval context): aggregate calls (sum/avg/count/…)
 * resolve to NRQL aggregates via mapFunction (avg→average, …), and operands are
 * NOT wrapped in numeric() — aggregates already return numbers and
 * numeric(<aggregate>) is illegal NRQL.
 */
import { Func, BinOp, Literal } from '../../ir/nodes.js';
import { walkEvalExpr } from './evalHandlers.js';
import { mapFunction } from './splExprUtils.js';
import { isFoldSafe, NRQL_AGG_FUNCS } from '../../ir/foldPostAggregation.js';

export function isNrqlAggregate(expr) {
  if (!expr) return false;
  if (expr.type === 'Function')
    return NRQL_AGG_FUNCS.has(expr.name) || expr.args.some(isNrqlAggregate);
  if (expr.type === 'BinOp')
    return isNrqlAggregate(expr.left) || isNrqlAggregate(expr.right);
  if (expr.type === 'Alias') return isNrqlAggregate(expr.expr);
  return false;
}

// IR expression, or null if any node is untranslatable in stats context
// (non-fold-safe function, string concat, comparison/boolean node).
export function walkStatsEvalExpr(node, ir) {
  if (!node) return null;
  // Bare atom: a numeric-literal token → Literal, a field name → Identifier.
  if (typeof node === 'string') return walkEvalExpr(node, ir);

  switch (node.type) {
    case 'StringLiteral':
      return Literal(node.value, 'string');
    case 'EvalParens':
      return walkStatsEvalExpr(node.inner, ir);
    case 'EvalArith': {
      if (node.op === '.') return null; // string concat is not fold-safe over an aggregate
      const left = walkStatsEvalExpr(node.left, ir);
      const right = walkStatsEvalExpr(node.right, ir);
      if (!left || !right) return null;
      return BinOp(node.op, left, right); // no numeric() wrap
    }
    case 'EvalFunc': {
      const lower = node.name.toLowerCase();
      if (isFoldSafe(lower)) {
        const args = node.args.map((a) => walkStatsEvalExpr(a, ir));
        if (args.some((a) => !a)) return null;
        return Func(lower, args);
      }
      // Aggregate? Route through the same mapper handleStats uses for normal fns.
      const { expr, warning } = mapFunction(node.name, node.args);
      if (expr && isNrqlAggregate(expr)) {
        if (warning) ir.warnings.push(warning);
        return expr;
      }
      return null; // non-fold-safe, non-aggregate (concat/lower/upper/numeric/mvjoin/…)
    }
    default:
      // EvalComparison / EvalBoolOp / EvalNot — not a numeric stats metric
      return null;
  }
}
```

- [ ] **Step 5: Wire it into `handleStats`.** In `src/input/spl/aggregationHandlers.js`, add the import and replace the Task-2 inert `fn.statsEval` branch body in `handleStats` with the translating version (leave `handleEventstats`'s guard as loud-unsupported):

```js
import { walkStatsEvalExpr, isNrqlAggregate } from './statsEvalHandlers.js';
import { Alias } from '../../ir/nodes.js'; // if not already imported
```

```js
    if (fn.statsEval) {
      const expr = walkStatsEvalExpr(fn.evalExpr, ir);
      if (!expr || !isNrqlAggregate(expr)) {
        // No aggregate (constant/row-wise), or a non-fold-safe function over one.
        ir.unsupported.push(messages.stats_eval_unsupported(fn.rawText));
        continue;
      }
      ir.select.push(fn.alias ? Alias(expr, fn.alias) : expr);
      continue;
    }
```

The `!isNrqlAggregate(expr)` guard enforces "≥1 aggregate": `eval(2*3)` walks to a constant `BinOp` with no aggregate → unsupported (the spec's conscious rejection of a renderable-but-degenerate constant metric).

- [ ] **Step 6: Run, confirm green; reconcile expected NRQL with the emitter.**

Run: `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "* | stats eval(sum(errors)*100/sum(reqs)) as rate"` (and the other three inputs). Copy the **exact** emitted NRQL into each case's `nrql` field (fix operator spacing / alias quoting to match the emitter). Then:
Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl`
Expected: all stats-eval cases (Task 2 + Task 3) PASS. Confirm the `upper(host)`/`eventstats`/`count(eval())` cases still behave as in Task 2 (unsupported / unsupported / unchanged).

- [ ] **Step 7: Whole-package + fuzz.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge` (no regressions), then `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check` (clean), then `for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done` (20 green).

- [ ] **Step 8: Staging validation.** Confirm the translatable outputs are valid, renderable NRQL via `nr-mcp-server` `execute_nrql_query` (account 1, `SINCE 30 minutes ago`) — substitute real fields if `CPU`/`errors` are absent (e.g. `numeric(<numericfield>)`). At minimum execute the emitted `SELECT sum(...)*100/sum(...) AS rate` and the `timechart … FACET … TIMESERIES` form; both must return rows, not a parse error. Promote validated cases to `verified: 'llm'`.

- [ ] **Step 9: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git commit -am "feat: translate bare eval() stats metric (aggregate arithmetic + fold-safe scalars)"
```

---

### Task 4: (Optional) Graduate the invariant

Run only once Tasks 1–3 are on master and staging-validated.

**Files:**
- Modify: `.claude/rules/design-decisions.md`
- Modify: the `known-issues-laundry-list` source (strike the `stats-eval-grammar` row)

- [ ] **Step 1: Add the invariant** under a relevant section of `.claude/rules/design-decisions.md`:

```markdown
- **Bare `eval()` as a stats/timechart function**: a bare `eval(<expr>)` in stats/timechart function position parses to `{statsEval:true, evalExpr, rawText, alias}` (grammar `stats_function`, the alternative before the generic `name(args)` form). `handleStats` translates it via `walkStatsEvalExpr` (`statsEvalHandlers.js`) — aggregate calls route through `mapFunction` (NOT `walkEvalExpr`, which is eval-context and rejects `avg()`), arithmetic/fold-safe scalars walked structurally, NO `numeric()` wrap. Faithful iff the result contains an NRQL aggregate (`isNrqlAggregate`); otherwise (no aggregate, or a non-fold-safe function over one) → `stats_eval_unsupported`. `count(eval(predicate))` is the DISTINCT `fn(eval())` form (`evalFilter` → `filter(count(*), …)`) and is unchanged. `eventstats` bare-`eval()` stays `unsupported`.
```

- [ ] **Step 2: Strike the laundry-list row** for `stats-eval-grammar` in its source file.

- [ ] **Step 3: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git commit -am "docs: graduate bare-eval stats-function invariant"
```

---

## Global Verification

- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm test` — full workspace suite green (translator baseline + new cases; importer package unaffected).
- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check` — clean.
- [ ] `splParser.js` is committed (regenerated by `build:parsers` in Task 2) — the generated parser must not be left uncommitted, or CI's no-uncommitted-changes gate fails.
- [ ] Fuzz ×20 green (`spl-fuzz`) — the grammar change is the risk surface.
- [ ] Staging (`nr-mcp-server`, acct 1, `SINCE 30 minutes ago`): the translatable outputs execute and return rows — `SELECT sum(...)*100/sum(...) AS 'rate'` and a `timechart … FACET … TIMESERIES` form.
- [ ] CLI spot-checks: `node bin/spl2nrql.js "* | timechart eval(avg(CPU)*avg(MEM)) by host span=5m"` (translates), `"* | stats eval(upper(host))"` (unsupported), `"* | stats count(eval(status>=500)) as errors"` (unchanged `filter(...)`).

## PR breakdown

The spec floated a single PR ("a grammar change with no handler is inert; splitting buys no isolation"). That argument is about splitting *grammar from handler* — it does not cover the wire-inert-then-activate split below, which DOES isolate (the loud-safe baseline ships and reviews independently of the faithful-translation logic, and each layer carries its own end-to-end tests). Recommended slicing — final choice is the author's:

1. **Loud-safe baseline** (Tasks 1 + 2; ~120 lines incl. generated parser) — message + grammar alternative + handler guards (`handleStats`, `handleEventstats`). Bare `eval()` becomes a precise `unsupported` instead of a silent `SELECT *` + false warning. Smallest shippable correctness win; reviewable on its own. Dependency: none (off `master`).
2. **Faithful translation** (Task 3; ~120 lines) — the `statsEvalHandlers.js` walk + `NRQL_AGG_FUNCS` export + `handleStats` upgrade + translatable cases + staging validation. Turns the loud-unsupported aggregate cases into real NRQL. Dependency: PR 1.
3. **(Optional) graduate** (Task 4; ~25 lines, docs) — graduate the invariant into `design-decisions.md`, strike the laundry-list row. Dependency: PR 2 + staging.

(If shipping as one PR per the spec, land Tasks 1→2→3 as the three commits above in order, then Task 4 separately.)

## Self-Review

1. **Spec coverage:** Problem (silent `SELECT *` + false warning) → Tasks 2/3 + verification. Approach A (grammar + stats-context walk via `mapFunction`, NOT `walkEvalExpr`) → Tasks 2/3. All five acceptance criteria → cases: `avg(CPU)*avg(MEM)` (T3), `round(avg(...))` (T3), `sum(errors)*100/sum(reqs)` (T3), `upper(host)` no-aggregate → unsupported (T2), `mvjoin(values(x),",")` non-fold-safe-over-aggregate → unsupported (T2), `count(eval())` regression (T2). Testing section (build:parsers, parser-as-cases, fuzz×20, staging) → all present.
2. **Placeholder scan:** no TBD/"handle edge cases"/"similar to"/uncoded steps — every code step shows the code, every command shows expected output. The one deliberate deferral (exact emitter NRQL formatting) is a marked verify-and-paste step (T3 Step 6), not a placeholder.
3. **Type consistency:** the parsed shape `{statsEval, evalExpr, rawText, alias, args}` is produced in T2 (grammar) and consumed in T2/T3 (handler) under the same names; `walkStatsEvalExpr(node, ir)` and `isNrqlAggregate(expr)` are defined in T3 and called with matching signatures; `NRQL_AGG_FUNCS`/`isFoldSafe`/`mapFunction` imports match their real exports (verified against source).

