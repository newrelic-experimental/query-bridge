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

const PERC_REGEX = /^perc(\d+)$/;
const P_REGEX = /^p(\d+)$/;
const EXACTPERC_REGEX = /^exactperc(\d+)$/;
const UPPERPERC_REGEX = /^upperperc(\d+)$/;

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
  list: {
    nrql: 'uniques',
    get warning() {
      return messages.list_order_warning();
    },
  },
  earliest: { nrql: 'earliest' },
  latest: { nrql: 'latest' },
  first: { nrql: 'latest' },
  last: { nrql: 'earliest' },
  estdc: { nrql: 'uniqueCount' },
  range: { nrql: 'max' },
};

const NO_EQUIV_FUNCS = {
  estdc_error:
    'estdc_error() (estimated distinct count error) has no NRQL equivalent',
  mode: 'mode() has no direct NRQL equivalent; consider FACET field LIMIT 1 to find most common value',
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

  // rate(field) → rate(sum(field), 1 second)
  if (lowerName === 'rate') {
    const innerArg =
      args.length > 0 ? mapFunctionArg(args[0]) : Identifier('*');
    return {
      expr: Func('rate', [Func('sum', [innerArg]), RawNrql('1 second')]),
      warning: null,
    };
  }

  // Functions with no NRQL equivalent
  if (NO_EQUIV_FUNCS[lowerName]) {
    return {
      expr: null,
      warning: messages.no_equiv_func(NO_EQUIV_FUNCS[lowerName]),
    };
  }

  // Unknown function — warn and omit
  return {
    expr: null,
    warning: messages.unknown_stats_func(name),
  };
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

export function wrapAsSubquery(ir) {
  const innerQuery = SelectQuery({
    dataSource: ir.dataSource,
    bindings: [...ir.bindings],
    select: [...ir.select],
    where: [...ir.where],
    facet: [...ir.facet],
    limit: ir.facet.length > 0 ? 'MAX' : ir.limit,
  });

  ir.dataSource = { type: 'SubquerySource', query: innerQuery };
  ir.select = [];
  ir.facet = [];
  ir.bindings = [];
  ir.where = [];
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
