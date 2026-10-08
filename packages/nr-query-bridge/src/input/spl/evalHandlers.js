/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Eval expression handlers and walker.
 *
 * Translates SPL eval expressions, where clauses, and function calls
 * into IR expression trees. Contains the recursive descent eval walker
 * (~800 lines) that handles all SPL eval functions.
 */
import {
  Identifier,
  Literal,
  BinOp,
  Not,
  Func,
  IsNull,
  Like,
  Regex,
  Binding,
  Alias,
  DualCheck,
  Lambda,
  ArrayLiteral,
} from '../../ir/nodes.js';
import {
  buildRegexMatch,
  looksLikeNumber,
  exprReferencesField,
  rawEventIdentifier,
  wrapAsSubquery,
  collectionBindingOf,
} from './splExprUtils.js';
// Circular import — safe because translateSearchExpr is only called at runtime, not at module load time
import { translateSearchExpr } from './splToIR.js';
import * as parser from './splParser.js';
import { messages } from '../../messages.js';
import { splFormatToJava } from './splFormatCodes.js';
import { getPreview } from '../../previewFlags.js';
import { transformTree } from '../../ir/transform.js';
import { buildRegexReplace, nextReplaceBase } from './regexReplace.js';

// ── Command handlers ────────────────────────────────────────

export function handleWhere(cmd, ir) {
  // `where A B` is invalid SPL (implicit AND is search syntax) — a source defect.
  if (cmd.implicitAnd) {
    ir.unsupported.push(messages.where_implicit_and());
    return;
  }
  // If after aggregation, wrap as subquery and filter the outer query.
  const afterAgg = ir._hasAggregation;
  const unwrap = afterAgg ? wrapAsSubquery(ir) : null;

  // The PEG grammar uses `expression` not `expr`
  const whereNode = cmd.expression || cmd.expr;
  const expr = translateWhereExpr(whereNode, ir, { isCaseSensitive: true });
  if (expr) {
    ir.where.push(expr);
  } else if (unwrap) {
    // Nothing to filter (e.g. a constant-folded `where "a"="a"`): don't leave
    // a pointless `FROM (…) SELECT *` wrapper behind.
    unwrap();
  }
}

export function handleEval(cmd, ir) {
  // eval after an aggregation must bind on the AGGREGATED result, not the raw
  // events. A pre-aggregation WITH would reference fields that no longer exist
  // post-stats (silent wrong result). Wrap the aggregation as a subquery and
  // project the eval columns on the outer query — re-projecting the facet keys
  // so the result stays one row per group (a `SELECT *` would drop the eval
  // alias entirely; verified against staging acct 10671289). The optimizer's
  // foldPostAggregation pass flattens this to a single query when it is safe.
  if (ir._hasAggregation) {
    const facetKeys = [...ir.facet];
    wrapAsSubquery(ir);
    // Inspect the wrapped inner's exposed columns for two hazards that have no
    // faithful translation — emit loud unsupported, never silently-wrong NRQL.
    const cols = ir.dataSource.query.select
      .map(exposedSubqueryColumn)
      .filter(Boolean);
    // Collision: two inner aggregates resolving to the same exposed subquery
    // column name (e.g. count(*) and `sum(x) as count`). NRQL silently keeps
    // only the last → faithful translation is impossible.
    const seen = new Set();
    for (const col of cols) {
      if (seen.has(col.name)) {
        ir.unsupported.push(messages.subquery_name_collision(col.name));
        return;
      }
      seen.add(col.name);
    }
    // mvcount(<values/uniques column>) is the number of distinct values — an
    // aggregate (uniqueCount) computed inside the stats step, not a row-wise
    // length() over the list (which is null across the subquery boundary).
    const evalCmd = rewriteSplColumnNames(
      rewriteMvcountOfUniques(cmd, ir.dataSource.query),
      ir.dataSource.query,
    );
    // Non-scalar: an eval referencing a median/percentile/uniques column (a
    // keyed object/list across the subquery boundary) cannot be used in
    // row-wise arithmetic — numeric() of it is null.
    const nonScalarNames = cols.filter((c) => c.nonScalar).map((c) => c.name);
    ir.select.push(...facetKeys);
    translateEvalExpr(evalCmd, ir, { projectToSelect: true, nonScalarNames });
    return;
  }
  // eval creates bindings: WITH expr AS name
  translateEvalExpr(cmd, ir);
}

// Rewrite `mvcount(v)` — where `v` is an inner `values()`/`uniques()` column — to
// reference a new inner column `uniqueCount(<same args>)`. Returns a new eval
// command (the parsed AST is not mutated); `inner.select` gains the column.
function rewriteMvcountOfUniques(cmd, inner) {
  if (!cmd.assignments) return cmd;
  const uniquesArgs = new Map();
  for (const e of inner.select) {
    const fn = e.type === 'Alias' ? e.expr : e;
    if (fn.type === 'Function' && fn.name === 'uniques' && fn.args.length) {
      uniquesArgs.set(e.type === 'Alias' ? e.name : 'uniques', fn.args);
    }
  }
  if (uniquesArgs.size === 0) return cmd;
  const taken = new Set(inner.select.map((e) => e.name).filter(Boolean));
  const added = new Map();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (
      node.type === 'EvalFunc' &&
      node.name.toLowerCase() === 'mvcount' &&
      node.args.length === 1 &&
      typeof node.args[0] === 'string' &&
      uniquesArgs.has(node.args[0])
    ) {
      const col = node.args[0];
      if (!added.has(col)) {
        let name = `${col}_count`;
        while (taken.has(name)) name = `_${name}`;
        taken.add(name);
        const helper = Alias(Func('uniqueCount', uniquesArgs.get(col)), name);
        Object.defineProperty(helper, '_synthetic', {
          value: true,
          enumerable: false,
        });
        inner.select.push(helper);
        added.set(col, name);
      }
      return added.get(col);
    }
    const copy = Array.isArray(node) ? [] : {};
    for (const [k, v] of Object.entries(node)) copy[k] = visit(v);
    return copy;
  };
  return {
    ...cmd,
    assignments: cmd.assignments.map((a) => ({ ...a, expr: visit(a.expr) })),
  };
}

