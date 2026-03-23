/**
 * SPL → NRQL translator entry point.
 *
 * SPL string → parse → IR → optimize → emit → NRQL string
 */
import * as parser from './input/spl/splParser.js';
import { translateAstToIR } from './input/spl/splToIR.js';
import { emitQuery } from './output/nrql/irToNrql.js';

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

  // TODO: Optimization pass goes here
  // const optimized = optimize(ir);

  // When a query is fully unsupported with no meaningful output,
  // return empty string
  if (
    ir.unsupported.length > 0 &&
    ir.select.length === 0 &&
    !ir.where &&
    ir.bindings.length === 0 &&
    !ir.join &&
    ir.facet.length === 0
  ) {
    return {
      nrql: '',
      warnings: ir.warnings,
      unsupported: ir.unsupported,
      errors: ir.errors,
    };
  }

  // Pass 2: IR → NRQL string
  const nrql = emitQuery(ir);

  return {
    nrql,
    warnings: ir.warnings,
    unsupported: ir.unsupported,
    errors: ir.errors,
  };
}
