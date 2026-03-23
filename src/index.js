/**
 * nr-query-bridge — Multi-language query translator.
 */

// SPL → NRQL translator
export { translateSplToNrql } from './translate.js';

// Time parsing utility
export { parseSplTime } from './input/spl/splTime.js';

// IR node constructors
export * from './ir/nodes.js';

// NRQL emitter
export { emitQuery, emitExpr } from './output/nrql/irToNrql.js';

// Encoding utilities
export {
  escapeAttributeNameForNrql,
  escapeStringLiteralForNrql,
  escapeStringWildcardForNrql,
} from './output/nrql/nrqlEncoding.js';
