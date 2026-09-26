/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SPL expression utility functions.
 *
 * Pure helper functions shared across SPL command handlers:
 * field mapping, function mapping, comparison builders,
 * type coercion, arithmetic parsing.
 */
import {
  Identifier,
  Literal,
  BinOp,
  Func,
  DualCheck,
  RawNrql,
  SelectQuery,
} from '../../ir/nodes.js';
import { escapeStringWildcardForNrql } from '../../output/nrql/nrqlEncoding.js';
import { messages } from '../../messages.js';
// Circular import — safe because walkEvalExpr is only invoked at runtime (during
// translation), never at module load. Mirrors evalHandlers.js's import of
// translateSearchExpr from splToIR.js.
import { walkEvalExpr } from './evalHandlers.js';

// ── Field name mapping ──────────────────────────────────────

// Map SPL metadata field names to NRQL equivalents
export function mapFieldName(name) {
  if (name === '_time') return 'timestamp';
  if (name === '_raw') return 'message';
  return name;
}

// ── Time span formatting ────────────────────────────────────

export function formatSpan(span) {
  const SPAN_MAP = {
    s: 'second',
    m: 'minute',
    h: 'hour',
    d: 'day',
    w: 'week',
    M: 'month',
    y: 'year',
  };
  const match = span.match(/^(\d+)([smhdwMy])$/);
  if (!match) return span;
  const [, num, unit] = match;
  const nrqlUnit = SPAN_MAP[unit] || unit;
  return `${num} ${nrqlUnit}${num === '1' ? '' : 's'}`;
}

// ── Function mapping ────────────────────────────────────────

// Percentile functions; the rank may be fractional (perc99.9 → percentile(x, 99.9)).
const PERC_REGEX = /^perc(\d+(?:\.\d+)?)$/;
const P_REGEX = /^p(\d+(?:\.\d+)?)$/;
const EXACTPERC_REGEX = /^exactperc(\d+(?:\.\d+)?)$/;
const UPPERPERC_REGEX = /^upperperc(\d+(?:\.\d+)?)$/;

const SPL_TO_NRQL_FUNCS = {
  count: { nrql: 'count' },
  dc: { nrql: 'uniqueCount' },
  distinct_count: { nrql: 'uniqueCount' },
  avg: { nrql: 'average' },
  mean: { nrql: 'average' },
  sum: { nrql: 'sum' },
  min: { nrql: 'min' },
  max: { nrql: 'max' },
  median: { nrql: 'median' },
  stdev: { nrql: 'stddev' },
  stdevp: {
    nrql: 'stddev',
    get warning() {
      return messages.stdevp_precision();
    },
  },
  values: { nrql: 'uniques' },
  earliest: { nrql: 'earliest' },
  latest: { nrql: 'latest' },
  // Splunk returns events newest-first, so first() is the newest value and
  // last() the oldest — as long as nothing re-ordered the rows (see
  // ORDER_SENSITIVE_FUNCS in handleStats).
  first: { nrql: 'latest' },
  last: { nrql: 'earliest' },
  estdc: { nrql: 'uniqueCount' },
};

// Aggregates with no faithful NRQL form. Each is reported as `unsupported` —
// never dropped from the SELECT list with only a warning (that yields a query
// that runs but silently answers a different question).
const NO_EQUIV_FUNCS = {
  estdc_error:
    'estdc_error() (estimated distinct count error) has no NRQL equivalent',
  mode: 'mode() (most common value) has no NRQL aggregate equivalent; use a separate query with FACET field LIMIT 1',
  list: 'list() keeps every value including duplicates, in event order; NRQL uniques() de-duplicates and does not preserve order. Use values() if distinct values are acceptable',
  sumsq: 'sumsq() (sum of squares) has no NRQL equivalent',
  var: 'var() (sample variance) has no NRQL equivalent',
  varp: 'varp() (population variance) has no NRQL equivalent',
  earliest_time:
    'earliest_time() has no NRQL equivalent; earliest() returns the value, not the timestamp',
  latest_time:
    'latest_time() has no NRQL equivalent; latest() returns the value, not the timestamp',
  rate_avg: 'rate_avg() is Splunk metrics-specific; no NRQL equivalent',
  rate_sum: 'rate_sum() is Splunk metrics-specific; no NRQL equivalent',
};

