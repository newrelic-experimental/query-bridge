import { emitExpr, emitQuery } from '../../src/output/nrql/irToNrql.js';
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
  Regex,
  SelectQuery,
  Union,
  NestedAggregation,
  EventType,
  LookupSource,
  SubquerySource,
  Binding,
  JoinClause,
  OrderBy,
} from '../../src/ir/nodes.js';

// ── Expression emission ──────────────────────────────────────

describe('emitExpr', () => {
  it('Identifier simple → bare', () => {
    expect(emitExpr(Identifier('host'))).toBe('host');
  });

  it('Identifier with dots → backtick-escaped', () => {
    expect(emitExpr(Identifier('log.level'))).toBe('`log.level`');
  });

  it('Identifier with dash → backtick-escaped', () => {
    expect(emitExpr(Identifier('container-name'))).toBe('`container-name`');
  });

  it('Identifier macro → bare (no backticks)', () => {
    expect(emitExpr(Identifier('$my_macro'))).toBe('$my_macro');
  });

  it('Literal string → single-quoted', () => {
    expect(emitExpr(Literal('error', 'string'))).toBe("'error'");
  });

  it('Literal number → bare', () => {
    expect(emitExpr(Literal(42, 'number'))).toBe('42');
  });

  it('Literal null → NULL', () => {
    expect(emitExpr(Literal(null, 'null'))).toBe('NULL');
  });

  it('Literal boolean', () => {
    expect(emitExpr(Literal(true, 'boolean'))).toBe('true');
  });

  it('BinOp AND', () => {
    expect(emitExpr(BinOp('AND', Identifier('a'), Identifier('b')))).toBe(
      'a AND b',
    );
  });

  it('BinOp =', () => {
    expect(
      emitExpr(BinOp('=', Identifier('status'), Literal(200, 'number'))),
    ).toBe('status = 200');
  });

  it('Not', () => {
    expect(emitExpr(Not(Identifier('x')))).toBe('NOT x');
  });

  it('Function with args', () => {
    expect(emitExpr(Func('count', [Identifier('status')]))).toBe(
      'count(status)',
    );
  });

  it('Function no args → count(*)', () => {
    expect(emitExpr(Func('count', []))).toBe('count(*)');
  });

  it('Alias', () => {
    expect(emitExpr(Alias(Func('count', []), 'total'))).toBe(
      "count(*) AS 'total'",
    );
  });

  it('IsNull', () => {
    expect(emitExpr(IsNull(Identifier('field')))).toBe('field IS NULL');
  });

  it('Like', () => {
    expect(emitExpr(Like(Identifier('msg'), '%error%'))).toBe(
      "msg LIKE '%error%'",
    );
  });

  it('In', () => {
    expect(
      emitExpr(
        In(Identifier('code'), [
          Literal(200, 'number'),
          Literal(404, 'number'),
        ]),
      ),
    ).toBe('code IN (200, 404)');
  });

  it('Wildcard → *', () => {
    expect(emitExpr(Wildcard())).toBe('*');
  });

  it('Regex', () => {
    expect(emitExpr(Regex('error|fail'))).toBe("r'error|fail'");
  });

  it('nested BinOp: OR inside AND needs NO parens (NRQL: OR binds tighter)', () => {
    const inner = BinOp('OR', Identifier('a'), Identifier('b'));
    const outer = BinOp('AND', inner, Identifier('c'));
    expect(emitExpr(outer)).toBe('a OR b AND c');
  });

  it('nested BinOp: AND inside OR NEEDS parens (NRQL: AND has lower precedence)', () => {
    const inner = BinOp('AND', Identifier('a'), Identifier('b'));
    const outer = BinOp('OR', inner, Identifier('c'));
    expect(emitExpr(outer)).toBe('(a AND b) OR c');
  });
});

// ── Query emission ───────────────────────────────────────────