// Splunk names an unaliased stats column after the call as written
// (`avg(elapsedSec)`), and an eval reads it as `'avg(elapsedSec)'`. The inner
// subquery exposes that aggregate under its NRQL function name (`average`), so
// rewrite such references to the exposed name. Returns a new eval command.
function rewriteSplColumnNames(cmd, inner) {
  if (!cmd.assignments) return cmd;
  const exposedBySplName = new Map();
  for (const e of inner.select) {
    if (e.type === 'Function' && e._splName && e._splName !== e.name) {
      exposedBySplName.set(e._splName, e.name);
    }
  }
  if (exposedBySplName.size === 0) return cmd;
  const visit = (node) => {
    if (typeof node === 'string') return exposedBySplName.get(node) ?? node;
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'QuotedField' && exposedBySplName.has(node.name)) {
      return exposedBySplName.get(node.name);
    }
    const copy = Array.isArray(node) ? [] : {};
    for (const [k, v] of Object.entries(node)) copy[k] = visit(v);
    return copy;
  };
  return {
    ...cmd,
    assignments: cmd.assignments.map((a) => ({ ...a, expr: visit(a.expr) })),
  };
}

// ── Expression translators ──────────────────────────────────

export function translateWhereExpr(expr, ir, options = {}) {
  if (!expr) return null;
  // The where pipe uses the same AST format as search expressions
  // (BooleanOp, Comparison, etc.), not eval expressions (EvalFunc, etc.)
  // However, where_primary can also contain eval-like function calls
  // and comparisons. We need to handle both formats.
  const {
    expr: irExpr,
    warnings,
    unsupported,
    since,
    until,
    consumedTime,
    folded,
  } = translateSearchExpr(expr, ir, options);
  ir.warnings.push(...warnings);
  ir.unsupported.push(...unsupported);
  // A `where _time ...` constraint becomes a SINCE/UNTIL clause, not a WHERE
  // term. translateSearchExpr surfaces it as since/until; copy to ir here
  // (the leading-search caller does the same).
  if (since) ir.since = since;
  if (until) ir.until = until;
  if (irExpr) return irExpr;
  // If translateSearchExpr consumed a `where _time ...` clause (as SINCE/UNTIL,
  // a tautology drop, or unsupported), there is no WHERE term to emit and we
  // must NOT re-walk via the eval fallback (it can't handle the _time node and
  // would emit a spurious unsupported). consumedTime covers the drop case where
  // neither since nor until is set.
  if (consumedTime || since || until) return null;
  // A constant-folded condition (`where "a"="a"`) that simplified away is
  // "always true", not an untranslated expression — no eval fallback.
  if (folded) return null;
  // If translateSearchExpr already emitted unsupported messages for this
  // expression (e.g. Path 2a: non-_time vs now()), don't re-walk through
  // the eval fallback — that would fire a second, spurious unsupported.
  if (unsupported.length > 0) return null;
  // Fallback: try eval expression walker for eval-style where expressions
  return walkEvalExpr(expr, ir);
}

function translateEvalExpr(
  cmd,
  ir,
  { projectToSelect = false, nonScalarNames = [] } = {},
) {
  if (cmd.rawText) {
    // Safety net: eval bodies the ladder still can't parse (e.g. LIKE/IN-in-eval,
    // known follow-ups) emit loud unsupported rather than silently wrong results.
    ir.unsupported.push(messages.eval_not_supported(cmd.rawText));
    return null;
  }
  // Return the first assignment's expression as IR
  // (cmd has assignments array from the PEG grammar)
  if (cmd.assignments) {
    for (const assignment of cmd.assignments) {
      ir._currentAlias = assignment.field;
      const expr = walkEvalExpr(assignment.expr, ir);
      if (expr) {
        // After an aggregation the query has been wrapped as a subquery, so the
        // eval must be an explicit `expr AS name` column on the outer SELECT — a
        // WITH binding would not appear in `SELECT *` output (verified on staging).
        if (projectToSelect) {
          // Guard: eval over a non-scalar aggregate column (median/percentile/
          // uniques) — numeric() over the keyed object/list yields null, so emit
          // loud unsupported instead of a silently-null column.
          if (nonScalarNames.some((n) => exprReferencesField(expr, n))) {
            ir.unsupported.push(
              messages.eval_after_agg_nonscalar(assignment.field),
            );
            continue;
          }
          ir.select.push(Alias(expr, assignment.field));
        } else {
          // A self-reference (`eval e=lower(e)`) is circular as `WITH … AS e`;
          // the pipeline's binding scope (bindingScope.js) renames it to a fresh
          // binding and points every LATER reference at it. Never drop it.
          ir.bindings.push(Binding(assignment.field, expr));
        }
      }
    }
    return null; // bindings/selects added directly
  }
  // Simple single-field eval
  if (cmd.expr) {
    return walkEvalExpr(cmd.expr, ir);
  }
  return null;
}

// ── Eval expression walker ──────────────────────────────────

/**
 * Walk an eval expression AST node and produce an IR expression.
 * Handles: EvalFunc, EvalComparison, EvalBoolOp, EvalParens, StringLiteral, bare strings.
 */
