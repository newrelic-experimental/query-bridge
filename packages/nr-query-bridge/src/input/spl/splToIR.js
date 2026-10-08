/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SPL AST → IR translation (Pass 1).
 *
 * Walks the PEG.js-produced SPL AST and builds an IR query plan.
 * Each SPL command transforms the IR structurally.
 */
import {
  SelectQuery,
  Identifier,
  Literal,
  BinOp,
  Not,
  Func,
  IsNull,
  Like,
  In,
  RawNrql,
} from '../../ir/nodes.js';
import { parseSplTime } from './splTime.js';
import {
  buildComparison,
  buildJparseComparison,
  coerceValue,
  escapeWildcard,
  isNumeric,
  normalizeSubsearch,
  rawEventIdentifier,
  stripTimeBucketFacets,
} from './splExprUtils.js';
import * as parser from './splParser.js';
import { messages } from '../../messages.js';
import {
  collectAutoExtractFields,
  collectDownstreamFieldRefs,
} from './spathAutoExtract.js';
import { isDedupCountDistinct } from './dedupCountDistinct.js';
import { createBindingScope } from './bindingScope.js';
import { setPreview } from '../../previewFlags.js';
import { formatRexAsAparse } from './rexAparse.js';
import { applyWildcardRenames } from './wildcardRename.js';
import { handleEval, handleWhere, walkEvalExpr } from './evalHandlers.js';
import {
  handleTable,
  handleFields,
  handleSort,
  handleHead,
  handleTail,
  handleRename,
  handleDedup,
  handleBin,
  handleReverse,
  handleFillnull,
  handleConvert,
  handleReplace,
  handleStrcat,
  handleMvexpand,
  handleUniq,
} from './rowHandlers.js';
import {
  handleRex,
  handleSpath,
  handleRegex,
  handleSearchPipe,
} from './extractionHandlers.js';
import {
  handleJoin,
  handleAppend,
  handleAppendpipe,
  handleInputlookup,
  handleLookup,
} from './enrichmentHandlers.js';
import {
  handleStats,
  handleTimechart,
  handleTop,
  handleRare,
  handleEventstats,
  handleChart,
} from './aggregationHandlers.js';

// NRQL functions NOT implemented in the row-wise (per-event) evaluator. They
// compile in some aggregation contexts but fail `Not supported: Call <fn>` on a
// WHERE comparison RHS. Verified via MCP 2026-06-10.
const ROW_WISE_UNIMPLEMENTED = new Set([
  'jparse',
  'convert',
  'cidrAddress',
  'toTimestamp',
  'toDatetime',
  'decode',
  'encode',
  'mapKeys',
  'mapValues',
  'lookup',
  'blob',
]);

// Find the first unimplemented-on-RHS function name anywhere in a SPL AST
// expression node, or null if none. SPL AST functions use type 'EvalFunc' or
// 'FunctionCall' with a 'name' field. Recurses into args and binary sides.
function findUnimplementedRhsFuncInAst(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'EvalFunc' || node.type === 'FunctionCall') {
    const name = typeof node.name === 'string' ? node.name.toLowerCase() : '';
    if (ROW_WISE_UNIMPLEMENTED.has(name)) return name;
    for (const a of node.args || []) {
      const hit = findUnimplementedRhsFuncInAst(a);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of ['left', 'right', 'operand', 'inner', 'value']) {
    if (node[key]) {
      const hit = findUnimplementedRhsFuncInAst(node[key]);
      if (hit) return hit;
    }
  }
  for (const a of node.args || []) {
    const hit = findUnimplementedRhsFuncInAst(a);
    if (hit) return hit;
  }
  return null;
}

/**
 * Main entry: translate a parsed SPL AST into an IR query plan.
 */
// A Splunk `$env:…$` runtime-context token (current app/page/user/locale + user-profile
// fields). Detected by the literal `env:` prefix — the colon is required, so a plain
// `$env$` user variable (no colon) is never reclassified. NR has no widget-level
// runtime-context token, so an env: token can never become a faithful {{…}} variable.
function isEnvToken(name) {
  return name.startsWith('env:');
}

// `field=$tok$` in a search: Splunk compares search-term values
// case-insensitively, NRQL's `=` doesn't. lower() alone is wrong for numbers —
// lower(100) is NULL and NULL = NULL is true in NRQL, so it matched every event
// (sandbox) — hence string() first, which also compares a number variable
// against a number attribute ('100' = '100'). `index` stays plain: the consumer
// maps an index token to its own source. Ordering ops, and `where` (which
// Splunk compares case-sensitively), stay plain too.
function buildTokenComparison(op, field, name, isCaseSensitive) {
  const token = Identifier(`{{${name}}}`);
  if (isCaseSensitive || field === 'index' || (op !== '=' && op !== '!=')) {
    return BinOp(op, Identifier(field), token);
  }
  const folded = (node) => Func('lower', [Func('string', [node])]);
  return BinOp(op, folded(Identifier(field)), folded(token));
}

// A token NAME containing ':' or '-' cannot tokenize inside an NRQL {{…}} variable
// (a hard NRDB parse error — verified acct 1). Emitted as {{name}} it would not run.
function hasUntranslatableTokenChar(name) {
  return name.includes(':') || name.includes('-');
}

// A dashboard token anywhere inside free search text (`"brandCode\":\"$brand$"`).
const TOKEN_IN_TEXT = /\$[A-Za-z0-9_.:-]+\$/;

