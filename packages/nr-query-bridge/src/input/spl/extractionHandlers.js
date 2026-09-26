/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

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
import {
  getRe2Compatibility,
  resolveConstructMessageKey,
} from './re2Compat.js';
// Circular import — safe because translateSearchExpr is only called at runtime
import { translateSearchExpr } from './splToIR.js';
import { wrapAsSubquery } from './splExprUtils.js';

export function handleRex(cmd, ir) {
  if (cmd.mode === 'sed') {
    // No NRQL equivalent (replace() is literal-only). Name the field and script so
    // migration tooling can route it to an ingest-time parsing rule.
    const field = !cmd.field || cmd.field === '_raw' ? 'message' : cmd.field;
    ir.unsupported.push(messages.rex_sed_unsupported(field, cmd.pattern || ''));
    return;
  }
  if (cmd.mode !== 'extract' || !cmd.pattern) {
    ir.unsupported.push(messages.rex_parse_failed(cmd.rawText || ''));
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

  // max_match=1 is the default (first match) — exactly what capture() does.
  // Anything else (0 = unlimited, N > 1) returns multiple values per event.
  if (cmd.maxMatch != null && cmd.maxMatch !== 1) {
    ir.unsupported.push(messages.rex_max_match(cmd.maxMatch));
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

  // RE2-compatibility gate: capture() is backed by RE2/J, which rejects
  // backreferences, atomic groups, possessive quantifiers, recursion, and
  // conditionals. re2js is a faithful RE2 oracle — if it can't compile the
  // emitted pattern, capture() will reject it at runtime. Emit unsupported
  // (loud) rather than a capture() that breaks live. (Lookaround is caught
  // above with its own message.)
  const { compatible, reason } = getRe2Compatibility(fullPattern);
  if (!compatible) {
    const key = resolveConstructMessageKey(cmd.pattern);
    if (key) {
      ir.unsupported.push(messages[key]());
    } else {
      ir.unsupported.push(messages.rex_re2_incompatible(reason));
    }
    return;
  }

  // Single capture() call with tuple destructuring for multiple groups:
  // WITH capture(field, r'...(?P<a>...)...(?P<b>...)...') AS (a, b)
  const captureExpr = Func('capture', [Identifier(field), Regex(fullPattern)]);
  const tupleName = `(${names.join(', ')})`;
  ir.bindings.push(Binding(tupleName, captureExpr));
}

export function handleSpath(cmd, ir) {
  if (!cmd.path) {
    // No path= → Splunk auto-extracts all JSON fields. There's no NRQL "extract
    // everything", but if the downstream references a small enumerable set of
    // fields (computed in splToIR), bind each as jparse(<source>, '<field>').
    // Non-enumerable / auto-extract-all → loud spath_no_path.
    const fields = cmd._autoExtractFields;
    if (!fields || fields.length === 0) {
      ir.unsupported.push(messages.spath_no_path());
      return;
    }
    const autoInput = cmd.input || 'message';
    const autoSource = autoInput === '_raw' ? 'message' : autoInput;
    for (const f of fields) {
      // Splunk array notation → jparse path: a{}.b → a[*].b, a{2}.b → a[2].b
      const jpath = f.replace(/\{(\d*)\}/g, (_, n) => (n ? `[${n}]` : '[*]'));
      ir.bindings.push(
        Binding(
          f,
          Func('jparse', [Identifier(autoSource), Literal(jpath, 'string')]),
        ),
      );
    }
    ir.warnings.push(messages.spath_auto_extract(fields.join(', ')));
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
  // Grammar produces pattern: null for unparseable forms (e.g. unquoted RHS,
  // template-variable RHS like `regex foo=$bar$`). Loud failure beats emitting
  // a syntactically-broken Rlike with no pattern.
  if (cmd.pattern == null) {
    ir.unsupported.push(messages.regex_command_unparsed(cmd.rawText || ''));
    return;
  }
  const field = cmd.field || '_raw';
  const fieldId = field === '_raw' ? Identifier('message') : Identifier(field);
  if (cmd.negate) {
    ir.where.push(Not(Rlike(fieldId, cmd.pattern)));
  } else {
    ir.where.push(Rlike(fieldId, cmd.pattern));
  }
}

// True when a search expression is built only from comparisons on the current
// (flat, not yet wrapped) aggregation's FACET keys.
function onlyReferencesFacetKeys(node, ir) {
  if (ir.dataSource?.type === 'SubquerySource') return false;
  const keys = new Set(
    ir.facet.filter((f) => f.type === 'Identifier').map((f) => f.name),
  );
  const walk = (n) => {
    if (!n || typeof n !== 'object') return false;
    switch (n.type) {
      case 'Comparison':
        return !n.rhsExpr && keys.has(n.field);
      case 'InComparison':
        return keys.has(n.field);
      case 'BooleanOp':
        return walk(n.left) && walk(n.right);
      case 'Not':
        return walk(n.operand);
      default:
        return false;
    }
  };
  return keys.size > 0 && walk(node);
}

export function handleSearchPipe(cmd, ir) {
  // | search is like an additional WHERE clause
  const searchNode = cmd.search || cmd.expression;
  if (searchNode) {
    // After an aggregation, `search` filters the AGGREGATED rows: wrap the
    // aggregation as a subquery and filter the outer query (same as `where`).
    // Pushing it into the inner WHERE would filter raw events on a column
    // that doesn't exist yet.
    // Exception: a filter on group-by keys only selects whole groups, which is
    // the same as filtering the events before aggregating — push it down.
    const unwrap =
      ir._hasAggregation && !onlyReferencesFacetKeys(searchNode, ir)
        ? wrapAsSubquery(ir)
        : null;
    const { expr, warnings, unsupported } = translateSearchExpr(searchNode, ir);
    if (expr) {
      ir.where.push(expr);
    } else if (unwrap) {
      unwrap(); // nothing to filter — no empty outer wrapper
    }
    ir.warnings.push(...warnings);
    ir.unsupported.push(...unsupported);
  }
}
