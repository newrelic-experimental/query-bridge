/**
 * nr-query-bridge — Multi-language query translator.
 */

// V1 translator (current)
export { translateSplToNrql, parseSplTime } from './input/spl/spl.js';

// V2 translator (IR-based, in development)
export { translateSplToNrqlV2 } from './translateV2.js';

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