// A search phrase containing a dashboard token. New Relic never substitutes
// {{tok}} inside a LIKE pattern, and LIKE accepts only a literal (LIKE concat(…)
// is a syntax error), so the phrase becomes a substring test built from concat():
//   position(lower(message), lower(concat('brandCode":"', {{brand}}))) >= 0
// lower() on both sides keeps Splunk's case-insensitive term match (position()
// is case-sensitive). Sandbox-verified by the consumer (same count as the LIKE,
// and substituted on a rendered dashboard). The position() call is attached as
// `_phrasePosition` so a surrounding NOT can emit a null-safe negation.
function buildPhraseTokenMatch(value, unsupported) {
  if (value.includes('*')) {
    // A wildcard can't be expressed in a position() substring test.
    unsupported.push(messages.affixed_token_unsupported('message', value));
    return null;
  }
  const parts = value.split(/\$([A-Za-z0-9_.:-]+)\$/);
  const args = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) args.push(Literal(parts[i], 'string'));
      continue;
    }
    const name = parts[i];
    if (isEnvToken(name)) {
      unsupported.push(messages.splunk_env_token(name));
      return null;
    }
    if (hasUntranslatableTokenChar(name)) {
      unsupported.push(messages.token_name_unsupported(name));
      return null;
    }
    args.push(Identifier(`{{${name}}}`));
  }
  const needle = args.length === 1 ? args[0] : Func('concat', args);
  const pos = Func('position', [
    Func('lower', [rawEventIdentifier()]),
    Func('lower', [needle]),
  ]);
  const match = BinOp('>=', pos, Literal(0, 'number'));
  Object.defineProperty(match, '_phrasePosition', {
    value: pos,
    enumerable: false,
  });
  return match;
}

/**
 * SPL AST → IR.
 *
 * @param {object} ast - The parsed SPL AST.
 * @param {Readonly<Record<string, boolean>>} [preview] - Normalized NRQL Beta
 *   gates (see `previewFlags.js`). Passed explicitly to each command handler
 *   rather than stored on the IR, so a `wrapAsSubquery` level cannot lose it.
 * @returns {object} The IR.
 */
export function translateAstToIR(ast, preview = {}) {
  const ir = SelectQuery();
  setPreview(ir, preview);

  // Search clause → WHERE
  if (ast.search) {
    const {
      expr,
      warnings,
      unsupported,
      since,
      until,
      sawTimeToken,
      sawTimeLiteral,
    } = translateSearchExpr(ast.search, ir);
    if (expr) ir.where.push(expr);
    if (sawTimeToken && sawTimeLiteral) {
      // Mixed literal+token window: dropping only the token would silently widen
      // or invert the range. Fail loud and emit no bound at all.
      ir.unsupported.push(messages.mixed_token_literal_time_unsupported());
    } else if (until && !since) {
      // Upper bound with no lower bound. We can't fabricate a safe SINCE: any
      // fixed default inverts the window when `until` resolves older than it
      // (NRQL rejects start >= end), and we can't evaluate relative offsets
      // statically. Fail loud rather than emit a window that may not compile.
      ir.unsupported.push(messages.latest_without_earliest_unsupported());
    } else {
      if (since) ir.since = since;
      if (until) ir.until = until;
    }
    ir.warnings.push(...warnings);
    ir.unsupported.push(...unsupported);
  }

  // Pipeline: each command transforms the IR
  const scope = createBindingScope();
  scope.seed(ir);
  let sawDedup = false;
  let mvexpandCount = 0;
  for (let i = 0; i < ast.commands.length; i++) {
    const cmd = ast.commands[i];
    if (cmd.type === 'DedupCommand') {
      // `dedup K … | stats count …` counts distinct K: translate flat as
      // uniqueCount(K) (handleStats) instead of a nested FACET K subquery.
      cmd._countDistinct =
        !ir._hasAggregation &&
        isDedupCountDistinct(cmd, ast.commands.slice(i + 1));
      if (!cmd._countDistinct) sawDedup = true;
    }
    // join / eventstats: which fields later stages read decides whether a bare
    // subsearch can join on its key alone, whether an eventstats list column
    // (values/list) can be dropped, and which fields a dedup must carry
    // (handleJoin, handleEventstats, handleDedup).
    if (
      cmd.type === 'JoinCommand' ||
      cmd.type === 'EventstatsCommand' ||
      cmd.type === 'DedupCommand'
    ) {
      cmd._downstreamRefs = collectDownstreamFieldRefs(
        ast.commands.slice(i + 1),
        { stopAtJoin: cmd.type === 'DedupCommand' },
      );
    }
    if (cmd.type === 'MvexpandCommand') mvexpandCount++;
    // Gap #2, #9: warn when dedup precedes aggregation
    if (
      sawDedup &&
      (cmd.type === 'StatsCommand' ||
        cmd.type === 'TimechartCommand' ||
        cmd.type === 'ChartCommand')
    ) {
      ir.warnings.push(messages.dedup_limit_max_cap());
      if (cmd.type === 'TimechartCommand') {
        ir.warnings.push(messages.dedup_timeseries_warning());
      }
    }
    // spath auto-extract (no path=): enumerate the fields referenced downstream so
    // handleSpath can bind each as jparse(<source>, '<field>'). null when not safely
    // enumerable → handleSpath emits the loud spath_no_path.
    if (cmd.type === 'SpathCommand' && !cmd.path) {
      cmd._autoExtractFields = collectAutoExtractFields(
        ast.commands.slice(i + 1),
      );
    }
    // Binding names: rename colliding WITH bindings and point later references
    // at them, in pipeline order (bindingScope.js).
    const wasAggregated = ir._hasAggregation;
    scope.beforeCommand(cmd);
    applyCommand(cmd, ir);
    scope.afterCommand(cmd, ir, wasAggregated);
  }
  scope.finish(ir);

  // Wildcard rename (`rename <prefix>.* as *`): register the prefix rewrite for
  // eligible downstream references, or emit a loud guard / drop-warning. Runs
  // before optimize()'s applyFieldReplacements substitutes the registered map.
  applyWildcardRenames(ir);

  // Gap #3: cascading mvexpand. Each mvexpand that resolved to a provable
  // collection pushed its own ExpandClause (handleMvexpand), and the emitter
  // renders one EXPAND per clause at this level — so a fully-resolved cascade
  // needs no bail. Any mvexpand that did NOT resolve already pushed
  // `mvexpand_unsupported`; the cascade is additionally unsupported because the
  // nested-FROM workaround the message names cannot be built from a half-
  // resolved chain.
  //
  // AI-DEV: Two EXPAND clauses at one query level are emitted on the
  // assumption that NRQL fans them out as a CARTESIAN product, matching
  // Splunk's cascading mvexpand. That assumption is NOT verified against a
  // flag-enabled account (probe V-7). Do NOT remove
  // `expand_cascading_unverified` until it is — a zip or sequential fan-out
  // would silently undercount, and the warning is the only thing telling the
  // user to check.
  if (mvexpandCount > 1) {
    if (ir.expand.length === mvexpandCount) {
      ir.warnings.push(messages.expand_cascading_unverified(mvexpandCount));
    } else {
      ir.unsupported.push(messages.mvexpand_cascading());
    }
  }

  // Gap #12: Splunk computes all groups by default; NRQL FACET defaults to 10.
  // Don't inject LIMIT MAX — it can cause performance issues in UI contexts.
  // Warn so the user can decide.
  if (ir.facet.length > 0 && ir.limit == null) {
    ir.warnings.push(messages.facet_default_limit());
  }

  // Gap #7: NRQL limits capture() to 5 calls per query. New Relic rejects the
  // 6th ("RegexCapture supports a maximum of 5 capture function calls"), so this
  // is unsupported, not a warning over NRQL that cannot run.
  // aparse() doesn't count toward it, so simple rex patterns (literal anchors
  // around the groups) become aparse(), latest rex first, until 5 remain.
  // The limit is per query level (sandbox: 6 in a subquery are rejected, 3 in
  // a subquery plus 3 outside run), so every level is checked on its own.
  forEachQueryLevel(ir, (level) => rewriteCapturesOverLimit(level, ir));

  // A rex value is a string: sum() of it is 0 and average()/max() are null
  // (sandbox), where Splunk reads "12" as 12. Numeric aggregates over one get
  // numeric() (row-wise arithmetic and comparisons already do).
  forEachQueryLevel(ir, wrapStringAggregateArgs);

  // Remove _time from FACET when TIMESERIES is present (TIMESERIES already groups by time)
  ir.facet = stripTimeBucketFacets(
    ir.facet,
    ir.timeseries,
    ir._timeBucketAliases,
  );

  return ir;
}

