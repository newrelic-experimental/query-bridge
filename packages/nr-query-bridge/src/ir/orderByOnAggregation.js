/**
 * ORDER BY on an aggregation.
 *
 * NRDB honors ORDER BY only on a non-aggregating result; on an aggregation it is
 * ignored (rows are ranked by the first aggregate, descending) and the dashboard
 * widget engine rejects it. This late pass — registered AFTER the post-aggregation
 * fold — detects an ORDER BY landing on an aggregation and applies one of three
 * outcomes: drop the redundant implicit order, restructure into a faithful subquery,
 * or mark it unsupported when no faithful NRDB form exists.
 */
import { wrapAsSubquery } from '../input/spl/splExprUtils.js';
import { Identifier } from './nodes.js';
import {
  isAggregateExpr,
  exposedNameOf,
  duplicateExposedName,
  extractNonScalar,
} from './foldPostAggregation.js';
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

// The FACET-defaults-to-10 warning (splToIR Gap #12) is deferred to this pass for any
// ORDER BY that lands on a faceted aggregation, because the outcome decides whether it
// applies. A flat faceted result (drop / unsupported) keeps the default-10 behavior →
// warn; the successful subquery restructure gives the inner LIMIT MAX → it does not.
function warnFacetDefaultLimit(ir) {
  if (ir.facet.length > 0 && ir.limit == null) {
    ir.warnings.push(messages.facet_default_limit());
  }
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
    warnFacetDefaultLimit(ir);
    ir.unsupported.push(messages.order_tail_after_aggregation());
    return ir;
  }
  if (ir._orderByKind === 'reverse') {
    warnFacetDefaultLimit(ir);
    ir.unsupported.push(messages.order_reverse_after_aggregation());
    return ir;
  }

  // Non-faceted single-row aggregation (stats count): nothing to order. Drop the
  // no-op — left in place, SELECT count(*) ORDER BY count DESC is widget-rejected.
  if (ir.facet.length === 0) {
    ir.orderBy = null;
    return ir;
  }

  // Faceted aggregation: drop the redundant implicit order; anything else is
  // restructured into a faithful subquery (the outer is row-wise → ORDER BY honored).
  if (isImplicitFacetOrder(ir)) {
    warnFacetDefaultLimit(ir);
    ir.orderBy = null;
    return ir;
  }
  return restructureForOrderBy(ir);
}

// Wrap the flat faceted aggregation in a subquery and order on the (row-wise) outer,
// which NRDB honors. The outer projects the inner's exposed columns; ORDER BY then
// selects the real top/bottom-N. Faithful up to the 5000-row subquery cap.
function restructureForOrderBy(ir) {
  // Inner aggregates expose bare names (count, average, …); a collision silently
  // keeps the last, so a sort key could read the wrong column. Fail loud. The result
  // is a flat faceted aggregation (no restructure), so the FACET default-10 applies.
  const collision = duplicateExposedName(ir);
  if (collision) {
    warnFacetDefaultLimit(ir);
    ir.unsupported.push(messages.subquery_name_collision(collision));
    return ir;
  }
  // The outer projects each inner column BY NAME, so every facet key must be a bare
  // Identifier (a fillnull/eval-substituted facet like `duration OR 0` has no clean
  // column name) and every aggregate must expose a name. No faithful name to order
  // on → loud unsupported (never a crash or a name-less SELECT).
  const aggregates = ir.select.filter(isAggregateExpr);
  const facetIsNameable = ir.facet.every((f) => f.type === 'Identifier');
  const aggsAreNameable = aggregates.every((a) => exposedNameOf(a) != null);
  if (!facetIsNameable || !aggsAreNameable) {
    warnFacetDefaultLimit(ir);
    ir.unsupported.push(
      messages.order_on_aggregation_unsupported(
        ir.orderBy.field?.name ?? 'the requested expression',
      ),
    );
    return ir;
  }
  const facetKeys = ir.facet.map((f) => Identifier(f.name));
  const aggCols = aggregates.map((a) => Identifier(exposedNameOf(a)));
  // Only facet keys and SCALAR aggregates can be ordered; median/percentile/uniques
  // expose keyed objects/lists (ordering by one is silently wrong → unsupported).
  const sortable = new Set([
    ...facetKeys.map((f) => f.name),
    ...aggregates.filter((a) => extractNonScalar(a) == null).map(exposedNameOf),
  ]);
  const sortKey =
    ir.orderBy.field?.type === 'Identifier' ? ir.orderBy.field.name : null;
  if (!sortKey || !sortable.has(sortKey)) {
    // No faithful form → flat faceted aggregation stands; the default-10 applies.
    warnFacetDefaultLimit(ir);
    ir.unsupported.push(
      messages.order_on_aggregation_unsupported(
        sortKey ?? 'the requested expression',
      ),
    );
    return ir;
  }
  wrapAsSubquery(ir); // select/facet/where → inner (LIMIT MAX); outer keeps orderBy + limit
  ir.select = [...facetKeys, ...aggCols];
  // The inner now carries LIMIT MAX, so the FACET-defaults-to-10 warning does not
  // apply (the outer is not faceted) — splToIR deferred it to here and we skip it.
  // The 5000-row subquery result cap is the new bound; warn about that instead.
  ir.warnings.push(
    messages.subquery_facet_cap(facetKeys.map((f) => f.name).join(', ')),
  );
  return ir;
}
