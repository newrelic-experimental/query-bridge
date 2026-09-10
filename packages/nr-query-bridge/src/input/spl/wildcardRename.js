/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wildcard rename (`rename <prefix>.* as *`) → scoped prefix rewrite (Option C).
 *
 * NRQL has no bulk-rename and the translator has no schema context, so a faithful
 * expansion is impossible. Instead we treat a clean single-affix wildcard rename as
 * a downstream field-replacement rule and register it into ir._fieldReplacements,
 * but ONLY for bare references that are provably safe to rewrite (see
 * applyWildcardRenames). Anything ambiguous stays a loud `unsupported`.
 */
import { Identifier } from '../../ir/nodes.js';
import { messages } from '../../messages.js';

/**
 * Recognize a clean single-affix wildcard rename.
 * @param {string} from
 * @param {string} to
 * @returns {{ direction: 'strip'|'reprefix', affix: string } | null}
 */
export function recognizeWildcardRename(from, to) {
  const fromStars = (from.match(/\*/g) || []).length;
  // Leading-prefix strip: `<affix>.* as *` — one trailing `*` in `from`, `to` is exactly `*`.
  if (to === '*' && fromStars === 1 && from.endsWith('*')) {
    const affix = from.slice(0, -1); // 'log.' from 'log.*'
    if (affix.length === 0) return null; // bare `* as *` — nothing to strip
    return { direction: 'strip', affix };
  }
  // Re-prefix: `* as <affix>*` — `from` is exactly `*`, `to` has one trailing `*`.
  const toStars = (to.match(/\*/g) || []).length;
  if (from === '*' && toStars === 1 && to.endsWith('*')) {
    const affix = to.slice(0, -1); // 'fld_' from 'fld_*'
    if (affix.length === 0) return null; // bare `* as *`
    return { direction: 'reprefix', affix };
  }
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

/**
 * Consume the ir._wildcardRenames markers (post-pipeline). For the strip shape,
 * register `<bare> → <affix><bare>` into ir._fieldReplacements for each downstream
 * bare reference that is eligible (appears nowhere except downstream, and is not a
 * binding/alias). Loud `unsupported` for >1 marker or an ambiguous (also-pre-rename)
 * reference; drop-with-warning when nothing eligible references the rename.
 * @param {object} ir
 */
export function applyWildcardRenames(ir) {
  const marks = ir._wildcardRenames;
  if (!marks || marks.length === 0) return;
  if (marks.length > 1) {
    ir.unsupported.push(messages.wildcard_rename_multiple());
    return;
  }
  const mark = marks[0];

  // Names bound by a real computed column — never rewritten (they are not the
  // stripped form of a wildcard-matched field).
  const bound = new Set();
  for (const s of ir.select) if (s.type === 'Alias') bound.add(s.name);
  for (const b of ir.bindings) bound.add(b.name);
  for (const f of ir.facet) if (f.type === 'Alias') bound.add(f.name);

  const downstream = collectRefs(ir);
  const candidates = [...downstream].filter((n) => isAffixCandidate(n, mark));

  // Ambiguity guard FIRST (bail before any partial rewrite): a candidate that also
  // existed before the rename could be a real top-level field as well as the stripped
  // form — never guess.
  for (const n of candidates) {
    if (!bound.has(n) && mark.beforeNames.has(n)) {
      ir.unsupported.push(messages.wildcard_rename_ambiguous(n));
      return;
    }
  }

  const replacements = {};
  for (const n of candidates) {
    if (bound.has(n)) continue; // a real computed column — leave as-is
    replacements[n] = Identifier(affixTarget(n, mark));
  }
  if (Object.keys(replacements).length === 0) {
    ir.warnings.push(messages.wildcard_rename_dropped(mark.affix));
    return;
  }
  ir._fieldReplacements = ir._fieldReplacements || {};
  Object.assign(ir._fieldReplacements, replacements);
}

/** strip: every bare name maps. reprefix: only affixed names map back. */
function isAffixCandidate(name, mark) {
  if (mark.direction === 'strip') return true;
  return name.startsWith(mark.affix); // reprefix
}

/** strip: `level` → `log.level`. reprefix: `fld_level` → `level`. */
function affixTarget(name, mark) {
  if (mark.direction === 'strip') return mark.affix + name;
  return name.slice(mark.affix.length); // reprefix
}
