import {
  SelectQuery,
  SubquerySource,
  Identifier,
  Literal,
  Func,
  Alias,
  BinOp,
  OrderBy,
  Binding,
  Wildcard,
} from '../../src/ir/nodes.js';
import {
  foldPostAggregationPass,
  isFoldSafe,
} from '../../src/ir/foldPostAggregation.js';
import { messages } from '../../src/messages.js';

// These unit tests drive foldPostAggregationPass directly with constructed IR
// (a SubquerySource over an aggregating inner) — the shapes the wiring layer's
// handlers produce. They exercise the pass in isolation so the engine ships with
// its own tests; the SPL→NRQL integration cases live with the wiring that turns
// it on.

describe('isFoldSafe', () => {
  it('recognizes a distributed-capable function and rejects others', () => {
    expect(isFoldSafe('round')).toBe(true);
    expect(isFoldSafe('getField')).toBe(true);
    expect(isFoldSafe('jparse')).toBe(false);
  });
});

describe('foldPostAggregationPass — passthrough', () => {
  it('returns a query with no SubquerySource unchanged', () => {
    const ir = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.dataSource.type).toBe('EventType');
    expect(result.select).toEqual([Func('count', [Wildcard()])]);
    expect(result.unsupported).toEqual([]);
  });

  it('leaves a chain that already carries an unsupported message untouched', () => {
    const inner = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [Alias(Func('numeric', [Identifier('count')]), 'c')],
      unsupported: ['prior'],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.dataSource.type).toBe('SubquerySource');
    expect(result.unsupported).toEqual(['prior']);
  });
});

describe('foldPostAggregationPass — eval-after-aggregation fold', () => {
  it('folds an eval projection into the aggregating layer and drops the raw aggregate', () => {
    const inner = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [
        Alias(
          BinOp(
            '*',
            Func('numeric', [Identifier('count')]),
            Literal(100, 'number'),
          ),
          'pct',
        ),
      ],
    });
    const result = foldPostAggregationPass(ir);
    // Flattened: the subquery is gone, the eval is projected beside the FACET,
    // and numeric(count) collapses back to the bare count aggregate.
    expect(result.dataSource.type).toBe('EventType');
    expect(result.facet).toEqual([Identifier('host')]);
    expect(result.select).toEqual([
      Alias(
        BinOp('*', Func('count', [Wildcard()]), Literal(100, 'number')),
        'pct',
      ),
    ]);
    expect(result.limit).toBe('MAX');
    expect(result.warnings).toContain(
      messages.eval_after_agg_drops_source(['count']),
    );
  });

  it('keeps the subquery and flags an eval referencing a column the inner does not expose', () => {
    const inner = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [
        Alias(BinOp('+', Identifier('count'), Identifier('missing')), 'x'),
      ],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.dataSource.type).toBe('SubquerySource');
    expect(result.unsupported).toContain(
      messages.compound_collapse_unsupported(),
    );
  });

  it('keeps the subquery when an eval references a facet key', () => {
    const inner = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [Alias(Func('length', [Identifier('host')]), 'hl')],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.dataSource.type).toBe('SubquerySource');
    expect(result.unsupported).toEqual([]);
  });

  it('keeps the subquery when the eval layer carries its own bindings', () => {
    const inner = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [Alias(Func('numeric', [Identifier('count')]), 'c')],
      bindings: [Binding('b', Identifier('count'))],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.dataSource.type).toBe('SubquerySource');
    expect(result.unsupported).toEqual([]);
  });

  it('keeps the subquery when there is nothing but facet keys to fold', () => {
    const inner = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [Identifier('host')],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.dataSource.type).toBe('SubquerySource');
    expect(result.unsupported).toEqual([]);
  });

  it('keeps the subquery and flags an unaccounted non-facet column', () => {
    const inner = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [Identifier('host'), Identifier('rexcap')],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.dataSource.type).toBe('SubquerySource');
    expect(result.unsupported).toContain(
      messages.compound_collapse_unsupported(),
    );
  });
});

