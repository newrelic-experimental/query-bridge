/**
 * Aggregation command handlers.
 *
 * Handlers for SPL commands that collapse rows into summaries:
 * stats, timechart, chart, top, rare, table, eventstats.
 */
import {
  SelectQuery,
  Identifier,
  BinOp,
  Func,
  Alias,
  Wildcard,
  RawNrql,
  OrderBy,
  JoinClause,
} from '../../ir/nodes.js';
import { mapFunction, formatSpan, wrapAsSubquery } from './splExprUtils.js';
import { walkEvalExpr } from './evalHandlers.js';

export function handleStats(cmd, ir) {
  // If already aggregated, wrap current IR as a subquery source
  if (ir._hasAggregation && ir.select.length > 0) {
    wrapAsSubquery(ir);
  } else if (ir.select.length > 0) {
    // Non-aggregation select (e.g., from table/fields) — clear it
    ir.select = [];
    ir.facet = [];
  }

  ir.select = [];
  ir.facet = [];

  for (const fn of cmd.functions) {
    if (fn.evalFilter) {
      // count(eval(expr)) → filter(count(*), WHERE expr)
      const filterCondition = walkEvalExpr(fn.evalFilter, ir);
      const filterExpr = Func(
        'filter',
        [Func('count', []), filterCondition].filter(Boolean),
      );
      const expr = fn.alias ? Alias(filterExpr, fn.alias) : filterExpr;
      ir.select.push(expr);
      continue;
    }

    const mapped = mapFunction(fn.name, fn.args);
    if (mapped.warning) ir.warnings.push(mapped.warning);
    if (mapped.expr) {
      const expr = fn.alias ? Alias(mapped.expr, fn.alias) : mapped.expr;
      ir.select.push(expr);
    }
  }

  if (cmd.groupBy.length > 0) {
    ir.facet = cmd.groupBy.map(Identifier);
  }

  ir._hasAggregation = true;
}

export function handleTimechart(cmd, ir) {
  handleStats(cmd, ir);
  ir.timeseries = cmd.span ? formatSpan(cmd.span) : 'AUTO';
}

export function handleTop(cmd, ir) {
  // count(*) with optional alias from countfield
  const countExpr = cmd.countfield
    ? Alias(Func('count', []), cmd.countfield)
    : Func('count', []);
  ir.select = [countExpr];

  // Percent column: count(*) * 100.0 / (SELECT count(*) FROM Log [WHERE ...])
  // TODO: consider emitting NRQL's native percentage(count(*), WHERE cond) when
  //   the pattern fits. Currently we always emit the manual subquery division.
  //   Source: splunk-to-nr migration guide (docs/references/splunk-to-nr-migration-guide.md)
  //   Feasibility unclear — percentage() only works for "percentage of total matching
  //   a condition", not for arbitrary ratio calculations like eventstats patterns.
  if (cmd.showperc !== false) {
    const subqWhere = ir.where ? { ...ir.where } : null;
    const subquery = SelectQuery({
      select: [Func('count', [])],
      where: subqWhere,
    });
    const percentExpr = BinOp(
      '/',
      BinOp('*', Func('count', []), RawNrql('100.0')),
      { type: 'SubqueryExpr', query: subquery },
    );
    const percentAlias = cmd.percentfield || 'percent';
    ir.select.push(Alias(percentExpr, percentAlias));
  }

  ir.facet = [Identifier(cmd.field)];
  if (cmd.groupBy && cmd.groupBy.length > 0) {
    ir.facet.push(...cmd.groupBy.map(Identifier));
    ir.warnings.push(
      'top with groupBy: NRQL FACET groups all fields together; SPL groups within each by-field value',
    );
  }
  ir.orderBy = OrderBy(Identifier('count'), true);

  // limit=0 means unlimited in SPL
  ir.limit = cmd.count === 0 ? 'MAX' : cmd.count || 10;

  if (cmd.useother) {
    ir.warnings.push(
      'useother: NRQL pie chart automatically shows an "Other" category for values outside LIMIT',
    );
  }

  ir._hasAggregation = true;
}

export function handleRare(cmd, ir) {
  ir.select = [Func('count', [])];
  ir.facet = [Identifier(cmd.field)];
  if (cmd.groupBy && cmd.groupBy.length > 0) {
    ir.facet.push(...cmd.groupBy.map(Identifier));
  }
  ir.orderBy = OrderBy(Identifier('count'), false); // ASC for rare
  ir.limit = cmd.count || 10;
  ir._hasAggregation = true;
}

export function handleEventstats(cmd, ir) {
  const subSelect = [];
  for (const fn of cmd.functions) {
    const mapped = mapFunction(fn.name, fn.args);
    if (mapped.warning) ir.warnings.push(mapped.warning);
    if (mapped.expr) {
      const alias = fn.alias || fn.args[0] || fn.name;
      subSelect.push(Alias(mapped.expr, alias));
    }
  }

  if (subSelect.length === 0) return;

  if (cmd.groupBy.length === 0) {
    // eventstats without BY → scalar subquery in SELECT
    let subquery;
    if (ir._hasAggregation) {
      const innerQuery = SelectQuery({
        dataSource: { ...ir.dataSource },
        select: [...ir.select],
        where: ir.where ? { ...ir.where } : null,
        facet: [...ir.facet],
        limit: 'MAX',
      });
      subquery = SelectQuery({
        dataSource: { type: 'SubquerySource', query: innerQuery },
        select: subSelect.map((s) => s.expr),
      });
    } else {
      subquery = SelectQuery({
        dataSource: { ...ir.dataSource },
        select: subSelect.map((s) => s.expr),
        where: ir.where ? { ...ir.where } : null,
      });
    }
    if (ir.select.length === 0) {
      ir.select.push(Wildcard());
    }
    for (const s of subSelect) {
      ir.select.push(Alias({ type: 'SubqueryExpr', query: subquery }, s.name));
    }
    ir.warnings.push(
      'eventstats without BY translated as scalar subquery in SELECT; ' +
        'for percentage calculations, use the subquery result in downstream eval',
    );
    return;
  }

  if (cmd.groupBy.length > 1) {
    ir.unsupported.push(
      `eventstats with multiple BY fields (${cmd.groupBy.join(', ')}) cannot be translated; NRQL subquery JOIN only supports a single ON key`,
    );
    return;
  }

  // eventstats with single BY → subquery JOIN
  const onKey = Identifier(cmd.groupBy[0]);
  const subquery = SelectQuery({
    dataSource: ir.dataSource,
    select: subSelect,
    facet: [onKey],
    limit: 'MAX',
  });

  ir.join = JoinClause(subquery, onKey);
  ir.warnings.push(
    'NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit',
  );
}