// Call `visit` on a query and on every query nested in it: a subquery FROM, a
// JOIN subquery, and a scalar subquery in an expression. Each is its own NRQL
// query level.
function forEachQueryLevel(query, visit) {
  visit(query);
  if (query.dataSource?.type === 'SubquerySource') {
    forEachQueryLevel(query.dataSource.query, visit);
  }
  if (query.join) forEachQueryLevel(query.join.subquery, visit);
  const exprs = [
    ...query.select,
    ...query.where,
    ...query.facet,
    ...query.bindings.map((b) => b.expr),
  ];
  for (const sub of findScalarSubqueries(exprs)) forEachQueryLevel(sub, visit);
}

function findScalarSubqueries(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (node.type === 'SubqueryExpr') {
    found.push(node.query);
    return found;
  }
  for (const value of Object.values(node)) findScalarSubqueries(value, found);
  return found;
}

// Past 5 capture() bindings at one level, rewrite simple ones as aparse(),
// latest first; still over → unsupported. Messages go to the root query.
function rewriteCapturesOverLimit(level, ir) {
  const captures = level.bindings.filter(
    (b) => b.expr.type === 'Function' && b.expr.name === 'capture',
  );
  let captureCount = captures.length;
  const asAparse = [];
  for (let i = captures.length - 1; i >= 0 && captureCount > 5; i--) {
    const b = captures[i];
    const aparse = b.expr._rexPattern && formatRexAsAparse(b.expr._rexPattern);
    if (!aparse) continue;
    b.expr = Func('aparse', [b.expr.args[0], Literal(aparse, 'string')]);
    asAparse.unshift(b.name.replace(/^\(|\)$/g, ''));
    captureCount--;
  }
  if (captureCount > 5) {
    ir.unsupported.push(messages.rex_capture_limit(captureCount));
  } else if (asAparse.length > 0) {
    ir.warnings.push(messages.rex_as_aparse(asAparse));
  }
}

const NUMERIC_AGGREGATES = new Set([
  'sum',
  'average',
  'min',
  'max',
  'median',
  'stddev',
  'percentile',
]);
const STRING_SOURCES = new Set(['capture', 'aparse']);

// The value branches of an `if(cond, a, b)` (SPL `case()` arrives as nested ifs).
function getIfBranches(expr) {
  return expr.type === 'Function' && expr.name === 'if'
    ? expr.args.slice(1)
    : [];
}

// The names bound at this level to a rex value (capture()/aparse()), or to a
// binding that passes one through (`eval p=price`, `if(…, price, …)`).
function getStringBindingNames(level) {
  const names = new Set();
  const isString = (expr) => {
    if (expr.type === 'Identifier') return names.has(expr.name);
    if (expr.type === 'Function' && STRING_SOURCES.has(expr.name)) return true;
    return getIfBranches(expr).some(isString);
  };
  for (const b of level.bindings) {
    if (!isString(b.expr)) continue;
    for (const n of b.name.replace(/^\(|\)$/g, '').split(/\s*,\s*/)) {
      names.add(n);
    }
  }
  return names;
}

function wrapStringAggregateArgs(level) {
  const names = getStringBindingNames(level);
  if (names.size === 0) return;
  // numeric() around a rex value, also inside if() branches
  // (`sum(if(ok = 'y', price, 0))`).
  const toNumeric = (expr) => {
    if (expr.type === 'Identifier' && names.has(expr.name)) {
      return Func('numeric', [expr]);
    }
    if (getIfBranches(expr).length === 0) return expr;
    return Func('if', [expr.args[0], ...expr.args.slice(1).map(toNumeric)]);
  };
  const wrap = (node) => {
    if (!node || typeof node !== 'object' || node.type === 'SubqueryExpr') {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(wrap);
      return;
    }
    if (
      node.type === 'Function' &&
      NUMERIC_AGGREGATES.has(node.name) &&
      node.args.length > 0
    ) {
      node.args[0] = toNumeric(node.args[0]);
    }
    for (const value of Object.values(node)) wrap(value);
  };
  wrap(level.select);
}