export function mapFunctionArg(a) {
  // Typed node from the unified ladder → walk to IR.
  if (a && typeof a === 'object') {
    return walkEvalExpr(a, { warnings: [], unsupported: [], errors: [] });
  }
  // Bare-string atoms the stats wildcard atom emits as strings:
  if (a === '_time') return Identifier('timestamp');
  if (/\{\d*\}/.test(a)) {
    const jpath = a.replace(/\{(\d*)\}/g, (_, n) => (n ? `[${n}]` : '[*]'));
    return Func('jparse', [Identifier('message'), Literal(jpath, 'string')]);
  }
  return Identifier(a); // wildcard (`tcp.*`) or plain field — emitter backticks it
}

export function mapFunction(name, args) {
  const lowerName = name.toLowerCase();
  const entry = SPL_TO_NRQL_FUNCS[lowerName];

  if (entry) {
    const nrqlArgs = args.map(mapFunctionArg);
    return {
      expr: Func(entry.nrql, nrqlArgs),
      warning: entry.warning || null,
    };
  }

  // percN, pN, exactpercN, upperpercN → percentile(field, N)
  const percMatch =
    lowerName.match(PERC_REGEX) ||
    lowerName.match(P_REGEX) ||
    lowerName.match(EXACTPERC_REGEX) ||
    lowerName.match(UPPERPERC_REGEX);
  if (percMatch) {
    const n = percMatch[1];
    const nrqlArgs =
      args.length > 0
        ? [...args.map(mapFunctionArg), Literal(Number(n), 'number')]
        : [Literal(Number(n), 'number')];
    const variant = lowerName.match(EXACTPERC_REGEX)
      ? 'exactperc'
      : lowerName.match(UPPERPERC_REGEX)
        ? 'upperperc'
        : null;
    return {
      expr: Func('percentile', nrqlArgs),
      warning: variant ? messages.perc_precision(variant, n) : null,
    };
  }

  // per_second/per_minute/per_hour/per_day → rate(sum(field), 1 unit)
  const perMatch = lowerName.match(/^per_(second|minute|hour|day)$/);
  if (perMatch) {
    const unit = perMatch[1];
    const innerArg =
      args.length > 0 ? mapFunctionArg(args[0]) : Identifier('*');
    return {
      expr: Func('rate', [Func('sum', [innerArg]), RawNrql(`1 ${unit}`)]),
      warning: null,
    };
  }

  // range(x) = max(x) - min(x) — both halves are NRQL aggregates.
  if (lowerName === 'range') {
    const nrqlArgs = args.map(mapFunctionArg);
    return {
      expr: BinOp('-', Func('max', nrqlArgs), Func('min', nrqlArgs)),
      warning: null,
    };
  }

  // rate(field) → rate(sum(field), 1 second)
  if (lowerName === 'rate') {
    const innerArg =
      args.length > 0 ? mapFunctionArg(args[0]) : Identifier('*');
    return {
      expr: Func('rate', [Func('sum', [innerArg]), RawNrql('1 second')]),
      warning: null,
    };
  }

  // Functions with no NRQL equivalent — loud, never silently omitted.
  if (NO_EQUIV_FUNCS[lowerName]) {
    return {
      expr: null,
      warning: null,
      unsupported: messages.no_equiv_func(NO_EQUIV_FUNCS[lowerName]),
    };
  }

  // Unknown function — loud, never silently omitted.
  return {
    expr: null,
    warning: null,
    unsupported: messages.unknown_stats_func(name),
  };
}

// ── Scalar functions over aggregates ────────────────────────

// Scalar functions NRQL can apply to an aggregate in a flat SELECT (the
// "distributed" set in nrql-reference.md: round(average(x), 0.01) is valid).
const AGG_SCALAR_FUNCS = new Set([
  'round',
  'abs',
  'ceil',
  'ceiling',
  'floor',
  'sqrt',
  'exp',
  'ln',
  'log',
  'log10',
  'log2',
  'pow',
]);

