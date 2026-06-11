# Where-Clause Comparison RHS Design

**Supersedes** `docs/superpowers/specs/2026-06-04-where-func-rhs-design.md`. That earlier spec framed the change as "allow a function call on the RHS." Expert review + MCP validation (2026-06-10) showed the RHS of an SPL `where` comparison is a full eval expression (field, arithmetic, function, parens — all of which NRQL accepts), so the correct model is "the comparison RHS is the existing `u_expr` eval ladder," with the function case as one branch. The verified findings and the `_time`→SINCE/UNTIL design carry forward from the old spec unchanged; the organizing idea is wider.

**Goal:** Let SPL `where` comparisons carry an arithmetic/function/field expression on the right-hand side — `where _time < relative_time(now(), "-1d")`, `where bytes > round(total/100, 2)`, `where a > b`, `where pct > total/100` — all of which fail to parse today. Translate the `_time`-vs-relative-time family to NRQL `SINCE`/`UNTIL`; translate every other comparison to a `BinOp` whose RHS is a walked eval expression. Never emit non-compiling NRQL: anything without a valid NRQL form fails loud (`unsupported`).

The RHS rule is the **`u_add`** tier of the eval ladder, NOT the full `u_expr`. The ladder is a single precedence-climbing chain — `u_expr → u_or → u_and → u_not → u_cmp → u_add → u_mul → u_unary → u_atom` — where each tier adds one operator level and defers the rest to the next tier down (composed, not duplicated; each tier defined once). `u_add` is the highest tier that covers arithmetic, function calls, parens, literals, and bare fields while EXCLUDING the comparison tier (`u_cmp`) and the boolean tiers (`u_or`/`u_and`). Pointing the RHS at `u_add` keeps `AND`/`OR`/comparison with the OUTER where-expression (see Architecture + Risks) — without it, `where a > b AND c < d` would let the RHS greedily eat the `AND`.

## Problem

`where_comparison`'s RHS is only a bare `where_value` (a flat token/string grabber). A function call, a second field used structurally, or an arithmetic expression on the RHS all fail at the first unexpected character:

```
where _time < relative_time(now(), "-1d")   → parse error at "("
where bytes > round(total/100, 2)            → parse error at "("
where a > b + 1                              → parse error at "+"
where in_bytes > out_bytes                   → parses, but as a literal "out_bytes" string (semantically a bareword, not a field reference)
```

This is the single largest parse-error root cause in the corpus: `relative_time(` alone appears in **196** error-bucket queries, and `"("` is the largest failed-token bucket (**344**; mixed causes, so 196 is the firmer per-feature number). Measured 2026-06-03 against the 32k corpus.

The SPL expert (2026-06-10) confirmed the RHS in SPL `where` is a full eval-language expression — identical grammar to the LHS — and explicitly recommended modeling it as the existing `u_expr` node. Real-world frequency order: literal ≫ function (time math, coalesce) > field-to-field ≈ arithmetic > infix LIKE > if/case.

### Verified NRQL constraints (executed against account 1; the design pivots on these)

**Relative-time filtering has exactly ONE mechanism — `SINCE`/`UNTIL`. No valid inline-WHERE form exists.** (2026-06-03)