// ── Search expression → IR expression tree ───────────────────

// `options.isCaseSensitive`: the `where` command compares values
// case-sensitively; a search (and `search`) doesn't.
export function translateSearchExpr(node, ir, options = {}) {
  const isCaseSensitive = options.isCaseSensitive === true;
  const warnings = [];
  const unsupported = [];
  let since = null;
  let until = null;
  // True once a `where _time ...` clause has been fully handled — as SINCE/UNTIL,
  // as a tautology drop, or as unsupported. Distinguishes "consumed, emit no WHERE
  // term" from "produced no IR", so the caller won't re-walk via the eval fallback.
  let consumedTime = false;
  // True once a dashboard time-range TOKEN ($…$) was seen in a time bound, and
  // once a LITERAL time bound (earliest=/latest= or where _time) was applied.
  // A search carrying BOTH is a mixed window the caller escalates to unsupported.
  let sawTimeToken = false;
  let sawTimeLiteral = false;

  // True once a literal-vs-literal comparison was constant-folded, so the caller
  // knows an absent expression means "always true", not "untranslated".
  let folded = false;

  function walk(node) {
    if (!node) return null;

    switch (node.type) {
      case 'BooleanOp': {
        const left = walk(node.left);
        const right = walk(node.right);
        // Constant folding: a folded side simplifies the boolean and is never
        // emitted. `true OR x` → true, `false OR x` → x, `true AND x` → x,
        // `false AND x` → false.
        const isOr = node.operator === 'OR';
        for (const [side, other] of [
          [left, right],
          [right, left],
        ]) {
          if (side && side.type === 'Const') {
            if (side.value === isOr) return side;
            return other;
          }
        }
        if (!left && !right) return null;
        if (!left) return right;
        if (!right) return left;
        return BinOp(node.operator, left, right);
      }

      case 'Not': {
        const inner = walk(node.operand);
        if (!inner) return null;
        if (inner.type === 'Const') return Const(!inner.value);
        // position() may be null when the text is absent, and NOT null is null
        // — which would drop exactly the events `NOT "phrase"` keeps.
        if (inner._phrasePosition) {
          const pos = inner._phrasePosition;
          return BinOp(
            'OR',
            IsNull(pos),
            BinOp('<', pos, Literal(0, 'number')),
          );
        }
        return Not(inner);
      }

      case 'ConstComparison': {
        folded = true;
        return foldConstComparison(node, warnings, unsupported);
      }

      case 'Comparison': {
        // New typed-node RHS (grammar `field op u_add`). Branch before the
        // legacy flat-`value` path, which assumes `value` is a string.
        if (node.rhsExpr) {
          const op = node.operator;
          const field = node.field;
          const rhs = node.rhsExpr;
          // Path 1: time-window. `_time` vs relative_time()/now() → SINCE/UNTIL.
          const isFunc =
            rhs && typeof rhs === 'object' && rhs.type === 'EvalFunc';
          const fnName = isFunc ? rhs.name.toLowerCase() : null;
          if (
            field === '_time' &&
            (fnName === 'relative_time' || fnName === 'now')
          ) {
            // This `_time` clause is consumed here (as SINCE/UNTIL, tautology
            // drop, or unsupported) — never as a WHERE term. Signal the caller.
            consumedTime = true;
            const isLower = op === '>' || op === '>=';
            const isUpper = op === '<' || op === '<=';

            // now() RHS
            if (fnName === 'now') {
              if (isUpper) {
                // `_time < now()` / `<= now()` is a tautology: NRDB stores no
                // future-dated events, so every event precedes now. It filters
                // nothing — drop it (warn so the dropped clause is visible).
                warnings.push(messages.where_time_tautology_dropped());
                return null;
              }
              if (isLower) {
                unsupported.push(
                  messages.where_time_future_bound_unsupported(),
                );
              } else {
                unsupported.push(messages.where_time_point_unsupported());
              }
              return null;
            }

            // relative_time(now(), "<offset>")
            const [anchor, offsetNode] = rhs.args;
            const anchorIsNow =
              anchor &&
              typeof anchor === 'object' &&
              anchor.type === 'EvalFunc' &&
              anchor.name.toLowerCase() === 'now';
            const offset =
              offsetNode &&
              typeof offsetNode === 'object' &&
              offsetNode.type === 'StringLiteral'
                ? offsetNode.value
                : null;
            if (!anchorIsNow || offset === null) {
              unsupported.push(
                messages.where_relative_time_nonliteral_unsupported(),
              );
              return null;
            }
            const { nrql, warning } = parseSplTime(offset);
            if (warning) warnings.push(warning);
            if (!nrql) {
              unsupported.push(
                messages.where_relative_time_nonliteral_unsupported(),
              );
              return null;
            }
            if (isLower && since) {
              warnings.push(messages.where_time_constraints_collapsed());
            }
            if (isLower) {
              sawTimeLiteral = true;
              since = nrql;
            } else if (isUpper) {
              // A past upper bound (UNTIL <past>) with no lower bound inverts
              // NRQL's default window (default SINCE is 1 hour ago), so the
              // query won't compile and any invented SINCE would be wrong.
              // (`_time < now()` is a tautology, handled above as drop+warn.)
              unsupported.push(
                messages.where_time_past_upper_bound_unsupported(),
              );
            } else {
              unsupported.push(messages.where_time_point_unsupported());
            }
            return null;
          }
          // Path 2a: non-_time field vs now()/relative_time → unsupported.
          // (Path 1 already returned for _time; here field !== '_time'.)
          if (fnName === 'now' || fnName === 'relative_time') {
            unsupported.push(messages.where_nontime_relative_unsupported());
            return null;
          }
          // Reversed operands: `.25 > count` — left is a numeric literal, not
          // a field. The eval walker's looksLikeNumber misses leading-decimal
          // literals like `.25`, so handle this sub-case before delegating.
          const leftLooksNumeric = /^-?(\d+\.\d+|\.\d+|\d+)$/.test(field);
          if (leftLooksNumeric) {
            const numLit = RawNrql(field);
            const right = walkEvalExpr(node.rhsExpr, ir);
            if (!right) return null;
            const numRight =
              op === '=' || op === '!='
                ? right
                : right.type === 'Identifier'
                  ? Func('numeric', [right])
                  : right;
            return BinOp(op, numLit, numRight);
          }
          // Path 2b: general expression RHS → BinOp via the eval walker.
          // walkEvalExpr handles numeric coercion + loud failure; reuse its
          // EvalComparison semantics by building an EvalComparison and walking it.
          const cmpNode = {
            type: 'EvalComparison',
            op,
            left: field === '_time' ? '_time' : field,
            right: node.rhsExpr,
          };
          // Gate: reject RHS expressions containing functions NRQL can't
          // evaluate row-wise (would emit non-compiling NRQL). Check the SPL
          // AST before walking so only one unsupported message fires.
          const badFn = findUnimplementedRhsFuncInAst(node.rhsExpr);
          if (badFn) {
            unsupported.push(messages.where_rhs_func_not_row_wise(badFn));
            return null;
          }
          const expr = walkEvalExpr(cmpNode, ir);
          if (!expr) return null; // walker already pushed unsupported
          return expr;
        }

        let { field, value, operator: op } = node;

        // Dashboard template variable in value position (field=$tok$): emit
        // `field = {{tok}}` unquoted. The token is a placeholder filled at
        // dashboard render time, so it must be neither string-quoted nor
        // numeric()-coerced. `value` is a typed node only for a complete $name$
        // (the grammar's !search_value_char lookahead); embedded tokens stay literal.
        if (
          value &&
          typeof value === 'object' &&
          value.type === 'TemplateVariable'
        ) {
          if (isEnvToken(value.name)) {
            unsupported.push(messages.splunk_env_token(value.name));
            return null;
          }
          if (hasUntranslatableTokenChar(value.name)) {
            unsupported.push(messages.token_name_unsupported(value.name));
            return null;
          }
          return buildTokenComparison(op, field, value.name, isCaseSensitive);
        }

        // A fully-quoted standalone token, e.g. `index="$env$"` — the grammar
        // strips the quotes leaving the literal string `$env$`. Treat it exactly
        // like an unquoted token (NR substitutes {{env}} at render time); a quoted
        // literal '$env$' would match nothing. Only a body that is EXACTLY $name$
        // qualifies — an embedded/affixed token (`"*x-$id$*"`, `"$id$-suffix"`)
        // stays literal and is handled by the wildcard/buildComparison paths below.
        if (typeof value === 'string') {
          const tokenOnly = /^\$([A-Za-z0-9_.:-]+)\$$/.exec(value);
          if (tokenOnly) {
            if (isEnvToken(tokenOnly[1])) {
              unsupported.push(messages.splunk_env_token(tokenOnly[1]));
              return null;
            }
            if (hasUntranslatableTokenChar(tokenOnly[1])) {
              unsupported.push(messages.token_name_unsupported(tokenOnly[1]));
              return null;
            }
            return buildTokenComparison(
              op,
              field,
              tokenOnly[1],
              isCaseSensitive,
            );
          }
        }

        // A token EMBEDDED in a quoted value (the standalone $tok$ case returned above).
        // New Relic substitutes {{tok}} only in value position — never inside a string
        // literal/pattern (verified against staging acct 1, 2026-06-22). So:
        //   - wildcard-ONLY wrap (`*$tok$*`, `$tok$*`, `*$tok$`) → `field LIKE {{tok}}`; the
        //     % wildcards must live in the variable's values (see wildcard_token_like).
        //   - any literal affix (`*fps-$tok$*`, `$tok$-suffix`) → unsupported: emitting the
        //     literal $tok$ would silently never substitute (loud failure over silent-wrong).
        if (typeof value === 'string' && /\$[A-Za-z0-9_.:-]+\$/.test(value)) {
          const wildcardToken = /^\*?\$([A-Za-z0-9_.:-]+)\$\*?$/.exec(value);
          if (wildcardToken && value.includes('*')) {
            if (isEnvToken(wildcardToken[1])) {
              unsupported.push(messages.splunk_env_token(wildcardToken[1]));
              return null;
            }
            if (hasUntranslatableTokenChar(wildcardToken[1])) {
              unsupported.push(
                messages.token_name_unsupported(wildcardToken[1]),
              );
              return null;
            }
            warnings.push(
              messages.wildcard_token_like(field, wildcardToken[1]),
            );
            const like = Like(Identifier(field), `{{${wildcardToken[1]}}}`);
            return op === '!=' ? Not(like) : like;
          }
          unsupported.push(messages.affixed_token_unsupported(field, value));
          return null;
        }

        // Reversed operands: `.25 > count` parses `.25` into the field slot and
        // `count` into the value slot. When the left is a numeric literal and the
        // right is a field name, emit `<number> op numeric(<field>)` rather than
        // backticking the number as an attribute. Equality keeps a plain compare.
        const leftLooksNumeric = /^-?(\d+\.\d+|\.\d+|\d+)$/.test(field);
        const rightLooksField = /^[a-zA-Z_][\w.]*$/.test(value);
        if (leftLooksNumeric && rightLooksField && !field.includes('{')) {
          const numLit = RawNrql(field);
          const fieldId = Identifier(value === '_time' ? 'timestamp' : value);
          if (op === '=' || op === '!=') {
            return BinOp(op, numLit, fieldId);
          }
          return BinOp(op, numLit, Func('numeric', [fieldId]));
        }

        // SPL `_raw=*text*` searches the whole event. `message` is only one
        // attribute (and is gone entirely when the Log API flattened a JSON-only
        // message into attributes), so a wildcard search on _raw matches across
        // every attribute value with dimensions().
        if (
          field === '_raw' &&
          typeof value === 'string' &&
          value.includes('*') &&
          !value.includes(',') && // dimensions() escapes `,` as `\,`
          (op === '=' || op === '!=')
        ) {
          warnings.push(messages.raw_search_dimensions());
          const like = Like(Func('dimensions', []), escapeWildcard(value));
          return op === '!=' ? Not(like) : like;
        }

        // SPL metadata field _raw → NRQL message
        if (field === '_raw') {
          field = 'message';
          warnings.push(messages.raw_mapped_to_message());
        }

        // JSON array field: field{}.sub or field{N}.sub → jparse translation
        if (/\{\d*\}/.test(field)) {
          const isIndexed = /\{\d+\}/.test(field);
          const jpath = field.replace(/\{(\d*)\}/g, (_, n) =>
            n ? `[${n}]` : '[*]',
          );
          const jparsed = Func('jparse', [
            Identifier('message'),
            Literal(jpath, 'string'),
          ]);

          // Wildcard values: use LIKE on jparse result
          if (value.includes('*')) {
            const pattern = escapeWildcard(value);
            if (op === '=') return Like(jparsed, pattern);
            if (op === '!=') return Not(Like(jparsed, pattern));
          }

          // Indexed access {N}: scalar result, use direct comparison
          if (isIndexed) {
            return buildJparseComparison(jparsed, op, value);
          }

          // Wildcard array {}: use contains for = and !=
          if (op === '=')
            return Func('contains', [jparsed, Literal(value, 'string')]);
          if (op === '!=')
            return Not(Func('contains', [jparsed, Literal(value, 'string')]));
          // For ordering operators on arrays, fall through to backtick-quoted literal
        }

        const fieldExpr = Identifier(field);

        // Infix like operator: name like "test%"
        if (op === 'like') {
          const pattern = value.replace(/\*/g, '%');
          return Like(fieldExpr, pattern);
        }

        if (value.includes('*')) {
          const pattern = escapeWildcard(value);
          if (op === '=') return Like(fieldExpr, pattern);
          if (op === '!=') return Not(Like(fieldExpr, pattern));
        }

        return buildComparison(field, op, value);
      }

      // Function call on the left of a comparison: mvcount(f) > 1.
      case 'FuncComparison': {
        const reported = ir.unsupported.length;
        const left = walkEvalExpr(node.left, ir);
        if (!left) {
          // Only when the walker didn't already say why.
          if (ir.unsupported.length === reported) {
            unsupported.push(messages.search_func_unsupported(node.left.name));
          }
          return null;
        }
        const { value, operator: op } = node;
        if (isNumeric(value)) {
          if (op === '=' || op === '!=') {
            return BinOp(op, left, Literal(Number(value), 'number'));
          }
          return BinOp(
            op,
            Func('numeric', [left]),
            Literal(Number(value), 'number'),
          );
        }
        return BinOp(op, left, Literal(value, 'string'));
      }

      case 'InComparison': {
        // JSON array field: field{}.sub IN (a, b) → contains(jparse(...), a) OR contains(jparse(...), b)
        if (node.field.includes('{}')) {
          const jpath = node.field.replace(/\{\}/g, '[*]');
          const jparsed = Func('jparse', [
            Identifier('message'),
            Literal(jpath, 'string'),
          ]);
          const parts = node.values.map((v) =>
            Func('contains', [jparsed, Literal(v, 'string')]),
          );
          return parts.reduce(
            (acc, p) => (acc ? BinOp('OR', acc, p) : p),
            null,
          );
        }

        const fieldExpr = Identifier(node.field);
        const hasWildcards = node.values.some((v) => v.includes('*'));

        if (hasWildcards) {
          const parts = node.values.map((v) => {
            if (v.includes('*')) return Like(fieldExpr, escapeWildcard(v));
            return BinOp('=', fieldExpr, coerceValue(v));
          });
          return parts.reduce(
            (acc, p) => (acc ? BinOp('OR', acc, p) : p),
            null,
          );
        }

        return In(fieldExpr, node.values.map(coerceValue));
      }

      case 'BareKeyword': {
        const { value } = node;
        if (node.fragment) {
          // `"key":"value"` — Splunk splits this on its breakers and matches the
          // resulting terms, which a LIKE on the literal text does not reproduce.
          unsupported.push(messages.search_json_fragment(value));
          return null;
        }
        if (!value || value === '*') return null;
        if (TOKEN_IN_TEXT.test(value)) {
          return buildPhraseTokenMatch(value, unsupported);
        }
        const escaped = escapeWildcard(value);
        return Like(rawEventIdentifier(), `%${escaped}%`);
      }

      case 'TimeConstraint': {
        // AI-DEV: a dashboard time token (earliest=$tok$ / latest=$tok$) **MUST**
        // be dropped with a warning, never emitted into SINCE/UNTIL — NRQL rejects
        // a {{var}} in a time clause and a wrong window is silent-wrong. Do not
        // "improve" this to pass the token through. (Dashboard-Time-Tokens rule.)
        if (/\$[^$]+\$/.test(node.value)) {
          sawTimeToken = true;
          warnings.push(
            messages.time_token_bound_dropped(node.param, node.value),
          );
          return null; // drop: leave since/until unset
        }
        const { nrql, warning } = parseSplTime(node.value);
        if (warning) warnings.push(warning);
        if (nrql) {
          sawTimeLiteral = true;
          if (node.param === 'earliest') since = nrql;
          else until = nrql;
        }
        return null;
      }

      case 'Macro': {
        const argsStr = node.args.length > 0 ? `(${node.args.join(', ')})` : '';
        const nrqlMacro = `$${node.name}${argsStr}`;
        warnings.push(messages.macro_translated(node.name, nrqlMacro));
        // Emit macro reference as a raw identifier (NRQL gateway expands it)
        return Identifier(nrqlMacro);
      }

      case 'TemplateVariable': {
        const isEarliest =
          node.name === 'earliest' || node.name.endsWith('.earliest');
        const isLatest =
          node.name === 'latest' || node.name.endsWith('.latest');
        if (isEarliest || isLatest) {
          // AI-DEV: a time-range template variable **MUST** be dropped with a
          // warning, never emitted as {{var}} into SINCE/UNTIL (NRQL rejects it
          // and a wrong window is silent-wrong). Only NON-time variables pass
          // through as {{name}} below. (Dashboard-Time-Tokens rule.)
          const param = isEarliest ? 'earliest' : 'latest';
          sawTimeToken = true;
          warnings.push(
            messages.time_token_bound_dropped(param, `$${node.name}$`),
          );
          return null; // drop: do NOT set since/until to {{…}}
        }
        if (isEnvToken(node.name)) {
          unsupported.push(messages.splunk_env_token(node.name));
          return null;
        }
        if (hasUntranslatableTokenChar(node.name)) {
          unsupported.push(messages.token_name_unsupported(node.name));
          return null;
        }
        return Identifier(`{{${node.name}}}`); // non-time variable: unchanged
      }

      case 'NotSubsearch': {
        const lookupMatch = node.rawText.match(/\|\s*inputlookup\s+([\w.-]+)/);
        if (lookupMatch) {
          const tableName = lookupMatch[1]
            .replace(/\.csv$/, '')
            .replace(/[.-]/g, '_');
          warnings.push(
            messages.not_inputlookup_translated(lookupMatch[1], tableName),
          );
          return RawNrql(
            `{{column}} NOT IN (FROM lookup(${tableName}) SELECT {{column}} LIMIT MAX)`,
          );
        }
        unsupported.push(messages.not_subsearch_unsupported());
        return null;
      }

      case 'TopLevelSubsearch': {
        // [subsearch] at the top level — Splunk runs the inner search and
        // uses results as search terms. We parse the subsearch and fold its
        // WHERE clause into the outer query.
        try {
          const subAst = parser.parse(normalizeSubsearch(node.rawText));
          const subIR = translateAstToIR(subAst);
          for (const w of subIR.warnings)
            warnings.push(messages.subsearch_warning(w));
          for (const u of subIR.unsupported)
            unsupported.push(messages.subsearch_unsupported(u));
          // Fold subsearch WHERE conditions into a single tree for the outer walk()
          if (subIR.where.length === 0) return null;
          return subIR.where.reduce((acc, w) => BinOp('AND', acc, w));
        } catch (e) {
          unsupported.push(messages.subsearch_parse_failed(e.message));
          return null;
        }
      }

      // FunctionCall nodes from the where expression grammar (like(), match(),
      // isnotnull(), cidrmatch(), etc.) — delegate to walkEvalExpr
      case 'FunctionCall': {
        const reported = ir.unsupported.length;
        const ret = walkEvalExpr(node, ir);
        if (ret === null) {
          // Only when the walker didn't already say why.
          if (ir.unsupported.length === reported) {
            unsupported.push(messages.search_func_unsupported(node.name));
          }
          return null;
        }
        return ret;
      }

      default:
        warnings.push(messages.search_unknown_node(node.type));
        return null;
    }
  }

  let expr = walk(node);
  // A folded constant never reaches NRQL: always-true drops the condition;
  // always-false would return no rows at all, which is almost certainly not the
  // intent of a translated panel — fail loud rather than emit an empty query.
  if (expr && expr.type === 'Const') {
    if (!expr.value) unsupported.push(messages.where_always_false());
    expr = null;
  }
  return {
    expr,
    warnings,
    unsupported,
    since,
    until,
    consumedTime,
    folded,
    sawTimeToken,
    sawTimeLiteral,
  };
}