export function walkEvalExpr(node, ir) {
  if (!node) return null;

  // Bare string is now ONLY a leaf field name or numeric-literal token from the
  // grammar (field_name / eval_number / wildcard atom). All operators,
  // comparisons, and arithmetic arrive as typed nodes (EvalArith/EvalComparison/
  // EvalBoolOp/EvalNot).
  if (typeof node === 'string') {
    if (looksLikeNumber(node)) return Literal(Number(node), 'number');
    if (node === '_time') return Identifier('timestamp');
    if (node === '_raw') {
      // _raw is not a NRQL attribute (bare it is a syntax error; backticked it
      // matches nothing) — the raw event text lives in `message`.
      const warning = messages.raw_mapped_to_message();
      if (!ir.warnings.includes(warning)) ir.warnings.push(warning);
      return rawEventIdentifier();
    }
    return Identifier(node);
  }

  switch (node.type) {
    case 'EvalFunc':
      return walkEvalFunc(node, ir);

    case 'StringLiteral':
      return Literal(node.value, 'string');

    case 'QuotedField':
      // SPL `'name'` in eval/where names a field (never a string). Resolve it
      // exactly like a bare field name, but never as a number.
      if (node.name === '_time' || node.name === '_raw') {
        return walkEvalExpr(node.name, ir);
      }
      return Identifier(node.name);

    case 'EvalComparison': {
      const left = walkEvalExpr(node.left, ir);
      const right = walkEvalExpr(node.right, ir);
      if (!left || !right) return null;
      const op = node.op === '==' ? '=' : node.op;
      // For ordering operators on plain fields, wrap in numeric()
      if (['>', '>=', '<', '<='].includes(op)) {
        const numLeft = needsNumeric(node.left)
          ? Func('numeric', [left])
          : left;
        const numRight = needsNumeric(node.right)
          ? Func('numeric', [right])
          : right;
        return BinOp(op, numLeft, numRight);
      }
      // Equality with numeric value: dual-check (string match OR numeric match)
      if (
        (op === '=' || op === '!=') &&
        right.type === 'Literal' &&
        right.kind === 'number' &&
        left.type === 'Identifier'
      ) {
        return DualCheck(left, op, right);
      }
      return BinOp(op, left, right);
    }

    case 'EvalBoolOp': {
      const left = walkEvalExpr(node.left, ir);
      const right = walkEvalExpr(node.right, ir);
      if (!left || !right) return null;
      return BinOp(node.op, left, right);
    }

    case 'EvalArith': {
      // op ∈ { +, -, *, /, %, . }. The grammar emits a single EvalArith for all
      // additive/multiplicative operators; this case decides arithmetic vs concat:
      //   '.'                         → always concat
      //   '+' with a string operand   → concat (one quoted/concat side forces it)
      //   '+' with no string operand  → arithmetic (corpus: field+field is numeric)
      //   '-', '*', '/', '%'          → arithmetic ('%' emitted as mod() downstream)
      const left = walkEvalExpr(node.left, ir);
      const right = walkEvalExpr(node.right, ir);
      if (!left || !right) return null; // loud failure
      const isConcat =
        node.op === '.' ||
        (node.op === '+' && (isStringExpr(left) || isStringExpr(right)));
      if (isConcat) {
        return flattenConcat(left, right);
      }
      return BinOp(node.op, numericize(left), numericize(right));
    }

    case 'EvalNot': {
      const operand = walkEvalExpr(node.operand, ir);
      return operand ? Not(operand) : null;
    }

    case 'EvalParens':
      return walkEvalExpr(node.inner, ir);

    case 'FunctionCall':
      // Where-pipe grammar produces FunctionCall, not EvalFunc — normalize and delegate
      return walkEvalFunc({ name: node.name, args: node.args }, ir);

    default:
      // Unknown typed node — loud failure rather than emitting
      // Identifier('[object Object]'). Reachable only if a new grammar node
      // type is added without a matching walker case.
      ir.unsupported.push(messages.eval_not_supported(JSON.stringify(node)));
      return null;
  }
}

// ── Eval function dispatcher ────────────────────────────────

// An integer literal from the eval ladder (`1`, or unary minus `-1` = 0 - 1).
function getIntegerLiteral(node) {
  if (typeof node === 'string' && /^\d+$/.test(node)) return Number(node);
  if (
    node?.type === 'EvalArith' &&
    node.op === '-' &&
    node.left === '0' &&
    typeof node.right === 'string' &&
    /^\d+$/.test(node.right)
  ) {
    return -Number(node.right);
  }
  return null;
}

// `mvindex(split(s, "D"), n)` — item n of s split on a one-character D — as a
// capture(), since NRQL split() is unavailable on production accounts (an
// "Unknown function", sandbox-verified). Exact: each item is a run of non-D
// characters, and an index past the end gives null, as in Splunk:
//   n >= 0: ^(?:[^D]*D){n}(?P<item>[^D]*)(?s:.*)$
//   n <  0: ^(?:(?s:.*)D)?(?P<item>[^D]*)(?:D[^D]*){|n|-1}$
// null when the call isn't that shape (the caller keeps getField(split())).
function buildSplitItem(args, ir) {
  const [list, indexArg] = args;
  if (list?.type !== 'EvalFunc' || list.name.toLowerCase() !== 'split') {
    return null;
  }
  const [source, delim] = list.args || [];
  const index = getIntegerLiteral(indexArg);
  if (
    args.length !== 2 ||
    list.args.length !== 2 ||
    delim?.type !== 'StringLiteral' ||
    delim.value.length !== 1 ||
    index === null
  ) {
    return null;
  }
  const value = walkEvalExpr(source, ir);
  if (!value) return null;
  const d = delim.value.replace(/[\\^$.|?*+()[\]{}-]/g, '\\$&');
  const pattern =
    index >= 0
      ? `^(?:[^${d}]*${d}){${index}}(?P<item>[^${d}]*)(?s:.*)$`
      : `^(?:(?s:.*)${d})?(?P<item>[^${d}]*)(?:${d}[^${d}]*){${-index - 1}}$`;
  return Func('capture', [value, Regex(pattern)]);
}

// NRQL aggregators. `reduce` accepts an aggregator body; `map` and `filter`
// REJECT one, bare or in-body ("Unknown function sum()" — validated). SPL's
// eval-context `sum()`/`max()` are per-event multivalue reducers, so a user can
// legitimately write one inside mvmap; it just has no `map` translation.
const NRQL_AGGREGATOR_NAMES = new Set([
  'count',
  'sum',
  'average',
  'avg',
  'min',
  'max',
  'median',
  'percentile',
  'percentage',
  'uniquecount',
  'uniques',
  'stddev',
  'latest',
  'earliest',
]);

function containsAggregator(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Function' && NRQL_AGGREGATOR_NAMES.has(node.name)) {
    return true;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      if (value.some(containsAggregator)) return true;
    } else if (value && typeof value === 'object') {
      if (containsAggregator(value)) return true;
    }
  }
  return false;
}

// Replace every reference to `field` with the lambda parameter.
function substituteLambdaParam(node, field, param) {
  return transformTree(node, (n) =>
    n.type === 'Identifier' && n.name === field ? Identifier(param) : n,
  );
}

