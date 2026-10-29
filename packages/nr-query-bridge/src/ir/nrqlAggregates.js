/**
 * Canonical set of NRQL aggregate function names.
 *
 * A single source of truth shared by the two places that need to recognize an
 * aggregate in the emitted-NRQL namespace (i.e. AFTER the SPL→NRQL function
 * mapping in handleStats — `avg`→`average`, `dc`→`uniqueCount`, …):
 *   - foldPostAggregation.js — deciding whether a projected column is an aggregate
 *     when collapsing post-aggregation subquery chains.
 *   - rowHandlers.js (handleSort) — deciding whether a faceted SELECT exposes an
 *     aggregate, so an ORDER BY on it is the render-failing faceted-aggregation case.
 *
 * These previously drifted as two hand-maintained lists; this union is the merge.
 */
export const NRQL_AGGREGATE_FUNCS = new Set([
  'count',
  'sum',
  'average',
  'min',
  'max',
  'latest',
  'earliest',
  'uniqueCount',
  'median',
  'percentile',
  'stddev',
  'standarddeviation',
  'uniques',
  'rate',
  'histogram',
  'percentage',
]);
