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
import { walkEvalExpr } from './evalHandlers.js';
// Circular import — safe because translateAstToIR is only called at runtime
import { translateAstToIR } from './splToIR.js';
import * as parser from './splParser.js';

import { normalizeSubsearch } from './splExprUtils.js';

export function handleJoin(cmd, ir) {
  if (cmd.joinType === 'outer') {
    ir.unsupported.push(
      'NRQL does not support full outer join; only INNER and LEFT joins are available',
    );
    return;
  }

  let subIR;
  try {
    const subAst = parser.parse(normalizeSubsearch(cmd.subsearch));
    subIR = translateAstToIR(subAst);
  } catch (e) {
    ir.unsupported.push(`join subsearch could not be parsed: ${e.message}`);
    return;
  }

  for (const w of subIR.warnings) ir.warnings.push(`join subsearch: ${w}`);
  for (const u of subIR.unsupported)
    ir.unsupported.push(`join subsearch: ${u}`);

  const key = Identifier(cmd.field);
  const joinType = (cmd.joinType || 'inner').toUpperCase();

  // NRQL requires the join key in FACET, not SELECT.
  // If the subsearch used table/fields (explicit SELECT, no FACET),
  // move the join key from SELECT to FACET.
  let subSelect = subIR.select.length > 0 ? subIR.select : [Wildcard()];
  let subFacet = subIR.facet;
  if (subFacet.length === 0) {
    // Remove join key from SELECT if present, add to FACET
    subSelect = subSelect.filter(
      (s) => !(s.type === 'Identifier' && s.name === cmd.field),
    );
    if (subSelect.length === 0) subSelect = [Wildcard()];
    subFacet = [key];
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
  ir.warnings.push(
    'NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit',
  );
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
    ir.unsupported.push(
      `appendpipe subsearch could not be parsed: ${e.message}`,
    );
    return;
  }

  // Pattern 1: empty result guard — the sub-pipeline just checks if count==0
  // This is a no-op in NRQL (empty results are handled natively)
  const isEmptyGuard =
    subIR.select.some(
      (s) => s.type === 'Function' && s.name === 'count' && s.args.length === 0,
    ) && subIR.where;

  if (isEmptyGuard) {
    ir.warnings.push(
      'appendpipe empty-result guard ignored; NRQL handles empty results natively',
    );
    return;
  }

  // Pattern 2: totals/summary row — the sub-pipeline aggregates current results
  // We can't append a row, but we note the aggregation intent
  ir.warnings.push(
    'appendpipe adds summary rows to results; NRQL cannot append rows to a query. ' +
      'The sub-pipeline aggregation is available as a nested query, but the "append as new row" behavior must be handled by the UI.',
  );
}

export function handleAppend(cmd, ir, label) {
  // Parse and translate the subsearch
  let subIR;
  try {
    const subAst = parser.parse(normalizeSubsearch(cmd.subsearch));
    subIR = translateAstToIR(subAst);
  } catch (e) {
    ir.unsupported.push(`${label} subsearch could not be parsed: ${e.message}`);
    return;
  }

  // Forward subsearch warnings/unsupported
  for (const w of subIR.warnings) ir.warnings.push(`${label} subsearch: ${w}`);
  for (const u of subIR.unsupported)
    ir.unsupported.push(`${label} subsearch: ${u}`);

  // Both sides must have aggregations to merge
  if (ir.select.length === 0 || subIR.select.length === 0) {
    ir.unsupported.push(
      `${label} with subsearch cannot be automatically translated; consider using filter() to compute multiple aggregations in a single query`,
    );
    return;
  }

  // Check FACET compatibility
  const mainFacetStr = ir.facet.map((f) => f.name || '').join(',');
  const subFacetStr = subIR.facet.map((f) => f.name || '').join(',');

  if (mainFacetStr !== subFacetStr) {
    ir.unsupported.push(
      `${label} with subsearch cannot be automatically translated; the main query and subsearch group by different fields`,
    );
    return;
  }

  // Same WHERE → just merge SELECT lists
  // Different WHERE → wrap each in filter()
  const mainWhere = ir.where;
  const subWhere = subIR.where;

  if (exprsEqual(mainWhere, subWhere)) {
    for (const s of subIR.select) ir.select.push(s);
    ir.warnings.push(
      `${label} merged into a single query; SPL append runs the subsearch independently, but here both sides query the same events`,
    );
  } else {
    // Wrap each SELECT expression in filter(expr, WHERE condition)
    ir.select = ir.select.map((s) => wrapInFilter(s, mainWhere));
    for (const s of subIR.select) {
      ir.select.push(wrapInFilter(s, subWhere));
    }
    ir.where = null;
    ir.warnings.push(
      `${label} translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log`,
    );
  }
}

function wrapInFilter(selectExpr, whereCondition) {
  if (!whereCondition) return selectExpr;
  // If the expression is aliased, wrap the inner part in filter
  if (selectExpr.type === 'Alias') {
    return Alias(
      Func('filter', [selectExpr.expr, whereCondition]),
      selectExpr.name,
    );
  }
  return Func('filter', [selectExpr, whereCondition]);
}

function exprsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function handleInputlookup(cmd, ir) {
  ir.dataSource = { type: 'Lookup', name: cmd.table };
  ir.warnings.push(
    `Ensure lookup table '${cmd.table}' is uploaded via the Lookups UI`,
  );
  if (cmd.where) {
    const whereExpr = walkEvalExpr(cmd.where, ir);
    if (whereExpr) {
      ir.where = ir.where ? BinOp('AND', ir.where, whereExpr) : whereExpr;
    }
    ir.warnings.push(
      'inputlookup WHERE condition translated as-is; verify field names match the lookup table schema',
    );
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
  ir.warnings.push(
    `Ensure lookup table '${cmd.table}' is uploaded via the Lookups UI`,
  );
}
