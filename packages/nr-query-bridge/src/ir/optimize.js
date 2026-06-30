/**
 * IR Optimization Pipeline.
 *
 * Composable passes that transform the IR tree between
 * AST→IR translation and NRQL emission.
 */
import { transformTree } from './transform.js';
import { Identifier, BinOp, Func, Literal, Wildcard } from './nodes.js';
import { foldPostAggregationPass } from './foldPostAggregation.js';
import { messages } from '../messages.js';

// ── Pass 1: Double-NOT elimination ──────────────────────────

function eliminateDoubleNot(ir) {
  return transformTree(ir, (node) => {
    if (node.type === 'Not' && node.child?.type === 'Not') {
      return node.child.child;
    }
    return node;
  });
}

// ── Pass 2: Constant folding ────────────────────────────────

const ARITHMETIC_OPS = {
  '+': (l, r) => l + r,
  '-': (l, r) => l - r,
  '*': (l, r) => l * r,
  '/': (l, r) => (r !== 0 ? l / r : null),
  '%': (l, r) => (r !== 0 ? l % r : null),
};

function foldConstants(ir) {
  return transformTree(ir, (node) => {
    if (node.type !== 'BinOp') return node;
    if (node.left?.type !== 'Literal' || node.left.kind !== 'number')
      return node;
    if (node.right?.type !== 'Literal' || node.right.kind !== 'number')
      return node;

    const op = ARITHMETIC_OPS[node.op];
    if (!op) return node;

    const result = op(node.left.value, node.right.value);
    if (result == null) return node;

    return { type: 'Literal', value: result, kind: 'number' };
  });
}

// ── Pass 3: Tautology/contradiction elimination ─────────────

function eliminateTautologies(ir) {
  const isTrue = (n) =>
    n?.type === 'Literal' && n.kind === 'boolean' && n.value === true;
  const isFalse = (n) =>
    n?.type === 'Literal' && n.kind === 'boolean' && n.value === false;

  return transformTree(ir, (node) => {
    if (node.type !== 'BinOp') return node;

    if (node.op === 'AND' && isTrue(node.right)) return node.left;
    if (node.op === 'AND' && isTrue(node.left)) return node.right;
    if (node.op === 'OR' && isFalse(node.right)) return node.left;
    if (node.op === 'OR' && isFalse(node.left)) return node.right;

    return node;
  });
}

// ── Pass 4: Fillnull substitution ───────────────────────────

function applyFillnull(ir) {
  if (!ir._fillnullMap) return ir;
  const map = ir._fillnullMap;
  const substituted = new Set();

  const walked = transformTree(ir, (node) => {
    if (node.type === 'Identifier' && map[node.name]) {
      substituted.add(node.name);
      return BinOp('OR', node, map[node.name]);
    }
    return node;
  });

  const unreferenced = Object.entries(map).filter(([f]) => !substituted.has(f));
  if (unreferenced.length > 0) {
    const fillExprs = unreferenced.map(([field, litValue]) =>
      BinOp('OR', Identifier(field), litValue),
    );
    const rest = walked.select.length === 0 ? [Wildcard()] : walked.select;
    walked.select = [...fillExprs, ...rest];
  }

  delete walked._fillnullMap;
  return walked;
}

// ── Pass 5: Field replacement substitution ──────────────────

function applyFieldReplacements(ir) {
  if (!ir._fieldReplacements) return ir;
  const map = ir._fieldReplacements;
  const substituted = new Set();

  const walked = transformTree(ir, (node) => {
    if (node.type === 'Identifier' && map[node.name]) {
      substituted.add(node.name);
      return map[node.name];
    }
    return node;
  });

  const unreferenced = Object.entries(map).filter(([f]) => !substituted.has(f));
  if (unreferenced.length > 0) {
    const rest = walked.select.length === 0 ? [Wildcard()] : walked.select;
    walked.select = [...unreferenced.map(([, expr]) => expr), ...rest];
  }

  delete walked._fieldReplacements;
  return walked;
}

// ── Pass 6: Dual-check expansion ────────────────────────────

function expandDualChecks(ir) {
  return transformTree(ir, (node) => {
    if (node.type !== 'DualCheck') return node;
    const { field, op, value } = node;
    const strCompare = BinOp(op, field, Literal(String(value.value), 'string'));
    const numCompare = BinOp(op, Func('numeric', [field]), value);
    const joinOp = op === '=' ? 'OR' : 'AND';
    return BinOp(joinOp, strCompare, numCompare);
  });
}

