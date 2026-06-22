/**
 * Build a per-dashboard coverage report (markdown). Counts clean/warned/
 * placeholder widgets and lists placeholder reasons. States the honest caveat
 * that emitted HCL is syntactically valid, not a guaranteed-working dashboard.
 *
 * @param {string} title
 * @param {{title:string, outcome:'clean'|'placeholder', warnings:string[], placeholderText?:string}[]} translated
 * @returns {string}
 */
export function buildReport(title, translated) {
  const total = translated.length;
  const placeholders = translated.filter((w) => w.outcome === 'placeholder');
  const clean = translated.filter((w) => w.outcome === 'clean');
  const warned = clean.filter((w) => w.warnings.length > 0);

  let md = `# Import report: ${title}\n\n`;
  md += `${total} widgets — ${clean.length} clean, ${warned.length} warned, ${placeholders.length} placeholder.\n\n`;

  if (warned.length > 0) {
    md += `## Warnings\n\n`;
    for (const w of warned) {
      md += `- **${w.title}**: ${w.warnings.join('; ')}\n`;
    }
    md += `\n`;
  }

  if (placeholders.length > 0) {
    md += `## Placeholders (could not translate)\n\n`;
    for (const w of placeholders) {
      md += `- **${w.title}**\n`;
    }
    md += `\n`;
  }

  md += `---\n\n`;
  md += `_Note: emitted Terraform is syntactically valid HCL; this does not guarantee a working New Relic dashboard. Widget NRQL correctness is proven separately (the deferred validation phase). Review placeholders and warnings before applying._\n`;

  return md;
}
