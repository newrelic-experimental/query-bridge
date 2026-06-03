# Eval Typed-Node Rearchitecture Design

**Goal:** Define the SPL `eval` expression language ONCE as typed AST nodes and reference it from all four contexts where it appears, replacing four divergent partial re-implementations (three of which flatten to strings and re-parse). This eliminates a class of bugs (dropped string literals, `numeric(+)` garbage, `Identifier(undefined)` crashes) and unlocks patterns the current split grammars reject (`round(total/count, 2)`, `status >= 400`, `if(a > b+1, ...)`).

## Problem

There is **one** SPL eval expression language. It appears in four syntactic contexts. The grammar implements it **four separate times**, each a different partial subset, three of them stringly-typed:

| # | Grammar rule | Context | Operators supported | Representation |
|---|---|---|---|---|
| 1 | `eval_expr`/`eval_term`/`eval_factor` | top-level `eval x = ...` | arithmetic `+ - * / %` (with precedence) | **flat string** |
| 2 | `eval_func_arg`/`eval_comparison_arg`/`eval_simple_arg` | function args (`if(...)`, `case(...)`) | comparison, `AND`/`OR`, string literals | **typed nodes** ✓ |
| 3 | `function_arg` | stats bare args (`sum(bytes/1024)`) | arithmetic + wildcard atoms | **flat string** |
| 4 | `eval_inner_expr` | stats `fn(eval(...))` | (none — raw text capture) | **raw string** |

