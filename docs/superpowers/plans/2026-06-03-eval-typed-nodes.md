# Eval Typed-Node Rearchitecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the SPL `eval` expression language once as typed AST nodes (`EvalArith`, `EvalNot`) and reference it from all four contexts where it appears, deleting the three flat-string round-trips and unblocking arithmetic-in-functions, comparison-at-top-level, and `+`-string concat.

**Architecture:** Add two IR node types and two walker cases alongside the existing typed eval walker (which already handles `EvalComparison`/`EvalBoolOp`/`EvalParens`/`EvalFunc`/`StringLiteral`). Build one unified Peggy ladder (parens → unary → `* / %` → `+ - .` → comparison → AND → OR), parameterized only by atom set (base vs. stats-wildcard). Wire the four call sites to it one at a time, gated by the 32k corpus after each step. Delete `buildArithmeticExpr` and the flat-string builders last.

**Tech Stack:** Pure ESM JavaScript, Node 24 (`ASDF_NODEJS_VERSION=24.14.0`), Peggy PEG parser, Vitest. Spec: `docs/superpowers/specs/2026-06-03-eval-typed-nodes-design.md`.

---

## Ground rules for this plan

- **Run everything with Node 24:** prefix every command with `ASDF_NODEJS_VERSION=24.14.0`.
- **Regenerate the parser after EVERY grammar edit:** `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`. The committed `splParser.js` is generated; editing `spl.grammar` alone changes nothing until you rebuild.
- **Peek-and-extend ONLY.** Every ladder level uses `head:X tail:(op Y)*` or `head:X tail:(op Y)?`, never `A op B / A`. The grammar comment at `eval_func_arg` (lines ~601-605) records a real O(3^n) backtracking incident from the naive form. Reintroducing it is a plan failure.
- **Loud failure, never silent wrong.** When a walker child returns null, return null (which surfaces as `unsupported`). Never emit `Identifier(undefined)` or drop an operand.
- **Corpus gate after each migration step that touches the grammar/walker (Tasks 3, 4, 5, 6, 7, 9; Task 8 is test-only, no gate).** The corpus lives in the sibling repo `../nr-query-bridge-corpus`. The primary metric is the `eval expression not supported` count — it must FALL or hold, never rise. Parse-errors and throws must not rise; clean must not fall. See "Corpus gating" below for the exact commands.
- **Synthetic test data only.** All new test cases use invented field names (`a`, `b`, `status`, `bytes`) — never customer data. New cases are `verified: false`; only a human promotes them.
- **Commit after each task** with a conventional-commit message, lowercase subject, ≤72 chars. Commit with `ASDF_NODEJS_VERSION=24.14.0 git commit` (hooks need Node 24). Do not auto-push; the user pushes.

## Corpus gating (run after Tasks 3, 4, 5, 6, 7, 9 — not 8, which is test-only)

The corpus harness is in the sibling private repo. From `../nr-query-bridge-corpus`:

```bash
cd ../nr-query-bridge-corpus
ASDF_NODEJS_VERSION=24.14.0 node enrich-corpus.mjs
```

