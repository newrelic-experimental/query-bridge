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
  OrderBy,
  JoinClause,
  Binding,
  SubqueryExpr,
} from '../../ir/nodes.js';
import {
  asTranslatedArg,
  mapFunction,
  mapAggregateExpression,
  isAggregateExpression,
  formatSpan,
  wrapAsSubquery,
} from './splExprUtils.js';
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

  // A preceding `dedup K` deferred to this aggregation (handleDedup); every
  // function here is a plain count, so each counts distinct K.
  const dedupKey = ir._dedupCountKey;
  ir._dedupCountKey = null;

  for (const fn of cmd.functions) {
    // `fn(eval(expr))` aggregates expr's per-event value. Only a count of a
    // condition is a filter; anything else (`dc(eval(if(c, user, null())))`,
    // `avg(eval(x*2))`) is fn over the expression — Splunk skips null values
    // and so do NRQL aggregates (sandbox: uniqueCount/count/average of if(…, NULL)).
    let evalArg = null;
    if (fn.evalFilter) {
      evalArg = walkEvalExpr(fn.evalFilter, ir);
      if (!evalArg) {
        // The walker already reported why; a condition-less filter() would
        // silently count every event.
        continue;
      }
      if (!isCountName(fn.name) && isCondition(evalArg)) {
        ir.unsupported.push(messages.stats_eval_condition_unsupported(fn.name));
        continue;
      }
    }
    if (evalArg && isCondition(evalArg)) {
      // count(eval(cond)) → filter(count(*), WHERE cond)
      const filterCondition = evalArg;
      // filter()'s WHERE needs a constant on one side of each comparison — New
      // Relic rejects `WHERE a = b` there ("must be a constant in this context").
      const pair = findFieldVsFieldComparison(filterCondition);
      if (pair) {
        ir.unsupported.push(
          messages.filter_field_vs_field(pair.left, pair.right),
        );
        continue;
      }
      const filterExpr = Func('filter', [Func('count', []), filterCondition]);
      const expr = fn.alias ? Alias(filterExpr, fn.alias) : filterExpr;
      ir.select.push(expr);
      continue;
    }

    // first()/last() map to latest()/earliest() because Splunk returns events
    // newest-first. A preceding sort/reverse/tail re-orders the rows, and then
    // "first in input order" no longer means "newest".
    if (ir.orderBy && (fn.name === 'first' || fn.name === 'last')) {
      ir.unsupported.push(messages.first_last_after_reorder(fn.name));
      continue;
    }
    // `round(avg(x), 2)` / `eval(<expr over aggregates>)` → one NRQL expression.
    /** @type {{ expr: any, warning?: string|null, warnings?: string[], unsupported?: string|string[] }} */
    const mapped = evalArg
      ? mapFunction(fn.name, [asTranslatedArg(evalArg)])
      : isAggregateExpression(fn)
        ? mapAggregateExpression(fn)
        : dedupKey
          ? { expr: Func('uniqueCount', [Identifier(dedupKey)]) }
          : mapFunction(fn.name, fn.args);
    for (const w of [mapped.warnings || [], mapped.warning || []].flat()) {
      ir.warnings.push(w);
    }
    for (const u of [mapped.unsupported || []].flat()) {
      ir.unsupported.push(u);
    }
    if (mapped.expr) {
      // uniqueCount(K) keeps Splunk's `count` column name for later stages.
      const alias = fn.alias || (dedupKey ? 'count' : null);
      const expr = alias ? Alias(mapped.expr, alias) : mapped.expr;
      // The column name Splunk gives an unaliased aggregate (`count`, `max(b)`),
      // so a later `table`/`fields` can find it. Non-enumerable (not emitted).
      if (!fn.alias) {
        Object.defineProperty(expr, '_splName', {
          value: splColumnName(fn),
          enumerable: false,
        });
      }
      ir.select.push(expr);
    }
  }

  if (cmd.groupBy.length > 0) {
    ir.facet = cmd.groupBy.map(Identifier);
  }

  ir._hasAggregation = true;
}

const COMPARISON_OPS = new Set(['=', '!=', '<', '<=', '>', '>=']);