// A compile-time boolean from constant folding. Internal to translateSearchExpr:
// it is always simplified away before an expression leaves this module.
function Const(value) {
  return { type: 'Const', value };
}

const TOKEN_ONLY_RE = /^\$([A-Za-z0-9_.:-]+)\$$/;

/**
 * Fold a literal-vs-literal `where` comparison (`"a"="a"`, `1=1`) to a Const.
 *
 * A side that is exactly a dashboard token (`"$tok$"`) compared with the literal
 * `"*"` is the Splunk "all values" guard: `where "$tok$"="*" OR f="$tok$"`. NR
 * substitutes {{tok}} directly into the field comparison, so the guard folds to
 * false (`!=` → true) and the field comparison carries the filter; a warning says
 * how to get "all" in NR. Any other comparison involving a token depends on the
 * run-time value and cannot be folded — unsupported, named.
 */
function foldConstComparison(node, warnings, unsupported) {
  const { left, right } = node;
  const negate = node.operator === '!=';
  const hasToken = (side) =>
    side.kind === 'string' && /\$[A-Za-z0-9_.:-]+\$/.test(side.value);

  if (hasToken(left) || hasToken(right)) {
    const [tokSide, litSide] = hasToken(left) ? [left, right] : [right, left];
    const tok = TOKEN_ONLY_RE.exec(tokSide.value);
    if (tok && !hasToken(litSide) && litSide.value === '*') {
      warnings.push(messages.where_token_all_guard_dropped(tok[1]));
      return Const(negate);
    }
    unsupported.push(
      messages.where_token_const_comparison(
        `"${left.value}"${node.operator}"${right.value}"`,
      ),
    );
    return null;
  }

  let equal;
  if (left.kind === 'number' && right.kind === 'number') {
    equal = Number(left.value) === Number(right.value);
  } else if (left.kind === 'string' && right.kind === 'string') {
    equal = left.value === right.value;
  } else {
    // String vs number: Splunk's coercion rules here are not something we can
    // reproduce with confidence. Loud over a guess.
    const show = (s) => (s.kind === 'string' ? `"${s.value}"` : s.value);
    unsupported.push(
      messages.where_mixed_const_comparison(
        `${show(left)}${node.operator}${show(right)}`,
      ),
    );
    return null;
  }
  return Const(negate ? !equal : equal);
}