None of the four is complete. The typed one (#2) has comparison/boolean/strings but **no arithmetic**. The arithmetic ones (#1, #3) have **no comparison/boolean/strings**. #4 doesn't parse structure at all — it grabs balanced-paren text and re-parses downstream. They are four copies of one language that each grew a different subset.

### The string round-trip is the root cause of the eval bugs

Contexts #1, #3, #4 flatten structured input back to a string, then re-parse:

- `eval_expr` builds `result + ' ' + op + ' ' + term`; `walkEvalExpr` regex-detects operators and `buildArithmeticExpr` re-tokenizes and re-parses into IR.
- `buildArithmeticExpr`'s tokenizer regex has no string alternative, so `" "` in `businessDate + " "` vanishes; the parser reads past end-of-input and emits `Identifier(undefined)`, crashing `smartEscape` in the emitter (89 corpus queries until hardened to loud `unsupported`).
- `"a" + "b"` emits `numeric(a) + numeric(b)` — quotes stripped, string contents become phantom fields wrapped in `numeric()`.

Because the four grammars don't compose, common SPL is rejected:

- `round(total/count, 2)` → `unsupported` (#2 func-args have no arithmetic)
- `if(a > b+1, "hi", "lo")` → `unsupported` (arithmetic inside a func arg)
- `status >= 400` at top level → `unsupported` (#1 arithmetic has no comparison)

The design-decisions doc already claims #1 produces typed `EvalArith` nodes. It does not — `EvalArith` appears nowhere in `src/`. The doc describes the intended destination; the code never got there.

### Verified ground truth (do not re-litigate)

These were settled by reading primary sources during design; the plan must not regress them:

- **`+` IS string concatenation in eval.** Splunk's official eval docs (SearchReference → Eval → Operators, line ~1231) state verbatim: *"The plus ( + ) operator accepts two numbers for addition, or two strings for concatenation."* An earlier expert claim that `+`-with-string returns null was **wrong** and is contradicted by both the docs and committed customer usage. `"a" + "b"` → `"ab"`. So `+`-with-string → `concat()` is the CORRECT translation, not a coercion hack.
- **`.` is dedicated string concat** (docs line 1236): *"The period ( . ) operator concatenates both strings and number. Numbers are concatenated in their string represented form."* `.` coerces; `+` requires the operands' types to drive the choice.
- **Operator precedence is not formally published by Splunk.** Arithmetic/paren tiers are documented; comparison/`AND`/`OR`/`.` ranking and associativity are observed convention. See the precedence section for what's documented vs. inferred.
- **`NOT` is a real eval operator** (`NOT isnull(x)`, `NOT (a AND b)`) — binds tighter than `AND`/`OR`. Must be in the ladder.

## Goals

1. Define the eval expression language once as typed AST nodes; no flatten/re-parse round-trip in any context.
2. Reference the one typed grammar from all four call sites. The only per-context parameter is the **atom set** (stats args additionally allow wildcard atoms like `avg(tcp.*)`).
3. Full SPL precedence: arithmetic + comparison + boolean (incl. unary `NOT`) + concat, so arithmetic-in-functions and comparisons-at-top-level work.
4. `buildArithmeticExpr`, `eval_inner_expr`'s text-capture, and the three flat-string builders deleted.
5. `.` and `+`-with-string → `concat()`; `+`-with-numerics → arithmetic. Type is determined from operands where knowable (string literal, concat result); where unknowable (two bare fields), best-effort with an explicit gotcha (see Risks).
6. No regression: 32k corpus parse-error and clean counts hold or improve; zero new throws.

## Non-goals

- Changing NRQL emit for already-working expressions (`if`/`case`/`round`/`coalesce` keep current output).
- SPL operators that don't exist in eval: `XOR`, exponentiation (use `pow()`). Verified absent.
- Rearchitecting search-clause or where-clause grammars (separate concerns), beyond what already shares `walkEvalExpr`.

## Architecture

### Precedence ladder (documented tiers marked; rest is observed convention)

Highest (binds tightest) → lowest, all left-associative except unary:

1. Parentheses `( )` — documented
2. Unary `-x` (numeric negation), `NOT x` (boolean) — operators documented; precedence observed
3. Multiplicative `* / %` — documented tier
4. Additive `+ -` and concat `.` — `+`/`-` documented; `.` placement observed. **`.` binds at least as tight as `+`/`-`; when mixed, prefer parenthesizing in tests rather than asserting an un-verified grouping.**
5. Comparison `> < >= <= = == != LIKE` — operators documented; tier observed
6. `AND` — observed
7. `OR` — observed

`=` and `==` both valid in eval (unlike search's `=` only). No `XOR`, no exponentiation, no general `!x` prefix (only `NOT`).

### Node types

**New:**
```js
EvalArith({ op, left, right })   // op ∈ { +, -, *, /, % }; unary minus → EvalArith('-', 0, x)
EvalNot({ operand })             // boolean NOT
```

**Reused (walker cases already exist, unchanged):** `EvalComparison{op,left,right}`, `EvalBoolOp{op,left,right}` (AND/OR), `StringLiteral{value}`, `EvalFunc{name,args}`, `EvalParens{inner}`.

`.`-concat and `+`-with-string concat do not get a node — the grammar/walker route them to `Func('concat', ...)` directly (concat already emits correctly).

### How `+` chooses concat vs. arithmetic

Splunk decides per-row at runtime (`+` adds numbers, concatenates strings). We decide statically from operand types — which quotes and numeric literals resolve in three of four cases:

| Expression | Decision | Reason |
|---|---|---|
| `"a" + "b"` | concat | both quoted → strings |
| `field + " "` | concat | one quoted operand forces string context |
| `field + 5` | arithmetic | numeric literal operand |
| `field1 + field2` | **arithmetic** | no literal; type unknowable statically |

The last row is the only undecidable case. Corpus evidence settles the default: of 340 `field + field` occurrences in the 32k corpus, all observed are numeric (counts, sizes, costs — `published_count + rejected_count`, `ddas_unit_cost + SmartStore_unit_cost`). String-field concatenation in real SPL uses `.`, not `+`. So `field + field` → `numeric(f) + numeric(g)` is the evidence-backed correct default, not a reluctant compromise. `isStringExpr` returns true only for a string literal or a `concat(...)` result — exactly the quote-resolvable cases.

### One grammar, parameterized atom

The unified ladder (seeded from the existing typed #2 chain, with the arithmetic tier added):

```
eval_expr(atom)        = eval_or(atom)
eval_or(atom)          = eval_and(atom)        (_* 'OR'  _* eval_and(atom))*        → EvalBoolOp
eval_and(atom)         = eval_not(atom)        (_* 'AND' _* eval_not(atom))*        → EvalBoolOp
eval_not(atom)         = 'NOT'i _+ eval_not(atom) { EvalNot }  /  eval_comparison(atom)
eval_comparison(atom)  = eval_additive(atom)   (_* cmp_op _* eval_additive(atom))?  → EvalComparison (non-chaining)
eval_additive(atom)    = eval_multiplicative(atom) (_* ('+' / '-' / '.') _* eval_multiplicative(atom))*  → EvalArith or concat
eval_multiplicative(atom) = eval_unary(atom)   (_* ('*' / '/' / '%') _* eval_unary(atom))*  → EvalArith
eval_unary(atom)       = '-' eval_unary(atom) { EvalArith('-',0,x) }  /  atom
eval_atom_base         = '(' eval_expr(eval_atom_base) ')' { EvalParens } / eval_func_call / eval_string_literal / eval_number / field_name
eval_atom_stats        = '(' eval_expr(eval_atom_stats) ')' / eval_func_call / eval_string_literal / eval_number / wildcard_field
```

PEG can't truly parameterize a rule, so in practice this is **one shared ladder rule chain** plus **two atom rules** (`eval_atom_base`, `eval_atom_stats`); the ladder's bottom (`eval_unary`) references a single `eval_atom` that is the ordered choice `eval_atom_stats_extras? / eval_atom_base`. Implementation detail — the plan picks the exact PEG encoding. The invariant: **one ladder, atom is the only divergence.**

Each level peek-and-extend (NOT `A op B / A`) — the grammar comments record a prior O(3^n) backtracking incident from the naive form; it MUST NOT be reintroduced.

### Walker: two new cases, rest reused

```js
case 'EvalArith': {
  const left = walkEvalExpr(node.left, ir);
  const right = walkEvalExpr(node.right, ir);
  if (!left || !right) return null;            // loud failure
  return BinOp(node.op, numericize(left), numericize(right));  // %→mod() handled by emitter
}
case 'EvalNot': {
  const x = walkEvalExpr(node.operand, ir);
  return x ? Not(x) : null;
}
```

Concat (`.` and string-`+`) is produced as `Func('concat', flattenConcat(...))` in the grammar action / additive walker branch, not as an `EvalArith` node. `EvalComparison`, `EvalBoolOp`, `EvalParens`, `EvalFunc`, `StringLiteral` cases stay unchanged.

### Four call sites point at the one grammar

1. **`eval_assignment`** (top-level): `expr:eval_expr(base atom)`. Replaces `eval_expr`/`eval_term`/`eval_factor`.
2. **`eval_func_call` args**: args become `eval_expr(base atom)`. Replaces the `eval_func_arg`/`eval_comparison_arg`/`eval_simple_arg` chain — this is the seed, now with arithmetic.
3. **`function_arg`** (stats bare): `eval_expr(stats atom)` — same ladder, wildcard atom. Replaces the flat-string builder; `mapFunctionArg` consumes typed nodes.
4. **`stats fn(eval(...))`** (`eval_inner_expr`): the inner `eval(...)` body becomes `eval_expr(base atom)` instead of raw text capture. The existing `evalFilter` → `filter(count(*), WHERE ...)` emit consumes the typed tree.

### Helpers — verified existence (checked against src/ 2026-06-03)

| Helper | Status |
|---|---|
| `DualCheck`, `buildExprComparison`, comparison numeric()+dual-check dispatch | exist (in `EvalComparison` case) — reused |
| `Func('concat', ...)`, `Not(...)`, `Like` `*`→`%` | exist — reused |
| `needsNumeric` | exists, **MUST be rewritten** from raw-string/regex form to typed-node form (is operand a bare field?) |
| `numericize(expr)` | new (thin) — wraps rewritten `needsNumeric` |
| `isStringExpr(expr)` | new (thin) — `Literal kind 'string'` or concat `Func`; drives `+`→concat |
| `flattenConcat(left,right)` | new (thin) — merge nested concats → `concat(a,b,c)` |

Net new: 2 node types (`EvalArith`, `EvalNot`), 2 walker cases, 3 thin helpers, 1 rewritten helper.

## Migration strategy

Incremental, gated by the 32k corpus (`nr-query-bridge-corpus/enrich-corpus.mjs`) after every step. The public `spl-real-world.json` is a synthetic stub post-open-sourcing; the corpus repo is the scale regression guard. Synthetic-only test cases (no customer data) go in the public `spl.test.js`.

1. **Add nodes + walker cases** (`EvalArith`, `EvalNot`) and helpers (`numericize`, `isStringExpr`, `flattenConcat`, rewritten typed `needsNumeric`) alongside existing code. Dead until the grammar emits them; full suite stays green.
2. **Build the unified ladder** in the grammar (seed from the existing typed #2 chain; add arithmetic, unary `NOT`, concat routing, two atom variants). Don't wire call sites yet — add it as new rules.
3. **Wire call site #2** (`eval_func_call` args → unified ladder). Removes the old `eval_func_arg` chain. Re-enrich; `round(total/count,2)`, `if(a>b+1,...)` should flip to clean.
4. **Wire call site #1** (top-level `eval_assignment`). Removes `eval_expr`/`eval_term`/`eval_factor`. Re-enrich; `status>=400`, `businessDate + " "`→concat should flip to clean.
5. **Wire call site #3** (stats `function_arg`, stats atom). `mapFunctionArg` consumes typed nodes. Re-enrich; `avg(tcp.*)` must still emit `average(\`tcp.*\`)`.
6. **Wire call site #4** (stats `fn(eval(...))` inner → unified ladder, base atom). Removes `eval_inner_expr` text-capture.
7. **Delete** `buildArithmeticExpr`, its tokenizer, the regex-detection branch in `walkEvalExpr`, and the old flat-string `needsNumeric`. Nothing should reference them.

Each step is a separate commit gated by: corpus parse-errors and throws must not rise; clean must not fall; no command bucket regresses. Any clean→error or new throw stops work.

## Testing

Synthetic `verified: false` cases (humans promote later). Assert the ACTUAL emitted NRQL string (capture via `node bin/spl2nrql.js`), not SPL-grouping notation.

- **Precedence:** `a*2+b`, `(a+b)*c`, `a*2 > b AND c < 3`
- **Arithmetic in function:** `round(total/count, 2)`, `if(a > b+1, "hi", "lo")`
- **Comparison at top level:** `status >= 400`
- **Unary NOT:** `if(NOT isnull(x), 1, 0)`, `NOT (a AND b)`
- **Concat (`.` and `+`):** `a . " " . b`; `businessDate + " "` → `concat(businessDate, ' ')`; `a + " " + b`
- **`+` numeric stays arithmetic:** `f + g` → `numeric(f) + numeric(g)`
- **Modulo:** `a % b` → `mod(...)` (emitter rewrites `%`; assert the `mod()` output, not infix `%`)
- **Dual-check regression:** `eval` `status=500` keeps `status='500' OR numeric(status)=500`
- **Stats:** `sum(bytes/1024)`, `sum(a*2+b)` (precedence), `avg(tcp.*)` (wildcard atom), `sum(eval(if(status>=400,1,0)))` (eval nested in stats arg)
- **`==` mapping:** `if(x==1,...)` → `=`
- **Existing eval suite** is the primary regression guard: every `if`/`case`/`round`/`coalesce`/`substr`/`replace` test must stay green (nodes/walker cases unchanged).

## Risks

- **Hottest expression path.** Every eval and stats-agg query flows through this. Corpus gate after each step is non-negotiable.
- **Exponential backtracking.** Peek-and-extend ladder is mandatory; the naive `A op B / A` form caused O(3^n) blowup before (grammar comments). Plan must use the proven structure.
- **`needsNumeric` rewrite blast radius.** Called from the existing `EvalComparison` case; rewriting to typed-node form must keep that case's output identical (existing comparison tests cover it).
- **Stats wildcard atoms.** `avg(tcp.*)` must keep emitting `average(\`tcp.*\`)`; the stats atom's char class (`*`, `\`) differs from base. Explicit regression case.
- **PEG rule "parameterization".** PEG has no real rule parameters; the "one ladder, two atoms" invariant is encoded via an ordered-choice atom rule. If that proves awkward, the fallback is two near-identical ladders sharing the walker — acceptable, since the duplication-elimination win is mostly in the walker/nodes, not the grammar rules. Plan decides.

## Open questions

- **`.`-concat node vs. grammar-action concat:** emit `Func('concat')` in the additive grammar action, or carry an `EvalArith{op:'.'}` the walker maps? Leaning grammar-action since `.` is unambiguously concat. Plan decides.
- **`LIKE` as an infix eval operator:** spl-expert confirms it's real (not only `like()`). Adding it to the comparison tier is low-cost; include if the corpus shows demand, else defer.
- **`IN` inside eval** (`if(status IN (400,500), ...)`): spl-expert flagged it exists. Out of scope for this spec unless corpus demand is high; note for a follow-up.
