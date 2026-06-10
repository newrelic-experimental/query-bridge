# Where-Clause Comparison RHS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let SPL `where field <op> <expr>` carry an arithmetic/function/field expression on the RHS — translating `_time` vs relative-time to NRQL `SINCE`/`UNTIL`, and every other comparison to a `BinOp` whose RHS is a walked eval expression, failing loud (`unsupported`) on anything with no valid NRQL form.

**Architecture:** One grammar change makes the comparison-operator RHS the `u_add` tier of the existing eval ladder (a new alternative before the bare `where_value` fallback; `u_add`, not the full `u_expr`, so boolean/comparison operators stay with the outer where-expression — see Task 1). The `Comparison` walker in `splToIR.js` gains a `rhsExpr` branch with three paths: time-window (`_time` + relative_time/now → `since`/`until`), non-`_time` relative-time (→ unsupported), and general expression (→ `BinOp` via the existing `walkEvalExpr`). No new IR nodes, no emitter change, no `parseSplTime` change.

**Tech Stack:** Pure ESM JavaScript (Node 24), Peggy PEG parser, Vitest. All commands require `ASDF_NODEJS_VERSION=24.14.0` prefix. Conventional commits, lowercase subject ≤72 chars.

**Spec:** `docs/superpowers/specs/2026-06-10-where-comparison-rhs-design.md`

---

## Critical Context for the Implementer

You know nothing about this codebase. Read this section before starting.

**The pipeline:** SPL → Peggy parser (`spl.grammar` → generated `splParser.js`) → AST → `splToIR.js` → IR → `optimize.js` → `irToNrql.js` → NRQL string.

**Two AST formats meet in the `where` pipe.** The `where` command grammar produces *search-expression* nodes (`Comparison`, `BooleanOp`, `FuncComparison`, `FunctionCall`) — these are walked by `translateSearchExpr`'s inner `walk()` function in `splToIR.js`. The `eval` command and the unified `u_expr` ladder produce *typed eval* nodes (`EvalArith`, `EvalComparison`, `EvalBoolOp`, `EvalNot`, `EvalFunc`, `EvalParens`, `StringLiteral`) — these are walked by `walkEvalExpr` in `evalHandlers.js`. This feature bridges them: the grammar attaches a typed eval node (`u_expr`) onto a search-expression `Comparison` node, and the walker calls `walkEvalExpr` on it.

**Grammar regeneration is required after every `.grammar` edit.** Run `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`. The generated `splParser.js` is git-excluded from lint but IS committed. A `.grammar` change has no effect until you rebuild.

**Peggy strips unused rules.** Adding a grammar rule that nothing references leaves the generated parser byte-identical. Don't be surprised if `build:parsers` produces no diff until the rule is actually wired in.

**Loud failure over silent wrong results** (project law). If a construct can't be translated correctly, push an `unsupported` message and return `null` — never emit guessed or non-compiling NRQL.

**`translateSearchExpr` data flow** (`splToIR.js:152`): it declares local `warnings`, `unsupported`, `since`, `until`; defines an inner `walk(node)`; and returns `{ expr, warnings, unsupported, since, until }`. The caller (`splToIR.js:76-85`) copies `since`/`until` onto `ir`. **Quirk to respect:** the caller has `if (until && !since) ir.since = '24 hours ago'` (line 84-85) — setting `until` without `since` triggers a spurious default `SINCE 24 hours ago`. The `_time < now()` case (Path 1) sets `until='now'` with no `since`, so this quirk WILL fire unless handled. See Task 5.

**The `Comparison` walker case** is at `splToIR.js:177`, inside `walk()`. It currently destructures `{ field, value, operator: op }` — note a `Comparison` node today always has `value` (a flat string). The new grammar alternative produces a `Comparison` with `rhsExpr` (a typed node) and NO `value`. The walker must branch on `rhsExpr` BEFORE touching `value` (which would be `undefined`).

**`walkEvalExpr(node, ir)`** (`evalHandlers.js:105`) already does numeric coercion for `EvalComparison` (lines 125-149): ordering ops wrap bare-field operands in `numeric()`, and `=`/`!=` with a numeric literal RHS emits a `DualCheck`. This is exactly the Path 2b behavior — so Path 2b largely delegates to it.

**This change reaches inside subsearches automatically.** Subsearch bodies (`[ search ... ]`) are captured as a raw string by the grammar, then RE-PARSED through the same parser by `enrichmentHandlers.js:32/102/130` (`parser.parse(normalizeSubsearch(cmd.subsearch))`). So the new `where_comparison` RHS rule applies inside subsearches on the re-parse — you do NOT need separate subsearch wiring. The subsearch gets its own `ir`, so a Path 1 `since`/`until` set inside a subsearch stays scoped to that subsearch (this is the behavior spec B depends on). Confirm with a regression test in Task 6 that a subsearch-internal comparison RHS translates correctly.