// ── Command dispatch ─────────────────────────────────────────

const handlers = {
  // Aggregation
  StatsCommand: handleStats,
  TimechartCommand: handleTimechart,
  ChartCommand: handleChart, // stats + chart options (limit=, …)
  TopCommand: handleTop,
  RareCommand: handleRare,
  TableCommand: handleTable,
  EventstatsCommand: handleEventstats,

  // Enrichment
  JoinCommand: handleJoin,
  AppendpipeCommand: handleAppendpipe,
  InputlookupCommand: handleInputlookup,
  LookupCommand: handleLookup,

  // Extraction
  RexCommand: handleRex,
  SpathCommand: handleSpath,
  RegexCommand: handleRegex,
  SearchCommand: handleSearchPipe,

  // Eval
  EvalCommand: handleEval,
  WhereCommand: handleWhere,

  // Row transforms
  FieldsCommand: handleFields,
  SortCommand: handleSort,
  HeadCommand: handleHead,
  TailCommand: handleTail,
  RenameCommand: handleRename,
  DedupCommand: handleDedup,
  BinCommand: handleBin,
  ReverseCommand: handleReverse,
  FillnullCommand: handleFillnull,
  StrcatCommand: handleStrcat,
  ConvertCommand: handleConvert,
  ReplaceCommand: handleReplace,
  MvexpandCommand: handleMvexpand,
  UniqCommand: handleUniq,
};

