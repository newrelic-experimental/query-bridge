/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A `rex` pattern as an NRQL aparse() pattern, when it is "simple": literal
 * anchor text around named groups that each read up to the next literal —
 * `"bookingId":"(?<id>[^"]+)"` → `%"bookingId":"*"%`.
 *
 * aparse() is not a capture() call, so it doesn't count toward NRQL's limit of
 * 5 capture() calls per query (sandbox-verified: six aparse() run). Its
 * semantics, sandbox-verified: `%` skips lazily (the FIRST occurrence, like
 * Splunk's rex), `*` captures up to the next literal, no match gives null — and
 * the literal text matches case-INSENSITIVELY (the one difference; callers warn).
 *
 * A group body is accepted only when `*` reads exactly what it reads:
 *   [^X]+ / [^X]*   followed by literal text starting with X
 *   .*? / .+?       followed by any literal text
 * (`[^X]+` and `.+?` need one character where `*` also takes an empty value.)
 *
 * @param {string} pattern  the rex pattern (Splunk `(?<name>…)` groups)
 * @returns {string | null} the aparse pattern, or null when not simple
 */
export function formatRexAsAparse(pattern) {
  let i = 0;
  let out = '';
  const anchoredStart = pattern.startsWith('^');
  if (anchoredStart) i = 1;
  let groups = 0;
  let pendingStop = null; // after a group: the literal text must start with this
  let literalSinceGroup = '';
  const flushGroupCheck = () => {
    if (pendingStop === null) return true;
    if (literalSinceGroup === '') return false; // nothing ends the capture
    if (pendingStop !== '' && literalSinceGroup[0] !== pendingStop)
      return false;
    pendingStop = null;
    return true;
  };

  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '$' && i === pattern.length - 1) {
      if (!flushGroupCheck()) return null;
      return groups > 0 ? `${anchoredStart ? '' : '%'}${out}` : null;
    }
    if (c === '(') {
      const group =
        /^\(\?P?<[A-Za-z_]\w*>(\[\^(\\.|[^\\\]])\][+*]|\.[*+]\?)\)/.exec(
          pattern.slice(i),
        );
      if (!group) return null;
      if (!flushGroupCheck()) return null;
      // Each capture needs anchor text before it (or the ^ anchor).
      if (out === '' ? !anchoredStart : out.endsWith('*')) return null;
      const body = group[1];
      pendingStop = body.startsWith('[^') ? unescape(group[2]) : '';
      literalSinceGroup = '';
      out += '*';
      groups++;
      i += group[0].length;
      continue;
    }
    let literal;
    if (c === '\\') {
      const next = pattern[i + 1];
      // Only an escaped punctuation character is a plain literal (\d, \t, … are not).
      if (next === undefined || /[A-Za-z0-9\\]/.test(next)) return null;
      literal = next;
      i += 2;
    } else if (/[.[\](){}*+?|^$]/.test(c)) {
      return null;
    } else {
      literal = c;
      i++;
    }
    // aparse's own wildcards can't appear as literal text.
    if (literal === '%' || literal === '*' || literal === "'") return null;
    out += literal;
    if (pendingStop !== null) literalSinceGroup += literal;
  }
  if (!flushGroupCheck()) return null;
  return groups > 0 ? `${anchoredStart ? '' : '%'}${out}%` : null;
}

function unescape(ch) {
  return ch.length === 2 && ch[0] === '\\' ? ch[1] : ch;
}
