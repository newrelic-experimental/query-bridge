/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decide which fields a `spath` (no `path=`) auto-extract must bind, by scanning
 * the commands that FOLLOW it in the pipeline.
 *
 * Returns the de-duplicated list of bare field names referenced by an enumerable
 * downstream, or `null` when the auto-extract is NOT safely enumerable — in which
 * case the caller emits the loud `spath_no_path` `unsupported`. LOUD over
 * silent-wrong: when in doubt, return null.
 *
 * v1 enumerates ONLY:
 *   - `stats`/`chart`/`timechart … by <fields>` whose functions are all field-free
 *     `count` (bare `count` or `count(*)`); its `groupBy` fields are collected. A
 *     function reading a bare field (`sum(bytes)`, `count(host)`) would itself need
 *     a binding we are not enumerating → null.
 *   - `where <field> <op> …` trees of `Comparison` (collect `.field`) and `BooleanOp`
 *     (recurse left/right).
 * Any other command type, a `*` reference, or an un-walkable where node → null.
 *
 * @param {Array<object>} downstream  commands after the no-path spath
 * @returns {string[] | null}
 */
export function collectAutoExtractFields(downstream) {
  if (!downstream || downstream.length === 0) return null;
  const fields = [];
  const add = (name) => {
    if (
      typeof name === 'string' &&
      name &&
      name !== '*' &&
      !fields.includes(name)
    ) {
      fields.push(name);
    }
  };
  for (const cmd of downstream) {
    switch (cmd.type) {
      case 'StatsCommand':
      case 'ChartCommand':
      case 'TimechartCommand': {
        // Every function must be a field-free count, else a JSON-derived metric
        // field would be left unbound (silent-wrong). Bail loudly instead.
        const fns = cmd.functions || [];
        const allFieldFreeCount = fns.every((fn) => isFieldFreeCount(fn));
        if (!allFieldFreeCount) return null;
        for (const f of cmd.groupBy || []) add(f);
        break;
      }
      case 'WhereCommand': {
        if (!collectWhereFields(cmd.expression || cmd.expr, add)) return null;
        break;
      }
      default:
        // Any command we do not confidently enumerate → not safely enumerable.
        return null;
    }
  }
  return fields.length > 0 ? fields : null;
}

// A `count` with no field argument: bare `count` (args:[]) or `count(*)`.
// Anything else (count(field), sum/avg/dc/…) reads a field we don't bind.
function isFieldFreeCount(fn) {
  if (!fn || fn.evalFilter) return false;
  if (typeof fn.name !== 'string' || fn.name.toLowerCase() !== 'count') {
    return false;
  }
  const args = fn.args || [];
  return args.every((a) => isStar(a));
}

function isStar(arg) {
  if (arg === '*') return true;
  // Tolerate an object-wrapped wildcard (e.g. { name: '*' } / { value: '*' }).
  return (
    !!arg && typeof arg === 'object' && (arg.name === '*' || arg.value === '*')
  );
}

// Walk a where expression collecting Comparison `.field` names. Returns false
// (→ caller bails) on any node we don't confidently understand.
function collectWhereFields(node, add) {
  if (!node || typeof node !== 'object') return false;
  switch (node.type) {
    case 'Comparison':
      if (typeof node.field !== 'string' || !node.field) return false;
      add(node.field);
      return true;
    case 'BooleanOp':
      return (
        collectWhereFields(node.left, add) &&
        collectWhereFields(node.right, add)
      );
    default:
      return false;
  }
}