// Commands with a dedicated grammar rule (mirrors `known_command` in spl.grammar).
// If one of these reaches the unknown_command catch-all, its arguments failed to
// parse — it is not an unknown command.
const KNOWN_COMMANDS = new Set([
  'stats',
  'timechart',
  'chart',
  'where',
  'search',
  'table',
  'fields',
  'sort',
  'head',
  'tail',
  'top',
  'rename',
  'dedup',
  'eval',
  'rex',
  'bin',
  'bucket',
  'lookup',
  'inputlookup',
  'spath',
  'join',
  'regex',
  'fillnull',
  'rare',
  'reverse',
  'strcat',
  'uniq',
  'convert',
  'appendcols',
  'appendpipe',
  'append',
  'eventstats',
  'mvexpand',
  'replace',
  'predict',
  'tstats',
]);

// Re-parse one stage with the strict (no catch-all) start rule to recover the
// parser's own "Expected … but … found" for the argument that failed. Returns a
// short `near '<text>': <expectation>` detail, or null if the strict parse
// unexpectedly succeeds (the failure depended on surrounding context).
function describeCommandParseFailure(name, rawText) {
  const text = rawText ? `${name} ${rawText}` : name;
  try {
    parser.parse(text, { startRule: 'strict_command' });
    return null;
  } catch (e) {
    const offset = e.location?.start?.offset ?? 0;
    const near = text.slice(offset, offset + 30) || '(end of command)';
    const expectation = String(e.message || '').replace(/\.$/, '');
    return `near '${near}' (column ${offset + 1} of '${text.slice(0, 60)}'): ${expectation}`;
  }
}