**Out of scope: `NOT` / `LIKE` / `IS NULL` are NOT affected.** `NOT` is handled one tier above `where_comparison` (in `where_not_expr`, `splToIR.js` grammar line 260), `LIKE` keeps its own untouched first alternative, and SPL `isnotnull()` is a function (via `where_function_call`), not a comparison RHS. SPL has no `IS NULL` infix operator (that's SQL/NRQL). The `u_add` RHS only governs the operand to the right of `=`/`!=`/`<`/`>`/`<=`/`>=` — none of these forms reach it. Do not add grammar for them.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/input/spl/spl.grammar` | PEG grammar | Add a `field op u_add` alternative to `where_comparison` (line 285-293), before the bare `where_value` alternative (`u_add`, not `u_expr` — see Task 1 for why) |
| `src/input/spl/splParser.js` | Generated parser | Regenerated via `npm run build:parsers` (do not hand-edit) |
| `src/input/spl/splToIR.js` | Search-expr → IR walker | Add `rhsExpr` branch to the `Comparison` case (line 177); Path 1 sets `since`/`until`, Path 2a/2b build/skip |
| `src/messages.js` | Message catalog | Add `where_rhs_*` unsupported/warning keys |
| `test/spl/spl.test.js` | Translation tests | Append `cases` entries (synthetic, `verified: false`) |

---

## Task 1: Grammar — add `u_add` RHS alternative to `where_comparison`

**Files:**
- Modify: `src/input/spl/spl.grammar:285-293`
- Then regenerate: `src/input/spl/splParser.js`

**Context:** `where_comparison` currently has two alternatives (line 285-293): a `like` form and a bare `field op where_value` form. We insert a NEW middle alternative that parses the RHS as **`u_add`** (NOT `u_expr`) and attaches it as `rhsExpr`.

**Why `u_add`, not `u_expr` (load-bearing):** the eval ladder is `u_expr → u_or → u_and → u_not → u_cmp → u_add → u_mul → u_unary → u_atom`. `u_expr` includes boolean `OR`/`AND` (`u_or`/`u_and`, lines 564-582) and a comparison tier (`u_cmp`, line 588). If the RHS were the full `u_expr`, then `where a > b AND c < d` would let the RHS greedily consume `b AND c < d` as a `u_and` — swallowing the `AND` that the OUTER `where_and_expr` (line 249) needs to split on, producing `a > (b AND (c < d))`. PEG is greedy and would take it. `u_add` is the highest tier that includes arithmetic, function calls, parens, literals, and bare fields but EXCLUDES comparison and boolean operators — so the outer `where_and_expr`/`where_or_expr` still split the top-level `AND`/`OR` before the RHS ever sees them. Use `u_add`.

Ordering is also load-bearing: the `u_add` alternative MUST come before the bare `where_value` alternative (so `where a > b + 1` parses structurally), and `where_value` MUST remain last (so odd barewords `u_add` rejects still parse). The `like` alternative stays first and untouched (LIKE RHS is literal-only — NRQL rejects a function there).

- [ ] **Step 1: Write the failing test**

Add to the `cases` array in `test/spl/spl.test.js` (near the other `where`/`_time` cases, e.g. after line 640):

```javascript
  {
    spl: 'index=web | where in_bytes > out_bytes',
    nrql: 'FROM Log SELECT * WHERE index = \'web\' AND numeric(in_bytes) > numeric(out_bytes)',
    doc: 'where-comparison-rhs',
    verified: false,
  },
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl -t "where in_bytes"`
Expected: FAIL. Today `where in_bytes > out_bytes` parses `out_bytes` as a flat `where_value` string, emitting `... > 'out_bytes'` (a string literal), not `numeric(out_bytes)`. The assertion on `numeric(out_bytes)` fails.

- [ ] **Step 3: Add the grammar alternative**

In `src/input/spl/spl.grammar`, change `where_comparison` (line 285-293) from:

```
where_comparison
  = field:field_name _+ 'like'i _+ value:where_value
    {
      return { type: 'Comparison', field: field, operator: 'like', value: value };
    }
  / field:field_name _* op:comparison_op _* value:where_value
    {
      return { type: 'Comparison', field: field, operator: op, value: value };
    }
```

to:

```
where_comparison
  = field:field_name _+ 'like'i _+ value:where_value
    {
      return { type: 'Comparison', field: field, operator: 'like', value: value };
    }
  / field:field_name _* op:comparison_op _* rhs:u_add
    {
      return { type: 'Comparison', field: field, operator: op, rhsExpr: rhs };
    }
  / field:field_name _* op:comparison_op _* value:where_value
    {
      return { type: 'Comparison', field: field, operator: op, value: value };
    }
```

- [ ] **Step 4: Regenerate the parser**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
Expected: `src/input/spl/splParser.js` is regenerated (diff present, since the new alternative is now reachable).

- [ ] **Step 5: Run the test, confirm it now reaches the walker but still fails correctly**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl -t "where in_bytes"`
Expected: STILL FAILS, but differently — the `Comparison` node now has `rhsExpr` (an `Identifier`-leaf `'out_bytes'` typed node) and NO `value`. The walker's `Comparison` case destructures `value` (now `undefined`) and downstream code (`value.includes`) throws or emits wrong output. This proves the grammar half works; Task 2 wires the walker. (If it throws, that's expected — Task 2 fixes it.)

- [ ] **Step 6: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/input/spl/spl.grammar src/input/spl/splParser.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: parse expr on where comparison rhs"
```

---

## Task 2: Walker — Path 2b (general expression RHS → BinOp)

**Files:**
- Modify: `src/input/spl/splToIR.js:177` (the `Comparison` case)
- Test: `test/spl/spl.test.js`

**Context:** The `Comparison` case currently assumes `value` exists. Add an early branch: if `node.rhsExpr` is present, handle the new typed-node RHS and return; otherwise fall through to the existing `value`-based code unchanged. Path 2b is the common case (field / arithmetic / ordinary function RHS): delegate to `walkEvalExpr`, which already does the numeric coercion and loud-failure. We implement 2b first (it's the bulk); Paths 1 and 2a come in Tasks 3-5.

`walkEvalExpr` is already imported in `splToIR.js` (used by `FuncComparison` at line 251). Confirm the import exists at the top of the file before relying on it.

- [ ] **Step 1: Write the failing tests**

The Task 1 test (`where in_bytes > out_bytes`) is the primary 2b case. Add two more to `cases`:

```javascript
  {
    spl: 'index=web | where a > b + 1',
    nrql: 'FROM Log SELECT * WHERE index = \'web\' AND numeric(a) > numeric(b) + 1',
    doc: 'where-comparison-rhs',
    verified: false,
  },
  {
    spl: 'index=web | where bytes > round(total / 100, 2)',
    nrql: 'FROM Log SELECT * WHERE index = \'web\' AND numeric(bytes) > round(numeric(total) / 100, 2)',
    doc: 'where-comparison-rhs',
    verified: false,
  },
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl -t "where-comparison-rhs"`
Expected: FAIL (walker doesn't handle `rhsExpr` yet — throws or wrong output).

- [ ] **Step 3: Add the `rhsExpr` branch (Path 2b only for now)**

In `src/input/spl/splToIR.js`, at the very top of the `case 'Comparison':` block (line 178, before the existing `let { field, value, operator: op } = node;`), insert:

```javascript
      case 'Comparison': {
        // New typed-node RHS (grammar `field op u_add`). Branch before the
        // legacy flat-`value` path, which assumes `value` is a string.
        if (node.rhsExpr) {
          const op = node.operator;
          const field = node.field;
          // Path 2b: general expression RHS → BinOp via the eval walker.
          // walkEvalExpr handles numeric coercion + loud failure. Reuse the
          // EvalComparison numeric semantics by building an EvalComparison node
          // and walking it: the LHS field is wrapped in numeric() for ordering
          // ops exactly as the RHS is.
          const cmpNode = {
            type: 'EvalComparison',
            op,
            left: field === '_time' ? '_time' : field,
            right: node.rhsExpr,
          };
          const expr = walkEvalExpr(cmpNode, ir);
          if (!expr) return null; // walker already pushed unsupported
          return expr;
        }

        let { field, value, operator: op } = node;
```

(Leave the rest of the `Comparison` case exactly as-is below this insertion.)

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl -t "where-comparison-rhs"`
Expected: PASS for `in_bytes > out_bytes`, `a > b + 1`, `bytes > round(...)`. `walkEvalExpr`'s `EvalComparison` case wraps both bare-field sides in `numeric()` under `>` and walks the arithmetic/function RHS.

If the `round` case's exact output differs (e.g. coercion of the inner `total`), capture the ACTUAL emitted NRQL via `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "index=web | where bytes > round(total / 100, 2)"` and update the expected `nrql` to match — the test asserts real output, not an idealized form.

- [ ] **Step 5: Run the full spl suite, confirm no regression**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: PASS. Existing plain-value comparisons (`where status > 200`), `like`, and `FuncComparison` cases are untouched (they have `value`, not `rhsExpr`).

- [ ] **Step 6: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/input/spl/splToIR.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: translate where comparison rhs expr to binop"
```

---

## Task 3: Forward `since`/`until` from the `where` pipe

**Files:**
- Modify: `src/input/spl/evalHandlers.js:53-65` (`translateWhereExpr`)
- Test: `test/spl/spl.test.js`

**Context (a real pre-existing bug this feature exposes):** `translateSearchExpr` returns `{ expr, warnings, unsupported, since, until }`. The leading-search caller (`splToIR.js:76-85`) reads `since`/`until` and copies them to `ir`. But `translateWhereExpr` (`evalHandlers.js:59`), which handles the `| where ...` PIPE command, destructures only `{ expr, warnings, unsupported }` — it DROPS `since`/`until`. Path 1 (Task 4) sets `since`/`until` and returns a null expr; if the constraint comes from a `| where _time ...` pipe, those values must reach `ir` or the time window is silently lost. Fix the forwarding here so Task 4's Path 1 works regardless of whether `_time` appears in the leading search or a `where` pipe.

- [ ] **Step 1: Write the failing test**

This test depends on Path 1 (Task 4), so it will fail for a different reason until Task 4 lands. Add it now to lock the end-to-end behavior:

```javascript
  {
    spl: 'index=web | where _time > relative_time(now(), "-7d")',
    nrql: 'FROM Log SELECT * WHERE index = \'web\' SINCE 7 days ago',
    doc: 'where-comparison-rhs',
    verified: false,
  },
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl -t "_time > relative_time"`
Expected: FAIL (Path 1 not implemented yet, and `since` not forwarded).

- [ ] **Step 3: Forward since/until in translateWhereExpr**

In `src/input/spl/evalHandlers.js`, change `translateWhereExpr` (line 59-62) from:

```javascript
  const { expr: irExpr, warnings, unsupported } = translateSearchExpr(expr, ir);
  ir.warnings.push(...warnings);
  ir.unsupported.push(...unsupported);
  if (irExpr) return irExpr;
```

to:

```javascript
  const { expr: irExpr, warnings, unsupported, since, until } =
    translateSearchExpr(expr, ir);
  ir.warnings.push(...warnings);
  ir.unsupported.push(...unsupported);
  // A `where _time ...` constraint becomes a SINCE/UNTIL clause, not a WHERE
  // term. translateSearchExpr surfaces it as since/until; copy to ir here
  // (the leading-search caller does the same at splToIR.js:81-82).
  if (since) ir.since = since;
  if (until) ir.until = until;
  if (until && !since && !ir.since) {
    ir.since = '24 hours ago';
  }
  if (irExpr) return irExpr;
```

- [ ] **Step 4: Run the full spl suite, confirm no regression**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: PASS (the new `_time > relative_time` test still fails — Path 1 pending — but nothing else regresses; forwarding is inert until Path 1 sets since/until).

- [ ] **Step 5: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/input/spl/evalHandlers.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "fix: forward since/until from where pipe to ir"
```

---

## Task 4: Walker — Path 1 (time-window: `_time` vs relative_time/now → SINCE/UNTIL)

**Files:**
- Modify: `src/input/spl/splToIR.js` (the `rhsExpr` branch added in Task 2)
- Modify: `src/messages.js` (new message keys)
- Test: `test/spl/spl.test.js`

**Context:** Now intercept the `_time` time-window case BEFORE Path 2b. After Task 1's grammar change, `where _time > relative_time(now(), "-7d")` parses the RHS as a typed `EvalFunc` node: `{ type: 'EvalFunc', name: 'relative_time', args: [ { type: 'EvalFunc', name: 'now', args: [] }, { type: 'StringLiteral', value: '-7d' } ] }`. And `where _time < now()` parses RHS as `{ type: 'EvalFunc', name: 'now', args: [] }`.

Path 1 fires when `node.field === '_time'` AND `node.rhsExpr` is an `EvalFunc` named `relative_time` or `now`. It sets the closure-scoped `since`/`until` vars (which Task 3 now forwards) and returns null (no WHERE term). `parseSplTime` is imported in `splToIR.js:18`.

Operator → bound: `>`/`>=` is a LOWER bound → `since`; `<`/`<=` is an UPPER bound → `until`.

- [ ] **Step 1: Write the failing tests**

The Task 3 test (`_time > relative_time(now(), "-7d")` → `SINCE 7 days ago`) is the primary case. Add the `<` and `now()` variants:

```javascript
  {
    spl: 'index=web | where _time < relative_time(now(), "-1d")',
    nrql: 'FROM Log SELECT * WHERE index = \'web\' SINCE 24 hours ago UNTIL 1 day ago',
    doc: 'where-comparison-rhs',
    verified: false,
  },
  {
    spl: 'index=web | where _time < now()',
    nrql: 'FROM Log SELECT * WHERE index = \'web\' UNTIL now',
    doc: 'where-comparison-rhs',
    verified: false,
  },
```

Note the `< relative_time` case: `until='1 day ago'` with no `since` triggers the default-SINCE quirk (Task 3 sets `ir.since='24 hours ago'`). Capture actual output and adjust if the default differs.

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl -t "where-comparison-rhs"`
Expected: the three `_time` cases FAIL (Path 1 not implemented — they currently hit Path 2b and emit a `numeric(timestamp) > ...` BinOp instead of a SINCE/UNTIL clause).

- [ ] **Step 3: Add message keys**

In `src/messages.js`, add near the other where-related messages:

```javascript
  // SPL: `| where _time >= now()`
  where_time_future_bound_unsupported: () =>
    'where _time >= now() (lower bound at/after present) matches no historical events; NRQL SINCE now does not compile',

  // SPL: `| where _time = now()`
  where_time_point_unsupported: () =>
    'where _time = now() (point-in-time, matches nothing) / != now() (degenerate no-op) has no NRQL SINCE/UNTIL equivalent',

  // SPL: `| where _time > relative_time(eventField, "-1d")`
  where_relative_time_nonliteral_unsupported: () =>
    'relative_time() with a non-now() anchor is a per-event value, not a static SINCE/UNTIL bound',

  // SPL: `| where _time > relative_time(now(), "-7d")` when earliest=/latest= already set
  where_time_constraints_collapsed: () =>
    'multiple time constraints collapsed into one SINCE/UNTIL (last-writer-wins)',
```

- [ ] **Step 4: Add Path 1 to the rhsExpr branch**

In `src/input/spl/splToIR.js`, inside the `if (node.rhsExpr) { ... }` block from Task 2, insert Path 1 BEFORE the Path 2b code:

```javascript
        if (node.rhsExpr) {
          const op = node.operator;
          const field = node.field;
          const rhs = node.rhsExpr;

          // Path 1: time-window. `_time` vs relative_time()/now() → SINCE/UNTIL.
          const isFunc = rhs && typeof rhs === 'object' && rhs.type === 'EvalFunc';
          const fnName = isFunc ? rhs.name.toLowerCase() : null;
          if (field === '_time' && (fnName === 'relative_time' || fnName === 'now')) {
            // Determine bound from operator: >/>= lower (since), </<= upper (until).
            const isLower = op === '>' || op === '>=';
            const isUpper = op === '<' || op === '<=';

            // now() RHS
            if (fnName === 'now') {
              if (isUpper) {
                if (since || until) warnings.push(messages.where_time_constraints_collapsed());
                until = 'now';
                return null;
              }
              // >/>= now() → future lower bound (no matches), or =/!= → point-in-time
              if (isLower) {
                unsupported.push(messages.where_time_future_bound_unsupported());
              } else {
                unsupported.push(messages.where_time_point_unsupported());
              }
              return null;
            }

            // relative_time(now(), "<offset>")
            const [anchor, offsetNode] = rhs.args;
            const anchorIsNow =
              anchor && typeof anchor === 'object' &&
              anchor.type === 'EvalFunc' && anchor.name.toLowerCase() === 'now';
            const offset =
              offsetNode && typeof offsetNode === 'object' &&
              offsetNode.type === 'StringLiteral' ? offsetNode.value : null;
            if (!anchorIsNow || offset === null) {
              unsupported.push(messages.where_relative_time_nonliteral_unsupported());
              return null;
            }
            const { nrql, warning } = parseSplTime(offset);
            if (warning) warnings.push(warning);
            if (!nrql) {
              unsupported.push(messages.where_relative_time_nonliteral_unsupported());
              return null;
            }
            if ((isLower && since) || (isUpper && until)) {
              warnings.push(messages.where_time_constraints_collapsed());
            }
            if (isLower) since = nrql;
            else if (isUpper) until = nrql;
            else {
              unsupported.push(messages.where_time_point_unsupported());
            }
            return null;
          }

          // Path 2b: general expression RHS → BinOp via the eval walker.
          const cmpNode = {
            type: 'EvalComparison',
            op,
            left: field === '_time' ? '_time' : field,
            right: rhs,
          };
          const expr = walkEvalExpr(cmpNode, ir);
          if (!expr) return null;
          return expr;
        }
```

(This REPLACES the Task 2 version of the `if (node.rhsExpr)` block — it now contains Path 1 then Path 2b. Path 2a is added in Task 5.)

- [ ] **Step 5: Run the tests, confirm they pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl -t "where-comparison-rhs"`
Expected: PASS for the `_time` time-window cases. Capture actual output via `node bin/spl2nrql.js` for any mismatch and align the expected `nrql`.

- [ ] **Step 6: Run the full spl suite**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/input/spl/splToIR.js src/messages.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: translate where _time relative-time to since/until"
```

---

## Task 5: Walker — Path 2a (non-`_time` vs now()/relative_time → unsupported)

**Files:**
- Modify: `src/input/spl/splToIR.js` (the `rhsExpr` branch)
- Modify: `src/messages.js`
- Test: `test/spl/spl.test.js`

**Context:** A non-`_time` field compared to `now()` or `relative_time(...)` (e.g. `where created < now()`) has no valid inline NRQL form — `now()` is rejected everywhere in WHERE (verified in the spec). Without this guard, such a query falls into Path 2b and emits `numeric(created) < now()`, which NRQL rejects at parse time (`Not supported: Call now`) — non-compiling output, violating loud-failure. Path 2a catches it between Path 1 and Path 2b.

- [ ] **Step 1: Write the failing test**

```javascript
  {
    spl: 'index=web | where created < now()',
    unsupportedIncludes: 'now()',
    doc: 'where-comparison-rhs',
    verified: false,
  },
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl -t "created < now"`
Expected: FAIL — currently falls into Path 2b and emits a `BinOp` with `now()` (no unsupported message).

- [ ] **Step 3: Add the message key**

In `src/messages.js`, add:

```javascript
  // SPL: `| where created < now()`
  where_nontime_relative_unsupported: () =>
    'comparison of a non-_time field against now()/relative_time() has no NRQL equivalent (now() is rejected in WHERE)',
```

- [ ] **Step 4: Add Path 2a between Path 1 and Path 2b**

In `src/input/spl/splToIR.js`, in the `if (node.rhsExpr) { ... }` block, AFTER the Path 1 block (which returns for `field === '_time'`) and BEFORE the Path 2b `cmpNode` construction, insert:

```javascript
          // Path 2a: non-_time field vs now()/relative_time → unsupported.
          // (Path 1 already returned for _time; here field !== '_time'.)
          if (fnName === 'now' || fnName === 'relative_time') {
            unsupported.push(messages.where_nontime_relative_unsupported());
            return null;
          }
```

(`fnName` is already computed in the Path 1 code from Task 4.)

- [ ] **Step 5: Run the test, confirm it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl -t "created < now"`
Expected: PASS — `unsupportedIncludes: 'now()'` matches.

- [ ] **Step 6: Run the full spl suite**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/input/spl/splToIR.js src/messages.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: reject non-_time relative-time comparison rhs"
```

---

## Task 6: Gate unimplemented row-wise NRQL functions to `unsupported` (was FIXME #8)

**Files:**
- Modify: `src/input/spl/splToIR.js` (the Path 2b branch from Tasks 2/4)
- Modify: `src/messages.js`
- Test: `test/spl/spl.test.js`

**Context (verified 2026-06-10 via MCP):** Some documented NRQL functions are NOT implemented in NRQL's row-wise (per-event) evaluator: `jparse`, `convert`, `cidrAddress`, `toTimestamp`, `toDatetime`, `decode`, `encode`, `mapKeys`, `mapValues`, `lookup`, `blob`. NRQL rejects them on a comparison RHS with `Not supported: Call <fn>` — e.g. `WHERE numeric(bytes) > jparse(message, 'a')` → `Not supported: Call jparse` (confirmed). The eval walker (`evalHandlers.js`) emits these as `Func('jparse', ...)` etc. by their NRQL names. Without a gate, Path 2b would emit non-compiling NRQL — violating the project's loud-failure law (CLAUDE.md Goal #5). This feature is the first to route arbitrary eval functions onto a where-RHS, so it must gate them.

The gate inspects the IR expression `walkEvalExpr` returns and recursively checks for any `Function` node whose `name` is in the unimplemented set (a `jparse` can be nested as an arg to a supported fn, e.g. `round(convert(...))`). `Func` nodes have shape `{ type: 'Function', name, args }` (`src/ir/nodes.js:19`).

**Scope note:** this gate guards the NEW where-RHS path only (Path 2b). Do NOT change how these functions translate elsewhere (eval bindings, SELECT) — that broader gating is a separate concern. Only the RHS-of-a-comparison position is fixed here.

- [ ] **Step 1: Write the failing test**

```javascript
  {
    spl: 'index=web | where bytes > jparse(payload, "size")',
    unsupportedIncludes: 'not supported on a comparison',
    doc: 'where-comparison-rhs',
    verified: false,
  },
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl -t "jparse(payload"`
Expected: FAIL — Path 2b currently emits `numeric(bytes) > jparse(message, 'size')` (a BinOp) with no unsupported message; the emitted NRQL would not compile.

- [ ] **Step 3: Add the message key**

In `src/messages.js`, add:

```javascript
  // SPL: `| where bytes > jparse(payload, "size")`
  where_rhs_func_not_row_wise: (name) =>
    `${name}() is not supported on a comparison right-hand side; NRQL does not implement it in the row-wise evaluator`,
```

- [ ] **Step 4: Add the gate to Path 2b**

In `src/input/spl/splToIR.js`, define a module-level constant and helper near the top of the file (after the imports), if not already present:

```javascript
// NRQL functions NOT implemented in the row-wise (per-event) evaluator. They
// compile in some aggregation contexts but fail `Not supported: Call <fn>` on a
// WHERE comparison RHS. Verified via MCP 2026-06-10.
const ROW_WISE_UNIMPLEMENTED = new Set([
  'jparse', 'convert', 'cidrAddress', 'toTimestamp', 'toDatetime',
  'decode', 'encode', 'mapKeys', 'mapValues', 'lookup', 'blob',
]);

// Find the first unimplemented-on-RHS NRQL function name anywhere in an IR
// expression tree, or null if none. Recurses into Function args and BinOp sides.
function findUnimplementedRhsFunc(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'Function') {
    if (ROW_WISE_UNIMPLEMENTED.has(node.name)) return node.name;
    for (const a of node.args || []) {
      const hit = findUnimplementedRhsFunc(a);
      if (hit) return hit;
    }
    return null;
  }
  // BinOp / other nodes with left/right/args children
  for (const key of ['left', 'right', 'operand', 'inner']) {
    if (node[key]) {
      const hit = findUnimplementedRhsFunc(node[key]);
      if (hit) return hit;
    }
  }
  for (const a of node.args || []) {
    const hit = findUnimplementedRhsFunc(a);
    if (hit) return hit;
  }
  return null;
}
```

Then in the Path 2b code (the `cmpNode` block from Task 2/4), after `walkEvalExpr` returns a non-null `expr`, gate on the RHS only. Change:

```javascript
          const expr = walkEvalExpr(cmpNode, ir);
          if (!expr) return null;
          return expr;
```

to:

```javascript
          const expr = walkEvalExpr(cmpNode, ir);
          if (!expr) return null;
          // Gate: the RHS must not contain a function NRQL can't evaluate row-wise.
          // Walk the RHS subtree (node.rhsExpr was walked into expr.right for a
          // BinOp; check the whole expr to catch nesting).
          const badFn = findUnimplementedRhsFunc(expr);
          if (badFn) {
            unsupported.push(messages.where_rhs_func_not_row_wise(badFn));
            return null;
          }
          return expr;
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl -t "jparse(payload"`
Expected: PASS — `unsupportedIncludes: 'not supported on a comparison'` matches.

- [ ] **Step 6: Verify a supported function still works (no over-gating)**

Add and run:

```javascript
  {
    spl: 'index=web | where bytes > round(total / 100, 2)',
    nrql: 'CAPTURE_ACTUAL_VIA_CLI',
    doc: 'where-comparison-rhs',
    verified: false,
  },
```

Run `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "index=web | where bytes > round(total / 100, 2)"`, set the expected `nrql`, and confirm `round` is NOT gated (it's row-wise — passes). This case may duplicate the Task 2 `round` case; if so, skip adding a duplicate and just confirm Task 2's case still passes.

- [ ] **Step 7: Run the full spl suite**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: PASS. The gate fires only for the unimplemented set; everything else is untouched.

- [ ] **Step 8: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/input/spl/splToIR.js src/messages.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: reject row-wise-unimplemented funcs on where rhs"
```

---

## Task 7: Regression & unsupported-case coverage

**Files:**
- Test: `test/spl/spl.test.js`

**Context:** The RHS widening touches EVERY `where field op X`. This task adds the regression cases the spec's Testing section requires, plus the remaining unsupported cases (FIXME #1/#3). No production code changes — if any of these fail, the bug is in Tasks 1-6 and must be fixed there, not by weakening the test.

- [ ] **Step 1: Add regression cases (these must already pass)**

```javascript
  {
    spl: 'index=web status > 200',
    nrql: 'FROM Log SELECT * WHERE index = \'web\' AND numeric(status) > 200',
    doc: 'where-comparison-rhs',
    verified: false,
  },
  {
    spl: 'index=web | where status = foo',
    nrql: 'FROM Log SELECT * WHERE index = \'web\' AND status = \'foo\'',
    doc: 'where-comparison-rhs',
    verified: false,
  },
  {
    // Regression: function-on-LEFT (where_func_comparison) is a SEPARATE grammar
    // rule and does NOT use the new rhsExpr path (the RHS `1` is a where_value).
    // mvcount maps to length() and fires eval_length_warning — actual output below.
    spl: 'index=web | where mvcount(tags) > 1',
    nrql: 'FROM Log SELECT * WHERE index = \'web\' AND numeric(length(tags)) > 1',
    warningFunc: ['eval_length_warning'],
    doc: 'where-comparison-rhs',
    verified: false,
  },
  {
    spl: 'index=web | where a > b AND c < d',
    nrql: 'FROM Log SELECT * WHERE index = \'web\' AND numeric(a) > numeric(b) AND numeric(c) < numeric(d)',
    doc: 'where-comparison-rhs',
    verified: false,
  },
  {
    // Subsearch re-parse: the where-RHS rule applies inside `[ ... ]` because
    // the subsearch body is re-parsed through the same grammar. Capture actual
    // output via bin/spl2nrql.js and align — the exact subsearch emission shape
    // (JOIN vs IN vs inline) is set by enrichmentHandlers, not this feature.
    spl: 'index=web [ search in_bytes > out_bytes ]',
    nrql: 'CAPTURE_ACTUAL_VIA_CLI',
    doc: 'where-comparison-rhs',
    verified: false,
  },
```

**For the subsearch case:** run `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "index=web [ search in_bytes > out_bytes ]"` and replace `CAPTURE_ACTUAL_VIA_CLI` with the real output. The point of the test is that `in_bytes > out_bytes` inside the brackets gets the SAME `numeric(in_bytes) > numeric(out_bytes)` treatment as it does at top level (proving the re-parse picks up the new RHS rule), NOT to pin the subsearch wrapping shape. If the subsearch path emits `unsupported` for an unrelated reason, downgrade this to a `node bin/spl2nrql.js` manual check noted in the task and move on — do not block on subsearch wrapping mechanics.

For each, capture the ACTUAL output via `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "<spl>"` and set the expected `nrql` to match real output. The `mvcount` case verifies `where_func_comparison` (function-on-LEFT) still works; the `status = foo` case verifies the bare-`where_value` fallback still fires; the `a > b AND c < d` case verifies the RHS `u_add` does NOT swallow the outer `AND` (spec risk #4 — `u_add` has no boolean tier, so `where_and_expr` splits the top-level AND before each RHS sees it). If this case emits `a > (b AND ...)`, the RHS tier is wrong (it's `u_expr`/`u_and`, not `u_add`) — fix the grammar in Task 1.

- [ ] **Step 2: Add unsupported FIXME cases**

```javascript
  {
    spl: 'index=web | where _time >= now()',
    unsupportedIncludes: 'matches no historical events',
    doc: 'where-comparison-rhs',
    verified: false,
  },
  {
    spl: 'index=web | where _time = now()',
    unsupportedIncludes: 'point-in-time',
    doc: 'where-comparison-rhs',
    verified: false,
  },
  {
    spl: 'index=web | where _time > relative_time(eventField, "-1d")',
    unsupportedIncludes: 'per-event value',
    doc: 'where-comparison-rhs',
    verified: false,
  },
```

- [ ] **Step 3: Run all new cases**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl -t "where-comparison-rhs"`
Expected: PASS. If a regression case fails, FIX the production code in Tasks 1-6 — do not edit the assertion to match buggy output.

- [ ] **Step 4: Adjust message-assertion exhaustiveness**

The test runner asserts `warningFunc`/`unsupportedFunc` exhaustively (every fired message must be listed; no unlisted message may fire). If any case fires a warning/unsupported not captured by `unsupportedIncludes`, the runner will flag it. Add the appropriate `unsupportedFunc`/`warningFunc` arrays per the failure output. Example for the collapsed-constraint case (if you added one):

```javascript
  {
    spl: 'index=web earliest=-7d | where _time > relative_time(now(), "-1d")',
    warningFunc: ['where_time_constraints_collapsed'],
    doc: 'where-comparison-rhs',
    verified: false,
  },
```

- [ ] **Step 5: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "test: cover where comparison rhs regression and unsupported cases"
```

---

## Task 8: Lint, types, and final verification

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run lint`
Expected: clean. Fix any issues in the files you touched.

- [ ] **Step 2: Type check**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run types:check`
Expected: clean. The `cmpNode` object literal must satisfy the eval-node shape; if checkJs complains, ensure `op`/`left`/`right` match what `walkEvalExpr`'s `EvalComparison` case reads.

- [ ] **Step 3: Full test suite**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: PASS, `threw` stays 0.

- [ ] **Step 4: Corpus gate (run from the sibling corpus repo)**

The 32k-query corpus lives in `../nr-query-bridge-corpus`. Run its diagnostic to confirm the parse-error bucket falls and `clean` does not regress:

```bash
cd ../nr-query-bridge-corpus && ASDF_NODEJS_VERSION=24.14.0 node corpus-diagnostic.mjs
```

Expected: the parse-error bucket drops (target: the ~196 `relative_time(` queries + field/arithmetic/function-RHS comparisons that previously failed to parse); `threw` stays 0; `clean` must NOT fall; no command bucket regresses. If `clean` falls or a bucket regresses, investigate before proceeding — a `where` comparison that previously emitted clean plain-value NRQL must still do so (the `where_value` fallback guarantees this; a regression means the `u_add` alternative is mis-ordered or over-matching).

- [ ] **Step 5: No commit** (verification only). Report results to the controller.

---

## Self-Review (run after writing, before handoff)

- **Spec coverage:** Grammar change (Task 1) ✓; Path 1 time-window (Task 4) ✓; Path 2a non-_time relative (Task 5) ✓; Path 2b general expr (Task 2) ✓; LIKE/RLIKE/IN untouched (no grammar change to those alternatives) ✓; since/until forwarding from where pipe (Task 3) ✓; FIXME #1/#3 unsupported cases (Task 6) ✓; corpus gate (Task 7) ✓. FIXME #8 (row-wise-unimplemented NRQL functions) is explicitly NOT a blocker per the spec — left as pre-existing behavior, not addressed here.
- **Type consistency:** `rhsExpr` key name is consistent across grammar (Task 1), walker branch (Tasks 2/4/5/6). `cmpNode` shape (`{type:'EvalComparison', op, left, right}`) matches `walkEvalExpr`'s `EvalComparison` reader (`node.op`, `node.left`, `node.right`). `Func` node shape `{type:'Function', name, args}` (Task 6 gate) matches `src/ir/nodes.js:19`. Message keys (`where_time_future_bound_unsupported`, `where_time_point_unsupported`, `where_relative_time_nonliteral_unsupported`, `where_time_constraints_collapsed`, `where_nontime_relative_unsupported`, `where_rhs_func_not_row_wise`) are defined in Tasks 4/5/6 before use.
- **FIXME #8 resolved:** the spec's deferred FIXME #8 (non-compiling output for row-wise-unimplemented NRQL functions) is now implemented as Task 6 per expert review — gated to `unsupported` in the walker. Verified via MCP: `> jparse(...)` → `Not supported: Call jparse`.
- **Placeholder scan:** no TBD/TODO; every code step shows real code; expected NRQL strings are marked "capture actual via bin/spl2nrql.js and align" where the precise coercion form is uncertain (the test asserts real output, so this is honest, not a placeholder).

---

## Execution Log (filled in during subagent-driven execution, 2026-06-10)

Durable record of every deviation from the written plan, edge case, and finding discovered while executing. Read this before the final whole-branch review. Commits are on `eval/parse-error-burndown`.

### Commits
- `4be2d59` Task 1a — grammar `field op u_add` rhsExpr alternative + first test (BROAD; superseded by 59cbed3)
- `59cbed3` Task 1b — narrowed: `&{}` predicate so lone literals backtrack to `where_value`
- `0499cf2` Task 2 — Path 2b general-expr RHS → BinOp via walkEvalExpr (+ leftLooksNumeric sub-branch)
- `cd07e1e` Task 3 — forward since/until from where pipe (translateWhereExpr)
- `5756000` Task 4 — Path 1 `_time` relative-time → SINCE/UNTIL (+ 4 message keys, + evalHandlers fallback guard #1)
- `8e0ae42` Task 5 — Path 2a non-_time relative-time → unsupported (+ message key, + evalHandlers fallback guard #2)
- `f699035` Task 6 — gate row-wise-unimplemented funcs on RHS (AST-pre-walk)
- `f846304` Task 7 — regression + unsupported test coverage
- `11fce3e` Task 7 follow-up — where-in-subsearch re-parse proof + reversed-operand loud-fail lock-in (+ comment fix on status=foo)
- `4aa009e` docs — mark findings #6/#7 resolved

### Task 8 — verification gate (PASSED, 2026-06-10)
- **lint:** clean. **types:check (tsc --noEmit):** clean. **Full test suite:** 678 passed, 6 skipped, 0 failures (7 files).
- **Corpus gate (32436 queries, before `4c6a832` vs after `4aa009e`, identical corpus):**

  | bucket | pre | post | delta |
  |---|---|---|---|
  | clean | 11413 | 11417 | +4 (did NOT regress) |
  | warningsOnly | 10481 | 10486 | +5 |
  | unsupported | 7937 | 7984 | +47 (intended loud-failures) |
  | errors (parse) | 2605 | 2549 | **−56** (parse errors fell) |
  | thrown | 0 | 0 | **0** (invariant holds) |

  Math reconciles: −56 parse errors → +4 clean, +5 warningsOnly, +47 unsupported. Every formerly-erroring query moved to a BETTER terminal state; none regressed. The `where`-attributed error bucket dropped to 36 (spec cited ~196 `relative_time(` errors pre-feature). Loud-failure increase (+47 unsupported) is the feature correctly converting non-`_time` relative-time, row-wise-unimplemented funcs, and future-bound `_time` into honest `unsupported` rather than parse-error or silent-wrong. Gate PASSES on all plan criteria: parse-errors fall, clean does not fall, no bucket regresses, threw stays 0.

  **Audit of the +47 net unsupported (49 in, 2 out — verified query-by-query against pre-feature `4c6a832`):** All 49 queries that flipped TO unsupported were `errors` (parse failures) pre-feature — ZERO came from clean/warningsOnly, so nothing that worked got downgraded. They now parse past the `where _time > relative_time(...)`/expr-RHS clause and fail loud at their REAL downstream blocker. Breakdown by reason: `lookup` (13), `strptime()` (7), wildcard rename (6), `strftime()` (4), `mvjoin()` (4), `timechart` (3), eval-subsearch (2), `trendline` (2), and 1 each of `transaction`/`spath`-no-path/`searchmatch()`/`relative_time()`-in-eval/`streamstats`/`makemv`/`metadata`. Only **1** is from THIS feature's new guards (Path 2a non-`_time` vs now()/relative_time). The rest are pre-existing unsupported constructs now surfaced with a PRECISE message instead of an opaque parse error — strictly better diagnostics.
  - **One unsupported→errors move (the only "worse" flip):** a single malformed query (`ABELSON_REVERSED`...) containing literal triple-backtick ``` ``` ``` inline-comment fences around a `| where ... AND ...` line. Pre-feature the loose `where_value` accidentally tolerated it to an unsupported verdict; post-feature the more-structured `u_add` RHS parse reaches the stray backtick and rejects (`Failed to parse ... "`" found`). Root cause is the triple-backtick corpus junk (see spl-reference "Triple backticks = inline comments — strip them"), not the RHS feature. Both states are LOUD failures (no wrong NRQL); this is unsupported→error within loud-fail, on 1 of 32436 malformed queries. Not fixing — would be over-engineering for corpus junk.

### Deviations from the written plan (all verified sound unless flagged OPEN)
1. **Task 1 narrowed (user decision).** Plan routed ALL RHS (incl. lone literals) through `rhsExpr`; that broke 21 existing literal-RHS cases (`u_add` matches numbers/strings too). User chose to NARROW: a `&{}` semantic predicate backtracks lone numbers (`/^[0-9]/` plain string) and lone `StringLiteral` objects to the unchanged `where_value` path. Only non-literal RHS (field/func/arith/parens) routes through `rhsExpr`. Preserves every existing literal contract by construction.
2. **Task 2 added a `leftLooksNumeric` reversed-operand sub-branch** not in the plan. The narrowed grammar moved `.25 > count` (bare-field RHS) onto the rhsExpr path, but the legacy reversed-operand handling (LHS numeric literal) lived only on the `value` path. The sub-branch is a faithful port of legacy splToIR lines 219-227. Mild DRY duplication with the legacy block — acceptable; both live in the same `case`. NOT extracted to a helper (premature given the branch is still evolving).
3. **`round(x, 2)` → `round(x, 0.01)` is CORRECT, not a bug.** evalHandlers.js:285-299 deliberately maps SPL "N decimal places" to NRQL "nearest multiple of 10^-N". The Task 2 implementer mislabeled it a mismatch; verified it's settled intentional behavior. Test asserts `0.01` correctly.
4. **Task 4 + Task 5 each added an evalHandlers.js fallback guard** (NOT in plan). `translateWhereExpr` falls back to `walkEvalExpr(expr)` when `irExpr` is null. Path 1 (since/until set) and Path 2a (unsupported pushed) both legitimately return null, so the fallback re-walked and emitted a spurious second message. Guards added: `if (since || until) return null;` (Task 4) and `if (unsupported.length > 0) return null;` (Task 5). BOTH are needed — success-with-time-clause vs rejected-with-unsupported are distinct null-return reasons. Sound.
5. **Task 6 gate pivoted from IR-post-walk (plan) to AST-pre-walk.** Plan checked the IR result for `type:'Function'` names in the unimplemented set. But `jparse`/`convert` etc. are ALSO unknown to the eval walker, which pushes its own `eval_func_unsupported` — so gating post-walk fired TWO messages. Solution: `findUnimplementedRhsFuncInAst(node.rhsExpr)` checks the SPL AST (`EvalFunc`/`FunctionCall` node types, lowercased name) BEFORE walking, firing exactly one clean `where_rhs_func_not_row_wise`. Verified jparse + convert each caught with a single message. Bare field named `jparse` (not a call) does NOT false-positive (only function node types match).

### Edges + findings
6. **RESOLVED — Reversed-operand + gated function (`0.25 > jparse(...)`) is UNGATED by Task 6 but still safe.** It fails loud via the eval walker's own `eval function jparse() has no NRQL equivalent` (no NRQL leaks) — just a DIFFERENT message than `where_rhs_func_not_row_wise`. Not a defect. Lock-in test added (commit `11fce3e`): `where 0.25 > jparse(payload, "x")` asserts `unsupportedFunc: ['eval_func_unsupported']`.
7. **RESOLVED — subsearch re-parse DOES apply the new rule for `| where` pipes; the misleading test used a `search`-command comparison.** Original test `index=web [ search in_bytes > out_bytes ]` → `in_bytes > 'out_bytes'` (string). ROOT CAUSE: that's a `search`-COMMAND comparison (search treats unquoted RHS as a string — correct per docs), NOT a `where` pipe. Verified: `index=web [ search index=x | where in_bytes > out_bytes ]` → `numeric(in_bytes) > numeric(out_bytes)` — the re-parse DOES apply the rule to `where` pipes inside subsearches, proving the spec's claim. Both cases now in the suite (commit `11fce3e`) with corrected search-vs-where comments. NOT a regression; spec claim is correct (it was always about `where`, and `where`-in-subsearch works).
8. **RESOLVED — `where status = foo` → `status = foo` (unquoted) is CORRECT, not a regression.** Initially flagged as a regression because pre-feature code (`4c6a832`) emitted `status = 'foo'` (quoted). But Splunk docs (SearchReference→where, verified 2026-06-10) are definitive: **`where`/`eval` treat an unquoted RHS as a FIELD NAME, a quoted RHS as a string literal.** So `where host=www2` is field-to-field; `where host="www2"` is string match. The doc's own example: `| where ipaddress=clientip` compares two fields. Therefore the LEGACY behavior (quoting the bareword → `status = 'foo'`) was the BUG, and the new feature output (`status = foo`, attribute ref) is correct SPL semantics. No disambiguation needed — the rule is unambiguous. Documented in `.claude/references/spl-reference.md` (Translation Gotchas, expanded the `search`-vs-`where` bullet). The Task 7 `where status = foo` test asserts correct behavior and stands. This also confirms `search`-term comparison and `where_comparison` are CORRECTLY different translation paths (SPL itself distinguishes them). LESSON: I trusted legacy code as the contract instead of checking docs — verify semantics against the source of truth, not the existing implementation.

### Stale-doc corrections (mine)
9. **`*Includes` test fields:** runner reads ONLY `errorIncludes` (substring) + `warningFunc`/`unsupportedFunc` (exhaustive message-KEY arrays). `warningIncludes`/`unsupportedIncludes` are DEAD (assert nothing). Fixed `CLAUDE.md` and `.claude/rules/project-testing.md` to match. The plan's Task 5/6/7 `unsupportedIncludes: '...'` cases were corrected to `unsupportedFunc: ['<key>']` during execution.
   - FLAGGED, NOT fixed (other thread's uncommitted file — hands-off): `.claude/skills/validate-test-cases/SKILL.md:47,63,98` still reference `*Includes`.
10. **CLAUDE.md test-filter line:** added `npm run test -- spl` (Vitest positional), correcting the absence that steered toward Jest's `--testPathPattern`. Committed `93c871d`.

### SPL reference gap-fix (expression semantics) — 2026-06-10
11. **Root cause of re-deriving SPL semantics from live docs:** `spl-reference.md` was strong on the COMMAND catalog and FUNCTION list but thin on EXPRESSION-LEVEL rules (quoting, boolean precedence, type coercion, field escaping). Those gaps are why we hit the docs twice this session. User chose a targeted expression-semantics audit. Backfilled into `spl-reference.md` Translation Gotchas (a thematic cluster next to the existing `search`-vs-`where` bullet), all VERIFIED against live Splunk docs this session (not recollection):
    - unquoted RHS = field / quoted RHS = string (SearchReference→where, verbatim).
    - quote TYPE rule: single quotes = field-with-non-alnum-chars, double = string literal (SearchReference→eval, verbatim; covers the hyphenated-field case `'server-1'`).
    - boolean precedence: `where`/`eval` = parens→NOT→AND→OR→XOR; `search` = OR-before-AND, no XOR; NRQL = OR-tighter-than-AND. Must fully parenthesize mixed AND/OR when translating where→NRQL.
    - comparison operators take two-numbers-or-two-strings, `=`==`==`; explains the `numeric()` wrapping (avoids lexicographic surprise `"10"<"9"`).
12. **TOOLING LESSON (durable, method-level):** the spl-expert subagent CANNOT reach docs.splunk.com (its tool set lacks WebFetch/WebSearch and the plugin web tools resolve to "No such tool available"). In the MAIN thread, the plugin `web_fetch`/`raw_http_fetch` get 403 or only chrome from the JS-hydrated Heretto-hosted Splunk docs, and `google_search` is permission-denied for this project. **What WORKS: `curl -sL -A "<browser UA>" "<docs.splunk.com URL>" | pandoc -f html -t plain`** — the raw HTML contains the full body text (precedence lists, quoting paragraphs) even though it's JS-hydrated for browsers. Use this for any future Splunk-docs verification. Do NOT delegate Splunk-docs lookups to the spl-expert subagent expecting live fetches; do them in the main thread via curl+pandoc, or hand the expert pre-fetched text.
