/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * nr-query-bridge — Multi-language query translator.
 */

/**
 * Re-exported public types.
 * @typedef {import('./translate.js').TranslateResult} TranslateResult
 * @typedef {import('./ir/nodes.js').IRNode} IRNode
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
