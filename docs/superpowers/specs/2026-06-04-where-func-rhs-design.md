# Where-Clause Function-RHS Design

**Goal:** Let SPL `where` comparisons carry a function call on the right-hand side — `where _time < relative_time(now(), "-1d")` and `where bytes > round(total/100, 2)` — which today fail to parse. Translate the `_time`-vs-relative-time family to NRQL `SINCE`/`UNTIL`, and ordinary `field op func(...)` to a `BinOp`. Everything without a valid NRQL form fails loud (`unsupported`), never emits non-compiling NRQL.

## Problem

The `where` grammar accepts a function call on the LEFT of a comparison (`where round(a/b,2) > 5`, via `where_func_comparison`) but the RIGHT side of `where_comparison` is only a bare `where_value` — no function call. So the parser chokes at the `(`:

```
where _time < relative_time(now(), "-1d")   → parse error at "("
where _time < now()                          → parse error at "("
where bytes > round(total/100, 2)            → parse error at "("
```

This is the single largest parse-error root cause in the corpus: `relative_time(` alone appears in **196** error-bucket queries, and the `"("` failed-token bucket is **344** queries (the largest). (Measured 2026-06-03 against the 32k-query corpus; the `"("` bucket also contains unrelated causes, so 196 is the firmer number for this feature's target.)

### Verified NRQL constraint (the design pivot)

Relative-time filtering in NRQL has exactly ONE mechanism: the `SINCE`/`UNTIL` clauses. There is no valid inline-WHERE form. Verified by executing against account 1 (2026-06-03):

| Query | Result |
|---|---|
| `FROM Log SELECT count(*) WHERE timestamp < now()` | FAILURE — `Not supported: Call ... now` |
| `FROM Log SELECT count(*) WHERE numeric(created) < now()` | FAILURE — same |
| `FROM Log SELECT count(*) WHERE timestamp > 1 day ago` | FAILURE — `unexpected 'day'` |
| `FROM Log SELECT count(*) WHERE created < 1 day ago` | FAILURE — `unexpected 'day'` |
| `FROM Log SELECT count(*) WHERE timestamp < (now() - 86400000)` | FAILURE — `Not supported: BinOp SUBTRACT ... now` |
| `FROM Log SELECT count(*) WHERE created < now() SINCE 7 days ago` | FAILURE — `now()` still rejected inline |
| `FROM Transaction SELECT count(*) SINCE 7 days ago` | SUCCESS (count returned) |

So `now()` is rejected inline everywhere in WHERE (bare, `numeric()`-wrapped, epoch arithmetic, even with a SINCE present), and `N days ago` is not a valid inline RHS value. `SINCE`/`UNTIL` is the only path. This is why `_time` comparisons MUST become `SINCE`/`UNTIL` and why any relative-time comparison that can't map to those clauses is `unsupported`, not a `BinOp`. (Note: validate NRQL against `FROM Log` with windows ≤ 6h — larger Log windows time out on volume, which looks like an error but isn't a syntax failure.)

## Goals

1. Parse `where field op <function-call>` (one grammar widening reusing the existing `where_function_call` rule).
2. Translate `_time op relative_time(now(), "offset")` and `_time op now()` to `SINCE`/`UNTIL` via the existing `parseSplTime` + IR `since`/`until` + emitter (all already exist).
3. Translate ordinary `field op func(...)` to a `BinOp`, reusing `walkEvalExpr` and its loud-failure.
4. Never emit non-compiling NRQL. Any relative-time comparison without a valid `SINCE`/`UNTIL` mapping → `unsupported`.
5. Reduce the corpus parse-error bucket (target: the ~196 `relative_time(` queries plus general func-RHS), zero new throws, clean must not fall.

## Non-goals

- Changing `parseSplTime`'s existing snap behavior (the `earliest=`/`latest=` path depends on it; see Risks).
- Supporting `now()`/`N days ago` as inline WHERE values — NRQL rejects them (verified above).
- Touching `where_func_comparison` (function-on-LEFT) — it already works.