/**
 * True for a stats/timechart function that is really an expression over
 * aggregates: `eval(<expr>)` or a scalar wrapper like `round(avg(x), 2)`.
 */
export function isAggregateExpression(fn) {
  if (fn.evalFilter) return false;
  if (fn.name === 'eval') return (fn.args || []).length === 1;
  // A scalar function in stats position is never itself an aggregate.
  return AGG_SCALAR_FUNCS.has(fn.name);
}

/**
 * Translate an expression over aggregates to one NRQL SELECT expression, e.g.
 * `round(avg(dur), 2)` → `round(average(dur), 0.01)`. SPL round(x, N) keeps N
 * decimal places; NRQL round(x, N) rounds to the nearest multiple of N, so the
 * precision is converted exactly as eval's round() is.
 *
 * @returns {{ expr: object|null, warnings: string[], unsupported: string[] }}
 */
export function mapAggregateExpression(fn) {
  const warnings = [];
  const unsupported = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      if (looksLikeNumber(node)) return Literal(Number(node), 'number');
      // A bare field has no single value per group — it isn't an aggregate.
      unsupported.push(messages.agg_expr_bare_field(node));
      return null;
    }
    if (!node || typeof node !== 'object') return null;
    switch (node.type) {
      case 'EvalParens':
        return walk(node.inner);
      case 'EvalArith': {
        if (node.op === '.') break;
        const l = walk(node.left);
        const r = walk(node.right);
        return l && r ? BinOp(node.op, l, r) : null;
      }
      case 'EvalFunc': {
        const name = node.name.toLowerCase();
        if (AGG_SCALAR_FUNCS.has(name)) {
          const args = node.args.map(walk);
          if (args.some((a) => !a)) return null;
          if (name === 'round' && args.length === 2) {
            const places = args[1];
            if (places.type !== 'Literal' || typeof places.value !== 'number') {
              break;
            }
            return Func('round', [
              args[0],
              Literal(Math.pow(10, -places.value), 'number'),
            ]);
          }
          if (name === 'log' && args.length === 1) return Func('log10', args);
          if (name === 'ceiling') return Func('ceil', args);
          return Func(name, args);
        }
        const mapped = mapFunction(name, node.args);
        if (mapped.warning) warnings.push(mapped.warning);
        if (mapped.unsupported) unsupported.push(mapped.unsupported);
        return mapped.expr;
      }
      default:
        break;
    }
    unsupported.push(messages.agg_expr_unsupported(fn.name));
    return null;
  };
  const root =
    fn.name === 'eval'
      ? fn.args[0]
      : { type: 'EvalFunc', name: fn.name, args: fn.args };
  const expr = walk(root);
  return { expr: unsupported.length ? null : expr, warnings, unsupported };
}

// ── Comparison builders ─────────────────────────────────────

export function buildComparison(field, op, value) {
  return buildExprComparison(Identifier(field), op, value);
}

export function buildJparseComparison(jparsedExpr, op, value) {
  return buildExprComparison(jparsedExpr, op, value);
}

export function buildExprComparison(fieldExpr, op, value) {
  if (isNumeric(value)) {
    if (op === '=' || op === '!=') {
      return DualCheck(fieldExpr, op, Literal(Number(value), 'number'));
    }
    return BinOp(
      op,
      Func('numeric', [fieldExpr]),
      Literal(Number(value), 'number'),
    );
  }

  return BinOp(op, fieldExpr, Literal(value, 'string'));
}

// ── Type coercion ───────────────────────────────────────────

export function coerceValue(value) {
  if (isNumeric(value)) return Literal(Number(value), 'number');
  return Literal(value, 'string');
}

export function isNumeric(value) {
  // Reject leading zeros (00123 is a string, not a number)
  return /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value);
}

export function looksLikeNumber(value) {
  return /^-?\d+(\.\d+)?$/.test(String(value));
}

// ── Tree utilities ──────────────────────────────────────────

/**
 * Check if an IR expression tree references a specific field name.
 */
