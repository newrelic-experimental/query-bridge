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
  stripTimeBucketFacets,
} from './splExprUtils.js';
import * as parser from './splParser.js';
import { messages } from '../../messages.js';
import { collectAutoExtractFields } from './spathAutoExtract.js';
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

// A token NAME containing ':' or '-' cannot tokenize inside an NRQL {{…}} variable
// (a hard NRDB parse error — verified acct 1). Emitted as {{name}} it would not run.
function hasUntranslatableTokenChar(name) {
  return name.includes(':') || name.includes('-');
}

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
  for (let i = 0; i < ast.commands.length; i++) {
    const cmd = ast.commands[i];
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
    // spath auto-extract (no path=): enumerate the fields referenced downstream so
    // handleSpath can bind each as jparse(<source>, '<field>'). null when not safely
    // enumerable → handleSpath emits the loud spath_no_path.
    if (cmd.type === 'SpathCommand' && !cmd.path) {
      cmd._autoExtractFields = collectAutoExtractFields(
        ast.commands.slice(i + 1),
      );
    }
    applyCommand(cmd, ir);
  }

  // Wildcard rename (`rename <prefix>.* as *`): register the prefix rewrite for
  // eligible downstream references, or emit a loud guard / drop-warning. Runs
  // before optimize()'s applyFieldReplacements substitutes the registered map.
  applyWildcardRenames(ir);

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
  ir.facet = stripTimeBucketFacets(
    ir.facet,
    ir.timeseries,
    ir._timeBucketAliases,
  );

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
        // Dashboard token in comparison LHS/field position ($tok$ = …). The
        // grammar emits `lhsToken` (a TemplateVariable node). New Relic
        // substitutes {{var}} in VALUE position only, so a token can never stay
        // in field position. An equality comparison with a non-token operand is
        // flipped (B′ — `$tok$="*"` → `'*' = {{tok}}`); a non-equality operator
        // or a token-vs-token comparison can't flip → loud unsupported (A).
        if (node.lhsToken) {
          const tok = node.lhsToken.name;
          const op = node.operator;
          const value = node.value;
          // RHS is itself a token? (a TemplateVariable node in base position, or
          // a `$other$` string in where position) → can't flip → Option A.
          const rhsIsToken =
            (value &&
              typeof value === 'object' &&
              value.type === 'TemplateVariable') ||
            (typeof value === 'string' && /^\$[A-Za-z0-9_.:-]+\$$/.test(value));
          // Only equality is commutative; an ordering op would need operator
          // inversion (out of scope) → Option A.
          const flippable = op === '=' || op === '!=';
          if (!flippable || rhsIsToken) {
            unsupported.push(messages.token_lhs_unsupported(tok));
            return null;
          }
          // B′ operand flip: <literal> op {{tok}}. Base-search comparison RHS
          // values are literals, so the flipped LHS is a string literal. The
          // means-all sentinel ('*') is realized by the NR variable, not a
          // literal asterisk match → warn.
          if (value === '*') {
            warnings.push(messages.means_all_token(tok));
          }
          return BinOp(op, Literal(value, 'string'), Identifier(`{{${tok}}}`));
        }

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
          return BinOp(op, Identifier(field), Identifier(`{{${value.name}}}`));
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
            return BinOp(
              op,
              Identifier(field),
              Identifier(`{{${tokenOnly[1]}}}`),
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
      } else if (name === 'transaction') {
        // No faithful NRQL equivalent: NRQL has no sessionization primitive, and
        // even bare transaction != FACET (maxevents=1000 + connected=true). Name
        // the first blocking window/boundary arg when one is present.
        const windowMatch = /\b(maxspan|maxpause|startswith|endswith)\b/i.exec(
          cmd.rawText || '',
        );
        const windowArg = windowMatch ? windowMatch[1].toLowerCase() : null;
        ir.unsupported.push(messages.transaction_unsupported(windowArg));
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
