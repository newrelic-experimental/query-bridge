/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RE2-compatibility gate for rex → capture() conversion.
 *
 * NRQL capture() is backed by RE2/J (com.google.re2j). re2js is the pure-JS
 * port of the same engine, so "does re2js compile this pattern?" authoritatively
 * answers "will capture() accept it at runtime?" — including constructs no
 * hand-maintained list enumerates. getRe2Compatibility is the gate;
 * resolveConstructMessageKey is a naive token probe used ONLY to phrase a
 * friendlier message after the gate has already rejected (so it never has to
 * distinguish a real backref from an escaped backslash — the gate did that).
 */
import { RE2JS } from 're2js';

/**
 * @param {string} pattern
 * @returns {{ compatible: boolean, reason: string|null }}
 */
export function getRe2Compatibility(pattern) {
  try {
    RE2JS.compile(pattern);
    return { compatible: true, reason: null };
  } catch (err) {
    return {
      compatible: false,
      reason: err && err.message ? err.message : String(err),
    };
  }
}

// Naive construct probes — message-quality only, consulted post-rejection.
// PR1: backreferences. Task 3 extends this list (atomic/possessive/recursion/
// conditional). Order is irrelevant since the gate has already rejected.
const CONSTRUCT_PROBES = [
  // numbered \1..\9, named \k<name>, named (?P=name)
  { re: /\\[1-9]|\\k<|\(\?P=/, key: 'rex_backreference' },
  // atomic group (?>...)
  { re: /\(\?>/, key: 'rex_atomic_group' },
  // possessive quantifiers: *+ ++ ?+ {n,m}+
  { re: /(?:[*+?]|\})\+/, key: 'rex_possessive_quantifier' },
  // recursion / subroutine: (?R) (?1) \g<name>
  { re: /\(\?R\)|\(\?\d+\)|\\g</, key: 'rex_recursion' },
  // conditional: (?(1)...|...)
  { re: /\(\?\(/, key: 'rex_conditional' },
];

/**
 * @param {string} pattern
 * @returns {string|null} a messages key, or null if no known construct matches
 */
export function resolveConstructMessageKey(pattern) {
  for (const probe of CONSTRUCT_PROBES) {
    if (probe.re.test(pattern)) return probe.key;
  }
  return null;
}