export function exprReferencesField(expr, fieldName) {
  if (!expr) return false;
  if (expr.type === 'Identifier' && expr.name === fieldName) return true;
  if (expr.type === 'BinOp') {
    return (
      exprReferencesField(expr.left, fieldName) ||
      exprReferencesField(expr.right, fieldName)
    );
  }
  if (expr.type === 'Not') return exprReferencesField(expr.child, fieldName);
  if (expr.type === 'Function')
    return expr.args.some((a) => exprReferencesField(a, fieldName));
  if (expr.type === 'Alias') return exprReferencesField(expr.expr, fieldName);
  if (expr.type === 'IsNull') return exprReferencesField(expr.child, fieldName);
  if (expr.type === 'Like') return exprReferencesField(expr.field, fieldName);
  if (expr.type === 'In') return exprReferencesField(expr.field, fieldName);
  return false;
}

// ── Wildcard escaping ───────────────────────────────────────

export function escapeWildcard(value) {
  return value.split('*').map(escapeStringWildcardForNrql).join('%');
}

// ── Subquery wrapping ───────────────────────────────────────

// Remove the time-bucket facet keys (_time/timestamp and any `bin _time as X`
// aliases) from a facet list when TIMESERIES is present — TIMESERIES already
// groups by time, so faceting by the bucket too is redundant. Always returns a
// fresh array. Shared by wrapAsSubquery (inner facet) and splToIR (outer post-loop).
export function stripTimeBucketFacets(
  facet,
  timeseries,
  timeAliases = new Set(),
) {
  if (!timeseries || facet.length === 0) return [...facet];
  return facet.filter(
    (f) =>
      !(
        f.type === 'Identifier' &&
        (f.name === '_time' ||
          f.name === 'timestamp' ||
          timeAliases.has(f.name))
      ),
  );
}

// Wrap the current query as a subquery source. The post-aggregation fold pass
// (foldPostAggregationPass) handles any illegal nesting after all wrapAsSubquery
// calls complete. Returns a function that restores the pre-wrap state, for a
// caller that turns out to have nothing to put on the outer query.
export function wrapAsSubquery(ir) {
  const before = {
    dataSource: ir.dataSource,
    select: ir.select,
    facet: ir.facet,
    bindings: ir.bindings,
    where: ir.where,
    timeseries: ir.timeseries,
  };
  // TIMESERIES already groups by time, so a _time/bucket facet on the inner is
  // redundant. The outer post-loop dedup (splToIR) can't reach the inner once
  // wrapped, so strip it here.
  const innerFacet = stripTimeBucketFacets(
    ir.facet,
    ir.timeseries,
    ir._timeBucketAliases,
  );
  const innerQuery = SelectQuery({
    dataSource: ir.dataSource,
    bindings: [...ir.bindings],
    select: [...ir.select],
    where: [...ir.where],
    facet: innerFacet,
    limit: innerFacet.length > 0 ? 'MAX' : ir.limit,
    // TIMESERIES belongs to the aggregation being pushed inner (e.g. a timechart
    // before a trailing stats). Nested TIMESERIES populates all buckets (verified
    // on staging); leaving it on the outer bolts it onto a non-time-bucketed
    // aggregate. No-op when ir.timeseries is null (the common stats/where case).
    timeseries: ir.timeseries,
  });

  ir.dataSource = { type: 'SubquerySource', query: innerQuery };
  ir.select = [];
  ir.facet = [];
  ir.bindings = [];
  ir.where = [];
  ir.timeseries = null;
  return () => Object.assign(ir, before);
}

// ── Subsearch normalization ─────────────────────────────────

// SPL subsearches can omit the leading `|` for commands like `inputlookup`.
// The parser needs `|` to recognize them as commands rather than search terms.
const COMMAND_PREFIXES =
  /^(inputlookup|lookup|stats|eventstats|top|rare|table|fields|eval|rename|dedup|sort|head|tail|rex|spath|regex|bin|bucket|chart|timechart|where|search|join|append|appendcols|appendpipe|convert|replace|strcat|fillnull|predict|mvexpand|uniq|reverse|transaction|streamstats)\b/i;

export function normalizeSubsearch(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('|')) return trimmed;
  if (COMMAND_PREFIXES.test(trimmed)) return `| ${trimmed}`;
  return trimmed;
}
