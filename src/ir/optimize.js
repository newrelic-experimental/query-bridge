/**
 * IR Optimization Pipeline.
 *
 * Composable passes that transform the IR tree between
 * AST→IR translation and NRQL emission.
 */
import { transformTree } from './transform.js';
import { Identifier, BinOp, Func, Literal, Wildcard } from './nodes.js';

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

// ── Pipeline ────────────────────────────────────────────────

const passes = [
  eliminateDoubleNot,
  foldConstants,
  eliminateTautologies,
  expandDualChecks,
  applyFillnull,
  applyFieldReplacements,
];

export function optimize(ir) {
  return passes.reduce((node, pass) => pass(node), ir);
}
