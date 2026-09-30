/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regex substitution (`rex mode=sed "s/A/B/"`, eval `replace(f, "regex", "B")`)
 * as NRQL. NRQL replace() is literal-only, but one substitution can be rebuilt
 * from a capture() that splits the value around the match:
 *
 *   WITH capture(f, r'^(?P<pre>(?s:.*?))(?P<m>A)(?P<post>(?s:.*))$') AS (pre, m, post),
 *        if(m IS NULL, f, concat(pre, 'B', post)) AS f'
 *
 * The lazy `pre` makes it the LEFTMOST match (Splunk's first match). `(?s:…)`
 * lets the context span newlines while A's own `.` keeps its meaning. `^A` drops
 * `pre`, `A$` drops `post`. `\N` in the replacement reads the pattern's N-th
 * capture group (each group is named, by position, in the capture() tuple).
 *
 * Exact only when ONE substitution is what Splunk does: no `g` flag, a `g` on an
 * anchored pattern (it can match once), or a literal pattern (→ NRQL replace(),
 * which replaces every occurrence). An unanchored regex with `g` (and eval
 * replace(), which is always global) is refused — loud over a first-match-only
 * result that differs from Splunk's.
 */
import {
  Binding,
  Func,
  Identifier,
  IsNull,
  Literal,
  Regex,
} from '../../ir/nodes.js';
import { getRe2Compatibility } from './re2Compat.js';
import { endsWithUnescapedDollar } from './splExprUtils.js';

const REGEX_META = /[.[\](){}*+?|^$\\]/;

/**
 * Parse a sed script `s<d>pattern<d>replacement<d>flags` (any delimiter; `\<d>`
 * escapes it). Returns null when it is not a substitution we understand.
 * @param {string} script
 * @returns {{ pattern: string, replacement: string, global: boolean } | null}
 */
export function parseSedScript(script) {
  if (typeof script !== 'string' || script[0] !== 's' || script.length < 4) {
    return null;
  }
  const delim = script[1];
  if (/[\w\s\\]/.test(delim)) return null;
  const parts = [];
  let current = '';
  for (let i = 2; i < script.length; i++) {
    const c = script[i];
    if (c === '\\' && script[i + 1] === delim) {
      current += delim;
      i++;
    } else if (c === '\\') {
      current += c + (script[i + 1] ?? '');
      i++;
    } else if (c === delim) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (parts.length !== 2) return null;
  const flags = current;
  if (!/^g?$/.test(flags)) return null; // an Nth-match or unknown flag
  return { pattern: parts[0], replacement: parts[1], global: flags === 'g' };
}

// Give every capturing group in `pattern` a positional name `<base>_g<N>`.
// Returns null on lookaround (capture()/RE2 has none).
function nameCaptureGroups(pattern, base) {
  let out = '';
  let inClass = false;
  let count = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      out += c + (pattern[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      out += c;
      continue;
    }
    if (c === '[') {
      inClass = true;
      out += c;
      if (pattern[i + 1] === '^') out += pattern[++i];
      if (pattern[i + 1] === ']') out += pattern[++i];
      continue;
    }
    if (c === '(') {
      const rest = pattern.slice(i);
      if (pattern[i + 1] !== '?') {
        count++;
        out += `(?P<${base}_g${count}>`;
        continue;
      }
      const named = /^\(\?P?<([A-Za-z_]\w*)>/.exec(rest);
      if (named) {
        count++;
        out += `(?P<${base}_g${count}>`;
        i += named[0].length - 1;
        continue;
      }
      if (/^\(\?<?[=!]/.test(rest)) return null;
    }
    out += c;
  }
  return { pattern: out, count };
}

// Split a replacement into literal text and group references.
// sed: `&` is the whole match (refused), `\&` a literal &.
function parseReplacement(replacement, groupCount, isSed) {
  const pieces = [];
  let text = '';
  for (let i = 0; i < replacement.length; i++) {
    const c = replacement[i];
    if (c === '\\' && /[0-9]/.test(replacement[i + 1] ?? '')) {
      const n = Number(replacement[++i]);
      if (n === 0 || n > groupCount) {
        return { error: `\\${n} names no capture group in the pattern` };
      }
      if (text) pieces.push({ text });
      text = '';
      pieces.push({ group: n });
    } else if (c === '\\' && i + 1 < replacement.length) {
      text += replacement[++i];
    } else if (c === '&' && isSed) {
      return { error: '& (the whole match) in the replacement' };
    } else {
      text += c;
    }
  }
  if (text) pieces.push({ text });
  return { pieces };
}

function concatOf(args) {
  if (args.length === 0) return Literal('', 'string');
  if (args.length === 1) return args[0];
  return Func('concat', args);
}

/**
 * Build the IR for one regex substitution over `source`.
 * @param {object} opts
 * @param {object} opts.source       IR expression being rewritten
 * @param {string} opts.pattern      regex (Splunk/PCRE syntax)
 * @param {string} opts.replacement  replacement text (`\N` group references)
 * @param {boolean} opts.global      replace every match (`g` / eval replace())
 * @param {boolean} opts.isSed       sed replacement syntax (`&`)
 * @param {string} opts.base         unique binding-name prefix for this substitution
 * @returns {{ bindings: object[], expr: object } | { error: string }}
 */
export function buildRegexReplace({
  source,
  pattern,
  replacement,
  global,
  isSed,
  base,
}) {
  // A literal pattern: NRQL replace() is exact for a global substitution.
  if (!REGEX_META.test(pattern) && global) {
    if (
      /\\[0-9]/.test(replacement) ||
      (isSed && /(^|[^\\])&/.test(replacement))
    ) {
      return {
        error: 'a group reference in the replacement of a literal pattern',
      };
    }
    const text = replacement.replace(/\\(.)/g, '$1');
    return {
      bindings: [],
      expr: Func('replace', [
        source,
        Literal(pattern, 'string'),
        Literal(text, 'string'),
      ]),
    };
  }
  let body = pattern;
  const anchoredStart = body.startsWith('^');
  const anchoredEnd = endsWithUnescapedDollar(body);
  if (anchoredStart) body = body.slice(1);
  if (anchoredEnd) body = body.slice(0, -1);
  if (global && !anchoredStart && !anchoredEnd) {
    return {
      error:
        'the substitution is global and the pattern can match more than once; capture() rebuilds only the first match',
    };
  }
  const named = nameCaptureGroups(body, base);
  if (!named) return { error: 'lookaround in the pattern' };
  const parsed = parseReplacement(replacement, named.count, isSed);
  if (parsed.error) return { error: parsed.error };

  const pre = `${base}_pre`;
  const match = `${base}_m`;
  const post = `${base}_post`;
  const groupNames = Array.from(
    { length: named.count },
    (_, i) => `${base}_g${i + 1}`,
  );
  const regex =
    '^' +
    (anchoredStart ? '' : `(?P<${pre}>(?s:.*?))`) +
    `(?P<${match}>${named.pattern})` +
    (anchoredEnd ? '' : `(?P<${post}>(?s:.*))`) +
    '$';
  const { compatible, reason } = getRe2Compatibility(regex);
  if (!compatible)
    return { error: `the pattern is not RE2-compatible (${reason})` };

  const tuple = [
    ...(anchoredStart ? [] : [pre]),
    match,
    ...groupNames,
    ...(anchoredEnd ? [] : [post]),
  ];
  const rebuilt = concatOf([
    ...(anchoredStart ? [] : [Identifier(pre)]),
    ...parsed.pieces.map((p) =>
      p.group ? Identifier(groupNames[p.group - 1]) : Literal(p.text, 'string'),
    ),
    ...(anchoredEnd ? [] : [Identifier(post)]),
  ]);
  return {
    bindings: [
      Binding(`(${tuple.join(', ')})`, Func('capture', [source, Regex(regex)])),
    ],
    expr: Func('if', [IsNull(Identifier(match)), source, rebuilt]),
  };
}

/**
 * The next unused binding-name prefix (`sed1`, `sed2`, … / `repl1`, …) at this
 * query level.
 * @param {{ bindings: Array<{ name: string }> }} ir
 * @param {string} kind
 */
export function nextReplaceBase(ir, kind) {
  let n = 1;
  const taken = (b) => b.name.includes(`${kind}${n}_`);
  while (ir.bindings.some(taken)) n++;
  return `${kind}${n}`;
}
