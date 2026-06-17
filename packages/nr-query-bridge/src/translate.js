/**
 * SPL → NRQL translator entry point.
 *
 * SPL string → parse → IR → optimize → emit → NRQL string
 */

import * as parser from './input/spl/splParser.js';
import { translateAstToIR } from './input/spl/splToIR.js';
import { emitQuery } from './output/nrql/irToNrql.js';
import { optimize } from './ir/optimize.js';

/**
 * The result of translating an SPL query to NRQL.
 *
 * When `unsupported` or `errors` is non-empty, `nrql` is an empty string —
 * the translator emits no NRQL rather than risk returning a wrong query.
 *
 * @typedef {object} TranslateResult
 * @property {string} nrql - The translated NRQL query, or '' if untranslatable.
 * @property {string[]} warnings - Precision-loss / advisory notes; NRQL is still valid.
 * @property {string[]} unsupported - Reasons a construct has no NRQL equivalent.
 * @property {string[]} errors - Parse or translation errors.
 */

/**
 * Translate a Splunk SPL query into New Relic NRQL.
 *
 * @param {string} spl - The SPL query string.
 * @returns {TranslateResult} The NRQL plus any warnings/unsupported/errors.
 */
export function translateSplToNrql(spl) {
  if (!spl || !spl.trim()) {
    return {
      nrql: 'FROM Log SELECT *',
      warnings: [],
      unsupported: [],
      errors: [],
    };
  }

  // Strip YAML multiline indicators
  spl = spl.replace(/^>-?\s*\n/, '');

  let ast;
  try {
    ast = parser.parse(spl);
  } catch (e) {
    let msg = 'Failed to parse SPL';
    if (e.location) {
      msg += ` at line ${e.location.start.line}:${e.location.start.column}`;
    }
    msg += `: ${e.message}`;
    return { nrql: '', warnings: [], unsupported: [], errors: [msg] };
  }

  // Pass 1: SPL AST → IR
  const ir = translateAstToIR(ast);

  // Pass 2: Optimize IR
  const optimized = optimize(ir);

  // Deduplicate messages (multiple commands can produce the same warning)
  const warnings = [...new Set(optimized.warnings)];
  const unsupported = [...new Set(optimized.unsupported)];
  const errors = [...new Set(optimized.errors)];

  // Unsupported or errors → no NRQL output
  if (unsupported.length > 0 || errors.length > 0) {
    return { nrql: '', warnings, unsupported, errors };
  }

  // Pass 3: IR → NRQL string
  const nrql = emitQuery(optimized);

  return { nrql, warnings, unsupported, errors };
}