/**
 * Build an NRQL higher-order collection call — `filter(<coll>, p -> (…))` or
 * `map(<coll>, p -> (…))` — from an SPL multivalue-function call.
 *
 * @param {'filter'|'map'} fn - The NRQL collection function.
 * @param {object|null} collArg - The SPL collection argument, or null to infer
 *   it from the body (SPL `mvfilter` names the field only inside its predicate).
 * @param {object} bodyArg - The SPL body/predicate expression.
 * @param {object} ir
 * @returns {object|null}
 */
function buildCollectionLambdaCall(fn, collArg, bodyArg, ir) {
  if (!getPreview(ir).lambdas) {
    ir.unsupported.push(
      messages.eval_func_unsupported(fn === 'filter' ? 'mvfilter' : 'mvmap'),
    );
    return null;
  }

  // Which SPL field is the collection? Explicit for mvmap; for mvfilter, the
  // single provable collection referenced in the predicate.
  let field = null;
  if (collArg) {
    // In the eval AST a bare field name is a plain STRING; `'name'` is a
    // QuotedField node.
    if (typeof collArg === 'string') field = collArg;
    else if (collArg.type === 'QuotedField') field = collArg.name;
  } else {
    const candidates = [...collectEvalFieldNames(bodyArg)].filter((n) =>
      collectionBindingOf(n, ir),
    );
    // Two collections in one predicate is ambiguous — which one is iterated
    // changes the result, so refuse rather than pick.
    if (candidates.length === 1) field = candidates[0];
  }

  if (!field || !collectionBindingOf(field, ir)) {
    // AI-DEV: Without a provable within-event collection this MUST stay
    // unsupported. A cross-event uniques()/values() list is rejected by NRQL in
    // every form, and over a scalar the collection functions silently treat the
    // value as a one-element list. Do NOT fall back to emitting the call.
    ir.unsupported.push(messages.mv_lambda_source_unknown());
    return null;
  }

  const body = walkEvalExpr(bodyArg, ir);
  if (!body) return null;

  if (fn === 'map' && containsAggregator(body)) {
    ir.unsupported.push(messages.map_rejects_aggregator());
    return null;
  }

  const param = pickLambdaParam(field, body);
  return Func(fn, [
    Identifier(field),
    Lambda([param], substituteLambdaParam(body, field, param)),
  ]);
}

// Every field name referenced in an SPL eval AST subtree. A bare field arrives
// as a plain string (numeric tokens excluded); `'name'` as a QuotedField.
function collectEvalFieldNames(node, acc = new Set()) {
  if (typeof node === 'string') {
    if (!looksLikeNumber(node)) acc.add(node);
    return acc;
  }
  if (!node || typeof node !== 'object') return acc;
  if (node.type === 'QuotedField' && typeof node.name === 'string') {
    acc.add(node.name);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const v of value) collectEvalFieldNames(v, acc);
    } else if (value && typeof value === 'object') {
      collectEvalFieldNames(value, acc);
    } else if (typeof value === 'string') {
      // Only recurse into positional arg/operand slots, never metadata like
      // `type` or an operator spelling.
      if (value !== node.type && value !== node.op && value !== node.name) {
        if (!looksLikeNumber(value)) acc.add(value);
      }
    }
  }
  return acc;
}

// Every Identifier name in a translated IR subtree.
function collectIrIdentifierNames(node, acc = new Set()) {
  if (!node || typeof node !== 'object') return acc;
  if (node.type === 'Identifier' && typeof node.name === 'string') {
    acc.add(node.name);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const v of value) collectIrIdentifierNames(v, acc);
    } else if (value && typeof value === 'object') {
      collectIrIdentifierNames(value, acc);
    }
  }
  return acc;
}

// A lambda parameter name that shadows nothing else referenced in the body — a
// lambda is lexically scoped and can read outer bindings, so a colliding
// parameter would silently shadow one.
function pickLambdaParam(field, body) {
  const used = collectIrIdentifierNames(body);
  for (const candidate of ['e', 'x', 'v', '_e', `${field}_e`]) {
    if (!used.has(candidate)) return candidate;
  }
  return `_${field}_e`;
}

