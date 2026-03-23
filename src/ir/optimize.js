/**
 * IR Optimization Pipeline.
 *
 * Composable passes that transform the IR tree between
 * AST→IR translation and NRQL emission.
 */
import { transformTree } from './transform.js';

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

// ── Pipeline ────────────────────────────────────────────────

const passes = [eliminateDoubleNot, foldConstants, eliminateTautologies];

export function optimize(ir) {
  return passes.reduce((node, pass) => pass(node), ir);
}
