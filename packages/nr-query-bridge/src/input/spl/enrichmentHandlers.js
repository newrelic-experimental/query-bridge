/**
 * Enrichment command handlers.
 *
 * Handlers for SPL commands that combine data from multiple sources:
 * join, append, appendcols, appendpipe, lookup, inputlookup.
 */
import {
  SelectQuery,
  Identifier,
  BinOp,
  Func,
  Alias,
  Wildcard,
  JoinClause,
} from '../../ir/nodes.js';
import { translateWhereExpr } from './evalHandlers.js';
// Circular import — safe because translateAstToIR is only called at runtime
import { translateAstToIR } from './splToIR.js';
import * as parser from './splParser.js';
import { messages } from '../../messages.js';

import { normalizeSubsearch } from './splExprUtils.js';

export function handleJoin(cmd, ir) {
  if (cmd.joinType === 'outer') {
    ir.unsupported.push(messages.join_outer_unsupported());
    return;
  }

  let subIR;
  try {
    const subAst = parser.parse(normalizeSubsearch(cmd.subsearch));
    subIR = translateAstToIR(subAst);
  } catch (e) {
    ir.unsupported.push(messages.join_parse_failed(e.message));
    return;
  }

  for (const w of subIR.warnings)
    ir.warnings.push(messages.join_subsearch_warning(w));
  for (const u of subIR.unsupported)
    ir.unsupported.push(messages.join_subsearch_unsupported(u));

  const key = Identifier(cmd.field);
  const joinType = (cmd.joinType || 'inner').toUpperCase();

  // Two patterns for join subqueries:
  // Pattern A (raw): subsearch has no aggregation → SELECT fields as-is, no FACET
  // Pattern B (aggregated): subsearch has stats → move join key to FACET, wrap in latest()
  let subSelect = subIR.select.length > 0 ? subIR.select : [Wildcard()];
  let subFacet = subIR.facet;
  if (subFacet.length === 0) {
    // Reject wildcard-only or empty SELECT — need explicit fields
    const hasWildcard = subSelect.some((s) => s.type === 'Wildcard');
    if (subSelect.length === 0 || hasWildcard) {
      ir.unsupported.push(messages.join_needs_fields());
      return;
    }

    if (subIR._hasAggregation) {
      // Pattern B (aggregated): move join key to FACET, wrap bare fields in latest()
      subSelect = subSelect.filter(
        (s) => !(s.type === 'Identifier' && s.name === cmd.field),
      );
      subSelect = subSelect.map((s) => {
        if (s.type === 'Identifier') {
          return Alias(Func('latest', [s]), s.name);
        }
        return s;
      });
      subFacet = [key];
    }
    // Pattern A (raw): keep SELECT as-is, no FACET — subFacet stays empty
  }

  ir.join = JoinClause(
    SelectQuery({
      dataSource: subIR.dataSource,
      bindings: subIR.bindings,
      select: subSelect,
      where: subIR.where,
      facet: subFacet,
      limit: subIR.limit || 'MAX',
    }),
    key,
    joinType,
  );
  ir.warnings.push(messages.join_cardinality_limit());
}

export function handleAppendpipe(cmd, ir) {
  // appendpipe forks current results and runs a sub-pipeline on the copy.
  // Common patterns:
  //   1. Empty result guard: appendpipe [stats count | where count==0] — no-op in NRQL
  //   2. Totals row: appendpipe [stats sum(count) as total | eval status="TOTAL"]
  //      → translatable as nested aggregation, but the "append as new row" part
  //        has no NRQL equivalent. The aggregation itself is expressible.

  // Parse the sub-pipeline to understand what it does
  let subIR;
  try {
    const subAst = parser.parse(normalizeSubsearch(cmd.subsearch));
    subIR = translateAstToIR(subAst);
  } catch (e) {
    ir.unsupported.push(messages.appendpipe_parse_failed(e.message));
    return;
  }

  // Pattern 1: empty result guard — the sub-pipeline just checks if count==0
  // This is a no-op in NRQL (empty results are handled natively)
  const isEmptyGuard =
    subIR.select.some(
      (s) => s.type === 'Function' && s.name === 'count' && s.args.length === 0,
    ) && subIR.where.length > 0;

  if (isEmptyGuard) {
    ir.warnings.push(messages.appendpipe_empty_guard());
    return;
  }

  // Pattern 2: totals/summary row — the sub-pipeline aggregates current results
  // We can't append a row, but we note the aggregation intent
  ir.warnings.push(messages.appendpipe_row_append());
}

