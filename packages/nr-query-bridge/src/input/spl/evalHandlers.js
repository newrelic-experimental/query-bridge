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
  Rlike,
  Regex,
  Binding,
  Alias,
  DualCheck,
} from '../../ir/nodes.js';
import {
  looksLikeNumber,
  exprReferencesField,
  wrapAsSubquery,
} from './splExprUtils.js';
// Circular import — safe because translateSearchExpr is only called at runtime, not at module load time
import { translateSearchExpr } from './splToIR.js';
import * as parser from './splParser.js';
import { messages } from '../../messages.js';
import { splFormatToJava } from './splFormatCodes.js';

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
  const expr = translateWhereExpr(whereNode, ir);
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
    const evalCmd = rewriteMvcountOfUniques(cmd, ir.dataSource.query);
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

// ── Expression translators ──────────────────────────────────

export function translateWhereExpr(expr, ir) {
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
  } = translateSearchExpr(expr, ir);
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
        } else if (exprReferencesField(expr, assignment.field)) {
          // NRQL WITH clause can't alias to a field that the expression references
          // (circular dependency). In that case, inline into SELECT instead.
          ir.select.push(expr);
        } else {
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
    return Identifier(node);
  }

  switch (node.type) {
    case 'EvalFunc':
      return walkEvalFunc(node, ir);

    case 'StringLiteral':
      return Literal(node.value, 'string');

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

    case 'trim': {
      const child = walkEvalExpr(args[0], ir);
      const gn = ir._currentAlias || '_t';
      return child
        ? Func('capture', [child, Regex(`^\\s*(?P<${gn}>.*\\S)\\s*$`)])
        : null;
    }
    case 'ltrim': {
      const child = walkEvalExpr(args[0], ir);
      const gn = ir._currentAlias || '_t';
      return child
        ? Func('capture', [child, Regex(`^\\s*(?P<${gn}>.*)$`)])
        : null;
    }
    case 'rtrim': {
      const child = walkEvalExpr(args[0], ir);
      const gn = ir._currentAlias || '_t';
      return child
        ? Func('capture', [child, Regex(`^(?P<${gn}>.*\\S)\\s*$`)])
        : null;
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
      ir.warnings.push(messages.eval_length_warning());
      return Func(
        'length',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );
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
          ir.unsupported.push(messages.eval_replace_regex(pattern));
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
        return Rlike(field, patternStr);
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

    case 'mvappend':
      return Func(
        'mvappend',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );

    case 'mvsort':
      return Func(
        'mvsort',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );

    case 'mvindex': {
      if (args.length < 2) {
        ir.warnings.push(messages.eval_mvindex_args());
        return walkEvalExpr(args[0], ir);
      }
      return Func(
        'getField',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );
    }

    case 'split': {
      // Gap #13: NRQL split() only supports single-character delimiters
      const delimArg = args[1];
      if (
        delimArg &&
        delimArg.type === 'StringLiteral' &&
        delimArg.value.length > 1
      ) {
        ir.warnings.push(messages.split_multi_char_delimiter(delimArg.value));
      }
      return Func(
        'split',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );
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
