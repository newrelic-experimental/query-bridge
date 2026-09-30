/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decide which fields a `spath` (no `path=`) auto-extract must bind, by scanning
 * the commands that FOLLOW it in the pipeline.
 *
 * Returns the de-duplicated list of bare field names referenced downstream, or
 * `null` when the auto-extract is NOT safely enumerable — in which case the caller
 * emits the loud `spath_no_path` `unsupported`. LOUD over silent-wrong: when in
 * doubt, return null.
 *
 * Every field-referencing stage is scanned: `where`, `search`, `eval`, `table`,
 * `fields`, `dedup`, `top`/`rare`, `sort`, `rename`, and the aggregations
 * (`stats`/`chart`/`timechart`/`eventstats` — function arguments and `by`
 * fields). The scan stops after the first aggregation: later references are to
 * aggregated columns, not JSON properties. Names an earlier `eval`/`rename`
 * defined are not JSON properties either, and Splunk's default fields (`_time`,
 * `index`, `host`, …) are never re-bound.
 *
 * Any command type not listed, a wildcard/`*` reference, or an expression node
 * the walker doesn't understand → null.
 *
 * @param {Array<object>} downstream  commands after the no-path spath
 * @returns {string[] | null}
 */
export function collectAutoExtractFields(downstream) {
  const refs = collectDownstreamFieldRefs(downstream);
  if (!refs) return null;
  const fields = refs.fields.filter((f) => !DEFAULT_FIELDS.has(f));
  return fields.length > 0 ? fields : null;
}

/**
 * The fields the commands after a stage reference, scanning up to and including
 * the first aggregation (past it, references are aggregated columns). Names an
 * earlier `eval`/`rename` defined are excluded; Splunk default fields are kept.
 * `aggregated` says whether the scan reached an aggregation.
 *
 * With `stopAtJoin`, the scan also stops at a `join` (after its key): which
 * later fields the join supplies is known only once its subsearch is
 * translated, so `joined` tells the caller (handleDedup) to leave them to
 * handleJoin.
 *
 * null when the references are not safely enumerable: any command type not
 * listed, a wildcard/`*` reference, or an expression node the walker doesn't
 * understand.
 *
 * @param {Array<object>} downstream  commands after the stage
 * @param {{ stopAtJoin?: boolean }} [options]
 * @returns {{ fields: string[], aggregated: boolean, joined?: boolean } | null}
 */
export function collectDownstreamFieldRefs(downstream, options = {}) {
  if (!downstream) return null;
  const fields = [];
  const defined = new Set();
  let ok = true;
  const add = (name) => {
    if (typeof name !== 'string' || !name) return;
    if (name === '*' || name.includes('*') || /\(.*\)$/.test(name)) {
      ok = false; // a wildcard / stats-column form is not enumerable
      return;
    }
    if (defined.has(name)) return;
    if (!fields.includes(name)) fields.push(name);
  };
  const done = (aggregated) => (ok ? { fields, aggregated } : null);
  const addExpr = (node) => {
    if (!collectExprFields(node, add)) ok = false;
  };

  for (const cmd of downstream) {
    switch (cmd.type) {
      case 'StatsCommand':
      case 'ChartCommand':
      case 'TimechartCommand':
      case 'EventstatsCommand': {
        for (const fn of cmd.functions || []) {
          if (fn.evalFilter) addExpr(fn.evalFilter);
          for (const a of fn.args || []) if (!isStar(a)) addExpr(a);
        }
        for (const f of cmd.groupBy || []) add(f);
        // Past an aggregation, references are aggregated columns — stop.
        return done(true);
      }
      case 'WhereCommand':
        if (!collectWhereFields(cmd.expression || cmd.expr, add, addExpr)) {
          return null;
        }
        break;
      case 'SearchCommand':
        if (!collectWhereFields(cmd.expression || cmd.search, add, addExpr)) {
          return null;
        }
        break;
      case 'EvalCommand':
        if (cmd.rawText || !cmd.assignments) return null;
        for (const a of cmd.assignments) {
          addExpr(a.expr);
          defined.add(a.field);
        }
        break;
      case 'TableCommand':
      case 'FieldsCommand':
      case 'DedupCommand':
        for (const f of cmd.fields || []) add(f);
        break;
      case 'TopCommand':
        for (const f of cmd.fields || []) add(f);
        for (const f of cmd.groupBy || []) add(f);
        // top is an aggregation — stop.
        return done(true);
      case 'RareCommand':
        add(cmd.field);
        for (const f of cmd.groupBy || []) add(f);
        return done(true);
      case 'SortCommand':
        for (const f of cmd.fields || []) add(f.field);
        break;
      case 'RenameCommand':
        for (const r of cmd.renames || []) {
          add(r.from);
          defined.add(r.to);
        }
        break;
      case 'HeadCommand':
      case 'TailCommand':
      case 'ReverseCommand':
        break;
      case 'JoinCommand':
        if (!options.stopAtJoin || !cmd.field) return null;
        add(cmd.field);
        return ok ? { fields, aggregated: false, joined: true } : null;
      default:
        // Any command we do not confidently enumerate → not safely enumerable.
        return null;
    }
    if (!ok) return null;
  }
  return done(false);
}

