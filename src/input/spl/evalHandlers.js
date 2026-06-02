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
  DualCheck,
} from '../../ir/nodes.js';
import {
  isNumeric,
  looksLikeNumber,
  buildArithmeticExpr,
  exprReferencesField,
  wrapAsSubquery,
} from './splExprUtils.js';
// Circular import — safe because translateSearchExpr is only called at runtime, not at module load time
import { translateSearchExpr } from './splToIR.js';
import { messages } from '../../messages.js';

// ── Command handlers ────────────────────────────────────────

export function handleWhere(cmd, ir) {
  // If after aggregation, wrap as subquery and filter the outer query
  if (ir._hasAggregation) {
    wrapAsSubquery(ir);
  }

  // The PEG grammar uses `expression` not `expr`
  const whereNode = cmd.expression || cmd.expr;
  const expr = translateWhereExpr(whereNode, ir);
  if (expr) {
    ir.where.push(expr);
  }
}

export function handleEval(cmd, ir) {
  // eval creates bindings: WITH expr AS name
  translateEvalExpr(cmd, ir);
}

// ── Expression translators ──────────────────────────────────

export function translateWhereExpr(expr, ir) {
  if (!expr) return null;
  // The where pipe uses the same AST format as search expressions
  // (BooleanOp, Comparison, etc.), not eval expressions (EvalFunc, etc.)
  // However, where_primary can also contain eval-like function calls
  // and comparisons. We need to handle both formats.
  const { expr: irExpr, warnings, unsupported } = translateSearchExpr(expr, ir);
  ir.warnings.push(...warnings);
  ir.unsupported.push(...unsupported);
  if (irExpr) return irExpr;
  // Fallback: try eval expression walker for eval-style where expressions
  return walkEvalExpr(expr, ir);
}

function translateEvalExpr(cmd, ir) {
  if (cmd.rawText) {
    // Try dot-concat: field = expr . expr . ...
    if (tryParseDotConcat(cmd.rawText, ir)) return null;
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
        // NRQL WITH clause can't alias to a field that the expression references
        // (circular dependency). In that case, inline into SELECT instead.
        if (exprReferencesField(expr, assignment.field)) {
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

/**
 * Try to parse a rawText eval as dot-concat: field = expr . expr . ...
 * SPL uses `.` (with spaces) as string concatenation operator.
 * Returns null if the rawText doesn't match this pattern.
 */
function tryParseDotConcat(rawText, ir) {
  // Match: field = stuff . stuff [. stuff ...]
  const eqIdx = rawText.indexOf('=');
  if (eqIdx < 0) return null;
  const field = rawText.slice(0, eqIdx).trim();
  const rhs = rawText.slice(eqIdx + 1).trim();
  // Split on ` . ` (space-dot-space) to distinguish from field.name dots
  const parts = rhs.split(/\s+\.\s+/);
  if (parts.length < 2) return null;
  const concatArgs = parts.map((p) => {
    const trimmed = p.trim();
    // Quoted string
    const strMatch = trimmed.match(/^"(.*)"$|^'(.*)'$/);
    if (strMatch) return Literal(strMatch[1] || strMatch[2] || '', 'string');
    // Number
    if (looksLikeNumber(trimmed)) return Literal(Number(trimmed), 'number');
    // Field name
    return Identifier(trimmed === '_time' ? 'timestamp' : trimmed);
  });
  ir.bindings.push(Binding(field, Func('concat', concatArgs)));
  return true; // signal success; bindings added directly
}

// ── Eval expression walker ──────────────────────────────────

/**
 * Walk an eval expression AST node and produce an IR expression.
 * Handles: EvalFunc, EvalComparison, EvalBoolOp, EvalParens, StringLiteral, bare strings.
 */
export function walkEvalExpr(node, ir) {
  if (!node) return null;

  // Bare string — could be field name, number, comparison, or arithmetic expression
  if (typeof node === 'string') {
    if (looksLikeNumber(node)) return Literal(Number(node), 'number');
    if (node === '_time') return Identifier('timestamp');
    // Comparison operators in raw strings (from eval_inner_expr): status>=400, EventCode=4648
    const cmpMatch = node.match(
      /^([a-zA-Z_][\w.]*)\s*(>=|<=|!=|>|<|==|=)\s*(.+)$/,
    );
    if (cmpMatch) {
      const [, field, rawOp, rawValue] = cmpMatch;
      const op = rawOp === '==' ? '=' : rawOp;
      const fieldId = Identifier(field === '_time' ? 'timestamp' : field);
      // Strip surrounding quotes from value if present
      const value =
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))
          ? rawValue.slice(1, -1)
          : rawValue;
      if (isNumeric(value)) {
        if (op === '=' || op === '!=') {
          const strCmp = BinOp(op, fieldId, Literal(value, 'string'));
          const numCmp = BinOp(
            op,
            Func('numeric', [fieldId]),
            Literal(Number(value), 'number'),
          );
          return BinOp(op === '=' ? 'OR' : 'AND', strCmp, numCmp);
        }
        return BinOp(
          op,
          Func('numeric', [fieldId]),
          Literal(Number(value), 'number'),
        );
      }
      return BinOp(op, fieldId, Literal(value, 'string'));
    }
    // If the string contains arithmetic operators, parse it into a BinOp tree
    if (/[+\-*/%]/.test(node) && /[a-zA-Z]/.test(node)) {
      return buildArithmeticExpr(node);
    }
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

    case 'EvalParens':
      return walkEvalExpr(node.inner, ir);

    case 'FunctionCall':
      // Where-pipe grammar produces FunctionCall, not EvalFunc — normalize and delegate
      return walkEvalFunc({ name: node.name, args: node.args }, ir);

    default:
      // Unknown node type — treat as bare string
      return Identifier(String(node));
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
        if (
          start.type === 'Literal' &&
          start.kind === 'number' &&
          start.value > 0
        ) {
          translated[1] = Literal(start.value - 1, 'number');
        } else if (start.type !== 'Literal') {
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
        // Convert SPL wildcards to NRQL: * → %
        const nrqlPattern = patStr.replace(/\*/g, '%');
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

    case 'typeof':
    case 'isbool':
    case 'isstr': {
      ir.unsupported.push(messages.eval_func_unsupported(name));
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

function needsNumeric(node) {
  return (
    typeof node === 'string' &&
    !looksLikeNumber(node) &&
    !/[+\-*/%()]/.test(node)
  );
}

function isTrueCondition(node) {
  if (typeof node === 'string') return node === '1' || node === 'true';
  if (node && node.type === 'EvalComparison') {
    return node.left === '1' && node.op === '=' && node.right === '1';
  }
  return !!(node && node.type === 'EvalFunc' && node.name === 'true');
}
