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
} from './splExprUtils.js';
import * as parser from './splParser.js';
import { messages } from '../../messages.js';
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
export function translateAstToIR(ast) {
  const ir = SelectQuery();

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
  let sawDedup = false;
  let mvexpandCount = 0;
  for (const cmd of ast.commands) {
    if (cmd.type === 'DedupCommand') sawDedup = true;
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
    applyCommand(cmd, ir);
  }

  // Gap #3: cascading mvexpand detection
  if (mvexpandCount > 1) {
    ir.unsupported.push(messages.mvexpand_cascading());
  }

  // Gap #12: Splunk computes all groups by default; NRQL FACET defaults to 10.
  // Don't inject LIMIT MAX — it can cause performance issues in UI contexts.
  // Warn so the user can decide.
  if (ir.facet.length > 0 && ir.limit == null) {
    ir.warnings.push(messages.facet_default_limit());
  }

  // Gap #7: NRQL limits capture() to 5 calls per query.
  const captureCount = ir.bindings.filter(
    (b) => b.expr.type === 'Function' && b.expr.name === 'capture',
  ).length;
  if (captureCount > 5) {
    ir.warnings.push(messages.rex_capture_limit(captureCount));
  }

  // Remove _time from FACET when TIMESERIES is present (TIMESERIES already groups by time)
  if (ir.timeseries && ir.facet.length > 0) {
    const timeAliases = ir._timeBucketAliases || new Set();
    ir.facet = ir.facet.filter(
      (f) =>
        !(
          f.type === 'Identifier' &&
          (f.name === '_time' ||
            f.name === 'timestamp' ||
            timeAliases.has(f.name))
        ),
    );
  }

  return ir;
}

// ── Search expression → IR expression tree ───────────────────

export function translateSearchExpr(node, ir) {
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

  function walk(node) {
    if (!node) return null;

    switch (node.type) {
      case 'BooleanOp': {
        const left = walk(node.left);
        const right = walk(node.right);
        if (!left && !right) return null;
        if (!left) return right;
        if (!right) return left;
        return BinOp(node.operator, left, right);
      }

      case 'Not': {
        const inner = walk(node.operand);
        if (!inner) return null;
        return Not(inner);
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
        const left = walkEvalExpr(node.left, ir);
        if (!left) {
          unsupported.push(messages.search_func_unsupported(node.left.name));
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
        if (!value || value === '*') return null;
        const escaped = escapeWildcard(value);
        return Like(Identifier('message'), `%${escaped}%`);
      }

      case 'TimeConstraint': {
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
          const param = isEarliest ? 'earliest' : 'latest';
          sawTimeToken = true;
          warnings.push(
            messages.time_token_bound_dropped(param, `$${node.name}$`),
          );
          return null; // drop: do NOT set since/until to {{…}}
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
        const ret = walkEvalExpr(node, ir);
        if (ret === null) {
          unsupported.push(messages.search_func_unsupported(node.name));
          return null;
        }
        return ret;
      }

      default:
        warnings.push(messages.search_unknown_node(node.type));
        return null;
    }
  }

  const expr = walk(node);
  return {
    expr,
    warnings,
    unsupported,
    since,
    until,
    consumedTime,
    sawTimeToken,
    sawTimeLiteral,
  };
}

// ── Command dispatch ─────────────────────────────────────────

const handlers = {
  // Aggregation
  StatsCommand: handleStats,
  TimechartCommand: handleTimechart,
  ChartCommand: handleStats, // chart is structurally same as stats
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
