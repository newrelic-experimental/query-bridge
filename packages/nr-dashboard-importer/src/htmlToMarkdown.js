import TurndownService from 'turndown';

// One configured turndown instance, reused across calls. Use ATX headings
// (`# H`) and strip non-content elements so a Splunk <head><style>…</style>
// block never renders as literal CSS text. Links use turndown's default — `[text](href)` for
// every scheme — because New Relic's markdown renderer is the display-time
// sanitizer; the importer does no scheme filtering. See
// .claude/references/nrql-reference.md, "Markdown (text) widgets."
const service = new TurndownService({ headingStyle: 'atx' });
service.remove(['style', 'script', 'head', 'noscript']);

/**
 * Convert a Splunk Simple XML <html> panel body to Markdown for an NR markdown
 * widget. Returns '' when there is no visible content (empty, whitespace-only,
 * CSS/script-only, or non-string) — the caller drops such panels rather than
 * emitting an empty widget.
 *
 * @param {string} html raw inner HTML of an <html> panel
 * @returns {string} Markdown, trimmed; '' when there is nothing to show
 */
export function htmlToMarkdown(html) {
  if (typeof html !== 'string' || html.trim() === '') return '';
  return service.turndown(html).trim();
}