describe('emitQuery', () => {
  it('minimal SelectQuery → FROM Log SELECT *', () => {
    expect(emitQuery(SelectQuery())).toBe('FROM Log SELECT *');
  });

  it('SelectQuery with select', () => {
    const q = SelectQuery({ select: [Func('count', [])] });
    expect(emitQuery(q)).toBe('FROM Log SELECT count(*)');
  });

  it('SelectQuery with where', () => {
    const q = SelectQuery({
      where: BinOp('=', Identifier('status'), Literal(500, 'number')),
    });
    expect(emitQuery(q)).toBe('FROM Log SELECT * WHERE status = 500');
  });

  it('SelectQuery with facet', () => {
    const q = SelectQuery({
      select: [Func('count', [])],
      facet: [Identifier('host')],
    });
    expect(emitQuery(q)).toBe('FROM Log SELECT count(*) FACET host');
  });

  it('SelectQuery with bindings (WITH clause)', () => {
    const q = SelectQuery({
      bindings: [
        Binding(
          'dur_sec',
          BinOp('/', Identifier('duration'), Literal(1000, 'number')),
        ),
      ],
    });
    expect(emitQuery(q)).toBe(
      'FROM Log WITH duration / 1000 AS dur_sec SELECT *',
    );
  });

  it('SelectQuery with order, limit, timeseries', () => {
    const q = SelectQuery({
      select: [Func('count', [])],
      orderBy: OrderBy(Identifier('count'), true),
      limit: 10,
      timeseries: '5 minutes',
    });
    expect(emitQuery(q)).toBe(
      'FROM Log SELECT count(*) ORDER BY count DESC LIMIT 10 TIMESERIES 5 minutes',
    );
  });

  it('SelectQuery with since/until', () => {
    const q = SelectQuery({ since: '1 hour ago', until: 'now' });
    expect(emitQuery(q)).toBe('FROM Log SELECT * SINCE 1 hour ago UNTIL now');
  });

  it('SelectQuery with predict', () => {
    const q = SelectQuery({
      select: [Func('count', [])],
      timeseries: '30 minutes',
      predict: true,
    });
    expect(emitQuery(q)).toBe(
      'FROM Log SELECT count(*) TIMESERIES 30 minutes PREDICT',
    );
  });

  it('SelectQuery with JOIN', () => {
    const subq = SelectQuery({
      select: [Alias(Func('average', [Identifier('duration')]), 'avg_dur')],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const q = SelectQuery({ join: JoinClause(subq, Identifier('host')) });
    const nrql = emitQuery(q);
    expect(nrql).toContain('JOIN');
    expect(nrql).toContain('ON host = host');
    expect(nrql).toContain("average(duration) AS 'avg_dur'");
  });

  it('SelectQuery FROM Metric', () => {
    const q = SelectQuery({
      dataSource: EventType(['Metric']),
      select: [Func('average', [Identifier('cpu.percent')])],
    });
    expect(emitQuery(q)).toBe('FROM Metric SELECT average(`cpu.percent`)');
  });

  it('SelectQuery FROM lookup', () => {
    const q = SelectQuery({ dataSource: LookupSource('users.csv') });
    expect(emitQuery(q)).toBe('FROM lookup(users.csv) SELECT *');
  });

  it('SelectQuery FROM subquery', () => {
    const inner = SelectQuery({
      select: [Alias(Func('count', []), 'cnt')],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const q = SelectQuery({
      dataSource: SubquerySource(inner),
      select: [Func('max', [Identifier('cnt')])],
    });
    const nrql = emitQuery(q);
    expect(nrql).toContain(
      "FROM (FROM Log SELECT count(*) AS 'cnt' FACET host LIMIT MAX)",
    );
    expect(nrql).toContain('SELECT max(cnt)');
  });

  it('NestedAggregation', () => {
    const inner = SelectQuery({
      select: [Alias(Func('count', []), 'cnt')],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const outer = SelectQuery({
      select: [Func('sum', [Identifier('cnt')])],
    });
    const na = NestedAggregation([outer], inner);
    const nrql = emitQuery(na);
    expect(nrql).toContain(
      "FROM (FROM Log SELECT count(*) AS 'cnt' FACET host LIMIT MAX)",
    );
    expect(nrql).toContain('SELECT sum(cnt)');
  });
});