This writes per-query classification. To get the four headline counts plus the target metric, run (the harness prints these; if it doesn't, this jq over its output JSON does):

```bash
# Replace enriched.json with the harness's actual output path if different.
ASDF_NODEJS_VERSION=24.14.0 node -e '
  const q = require("./enriched.json");
  const c = {clean:0, warning:0, unsupported:0, error:0, evalUnsup:0, throws:0};
  for (const r of q) {
    if (r.error) c.error++; else if (r.unsupported?.length) c.unsupported++;
    else if (r.warnings?.length) c.warning++; else c.clean++;
    if ((r.unsupported||[]).some(m => m.includes("eval expression not supported"))) c.evalUnsup++;
    if (r.threw) c.throws++;
  }
  console.log(JSON.stringify(c));
'
```

> **NOTE on running node:** the project deny-list blocks ad-hoc `node -e`. If this command is blocked, instead add a tiny committed script `count-eval-unsup.mjs` in the corpus repo (one-time, reviewed) and run `ASDF_NODEJS_VERSION=24.14.0 node count-eval-unsup.mjs`, OR read the enriched JSON with the Read tool and count by inspection. Do NOT wrap node in a bash script to dodge the deny-list.

Record the `evalUnsup` and `throws` numbers in each migration commit body. **Baseline at start (measured 2026-06-03): evalUnsup ≈ 1926, throws = 0, parse-errors ≈ 2624.** A step that raises `evalUnsup`, raises `throws` above 0, or lowers `clean` is a regression — stop and investigate before continuing.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/ir/nodes.js` | IR node constructors | Add `EvalArith`, `EvalNot` factories |
| `src/input/spl/evalHandlers.js` | Eval walker + handlers | Add `EvalArith`/`EvalNot` walker cases; add `numericize`/`isStringExpr`/`flattenConcat` helpers; rewrite `needsNumeric` to typed-node form; delete flat-string branches (final task) |
| `src/input/spl/splExprUtils.js` | Shared expr utilities | Delete `buildArithmeticExpr` + its use in `mapFunctionArg` (final task) |
| `src/input/spl/spl.grammar` | PEG grammar | Add unified ladder rules; rewire 4 call sites; delete old eval rules |
| `src/input/spl/splParser.js` | Generated parser | Regenerated via `npm run build:parsers` (never hand-edited) |
| `test/spl/spl.test.js` | Translation test suite | Append synthetic `verified: false` cases per task |

## Decisions on the spec's open questions

The spec left three open questions ("Open questions" section). This plan resolves them:

- **`.`-concat node vs. grammar-action concat:** the grammar emits a single `EvalArith` node for `+`, `-`, and `.` (Task 3, `u_add`); the **walker** decides concat-vs-arithmetic (Task 2 `EvalArith` case). No separate `.`-concat node. This keeps the grammar's additive rule uniform and puts the one type-decision (`isStringExpr`) in one place.
- **`LIKE` as an infix eval operator:** **deferred.** `comparison_op` (the operator set `u_cmp` uses) does not include `LIKE`. `like()` as a function already works via the `like` walker case. Adding infix `LIKE` is a low-cost follow-up if the corpus shows demand — out of scope here.
- **`IN` inside eval** (`if(status IN (400,500), ...)`): **deferred** — out of scope, noted for a follow-up. The ladder does not add an `IN` tier.

---
## Task 1: Add `EvalArith` and `EvalNot` IR node factories

These are AST node types the grammar will emit and the walker will consume. Dead code until the grammar emits them — full suite stays green.

**Files:**
- Modify: `src/ir/nodes.js` (add after the `DualCheck` factory, ~line 44)
- Test: `test/spl/spl.test.js` (no test in this task — factories are exercised via the walker in Task 2)

- [ ] **Step 1: Add the two factories**

In `src/ir/nodes.js`, after the `DualCheck` factory (currently ends at line 44), add:

```js
// ── Eval AST nodes (consumed by walkEvalExpr; never emitted to NRQL directly) ──

export const EvalArith = (op, left, right) => ({
  type: 'EvalArith',
  op,
  left,
  right,
});

export const EvalNot = (operand) => ({ type: 'EvalNot', operand });
```

- [ ] **Step 2: Verify the suite still passes (nothing references them yet)**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: PASS (identical pass count to before — these factories are unreferenced).

- [ ] **Step 3: Verify types**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run types:check`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/ir/nodes.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: add EvalArith and EvalNot IR node factories"
```

---

## Task 2: Add walker cases and helpers (still dead until grammar emits)

Add the `EvalArith` and `EvalNot` walker cases plus the three thin helpers, and rewrite `needsNumeric` to a typed-node form. The rewritten `needsNumeric` must keep the existing `EvalComparison` case's output byte-identical (existing comparison tests are the guard). The new cases are dead until the grammar emits the new node types, so the full suite stays green.

**Files:**
- Modify: `src/input/spl/evalHandlers.js` (walker switch ~line 188; helpers ~line 605)
- Test: `test/spl/spl.test.js` (regression check only — existing comparison tests must stay green)

- [ ] **Step 1: Add the two walker cases**

In `src/input/spl/evalHandlers.js`, inside the `switch (node.type)` in `walkEvalExpr` (after the `EvalBoolOp` case, ~line 227), add:

```js
    case 'EvalArith': {
      // op ∈ { +, -, *, /, %, . }. The grammar emits a single EvalArith for all
      // additive/multiplicative operators; this case decides arithmetic vs concat:
      //   '.'                         → always concat
      //   '+' with a string operand   → concat (one quoted/concat side forces it)
      //   '+' with no string operand  → arithmetic (corpus: field+field is numeric)
      //   '-', '*', '/', '%'          → arithmetic ('%' emitted as mod() downstream)
      const left = walkEvalExpr(node.left, ir);
      const right = walkEvalExpr(node.right, ir);
      if (!left || !right) return null; // loud failure
      const isConcat =
        node.op === '.' ||
        (node.op === '+' && (isStringExpr(left) || isStringExpr(right)));
      if (isConcat) {
        return flattenConcat(left, right);
      }
      return BinOp(node.op, numericize(left), numericize(right));
    }

    case 'EvalNot': {
      const operand = walkEvalExpr(node.operand, ir);
      return operand ? Not(operand) : null;
    }
```

- [ ] **Step 2: Rewrite `needsNumeric` to operate on typed nodes**

Replace the existing `needsNumeric` function (currently lines ~605-611, the raw-string/regex form) with:

```js
// True when an EVAL AST NODE is a bare field reference that must be wrapped in
// numeric() for an ordering comparison. Mirrors the old raw-string heuristic
// (a non-numeric token with no arithmetic operators = a bare field) but reads
// the typed node instead of a flattened string.
//   - bare string that isn't a number  → bare field → true
//   - a field_name produces a string in the grammar; numbers produce eval_number
//   - typed nodes (EvalFunc, StringLiteral, EvalArith, EvalParens) → false
function needsNumeric(node) {
  if (typeof node === 'string') {
    return !looksLikeNumber(node);
  }
  return false;
}
```

> **Why this keeps `EvalComparison` identical:** in the current grammar the comparison operands (`eval_simple_arg`) are either a bare field (string), an `eval_number` (string of digits), a `StringLiteral` node, an `EvalFunc` node, or an `EvalParens` node. The old `needsNumeric` returned true only for a non-numeric string with no arithmetic chars — i.e. a bare field. The new form returns true for exactly the same input (non-numeric string), and false for every typed node (which the old form also rejected via its `typeof node === 'string'` guard). Output is unchanged. Once Task 4 wires arithmetic into comparison operands, an `EvalArith` operand correctly returns false (it self-numericizes its own operands).

- [ ] **Step 3: Add the three thin helpers**

In `src/input/spl/evalHandlers.js`, in the `── Internal helpers ──` section (after `needsNumeric`, ~line 611), add:

```js
// Wrap a bare-field IR expression in numeric() for arithmetic context.
// Numbers, functions, and already-wrapped expressions pass through unchanged.
function numericize(expr) {
  if (!expr) return expr;
  if (expr.type === 'Literal' && expr.kind === 'number') return expr;
  if (expr.type === 'Identifier') return Func('numeric', [expr]);
  return expr; // BinOp/Function/etc. already typed — don't double-wrap
}

// True when an eval expression is statically known to be a string: a string
// literal, or a concat() result. Drives the '+' concat-vs-arithmetic decision.
function isStringExpr(expr) {
  if (!expr) return false;
  if (expr.type === 'Literal' && expr.kind === 'string') return true;
  if (expr.type === 'Function' && expr.name === 'concat') return true;
  return false;
}

// Merge nested concats so `a . b . c` emits concat(a, b, c) not
// concat(concat(a, b), c). Each side is already a walked IR expression.
function flattenConcat(left, right) {
  const flat = [];
  for (const side of [left, right]) {
    if (side && side.type === 'Function' && side.name === 'concat') {
      flat.push(...side.args);
    } else {
      flat.push(side);
    }
  }
  return Func('concat', flat);
}
```

- [ ] **Step 3a: Export the helpers the grammar/walker additive branch will need**

`flattenConcat` and `isStringExpr` are used by the additive walker branch added in Task 3. They live in the same module as `walkEvalExpr`, so no export is needed — confirm they are module-scoped functions in `evalHandlers.js`, not imported from elsewhere.

- [ ] **Step 4: Run the full suite — existing comparison tests are the guard**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: PASS, identical pass count. Specifically these `verified: 'human'` cases must stay green (they exercise the unchanged `EvalComparison` path):
- `* | eval x = if(a>1, "y", "n")` → `FROM Log WITH if(numeric(a) > 1, 'y', 'n') AS x SELECT *`
- `* | eval x=if(a > 0 and b > 0, "both", "nope")` → `...if(numeric(a) > 0 AND numeric(b) > 0, ...)...`
- `* | eval level = case(status<300, "ok", status<500, "warn", 1=1, "err")` → `...if(numeric(status) < 300, 'ok', if(numeric(status) < 500, 'warn', 'err'))...`

- [ ] **Step 5: Verify types**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run types:check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/input/spl/evalHandlers.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: add EvalArith/EvalNot walker cases and typed needsNumeric"
```

---
## Task 3: Build the unified ladder grammar (new rules, not wired yet)

Add the one unified eval ladder as **new** grammar rules. Don't touch the four call sites yet — this task only introduces the rules and proves they parse in isolation. The invariant: **one ladder chain, the atom is the only divergence.**

PEG has no real rule parameters, so the "one ladder, two atoms" design is encoded as: a single ladder chain (`u_or` → `u_and` → `u_not` → `u_cmp` → `u_add` → `u_mul` → `u_unary`) whose bottom `u_unary` references a single `u_atom` rule. `u_atom` is an ordered choice that tries the stats-only wildcard atom first, then the base atom. The base atom is reachable in every context; the wildcard extra only matches in stats (where `tcp.*` appears) and is harmless elsewhere because a bare `*` or `tcp.*` never appears as a top-level eval operand in practice — and if it did, the base atom's `field_name` already accepts `*`.

**Files:**
- Modify: `src/input/spl/spl.grammar` (add new rules near the existing eval rules, ~line 640, after `eval_number`)
- Then: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
- Test: `test/spl/spl.test.js`

- [ ] **Step 1: Add the unified ladder rules to the grammar**

In `src/input/spl/spl.grammar`, after the `eval_number` rule (~line 640), add this block. Note every level is **peek-and-extend**; `u_cmp` is non-chaining (`?` not `*`) matching the existing `eval_comparison_arg`.

```
/* ============================================================
   Unified eval expression ladder. ONE definition of the SPL eval
   expression language, referenced by all four call sites.
   Precedence (tight→loose): parens, unary(-/NOT), * / %, + - ., cmp, AND, OR.
   Peek-and-extend at every level (NEVER `A op B / A` — see eval_func_arg
   comment for the O(3^n) backtracking incident this avoids).
   The only per-context divergence is u_atom (base vs. stats-wildcard).
   ============================================================ */
u_expr
  = u_or

u_or
  = head:u_and tail:(_* 'OR'i _* r:u_and { return r; })*
    {
      var result = head;
      for (var i = 0; i < tail.length; i++) {
        result = { type: 'EvalBoolOp', op: 'OR', left: result, right: tail[i] };
      }
      return result;
    }

u_and
  = head:u_not tail:(_* 'AND'i _* r:u_not { return r; })*
    {
      var result = head;
      for (var i = 0; i < tail.length; i++) {
        result = { type: 'EvalBoolOp', op: 'AND', left: result, right: tail[i] };
      }
      return result;
    }

u_not
  = 'NOT'i _+ operand:u_not { return { type: 'EvalNot', operand: operand }; }
  / u_cmp

u_cmp
  = left:u_add tail:(_* op:comparison_op _* right:u_add { return { op: op, right: right }; })?
    {
      return tail
        ? { type: 'EvalComparison', op: tail.op, left: left, right: tail.right }
        : left;
    }

u_add
  = head:u_mul tail:(_* op:[+\-.] _* r:u_mul { return { op: op, right: r }; })*
    {
      var result = head;
      for (var i = 0; i < tail.length; i++) {
        result = { type: 'EvalArith', op: tail[i].op, left: result, right: tail[i].right };
      }
      return result;
    }

u_mul
  = head:u_unary tail:(_* op:[*/%] _* r:u_unary { return { op: op, right: r }; })*
    {
      var result = head;
      for (var i = 0; i < tail.length; i++) {
        result = { type: 'EvalArith', op: tail[i].op, left: result, right: tail[i].right };
      }
      return result;
    }

u_unary
  = '-' _* operand:u_unary { return { type: 'EvalArith', op: '-', left: '0', right: operand }; }
  / u_atom

u_atom
  = u_atom_stats_extra
  / u_atom_base

// Base atom: a parenthesized sub-expression, function call, string literal,
// number, or bare field name. Used in every context.
u_atom_base
  = '(' _* e:u_expr _* ')' { return { type: 'EvalParens', inner: e }; }
  / u_func_call
  / eval_string_literal
  / n:eval_number { return n; }
  / f:field_name { return f; }

// Stats-only extra: wildcard field atoms like `tcp.*` (and bare `*`). Tried
// before u_atom_base only inside stats function args. Elsewhere it still
// parses but never matches anything u_atom_base wouldn't also accept, so
// including it in the shared u_atom is safe.
u_atom_stats_extra
  = chars:[a-zA-Z0-9_.:{}]* '*' rest:[a-zA-Z0-9_.:{}*]*
    { return (chars.join('') + '*' + rest.join('')); }

u_func_call
  = name:function_name '(' _* args:u_func_args _* ')'
    { return { type: 'EvalFunc', name: name, args: args }; }

u_func_args
  = first:u_expr rest:(_* ',' _* a:u_expr { return a; })*
    { return [first].concat(rest); }
  / '' { return []; }
```

> **Why `u_atom_stats_extra` is safe to try first in every context:** it REQUIRES a literal `*` glued to the field chars (no whitespace before the `*`). A normal field (`status`, `tcp.foo`) has no `*`, so it fails and falls to `u_atom_base`. A multiplicative `a * 2` has a space around `*`, which `u_mul` consumes as an operator before the atom rule ever sees it — `u_atom_stats_extra` matching `a` then needing an immediate `*` fails on the space and falls to base. Only glued `tcp.*` (the stats wildcard) matches. So including it in the shared `u_atom` is harmless outside stats and correct inside it. **Regression-guarded by the `avg(tcp.*)` test in Task 6.**

> **Note on `'NOT'i _+ operand:u_not` precedence:** `u_not` calls `u_cmp` for its non-NOT alternative, and `NOT` consumes a full `u_not` (which descends to `u_cmp`), so `NOT isnull(x)` → `EvalNot(EvalFunc isnull)`, and `NOT (a AND b)` → `EvalNot(EvalParens(...))`. `a = b` with no NOT flows straight to `u_cmp`. Unary `NOT` binds tighter than `AND`/`OR` and wraps a comparison fine.

- [ ] **Step 2: Regenerate the parser**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
Expected: completes with no error. (If Peggy reports a left-recursion or undefined-rule error, the rule block has a typo — fix before proceeding.)

- [ ] **Step 3: Confirm nothing changed yet (rules are unwired)**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: PASS, identical pass count. The new rules are unreachable from any entry point, so behavior is unchanged.

- [ ] **Step 4: Corpus gate (baseline confirmation — must not move)**

Run the corpus enrich + count (see "Corpus gating"). Expected: `evalUnsup` unchanged (~1926), `throws` = 0, `clean` unchanged. This step adds dead rules; any movement means a rule accidentally became reachable — investigate.

- [ ] **Step 5: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/input/spl/spl.grammar src/input/spl/splParser.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: add unified eval ladder grammar rules (unwired)"
```

---
## Task 4: Wire call site #2 — `eval_func_call` args → unified ladder

Point function-call arguments (`if(...)`, `case(...)`, `round(...)`, etc.) at the unified ladder. This is the "seed, now with arithmetic" step: the old typed chain (`eval_func_arg`/`eval_comparison_arg`/`eval_simple_arg`) had comparison+boolean but no arithmetic; the unified ladder adds arithmetic, so `round(total/count, 2)` and `if(a > b+1, ...)` flip from `unsupported` to clean.

**Files:**
- Modify: `src/input/spl/spl.grammar` (`eval_func_call` ~line 592)
- Then: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
- Test: `test/spl/spl.test.js`

- [ ] **Step 1: Write failing tests for the flips**

Append to the `cases` array in `test/spl/spl.test.js` (in the eval section, ~line 800). These currently emit `unsupported` — they must become the NRQL shown:

```js
  // ── EvalArith: arithmetic inside function args (Task 4) ──
  {
    spl: '* | stats count | eval x = round(total/count, 2)',
    nrql: 'FROM Log WITH round(numeric(total) / numeric(count), 0.01) AS x SELECT count(*)',
    doc: 'eval-conditional',
    verified: false,
  },
  {
    spl: '* | eval x = if(a > b+1, "hi", "lo")',
    nrql: "FROM Log WITH if(numeric(a) > numeric(b) + 1, 'hi', 'lo') AS x SELECT *",
    doc: 'eval-conditional',
    verified: false,
  },
```

> **Derivation of expected NRQL:** `round(total/count, 2)` → `round` func with arg0 = `EvalArith('/', total, count)` → walker → `BinOp('/', numeric(total), numeric(count))`; arg1 = `2` → `round` case converts to `0.01`. `b+1` → `EvalArith('+', b, 1)`; `1` is a number literal so not a string → arithmetic → `BinOp('+', numeric(b), 1)`. The comparison `a > (b+1)` → `numeric(a) > (numeric(b)+1)` — note `numericize` of an `EvalArith` result (a `BinOp`) is a no-op, so no double-wrap.

- [ ] **Step 2: Confirm tests FAIL with the current grammar**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: the two new cases FAIL (they currently produce `unsupported: eval expression not supported`, not the NRQL).

- [ ] **Step 3: Repoint `eval_func_call` at the unified ladder**

In `src/input/spl/spl.grammar`, change `eval_func_call` (line 592-594) FROM:

```
eval_func_call
  = name:function_name '(' _* args:eval_func_args _* ')'
    { return { type: 'EvalFunc', name: name, args: args }; }
```

TO (reuse the unified func-call/args rules so the old `eval_func_arg` chain is no longer the source of truth for func args):

```
eval_func_call
  = u_func_call
```

This makes `eval_func_call` an alias of `u_func_call`, whose args are `u_expr` (the full ladder). The old `eval_func_args`/`eval_func_arg`/`eval_comparison_arg`/`eval_simple_arg`/`eval_bool_op` rules are now orphaned — leave them in place for this task (deleted in Task 9) so the diff stays small and reviewable.

> **Why `eval_func_call` is still reachable:** the old top-level `eval_factor` (line 589) references `eval_func_call`. After this change it resolves to `u_func_call`. The top-level `eval_expr`/`eval_term`/`eval_factor` flat-string path is still active until Task 5 — but its `eval_func_call` now produces fully-typed args. The top-level flat-string builder wraps the typed `EvalFunc` as a string segment; confirm Step 5 shows no top-level regression.

- [ ] **Step 4: Regenerate the parser**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
Expected: no error.

- [ ] **Step 5: Run the suite — flips pass, existing func tests stay green**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: the two new cases now PASS. These existing `verified: 'human'` func-arg cases MUST stay green (they exercise the same call site, now via the unified ladder):
- `* | eval x = if(a>1, "y", "n")` → `...if(numeric(a) > 1, 'y', 'n')...`
- `* | eval x=if(a > 0 and b > 0, "both", "nope")` → `...if(numeric(a) > 0 AND numeric(b) > 0, ...)...`
- `* | eval FLSQuantity=if(channelName=="FLS", availableQuantityInChannel, 0)` → `...if(channelName = 'FLS', ...)...`
- `* | eval level = case(status<300, "ok", status<500, "warn", 1=1, "err")` → nested-if output
- `* | eval val = coalesce(field1, field2, "default")` → `(field1 OR field2 OR 'default')`

If any existing case regresses, STOP — the unified ladder's func-arg parse differs from the old chain. Compare the AST the old `eval_func_arg` produced vs. `u_expr` for that input before continuing.

- [ ] **Step 6: Corpus gate**

Run corpus enrich + count. Expected: `evalUnsup` FALLS (round-in-func and arithmetic-in-func queries flip); `throws` = 0; `clean` rises; parse-errors hold or improve. Record before/after `evalUnsup` in the commit body.

- [ ] **Step 7: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/input/spl/spl.grammar src/input/spl/splParser.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: wire eval func args to unified ladder (arithmetic in funcs)"
```

---
## Task 5: Wire call site #1 — top-level `eval_assignment` → unified ladder

Replace the top-level flat-string `eval_expr`/`eval_term`/`eval_factor` with the unified ladder. This deletes the string round-trip for top-level eval and flips `status >= 400` (comparison at top level) and `businessDate + " "` (string-`+` concat) to clean.

**Files:**
- Modify: `src/input/spl/spl.grammar` (`eval_assignment` ~line 560)
- Then: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
- Test: `test/spl/spl.test.js`

- [ ] **Step 1: Write failing tests for the top-level flips**

Append to the `cases` array (eval section):

```js
  // ── EvalArith: top-level comparison + string-concat (Task 5) ──
  {
    spl: '* | eval hi = status >= 400',
    nrql: 'FROM Log WITH numeric(status) >= 400 AS hi SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  {
    spl: '* | eval z = businessDate + " "',
    nrql: "FROM Log WITH concat(businessDate, ' ') AS z SELECT *",
    doc: 'eval-string',
    verified: false,
  },
  {
    spl: '* | eval full = a + " " + b',
    nrql: "FROM Log WITH concat(a, ' ', b) AS full SELECT *",
    doc: 'eval-string',
    verified: false,
  },
```

> **Derivation:** `status >= 400` → `EvalComparison('>=', 'status', '400')`. `400` is a number; `>=` is ordering → `numeric(status) >= 400`. Wait — `needsNumeric('400')` returns false (it's a number) so the right side is NOT wrapped; `needsNumeric('status')` returns true → `numeric(status)`. Left `numeric(status)`, right `400`. `businessDate + " "` → `EvalArith('+', 'businessDate', StringLiteral ' ')` → string operand → `flattenConcat(Identifier businessDate, Literal ' ')` → `concat(businessDate, ' ')`. `a + " " + b` left-assoc → `EvalArith('+', EvalArith('+', a, " "), b)`; inner is concat → `concat(a, ' ')`; outer `+` with left=concat(string) → `flattenConcat(concat(a,' '), Identifier b)` → `concat(a, ' ', b)`.

- [ ] **Step 2: Confirm tests FAIL with current grammar**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: the three new cases FAIL (currently `unsupported`).

- [ ] **Step 3: Repoint `eval_assignment` at the unified ladder**

In `src/input/spl/spl.grammar`, change `eval_assignment` (lines 560-562) FROM:

```
eval_assignment
  = field:field_name _* '=' _* expr:eval_expr
    { return { field: field, expr: expr }; }
```

TO:

```
eval_assignment
  = field:field_name _* '=' _* expr:u_expr
    { return { field: field, expr: expr }; }
```

Now `assignment.expr` is a typed node, not a flat string. `translateEvalExpr` (in `evalHandlers.js`) already calls `walkEvalExpr(assignment.expr, ir)` — which now receives a typed tree and never hits the rawText/`buildArithmeticExpr` path for parseable assignments.

- [ ] **Step 4: Regenerate the parser**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
Expected: no error.

- [ ] **Step 5: Run the suite — flips pass, all existing top-level eval tests stay green**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: the three new cases PASS. These existing `verified: 'human'` top-level arithmetic cases MUST stay byte-identical (they now route through the typed ladder + `numericize` instead of `buildArithmeticExpr`):
- `* | eval size_mb = bytes / 1048576 | ...` → `WITH numeric(bytes) / 1048576 AS size_mb, ...`
- `status=200 | eval duration_sec = duration / 1000 | ...` → `WITH numeric(duration) / 1000 AS duration_sec ...`
- `* | eval x=a+b, alias = original, lit = 42, parens = ((a + b)), hyph = http-status / 100, col = aws:region, dot = http.status / 100` → exact output at line 713 of the test file:
  `FROM Log WITH numeric(a) + numeric(b) AS x, original AS alias, 42 AS lit, numeric(a) + numeric(b) AS parens, numeric(\`http-status\`) / 100 AS hyph, \`aws:region\` AS col, numeric(\`http.status\`) / 100 AS dot SELECT *`
- `* | eval full = first . " " . last` → `WITH concat(first, ' ', last) AS full ...` (the dot-concat case — now flows through the ladder's `.` branch, not `tryParseDotConcat`)
- `* | fillnull value=0 bytes | eval kb = bytes / 1024` → `WITH numeric(bytes OR 0) / 1024 AS kb ...`

> **Watch the `original AS alias` and `42 AS lit` cases:** `alias = original` is a bare field with no operators → walker returns `Identifier('original')` → emits `original AS alias` (no numeric wrap, since it's not in arithmetic context). `lit = 42` → `eval_number` → `Literal(42,'number')` → `42 AS lit`. `col = aws:region` → bare field `aws:region` → `Identifier` → backticked → `\`aws:region\` AS col`. If any of these regress, the `u_atom_base` ordering or `field_name` char class differs from the old `eval_factor` — diff the two.

- [ ] **Step 6: Corpus gate**

Run corpus enrich + count. Expected: `evalUnsup` FALLS substantially (top-level comparison + concat are common); `throws` = 0; `clean` rises. Record before/after.

- [ ] **Step 7: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/input/spl/spl.grammar src/input/spl/splParser.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: wire top-level eval assignment to unified ladder"
```

---
## Task 6: Wire call site #3 — stats `function_arg` → unified ladder (stats atom)

Replace the stats-bare-arg flat-string builder (`function_arg`/`func_arg_atom`, which `mapFunctionArg` re-parses via `buildArithmeticExpr`) with the unified ladder using the stats atom. The wildcard atom (`avg(tcp.*)`) must keep emitting `average(\`tcp.*\`)`.

The wrinkle: stats args currently arrive at `mapFunctionArg` (in `splExprUtils.js`) as **strings** — either a bare field, a wildcard pattern, a `{}`-jpath, or an arithmetic string. The unified ladder produces **typed nodes**. So `mapFunctionArg` must learn to consume a typed node (pass it to `walkEvalExpr`) while still handling the wildcard/jpath string atoms the stats atom emits as strings.

**Files:**
- Modify: `src/input/spl/spl.grammar` (`function_args`/`function_arg` ~line 135)
- Modify: `src/input/spl/splExprUtils.js` (`mapFunctionArg` ~line 102)
- Then: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
- Test: `test/spl/spl.test.js`

- [ ] **Step 1: Write failing/guard tests**

Append to the `cases` array (stats section):

```js
  // ── EvalArith: stats function args via unified ladder (Task 6) ──
  {
    spl: '* | stats sum(bytes/1024)',
    nrql: 'FROM Log SELECT sum(numeric(bytes) / 1024)',
    doc: 'stats-agg',
    verified: false,
  },
  {
    spl: '* | stats sum(a*2+b)',
    nrql: 'FROM Log SELECT sum(numeric(a) * 2 + numeric(b))',
    doc: 'stats-agg',
    verified: false,
  },
  {
    spl: '* | stats avg(tcp.*)',
    nrql: 'FROM Log SELECT average(`tcp.*`)',
    doc: 'stats-agg',
    verified: false,
  },
```

> `sum(bytes/1024)` already works today (the flat-string `func_arg_atom` + `buildArithmeticExpr`); it's here as a regression guard. `sum(a*2+b)` exercises precedence (`*` before `+`). `avg(tcp.*)` is the wildcard-atom regression guard.

- [ ] **Step 2: Confirm current state**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: `sum(bytes/1024)` and `avg(tcp.*)` PASS already; `sum(a*2+b)` — verify whether it passes or fails today (run `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | stats sum(a*2+b)'` to see). Record which fail.

- [ ] **Step 3: Repoint `function_args`/`function_arg` at the unified ladder**

In `src/input/spl/spl.grammar`, change `function_args` (lines 135-138) and `function_arg`/`func_arg_atom` (lines 140-149). Replace the whole block FROM:

```
function_args
  = first:function_arg rest:(',' _* arg:function_arg { return arg; })*
    { return [first].concat(rest); }
  / '' { return []; }

function_arg
  = '"' chars:double_string_char* '"' { return chars.join(''); }
  / "'" chars:single_string_char* "'" { return chars.join(''); }
  / head:func_arg_atom tail:(_* op:[+\-*/%] _* right:func_arg_atom { return ' ' + op + ' ' + right; })+
    { return head + tail.join(''); }
  / func_arg_atom

func_arg_atom
  = '(' _* expr:function_arg _* ')' { return '(' + expr + ')'; }
  / chars:[a-zA-Z0-9_.*\\:{}]+ { return chars.join(''); }
```

TO:

```
function_args
  = first:u_expr rest:(',' _* arg:u_expr { return arg; })*
    { return [first].concat(rest); }
  / '' { return []; }
```

`function_arg` and `func_arg_atom` are now orphaned — leave them for Task 9. `function_args` now produces typed nodes (including the wildcard string from `u_atom_stats_extra`, which returns a bare string like `'tcp.*'`).

> **Reachability note:** `function_args` is referenced by `stats_function` (line 116), `where_function_call` (line 291), and others. All now receive typed nodes. `where_function_call` feeds `walkEvalFunc` via the `FunctionCall` walker case, which maps args through `walkEvalExpr` — typed nodes flow through fine. Confirm in Step 6 that where-pipe function calls (`where like(uri, "%/api/%")`, `where cidrmatch(...)`) stay green.

- [ ] **Step 4: Teach `mapFunctionArg` to consume typed nodes**

In `src/input/spl/splExprUtils.js`, `mapFunctionArg` (lines 102-119) currently assumes a string `a`. The unified ladder hands it either a typed node OR a bare string (wildcard `tcp.*`, jpath `field{}`). Rewrite to dispatch on type. Add `walkEvalExpr` to the imports (it lives in `evalHandlers.js`; a runtime-only import avoids the load-time circular — mirror the existing `translateSearchExpr` circular-import pattern). Replace `mapFunctionArg` with:

```js
export function mapFunctionArg(a) {
  // Typed node from the unified ladder → walk to IR.
  if (a && typeof a === 'object') {
    return walkEvalExpr(a, { warnings: [], unsupported: [], errors: [] });
  }
  // Bare-string atoms the stats atom emits as strings:
  if (a === '_time') return Identifier('timestamp');
  if (/\{\d*\}/.test(a)) {
    const jpath = a.replace(/\{(\d*)\}/g, (_, n) => (n ? `[${n}]` : '[*]'));
    return Func('jparse', [Identifier('message'), Literal(jpath, 'string')]);
  }
  return Identifier(a); // wildcard (`tcp.*`) or plain field — emitter backticks it
}
```

> **The throwaway `ir` in the typed-node branch:** stats-arg eval expressions don't currently surface warnings/unsupported to the query's `ir` (the old flat-string path didn't either). Passing a throwaway collector preserves that behavior for now. A follow-up could thread the real `ir` through `mapFunction`/`mapFunctionArg`, but that's out of scope — note it and move on. **Verify** `avg(tcp.*)` still emits `average(\`tcp.*\`)`: `tcp.*` arrives as a string (not an object), skips the typed branch, isn't `_time`, has no `{}`, so → `Identifier('tcp.*')` → emitter backticks → `\`tcp.*\``. Correct.

- [ ] **Step 4a: Add the runtime import**

At the top of `splExprUtils.js`, the existing imports don't include `walkEvalExpr`. Add a runtime-safe import. Since `evalHandlers.js` already imports from `splExprUtils.js` (`buildArithmeticExpr`, etc.), a static `import { walkEvalExpr } from './evalHandlers.js'` would create a load-time cycle. Use the same deferred pattern the codebase already uses — import inside the function is not allowed in ESM at call sites cleanly, so instead add at module top:

```js
// Circular import — safe because walkEvalExpr is only invoked at runtime (during
// translation), never at module load. Mirrors evalHandlers.js's import of
// translateSearchExpr from splToIR.js.
import { walkEvalExpr } from './evalHandlers.js';
```

> **If the cycle causes a `walkEvalExpr is undefined` at runtime** (ESM live-binding usually prevents this, but if it bites): move `mapFunctionArg` and `mapFunction` into `evalHandlers.js` (they're eval-adjacent), or extract `walkEvalExpr` into a third module both import. Decide at implementation time based on whether the static import works — try the static import first; it almost certainly works because both modules finish loading before any translation runs.

- [ ] **Step 5: Regenerate the parser**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
Expected: no error.

- [ ] **Step 6: Run the suite — wildcard + arithmetic + where-funcs stay green**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: new cases PASS. These MUST stay green:
- `* | stats avg(tcp.*)` → `average(\`tcp.*\`)` (wildcard atom)
- All `where like(...)`, `where cidrmatch(...)`, `where isint(...)` cases (where-pipe function calls now get typed args)
- All existing percentile/rate/per_second stats cases (they go through `mapFunctionArg`)

- [ ] **Step 7: Corpus gate**

Run corpus enrich + count. Expected: `evalUnsup` holds or falls; `throws` = 0; `clean` holds or rises. Stats-arg arithmetic was mostly already working, so the big movement here is NOT expected — the value is deleting a flat-string path. Watch closely for any `clean→error` from where-pipe function calls receiving typed args. Record before/after.

- [ ] **Step 8: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/input/spl/spl.grammar src/input/spl/splParser.js src/input/spl/splExprUtils.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: wire stats function args to unified ladder (stats atom)"
```

---

## Task 7: Wire call site #4 — stats `fn(eval(...))` inner → unified ladder

Replace `eval_inner_expr`'s balanced-paren text capture with the unified ladder, so the inner `eval(...)` body of `sum(eval(if(status>=400,1,0)))` parses to a typed tree. The existing `evalFilter` → `filter(count(*), WHERE ...)` emit must keep working.

**Files:**
- Modify: `src/input/spl/spl.grammar` (`stats_function` line 112)
- Consumer (`aggregationHandlers.js:38`) needs NO change — already walks the node (see Step 0)
- Then: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
- Test: `test/spl/spl.test.js`

- [ ] **Step 0: Confirm the consumer already walks the node (no consumer change needed)**

The consumer is `aggregationHandlers.js:36-45`. It already does `const filterCondition = walkEvalExpr(fn.evalFilter, ir);`. Today `fn.evalFilter` is a **string**, so `walkEvalExpr` hits its bare-string parsing path. After this task it's a **typed node**, which `walkEvalExpr` handles natively via its `switch (node.type)`. **No consumer edit is required** — the grammar change alone upgrades `evalFilter` from string to typed node, and the existing `walkEvalExpr` call consumes either. (Verified 2026-06-03: the only `src/` references to `evalFilter` are the grammar action at `spl.grammar:114` and this consumer at `aggregationHandlers.js:38`.) Re-confirm with: `ASDF_NODEJS_VERSION=24.14.0 grep -rn "evalFilter" src/` — if a new consumer has appeared, update it to walk a node.

- [ ] **Step 1: Write a failing/guard test**

Append to the `cases` array (stats section):

```js
  // ── EvalArith: eval nested in stats arg (Task 7) ──
  {
    spl: '* | stats sum(eval(if(status>=400,1,0)))',
    nrql: 'FROM Log SELECT filter(count(*), WHERE numeric(status) >= 400)',
    doc: 'stats-agg',
    verified: false,
  },
```

> **Confirm the expected NRQL first.** Run `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | stats sum(eval(if(status>=400,1,0)))'` BEFORE making changes to capture the CURRENT output, and again after. The expected string above is the design intent (`filter(count(*), WHERE ...)`); if the current consumer emits a different but equivalent shape, match the consumer's actual post-change output. Adjust the test's `nrql` to the real emitted string — do not assert a shape the emitter doesn't produce.

- [ ] **Step 2: Repoint `stats_function`'s eval-inner at the unified ladder**

In `src/input/spl/spl.grammar`, change `stats_function`'s first alternative (line 112) FROM:

```
  = _* name:function_name '(' _* 'eval'i _* '(' _* evalExpr:eval_inner_expr _* ')' _* ')' alias:as_clause?
    {
      return { name: name, args: [], alias: alias, evalFilter: evalExpr };
    }
```

TO:

```
  = _* name:function_name '(' _* 'eval'i _* '(' _* evalExpr:u_expr _* ')' _* ')' alias:as_clause?
    {
      return { name: name, args: [], alias: alias, evalFilter: evalExpr };
    }
```

`evalFilter` is now a typed node.

- [ ] **Step 3: (No consumer change — confirmed in Step 0)**

`aggregationHandlers.js:38` already walks `fn.evalFilter` with `walkEvalExpr`. Because that function dispatches on `node.type` for objects and only falls back to string-parsing for strings, upgrading `evalFilter` from string to typed node requires no consumer edit. Skip to Step 4. If Step 0's re-grep surfaced a NEW string-based consumer, fix only that one here.

- [ ] **Step 4: Regenerate the parser**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
Expected: no error.

- [ ] **Step 5: Run the suite**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: the new case PASSES (matching the real emitted string); all existing `stats ... eval(...)` cases stay green.

- [ ] **Step 6: Corpus gate**

Run corpus enrich + count. Expected: `evalUnsup` holds or falls; `throws` = 0; `clean` holds or rises. Record before/after.

- [ ] **Step 7: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/input/spl/spl.grammar src/input/spl/splParser.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: wire stats fn(eval(...)) inner to unified ladder"
```

---
## Task 8: Edge-case test batch — concat decision, modulo, dual-check, precedence

All four call sites now use the unified ladder. This task adds the spec's full edge-case test matrix (Testing section) as one batch of synthetic `verified: false` cases, proving the concat-vs-arithmetic decision, modulo, dual-check, unary NOT, and `==` mapping all behave. No source change — if a case fails, the bug is in Tasks 2-7 and you return there.

**Files:**
- Test: `test/spl/spl.test.js` (append the batch)
- No source change expected. If a case fails → fix the relevant earlier task's source, not the test.

- [ ] **Step 1: Append the edge-case batch**

Append to the `cases` array (eval section). Run each through `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '<spl>'` first to capture the ACTUAL emitted NRQL, then paste that exact string into `nrql` (do not hand-guess grouping):

```js
  // ── Unified ladder edge cases (Task 8) ──
  // Precedence: * binds tighter than +
  {
    spl: '* | eval r = a*2+b',
    nrql: 'FROM Log WITH numeric(a) * 2 + numeric(b) AS r SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  // Precedence: parens override
  {
    spl: '* | eval r = (a+b)*c',
    nrql: 'FROM Log WITH (numeric(a) + numeric(b)) * numeric(c) AS r SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  // Mixed arithmetic + comparison + boolean
  {
    spl: '* | eval r = if(a*2 > b AND c < 3, "y", "n")',
    nrql: "FROM Log WITH if(numeric(a) * 2 > numeric(b) AND numeric(c) < 3, 'y', 'n') AS r SELECT *",
    doc: 'eval-conditional',
    verified: false,
  },
  // Unary NOT around a function
  {
    spl: '* | eval r = if(NOT isnull(x), 1, 0)',
    nrql: 'FROM Log WITH if(NOT x IS NULL, 1, 0) AS r SELECT *',
    doc: 'eval-conditional',
    verified: false,
  },
  // Unary NOT around a parenthesized boolean
  {
    spl: '* | eval r = if(NOT (a AND b), 1, 0)',
    nrql: 'FROM Log WITH if(NOT (a AND b), 1, 0) AS r SELECT *',
    doc: 'eval-conditional',
    verified: false,
  },
  // Concat via dot
  {
    spl: '* | eval r = a . " " . b',
    nrql: "FROM Log WITH concat(a, ' ', b) AS r SELECT *",
    doc: 'eval-string',
    verified: false,
  },
  // + with numeric literal stays arithmetic
  {
    spl: '* | eval r = field + 5',
    nrql: 'FROM Log WITH numeric(field) + 5 AS r SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  // + of two bare fields → arithmetic (corpus default)
  {
    spl: '* | eval r = f + g',
    nrql: 'FROM Log WITH numeric(f) + numeric(g) AS r SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  // Modulo → mod() (emitter rewrites %)
  {
    spl: '* | eval r = a % b',
    nrql: 'FROM Log WITH mod(numeric(a), numeric(b)) AS r SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  // == maps to =
  {
    spl: '* | eval r = if(x==1, "y", "n")',
    nrql: "FROM Log WITH if(x = '1' OR numeric(x) = 1, 'y', 'n') AS r SELECT *",
    doc: 'eval-conditional',
    verified: false,
  },
  // Dual-check regression: eval equality with numeric value
  {
    spl: '* | eval r = if(status=500, 1, 0)',
    nrql: "FROM Log WITH if(status = '500' OR numeric(status) = 500, 1, 0) AS r SELECT *",
    doc: 'eval-conditional',
    verified: false,
  },
```

> **Two cases to verify against the emitter carefully (don't trust the guess above):**
> - `if(NOT isnull(x), 1, 0)`: `isnull(x)` → `IsNull(Identifier x)`; the existing `isnull` walker case emits `x IS NULL`; `NOT` wraps → `NOT x IS NULL`. NRQL may render as `NOT x IS NULL` or `NOT (x IS NULL)` depending on the emitter — capture the real string.
> - `x==1` dual-check: `==` → `=`; `1` numeric + left is Identifier → `DualCheck` → `x = '1' OR numeric(x) = 1`. Confirm the emitter's exact spacing/parens.
> If the emitter's real output differs from these guesses, the EMITTER output is authoritative — set `nrql` to it. These are `verified: false`, so a human will sanity-check semantics later; your job is to assert the actual string so the test guards against future drift.

- [ ] **Step 2: Run the suite**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: all batch cases PASS (with `nrql` set to the captured real output). If a case can't be made to pass with a correct-looking NRQL, the bug is upstream (Tasks 2-7) — fix there, don't weaken the test.

- [ ] **Step 3: Lint + types + format**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check && ASDF_NODEJS_VERSION=24.14.0 npm run format:check`
Expected: all PASS. (`format:check` may flag the appended test block — run `npm run format` to fix, then re-add.)

- [ ] **Step 4: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "test: add unified eval ladder edge-case coverage"
```

---

## Task 9: Delete the dead flat-string machinery

All four call sites use the unified ladder. Remove the now-orphaned flat-string code: `buildArithmeticExpr` and its tokenizer, the regex-detection + bare-string-comparison branches in `walkEvalExpr`, and the orphaned grammar rules. Nothing should reference them.

**Files:**
- Modify: `src/input/spl/splExprUtils.js` (delete `buildArithmeticExpr`, lines ~242-319; clean its now-dead use in `mapFunctionArg` — already replaced in Task 6)
- Modify: `src/input/spl/evalHandlers.js` (delete the bare-string comparison + arithmetic branches in `walkEvalExpr`, lines ~146-186; remove the now-unused `buildArithmeticExpr` import; the `tryParseDotConcat` rawText path)
- Modify: `src/input/spl/spl.grammar` (delete orphaned rules: `eval_expr`, `eval_term`, `eval_factor`, `eval_func_args`, `eval_func_arg`, `eval_comparison_arg`, `eval_bool_op`, `eval_simple_arg`, `function_arg`, `func_arg_atom`, `eval_inner_expr`, `eval_inner_part`)
- Then: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
- Test: `test/spl/spl.test.js`

- [ ] **Step 1: Find all references before deleting**

Run each and confirm the only hits are definitions (not uses):
```bash
ASDF_NODEJS_VERSION=24.14.0 grep -rn "buildArithmeticExpr" src/
ASDF_NODEJS_VERSION=24.14.0 grep -rn "eval_expr\|eval_term\|eval_factor\|eval_func_arg\|eval_comparison_arg\|eval_simple_arg\|eval_bool_op\|eval_func_args\b\|func_arg_atom\|eval_inner_expr\|eval_inner_part" src/input/spl/spl.grammar
ASDF_NODEJS_VERSION=24.14.0 grep -rn "tryParseDotConcat" src/
```
> `function_arg` appears in `function_args`' OLD body — but Task 6 replaced `function_args`, so `function_arg`/`func_arg_atom` are orphaned. `eval_inner_expr`/`eval_inner_part` orphaned by Task 7. `eval_func_arg` chain orphaned by Task 4. `eval_expr`/`eval_term`/`eval_factor` orphaned by Task 5 (but `eval_factor` referenced `eval_func_call` which is now `u_func_call` — confirm `eval_factor` itself is unreferenced). If any grammar rule still has a live referrer, do NOT delete it; investigate why a call site wasn't fully rewired.

- [ ] **Step 2: Delete `buildArithmeticExpr` from `splExprUtils.js`**

Remove the entire `── Arithmetic expression parsing ──` section (the `buildArithmeticExpr` function, lines ~234-319). Remove `buildArithmeticExpr` from any export and from the `evalHandlers.js` import list (line ~24). The `mapFunctionArg` rewrite from Task 6 already removed its only remaining use there.

- [ ] **Step 3: Delete the bare-string branches in `walkEvalExpr`**

In `evalHandlers.js`, in `walkEvalExpr`, the `if (typeof node === 'string')` block (lines ~146-186) handled flat-string operators, the comparison regex, and bare arithmetic. The ladder now delivers typed nodes, so a bare field arrives as a string ONLY as a leaf (a `field_name` returns a string). Keep the minimal leaf handling — replace the whole string block with:

```js
  // Bare string is now ONLY a leaf field name or numeric literal token from the
  // grammar (field_name / eval_number / wildcard atom). All operators, comparisons,
  // and arithmetic now arrive as typed nodes (EvalArith/EvalComparison/etc.).
  if (typeof node === 'string') {
    if (looksLikeNumber(node)) return Literal(Number(node), 'number');
    if (node === '_time') return Identifier('timestamp');
    return Identifier(node);
  }
```

> This deletes the comparison-regex and `buildArithmeticExpr` fallback. Verify no test relied on a raw comparison string reaching `walkEvalExpr` — the `where`-pipe still produces `FunctionCall`/`Comparison` via `translateSearchExpr`, not bare strings, so this is safe. Re-run the suite to confirm.

- [ ] **Step 4: Remove the `tryParseDotConcat` rawText path (now redundant)**

In `translateEvalExpr` (evalHandlers.js, lines ~69-82), the `cmd.rawText` branch with `tryParseDotConcat` + the FIXME `unsupported` exists for evals the OLD grammar couldn't parse into assignments. The unified ladder parses `.`-concat and `+`-concat as typed assignments, so `eval_command`'s first alternative (line 543) now succeeds for these and `rawText` is null. The rawText fallback (line 551) only fires for genuinely unparseable eval bodies. Decide:
  - **Keep the rawText fallback** (line 551 alternative) — it's the loud-`unsupported` safety net for eval bodies the ladder still can't parse. Correct to keep.
  - **Delete `tryParseDotConcat`** (lines ~108-134) and its call (line 72) — `.`-concat now goes through the ladder. Confirm the dot-concat test `* | eval full = first . " " . last` still passes via the ladder (Task 5 Step 5 covered it) BEFORE deleting. Then remove `tryParseDotConcat` and simplify the rawText branch to just push `messages.eval_not_supported(cmd.rawText)`.

- [ ] **Step 5: Delete the orphaned grammar rules**

In `spl.grammar`, delete the rule definitions confirmed orphaned in Step 1: `eval_expr`, `eval_term`, `eval_factor`, `eval_func_call`'s OLD body is already `= u_func_call` (keep that alias or inline it — keeping the alias is fine), `eval_func_args`, `eval_func_arg`, `eval_comparison_arg`, `eval_bool_op`, `eval_simple_arg`, `function_arg`, `func_arg_atom`, `eval_inner_expr`, `eval_inner_part`. Leave `eval_string_literal`, `eval_number`, `field_name`, `comparison_op` — the unified ladder uses them.

- [ ] **Step 6: Regenerate, test, lint, types**

```bash
ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers
ASDF_NODEJS_VERSION=24.14.0 npm run test
ASDF_NODEJS_VERSION=24.14.0 npm run lint
ASDF_NODEJS_VERSION=24.14.0 npm run types:check
```
Expected: parser builds clean (no "rule defined but not used" — Peggy warns on unused rules, so leftover orphans surface here); full suite PASS; lint/types clean.

- [ ] **Step 7: Final corpus gate**

Run corpus enrich + count. Expected vs. the baseline in the "Corpus gating" section (evalUnsup ≈ 1926, throws = 0, parse-errors ≈ 2624): `evalUnsup` substantially LOWER (target: a large fraction of ~1926 gone); `throws` = 0; `clean` substantially HIGHER; parse-errors ≤ baseline. Record final numbers in the commit body — this is the proof the rearchitecture worked.

- [ ] **Step 8: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add src/input/spl/splExprUtils.js src/input/spl/evalHandlers.js src/input/spl/spl.grammar src/input/spl/splParser.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "refactor: delete flat-string eval machinery, ladder is sole path"
```

- [ ] **Step 9: Update design-decisions doc**

The `.claude/rules/design-decisions.md` "Eval expression representation (KNOWN DEBT)" entry (line 13) describes the now-removed string round-trip. Update it to describe the shipped state: one unified typed ladder, `EvalArith`/`EvalNot` nodes, no flat-string round-trip. Commit separately:

```bash
ASDF_NODEJS_VERSION=24.14.0 git add .claude/rules/design-decisions.md
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: update eval design-decision to shipped typed-ladder state"
```

---

## Done

After Task 9: one typed eval grammar, referenced by all four call sites; `EvalArith`/`EvalNot` nodes; no `buildArithmeticExpr`, no flat-string round-trip. The corpus `eval expression not supported` count has dropped substantially from ~1926, `clean` has risen, zero new throws, parse-errors held or improved.

Then invoke **superpowers:finishing-a-development-branch** to verify the full suite and choose merge/PR.
