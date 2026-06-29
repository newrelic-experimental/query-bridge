import { translateSplToNrql } from '@newrelic/query-bridge';
import { EMITTABLE_VIZ_TYPES } from './emitTerraform.js';

/**
 * @typedef {import('./model.js').Widget} Widget
 * @typedef {Widget & {outcome:'clean', nrql?:string, markdownText?:string, warnings:string[]}} CleanWidget
 * @typedef {Widget & {outcome:'placeholder', vizType:'markdown', placeholderText:string, warnings:string[]}} PlaceholderWidget
 */

/**
 * Build the markdown body for a placeholder widget: title, original SPL fenced,
 * the reason, and partial NRQL ONLY if the translator produced some. Per the
 * project's error/unsupported rule, omit the NRQL section entirely when nrql === ''.
 *
 * @param {Widget} widget
 * @param {{nrql:string, unsupported:string[], errors:string[]}} result
 * @returns {string}
 */
function placeholderBody(widget, result) {
  const reasons = [...result.unsupported, ...result.errors];
  let body = `### ${widget.title || '(untitled panel)'}\n\n`;
  body += `**This panel could not be translated automatically.**\n\n`;
  body += `Original SPL:\n\n\`\`\`\n${widget.rawSpl}\n\`\`\`\n\n`;
  body += `Unsupported/errors:\n\n`;
  for (const r of reasons) body += `- ${r}\n`;
  if (result.nrql) {
    body += `\nPartial — unverified NRQL:\n\n\`\`\`sql\n${result.nrql}\n\`\`\`\n`;
  }
  return body;
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * New Relic expands a multi-selection variable to a comma list (`'a', 'b'`), so a
 * `field = {{tok}}` comparison must become `field IN ({{tok}})` — otherwise the
 * substituted NRQL (`field = 'a', 'b'`) is invalid. Rewrites only the named
 * multiselect tokens; bare-term and non-comparison uses are left untouched.
 *
 * @param {string} nrql
 * @param {Set<string>} multiSelectTokens
 * @returns {string}
 */
function rewriteMultiSelectComparisons(nrql, multiSelectTokens) {
  let out = nrql;
  for (const tok of multiSelectTokens) {
    const re = new RegExp(
      '(`[^`]+`|[A-Za-z_][\\w.]*)\\s*=\\s*\\{\\{' +
        escapeRegExp(tok) +
        '\\}\\}',
      'g',
    );
    out = out.replace(re, `$1 IN ({{${tok}}})`);
  }
  return out;
}

/**
 * Translate every widget's SPL. Clean/warnings-only widgets get NRQL attached;
 * unsupported/errors become markdown placeholders that preserve the original SPL.
 *
 * @param {Widget[]} widgets
 * @param {{multiSelectTokens?: Set<string>}} [opts] multiselect variable tokens
 *   whose `= {{tok}}` comparisons are rewritten to `IN ({{tok}})`.
 * @returns {(CleanWidget|PlaceholderWidget)[]}
 */
export function translateWidgets(widgets, opts = {}) {
  const multiSelectTokens = opts.multiSelectTokens ?? new Set();
  return widgets.map((widget) => {
    // Literal-markdown widgets carry their body in `options.text` (e.g. a Studio
    // image rendered as `![](url)`) and have no SPL. Emit the text as a CLEAN
    // markdown widget — there is nothing to translate. Native `splunk.markdown`
    // panels without `options.text` fall through to the placeholder path below.
    if (
      widget.vizType === 'markdown' &&
      typeof widget.options?.text === 'string' &&
      widget.options.text !== ''
    ) {
      return {
        ...widget,
        outcome: 'clean',
        markdownText: widget.options.text,
        warnings: [],
      };
    }

    // Pre-translation placeholders: a parser-flagged unsupported widget (e.g. an
    // event/map panel, or an unresolvable base search) or an empty query cannot
    // produce a clean widget. Placeholder loudly rather than translate '' into a
    // silent `FROM Log SELECT *`.
    const preReason =
      widget.unsupportedReason ||
      (widget.rawSpl.trim() === ''
        ? 'empty query — no SPL to translate'
        : null);
    if (preReason) {
      return {
        ...widget,
        vizType: 'markdown',
        outcome: 'placeholder',
        placeholderText: placeholderBody(widget, {
          nrql: '',
          unsupported: [preReason],
          errors: [],
        }),
        warnings: [],
      };
    }

    const result = translateSplToNrql(widget.rawSpl);
    const failed = result.unsupported.length > 0 || result.errors.length > 0;
    if (failed) {
      return {
        ...widget,
        vizType: 'markdown',
        outcome: 'placeholder',
        placeholderText: placeholderBody(widget, result),
        warnings: result.warnings,
      };
    }
    // The SPL translated, but the viz type has no New Relic widget block
    // (scatter, map, unknown). Placeholder it — keeping the valid NRQL as a
    // partial — rather than emit an invalid block. EMITTABLE_VIZ_TYPES is the
    // single source of truth, shared with the emitter.
    if (!EMITTABLE_VIZ_TYPES.has(widget.vizType)) {
      return {
        ...widget,
        vizType: 'markdown',
        outcome: 'placeholder',
        placeholderText: placeholderBody(widget, {
          nrql: result.nrql,
          unsupported: [`no New Relic equivalent for ${widget.vizType} charts`],
          errors: [],
        }),
        warnings: result.warnings,
      };
    }
    const finalNrql = multiSelectTokens.size
      ? rewriteMultiSelectComparisons(result.nrql, multiSelectTokens)
      : result.nrql;
    // A no-aggregate `SELECT *` (raw events) has nothing to plot in a chart or
    // billboard widget — only a table renders raw events; a bar/line/billboard/pie
    // shows blank. Route it to a table regardless of the Splunk viz type. This is at
    // least as faithful as Splunk, whose charts also cannot plot a non-transforming
    // search (raw events go to Splunk's events list, not a chart).
    const warnings = [...result.warnings];
    let vizType = widget.vizType;
    if (
      /\bSELECT \*(?:\s|,|$)/.test(finalNrql) &&
      vizType !== 'table' &&
      vizType !== 'markdown'
    ) {
      warnings.push(
        `raw-events (SELECT *) query routed to a table widget; a ${vizType} widget renders blank for a non-aggregate query`,
      );
      vizType = 'table';
    }
    return {
      ...widget,
      vizType,
      outcome: 'clean',
      nrql: finalNrql,
      warnings,
    };
  });
}
