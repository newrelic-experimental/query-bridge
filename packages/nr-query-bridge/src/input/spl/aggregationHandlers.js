/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

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
  JoinClause,
} from '../../ir/nodes.js';
import { mapFunction, formatSpan, wrapAsSubquery } from './splExprUtils.js';
import { walkEvalExpr } from './evalHandlers.js';
import { messages } from '../../messages.js';

export function handleStats(cmd, ir) {
  // A head/tail sat between this aggregation and a prior one. SPL takes the first
  // N rows in stats order; a nested-subquery LIMIT N takes the top N by aggregate
  // value — not the same selection, so there is no faithful translation.
  if (ir._headBetweenAgg) {
    ir.unsupported.push(messages.head_between_aggregations());
    return;
  }
  // If already aggregated, wrap current IR as a subquery source. Any illegal
  // nesting is caught by foldPostAggregationPass after all handlers run.
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
  if (
    cmd.span &&
    typeof cmd.span === 'object' &&
    cmd.span.type === 'SpanToken'
  ) {
    ir.unsupported.push(messages.span_token_unsupported(`$${cmd.span.name}$`));
  } else {
    ir.timeseries = cmd.span ? formatSpan(cmd.span) : 'AUTO';
  }
  for (const opt of cmd.options || []) {
    if (opt.type === 'limit') {
      ir.limit = opt.value === 0 ? 'MAX' : opt.value;
    } else if (opt.type === 'usenull') {
      ir.warnings.push(messages.usenullNoEquivalent());
    }
    // useother=false is a no-op: NRQL never synthesizes an OTHER bucket.
  }
}

export function handleTop(cmd, ir) {
  // count(*) with optional alias from countfield
  const countExpr = cmd.countfield
    ? Alias(Func('count', []), cmd.countfield)
    : Func('count', []);
  ir.select = [countExpr];

  // Percent column: count(*) * 100.0 / (SELECT count(*) FROM Log [WHERE ...])
  // NOTE: NRQL's native percentage(count(*), WHERE cond) CANNOT replace this — verified on
  //   staging 2026-06-25: percentage() is scoped WITHIN each facet (returns 100 per row), not
  //   percent-of-grand-total; and WITH count(*) AS total is rejected (WITH cannot aggregate).
  //   The percent-of-total denominator genuinely needs this scalar subquery. Do not re-chase.
  if (cmd.showperc !== false) {
    const subqWhere = [...ir.where];
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

  ir.facet = cmd.fields.map(Identifier);
  if (cmd.groupBy && cmd.groupBy.length > 0) {
    ir.facet.push(...cmd.groupBy.map(Identifier));
    ir.warnings.push(messages.top_groupby_warning());
  }
  // No ORDER BY: a faceted aggregation already returns top-N DESC by the first
  // aggregate (count) implicitly — NRDB ignores an explicit ORDER BY on it, and the
  // dashboard widget rejects the clause — so emitting it is redundant + render-failing.

  // limit=0 means unlimited in SPL
  ir.limit = cmd.count === 0 ? 'MAX' : cmd.count || 10;

  if (cmd.useother) {
    ir.warnings.push(messages.top_useother());
  }

  ir._hasAggregation = true;
}

export function handleRare(cmd, ir) {
  // rare needs the LEAST-common facet values (bottom-N). NRQL FACET returns only the
  // top-N descending by count and IGNORES an explicit ORDER BY on a faceted aggregation
  // — the `ORDER BY count ASC` this used to emit was silently dropped, so NRDB returned
  // the MOST common values (the exact opposite of rare). There is no faithful bottom-N
  // of a faceted aggregation in NRQL, so fail loud rather than return wrong data.
  ir.unsupported.push(messages.rare_unsupported());
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
        where: [...ir.where],
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
        where: [...ir.where],
      });
    }
    if (ir.select.length === 0) {
      ir.select.push(Wildcard());
    }
    for (const s of subSelect) {
      ir.select.push(Alias({ type: 'SubqueryExpr', query: subquery }, s.name));
    }
    ir.warnings.push(messages.eventstats_scalar_subquery());
    return;
  }

  if (cmd.groupBy.length > 1) {
    ir.unsupported.push(messages.eventstats_multi_by(cmd.groupBy.join(', ')));
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
  ir.warnings.push(messages.join_cardinality_limit());
}
