/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { transformTree } from '../../src/ir/transform.js';
import {
  Identifier,
  Literal,
  BinOp,
  Not,
  Func,
  Alias,
  IsNull,
  Like,
  In,
  Rlike,
  Wildcard,
  Regex,
  RawNrql,
  SelectQuery,
  SubqueryExpr,
  SubquerySource,
  Binding,
  OrderBy,
  DualCheck,
} from '../../src/ir/nodes.js';

describe('transformTree', () => {
  it('returns null/undefined unchanged', () => {
    expect(transformTree(null, () => 'replaced')).toBe(null);
    expect(transformTree(undefined, () => 'replaced')).toBe(undefined);
  });

  it('identity transform returns equivalent tree', () => {
    const tree = BinOp('AND', Identifier('a'), Literal('b', 'string'));
    const result = transformTree(tree, (node) => node);
    expect(result).toEqual(tree);
  });

  it('transforms leaf Identifier nodes', () => {
    const tree = Identifier('old');
    const result = transformTree(tree, (node) => {
      if (node.type === 'Identifier' && node.name === 'old') {
        return Identifier('new');
      }
      return node;
    });
    expect(result).toEqual(Identifier('new'));
  });

  it('transforms bottom-up (children before parents)', () => {
    const order = [];
    const tree = BinOp('AND', Identifier('a'), Identifier('b'));
    transformTree(tree, (node) => {
      order.push(node.type === 'Identifier' ? node.name : node.type);
      return node;
    });
    expect(order).toEqual(['a', 'b', 'BinOp']);
  });

  it('transforms nested BinOp children', () => {
    const tree = BinOp(
      'AND',
      BinOp('OR', Identifier('a'), Identifier('b')),
      Identifier('c'),
    );
    const result = transformTree(tree, (node) => {
      if (node.type === 'Identifier')
        return Identifier(node.name.toUpperCase());
      return node;
    });
    expect(result.left.left.name).toBe('A');
    expect(result.left.right.name).toBe('B');
    expect(result.right.name).toBe('C');
  });

  it('transforms Not child', () => {
    const tree = Not(Identifier('x'));
    const result = transformTree(tree, (node) => {
      if (node.type === 'Identifier') return Identifier('y');
      return node;
    });
    expect(result.child.name).toBe('y');
  });

  it('transforms Function args', () => {
    const tree = Func('count', [Identifier('x'), Literal(1, 'number')]);
    const result = transformTree(tree, (node) => {
      if (node.type === 'Identifier') return Identifier('replaced');
      return node;
    });
    expect(result.args[0].name).toBe('replaced');
    expect(result.args[1]).toEqual(Literal(1, 'number'));
  });

  it('transforms Alias expr', () => {
    const tree = Alias(Identifier('x'), 'myAlias');
    const result = transformTree(tree, (node) => {
      if (node.type === 'Identifier') return Identifier('y');
      return node;
    });
    expect(result.expr.name).toBe('y');
    expect(result.name).toBe('myAlias');
  });

  it('transforms IsNull child', () => {
    const tree = IsNull(Identifier('x'));
    const result = transformTree(tree, (node) => {
      if (node.type === 'Identifier') return Identifier('y');
      return node;
    });
    expect(result.child.name).toBe('y');
  });

  it('transforms Like field', () => {
    const tree = Like(Identifier('x'), '%test%');
    const result = transformTree(tree, (node) => {
      if (node.type === 'Identifier') return Identifier('y');
      return node;
    });
    expect(result.field.name).toBe('y');
    expect(result.pattern).toBe('%test%');
  });

  it('transforms In field but not values', () => {
    const tree = In(Identifier('x'), [
      Literal('a', 'string'),
      Literal('b', 'string'),
    ]);
    const result = transformTree(tree, (node) => {
      if (node.type === 'Identifier') return Identifier('y');
      return node;
    });
    expect(result.field.name).toBe('y');
    expect(result.values).toEqual([
      Literal('a', 'string'),
      Literal('b', 'string'),
    ]);
  });

  it('transforms Rlike field', () => {
    const tree = Rlike(Identifier('x'), '.*test.*');
    const result = transformTree(tree, (node) => {
      if (node.type === 'Identifier') return Identifier('y');
      return node;
    });
    expect(result.field.name).toBe('y');
    expect(result.pattern).toBe('.*test.*');
  });

  it('leaves leaf nodes unchanged when fn returns them', () => {
    expect(transformTree(Wildcard(), (n) => n)).toEqual(Wildcard());
    expect(transformTree(Regex('.*'), (n) => n)).toEqual(Regex('.*'));
    expect(transformTree(RawNrql('1'), (n) => n)).toEqual(RawNrql('1'));
    expect(transformTree(Literal(42, 'number'), (n) => n)).toEqual(
      Literal(42, 'number'),
    );
  });

  it('does NOT recurse into SubqueryExpr', () => {
    const inner = SelectQuery({ where: [Identifier('should_not_touch')] });
    const tree = SubqueryExpr(inner);
    const result = transformTree(tree, (node) => {
      if (node.type === 'Identifier') return Identifier('TOUCHED');
      return node;
    });
    expect(result.query.where[0].name).toBe('should_not_touch');
  });

  it('does NOT recurse into SubquerySource', () => {
    const inner = SelectQuery({ where: [Identifier('should_not_touch')] });
    const tree = SubquerySource(inner);
    const result = transformTree(tree, (node) => {
      if (node.type === 'Identifier') return Identifier('TOUCHED');
      return node;
    });
    expect(result.query.where[0].name).toBe('should_not_touch');
  });

  it('transforms SelectQuery fields', () => {
    const query = SelectQuery({
      select: [Identifier('a')],
      where: [Identifier('b')],
      facet: [Identifier('c')],
      bindings: [Binding('d', Identifier('d'))],
    });
    const result = transformTree(query, (node) => {
      if (node.type === 'Identifier')
        return Identifier(node.name.toUpperCase());
      return node;
    });
    expect(result.select[0].name).toBe('A');
    expect(result.where[0].name).toBe('B');
    expect(result.facet[0].name).toBe('C');
    expect(result.bindings[0].expr.name).toBe('D');
  });

  it('transforms OrderBy field', () => {
    const tree = OrderBy(Identifier('x'), true);
    const result = transformTree(tree, (node) => {
      if (node.type === 'Identifier') return Identifier('y');
      return node;
    });
    expect(result.field.name).toBe('y');
  });

  it('transforms DualCheck field but not op/value', () => {
    const tree = DualCheck(Identifier('x'), '=', Literal(500, 'number'));
    const result = transformTree(tree, (node) => {
      if (node.type === 'Identifier') return Identifier('y');
      return node;
    });
    expect(result.field.name).toBe('y');
    expect(result.op).toBe('=');
    expect(result.value).toEqual(Literal(500, 'number'));
  });
});
