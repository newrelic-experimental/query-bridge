/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SPL → NRQL translator entry point.
 *
 * SPL string → parse → IR → optimize → emit → NRQL string
 */

import * as parser from './input/spl/splParser.js';
import { translateAstToIR } from './input/spl/splToIR.js';
import { emitQuery } from './output/nrql/irToNrql.js';
import { optimize } from './ir/optimize.js';
import { messages } from './messages.js';
import { normalizePreview } from './previewFlags.js';

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
 * `options.preview` opts in to NRQL Limited Preview syntax (see
 * `previewFlags.js`). Every gate defaults to off, so calling with one argument
 * — as every caller did before gating existed — produces byte-identical output.
 *
 * @param {string} spl - The SPL query string.
 * @param {import('./previewFlags.js').TranslateOptions} [options] - Opt-in NRQL Beta gates.
 * @returns {TranslateResult} The NRQL plus any warnings/unsupported/errors.
 */
export function translateSplToNrql(spl, options = {}) {
  const preview = normalizePreview(options);

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
      const stage = stageAt(spl, e.location.start.offset);
      if (stage) msg += ` in stage '${stage}'`;
    }
    msg += `: ${e.message}`;
    return { nrql: '', warnings: [], unsupported: [], errors: [msg] };
  }

  // Pass 1: SPL AST → IR
  const ir = translateAstToIR(ast, preview);

  // Pass 2: Optimize IR (gates ride on the IR; see previewFlags.js)
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

  // AI-DEV: Contract — an empty `nrql` MUST carry a reason in `unsupported` or
  // `errors`. Callers classify on those arrays; empty-with-no-reason is
  // untriageable. Do NOT remove this guard; fix the path that produced it.
  if (!nrql || !nrql.trim()) {
    return {
      nrql: '',
      warnings,
      unsupported,
      errors: [messages.empty_translation_internal()],
    };
  }

  return { nrql, warnings, unsupported, errors };
}

/**
 * The pipeline stage (text between top-level `|`s) containing `offset`, trimmed
 * and truncated — so a parse error names the construct that failed. Pipes inside
 * quotes or [subsearch] brackets do not split stages.
 *
 * @param {string} spl
 * @param {number} offset
 * @returns {string|null}
 */
function stageAt(spl, offset) {
  let start = 0;
  let quote = null;
  let depth = 0;
  for (let i = 0; i <= spl.length; i++) {
    const ch = spl[i];
    if (i === spl.length || (ch === '|' && !quote && depth === 0)) {
      if (offset >= start && offset <= i) {
        const stage = spl.slice(start, i).trim();
        if (!stage) return null;
        return stage.length > 80 ? `${stage.slice(0, 77)}...` : stage;
      }
      start = i + 1;
      continue;
    }
    if (ch === '\\') {
      i++;
    } else if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']' && depth > 0) {
      depth--;
    }
  }
  return null;
}