function walkEvalFunc(node, ir) {
  const name = node.name.toLowerCase();
  const args = node.args;

  switch (name) {
    case 'if': {
      if (args.length < 2) return null;
      return Func('if', args.map((a) => walkEvalExpr(a, ir)).filter(Boolean));
    }

    case 'case': {
      // case(cond1, val1, cond2, val2, ...) → nested if()
      // Detect 1=1 default and true() default
      let effectiveArgs = [...args];
      let hasDefault = args.length % 2 === 1;
      if (
        !hasDefault &&
        args.length >= 2 &&
        isTrueCondition(args[args.length - 2])
      ) {
        hasDefault = true;
        effectiveArgs = [...args.slice(0, -2), args[args.length - 1]];
      }

      let expr;
      if (hasDefault) {
        expr = walkEvalExpr(effectiveArgs[effectiveArgs.length - 1], ir);
        for (let i = effectiveArgs.length - 3; i >= 0; i -= 2) {
          const cond = walkEvalExpr(effectiveArgs[i], ir);
          const val = walkEvalExpr(effectiveArgs[i + 1], ir);
          expr = Func('if', [cond, val, expr].filter(Boolean));
        }
      } else {
        expr = Literal(null, 'null');
        for (let i = effectiveArgs.length - 2; i >= 0; i -= 2) {
          const cond = walkEvalExpr(effectiveArgs[i], ir);
          const val = walkEvalExpr(effectiveArgs[i + 1], ir);
          expr = Func('if', [cond, val, expr].filter(Boolean));
        }
      }
      return expr;
    }

    case 'coalesce': {
      // NRQL (a OR b OR c) is null-coalescing — chain with OR
      const coalesceArgs = args.map((a) => walkEvalExpr(a, ir)).filter(Boolean);
      if (coalesceArgs.length === 0) return null;
      if (coalesceArgs.length === 1) return coalesceArgs[0];
      return coalesceArgs.reduce((acc, arg) => BinOp('OR', acc, arg));
    }

    case 'trim':
    case 'ltrim':
    case 'rtrim': {
      // AI-DEV: SPL's optional 2nd argument is a SET OF CHARACTERS to strip
      // (`ltrim(code, "0")` strips leading zeros), NOT a trim type. Neither
      // capture() nor NRQL trim() reproduces that, and ignoring the argument
      // returns the UNTRIMMED value — silently wrong. It MUST stay
      // `unsupported`; do not "fix" this by dropping the argument.
      if (args.length > 1) {
        ir.unsupported.push(messages.trim_charset_unsupported(name));
        return null;
      }
      const child = walkEvalExpr(args[0], ir);
      if (!child) return null;

      // Native NRQL trim() — strips whitespace directly instead of rebuilding
      // the trim as a capture(). Worth gating for: it frees a capture() slot
      // against NRQL's hard limit of 5 per query level, and it returns '' for
      // an empty/all-whitespace input where the regex form cannot.
      if (getPreview(ir).trim) {
        const trimType =
          name === 'ltrim' ? 'LEADING' : name === 'rtrim' ? 'TRAILING' : null;
        return trimType
          ? Func('trim', [child, Literal(trimType, 'string')])
          : Func('trim', [child]);
      }

      const gn = ir._currentAlias || '_t';
      // `(?:.*\S)?` — the group is OPTIONAL so an empty or all-whitespace
      // input yields '' like SPL, not a null capture (a bare `.*\S` requires
      // a non-space character and fails the match outright).
      const pattern =
        name === 'ltrim'
          ? `^\\s*(?P<${gn}>.*)$`
          : name === 'rtrim'
            ? `^(?P<${gn}>(?:.*\\S)?)\\s*$`
            : `^\\s*(?P<${gn}>(?:.*\\S)?)\\s*$`;
      return Func('capture', [child, Regex(pattern)]);
    }

    case 'lower':
    case 'upper':
    case 'abs':
    case 'ceil':
    case 'ceiling':
    case 'floor':
    case 'sqrt':
    case 'exp':
    case 'ln':
      return Func(name, args.map((a) => walkEvalExpr(a, ir)).filter(Boolean));

    case 'round': {
      const val = walkEvalExpr(args[0], ir);
      if (!val) return null;
      if (args.length >= 2) {
        // SPL round(val, N) = N decimal places
        // NRQL round(val, N) = nearest multiple of N
        // Convert: round(val, 2) → round(val, 0.01)
        const decPlaces = walkEvalExpr(args[1], ir);
        const decVal = decPlaces?.type === 'Literal' ? decPlaces.value : null;
        if (decVal != null && typeof decVal === 'number') {
          return Func('round', [val, Literal(Math.pow(10, -decVal), 'number')]);
        }
        return Func('round', [val, decPlaces]);
      }
      return Func('round', [val]);
    }

    case 'len':
    case 'length':
    case 'mvcount': {
      const translated = args.map((a) => walkEvalExpr(a, ir)).filter(Boolean);
      // length() of split()'s array counts its items (sandbox-verified on a
      // jparse array); of a plain string it counts characters.
      const isArray =
        translated.length === 1 &&
        translated[0].type === 'Function' &&
        translated[0].name === 'split';
      if (!isArray) ir.warnings.push(messages.eval_length_warning());
      return Func('length', translated);
    }

    case 'substr': {
      // SPL substr is 1-indexed, NRQL substring is 0-indexed — subtract 1 from positive start
      const translated = args.map((a) => walkEvalExpr(a, ir)).filter(Boolean);
      if (translated.length >= 2) {
        const start = translated[1];
        // Detect negative literal: the unified ladder emits unary minus as
        // EvalArith(op='-', left='0', right=N) in the AST, which walkEvalExpr
        // translates to BinOp('-', Literal(0, 'number'), Literal(N, 'number')).
        // Negative indices are pass-through in both SPL and NRQL (count from end).
        const isNegativeLiteral =
          start.type === 'BinOp' &&
          start.op === '-' &&
          start.left?.type === 'Literal' &&
          start.left.kind === 'number' &&
          start.left.value === 0 &&
          start.right?.type === 'Literal' &&
          start.right.kind === 'number';
        if (
          start.type === 'Literal' &&
          start.kind === 'number' &&
          start.value > 0
        ) {
          translated[1] = Literal(start.value - 1, 'number');
        } else if (!isNegativeLiteral && start.type !== 'Literal') {
          translated[1] = BinOp('-', start, Literal(1, 'number'));
        }
        // Negative indices pass through unchanged (both SPL and NRQL count from end)
      }
      return Func('substring', translated);
    }

    case 'replace': {
      const translated = args.map((a) => walkEvalExpr(a, ir)).filter(Boolean);
      // SPL replace() uses regex; NRQL replace() is literal-only
      if (
        args.length >= 2 &&
        typeof args[1] === 'object' &&
        args[1].type === 'StringLiteral'
      ) {
        const pattern = args[1].value;
        // URLs/paths use ? and + as literals — skip word-quantifier
        // check for strings that look like URLs or paths
        const isUrlOrPath = /^\/|:\/\//.test(pattern);
        // Detect regex syntax in the post-parse value. The parser already
        // interprets escapes (\t→tab, \d→d), so we check for structural
        // patterns: char classes, groups, dot-quantifiers, brace repetition,
        // anchors, alternation, quantifiers after word/group/class chars.
        // For URL/path patterns, skip \w[+*?] to avoid false positives
        // on query strings (?key=val) and encoded spaces (+)
        const regexCoreRe =
          /\[.*\]|\(.*\)|\.[*+?]|\{\d+[,}]|^\^|\$$|\||\)[+*?]|\][+*?]/;
        const wordQuantifierRe = /\w[+*?]/;
        if (
          regexCoreRe.test(pattern) ||
          (!isUrlOrPath && wordQuantifierRe.test(pattern))
        ) {
          // Splunk replace() is regex and global. An anchored pattern matches
          // once, so a capture() split + concat() rebuild is exact
          // (regexReplace.js); anything else stays loud.
          const replacementArg = args[2];
          const result =
            !ir._hasAggregation &&
            translated.length === 3 &&
            replacementArg &&
            typeof replacementArg === 'object' &&
            replacementArg.type === 'StringLiteral'
              ? buildRegexReplace({
                  source: translated[0],
                  pattern,
                  replacement: replacementArg.value,
                  global: true,
                  isSed: false,
                  base: nextReplaceBase(ir, 'repl'),
                })
              : null;
          if (result && !('error' in result)) {
            ir.bindings.push(...result.bindings);
            return result.expr;
          }
          ir.unsupported.push(messages.eval_replace_regex(pattern));
          return null;
        }
      }
      return Func('replace', translated);
    }

    case 'isnull':
      return IsNull(walkEvalExpr(args[0], ir));

    case 'isnotnull': {
      const child = walkEvalExpr(args[0], ir);
      return child ? Not(IsNull(child)) : null;
    }

    case 'isint':
    case 'isnum': {
      // SPL isint()/isnum() → NRQL numeric(field) IS NOT NULL
      const child = walkEvalExpr(args[0], ir);
      return child ? Not(IsNull(Func('numeric', [child]))) : null;
    }

    case 'like': {
      // like(_raw, …) stays on message (via walkEvalExpr): dimensions() also
      // matches attribute NAMES, so a short pattern hits nearly every event.
      const field = walkEvalExpr(args[0], ir);
      // Pattern arg may be a raw string (from where-pipe FunctionCall)
      const rawPat = args[1];
      const patStr =
        typeof rawPat === 'string'
          ? rawPat
          : rawPat?.type === 'StringLiteral'
            ? rawPat.value
            : (walkEvalExpr(rawPat, ir)?.value ?? String(rawPat));
      if (field && patStr) {
        // SPL `like()` uses `%` as its wildcard, but real-world queries also
        // pass `*` (search-clause convention). Convert both to `%`. Then
        // escape `'` so apostrophes in user content don't terminate the NRQL
        // string literal.
        const nrqlPattern = patStr.replace(/\*/g, '%').replace(/'/g, "\\'");
        return Like(field, nrqlPattern);
      }
      return null;
    }

    case 'cidrmatch': {
      // cidrmatch("10.0.0.0/8", src_ip) → cidrAddress(src_ip, 8) = '10.0.0.0/8'
      const rawCidr = args[0];
      const cidrStr =
        typeof rawCidr === 'string'
          ? rawCidr
          : rawCidr?.type === 'StringLiteral'
            ? rawCidr.value
            : (walkEvalExpr(rawCidr, ir)?.value ?? String(rawCidr));
      const ipField = walkEvalExpr(args[1], ir);
      if (cidrStr && ipField) {
        const prefixMatch = cidrStr.match(/\/(\d+)$/);
        const prefix = prefixMatch ? Number(prefixMatch[1]) : 24;
        return BinOp(
          '=',
          Func('cidrAddress', [ipField, Literal(prefix, 'number')]),
          Literal(cidrStr, 'string'),
        );
      }
      return null;
    }

    case 'match': {
      const field = walkEvalExpr(args[0], ir);
      // Pattern arg may be a raw string (from where-pipe FunctionCall)
      // or a StringLiteral/Literal node (from eval AST)
      const rawPattern = args[1];
      const patternStr =
        typeof rawPattern === 'string'
          ? rawPattern
          : rawPattern?.type === 'StringLiteral'
            ? rawPattern.value
            : (walkEvalExpr(rawPattern, ir)?.value ?? String(rawPattern));
      if (field && patternStr) {
        return buildRegexMatch(field, patternStr);
      }
      return null;
    }

    case 'tonumber': {
      return Func(
        'numeric',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );
    }

    case 'now':
      return Func('now', []);

    case 'null':
      return Literal(null, 'null');

    case 'true':
      return Func('true', []);

    case 'mvjoin':
      ir.unsupported.push(messages.eval_mvjoin_unsupported());
      return walkEvalExpr(args[0], ir);

    case 'mvappend': {
      // An array literal is the NRQL form of "these values as one collection".
      // Caveat: SPL mvappend FLATTENS a nested multivalue argument, where
      // `[a, b]` nests it — equivalent only for scalar arguments.
      if (getPreview(ir).arrayMaps && args.length >= 2) {
        const elements = [];
        for (const a of args) {
          const el = walkEvalExpr(a, ir);
          if (!el) return null;
          elements.push(el);
        }
        return ArrayLiteral(elements);
      }
      ir.unsupported.push(messages.eval_func_unsupported(name));
      return null;
    }

    case 'mvsort':
      // Not NRQL functions — emitting them verbatim is "Unknown function" on
      // New Relic (sandbox-verified for mvappend).
      ir.unsupported.push(messages.eval_func_unsupported(name));
      return null;

    case 'mvfilter':
      // SPL `mvfilter(<predicate>)` takes ONE argument; the multivalue field is
      // named inside the predicate and becomes the lambda parameter.
      if (args.length !== 1) {
        ir.unsupported.push(messages.eval_func_unsupported(name));
        return null;
      }
      return buildCollectionLambdaCall('filter', null, args[0], ir);

    case 'mvmap':
      // SPL `mvmap(<field>, <expr>)` — the collection is explicit.
      if (args.length !== 2) {
        ir.unsupported.push(messages.eval_func_unsupported(name));
        return null;
      }
      return buildCollectionLambdaCall('map', args[0], args[1], ir);

    case 'mvindex': {
      if (args.length < 2) {
        ir.warnings.push(messages.eval_mvindex_args());
        return walkEvalExpr(args[0], ir);
      }
      // `mvindex(split(s, "D"), n)` has an exact capture() form for a negative
      // n too, so try it before the guards below reject one.
      const item = buildSplitItem(args, ir);
      if (item) return item;
      // AI-DEV: A negative or computed index MUST be `unsupported`, never
      // emitted. NRQL `getField()` indexes from 0 and has no from-the-end
      // form, so `getField(f, -1)` and `getField(f, length(f) - 1)` return
      // null where Splunk returns the last element — silent-wrong, which the
      // loud-failure rule forbids. A bare field index (`mvindex(f, i)`) is
      // left alone: it is correct whenever i >= 0 at runtime.
      const index = getIntegerLiteral(args[1]);
      if (index !== null ? index < 0 : args[1]?.type === 'EvalArith') {
        ir.unsupported.push(messages.mvindex_last_element());
        return null;
      }
      // SPL's 3-argument form returns the sublist between two indexes; NRQL
      // getField() takes exactly one index, so `getField(f, 0, 2)` does not
      // compile.
      if (args.length > 2) {
        ir.unsupported.push(messages.mvindex_range_unsupported());
        return null;
      }
      return Func(
        'getField',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );
    }

    case 'split': {
      // AI-DEV: A delimiter NRQL cannot accept MUST be `unsupported`, never a
      // warning. NRQL split() takes a delimiter of exactly one character and
      // rejects anything else at compile time ("split delimiter must be one
      // character"), so emitting split() anyway returns NRQL that does not
      // run — a warning-and-emit here is the loud-failure rule inverted.
      const delimArg = args[1];
      if (delimArg) {
        if (delimArg.type !== 'StringLiteral') {
          // A runtime value can't be proven to be one character.
          ir.unsupported.push(messages.split_dynamic_delimiter());
          return null;
        }
        if (delimArg.value.length === 0) {
          // Splunk splits into single characters; NRQL has no such form.
          ir.unsupported.push(messages.split_empty_delimiter());
          return null;
        }
        if (delimArg.value.length > 1) {
          ir.unsupported.push(
            messages.split_multi_char_delimiter(delimArg.value),
          );
          return null;
        }
      }
      const source = walkEvalExpr(args[0], ir);
      if (!source) return null;
      const splitArgs = [source];
      if (delimArg) {
        const delim = walkEvalExpr(delimArg, ir);
        if (!delim) return null;
        splitArgs.push(delim);
      }
      // NRQL caps split() at 256 elements and drops the rest silently.
      ir.warnings.push(messages.split_element_cap());
      return Func('split', splitArgs);
    }

    case 'pow':
      return Func('pow', args.map((a) => walkEvalExpr(a, ir)).filter(Boolean));

    case 'log': {
      // SPL log(val) = log base 10; log(val, base) = log with base
      // NRQL log(val, base) requires two args; log10(val) for base 10
      const logArgs = args.map((a) => walkEvalExpr(a, ir)).filter(Boolean);
      if (logArgs.length === 1) return Func('log10', logArgs);
      return Func('log', logArgs);
    }

    case 'log10':
      return Func(
        'log10',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );

    case 'log2':
      return Func('log2', args.map((a) => walkEvalExpr(a, ir)).filter(Boolean));

    case 'tostring':
      // SPL tostring(x, "hex"|"commas"|"duration") formats the value; NRQL
      // string()'s second argument is an integer precision, so passing the
      // format through is an argument error on New Relic.
      if (args.length > 1) {
        const format = args[1];
        const text =
          format && typeof format === 'object' && 'value' in format
            ? format.value
            : String(format);
        const value = args.length === 2 ? walkEvalExpr(args[0], ir) : null;
        if (text === 'commas' && value) {
          // "commas" rounds to 2 decimals and groups thousands. string(x, 2)
          // rounds the same way (15921 → "15921", 15921.034 → "15921.03",
          // sandbox-verified); only the grouping is lost.
          ir.warnings.push(messages.tostring_commas_grouping_lost());
          return Func('string', [value, Literal(2, 'number')]);
        }
        ir.unsupported.push(messages.tostring_format_unsupported(text));
        return null;
      }
      // SPL tostring() → NRQL string()
      return Func(
        'string',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );

    case 'json_extract':
    case 'spath': {
      // SPL json_extract(field, "$.path") or spath(field, "path") → jparse(field, 'path')
      const fieldArg = walkEvalExpr(args[0], ir);
      const pathArg = args[1];
      let path =
        typeof pathArg === 'string'
          ? pathArg
          : (pathArg && pathArg.value) || '';
      // Strip JSONPath $. prefix — jparse uses bare paths
      path = path.replace(/^\$\.?/, '');
      // Convert Splunk {} array notation to [] for jparse
      path = path.replace(/\{(\d*)\}/g, (_, n) => (n ? `[${n}]` : '[*]'));
      return Func('jparse', [fieldArg, Literal(path, 'string')]);
    }

    case 'strftime':
    case 'strptime': {
      // The format must be a quoted string literal (StringLiteral node). A bare
      // field arrives as a raw string (its NAME); a computed format as a typed
      // node — neither is a static format we can precompile. Baking a field name
      // in as a literal pattern is silent-wrong (strftime(_time, myfmt) →
      // toDatetime(.., 'myfmt')), so require a literal and fail loud otherwise.
      const fmtArg = args[1];
      if (
        !fmtArg ||
        fmtArg.type !== 'StringLiteral' ||
        typeof fmtArg.value !== 'string'
      ) {
        ir.unsupported.push(messages.strftime_nonliteral_format(name));
        return null;
      }
      const { pattern, unmappable } = splFormatToJava(fmtArg.value);
      if (unmappable.length) {
        // One message per unmappable code so the user sees them all at once,
        // instead of fixing one, re-running, and hitting the next.
        for (const code of unmappable) {
          ir.unsupported.push(messages.strftime_unmappable_code(code));
        }
        return null;
      }
      const src = walkEvalExpr(args[0], ir);
      if (!src) {
        // src is null when the epoch/source arg is itself untranslatable — e.g.
        // strftime(<unsupported-func>(x), "%Y"). Reachable, so keep the guard.
        ir.unsupported.push(messages.eval_func_unsupported(name));
        return null;
      }
      if (name === 'strptime') {
        // toTimestamp returns ms; Splunk strptime returns seconds → /1000.
        ir.warnings.push(messages.strptime_units_warning());
        return BinOp(
          '/',
          Func('toTimestamp', [src, Literal(pattern, 'string')]),
          Literal(1000, 'number'),
        );
      }
      // strftime → toDatetime; warn when the epoch source isn't _time/timestamp
      // (a seconds-epoch field would render a 1970 date — NR timestamp is ms).
      if (!(src.type === 'Identifier' && src.name === 'timestamp')) {
        ir.warnings.push(messages.strftime_epoch_units_warning());
      }
      return Func('toDatetime', [src, Literal(pattern, 'string')]);
    }

    case 'typeof':
    case 'isbool':
    case 'isstr': {
      ir.unsupported.push(messages.eval_func_unsupported(name));
      return null;
    }

    case 'searchmatch': {
      // searchmatch("<search terms>") evaluates search syntax against the event.
      // Translate the string with the search-clause translator (bare terms →
      // message LIKE, field=value → comparison). Splunk matches bare terms
      // against the whole raw event; NR Log keeps that text in `message`.
      const arg = args[0];
      const text =
        typeof arg === 'object' && arg?.type === 'StringLiteral'
          ? arg.value
          : null;
      if (text === null || args.length !== 1) {
        ir.unsupported.push(messages.searchmatch_nonliteral());
        return null;
      }
      let ast;
      try {
        ast = parser.parse(text);
      } catch {
        ast = null;
      }
      if (!ast || ast.commands.length > 0 || !ast.search) {
        ir.unsupported.push(messages.searchmatch_unparsed(text));
        return null;
      }
      const { expr, warnings, unsupported } = translateSearchExpr(
        ast.search,
        ir,
      );
      ir.warnings.push(...warnings);
      ir.unsupported.push(...unsupported);
      if (!expr) return null;
      ir.warnings.push(messages.searchmatch_raw_event());
      return expr;
    }

    case 'sum': {
      // Row-wise sum(a, b, …) = a + b + … . (One argument is a multivalue sum
      // over a single field, which NRQL has no row-wise form for.)
      if (args.length < 2) {
        ir.unsupported.push(messages.eval_func_unsupported(name));
        return null;
      }
      const terms = args.map((a) => walkEvalExpr(a, ir));
      if (terms.some((t) => !t)) return null;
      return terms.map(numericize).reduce((acc, t) => BinOp('+', acc, t));
    }

    case 'relative_time': {
      ir.unsupported.push(messages.eval_relative_time_unsupported());
      return null;
    }

    // Gap #5: mvzip has no NRQL equivalent
    case 'mvzip': {
      ir.unsupported.push(messages.mvzip_unsupported());
      return null;
    }

    default: {
      // Unknown function — pass through with warning
      ir.unsupported.push(messages.eval_func_unsupported(name));
      return Func(name, args.map((a) => walkEvalExpr(a, ir)).filter(Boolean));
    }
  }
}

