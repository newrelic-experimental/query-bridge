import { translateSplToNrql } from '@newrelic/query-bridge';

/**
 * @typedef {import('./model.js').Variable} Variable
 */

/**
 * The single FACET field of a NRQL query, or null when it has zero or several.
 * (`FACET host` → "host"; `FACET host, region` → null.)
 *
 * @param {string} nrql
 * @returns {string|null}
 */
export function singleFacetField(nrql) {
  const m = /\bFACET\s+(.+?)(?:\s+(?:SINCE|UNTIL|LIMIT|TIMESERIES)\b|$)/i.exec(
    nrql,
  );
  if (!m) return null;
  const fields = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fields.length === 1 ? fields[0] : null;
}

/**
 * Resolve search-backed dropdowns into New Relic-native variables. A dropdown
 * whose source SPL reduces to ONE faceted field becomes a `type="nrql"` variable
 * — New Relic populates the dropdown from that facet's values, which is the
 * provider's canonical variable shape (`SELECT … FACET field`). Anything else
 * degrades safely and never emits an invalid empty enum:
 *   - multi-field / untranslatable, but has static choices → keep the enum;
 *   - multi-field / untranslatable, no choices → free-text string variable.
 *
 * Static enums and text variables (no sourceQuery) pass through untouched.
 *
 * @param {Variable[]} variables
 * @returns {Variable[]}
 */
export function translateVariables(variables) {
  return variables.map((v) => {
    if (v.type !== 'enum' || !v.sourceQuery) return v;
    const result = translateSplToNrql(v.sourceQuery);
    const clean = result.unsupported.length === 0 && result.errors.length === 0;
    const facet = clean ? singleFacetField(result.nrql) : null;
    if (facet) return { ...v, type: 'nrql', sourceQuery: result.nrql };
    if (v.choices.length > 0) return { ...v, sourceQuery: null };
    return { ...v, type: 'string', sourceQuery: null };
  });
}
