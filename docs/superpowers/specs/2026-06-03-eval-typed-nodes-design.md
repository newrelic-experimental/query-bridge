# Eval Typed-Node Rearchitecture Design

**Goal:** Replace the flat-string round-trip in the SPL `eval` expression pipeline with typed AST nodes, eliminating a class of bugs (dropped string literals, `numeric(+)` garbage, `Identifier(undefined)` crashes) and unlocking query patterns the current split grammar rejects (`round(total/count, 2)`, `status >= 400`, `businessDate + " "`).

## Problem

The eval pipeline parses structured expressions, then **flattens them back to strings** and re-parses. `eval_expr`/`eval_term`/`eval_factor` build a flat string via `result + ' ' + op + ' ' + term`; `walkEvalExpr` then regex-detects operators and `buildArithmeticExpr` re-tokenizes and re-parses that string into IR.

This string round-trip is the root cause of every eval bug we keep hitting:

- **Dropped string literals.** `buildArithmeticExpr`'s tokenizer regex has no string alternative, so `" "` in `businessDate + " "` vanishes; the parser then reads past end-of-input and emits `Identifier(undefined)`, crashing `smartEscape` in the emitter (89 corpus queries until hardened to loud `unsupported`).
- **Wrong type inference.** `"a" + "b"` emits `numeric(a) + numeric(b)` — the quotes are stripped, string contents become phantom field identifiers wrapped in `numeric()`.
- **Leading-dot misclassification** (fixed separately, same root): operand type guessed by regex instead of known from the parse.

The design-decisions doc already *claims* `eval_expr`/`eval_term`/`eval_factor` produce typed `EvalArith` nodes. They do not — `EvalArith` appears nowhere in `src/`. The doc describes the intended destination; the code never got there.

### Two parallel grammars, mutually exclusive in capability

The eval grammar has two separate expression chains that don't compose:

| Path | Operators | Atoms | Produces |
|---|---|---|---|
| `eval_expr`/`eval_term`/`eval_factor` (top-level arithmetic) | `+ - * / %` with precedence | `field_name`, number, parens, func-call | **flat string** |
| `eval_func_arg`/`eval_comparison_arg`/`eval_simple_arg` (function args, e.g. inside `if`/`case`) | comparison, `AND`/`OR` | + `eval_string_literal` | **typed nodes** (`EvalComparison`, `EvalBoolOp`, `EvalParens`, `StringLiteral`) |

Because they're separate, neither composes with the other:

- `round(total/count, 2)` → `unsupported` (func-arg path has no arithmetic)
- `if(a > b+1, "hi", "lo")` → `unsupported` (arithmetic inside a func arg)
- `status >= 400` at top level → `unsupported` (arithmetic path has no comparison)

These are common SPL patterns rejected purely because arithmetic and comparison/boolean live in grammars that can't nest.

### A third flat-string arithmetic path: stats function args

`buildArithmeticExpr` has a **second caller**: `mapFunctionArg` (`splExprUtils.js`), the stats/aggregation function-argument mapper. The stats `function_arg` grammar (`spl.grammar:140-149`) uses the same flat-string build (`' ' + op + ' ' + right`), so `stats sum(bytes/1024)` works today via the same round-trip and carries the same latent string-crash fragility.

**Investigation finding — the eval and stats-arg paths are different expression languages sharing an arithmetic core:**