// ── Internal helpers ────────────────────────────────────────

// NRQL aggregates whose subquery-exposed column is a LIST (uniques — the NRQL form
// of SPL values/list). A list has no scalar extraction, so an eval-projection
// referencing one after stats is unsupported. median/percentile expose a KEYED
// OBJECT ({50:v} / {N:v}); they are NOT listed here — the optimizer's
// foldPostAggregation pass folds eval-arithmetic over them FLAT (`median(d) * 2`,
// valid NRQL) and extracts the scalar via getField(col,'<N>') for a where/trailing-agg
// reference. Keeping them out of this set is what re-opens that faithful path.
const NON_SCALAR_AGG_FUNCS = new Set(['uniques']);

function isNonScalarAgg(expr) {
  return expr?.type === 'Function' && NON_SCALAR_AGG_FUNCS.has(expr.name);
}

// The name + scalar-ness a subquery exposes for one inner SELECT entry. A
// subquery exposes an unaliased aggregate under its bare NRQL function name; an
// `AS alias` re-keys it (engine: DistributedFunctionLeaf.flattenResultLeaf).
// Returns null for entries that aren't simple aggregate columns (e.g. the
// arithmetic produced by `top`'s percent column).
function exposedSubqueryColumn(entry) {
  if (entry.type === 'Alias') {
    return { name: entry.name, nonScalar: isNonScalarAgg(entry.expr) };
  }
  if (entry.type === 'Function') {
    return {
      name: entry.name,
      nonScalar: NON_SCALAR_AGG_FUNCS.has(entry.name),
    };
  }
  return null;
}