// The name of the first attribute an IR expression reads, or null. A dashboard
// {{token}} is a constant at query time, not an attribute.
function firstAttributeName(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'Identifier') {
    return node.name.startsWith('{{') ? null : node.name;
  }
  if (node.type === 'Function') {
    for (const arg of node.args) {
      const name = firstAttributeName(arg);
      if (name) return name;
    }
    return null;
  }
  if (node.type === 'BinOp') {
    return firstAttributeName(node.left) || firstAttributeName(node.right);
  }
  return null;
}

// A comparison (possibly nested in AND/OR/NOT, or a DualCheck) whose two sides
// both read an attribute: `a = b`, `numeric(a) > numeric(b)`.
function findFieldVsFieldComparison(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'Not') return findFieldVsFieldComparison(node.child);
  if (node.type === 'DualCheck') {
    const left = firstAttributeName(node.field);
    const right = firstAttributeName(node.value);
    return left && right ? { left, right } : null;
  }
  if (node.type !== 'BinOp') return null;
  if (COMPARISON_OPS.has(node.op)) {
    const left = firstAttributeName(node.left);
    const right = firstAttributeName(node.right);
    return left && right ? { left, right } : null;
  }
  return (
    findFieldVsFieldComparison(node.left) ||
    findFieldVsFieldComparison(node.right)
  );
}

function isCountName(name) {
  return name.toLowerCase() === 'count' || name.toLowerCase() === 'c';
}

const CONDITION_OPS = new Set([...COMPARISON_OPS, 'AND', 'OR']);
const CONDITION_TYPES = new Set([
  'Not',
  'IsNull',
  'Like',
  'In',
  'Rlike',
  'DualCheck',
]);

// An IR expression that is true/false per event (a WHERE condition).
function isCondition(node) {
  if (CONDITION_TYPES.has(node.type)) return true;
  return node.type === 'BinOp' && CONDITION_OPS.has(node.op.toUpperCase());
}

// Splunk's output column name for an unaliased stats function: `count` for a
// bare/`count(*)` count, else `fn(arg, …)` as written. null when an argument is
// an expression we can't render back to text.
function splColumnName(fn) {
  if (fn.evalFilter) return null;
  const args = fn.args || [];
  if (args.length === 0 || (args.length === 1 && args[0] === '*')) {
    return fn.name;
  }
  if (!args.every((a) => typeof a === 'string')) return null;
  return `${fn.name}(${args.join(', ')})`;
}

export function handleTimechart(cmd, ir) {
  handleStats(cmd, ir);
  const options = cmd.options || [];
  if (
    cmd.span &&
    typeof cmd.span === 'object' &&
    cmd.span.type === 'SpanToken'
  ) {
    ir.unsupported.push(messages.span_token_unsupported(`$${cmd.span.name}$`));
  } else if (cmd.span) {
    const span = normalizeSpan(cmd.span);
    if (span) {
      ir.timeseries = formatSpan(span);
    } else {
      ir.unsupported.push(messages.span_unrecognized(cmd.span));
    }
  } else {
    ir.timeseries = 'AUTO';
    // bins=N / minspan=X only steer Splunk's automatic bucket size, which depends
    // on the search window. NRQL's TIMESERIES AUTO does the same job; say so.
    const hint = options.find((o) => o.type === 'bins' || o.type === 'minspan');
    if (hint) {
      ir.warnings.push(
        messages.timechart_bucket_hint_auto(`${hint.type}=${hint.value}`),
      );
    }
  }
  applyAggOptions(
    options.filter((o) => o.type !== 'bins' && o.type !== 'minspan'),
    ir,
    'timechart',
  );
}

export function handleChart(cmd, ir) {
  handleStats(cmd, ir);
  const options = cmd.options || [];
  const span = options.find((o) => o.type === 'span');
  if (span) {
    // chart's span= bins the `over` field. Only `over _time` is a time bucket
    // (→ TIMESERIES); over any other field it is a numeric bin width.
    const overTime = (cmd.groupBy || []).includes('_time');
    const normalized = overTime ? normalizeSpan(span.value) : null;
    if (normalized) {
      ir.timeseries = formatSpan(normalized);
    } else {
      ir.unsupported.push(
        overTime
          ? messages.span_unrecognized(span.value)
          : messages.chart_span_non_time(span.value),
      );
    }
  }
  applyAggOptions(
    options.filter((o) => o.type !== 'span'),
    ir,
    'chart',
  );
}