describe('foldPostAggregationPass — where-after-aggregation', () => {
  it('keeps a scalar where filter as a subquery', () => {
    const inner = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      where: [
        BinOp(
          '>',
          Func('numeric', [Identifier('count')]),
          Literal(5, 'number'),
        ),
      ],
      select: [Identifier('host')],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.dataSource.type).toBe('SubquerySource');
    expect(result.unsupported).toEqual([]);
  });

  it('extracts a median column referenced in a where via a getField binding', () => {
    const inner = SelectQuery({
      select: [
        Alias(Func('median', [Identifier('d')]), 'md'),
        Func('count', [Wildcard()]),
      ],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      where: [
        BinOp('>', Func('numeric', [Identifier('md')]), Literal(10, 'number')),
      ],
      select: [],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.bindings).toContainEqual(
      Binding(
        'md50',
        Func('getField', [Identifier('md'), Literal('50', 'string')]),
      ),
    );
    // numeric(md) > 10 is rewritten to the bound scalar, numeric() stripped.
    expect(result.where[0]).toEqual(
      BinOp('>', Identifier('md50'), Literal(10, 'number')),
    );
    expect(result.select).toEqual([Identifier('md50')]);
    expect(result.unsupported).toEqual([]);
  });

  it('marks a uniques (list) column referenced in a where as unsupported', () => {
    const inner = SelectQuery({
      select: [
        Alias(Func('uniques', [Identifier('u')]), 'us'),
        Func('count', [Wildcard()]),
      ],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      where: [
        BinOp('>', Func('length', [Identifier('us')]), Literal(2, 'number')),
      ],
      select: [],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.unsupported).toContain(
      messages.eval_after_agg_nonscalar('us'),
    );
  });

  it('bails with a collision message when the extracted column is exposed twice', () => {
    const inner = SelectQuery({
      // Both aliased 'md'; the LAST (median) is what the exposed map resolves to.
      select: [
        Alias(Func('max', [Identifier('e')]), 'md'),
        Alias(Func('median', [Identifier('d')]), 'md'),
      ],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      where: [
        BinOp('>', Func('numeric', [Identifier('md')]), Literal(1, 'number')),
      ],
      select: [],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.unsupported).toContain(
      messages.subquery_name_collision('md'),
    );
  });
});

describe('foldPostAggregationPass — where-only-layer merge', () => {
  it('AND-merges two stacked where-only layers over the aggregating inner', () => {
    const aggInner = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const midWhere = SelectQuery({
      dataSource: SubquerySource(aggInner),
      where: [
        BinOp(
          '>',
          Func('numeric', [Identifier('count')]),
          Literal(5, 'number'),
        ),
      ],
      select: [],
    });
    const outer = SelectQuery({
      dataSource: SubquerySource(midWhere),
      where: [
        BinOp(
          '<',
          Func('numeric', [Identifier('count')]),
          Literal(100, 'number'),
        ),
      ],
      select: [],
    });
    const result = foldPostAggregationPass(outer);
    expect(result.dataSource.type).toBe('SubquerySource');
    expect(result.where).toEqual([
      BinOp('>', Func('numeric', [Identifier('count')]), Literal(5, 'number')),
      BinOp(
        '<',
        Func('numeric', [Identifier('count')]),
        Literal(100, 'number'),
      ),
    ]);
    expect(result.unsupported).toEqual([]);
  });
});

describe('foldPostAggregationPass — aggregation over aggregation', () => {
  it('allows a trailing regroup on an exposed facet key', () => {
    const inner = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [Func('average', [Identifier('count')])],
      facet: [Identifier('host')],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.dataSource.type).toBe('SubquerySource');
    expect(result.unsupported).toEqual([]);
  });

  it('flags a trailing regroup on a key the inner never produced', () => {
    const inner = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [Func('average', [Identifier('count')])],
      facet: [Identifier('region')],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.unsupported).toContain(
      messages.compound_trailing_regroup_unsupported('region'),
    );
  });

  it('inlines getField for a median referenced in a trailing aggregate', () => {
    const inner = SelectQuery({
      select: [Alias(Func('median', [Identifier('d')]), 'md')],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [Func('average', [Identifier('md')])],
      facet: [Identifier('host')],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.select).toEqual([
      Func('average', [
        Func('getField', [Identifier('md'), Literal('50', 'string')]),
      ]),
    ]);
    expect(result.unsupported).toEqual([]);
  });

  it('marks a list column in a trailing aggregate as unsupported', () => {
    const inner = SelectQuery({
      select: [Alias(Func('uniques', [Identifier('u')]), 'us')],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [Func('latest', [Identifier('us')])],
      facet: [Identifier('host')],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.unsupported).toContain(
      messages.eval_after_agg_nonscalar('us'),
    );
  });

  it('bails with a collision message in a trailing aggregate', () => {
    const inner = SelectQuery({
      select: [
        Alias(Func('max', [Identifier('e')]), 'md'),
        Alias(Func('median', [Identifier('d')]), 'md'),
      ],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [Func('average', [Identifier('md')])],
      facet: [Identifier('host')],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.unsupported).toContain(
      messages.subquery_name_collision('md'),
    );
  });
});

describe('foldPostAggregationPass — residual guards', () => {
  it('flags a row-wise inner as an illegal nested aggregation', () => {
    const rowwiseInner = SelectQuery({ select: [Identifier('a')] });
    const ir = SelectQuery({
      dataSource: SubquerySource(rowwiseInner),
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.unsupported).toContain(
      messages.compound_collapse_unsupported(),
    );
  });

  it('flags an order-by on a fold-dropped aggregate', () => {
    const inner = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [
        Alias(
          BinOp(
            '/',
            Func('numeric', [Identifier('count')]),
            Literal(60, 'number'),
          ),
          'cpm',
        ),
      ],
      orderBy: OrderBy(Identifier('count'), true),
    });
    const result = foldPostAggregationPass(ir);
    expect(result.warnings).toContain(
      messages.eval_after_agg_drops_source(['count']),
    );
    expect(result.unsupported).toContain(
      messages.compound_collapse_unsupported(),
    );
  });

  it('flags an unextracted non-scalar column reaching ORDER BY', () => {
    const inner = SelectQuery({
      select: [
        Alias(Func('median', [Identifier('d')]), 'md'),
        Func('count', [Wildcard()]),
      ],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [Identifier('host')],
      orderBy: OrderBy(Identifier('md'), true),
    });
    const result = foldPostAggregationPass(ir);
    expect(result.unsupported).toContain(
      messages.eval_after_agg_nonscalar('md'),
    );
  });

  it('sets LIMIT MAX on an aggregating inner that lacks a limit', () => {
    const inner = SelectQuery({
      select: [Func('count', [Wildcard()])],
      facet: [Identifier('host')],
    });
    const ir = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [Identifier('host')],
    });
    const result = foldPostAggregationPass(ir);
    expect(result.dataSource.query.limit).toBe('MAX');
  });
});
