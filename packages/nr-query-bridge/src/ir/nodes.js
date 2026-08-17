/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IR Node Constructors.
 *
 * Plain objects with `type` discriminator fields.
 * Inspired by NRQL's TCompilerExpressionPlan from dirac-nrql Thrift,
 * but language-neutral — can emit to NRQL, Trino SQL, or other targets.
 */

/**
 * Base shape of every IR node: a plain object with a `type` discriminator.
 * Specific constructors below add their own fields. Field values are `any`
 * because the IR is an untyped JS tree internally; the discriminant `type`
 * is the stable contract.
 *
 * @typedef {{ type: string, [key: string]: any }} IRNode
 */

// ── Expression nodes ──────────────────────────────────────────

export const Identifier = (name) => ({ type: 'Identifier', name });

export const Literal = (value, kind) => ({ type: 'Literal', value, kind });

export const BinOp = (op, left, right) => ({ type: 'BinOp', op, left, right });

export const Not = (child) => ({ type: 'Not', child });

export const Func = (name, args) => ({ type: 'Function', name, args });

export const Alias = (expr, name) => ({ type: 'Alias', expr, name });

export const IsNull = (child) => ({ type: 'IsNull', child });

export const Like = (field, pattern) => ({ type: 'Like', field, pattern });

export const In = (field, values) => ({ type: 'In', field, values });

export const Wildcard = () => ({ type: 'Wildcard' });

export const SubqueryExpr = (query) => ({ type: 'SubqueryExpr', query });

export const Regex = (pattern) => ({ type: 'Regex', pattern });

export const Rlike = (field, pattern) => ({ type: 'Rlike', field, pattern });

export const RawNrql = (nrql) => ({ type: 'RawNrql', nrql });

export const DualCheck = (field, op, value) => ({
  type: 'DualCheck',
  field,
  op,
  value,
});

// ── Eval AST nodes (consumed by walkEvalExpr; never emitted to NRQL directly) ──

export const EvalArith = (op, left, right) => ({
  type: 'EvalArith',
  op,
  left,
  right,
});

export const EvalNot = (operand) => ({ type: 'EvalNot', operand });

// ── Data source nodes ─────────────────────────────────────────

export const EventType = (names) => ({ type: 'EventType', names });

export const LookupSource = (name) => ({ type: 'Lookup', name });

export const SubquerySource = (query) => ({ type: 'SubquerySource', query });

// ── Structural nodes ──────────────────────────────────────────

export const Binding = (name, expr) => ({ name, expr });

export const JoinClause = (subquery, onKey, joinType = 'INNER') => ({
  type: 'JoinClause',
  subquery,
  onKey,
  joinType,
});

export const OrderBy = (field, descending) => ({
  type: 'OrderBy',
  field,
  descending,
});

// ── Query-level nodes ─────────────────────────────────────────

export const SelectQuery = (overrides = {}) => ({
  type: 'SelectQuery',
  dataSource: EventType(['Log']),
  bindings: [],
  select: [],
  where: [],
  facet: [],
  join: null,
  orderBy: null,
  limit: null,
  timeseries: null,
  predict: false,
  since: null,
  until: null,
  warnings: [],
  unsupported: [],
  errors: [],
  /** @type {boolean} internal: true after stats/dedup/top/rare set aggregation mode */
  _hasAggregation: false,
  /** @type {boolean} internal: true when a head/tail ran between two aggregations (→ unsupported) */
  _headBetweenAgg: false,
  /** @type {Object|undefined} internal: fillnull default-value map, consumed during IR build */
  _fillnullMap: undefined,
  /** @type {Map<string,string>|undefined} internal: field rename map, consumed during IR build */
  _fieldReplacements: undefined,
  /** @type {Set<string>|undefined} internal: bin _time alias names, stripped from FACET when TIMESERIES present */
  _timeBucketAliases: undefined,
  /** @type {Array<{direction:string,affix:string,beforeNames:Set<string>}>|undefined} internal: pending wildcard-rename markers, consumed post-loop by applyWildcardRenames */
  _wildcardRenames: undefined,
  ...overrides,
});
