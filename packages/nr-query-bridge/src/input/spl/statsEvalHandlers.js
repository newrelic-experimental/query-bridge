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
import { mapFunction, isAggregateFuncName } from './splExprUtils.js';
import { isFoldSafe, NRQL_AGG_FUNCS } from '../../ir/foldPostAggregation.js';

// Walk results are bare expressions (Function / BinOp / Literal / Identifier) —
// alias wrapping happens in handleStats AFTER this, so no Alias node ever reaches
// here.
export function isNrqlAggregate(expr) {
  if (!expr) return false;
  if (expr.type === 'Function')
    return NRQL_AGG_FUNCS.has(expr.name) || expr.args.some(isNrqlAggregate);
  if (expr.type === 'BinOp')
    return isNrqlAggregate(expr.left) || isNrqlAggregate(expr.right);
  return false;
}

// A bare event-field reference (Identifier) sitting OUTSIDE an aggregate — e.g.
// the `offset` in `sum(x) + offset`. NRDB rejects an aggregate combined with a
// row-level event field in one SELECT expression ("Value must be constant in
// its context" — verified on staging), so such a metric has no valid NRQL form.
// A field INSIDE an aggregate (the `x` in sum(x)) is consumed by the aggregate
// and is not free. Used with isNrqlAggregate: agg + free field → unsupported.
export function hasFreeFieldRef(expr) {
  if (!expr) return false;
  if (expr.type === 'Identifier') return true;
  if (expr.type === 'BinOp')
    return hasFreeFieldRef(expr.left) || hasFreeFieldRef(expr.right);
  if (expr.type === 'Function') {
    if (NRQL_AGG_FUNCS.has(expr.name)) return false; // args consumed by the aggregate
    return expr.args.some(hasFreeFieldRef); // fold-safe fn: a field arg is still free
  }
  return false; // Literal and other constant leaves
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
      // Gate on isAggregateFuncName first: calling mapFunction on a non-aggregate
      // (upper/mvjoin/…) would fire an unknown_stats_func warning as a side effect,
      // even though the whole bare-eval() metric is already heading to unsupported.
      if (isAggregateFuncName(node.name)) {
        const { expr, warning } = mapFunction(node.name, node.args);
        if (expr && isNrqlAggregate(expr)) {
          if (warning) ir.warnings.push(warning);
          return expr;
        }
      }
      return null; // non-fold-safe, non-aggregate (concat/lower/upper/numeric/mvjoin/…)
    }
    default:
      // EvalComparison / EvalBoolOp / EvalNot — not a numeric stats metric
      return null;
  }
}
