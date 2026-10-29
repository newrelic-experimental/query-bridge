/**
 * ORDER BY on an aggregation.
 *
 * NRDB honors ORDER BY only on a non-aggregating result; on an aggregation it is
 * ignored (rows are ranked by the first aggregate, descending) and the dashboard
 * widget engine rejects it. This late pass — registered AFTER the post-aggregation
 * fold — detects an ORDER BY landing on an aggregation and either drops the
 * redundant implicit order or marks it unsupported. (Subquery-restructure for the
 * faithful-but-non-redundant orders is added in a follow-up.)
 */
import { isAggregateExpr, exposedNameOf } from './foldPostAggregation.js';
import { messages } from '../messages.js';

// ORDER BY lands on an aggregation when the top-level result groups (FACET) or
// selects an aggregate. A row-wise outer over a subquery (SELECT host, count AS
// pct, or SELECT * WHERE …) has neither, so ORDER BY is honored there → false.
function landsOnAggregation(ir) {
  if (ir.facet.length > 0) return true;
  return ir.select.some(isAggregateExpr);
}

// Exposed name of the first aggregate in the query's own SELECT (count → 'count',
// avg(x) as a → 'a', …); null when there is none.
function firstAggregateName(ir) {
  const agg = ir.select.find(isAggregateExpr);
  return agg ? exposedNameOf(agg) : null;
}

// True when ORDER BY is exactly the implicit faceted ranking — DESC by the first
// aggregate — which NRDB already returns, so the clause is redundant.
function isImplicitFacetOrder(ir) {
  if (!ir.orderBy?.descending) return false;
  const f = ir.orderBy.field;
  return f?.type === 'Identifier' && f.name === firstAggregateName(ir);
}

export function orderByOnAggregationPass(ir) {
  // Skip queries already failed elsewhere (a prior pass / handler pushed
  // unsupported) — never pile a second diagnosis on the same query.
  if (!ir.orderBy || ir.unsupported.length > 0 || !landsOnAggregation(ir)) {
    return ir;
  }

  // tail/reverse after an aggregation: SPL slices/flips a stats-specific row order
  // NRDB does not define. No faithful form → loud unsupported.
  if (ir._orderByKind === 'tail') {
    ir.unsupported.push(messages.order_tail_after_aggregation());
    return ir;
  }
  if (ir._orderByKind === 'reverse') {
    ir.unsupported.push(messages.order_reverse_after_aggregation());
    return ir;
  }

  // Non-faceted single-row aggregation (stats count): nothing to order. Drop the
  // no-op — left in place, SELECT count(*) ORDER BY count DESC is widget-rejected.
  if (ir.facet.length === 0) {
    ir.orderBy = null;
    return ir;
  }

  // Faceted aggregation: drop the redundant implicit order; anything else is not
  // faithfully expressible yet → unsupported (the follow-up restructures it).
  if (isImplicitFacetOrder(ir)) {
    ir.orderBy = null;
    return ir;
  }
  ir.unsupported.push(
    messages.order_on_aggregation_unsupported(
      ir.orderBy.field?.name ?? 'the requested field',
    ),
  );
  return ir;
}