## Architecture

### Grammar change (the only one)

`where_comparison` currently:
```
where_comparison
  = field:field_name _+ 'like'i _+ value:where_value
    { return { type: 'Comparison', field, operator: 'like', value }; }
  / field:field_name _* op:comparison_op _* value:where_value
    { return { type: 'Comparison', field, operator: op, value }; }
```

Add a function-call RHS alternative BEFORE the bare-value one (more specific — requires `name(` — so no ambiguity; the `(` disambiguates, no backtracking risk):
```
where_comparison
  = field:field_name _+ 'like'i _+ value:where_value
    { return { type: 'Comparison', field, operator: 'like', value }; }
  / field:field_name _* op:comparison_op _* rhsFunc:where_function_call
    { return { type: 'Comparison', field, operator: op, rhsFunc }; }
  / field:field_name _* op:comparison_op _* value:where_value
    { return { type: 'Comparison', field, operator: op, value }; }
```

`where_function_call` already exists and returns `{ type: 'FunctionCall', name, args }`. The new alternative attaches it as `rhsFunc` (a distinct key from `value`, so the walker can tell them apart). No new rule.

### Walker: branch on `rhsFunc` in the `Comparison` case (`splToIR.js`)

When a `Comparison` node has `rhsFunc`:

**Path 1 — time-window.** `LHS field is _time` AND `rhsFunc.name` is `relative_time` or `now`:
- `now()` → offset string `"now"`.
- `relative_time(now(), "<offset>")` → confirm arg0 is a `now()` call; extract arg1 string `"<offset>"`. If arg0 is NOT `now()` (a field or absolute anchor) → `unsupported` (FIXME: support later).
- Run the offset through `parseSplTime(offset)` → `{ nrql, warning }`.
- Operator → clause: `>` / `>=` → `ir.since = nrql`; `<` / `<=` → `ir.until = nrql`.
- `=` / `!=` → `unsupported` (FIXME: point-in-time equality is figure-out-able later).
- Push `parseSplTime`'s warning if present (this is where snap-approximation surfaces).
- If `ir.since`/`ir.until` was ALREADY set (e.g. by `earliest=`/`latest=` or a prior `where _time`) → push a warning that multiple time constraints collapsed (last-writer-wins).
- Emit NO `BinOp` — the constraint is a clause, not a WHERE term. Return null (the handler adds nothing to `ir.where`).

**Path 2 — general function RHS.** Any other `field op func(...)`:
- **2a — `rhsFunc` is `now`/`relative_time` but LHS is NOT `_time`** (e.g. `where created < now()`): `unsupported`. Verified: no valid inline NRQL. (FIXME: revisit if NRQL gains inline relative-time.)
- **2b — `rhsFunc` is an ordinary function** (`round`, `pow`, `abs`, ...): `const rhs = walkEvalExpr(rhsFunc, ir)`. If null → `walkEvalExpr` already pushed `unsupported`; bail (return null). Else build `BinOp(op, lhs, rhs)` mirroring the existing `FuncComparison` numeric-coercion logic:
  - numeric ordering ops wrap the LHS field in `numeric()`;
  - the RHS is the walked function expression as-is.

When a `Comparison` node has `value` (no `rhsFunc`) → existing code path, untouched.

### Data flow

- Time-window writes `ir.since` / `ir.until`. The emitter already renders these (`irToNrql.js:282` `SINCE`, `:285` `UNTIL`). No emitter change.
- General func RHS pushes a `BinOp` to `ir.where` as today.
- `parseSplTime` is reused unchanged — it already parses `-7d`, `@d`, `-1d@d`, `now`, and returns NRQL relative-time strings + snap warnings.

### Helpers — existence verified (against src/ 2026-06-03)