export function handleAppend(cmd, ir, label) {
  // Parse and translate the subsearch
  let subIR;
  try {
    const subAst = parser.parse(normalizeSubsearch(cmd.subsearch));
    subIR = translateAstToIR(subAst);
  } catch (e) {
    ir.unsupported.push(messages.append_parse_failed(label, e.message));
    return;
  }

  // Forward subsearch warnings/unsupported
  for (const w of subIR.warnings)
    ir.warnings.push(messages.append_subsearch_warning(label, w));
  for (const u of subIR.unsupported)
    ir.unsupported.push(messages.append_subsearch_unsupported(label, u));

  // Both sides must have aggregations to merge
  if (ir.select.length === 0 || subIR.select.length === 0) {
    ir.unsupported.push(messages.append_no_agg(label));
    return;
  }

  // Check FACET compatibility
  const mainFacetStr = ir.facet.map((f) => f.name || '').join(',');
  const subFacetStr = subIR.facet.map((f) => f.name || '').join(',');

  if (mainFacetStr !== subFacetStr) {
    const mainDesc = mainFacetStr || '(none)';
    const subDesc = subFacetStr || '(none)';
    ir.unsupported.push(
      messages.append_facet_mismatch(label, mainDesc, subDesc),
    );
    return;
  }

  // Same WHERE → just merge SELECT lists
  // Different WHERE → wrap each in filter()
  const mainWhere = ir.where;
  const subWhere = subIR.where;

  if (exprsEqual(mainWhere, subWhere)) {
    for (const s of subIR.select) ir.select.push(s);
    ir.warnings.push(messages.append_merged(label));
  } else {
    // Wrap each SELECT expression in filter(expr, WHERE condition)
    ir.select = ir.select.map((s) => wrapInFilter(s, mainWhere));
    for (const s of subIR.select) {
      ir.select.push(wrapInFilter(s, subWhere));
    }
    ir.where = [];
    ir.warnings.push(messages.append_filter_warning(label));
  }
}

function wrapInFilter(selectExpr, whereConditions) {
  if (whereConditions.length === 0) return selectExpr;
  // Join multiple conditions into a single AND tree for filter()
  const condition = whereConditions.reduce((acc, w) => BinOp('AND', acc, w));
  // If the expression is aliased, wrap the inner part in filter
  if (selectExpr.type === 'Alias') {
    return Alias(Func('filter', [selectExpr.expr, condition]), selectExpr.name);
  }
  return Func('filter', [selectExpr, condition]);
}

function exprsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function handleInputlookup(cmd, ir) {
  ir.dataSource = { type: 'Lookup', name: cmd.table };
  ir.warnings.push(messages.lookup_upload_reminder(cmd.table));
  if (cmd.where) {
    const whereExpr = translateWhereExpr(cmd.where, ir);
    if (whereExpr) {
      ir.where.push(whereExpr);
    }
    ir.warnings.push(messages.inputlookup_where_warning());
  }
}

export function handleLookup(cmd, ir) {
  // lookup table keyField [AS eventField] [OUTPUT outField1, outField2]
  // Translate as subquery JOIN on the key field
  // NRQL JOIN requires the join key to be produced by FACET in the subquery
  const eventField = cmd.keyAlias || cmd.key;
  const lookupKey = cmd.key;
  const outputFields = cmd.outputFields || [];
  const selectExprs =
    outputFields.length > 0
      ? outputFields.map((f) =>
          f.alias ? Alias(Identifier(f.name), f.alias) : Identifier(f.name),
        )
      : [Wildcard()];
  const subquery = SelectQuery({
    dataSource: { type: 'Lookup', name: cmd.table },
    select: selectExprs,
    facet: [Identifier(lookupKey)],
    limit: 'MAX',
  });
  const join = JoinClause(subquery, Identifier(eventField));
  // When lookup key differs from event field (username AS user), store both
  if (lookupKey !== eventField) {
    join.onLookupKey = Identifier(lookupKey);
  }
  ir.join = join;
  ir.warnings.push(messages.lookup_upload_reminder(cmd.table));
}
