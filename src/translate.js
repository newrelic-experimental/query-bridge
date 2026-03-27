/**
 * SPL → NRQL translator entry point.
 *
 * SPL string → parse → IR → optimize → emit → NRQL string
 */

// TODO: Extract all warning/unsupported/error messages into src/messages.js
//
// Goals:
//   1. Single catalog of all user-facing messages, readable in one place
//   2. Each message has a key, a template function, and a doc comment with example SPL
//   3. Tests reference message keys so changing wording doesn't break tests
//   4. Full message text still visible in test output for human review
//
// Design:
//   export const messages = {
//     // example: `* | stats count as total | appendcols [search * | stats count by host]`
//     // Main query groups by nothing, subsearch groups by host — can't merge.
//     facet_mismatch: (label, main, sub) =>
//       `${label} with subsearch has mismatched FACET: main groups by ${main}, subsearch groups by ${sub}`,
//
//     // example: `* | mvexpand perms`
//     // NRQL cannot expand multivalue fields into rows.
//     mvexpand_unsupported: (field) =>
//       `mvexpand ${field} is not supported; NRQL cannot expand multivalue fields into separate rows`,
//     ...
//   };
//
// Migration: update each handler to use messages.key(...args), update tests to
//   use messages.key(...) or a helper that checks the key + renders the full string.
// No external i18n library needed — plain template functions are sufficient.
import * as parser from './input/spl/splParser.js';
import { translateAstToIR } from './input/spl/splToIR.js';
import { emitQuery } from './output/nrql/irToNrql.js';
import { optimize } from './ir/optimize.js';

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