// True when an EVAL AST NODE is a bare field reference that must be wrapped in
// numeric() for an ordering comparison.
//   - bare string that isn't a number → bare field name leaf from grammar → true
//   - typed nodes (EvalFunc, StringLiteral, EvalArith, EvalParens) → false
function needsNumeric(node) {
  if (typeof node === 'string') {
    return !looksLikeNumber(node) && !/[+\-*/%()]/.test(node);
  }
  return false;
}

// Wrap a bare-field IR expression in numeric() for arithmetic context.
// Numbers, functions, and already-wrapped expressions pass through unchanged.
function numericize(expr) {
  if (!expr) return expr;
  if (expr.type === 'Literal' && expr.kind === 'number') return expr;
  if (expr.type === 'Identifier') return Func('numeric', [expr]);
  return expr; // BinOp/Function/etc. already typed — don't double-wrap
}

// NRQL functions the eval walker emits that return a string value. Drives the
// `+` concat decision: `lower(a) + b` is concat, not arithmetic. Only functions
// that UNAMBIGUOUSLY return a string belong here — `if`/`jparse` are
// type-ambiguous and deliberately excluded (they fall through to arithmetic,
// the field+field default).
const STRING_RETURNING_FUNCS = new Set([
  'concat',
  'lower',
  'upper',
  'substring',
  'string',
  'replace',
  'capture',
]);

// True when an eval expression is statically known to be a string: a string
// literal, a string-returning function call, or a parenthesized string.
// Drives the '+' concat-vs-arithmetic decision.
function isStringExpr(expr) {
  if (!expr) return false;
  if (expr.type === 'Literal' && expr.kind === 'string') return true;
  if (expr.type === 'Function' && STRING_RETURNING_FUNCS.has(expr.name)) {
    return true;
  }
  return false;
}

// Merge nested concats so `a . b . c` emits concat(a, b, c) not
// concat(concat(a, b), c). Each side is already a walked IR expression.
function flattenConcat(left, right) {
  const flat = [];
  for (const side of [left, right]) {
    if (side && side.type === 'Function' && side.name === 'concat') {
      flat.push(...side.args);
    } else {
      flat.push(side);
    }
  }
  return Func('concat', flat);
}

function isTrueCondition(node) {
  if (typeof node === 'string') return node === '1' || node === 'true';
  if (node && node.type === 'EvalComparison') {
    return node.left === '1' && node.op === '=' && node.right === '1';
  }
  return !!(node && node.type === 'EvalFunc' && node.name === 'true');
}