| | Eval | Stats function arg |
|---|---|---|
| Arithmetic `+ - * / %` with precedence | yes | yes (precedence recovered in re-parse) |
| Comparison, `AND`/`OR` | yes | no (`sum(a > b)` isn't a thing) |
| `.` / `+`-string concat | yes | no |
| Wildcard atoms (`avg(tcp.*)`) | no (rejected) | **yes** (valid metrics/mstats pattern) |
| Operand meaning | row-level value | aggregation input |

They overlap only in the arithmetic subset. They funnel through `buildArithmeticExpr` solely because both flatten to strings — not because they're one language.

## Goals

1. Eval expressions parse into typed AST nodes; no flatten/re-parse round-trip.
2. Merge eval's two internal sub-grammars (top-level arithmetic + function-args) into one expression ladder with the full SPL precedence (arithmetic + comparison + boolean + concat), so arithmetic-in-functions and comparisons-at-top-level work.
3. The stats function-arg path stays a **separate grammar** but shares the arithmetic **node type and walker case** — its outer rule keeps wildcard atoms and stays arithmetic-only. It does NOT merge into the eval ladder.
4. `buildArithmeticExpr` and the string round-trip deleted entirely.
5. `+`-with-string and `.` translate to `concat()`; `+`-with-numerics stays arithmetic.
6. No regression: the 32k corpus parse-error count and clean count hold or improve; zero new throws.

## Non-goals

- Changing NRQL emit semantics for already-working expressions (`if`/`case`/`round`/`coalesce` etc. keep their current output).
- Supporting SPL operators that don't exist (`XOR`, exponentiation, general `!x` prefix — verified absent by spl-expert).
- Rearchitecting the search-clause or where-clause grammars (separate concerns).

## Architecture

### Verified operator precedence (spl-expert, 2026-06-03)

Splunk publishes no formal precedence table. Arithmetic/paren tiers are documented; comparison/AND/OR ordering and associativity are observed convention, corroborated by this repo's existing func-arg grammar. Highest (binds tightest) to lowest:

1. Parentheses `( )`
2. Unary minus `-x` (right-assoc, trivial)
3. Multiplicative `* / %` (left)
4. Additive / concat `+ - .` (left)
5. Comparison `> < >= <= = == != LIKE` (left, non-chaining)
6. `AND` (left)
7. `OR` (left)

Notes confirmed by spl-expert: `.` is the documented concat operator; `+`-with-string is an undocumented coercion (we translate it to concat anyway since the typed grammar knows operand types). Eval comparison accepts both `=` and `==`. No `XOR`, no exponentiation, no general `!x`.

### Node types

**One new node** for arithmetic, reused by both eval and stats-arg paths:

```js
EvalArith({ op, left, right })   // op ∈ { +, -, *, /, % }
```

**Reused existing nodes** (no new types, walker cases unchanged):

- `EvalComparison{op,left,right}` — comparison + dual-check + numeric() wrapping (walker case exists)
- `EvalBoolOp{op,left,right}` — `AND`/`OR` (walker case exists)
- `StringLiteral{value}`, `EvalFunc{name,args}`, `EvalParens{inner}` (exist)

Unary minus folds into `EvalArith` as `0 - x` — no new node.

### Eval grammar ladder (replaces BOTH old chains)

Lowest → highest precedence, each level peek-and-extend (the non-backtracking shape — the grammar comments record a prior exponential-backtracking incident from the naive `A op B / A` form, which MUST NOT be reintroduced):

```
eval_expr           = eval_or
eval_or             = eval_and        (_* 'OR'  _* eval_and)*       → EvalBoolOp
eval_and            = eval_comparison (_* 'AND' _* eval_comparison)* → EvalBoolOp
eval_comparison     = eval_additive   (_* cmp_op _* eval_additive)?  → EvalComparison (non-chaining)
eval_additive       = eval_multiplicative (_* ('+' / '-' / '.') _* eval_multiplicative)* → EvalArith / concat marker
eval_multiplicative = eval_unary      (_* ('*' / '/' / '%') _* eval_unary)* → EvalArith
eval_unary          = '-' eval_atom { 0 - x }  /  eval_atom
eval_atom           = '(' eval_expr ')' { EvalParens } / eval_func_call / eval_string_literal / eval_number / field_name
```

`eval_func_call`'s args become `eval_expr` (was the separate `eval_func_arg` chain), so `round(total/count, 2)` and `if(a > b+1, ...)` parse. The `.` operator carries a marker so the walker routes it to concat.

### Stats function-arg grammar (shares the arithmetic NODE, not the rule)

`function_arg` keeps its own rule (wildcard atoms `[a-zA-Z0-9_.*\\:{}]+`, arithmetic-only, no comparison/boolean) but is rewritten to emit `EvalArith` nodes directly instead of a flat string:

```
function_arg = eval_string_literal
             / func_arg_additive
             / func_arg_atom
func_arg_additive       = func_arg_multiplicative (_* ('+' / '-') _* func_arg_multiplicative)+ → EvalArith
func_arg_multiplicative = func_arg_atom (_* ('*' / '/' / '%') _* func_arg_atom)* → EvalArith
func_arg_atom           = '(' function_arg ')' / wildcard-or-field-chars
```

Note: stats args keep their wildcard atom (`avg(tcp.*)`) — that's the divergence point that keeps the grammars separate. No comparison/boolean tier (you don't write `sum(a > b)`).

### Walker: one new arithmetic case, shared by both paths

```js
case 'EvalArith': {
  const left = walkEvalExpr(node.left, ir);
  const right = walkEvalExpr(node.right, ir);
  if (!left || !right) return null;          // loud failure, no half-built trees
  if (node.op === '+' && (isStringExpr(left) || isStringExpr(right)))
    return Func('concat', flattenConcat(left, right));
  return BinOp(node.op, numericize(left), numericize(right));
}
```

Comparison (`EvalComparison`) and boolean (`EvalBoolOp`) reuse their existing walker cases unchanged. The `.` operator produces a concat directly in the grammar action (or an `EvalArith` with `op:'.'` that the walker maps to concat) — design detail deferred to the plan.

### Helpers — verified existence (checked against src/ 2026-06-03)

