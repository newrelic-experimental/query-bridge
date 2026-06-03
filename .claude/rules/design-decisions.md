# Key Design Decisions

Architectural choices that affect how code should be written and modified.

## IR & Optimization
- **DualCheck IR node**: `SPL: status=500` → `DualCheck` node → expanded by optimizer to `status = '500' OR numeric(status) = 500`. Consolidates dual-check logic from 2 call sites into 1 expansion pass.
- **Subquery wrapping**: Stats-after-stats wraps as `SubquerySource`. `wrapAsSubquery` carries expand/timeseries into inner query and clears _fieldReplacements.
- **WHERE as condition list**: `ir.where` is `IRNode[]`, not a single tree. Handlers `push()` conditions; emitter joins with AND. No null checks needed.
- **Field replacement scoping**: `applyFieldReplacements` only replaces in select/where/facet/orderBy — NOT in bindings/expand/dataSource. Prevents corrupting WITH/EXPAND source expressions.

## Expression Walking
- **Walker composition**: `walkExpr(node, ir, resolveFunc)` is the shared core. `walkEvalExpr` uses `resolveEvalFunc` (eval context — string ops, conditionals, multivalue functions), `walkStatsExpr` uses `resolveStatsFunc` (stats context — sum/count/avg are aggregation functions). Same tree walking, different function-call semantics.
- **Eval expression representation (KNOWN DEBT)**: `eval_expr`/`eval_term`/`eval_factor` currently flatten to a string that `buildArithmeticExpr` re-parses — NOT typed `EvalArith` nodes. This string round-trip causes a recurring bug class (dropped string literals, `Identifier(undefined)` crashes) and four divergent partial eval grammars. Planned rearchitecture to one typed eval grammar: `docs/superpowers/specs/2026-06-03-eval-typed-nodes-design.md`. `stats_function` supports bare `eval(expr)` as a top-level alternative.
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