// ── Pass 7: Template-variable-in-subquery detection ─────────
// A dashboard template variable ({{var}}) is substituted by New Relic's interpolator
// only at the OUTER query level — never inside a `FROM (subquery …)`. A {{var}} that
// the post-aggregation fold pushed into a SubquerySource therefore reaches NRDB
// unbound and the widget fails to render ("undefined template variable"), even though
// the console / NerdGraph accept it. Detect it and fail loud rather than emit the
// render-failing query. (Hoisting a hoistable pre-aggregation filter to the outer —
// only valid when its field is an exposed facet key — is a deferred follow-up.)

/** True if any Identifier/Like under `node` is a {{template var}}. */
function hasTemplateVar(node) {
  if (!node || typeof node !== 'object') return false;
  if (
    node.type === 'Identifier' &&
    typeof node.name === 'string' &&
    node.name.startsWith('{{')
  ) {
    return true;
  }
  if (
    node.type === 'Like' &&
    typeof node.pattern === 'string' &&
    node.pattern.startsWith('{{')
  ) {
    return true;
  }
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) {
      if (v.some(hasTemplateVar)) return true;
    } else if (v && typeof v === 'object' && hasTemplateVar(v)) {
      return true;
    }
  }
  return false;
}

/** True if a {{template var}} sits inside any SubquerySource's inner query. */
function hasTemplateVarInSubquery(ir) {
  let found = false;
  const walk = (node) => {
    if (found || !node || typeof node !== 'object') return;
    if (
      node.type === 'SubquerySource' &&
      node.query &&
      hasTemplateVar(node.query)
    ) {
      found = true;
      return;
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(ir);
  return found;
}

// Field a simple predicate filters on (the side that is NOT the {{var}}): a BinOp's
// left Identifier, or a Like's field. null when the shape isn't a simple field filter.
function fieldNameOf(cond) {
  if (cond?.type === 'BinOp' && cond.left?.type === 'Identifier') {
    return cond.left.name;
  }
  if (cond?.type === 'Like') {
    return cond.field?.type === 'Identifier'
      ? cond.field.name
      : (cond.field ?? null);
  }
  return null;
}

// Rescue hoistable {{var}} predicates from the TOP-LEVEL subquery: a {{var}} filter
// whose field is an exposed inner facet key commutes with the aggregation, so it can
// move to the outer ir.where (where NR substitutes {{var}}). Deeper-nested subqueries,
// non-facet fields, and {{var}}s outside a simple WHERE predicate are left in place
// (→ still flagged unsupported below).
function hoistFacetKeyTemplateVars(ir) {
  const ds = ir.dataSource;
  if (ds?.type !== 'SubquerySource' || !ds.query) return;
  const inner = ds.query;
  const facetNames = new Set(
    inner.facet.filter((f) => f.type === 'Identifier').map((f) => f.name),
  );
  const kept = [];
  for (const cond of inner.where) {
    const field = fieldNameOf(cond);
    if (hasTemplateVar(cond) && field && facetNames.has(field)) {
      ir.where.push(cond); // hoist to the outer WHERE — interpolator substitutes here
      ir.warnings.push(messages.template_var_hoisted(field));
    } else {
      kept.push(cond);
    }
  }
  inner.where = kept;
}

function detectTemplateVarInSubquery(ir) {
  if (!hasTemplateVarInSubquery(ir)) return ir;
  hoistFacetKeyTemplateVars(ir); // rescue facet-key {{var}} filters…
  if (hasTemplateVarInSubquery(ir)) {
    // …anything still stranded (non-facet field, deeper subquery, or a {{var}} outside
    // a simple WHERE predicate) has no faithful form → loud.
    ir.unsupported.push(messages.template_var_in_subquery());
  }
  return ir;
}

// ── Pipeline ────────────────────────────────────────────────

const passes = [
  eliminateDoubleNot,
  foldConstants,
  eliminateTautologies,
  expandDualChecks,
  foldPostAggregationPass, // ← collapse over-nested post-aggregation chains; catch-all unsupported
  applyFillnull,
  applyFieldReplacements,
  detectTemplateVarInSubquery, // ← render-fail guard: {{var}} stranded inside a subquery
];

export function optimize(ir) {
  return passes.reduce((node, pass) => pass(node), ir);
}
