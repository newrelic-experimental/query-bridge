/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decide whether `dedup K … | stats|timechart|chart count …` can translate as a
 * flat `uniqueCount(K)` instead of a nested `FACET K LIMIT MAX` subquery.
 *
 * Counting the rows dedup keeps is counting distinct values of K, so the nested
 * form is unnecessary — and harmful: its inner FACET caps at 5,000 keys and
 * exposes only K, so any later reference to another field is unsupported.
 *
 * True only when every command between the dedup and the next aggregation is a
 * row-wise step that cannot rewrite K, and that aggregation is all plain counts.
 * Anything else → false, and the caller keeps the nested translation. LOUD over
 * silent-wrong: when in doubt, return false.
 *
 * @param {object} dedup        the DedupCommand AST node
 * @param {Array<object>} downstream  commands after it
 * @returns {boolean}
 */
export function isDedupCountDistinct(dedup, downstream) {
  // `dedup 3 K` keeps 3 rows per key; multi-key needs uniqueCount(a, b), not yet
  // validated live.
  if (dedup.count !== 1 || (dedup.fields || []).length !== 1) return false;
  const key = dedup.fields[0];
  if (typeof key !== 'string' || key.includes('*')) return false;

  for (const cmd of downstream) {
    switch (cmd.type) {
      case 'StatsCommand':
      case 'TimechartCommand':
      case 'ChartCommand':
        return (
          (cmd.functions || []).length > 0 && cmd.functions.every(isPlainCount)
        );
      case 'WhereCommand':
      case 'SearchCommand':
      case 'JoinCommand':
        break;
      case 'EvalCommand':
        if (cmd.rawText || !cmd.assignments) return false;
        if (cmd.assignments.some((a) => a.field === key)) return false;
        break;
      case 'BinCommand':
        if (!cmd.field || cmd.field === key || cmd.alias === key) return false;
        break;
      default:
        return false;
    }
  }
  return false;
}

// `count`, `c`, `count()`, `count(*)` — not `count(field)` (non-null count) or
// `count(eval(…))` (a filtered count).
function isPlainCount(fn) {
  if (fn.name !== 'count' || fn.evalFilter) return false;
  const args = fn.args || [];
  return args.length === 0 || (args.length === 1 && isStar(args[0]));
}

function isStar(arg) {
  if (arg === '*') return true;
  return (
    !!arg && typeof arg === 'object' && (arg.name === '*' || arg.value === '*')
  );
}