| Helper | Status | Notes |
|---|---|---|
| `DualCheck`, `buildExprComparison` | **exist** | reused via existing `EvalComparison` case |
| comparison numeric() + dual-check dispatch | **exists** | the `EvalComparison` walker case already does this; reused, not rewritten |
| `Func('concat', ...)` emission | **exists** | `tryParseDotConcat` already builds concat nodes |
| `Like` pattern (`*`→`%`) | **exists** | splToIR:236, evalHandlers:435 |
| `needsNumeric` | **exists, MUST be rewritten** | currently tests raw strings (`typeof node==='string'` + regex) — the flat-string representation being deleted. Rewrite to test typed nodes: is it a bare field (`Identifier`/`Field`) vs `Literal`/`EvalFunc`. |
| `numericize(expr)` | **new (thin)** | wraps the rewritten `needsNumeric`; bare field → `numeric(field)`, else passthrough |
| `isStringExpr(expr)` | **new (thin)** | `expr.type==='Literal' && expr.kind==='string'`, or a concat `Func` |
| `flattenConcat(left,right)` | **new (thin)** | merge nested concats so `a.b.c` → `concat(a,b,c)` |

Net new code: 1 node type (`EvalArith`), 1 walker case, 3 thin helpers, 1 rewritten helper. Everything comparison/boolean/dual-check/function-related is reused.

## Migration strategy

Incremental, gated by the 32k corpus (`nr-query-bridge-corpus/enrich-corpus.mjs`) after every step. The public `spl-real-world.json` is a synthetic stub post-open-sourcing; the corpus repo is the scale regression guard. Synthetic-only test cases go in the public `spl.test.js` (no customer data).

1. **Add `EvalArith` node + walker case** alongside existing code (no grammar change). Dead code; full suite stays green. Add `numericize`/`isStringExpr`/`flattenConcat` helpers and the rewritten typed `needsNumeric`, used only by the new case.
2. **Rewrite the eval grammar ladder** to emit typed nodes; `eval_func_call` args become `eval_expr`. Rebuild parser. The old `eval_func_arg`/`eval_comparison_arg`/`eval_simple_arg` chain is removed in the same step (the new ladder subsumes it).
3. **Rewrite the stats `function_arg` grammar** to emit `EvalArith` (keeping wildcard atoms). Point `mapFunctionArg` at the typed walker.
4. **Delete `buildArithmeticExpr`**, its tokenizer, the regex-detection branch (`walkEvalExpr` ~line 182), and the flat-string `needsNumeric`.
5. **Re-enrich the corpus after each step.** Parse errors and throws must not rise; clean must not fall. The FIXME'd `+`-string cases should flip from `unsupported` to clean (`concat()`). Any clean→error or new throw stops work for investigation.

Each step is a separate commit. Steps 1–2 are the bulk; 3 can be its own commit; 4 is cleanup once nothing references the old path.

## Testing

Synthetic `verified: false` cases (humans promote later):

- **Precedence:** `a*2+b` → `(a*2)+b`; `(a+b)*c`; `a*2 > b AND c < 3` → `((a*2)>b) AND (c<3)`
- **Arithmetic in function:** `round(total/count, 2)`, `if(a > b+1, "hi", "lo")`
- **Comparison at top level:** `status >= 400`
- **Concat:** `businessDate + " "` → `concat(...)`; `a + " " + b`; `.`-concat regression (`a . b . c`)
- **Dual-check regression:** `status=500` (eval context) keeps `status='500' OR numeric(status)=500`
- **Stats arithmetic:** `sum(bytes/1024)`, `sum(a*2+b)` (precedence), `avg(tcp.*)` (wildcard atom preserved)
- **Existing eval suite** is the primary regression guard: every `if`/`case`/`round`/`coalesce`/`substr`/`replace` test must stay green (their nodes and walker cases are unchanged).

Red-green discipline: write each case, confirm it fails (or crashes) on the current code, implement, confirm green. The leading-dot and `+`-string cases already have failing/`unsupported` cases committed — convert them to expected `concat()`/arithmetic output as the steps land.

## Risks

- **Hottest expression path.** Every eval and stats-agg query flows through this. The corpus gate after each step is non-negotiable.
- **Exponential backtracking.** The peek-and-extend ladder shape is mandatory; the naive `A op B / A` form caused an O(3^n) blowup before (recorded in grammar comments). The plan must use the proven structure.
- **`needsNumeric` rewrite blast radius.** It's called from the existing `EvalComparison` case. Rewriting it to typed-node form must keep that case's output identical — covered by the existing comparison tests.
- **Stats wildcard atoms.** `avg(tcp.*)` must keep emitting `average(\`tcp.*\`)`. The stats grammar's atom class (`*`, `\`) differs from eval's; the rewrite must preserve it. Explicit regression case.
- **`=` vs `==`.** Eval accepts both; the comparison rule must map `==` → `=` (existing `EvalComparison` case already does).

## Open questions

- **`.`-concat node representation:** emit `concat` directly in the grammar action, or an `EvalArith{op:'.'}` the walker maps? Deferred to the plan; leaning grammar-action since `.` is unambiguously concat (no numeric meaning).
- **`LIKE` as eval operator vs `like()` function:** spl-expert notes both exist; the `like()` function already works. Whether to add `LIKE` as an infix operator in the ladder is low-priority — defer unless the corpus shows demand.
