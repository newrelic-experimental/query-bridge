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
  Wildcard,
  SubqueryExpr,
  Regex,
  SelectQuery,
  NestedAggregation,
  EventType,
  LookupSource,
  SubquerySource,
  Binding,
  JoinClause,
  OrderBy,
} from '../../src/ir/nodes.js';

describe('IR expression nodes', () => {
  it('Identifier', () => {
    const node = Identifier('host');
    expect(node).toEqual({ type: 'Identifier', name: 'host' });
  });

  it('Literal string', () => {
    const node = Literal('error', 'string');
    expect(node).toEqual({ type: 'Literal', value: 'error', kind: 'string' });
  });

  it('Literal number', () => {
    const node = Literal(42, 'number');
    expect(node).toEqual({ type: 'Literal', value: 42, kind: 'number' });
  });

  it('Literal null', () => {
    const node = Literal(null, 'null');
    expect(node).toEqual({ type: 'Literal', value: null, kind: 'null' });
  });

  it('BinOp', () => {
    const node = BinOp('AND', Identifier('a'), Identifier('b'));
    expect(node.type).toBe('BinOp');
    expect(node.op).toBe('AND');
    expect(node.left.name).toBe('a');
    expect(node.right.name).toBe('b');
  });

  it('Not', () => {
    const node = Not(Identifier('x'));
    expect(node).toEqual({
      type: 'Not',
      child: { type: 'Identifier', name: 'x' },
    });
  });

  it('Func', () => {
    const node = Func('count', [Identifier('status')]);
    expect(node.type).toBe('Function');
    expect(node.name).toBe('count');
    expect(node.args).toHaveLength(1);
  });

  it('Alias', () => {
    const node = Alias(Func('count', []), 'total');
    expect(node.type).toBe('Alias');
    expect(node.name).toBe('total');
    expect(node.expr.type).toBe('Function');
  });

  it('IsNull', () => {
    const node = IsNull(Identifier('field'));
    expect(node).toEqual({
      type: 'IsNull',
      child: { type: 'Identifier', name: 'field' },
    });
  });

  it('Like', () => {
    const node = Like(Identifier('msg'), '%error%');
    expect(node.type).toBe('Like');
    expect(node.pattern).toBe('%error%');
  });

  it('In', () => {
    const node = In(Identifier('status'), [
      Literal(200, 'number'),
      Literal(404, 'number'),
    ]);
    expect(node.type).toBe('In');
    expect(node.values).toHaveLength(2);
  });

  it('Wildcard', () => {
    expect(Wildcard()).toEqual({ type: 'Wildcard' });
  });

  it('SubqueryExpr', () => {
    const node = SubqueryExpr(SelectQuery());
    expect(node.type).toBe('SubqueryExpr');
    expect(node.query.type).toBe('SelectQuery');
  });

  it('Regex', () => {
    const node = Regex('error|fail');
    expect(node).toEqual({ type: 'Regex', pattern: 'error|fail' });
  });
});

describe('IR query nodes', () => {
  it('SelectQuery with defaults', () => {
    const q = SelectQuery();
    expect(q.type).toBe('SelectQuery');
    expect(q.dataSource).toEqual({ type: 'EventType', names: ['Log'] });
    expect(q.select).toEqual([]);
    expect(q.where).toBeNull();
    expect(q.facet).toEqual([]);
    expect(q.bindings).toEqual([]);
    expect(q.join).toBeNull();
    expect(q.orderBy).toBeNull();
    expect(q.limit).toBeNull();
    expect(q.timeseries).toBeNull();
    expect(q.predict).toBe(false);
    expect(q.since).toBeNull();
    expect(q.until).toBeNull();
    expect(q.warnings).toEqual([]);
    expect(q.unsupported).toEqual([]);
    expect(q.errors).toEqual([]);
  });

  it('SelectQuery with overrides', () => {
    const q = SelectQuery({
      dataSource: EventType(['Metric']),
      select: [Func('average', [Identifier('duration')])],
      limit: 100,
    });
    expect(q.dataSource.names).toEqual(['Metric']);
    expect(q.select).toHaveLength(1);
    expect(q.limit).toBe(100);
  });

  it('EventType', () => {
    expect(EventType(['Log'])).toEqual({ type: 'EventType', names: ['Log'] });
  });

  it('LookupSource', () => {
    expect(LookupSource('users.csv')).toEqual({
      type: 'Lookup',
      name: 'users.csv',
    });
  });

  it('SubquerySource', () => {
    const inner = SelectQuery();
    const src = SubquerySource(inner);
    expect(src.type).toBe('SubquerySource');
    expect(src.query.type).toBe('SelectQuery');
  });

  it('NestedAggregation', () => {
    const n = NestedAggregation([SelectQuery()], SelectQuery());
    expect(n.type).toBe('NestedAggregation');
    expect(n.layers).toHaveLength(1);
    expect(n.dataQuery.type).toBe('SelectQuery');
  });

  it('Binding', () => {
    const b = Binding('x', Func('lower', [Identifier('host')]));
    expect(b.name).toBe('x');
    expect(b.expr.type).toBe('Function');
  });

  it('JoinClause', () => {
    const j = JoinClause(SelectQuery(), Identifier('host'));
    expect(j.type).toBe('JoinClause');
    expect(j.onKey.name).toBe('host');
  });

  it('OrderBy', () => {
    expect(OrderBy(Identifier('count'), true)).toEqual({
      type: 'OrderBy',
      field: { type: 'Identifier', name: 'count' },
      descending: true,
    });
  });
});
