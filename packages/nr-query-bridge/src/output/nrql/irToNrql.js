/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * NRQL Emitter — Pass 2: IR → NRQL string.
 *
 * Walks the IR tree and produces a NRQL query string.
 * Escaping is centralized here — no scattered escapeField() calls.
 */
import {
  escapeAttributeNameForNrql,
  escapeStringLiteralForNrql,
  escapeRegexPatternForNrql,
  formatJsonPathForNrql,
} from './nrqlEncoding.js';

// ── Expression emission ──────────────────────────────────────

/**
 * Emit a single IR expression node as an NRQL expression string.
 *
 * @param {import('../../ir/nodes.js').IRNode | null | undefined} node - An IR
 *   expression node (from `src/ir/nodes.js` constructors).
 * @returns {string} The NRQL expression, or '' for a nullish node.
 */
export function emitExpr(node) {
  if (!node) return '';

  switch (node.type) {
    case 'Identifier':
      return smartEscape(node.name);

    case 'Literal':
      if (node.kind === 'null') return 'NULL';
      if (node.kind === 'number') return String(node.value);
      if (node.kind === 'boolean') return node.value ? 'true' : 'false';
      return `'${escapeStringLiteralForNrql(node.value)}'`;

    case 'BinOp':
      return emitBinOp(node);

    case 'Not': {
      // NOT(IsNull) → IS NOT NULL (more idiomatic)
      if (node.child.type === 'IsNull') {
        return `${emitExpr(node.child.child)} IS NOT NULL`;
      }
      // NOT(Like) → field NOT LIKE 'pattern' (idiomatic NRQL). A {{tok}} pattern is a
      // dashboard template variable, emitted bare (unquoted) — see the Like case below.
      if (node.child.type === 'Like') {
        return node.child.pattern.startsWith('{{')
          ? `${emitExpr(node.child.field)} NOT LIKE ${node.child.pattern}`
          : `${emitExpr(node.child.field)} NOT LIKE '${node.child.pattern}'`;
      }
      // NOT(Rlike) → field NOT RLIKE r'pattern'
      if (node.child.type === 'Rlike') {
        return `${emitExpr(node.child.field)} NOT RLIKE r'${escapeRegexPatternForNrql(node.child.pattern)}'`;
      }
      const inner = emitExpr(node.child);
      // Parenthesize compound expressions under NOT
      const needsParens = node.child.type === 'BinOp';
      return needsParens ? `NOT (${inner})` : `NOT ${inner}`;
    }

    case 'Function':
      if (node.name === 'count' && node.args.length === 0) {
        return 'count(*)';
      }
      // AI-DEV: Two DIFFERENT NRQL functions are both named `filter` with two
      // arguments. The GA aggregate is `filter(<agg>, WHERE <cond>)`; the
      // Limited Preview collection function is `filter(<collection>, <lambda>)`
      // and takes NO `WHERE` keyword. A Lambda second argument means the
      // collection form — do NOT emit `WHERE` for it.
      if (
        node.name === 'filter' &&
        node.args.length === 2 &&
        node.args[1].type !== 'Lambda'
      ) {
        return `filter(${emitExpr(node.args[0])}, WHERE ${emitExpr(node.args[1])})`;
      }
      // jparse(field, 'path'): non-plain keys need the all-bracketed path form.
      if (
        node.name === 'jparse' &&
        node.args.length === 2 &&
        node.args[1].type === 'Literal' &&
        node.args[1].kind === 'string'
      ) {
        const path = formatJsonPathForNrql(node.args[1].value);
        return `jparse(${emitExpr(node.args[0])}, '${escapeStringLiteralForNrql(path)}')`;
      }
      return `${node.name}(${node.args.map(emitExpr).join(', ')})`;

    case 'Lambda': {
      // The body is ALWAYS parenthesized: unconditionally valid, and it removes
      // every question about how `->` binds against the body's own operators.
      const params =
        node.params.length === 1
          ? node.params[0]
          : `(${node.params.join(', ')})`;
      return `${params} -> (${emitExpr(node.body)})`;
    }

    case 'ArrayLiteral':
      return `[${node.elements.map(emitExpr).join(', ')}]`;

    case 'MapLiteral':
      return `{${node.entries
        .map((e) => `${emitMapKey(e.key)}: ${emitExpr(e.value)}`)
        .join(', ')}}`;

    case 'Index':
      return `${emitExpr(node.base)}[${emitExpr(node.key)}]`;

    case 'Alias':
      return `${emitExpr(node.expr)} AS '${escapeStringLiteralForNrql(node.name)}'`;

    case 'IsNull':
      return `${emitExpr(node.child)} IS NULL`;

    case 'Like':
      // A {{tok}} pattern is a dashboard template variable: emit it bare (unquoted), like
      // the Identifier {{ passthrough above — New Relic substitutes it in value position.
      return node.pattern.startsWith('{{')
        ? `${emitExpr(node.field)} LIKE ${node.pattern}`
        : `${emitExpr(node.field)} LIKE '${node.pattern}'`;

    case 'Rlike':
      return `${emitExpr(node.field)} RLIKE r'${escapeRegexPatternForNrql(node.pattern)}'`;

    case 'In':
      return `${emitExpr(node.field)} IN (${node.values.map(emitExpr).join(', ')})`;

    case 'Wildcard':
      return '*';

    case 'Regex':
      return `r'${escapeRegexPatternForNrql(node.pattern)}'`;

    case 'RawNrql':
      return node.nrql;

    case 'SubqueryExpr':
      return `(${emitQuery(node.query)})`;

    case 'DualCheck': {
      // Defensive: expand inline if a DualCheck reaches the emitter unexpanded
      const field = emitExpr(node.field);
      const strVal = escapeStringLiteralForNrql(String(node.value.value));
      const str = `${field} ${node.op} '${strVal}'`;
      const num = `numeric(${field}) ${node.op} ${node.value.value}`;
      const join = node.op === '=' ? 'OR' : 'AND';
      return `${str} ${join} ${num}`;
    }

    default:
      return `/* unknown expression: ${node.type} */`;
  }
}