| Query | Result |
|---|---|
| `WHERE timestamp < now()` | FAILURE — `Not supported: Call ... now` |
| `WHERE numeric(created) < now()` | FAILURE — same |
| `WHERE timestamp > 1 day ago` | FAILURE — `unexpected 'day'` |
| `WHERE timestamp < (now() - 86400000)` | FAILURE — `Not supported: BinOp SUBTRACT ... now` |
| `SINCE now` | FAILURE — `start time must be before its end time` (so `_time >= now()` can't emit a valid clean clause) |
| `SINCE 6 hours ago UNTIL 1 hour ago` | SUCCESS — two-sided window valid |
| `UNTIL now SINCE 2 hours ago` | SUCCESS — `_time < now()` → `UNTIL now`; SINCE/UNTIL order-independent |
| `SINCE 1717200000000 UNTIL 1717221600000` (epoch ms) | SUCCESS |
| `SINCE '2026-06-01 00:00:00'` (datetime string) | SUCCESS |
| `FROM Transaction SINCE 7 days ago` | SUCCESS |

**Comparison-RHS forms — what NRQL accepts after `>` `<` `=` etc.** (2026-06-10, `FROM Transaction`, 30-min windows)

| RHS form | Example | NRQL |
|---|---|---|
| literal | `duration > 0.5` | ✓ |
| field-to-field | `duration > databaseDuration` | ✓ |
| arithmetic expr | `duration > (databaseDuration + 1)` | ✓ |
| function (row-wise) | `duration > round(databaseDuration, 2)` | ✓ |
| function (unimplemented in row-wise eval) | `duration > convert(databaseDuration,'ms','s')` | ✗ `Not supported: Call convert` |
| aggregator (bare) | `duration > average(duration)` | ✗ `Not supported: Call average` |
| aggregator (subquery) | `duration > (SELECT average(duration) FROM Transaction)` | ✓ |
| infix `LIKE` literal | `name LIKE 'Web%'` | ✓ |
| infix `LIKE` function | `name LIKE lower(host)` (pattern from a field — unfoldable) | ✗ `unexpected 'lower'` |
| infix `LIKE` field ref | `name LIKE host` | ✗ `unexpected 'host'` |
| infix `RLIKE` literal | `name RLIKE 'Web.*'` | ✓ |
| infix `RLIKE` function | `request.uri RLIKE concat(host, '.*')` (regex from a field — unfoldable) | ✗ `unexpected 'concat'` |
| infix `RLIKE` field ref | `request.uri RLIKE host` | ✗ `unexpected 'host'` |
| `IN` **subquery** | `host IN (SELECT uniques(host) FROM Transaction WHERE error IS true)` | ✓ |
| `IN` function in list | `host IN (concat('web','01'), 'web02')` | ✗ `unsupported expression in the IN clause: concat(...)` |

So: the **comparison-operator RHS** accepts field / arithmetic / function → model it as `u_add` (the eval ladder's arithmetic tier; see Architecture for why not the full `u_expr`). But not *every* function works: NRQL's row-wise evaluator only implements some of the documented non-aggregator functions. `round`/`numeric`/`concat`/`mod`/`substring`/etc. evaluate per-row and work; `jparse`/`convert`/`cidrAddress`/`toTimestamp`/`decode`/`encode`/`mapKeys`/`mapValues`/`lookup`/`blob` return `Not supported: Call <fn>` in WHERE (and `Unknown function <fn>()` in a bare SELECT — same gap, different message). **Quick test, no list:** if `SELECT fn(x)` returns a value per row, `fn` is RHS-safe; if it returns `Unknown function`, it isn't → `unsupported`. **Aggregators** (`average`/`sum`/`max`/`percentile`/...) are never valid bare on the RHS, but a **subquery RHS works** (`op (SELECT agg(...) FROM <source>)`). Full verified ✓/✗ table: `.claude/references/nrql-reference.md` → "Functions on a WHERE comparison RHS".

**`LIKE`/`RLIKE` RHS is effectively a string-literal slot** — not a constant-folding limit: the parser rejects a function (`lower`/`concat`/`string` all fail identically) or even a bare field (`host`) at that position. (It does also admit a `{{template-var}}`, which resolves to a literal at bind time — see the reference's template-variable section — but no field/function/expression.) The realistic motivation for a non-literal RHS — a pattern or regex derived from another field — is genuinely unfoldable, which is exactly why NRQL's flat rejection matters. **`IN` is asymmetric:** a *subquery* RHS works (`IN (SELECT ...)`), but a scalar *function* in the value list fails (`unsupported expression in the IN clause`) — the constraint is about which expression *kind* the grammar admits per position, not about folding.

**Type behavior (not a validity rule):** NRQL never rejects a comparison or `LIKE`/`RLIKE` on operand *type* — everything compiles. Mismatch is silent: a numeric field vs a string literal yields 0 matches (the reason for DualCheck), two strings compare lexicographically (`'10' < '9'` is true), and `LIKE` on a numeric field matches nothing unless wrapped in `string(...)`. So the LHS-`numeric()` coercion in Path 2b (below) is about getting *numeric* comparison semantics, not about passing a type check. (Validate NRQL against `FROM Log` only with windows ≤ 6h; larger Log windows time out on volume, which looks like an error but isn't a syntax failure.)

## Goals

1. Parse `where field <comparison-op> <eval-expr>` by making the comparison RHS the existing `u_add` tier of the eval ladder (covers literal / field / arithmetic / function / parens in one rule; excludes the comparison and boolean tiers, which stay with the outer where-expression).
2. Translate `_time op relative_time(now(), "offset")` and `_time op now()` to `SINCE`/`UNTIL` via the existing `parseSplTime` + IR `since`/`until` + emitter (all already exist).
3. Translate every other comparison to `BinOp(op, lhs, walkEvalExpr(rhs))`, reusing the eval walker and its loud-failure.
4. Keep `LIKE`/`RLIKE`/`IN` RHS literal-only (NRQL rejects functions there — verified).
5. Never emit non-compiling NRQL. Any RHS without a valid NRQL form → `unsupported`.
6. Reduce the corpus parse-error bucket (target: ~196 `relative_time(` queries + field/arithmetic/function RHS comparisons); zero new throws; clean must not fall.

## Non-goals

- Changing `parseSplTime`'s existing snap or token behavior (the `earliest=`/`latest=` path depends on it; see Risks). The snap-policy unification (FIXME #4) and the silent-wrong token-passthrough bug are owned by spec B — `docs/superpowers/specs/2026-06-10-dashboard-time-tokens-HANDOFF.md`. This spec only consumes `parseSplTime` for the LITERAL offset inside `relative_time(now(), "<offset>")`, never a token.
- Widening `LIKE`/`RLIKE`/`IN` RHS to expressions — NRQL rejects functions there (verified).
- Supporting `now()`/`N units ago` as inline WHERE values — NRQL rejects them (verified).
- Touching `where_func_comparison` (function-on-LEFT) — it already works.

## Architecture

### Grammar change

`where_comparison` today:
```
where_comparison
  = field:field_name _+ 'like'i _+ value:where_value
    { return { type: 'Comparison', field, operator: 'like', value }; }
  / field:field_name _* op:comparison_op _* value:where_value
    { return { type: 'Comparison', field, operator: op, value }; }
```

Change ONLY the comparison-operator alternative's RHS from `where_value` to `u_add`. The `like` alternative is untouched (LIKE RHS stays a literal `where_value` — NRQL rejects a function there):
```
where_comparison
  = field:field_name _+ 'like'i _+ value:where_value
    { return { type: 'Comparison', field, operator: 'like', value }; }
  / field:field_name _* op:comparison_op _* rhs:u_add
    { return { type: 'Comparison', field, operator: op, rhsExpr: rhs }; }
  / field:field_name _* op:comparison_op _* value:where_value
    { return { type: 'Comparison', field, operator: op, value }; }
```

Three alternatives, ordered most-specific-first:
1. `like` (unchanged).
2. **NEW:** `field op u_add` → attaches a typed eval node as `rhsExpr`.
3. Bare `field op where_value` → kept as a FALLBACK for RHS forms `u_add` can't parse (e.g. unquoted barewords with special chars that aren't valid eval atoms). `u_add` is tried first; if it fails, the flat `where_value` grabber still catches it as today. This preserves existing plain-value behavior with zero regression — any `where status = foo` that parses today still parses.

`u_add` is the arithmetic tier of the eval ladder (grammar line ~596, shipped in the eval rearchitecture). It returns typed nodes: `EvalArith`, `EvalFunc`/`FunctionCall`, `StringLiteral`, bare field strings, `EvalParens` (a parenthesized `u_expr` re-enters the top of the ladder). Reused as-is; no new rule. **Why `u_add` and not `u_expr`:** the ladder is one precedence-climbing chain (`u_expr → u_or → u_and → u_not → u_cmp → u_add → ...`), each tier composed on the next. `u_expr` includes the boolean tiers (`u_or`/`u_and`) and the comparison tier (`u_cmp`); `u_add` is the highest tier that stops below them. So `u_add` admits arithmetic/functions/parens/fields but NOT `AND`/`OR`/comparison — leaving those for the outer where-expression to split (see Risks).

> **Ordering matters.** The `u_add` alternative must come BEFORE the bare `where_value` alternative so `where a > b + 1` parses structurally instead of `where_value` grabbing `b` and choking on `+`. But `where_value` must REMAIN as the final fallback so values `u_add` rejects (odd barewords) still parse. A bare field like `where a > b` parses via `u_add` as an `Identifier('b')` — structurally a field reference, which is what we want (field-to-field).

### Walker: branch on `rhsExpr` in the `Comparison` case (`splToIR.js`)

When a `Comparison` node has `rhsExpr` (the new typed-node shape):

**Path 1 — time-window.** `LHS field is _time` AND `rhsExpr` is a function node named `relative_time` or `now`:
- `relative_time(now(), "<offset>")` → confirm arg0 is a `now()` call; extract arg1 literal `"<offset>"`. If arg0 is NOT `now()` (a field/absolute anchor) → `unsupported` (FIXME #1: `relative_time(field,...)` is a per-event row-wise value, can't be a static SINCE/UNTIL — confirmed by spl-expert).
- Operator → clause: `_time > t` is a LOWER bound → `ir.since`; `_time < t` → UPPER bound → `ir.until` (`>=`/`<=` map the same; SPL-strict vs NRQL-inclusive boundary is sub-second on `_time`, immaterial).
- Run offset through `parseSplTime(offset)` → `{nrql, warning}`, set `ir.since`/`ir.until`, push any warning (snap-approximation surfaces here).
- **`now()` RHS:** `_time < now()` / `<= now()` → `ir.until = 'now'` (normal "up to now"). `_time > now()` / `>= now()` → `unsupported` (future lower bound matches no historical events; clean `SINCE now` doesn't even compile — verified — and would hide the empty result; FIXME #3). `_time = now()` / `!= now()` → `unsupported` (FIXME #3, point-in-time).
- If `ir.since`/`ir.until` was ALREADY set (by `earliest=`/`latest=` or a prior `where _time`) → warn that multiple time constraints collapsed (last-writer-wins). **Caveat (spl-expert):** real SPL *intersects* multiple time bounds (tightest wins); NRQL has only one SINCE/UNTIL pair, so collapsing is forced, but last-writer-wins can pick the LOOSER bound and silently widen results. The warning surfaces this; choosing the tighter bound (or `unsupported`) would be more correct. Deferred — the warning is the safety net for now.
- Emit NO `BinOp` — the constraint is a clause. Return null.

**Path 2 — everything else** (`field op <expr>` that isn't the `_time`+relative-time case):
- **2a — `rhsExpr` is `now`/`relative_time` but LHS is NOT `_time`** (e.g. `where created < now()`): `unsupported`. No valid inline NRQL (verified). FIXME #2.
- **2b — any other `rhsExpr`** (field, arithmetic, ordinary function): `const rhs = walkEvalExpr(rhsExpr, ir)`. If null → walker already pushed `unsupported`; bail. Else `BinOp(op, lhs, rhs)`, mirroring the existing `FuncComparison` numeric-coercion (numeric ordering ops wrap the LHS field in `numeric()`; the RHS is the walked expr as-is — a bare field RHS becomes `numeric(field)` under an ordering op, matching the LHS treatment).
  - **Gate (was FIXME #8, now implemented):** `walkEvalExpr` maps an SPL function to a NRQL `Func` node without knowing whether that NRQL function is implemented in the row-wise evaluator. If the RHS maps to one of the unimplemented set (`jparse`/`convert`/`cidrAddress`/`toTimestamp`/`toDatetime`/`decode`/`encode`/`mapKeys`/`mapValues`/`lookup`/`blob`), the emitted NRQL would be `op <fn>(...)` which NRQL rejects at parse time (`Not supported: Call <fn>` — MCP-verified: `> jparse(...)` fails). Per expert review, this feature is the first to route arbitrary eval functions onto a where-RHS, so it MUST gate them rather than ship non-compiling output. Path 2b walks the returned RHS subtree for any `Function` node in the unimplemented set and pushes `unsupported` if found. (Implementation: plan Task 6.)

When a `Comparison` node has `value` (no `rhsExpr`, matched the fallback) → existing code path, untouched.

### Data flow

- Time-window writes `ir.since`/`ir.until`; emitter already renders them (`irToNrql.js:282` SINCE, `:285` UNTIL). No emitter change.
- Path 2 pushes a `BinOp` to `ir.where`.
- `parseSplTime` reused unchanged (literal offsets only here).

### Helpers — existence verified (against src/ 2026-06-10)

| Helper / field | Status |
|---|---|
| `u_add` tier + typed nodes (`EvalArith`/`EvalFunc`/`StringLiteral`/parens/field) | exist (shipped eval rearchitecture). Reused as the RHS rule + walked by `walkEvalExpr`. |
| `walkEvalExpr` | exists — walks typed nodes, loud-fails on untranslatable. Reused for Path 2b. |
| `parseSplTime` | exists — literal offset → NRQL relative time. Reused (literal only). |
| `ir.since`/`ir.until` + emitter SINCE/UNTIL | exist (`irToNrql.js:282/285`). Reused. |
| `FuncComparison` walker (function-on-LEFT) | exists (`splToIR.js:250`) — Path 2b mirrors its coercion. |

Net new: one grammar alternative (RHS = `u_add`), one `rhsExpr` branch in the `Comparison` walker (Path 1 + 2a/2b), a few message entries. No new IR nodes, no emitter change, no `parseSplTime` change.

## Deferred gaps (FIXME-tracked)

1. `relative_time(<non-now> anchor, ...)` → `unsupported`. Per-event row-wise value, never a static window bound (spl-expert). Likely permanent.
2. Non-`_time` field vs `now()`/`relative_time` (Path 2a) → `unsupported`. No inline NRQL relative-time form exists (verified).
3. `_time = now()` / `!= now()` and `_time >/>= now()` (future lower bound) → `unsupported`. Point-in-time / empty-result cases.
4. `where _time` snap-to-time (`@d`,`@w`,`@h`) — inherits `parseSplTime`'s existing approximate-and-warn (this spec does NOT change `parseSplTime`). spl-expert: `-1d@d` = "start of yesterday"; dropping `@d` shifts the bound LATER by up to 24h, GROWING the window — a real defect, and NRQL CAN express the calendar boundary (`UNTIL '<date> 00:00:00'`). **Decision (2026-06-10): keep the inherited warn-and-approximate here; the proper snap fix (loud-unsupported or calendar-boundary emission, unified with the `earliest`/`latest` snap policy) is owned by spec B, which is being done IMMEDIATELY after this feature.** This spec does not touch the snap path, so it neither improves nor regresses it.
5. Two-sided `where _time >= X AND _time < Y` → `SINCE X UNTIL Y` (verified valid). Common dashboard idiom; this spec covers only one-sided. Deferred.
6. `LIKE`/`RLIKE`/`IN` with a function/expression RHS → stays unsupported-as-today. NRQL's LIKE/RLIKE RHS is a literal-only slot (rejects any non-literal — function or bare field — with `unexpected '<token>'`); `IN` accepts a subquery but not a scalar function in the value list (`unsupported expression in the IN clause`). All verified 2026-06-10. Out of scope.
7. Dashboard time tokens in time context → spec B (see Non-goals).
8. **RESOLVED in this spec (plan Task 6), not deferred.** RHS function that maps to a NRQL function NOT implemented in the row-wise evaluator (`jparse`/`convert`/`cidrAddress`/`toTimestamp`/`toDatetime`/`decode`/`encode`/`mapKeys`/`mapValues`/`lookup`/`blob`) → emitted `op <fn>(...)` would fail NRQL parse (`Not supported: Call <fn>`, MCP-verified). Gated to `unsupported` at the walker. STILL DEFERRED: an aggregator RHS (`> average(...)`) is not rewritten to a subquery (`op (SELECT agg(...) FROM <source>)`) here — bare aggregators on a where-RHS are rare from SPL and fall to the `walkEvalExpr` loud-failure path; subquery-RHS rewrite is future work. See `.claude/references/nrql-reference.md` for the verified ✓/✗ set and the `SELECT fn(x)` probe.

## Testing

Synthetic `verified: false` cases (humans promote). Assert ACTUAL emitted NRQL (capture via `bin/spl2nrql.js`). Validate emitted SINCE/UNTIL + BinOp NRQL compiles via MCP (≤6h windows on `FROM Log`, or `FROM Transaction`).

- **Time-window (valid):** `where _time > relative_time(now(), "-7d")` → `... SINCE 7 days ago`; `where _time < relative_time(now(), "-1d")` → `... UNTIL 1 day ago`; `where _time < now()` → `... UNTIL now`; snap `where _time < relative_time(now(), "-1d@d")` → `UNTIL 1 day ago` + snap warning.
- **Time-window unsupported:** `where _time >= now()` / `> now()` → unsupported (FIXME #3); `where _time = now()` → unsupported (FIXME #3); `where _time > relative_time(eventField, "-1d")` → unsupported (FIXME #1).
- **Field-to-field (NEW, Path 2b):** `where in_bytes > out_bytes` → `WHERE numeric(in_bytes) > numeric(out_bytes)` (capture exact — confirm coercion matches FuncComparison).
- **Arithmetic RHS (NEW, Path 2b):** `where a > b + 1` → `WHERE numeric(a) > numeric(b) + 1`; `where pct > total/100` → capture exact.
- **Function RHS (Path 2b):** `where bytes > round(total/100, 2)`; `where y > mvzip(a,b)` → unsupported (walkEvalExpr loud-fail).
- **Non-_time relative-time (2a):** `where created < now()` → unsupported (FIXME #2).
- **Conflict:** `where _time > relative_time(now(), "-7d")` plus an `earliest=...` → warning that constraints collapsed.
- **Regression (critical — RHS widening touches every comparison):** plain-value `where status > 200`, `where status = foo`, `where x like "%y%"` unchanged; `where_func_comparison` (func-on-LEFT) cases green; `where status IN (400,500)` unchanged; `earliest=`/`latest=` path unchanged (parseSplTime untouched).
- **Corpus gate:** parse-error bucket falls (target ~196 relative_time + field/arith/function RHS); `threw` stays 0; clean must not fall; no command bucket regresses.

## Risks

- **RHS widening to `u_add` is the big one.** EVERY `where field op X` now tries `u_add` first. The fallback `where_value` alternative bounds the regression (anything `u_add` rejects still parses as today), but the corpus gate after this change is non-negotiable, and `clean` must not fall. This is a wider blast radius than a function-only RHS — accepted because it's the correct model and reuses shipped code.
- **`parseSplTime` is shared with `earliest`/`latest`.** Not modified here. The `where _time` path inherits its snap behavior; FIXME #4 / spec B own the fix. Do NOT change `parseSplTime` in this work.
- **Grammar ordering.** `u_add` alternative MUST precede the bare `where_value` fallback (so arithmetic parses structurally), and `where_value` MUST remain last (so odd barewords still parse). A bare `now` without parens is a `where_value`, not a function — confirm with a regression test (`where status = now`).
- **Boolean/comparison swallowing — resolved by tier choice.** Using `u_add` (not `u_expr`) is precisely what prevents the RHS from eating the outer `AND`/`OR`/comparison: `u_add` has no boolean or comparison tier, so `where_and_expr`/`where_or_expr` split the top-level `AND`/`OR` before the RHS is parsed. Had the RHS been `u_expr`, `where a > b AND c < d` would greedily parse as `a > (b AND (c < d))`. Regression test `where a > b AND c < d` guards this — if it ever emits a nested boolean inside the RHS, the grammar tier regressed back toward `u_expr`.
