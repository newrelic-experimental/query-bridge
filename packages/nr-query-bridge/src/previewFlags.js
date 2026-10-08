/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Caller opt-in for NRQL Limited Preview / Beta syntax.
 *
 * Every flag here corresponds to a per-account NRQL Beta feature flag. An
 * account without that flag REJECTS the syntax at compile time, so each gate
 * defaults to `false` and the translator emits its pre-existing (GA) form —
 * usually `unsupported`. Turning a flag on is an assertion by the caller that
 * the target account has the matching NRQL flag enabled.
 *
 * AI-DEV: Gates are read ONLY in `src/input/spl/**` and `optimize.js` passes —
 * the layer that DECIDES what to build. The emitter MUST stay flag-free: the
 * IR carries capability-neutral nodes that are only ever constructed when the
 * gate is on, and `irToNrql.js` emits whatever it is handed. Do NOT add a
 * `preview` parameter to `emitQuery`/`emitExpr`.
 *
 * The gates ride on the IR under a NON-ENUMERABLE `_preview`, seeded once by
 * `translateAstToIR` and read via {@link getPreview}. Rationale: the gated
 * constructs (`split`, `trim`, `mvfilter`, `mvmap`) live deep inside
 * `walkEvalExpr`, which has ~100 call sites across the handler files —
 * threading a parameter through all of them is large, high-risk churn through
 * subtle code, and a site missed in the plumbing silently reads "flags off".
 * Non-enumerable keeps the bag out of IR snapshots, `JSON.stringify`, and
 * structural equality, so it cannot leak into emitted output or test fixtures.
 *
 * AI-DEV: Any code that builds a NEW query level (`wrapAsSubquery`, a JOIN or
 * scalar subquery) MUST carry the bag over with {@link setPreview}, or that
 * level silently translates with every gate off while its parent has them on.
 * {@link getPreview} returns all-false for an un-seeded query, so the failure
 * mode is a missing feature, never invalid NRQL.
 */

/**
 * @typedef {object} PreviewFlags
 * @property {boolean} [expand] NRQL Beta `Expand` / `NrqlFlexibleWithExpand`:
 *   the `EXPAND <collection> AS <element>` clause, including EXPAND of a
 *   computed collection.
 * @property {boolean} [split] NRQL Beta `SplitFunction`: `split(str, delim)`.
 * @property {boolean} [trim] NRQL Beta `Trim`: `trim(str)` and
 *   `trim(str, 'LEADING'|'TRAILING'|'ALL')`.
 * @property {boolean} [arrayMaps] NRQL Beta `NrqlEvalArrayMaps`: array (`[a, b]`)
 *   and map (`{k: v}`) literals.
 * @property {boolean} [lambdas] NRQL Beta `NrqlLambdas`: `x -> expr` lambdas and
 *   the higher-order collection functions (`map`, `filter`, `reduce`, …).
 * @property {boolean} [facetEvaluables] NRQL Beta `NrqlFacetEvaluables`:
 *   `FACET <computed expression>`.
 */

/**
 * The caller-facing options bag for {@link translateSplToNrql}.
 *
 * @typedef {object} TranslateOptions
 * @property {PreviewFlags} [preview] Opt-in NRQL Beta syntax gates.
 */

/**
 * Every recognized preview flag name, in declaration order.
 *
 * Exported so the CLI can validate `--preview=<name>` without duplicating the
 * list.
 *
 * @type {readonly string[]}
 */
export const PREVIEW_FLAG_NAMES = Object.freeze([
  'expand',
  'split',
  'trim',
  'arrayMaps',
  'lambdas',
  'facetEvaluables',
]);

/**
 * Normalize a caller options bag into a frozen, fully-populated flag object, so
 * no downstream site needs `?? false` and no handler can accidentally mutate a
 * gate mid-translation.
 *
 * Unknown keys are IGNORED rather than rejected: a consumer pinned to an older
 * version of this package must not crash on a config naming a flag it predates.
 *
 * @param {TranslateOptions} [options] - The caller's options, if any.
 * @returns {Readonly<Record<string, boolean>>} Every flag name, explicitly boolean.
 */
export function normalizePreview(options) {
  const requested = options?.preview ?? {};
  /** @type {Record<string, boolean>} */
  const flags = {};
  for (const name of PREVIEW_FLAG_NAMES) {
    flags[name] = requested[name] === true;
  }
  return Object.freeze(flags);
}

/** Every gate off — the shape {@link getPreview} falls back to. */
const NO_PREVIEW = normalizePreview(undefined);

/**
 * Attach the normalized gates to a query level, non-enumerably so they never
 * appear in an IR snapshot or emitted output.
 *
 * @param {object} query - A `SelectQuery` IR node.
 * @param {Readonly<Record<string, boolean>>} preview - Normalized gates.
 * @returns {object} The same query, for chaining.
 */
export function setPreview(query, preview) {
  if (!query) return query;
  Object.defineProperty(query, '_preview', {
    value: preview ?? NO_PREVIEW,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return query;
}

/**
 * Read the gates off a query level.
 *
 * Returns all-false when the query was never seeded, so a plumbing gap degrades
 * to "the preview feature did not fire" rather than to invalid NRQL.
 *
 * @param {object} [query] - A `SelectQuery` IR node.
 * @returns {Readonly<Record<string, boolean>>}
 */
export function getPreview(query) {
  return query?._preview ?? NO_PREVIEW;
}