// Only backtick-wrap identifiers that need it:
// dots, dashes, colons, spaces, curly braces, starts with $ / {{, or NRQL reserved words
const NEEDS_BACKTICK = /[.\-:{} ]|^\$|^\{\{/;

// Clause keywords only — function names (rate, filter, average, etc.) don't need
// backticking because NRQL distinguishes them by context (parens = function call).
const NRQL_RESERVED_WORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'AS',
  'FACET',
  'LIMIT',
  'SINCE',
  'UNTIL',
  'TIMESERIES',
  'COMPARE',
  'WITH',
  'IN',
  'IS',
  'LIKE',
  'RLIKE',
  'ORDER',
  'BY',
  'ASC',
  'DESC',
  'JOIN',
  'ON',
  'NULL',
  'TRUE',
  'FALSE',
  'PREDICT',
  'RAW',
  'EXTRAPOLATE',
  'SHOW',
  'AUTO',
  'MAX',
  'OFFSET',
  'SLIDE',
]);

// A map-literal key. Bare when it is a plain identifier (`{a: 1}`), quoted
// otherwise (`{'404': 'client error'}` — the inline-lookup form, where keys are
// commonly numeric strings that cannot be bare).
function emitMapKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? key
    : `'${escapeStringLiteralForNrql(key)}'`;
}

function smartEscape(name) {
  // Tuple destructuring names like (a, b) pass through as-is
  if (name.startsWith('(') && name.endsWith(')')) return name;
  // Macro references ($name) and template vars ({{name}}) pass through as-is
  if (name.startsWith('$') || name.startsWith('{{')) return name;
  if (
    NEEDS_BACKTICK.test(name) ||
    NRQL_RESERVED_WORDS.has(name.toUpperCase())
  ) {
    return `\`${escapeAttributeNameForNrql(name)}\``;
  }
  return name;
}

// NRQL precedence (OR binds TIGHTER than AND — opposite of SQL/SPL):
//   OR  > AND > comparisons > addition > multiplication
const NRQL_PRECEDENCE = {
  AND: 1, // lowest boolean precedence in NRQL
  OR: 2, // OR binds tighter than AND in NRQL
  '=': 3,
  '!=': 3,
  '<': 3,
  '>': 3,
  '<=': 3,
  '>=': 3,
  '+': 4,
  '-': 4,
  '*': 5,
  '/': 5,
  '%': 5,
};

