/**
 * Wildcard rename (`rename <prefix>.* as *`) → scoped prefix rewrite (Option C).
 *
 * NRQL has no bulk-rename and the translator has no schema context, so a faithful
 * expansion is impossible. Instead we treat a clean single-affix wildcard rename as
 * a downstream field-replacement rule and register it into ir._fieldReplacements,
 * but ONLY for bare references that are provably safe to rewrite (see
 * applyWildcardRenames). Anything ambiguous stays a loud `unsupported`.
 */

/**
 * Recognize a clean single-affix wildcard rename.
 * @param {string} from
 * @param {string} to
 * @returns {{ direction: 'strip', affix: string } | null}
 */
export function recognizeWildcardRename(from, to) {
  const fromStars = (from.match(/\*/g) || []).length;
  // Leading-prefix strip: `<affix>.* as *` — one trailing `*` in `from`, `to` is exactly `*`.
  if (to === '*' && fromStars === 1 && from.endsWith('*')) {
    const affix = from.slice(0, -1); // 'log.' from 'log.*'
    if (affix.length === 0) return null; // bare `* as *` — nothing to strip
    return { direction: 'strip', affix };
  }
  // (Task 3 adds the re-prefix shape `* as <affix>*` here.)
  return null;
}

/**
 * Every Identifier name referenced in the consumer surfaces, not crossing into
 * subqueries. Used both to snapshot pre-rename names (ambiguity guard) and to find
 * downstream candidates. Mirrors transform.js's enumerate-every-property walk.
 * @param {object} ir
 * @returns {Set<string>}
 */
export function collectRefs(ir) {
  const refs = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.type === 'Identifier') {
      refs.add(node.name);
      return;
    }
    if (node.type === 'SubqueryExpr' || node.type === 'SubquerySource') return;
    for (const key of Object.keys(node)) {
      if (key !== 'type') visit(node[key]);
    }
  };
  for (const s of ir.select) visit(s);
  for (const w of ir.where) visit(w);
  for (const f of ir.facet) visit(f);
  if (ir.orderBy) visit(ir.orderBy);
  for (const b of ir.bindings) visit(b.expr);
  return refs;
}
