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
  Binding,
} from '../../ir/nodes.js';
import { messages } from '../../messages.js';
import {
  getRe2Compatibility,
  resolveConstructMessageKey,
} from './re2Compat.js';
// Circular import — safe because translateSearchExpr is only called at runtime
import { translateSearchExpr } from './splToIR.js';
import {
  buildRegexMatch,
  rawEventIdentifier,
  wrapAsSubquery,
} from './splExprUtils.js';
import {
  buildRegexReplace,
  nextReplaceBase,
  parseSedScript,
} from './regexReplace.js';

// Options before the regex (`field=x max_match=1 `), a complete quoted regex.
const REX_LEAD = String.raw`^(?:[a-z_]+=\S+\s+)*"(?:[^"\\]|\\.)*"`;
const REX_TRAILING_TOKEN = new RegExp(
  `${REX_LEAD}\\s+\\$([A-Za-z0-9_.:-]+)\\$\\s*$`,
  'i',
);
const REX_STRAY_AFTER_QUOTE = new RegExp(`${REX_LEAD}\\S`, 'i');

// Tell a source defect from a grammar gap so the two route differently.
function describeRexFailure(rawText) {
  const token = REX_TRAILING_TOKEN.exec(rawText);
  if (token) return messages.rex_trailing_token(token[1]);
  if (REX_STRAY_AFTER_QUOTE.test(rawText)) {
    return messages.rex_malformed_regex(rawText);
  }
  return messages.rex_parse_failed(rawText);
}

export function handleRex(cmd, ir) {
  if (cmd.mode === 'sed') {
    handleRexSed(cmd, ir);
    return;
  }
  if (cmd.mode !== 'extract' || !cmd.pattern) {
    ir.unsupported.push(describeRexFailure(cmd.rawText || ''));
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

  // A positive lookbehind at the very start / lookahead at the very end of the
  // pattern only asserts context around the extraction. capture() returns just
  // the named groups, so consuming that context instead is the same extraction:
  // `(?<=orderId=)(?<oid>\d+)` ≡ `(?:orderId=)(?<oid>\d+)`. Only assertions with
  // no nested group qualify; anything else stays refused below.
  const pattern = consumeEdgeLookaround(cmd.pattern);

  // Detect PCRE lookbehind/lookahead — NRQL capture() rejects these
  if (/\(\?<=|\(\?<!|\(\?=|\(\?!/.test(pattern)) {
    ir.unsupported.push(messages.rex_lookaround());
    return;
  }

  // Build capture() expression(s)
  const field = cmd.field === '_raw' ? 'message' : cmd.field;
  // Convert (?<name>) to (?P<name>) — NRQL capture() uses Python regex syntax
  // Only convert named groups ((?<identifier>)), not lookbehind (?<=) or lookahead (?=)
  const normalizedPattern = pattern.replace(/\(\?<([a-zA-Z_]\w*)>/g, '(?P<$1>');
  // capture() matches the WHOLE value, so the pattern is wrapped in context.
  // The prefix must be LAZY: a greedy `.*` would consume as much as it can and
  // bind the LAST match (`.*(?P<a>\w+).*` on "hello world" → "d"), where Splunk
  // rex takes the first. `(?s:…)` lets the context span newlines (a multi-line
  // message otherwise fails to match at all) while the pattern's own `.` keeps
  // its Splunk meaning. Avoid the wrap when the pattern already starts/ends
  // with .* or .+.
  const prefix = /^\.[*+]/.test(normalizedPattern) ? '' : '(?s:.*?)';
  const suffix = /\.[*+]$/.test(normalizedPattern) ? '' : '(?s:.*)';
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
  const source =
    cmd.field === '_raw' ? rawEventIdentifier() : Identifier(field);
  const captureExpr = Func('capture', [source, Regex(fullPattern)]);
  // Past 5 capture() calls, splToIR rewrites simple patterns as aparse().
  Object.defineProperty(captureExpr, '_rexPattern', {
    value: pattern,
    enumerable: false,
  });
  const tupleName = `(${names.join(', ')})`;
  ir.bindings.push(Binding(tupleName, captureExpr));
}

// `rex mode=sed "s/A/B/[g]"` on a field → a capture() split + concat() rebuild
// bound back to the field (regexReplace.js). Refused (loud, naming the script):
// sed on _raw (later raw-event searches would still read the unmodified
// message), after an aggregation, or any substitution that isn't exact.
function handleRexSed(cmd, ir) {
  const script = cmd.pattern || '';
  const isRaw = !cmd.field || cmd.field === '_raw';
  const field = isRaw ? 'message' : cmd.field;
  if (isRaw || ir._hasAggregation) {
    ir.unsupported.push(messages.rex_sed_unsupported(field, script));
    return;
  }
  const sed = parseSedScript(script);
  if (!sed) {
    ir.unsupported.push(messages.rex_sed_unsupported(field, script));
    return;
  }
  const result = buildRegexReplace({
    source: Identifier(field),
    pattern: sed.pattern,
    replacement: sed.replacement,
    global: sed.global,
    isSed: true,
    base: nextReplaceBase(ir, 'sed'),
  });
  if ('error' in result) {
    ir.unsupported.push(
      messages.rex_sed_untranslatable(field, script, result.error),
    );
    return;
  }
  ir.bindings.push(...result.bindings, Binding(field, result.expr));
}

// The body of a lookaround with no nested group (escapes allowed).
const LOOKAROUND_BODY = String.raw`((?:\\.|[^()\\])*)`;
const LEADING_LOOKBEHIND = new RegExp(
  String.raw`^\(\?<=` + LOOKAROUND_BODY + String.raw`\)`,
);
const TRAILING_LOOKAHEAD = new RegExp(
  String.raw`\(\?=` + LOOKAROUND_BODY + String.raw`\)$`,
);

// Rewrite a leading positive lookbehind / trailing positive lookahead as a
// non-capturing group that consumes the same text. Any other lookaround is left
// in place (the caller refuses it).
function consumeEdgeLookaround(pattern) {
  return pattern
    .replace(LEADING_LOOKBEHIND, '(?:$1)')
    .replace(TRAILING_LOOKAHEAD, '(?:$1)');
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
    const autoInput = cmd.input || '_raw';
    for (const f of fields) {
      // Splunk array notation → jparse path: a{}.b → a[*].b, a{2}.b → a[2].b
      const jpath = f.replace(/\{(\d*)\}/g, (_, n) => (n ? `[${n}]` : '[*]'));
      ir.bindings.push(
        Binding(
          f,
          Func('jparse', [spathSource(autoInput), Literal(jpath, 'string')]),
        ),
      );
    }
    ir.warnings.push(messages.spath_auto_extract(fields.join(', ')));
    return;
  }
  const input = cmd.input || '_raw';
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
      Func('jparse', [spathSource(input), Literal(jsonPath, 'string')]),
    ),
  );
  ir.warnings.push(messages.spath_json_only());
}

// spath reads _raw by default. An explicit `input=message` is the SPL field
// named message (which an earlier rex/spath may have re-bound); `_raw` is the
// raw event text, stored in New Relic as `message`.
function spathSource(input) {
  return input === '_raw' ? rawEventIdentifier() : Identifier(input);
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
  const fieldId = field === '_raw' ? rawEventIdentifier() : Identifier(field);
  const match = buildRegexMatch(fieldId, cmd.pattern);
  ir.where.push(cmd.negate ? Not(match) : match);
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