function emitBinOp(node) {
  // NRQL has no % operator — use mod() function
  if (node.op === '%') {
    return `mod(${emitExpr(node.left)}, ${emitExpr(node.right)})`;
  }

  const parentPrec = NRQL_PRECEDENCE[node.op] || 0;

  let left = emitExpr(node.left);
  let right = emitExpr(node.right);

  // Parenthesize children whose NRQL precedence is lower than the parent's.
  // In NRQL: OR binds tighter than AND, so:
  //   - emitting OR: AND children need parens (AND has lower NRQL precedence)
  //   - emitting AND: OR children do NOT need parens (OR has higher NRQL precedence)
  if (node.left.type === 'BinOp') {
    const childPrec = NRQL_PRECEDENCE[node.left.op] || 0;
    if (childPrec < parentPrec) {
      left = `(${left})`;
    }
  }

  if (node.right.type === 'BinOp') {
    const childPrec = NRQL_PRECEDENCE[node.right.op] || 0;
    if (childPrec < parentPrec) {
      right = `(${right})`;
    }
  }

  return `${left} ${node.op} ${right}`;
}

// ── Query emission ───────────────────────────────────────────

/**
 * Emit a top-level IR query node (e.g. SelectQuery) as a full NRQL string.
 *
 * @param {import('../../ir/nodes.js').IRNode} node - A query-level IR node.
 * @returns {string} The complete NRQL query.
 */
export function emitQuery(node) {
  switch (node.type) {
    case 'SelectQuery':
      return emitSelectQuery(node);
    default:
      return `/* unknown query type: ${node.type} */`;
  }
}

function emitSelectQuery(q) {
  const parts = [];

  // FROM
  parts.push(`FROM ${emitDataSource(q.dataSource)}`);

  // JOIN
  if (q.join) {
    const subNrql = emitSelectQuery(q.join.subquery);
    const key = emitExpr(q.join.onKey);
    const rightKey = q.join.onLookupKey ? emitExpr(q.join.onLookupKey) : key;
    const joinType =
      q.join.joinType && q.join.joinType !== 'INNER'
        ? `${q.join.joinType} `
        : '';
    parts.push(`${joinType}JOIN (${subNrql}) ON ${key} = ${rightKey}`);
  }

  // WITH (bindings)
  if (q.bindings.length > 0) {
    const binds = q.bindings.map((b) => {
      let expr = emitExpr(b.expr);
      // Parenthesize OR/AND in bindings so AS binds to the whole expression
      if (
        b.expr.type === 'BinOp' &&
        (b.expr.op === 'OR' || b.expr.op === 'AND')
      ) {
        expr = `(${expr})`;
      }
      return `${expr} AS ${smartEscape(b.name)}`;
    });
    parts.push(`WITH ${binds.join(', ')}`);
  }

  // EXPAND — must sit between WITH and SELECT: an EXPAND source may reference a
  // WITH binding, and the expanded alias may be selected/faceted below.
  if (q.expand?.length > 0) {
    for (const e of q.expand) {
      parts.push(`EXPAND ${emitExpr(e.source)} AS ${smartEscape(e.alias)}`);
    }
  }

  // SELECT
  const select = q.select.length > 0 ? q.select.map(emitExpr).join(', ') : '*';
  parts.push(`SELECT ${select}`);

  // WHERE
  if (q.where.length > 0) {
    const conditions = q.where.map(emitExpr);
    parts.push(`WHERE ${conditions.join(' AND ')}`);
  }

  // FACET
  if (q.facet.length > 0) {
    parts.push(`FACET ${q.facet.map(emitExpr).join(', ')}`);
  }

  // ORDER BY
  if (q.orderBy) {
    const dir = q.orderBy.descending ? 'DESC' : 'ASC';
    parts.push(`ORDER BY ${emitExpr(q.orderBy.field)} ${dir}`);
  }

  // LIMIT
  if (q.limit != null) {
    parts.push(`LIMIT ${q.limit}`);
  }

  // SINCE
  if (q.since) parts.push(`SINCE ${q.since}`);

  // UNTIL
  if (q.until) parts.push(`UNTIL ${q.until}`);

  // TIMESERIES
  if (q.timeseries) parts.push(`TIMESERIES ${q.timeseries}`);

  // PREDICT
  if (q.predict) parts.push('PREDICT');

  return parts.join(' ');
}

function emitDataSource(ds) {
  switch (ds.type) {
    case 'EventType':
      return ds.names.join(', ');
    case 'Lookup':
      return `lookup(${ds.name})`;
    case 'SubquerySource':
      return `(${emitSelectQuery(ds.query)})`;
    default:
      return 'Log';
  }
}
