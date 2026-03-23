/**
 * SPL → NRQL translator entry point.
 *
 * SPL string → parse → IR → optimize → emit → NRQL string
 */
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

  // Unsupported or errors → no NRQL output
  if (optimized.unsupported.length > 0 || optimized.errors.length > 0) {
    return {
      nrql: '',
      warnings: optimized.warnings,
      unsupported: optimized.unsupported,
      errors: optimized.errors,
    };
  }

  // Pass 3: IR → NRQL string
  const nrql = emitQuery(optimized);

  return {
    nrql,
    warnings: optimized.warnings,
    unsupported: optimized.unsupported,
    errors: optimized.errors,
  };
}
