# Key Design Decisions

Architectural choices that affect how code should be written and modified.

> **This file is where shipped specs graduate.** When a `docs/superpowers/` spec/plan ships, its durable *invariants* (things a future edit could violate) move here as one-liners; the spec/plan is then deleted (git history is the archive). Before deleting any shipped spec/plan, confirm its invariants are captured below — distill, don't archive. The build narrative (alternatives weighed, corpus counts, "how we got here") dies with the spec; only the load-bearing rule survives. Retiring a spec is a good moment to run `/nr:reflect`.

## IR & Optimization
- **DualCheck IR node**: `SPL: status=500` → `DualCheck` node → expanded by optimizer to `status = '500' OR numeric(status) = 500`. Consolidates dual-check logic from 2 call sites into 1 expansion pass.
- **Subquery wrapping**: Stats-after-stats wraps as `SubquerySource`. `wrapAsSubquery` carries expand/timeseries into inner query and clears _fieldReplacements.
- **WHERE as condition list**: `ir.where` is `IRNode[]`, not a single tree. Handlers `push()` conditions; emitter joins with AND. No null checks needed.
- **Field replacement scoping**: `applyFieldReplacements` only replaces in select/where/facet/orderBy — NOT in bindings/expand/dataSource. Prevents corrupting WITH/EXPAND source expressions.

## Expression Walking
- **Walker composition**: `walkExpr(node, ir, resolveFunc)` is the shared core. `walkEvalExpr` uses `resolveEvalFunc` (eval context — string ops, conditionals, multivalue functions), `walkStatsExpr` uses `resolveStatsFunc` (stats context — sum/count/avg are aggregation functions). Same tree walking, different function-call semantics.
- **Eval expression representation (SHIPPED)**: One unified typed ladder (`u_expr` and below in `spl.grammar`). All four call sites — eval func args, top-level eval assignment, stats function args, and stats `fn(eval(...))` inner — reference `u_expr` directly. The grammar produces typed `EvalArith`/`EvalBoolOp`/`EvalComparison`/`EvalNot` nodes; `walkEvalExpr` handles them in a switch. No flat-string round-trip; `buildArithmeticExpr` and `tryParseDotConcat` deleted. The `u_atom_stats_extra` rule handles stats wildcard tokens (`count(*)`, `app.*`) with a `![0-9]` guard to prevent `a*2` from being swallowed as a wildcard.
- **Stats vs eval `sum()`**: In stats context, `sum(x)` is aggregation (via `resolveStatsFunc`). In eval context, `sum(x)` is multivalue sum on one event (via `resolveEvalFunc`). The walker strategy parameter handles this.

## EXPAND (mvexpand Translation)
- **EXPAND is Limited Preview**: Not GA — only use when no alternative exists. For simple array membership, prefer `contains(jparse(...))`.
- **Grammar**: `by_field` rule detects `{}` in field names, producing `ArrayField` nodes with `array` and `subfield` properties.
- **Naming**: `field_parsed` for jparse WITH bindings, `field_expanded` for EXPAND aliases. No leading underscores (NRQL rejects them). Alias must differ from WITH binding name.
- **Clause ordering**: NRQL requires `FROM ... WITH ... EXPAND ... SELECT`. WITH before EXPAND (EXPAND references WITH aliases). Inline expressions in EXPAND fail — always WITH-bind first.
- **Cascading**: Second mvexpand wraps current query as subquery, adds new EXPAND to outer. `wrapAsSubquery` carries expand into inner query.

## Emitter & Encoding
- **Smart backticking**: Only backtick identifiers with dots/dashes/spaces/colons/curlies. Simple names bare. Macros (`$name`) pass through.

## Messages & Pipeline
- **Message catalog**: All user-facing messages in `src/messages.js`. Handlers call `messages.key()` — no inline template literals. `splExprUtils.js` uses lazy getters for `resolveStatsFunc` warnings so spies work. Bidirectional consistency test in `test/messages.test.js`.
- **Pipeline-level detection**: `splToIR.js` tracks state across the pipeline loop (dedup seen, mvexpand fields) and emits warnings after the loop (capture count, FACET LIMIT default, cascading/cross-field mvexpand). Individual handlers don't have pipeline context.
