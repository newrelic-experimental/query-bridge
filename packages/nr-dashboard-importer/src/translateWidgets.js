import { translateSplToNrql } from '@newrelic/query-bridge';
import { EMITTABLE_VIZ_TYPES } from './emitTerraform.js';

/**
 * @typedef {import('./model.js').Widget} Widget
 * @typedef {Widget & {outcome:'clean', nrql:string, warnings:string[]}} CleanWidget
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

/**
 * Translate every widget's SPL. Clean/warnings-only widgets get NRQL attached;
 * unsupported/errors become markdown placeholders that preserve the original SPL.
 * Phase 1: baseRef is always null (no base/post-process resolution yet).
 *
 * @param {Widget[]} widgets
 * @returns {(CleanWidget|PlaceholderWidget)[]}
 */
export function translateWidgets(widgets) {
  return widgets.map((widget) => {
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
    return {
      ...widget,
      outcome: 'clean',
      nrql: result.nrql,
      warnings: result.warnings,
    };
  });
}