function applyCommand(cmd, ir) {
  const handler = handlers[cmd.type];
  if (handler) {
    handler(cmd, ir);
    return;
  }

  // Commands with inline logic that doesn't fit the handler pattern
  switch (cmd.type) {
    case 'AppendCommand':
    case 'AppendcolsCommand':
      handleAppend(
        cmd,
        ir,
        cmd.type === 'AppendcolsCommand' ? 'appendcols' : 'append',
      );
      return;
    case 'PredictCommand':
      ir.predict = true;
      if (!ir.timeseries) {
        ir.timeseries = 'AUTO';
        ir.warnings.push(messages.predict_needs_timeseries());
      }
      if (ir.select.length === 0) {
        ir.select.push(Func('count', []));
      }
      return;
    case 'TstatsCommand':
      ir.unsupported.push(messages.tstats_unsupported());
      return;
    case 'MacroCommand': {
      const argsStr = cmd.args.length > 0 ? `(${cmd.args.join(', ')})` : '';
      const nrqlMacro = `$${cmd.name}${argsStr}`;
      ir.warnings.push(messages.macro_translated(cmd.name, nrqlMacro));
      const macroExpr = Identifier(nrqlMacro);
      ir.where.push(macroExpr);
      return;
    }
    case 'UnsupportedCommand': {
      // TODO: give timewrap a more helpful unsupported message suggesting
      //   NRQL's COMPARE WITH clause as the closest equivalent.
      //   Source: splunk-to-nr migration guide (docs/references/splunk-to-nr-migration-guide.md)
      //   Feasibility: easy — just a special-case message, no translation needed.
      const name = cmd.name;
      // Gap #22, #10: special-case commands that deserve more helpful messages
      if (name === 'streamstats') {
        ir.unsupported.push(messages.streamstats_unsupported());
      } else if (name === 'kvparse' || name === 'extract' || name === 'kv') {
        ir.unsupported.push(messages.kvparse_unsupported());
      } else if (name === 'transaction') {
        // No faithful NRQL equivalent: NRQL has no sessionization primitive, and
        // even bare transaction != FACET (maxevents=1000 + connected=true). Name
        // the first blocking window/boundary arg when one is present.
        const windowMatch = /\b(maxspan|maxpause|startswith|endswith)\b/i.exec(
          cmd.rawText || '',
        );
        const windowArg = windowMatch ? windowMatch[1].toLowerCase() : null;
        ir.unsupported.push(messages.transaction_unsupported(windowArg));
      } else if (KNOWN_COMMANDS.has(name)) {
        // A command we DO translate, whose own grammar rule rejected these
        // arguments (the catch-all then swallowed it). The command is not the
        // problem — an option, identifier form, or sub-expression is. Report
        // the parser's position/expectation for that construct instead.
        ir.unsupported.push(
          messages.command_args_unparsed(
            name,
            describeCommandParseFailure(name, cmd.rawText),
          ),
        );
      } else {
        ir.unsupported.push(messages.unsupported_command(name));
      }
      return;
    }
    default:
      ir.unsupported.push(messages.command_not_implemented(cmd.type));
      return;
  }
}