// Options that change only how Splunk renders the result, never the numbers.
const DISPLAY_ONLY_AGG_OPTIONS = new Set([
  'cont',
  'fixedrange',
  'partial',
  'nullstr',
  'otherstr',
  'format',
  'sep',
]);

// Shared interpretation of the key=value options timechart/chart accept in any
// position. `limit=` is the same knob as the FACET-default LIMIT warning.
function applyAggOptions(options, ir, command) {
  const ignored = [];
  for (const opt of options) {
    const value = String(opt.value);
    if (opt.type === 'limit') {
      const m = /^(?:top)?(\d+)$/i.exec(value);
      if (m) {
        const n = Number(m[1]);
        ir.limit = n === 0 ? 'MAX' : n;
      } else {
        ir.unsupported.push(
          messages.agg_option_unsupported(command, `limit=${value}`),
        );
      }
    } else if (opt.type === 'usenull') {
      ir.warnings.push(messages.usenullNoEquivalent());
    } else if (opt.type === 'useother') {
      // No-op: NRQL never synthesizes an OTHER bucket in the data.
    } else if (DISPLAY_ONLY_AGG_OPTIONS.has(opt.type)) {
      ignored.push(`${opt.type}=${value}`);
    } else {
      ir.unsupported.push(
        messages.agg_option_unsupported(command, `${opt.type}=${value}`),
      );
    }
  }
  if (ignored.length > 0) {
    ir.warnings.push(messages.agg_display_options_ignored(command, ignored));
  }
}

// Splunk span units → the single-letter units formatSpan understands. `m` is
// minutes and `mon` months (Splunk); a bare `M` is kept as months for
// compatibility. Quarters become 3 months.
const SPAN_UNITS = [
  { re: /^(s|sec|secs|second|seconds)$/, letter: 's', mult: 1 },
  { re: /^(m|min|mins|minute|minutes)$/, letter: 'm', mult: 1 },
  { re: /^(h|hr|hrs|hour|hours)$/, letter: 'h', mult: 1 },
  { re: /^(d|day|days)$/, letter: 'd', mult: 1 },
  { re: /^(w|week|weeks)$/, letter: 'w', mult: 1 },
  { re: /^(mon|month|months)$/, letter: 'M', mult: 1 },
  { re: /^(q|qtr|qtrs|quarter|quarters)$/, letter: 'M', mult: 3 },
  { re: /^(y|yr|yrs|year|years)$/, letter: 'y', mult: 1 },
];