| Helper / field | Status |
|---|---|
| `parseSplTime(str)` (`splTime.js`) | exists — parses offsets + snap, returns `{nrql, warning}`. Reused as-is. |
| `ir.since` / `ir.until` + emitter `SINCE`/`UNTIL` | exist (`irToNrql.js:282/285`). Reused. |
| `where_function_call` grammar rule | exists — returns `{type:'FunctionCall',name,args}`. Reused for RHS. |
| `walkEvalExpr` | exists — walks func nodes, loud-fails on untranslatable. Reused for Path 2b. |
| `FuncComparison` walker (function-on-LEFT) | exists (`splToIR.js:250`) — Path 2b mirrors its numeric-coercion logic. |
| `messages.*` for new unsupported/warning strings | new entries needed (see below). |

Net new: ~1 grammar alternative, one `rhsFunc` branch in the `Comparison` walker (2 sub-paths), a few message-catalog entries. No new IR nodes, no emitter change, no `parseSplTime` change.

## Deferred gaps (all loud `unsupported` now, FIXME-tracked)

1. `relative_time(<non-now> anchor, ...)` — field/absolute-timestamp anchor.
2. Non-`_time` field vs `now()`/`relative_time` (Path 2a) — pending any inline NRQL relative-time form.
3. `_time = now()` / `!= now()` — point-in-time equality.
4. `where _time` snap-to-time — currently inherits `parseSplTime` approximate-and-warn; should become loud-unsupported to match the project's fail-loud principle, and unified with the `earliest`/`latest` snap policy.

## Testing

Synthetic `verified: false` cases (humans promote). Assert ACTUAL emitted NRQL (capture via `bin/spl2nrql.js`). Validate emitted `SINCE`/`UNTIL` NRQL compiles via MCP (≤6h windows on `FROM Log`).

- **Time-window:** `where _time > relative_time(now(), "-7d")` → `... SINCE 7 days ago`; `where _time < relative_time(now(), "-1d")` → `... UNTIL 1 day ago`; `where _time >= now()` → `... SINCE now` (capture exact); snap `where _time < relative_time(now(), "-1d@d")` → `UNTIL 1 day ago` + snap warning.
- **Time-window unsupported:** `where _time = now()` → unsupported (FIXME #3); `where _time > relative_time(eventField, "-1d")` → unsupported (FIXME #1).
- **General BinOp (2b):** `where bytes > round(total/100, 2)`; `where x < pow(2, n)`; `where y > mvzip(a,b)` → unsupported (walkEvalExpr loud-fail).
- **Non-_time relative-time (2a):** `where created < now()` → unsupported (FIXME #2).
- **Conflict:** `where _time > relative_time(now(), "-7d")` in a query that also has `earliest=...` → warning that time constraints collapsed.
- **Regression:** existing `where_func_comparison` (func-on-LEFT) cases stay green; plain-value `where status > 200` and `where x like "%y%"` unchanged; `earliest=`/`latest=` path unchanged (parseSplTime untouched).
- **Corpus gate:** parse-error bucket falls (target ~196 relative_time queries + general func-RHS); `threw` stays 0; clean must not fall; no command bucket regresses.

## Risks

- **`parseSplTime` is shared with `earliest`/`latest`.** This spec does NOT modify it. The `where _time` path inherits its snap behavior (approximate + warn). FIXME #4 tracks unifying to loud-unsupported later. Do not change `parseSplTime` in this work — regressing `earliest`/`latest` is the bigger risk.
- **Grammar ordering.** The `rhsFunc` alternative must come before the bare-`where_value` alternative (more specific first). Peek-and-extend is not needed here (single optional alternative, `(` disambiguates), but the ordering matters — a bare value like `now` without parens must still fall through to `where_value`.
- **`now` as a bare field name.** `where status = now` (no parens) is a plain value comparison, not a function — the `where_function_call` rule requires `(`, so `now` bare correctly falls to `where_value`. Confirm with a regression test.
- **Hottest filter path.** Every `where` comparison flows through this case. Corpus gate after the change is non-negotiable; clean must not fall.
