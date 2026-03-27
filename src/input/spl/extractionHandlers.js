/**
 * Extraction command handlers.
 *
 * Handlers for SPL commands that extract fields from text:
 * rex (regex extraction), spath (JSON path), regex (filter by pattern),
 * search pipe (additional WHERE).
 */
import {
  Identifier,
  Literal,
  Not,
  Func,
  Regex,
  Rlike,
  Binding,
} from '../../ir/nodes.js';
import { messages } from '../../messages.js';
// Circular import — safe because translateSearchExpr is only called at runtime
import { translateSearchExpr } from './splToIR.js';

export function handleRex(cmd, ir) {
  if (cmd.mode === 'sed') {
    ir.unsupported.push(messages.rex_sed_unsupported());
    return;
  }
  if (cmd.mode !== 'extract' || !cmd.pattern) {
    ir.unsupported.push(messages.rex_parse_failed());
    return;
  }

  // Extract named group names — match (?P<name>) or (?<name>) but NOT (?<=) or (?<!)
  const groupRegex = /\(\?(?:P<|<)([a-zA-Z_]\w*)>/g;
  const names = [];
  let match;
  while ((match = groupRegex.exec(cmd.pattern)) !== null) {
    names.push(match[1]);
  }

  if (names.length === 0) {
    ir.unsupported.push(messages.rex_no_groups());
    return;
  }

  if (cmd.maxMatch) {
    ir.unsupported.push(messages.rex_max_match());
  }

  // Detect PCRE lookbehind/lookahead — NRQL capture() rejects these
  if (/\(\?<=|\(\?<!|\(\?=|\(\?!/.test(cmd.pattern)) {
    ir.unsupported.push(messages.rex_lookaround());
    return;
  }

  // Build capture() expression(s)
  const field = cmd.field === '_raw' ? 'message' : cmd.field;
  // Convert (?<name>) to (?P<name>) — NRQL capture() uses Python regex syntax
  // Only convert named groups ((?<identifier>)), not lookbehind (?<=) or lookahead (?=)
  const normalizedPattern = cmd.pattern.replace(
    /\(\?<([a-zA-Z_]\w*)>/g,
    '(?P<$1>',
  );
  // Avoid redundant .* when pattern already anchors with .* or .+
  const prefix = /^\.[*+]/.test(normalizedPattern) ? '' : '.*';
  const suffix = /\.[*+]$/.test(normalizedPattern) ? '' : '.*';
  const fullPattern = `${prefix}${normalizedPattern}${suffix}`;

  // Single capture() call with tuple destructuring for multiple groups:
  // WITH capture(field, r'...(?P<a>...)...(?P<b>...)...') AS (a, b)
  const captureExpr = Func('capture', [Identifier(field), Regex(fullPattern)]);
  const tupleName = `(${names.join(', ')})`;
  ir.bindings.push(Binding(tupleName, captureExpr));
}

export function handleSpath(cmd, ir) {
  if (!cmd.path) {
    ir.unsupported.push(messages.spath_no_path());
    return;
  }
  const rawInput = cmd.input || 'message';
  const input = rawInput === '_raw' ? 'message' : rawInput;
  // Default output name is last segment of path (SPL convention)
  const output =
    cmd.output ||
    cmd.path
      .split('.')
      .pop()
      .replace(/[{}[\]*]/g, '');
  const jsonPath = cmd.path.replace(/\{[^}]*\}/g, '[*]');
  ir.bindings.push(
    Binding(
      output,
      Func('jparse', [Identifier(input), Literal(jsonPath, 'string')]),
    ),
  );
  ir.warnings.push(messages.spath_json_only());
}

export function handleRegex(cmd, ir) {
  const field = cmd.field || '_raw';
  const fieldId = field === '_raw' ? Identifier('message') : Identifier(field);
  const pattern = cmd.pattern;
  if (cmd.negate) {
    ir.where.push(Not(Rlike(fieldId, pattern)));
  } else {
    ir.where.push(Rlike(fieldId, pattern));
  }
}

export function handleSearchPipe(cmd, ir) {
  // | search is like an additional WHERE clause
  const searchNode = cmd.search || cmd.expression;
  if (searchNode) {
    const { expr, warnings, unsupported } = translateSearchExpr(searchNode, ir);
    if (expr) {
      ir.where.push(expr);
    }
    ir.warnings.push(...warnings);
    ir.unsupported.push(...unsupported);
  }
}