// Splunk default/metadata fields — never JSON properties of the spath input.
const DEFAULT_FIELDS = new Set([
  '_time',
  '_raw',
  'index',
  'sourcetype',
  'source',
  'host',
  'linecount',
  'splunk_server',
  'timestamp',
  'message',
]);

// `count(*)`: the wildcard arg as a string, or object-wrapped ({ name: '*' }).
function isStar(arg) {
  if (arg === '*') return true;
  return (
    !!arg && typeof arg === 'object' && (arg.name === '*' || arg.value === '*')
  );
}

// Collect bare field references in an eval-ladder expression (strings are field
// names or numeric literals; typed nodes recurse). False on an unknown node.
function collectExprFields(node, add) {
  if (node == null) return true;
  if (typeof node === 'string') {
    if (!/^-?\d+(\.\d+)?$/.test(node)) add(node);
    return true;
  }
  if (typeof node !== 'object') return false;
  switch (node.type) {
    case 'StringLiteral':
      return true;
    case 'QuotedField':
      add(node.name);
      return true;
    case 'EvalFunc':
    case 'FunctionCall':
      return (node.args || []).every((a) => collectExprFields(a, add));
    case 'EvalArith':
    case 'EvalComparison':
    case 'EvalBoolOp':
      return (
        collectExprFields(node.left, add) && collectExprFields(node.right, add)
      );
    case 'EvalNot':
      return collectExprFields(node.operand, add);
    case 'EvalParens':
      return collectExprFields(node.inner, add);
    default:
      return false;
  }
}

// Walk a where/search expression collecting field names. Returns false (→ caller
// bails) on any node we don't confidently understand.
function collectWhereFields(node, add, addExpr) {
  if (!node || typeof node !== 'object') return false;
  switch (node.type) {
    case 'Comparison':
      if (typeof node.field !== 'string' || !node.field) return false;
      add(node.field);
      if (node.rhsExpr) addExpr(node.rhsExpr);
      return true;
    case 'InComparison':
      add(node.field);
      return true;
    case 'BooleanOp':
      return (
        collectWhereFields(node.left, add, addExpr) &&
        collectWhereFields(node.right, add, addExpr)
      );
    case 'Not':
      return collectWhereFields(node.operand, add, addExpr);
    case 'ConstComparison':
    case 'BareKeyword':
    case 'TimeConstraint':
      // No JSON field reference (a bare term searches the raw text).
      return true;
    case 'FunctionCall':
      addExpr(node);
      return true;
    default:
      return false;
  }
}