/**
 * Normalize a Splunk span (`1h`, `d`, `1mon`, `30min`, `2 hours`) to the `<n><unit>`
 * form formatSpan expects, or null if it is not a span we can express.
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeSpan(raw) {
  const m = /^(\d*)\s*([a-zA-Z]+)$/.exec(String(raw).trim());
  if (!m) return null;
  const count = m[1] === '' ? 1 : Number(m[1]);
  if (count === 0) return null;
  if (m[2] === 'M') return `${count}M`;
  const unit = m[2].toLowerCase();
  for (const { re, letter, mult } of SPAN_UNITS) {
    if (re.test(unit)) return `${count * mult}${letter}`;
  }
  return null;
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
    // The copied WHERE may reference WITH bindings (rex/spath/eval fields); the
    // subquery needs the same bindings or those names resolve to null there.
    const subquery = SelectQuery({
      bindings: [...ir.bindings],
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
  ir.orderBy = OrderBy(Identifier('count'), true);

  // limit=0 means unlimited in SPL
  ir.limit = cmd.count === 0 ? 'MAX' : cmd.count || 10;

  if (cmd.useother) {
    ir.warnings.push(messages.top_useother());
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
  // Columns named by `as`. An unnamed one falls back to its argument's name
  // (`avg(price)` → `price`), which must not become a binding over the field.
  const aliased = new Set(cmd.functions.map((fn) => fn.alias).filter(Boolean));
  for (const fn of cmd.functions) {
    const mapped = mapFunction(fn.name, fn.args);
    if (mapped.warning) ir.warnings.push(mapped.warning);
    if (mapped.unsupported) ir.unsupported.push(mapped.unsupported);
    if (mapped.expr) {
      const alias = fn.alias || fn.args[0] || fn.name;
      subSelect.push(Alias(mapped.expr, alias));
    }
  }

  if (subSelect.length === 0) return;

  if (cmd.groupBy.length === 0) {
    // eventstats without BY → one scalar subquery per column (New Relic allows
    // a single result there), re-running this level with its WITH bindings.
    const levelSelect = [...ir.select];
    const scalarOf = (expr) =>
      SubqueryExpr(
        ir._hasAggregation
          ? SelectQuery({
              dataSource: {
                type: 'SubquerySource',
                query: SelectQuery({
                  dataSource: { ...ir.dataSource },
                  bindings: copyBindings(ir.bindings),
                  select: [...levelSelect],
                  where: [...ir.where],
                  facet: [...ir.facet],
                  limit: 'MAX',
                }),
              },
              select: [expr],
            })
          : SelectQuery({
              dataSource: { ...ir.dataSource },
              bindings: copyBindings(ir.bindings),
              select: [expr],
              where: [...ir.where],
            }),
      );
    // Over events, a column a later step reads is a WITH binding, so `where`,
    // `eval` and `stats … by` see it (a SELECT column is gone by then).
    const refs = cmd._downstreamRefs;
    const isReadLater = (name) =>
      aliased.has(name) && (!refs || refs.fields.includes(name));
    if (ir.select.length === 0) {
      ir.select.push(Wildcard());
    }
    for (const s of subSelect) {
      if (!ir._hasAggregation && isReadLater(s.name)) {
        ir.bindings.push(Binding(s.name, scalarOf(s.expr)));
        ir.select.push(Identifier(s.name));
      } else {
        ir.select.push(Alias(scalarOf(s.expr), s.name));
      }
    }
    ir.warnings.push(messages.eventstats_scalar_subquery());
    return;
  }

  if (cmd.groupBy.length > 1) {
    ir.unsupported.push(messages.eventstats_multi_by(cmd.groupBy.join(', ')));
    return;
  }

  // A values()/list() column is a list, and a list can't be a JOIN column
  // ("Logic error in result flattening", sandbox-verified). Unread, it can go;
  // read later, there is no faithful form.
  const lists = subSelect.filter(
    (s) => s.expr.type === 'Function' && s.expr.name === 'uniques',
  );
  if (lists.length > 0) {
    const refs = cmd._downstreamRefs;
    const names = lists.map((s) => s.name);
    if (!refs || names.some((n) => refs.fields.includes(n))) {
      ir.unsupported.push(messages.eventstats_list_join(names));
      return;
    }
    ir.warnings.push(messages.eventstats_unread_list_dropped(names));
    for (const s of lists) subSelect.splice(subSelect.indexOf(s), 1);
    if (subSelect.length === 0) return;
  }

  // eventstats with single BY → subquery JOIN over the same events: the base
  // search, and the fields extracted so far (bindingScope points the key and
  // arguments at their binding names).
  const onKey = Identifier(cmd.groupBy[0]);
  const subquery = SelectQuery({
    dataSource: ir.dataSource,
    // Own copies: a JOIN-column clash renames the OUTER binding only.
    bindings: copyBindings(ir.bindings),
    select: subSelect,
    where: [...ir.where],
    facet: [onKey],
    limit: 'MAX',
  });

  ir.join = JoinClause(subquery, onKey);
  ir.warnings.push(messages.join_cardinality_limit());
}

// A subquery re-running this level needs its WITH bindings — own copies, so a
// later rename of an outer binding (JOIN-column clash) leaves them alone.
function copyBindings(bindings) {
  return bindings.map((b) => Binding(b.name, b.expr));
}
