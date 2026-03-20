# nr-query-bridge Phase 1: IR Node Types + NRQL Emitter

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

> **IMPORTANT:** Seriously, no bash/python/node. Use Read/Edit tools only. Work in small chunks (you timeout on large edits).

**Goal:** Define the IR node types and build the NRQL emitter (Pass 2). After this phase, you can hand-build IR trees and emit valid NRQL strings. This is the foundation for Pass 1 (SPL AST → IR) in Phase 2.

**Architecture:** IR nodes are plain objects with `type` discriminator fields. The emitter walks the IR tree and produces a NRQL string. TDD: write emitter tests first with hand-built IR, then implement.

**Tech Stack:** Node 20, Jest, plain JS (no TypeScript)

**Spec:** `docs/superpowers/specs/2026-03-15-spl-ir-rearchitecture-design.md`

**Run tests:** `ASDF_NODEJS_VERSION=20.19.0 packages/nr-query-bridge/node_modules/.bin/jest --no-coverage --config packages/nr-query-bridge/jest.config.js`

---

## Chunk 1: IR Node Constructors

### Task 1: Expression node constructors

**Files:**
- Create: `packages/nr-query-bridge/src/ir/nodes.js`
- Create: `packages/nr-query-bridge/test/ir/nodes.test.js`

- [ ] **Step 1: Write tests for expression constructors**

Create `packages/nr-query-bridge/test/ir/nodes.test.js`:

```js
import {
  Identifier, Literal, BinOp, Not, Func, Alias,
  IsNull, Like, In, Wildcard, Regex,
} from '../../src/ir/nodes';

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
    expect(node).toEqual({ type: 'Not', child: { type: 'Identifier', name: 'x' } });
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
    expect(node).toEqual({ type: 'IsNull', child: { type: 'Identifier', name: 'field' } });
  });

  it('Like', () => {
    const node = Like(Identifier('msg'), '%error%');
    expect(node.type).toBe('Like');
    expect(node.pattern).toBe('%error%');
  });

  it('In', () => {
    const node = In(Identifier('status'), [Literal(200, 'number'), Literal(404, 'number')]);
    expect(node.type).toBe('In');
    expect(node.values).toHaveLength(2);
  });

  it('Wildcard', () => {
    expect(Wildcard()).toEqual({ type: 'Wildcard' });
  });

  it('Regex', () => {
    const node = Regex('error|fail');
    expect(node).toEqual({ type: 'Regex', pattern: 'error|fail' });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `ASDF_NODEJS_VERSION=20.19.0 packages/nr-query-bridge/node_modules/.bin/jest --no-coverage --config packages/nr-query-bridge/jest.config.js --testPathPattern=nodes`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement expression constructors**

Create `packages/nr-query-bridge/src/ir/nodes.js`:

```js
/**
 * IR Node Constructors.
 *
 * Plain objects with `type` discriminator fields.
 * Mirrors NRQL's TCompilerExpressionPlan from dirac-nrql Thrift.
 */

// ── Expression nodes ──────────────────────────────────────────

export const Identifier = (name) => ({ type: 'Identifier', name });

export const Literal = (value, kind) => ({ type: 'Literal', value, kind });

export const BinOp = (op, left, right) => ({ type: 'BinOp', op, left, right });

export const Not = (child) => ({ type: 'Not', child });

export const Func = (name, args) => ({ type: 'Function', name, args });

export const Alias = (expr, name) => ({ type: 'Alias', expr, name });

export const IsNull = (child) => ({ type: 'IsNull', child });

export const Like = (field, pattern) => ({ type: 'Like', field, pattern });

export const In = (field, values) => ({ type: 'In', field, values });

export const Wildcard = () => ({ type: 'Wildcard' });

export const SubqueryExpr = (query) => ({ type: 'SubqueryExpr', query });

export const Regex = (pattern) => ({ type: 'Regex', pattern });
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```
feat: ir expression node constructors
```

### Task 2: Query-level node constructors

**Files:**
- Modify: `packages/nr-query-bridge/src/ir/nodes.js`
- Modify: `packages/nr-query-bridge/test/ir/nodes.test.js`

- [ ] **Step 1: Add tests for query-level nodes**

Append to `nodes.test.js`:

```js
import {
  SelectQuery, Union, NestedAggregation,
  EventType, LookupSource, SubquerySource,
  Binding, JoinClause, OrderBy,
} from '../../src/ir/nodes';

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
    expect(LookupSource('users.csv')).toEqual({ type: 'Lookup', name: 'users.csv' });
  });

  it('SubquerySource', () => {
    const inner = SelectQuery();
    const src = SubquerySource(inner);
    expect(src.type).toBe('SubquerySource');
    expect(src.query.type).toBe('SelectQuery');
  });

  it('Union', () => {
    const u = Union([SelectQuery(), SelectQuery()]);
    expect(u.type).toBe('Union');
    expect(u.queries).toHaveLength(2);
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
      type: 'OrderBy', field: { type: 'Identifier', name: 'count' }, descending: true,
    });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

- [ ] **Step 3: Implement query-level constructors**

Append to `nodes.js`:

```js
// ── Data source nodes ─────────────────────────────────────────

export const EventType = (names) => ({ type: 'EventType', names });

export const LookupSource = (name) => ({ type: 'Lookup', name });

export const SubquerySource = (query) => ({ type: 'SubquerySource', query });

// ── Structural nodes ──────────────────────────────────────────

export const Binding = (name, expr) => ({ name, expr });

export const JoinClause = (subquery, onKey) => ({
  type: 'JoinClause', subquery, onKey,
});

export const OrderBy = (field, descending) => ({
  type: 'OrderBy', field, descending,
});

// ── Query-level nodes ─────────────────────────────────────────

export const SelectQuery = (overrides = {}) => ({
  type: 'SelectQuery',
  dataSource: EventType(['Log']),
  bindings: [],
  select: [],
  where: null,
  facet: [],
  join: null,
  orderBy: null,
  limit: null,
  timeseries: null,
  predict: false,
  since: null,
  until: null,
  warnings: [],
  unsupported: [],
  errors: [],
  ...overrides,
});

export const Union = (queries) => ({ type: 'Union', queries });

export const NestedAggregation = (layers, dataQuery) => ({
  type: 'NestedAggregation', layers, dataQuery,
});
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```
feat: ir query-level node constructors
```

---

## Chunk 2: NRQL Emitter

### Task 3: Expression emitter

**Files:**
- Create: `packages/nr-query-bridge/src/output/nrql/irToNrql.js`
- Create: `packages/nr-query-bridge/test/output/irToNrql.test.js`

- [ ] **Step 1: Write tests for expression emission**

Create `packages/nr-query-bridge/test/output/irToNrql.test.js`:

```js
import { emitExpr } from '../../src/output/nrql/irToNrql';
import {
  Identifier, Literal, BinOp, Not, Func, Alias,
  IsNull, Like, In, Wildcard, Regex,
} from '../../src/ir/nodes';

describe('emitExpr', () => {
  it('Identifier → backtick-escaped', () => {
    expect(emitExpr(Identifier('host'))).toBe('`host`');
  });

  it('Identifier with dots → backtick-escaped', () => {
    expect(emitExpr(Identifier('log.level'))).toBe('`log.level`');
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

  it('BinOp AND', () => {
    expect(emitExpr(BinOp('AND', Identifier('a'), Identifier('b'))))
      .toBe('`a` AND `b`');
  });

  it('BinOp =', () => {
    expect(emitExpr(BinOp('=', Identifier('status'), Literal(200, 'number'))))
      .toBe("`status` = 200");
  });

  it('Not', () => {
    expect(emitExpr(Not(Identifier('x')))).toBe('NOT `x`');
  });

  it('Function with args', () => {
    expect(emitExpr(Func('count', [Identifier('status')])))
      .toBe('count(`status`)');
  });

  it('Function no args (count(*))', () => {
    expect(emitExpr(Func('count', []))).toBe('count(*)');
  });

  it('Alias', () => {
    expect(emitExpr(Alias(Func('count', []), 'total')))
      .toBe("count(*) AS 'total'");
  });

  it('IsNull', () => {
    expect(emitExpr(IsNull(Identifier('field')))).toBe('`field` IS NULL');
  });

  it('Like', () => {
    expect(emitExpr(Like(Identifier('msg'), '%error%')))
      .toBe("`msg` LIKE '%error%'");
  });

  it('In', () => {
    expect(emitExpr(In(Identifier('code'), [Literal(200, 'number'), Literal(404, 'number')])))
      .toBe('`code` IN (200, 404)');
  });

  it('Wildcard → *', () => {
    expect(emitExpr(Wildcard())).toBe('*');
  });

  it('Regex', () => {
    expect(emitExpr(Regex('error|fail'))).toBe("r'error|fail'");
  });

  it('nested BinOp respects NRQL precedence (OR inside AND gets parens)', () => {
    const inner = BinOp('OR', Identifier('a'), Identifier('b'));
    const outer = BinOp('AND', inner, Identifier('c'));
    expect(emitExpr(outer)).toBe('(`a` OR `b`) AND `c`');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

- [ ] **Step 3: Implement expression emitter**

Create `packages/nr-query-bridge/src/output/nrql/irToNrql.js`:

```js
/**
 * NRQL Emitter — Pass 2: IR → NRQL string.
 *
 * Walks the IR tree and produces a NRQL query string.
 * Escaping is centralized here — no scattered escapeField() calls.
 */
import {
  escapeAttributeNameForNrql,
  escapeStringLiteralForNrql,
} from './nrqlEncoding';

export function emitExpr(node) {
  if (!node) return '';

  switch (node.type) {
    case 'Identifier':
      return escapeAttributeNameForNrql(node.name);

    case 'Literal':
      if (node.kind === 'null') return 'NULL';
      if (node.kind === 'number') return String(node.value);
      if (node.kind === 'boolean') return node.value ? 'true' : 'false';
      return `'${escapeStringLiteralForNrql(node.value)}'`;

    case 'BinOp':
      return emitBinOp(node);

    case 'Not':
      return `NOT ${emitExpr(node.child)}`;

    case 'Function':
      if (node.name === 'count' && node.args.length === 0) {
        return 'count(*)';
      }
      return `${node.name}(${node.args.map(emitExpr).join(', ')})`;

    case 'Alias':
      return `${emitExpr(node.expr)} AS '${escapeStringLiteralForNrql(node.name)}'`;

    case 'IsNull':
      return `${emitExpr(node.child)} IS NULL`;

    case 'Like':
      return `${emitExpr(node.field)} LIKE '${node.pattern}'`;

    case 'In':
      return `${emitExpr(node.field)} IN (${node.values.map(emitExpr).join(', ')})`;

    case 'Wildcard':
      return '*';

    case 'Regex':
      return `r'${node.pattern}'`;

    case 'SubqueryExpr':
      return `(${emitQuery(node.query)})`;

    default:
      return `/* unknown expression: ${node.type} */`;
  }
}

function emitBinOp(node) {
  let left = emitExpr(node.left);
  let right = emitExpr(node.right);

  // NRQL precedence: OR binds tighter than AND (opposite of SQL/SPL).
  // Parenthesize OR children inside AND to preserve semantics.
  if (node.op === 'AND') {
    if (node.left.type === 'BinOp' && node.left.op === 'OR') left = `(${left})`;
    if (node.right.type === 'BinOp' && node.right.op === 'OR') right = `(${right})`;
  }

  return `${left} ${node.op} ${right}`;
}
```

Note: `emitQuery` is referenced but not yet implemented — add a stub that throws. We'll implement it in Task 4.

Add at the top of the file after the existing code:

```js
// Stub — implemented in Task 4
export function emitQuery(node) {
  throw new Error(`emitQuery not yet implemented for ${node.type}`);
}
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```
feat: nrql expression emitter
```

### Task 4: Query emitter

**Files:**
- Modify: `packages/nr-query-bridge/src/output/nrql/irToNrql.js`
- Modify: `packages/nr-query-bridge/test/output/irToNrql.test.js`

- [ ] **Step 1: Write tests for query emission**

Append to `irToNrql.test.js`:

```js
import { emitQuery } from '../../src/output/nrql/irToNrql';
import {
  SelectQuery, Union, NestedAggregation,
  EventType, LookupSource, SubquerySource,
  Identifier, Literal, BinOp, Func, Alias, Like,
  Binding, JoinClause, OrderBy, Wildcard,
} from '../../src/ir/nodes';

describe('emitQuery', () => {
  it('minimal SelectQuery → FROM Log SELECT *', () => {
    expect(emitQuery(SelectQuery())).toBe('FROM Log SELECT *');
  });

  it('SelectQuery with select', () => {
    const q = SelectQuery({
      select: [Func('count', [])],
    });
    expect(emitQuery(q)).toBe('FROM Log SELECT count(*)');
  });

  it('SelectQuery with where', () => {
    const q = SelectQuery({
      where: BinOp('=', Identifier('status'), Literal(500, 'number')),
    });
    expect(emitQuery(q)).toBe("FROM Log SELECT * WHERE `status` = 500");
  });

  it('SelectQuery with facet', () => {
    const q = SelectQuery({
      select: [Func('count', [])],
      facet: [Identifier('host')],
    });
    expect(emitQuery(q)).toBe('FROM Log SELECT count(*) FACET `host`');
  });

  it('SelectQuery with bindings (WITH clause)', () => {
    const q = SelectQuery({
      bindings: [Binding('dur_sec', BinOp('/', Identifier('duration'), Literal(1000, 'number')))],
    });
    expect(emitQuery(q)).toBe("FROM Log WITH `duration` / 1000 AS `dur_sec` SELECT *");
  });

  it('SelectQuery with order, limit, timeseries', () => {
    const q = SelectQuery({
      select: [Func('count', [])],
      orderBy: OrderBy(Identifier('count'), true),
      limit: 10,
      timeseries: '5 minutes',
    });
    expect(emitQuery(q)).toBe('FROM Log SELECT count(*) ORDER BY `count` DESC LIMIT 10 TIMESERIES 5 minutes');
  });

  it('SelectQuery with since/until', () => {
    const q = SelectQuery({
      since: '1 hour ago',
      until: 'now',
    });
    expect(emitQuery(q)).toBe('FROM Log SELECT * SINCE 1 hour ago UNTIL now');
  });

  it('SelectQuery with predict', () => {
    const q = SelectQuery({
      select: [Func('count', [])],
      timeseries: '30 minutes',
      predict: true,
    });
    expect(emitQuery(q)).toBe('FROM Log SELECT count(*) TIMESERIES 30 minutes PREDICT');
  });

  it('SelectQuery with JOIN', () => {
    const subq = SelectQuery({
      select: [Alias(Func('average', [Identifier('duration')]), 'avg_dur')],
      facet: [Identifier('host')],
      limit: 'MAX',
    });
    const q = SelectQuery({
      join: JoinClause(subq, Identifier('host')),
    });
    const nrql = emitQuery(q);
    expect(nrql).toContain('JOIN');
    expect(nrql).toContain('ON `host`');
    expect(nrql).toContain("average(`duration`) AS 'avg_dur'");
  });

  it('SelectQuery FROM Metric', () => {
    const q = SelectQuery({
      dataSource: EventType(['Metric']),
      select: [Func('average', [Identifier('cpu.percent')])],
    });
    expect(emitQuery(q)).toBe("FROM Metric SELECT average(`cpu.percent`)");
  });

  it('SelectQuery FROM lookup', () => {
    const q = SelectQuery({
      dataSource: LookupSource('users.csv'),
    });
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
    expect(nrql).toContain("FROM (FROM Log SELECT count(*) AS 'cnt' FACET `host` LIMIT MAX)");
    expect(nrql).toContain('SELECT max(`cnt`)');
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
    expect(nrql).toContain("FROM (FROM Log SELECT count(*) AS 'cnt' FACET `host` LIMIT MAX)");
    expect(nrql).toContain('SELECT sum(`cnt`)');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

- [ ] **Step 3: Implement query emitter**

Replace the `emitQuery` stub in `irToNrql.js`:

```js
export function emitQuery(node) {
  switch (node.type) {
    case 'SelectQuery':
      return emitSelectQuery(node);
    case 'Union':
      return emitUnion(node);
    case 'NestedAggregation':
      return emitNestedAggregation(node);
    default:
      return `/* unknown query type: ${node.type} */`;
  }
}

function emitSelectQuery(q) {
  const parts = [];

  // FROM
  parts.push(`FROM ${emitDataSource(q.dataSource)}`);

  // JOIN
  if (q.join) {
    const subNrql = emitSelectQuery(q.join.subquery);
    parts.push(`JOIN (${subNrql}) ON ${emitExpr(q.join.onKey)} = ${emitExpr(q.join.onKey)}`);
  }

  // WITH (bindings)
  if (q.bindings.length > 0) {
    const binds = q.bindings.map(
      (b) => `${emitExpr(b.expr)} AS ${escapeAttributeNameForNrql(b.name)}`
    );
    parts.push(`WITH ${binds.join(', ')}`);
  }

  // SELECT
  const select = q.select.length > 0
    ? q.select.map(emitExpr).join(', ')
    : '*';
  parts.push(`SELECT ${select}`);

  // WHERE
  if (q.where) {
    parts.push(`WHERE ${emitExpr(q.where)}`);
  }

  // FACET
  if (q.facet.length > 0) {
    parts.push(`FACET ${q.facet.map(emitExpr).join(', ')}`);
  }

  // ORDER BY
  if (q.orderBy) {
    const dir = q.orderBy.descending ? 'DESC' : 'ASC';
    parts.push(`ORDER BY ${emitExpr(q.orderBy.field)} ${dir}`);
  }

  // LIMIT
  if (q.limit != null) {
    parts.push(`LIMIT ${q.limit}`);
  }

  // SINCE
  if (q.since) parts.push(`SINCE ${q.since}`);

  // UNTIL
  if (q.until) parts.push(`UNTIL ${q.until}`);

  // TIMESERIES
  if (q.timeseries) parts.push(`TIMESERIES ${q.timeseries}`);

  // PREDICT
  if (q.predict) parts.push('PREDICT');

  return parts.join(' ');
}

function emitDataSource(ds) {
  switch (ds.type) {
    case 'EventType':
      return ds.names.join(', ');
    case 'Lookup':
      return `lookup(${ds.name})`;
    case 'SubquerySource':
      return `(${emitSelectQuery(ds.query)})`;
    default:
      return 'Log';
  }
}

function emitUnion(node) {
  // NRQL doesn't have UNION — emit as separate queries with warning
  return node.queries.map(emitSelectQuery).join('\n/* UNION */\n');
}

function emitNestedAggregation(node) {
  // Inner query becomes FROM subquery, outer layers wrap around it
  const innerNrql = emitSelectQuery(node.dataQuery);
  let result = node.layers[0];
  result = SelectQuery({
    ...result,
    dataSource: { type: 'SubquerySource', query: node.dataQuery },
  });
  return emitSelectQuery(result);
}
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```
feat: nrql query emitter
```

---

## Chunk 3: Top-level API and V2 test harness

### Task 5: Top-level translateV2 function

**Files:**
- Create: `packages/nr-query-bridge/src/translateV2.js`
- Modify: `packages/nr-query-bridge/src/index.js`

- [ ] **Step 1: Create translateV2 stub**

Create `packages/nr-query-bridge/src/translateV2.js`:

```js
/**
 * V2 translator entry point.
 *
 * SPL string → parse → IR → optimize → emit → NRQL string
 *
 * Currently a stub that returns empty results.
 * Phase 2 will implement the SPL AST → IR translation.
 */
import parser from './input/spl/splParser';
import { emitQuery } from './output/nrql/irToNrql';
import { SelectQuery } from './ir/nodes';

export function translateSplToNrqlV2(spl) {
  if (!spl || !spl.trim()) {
    return { nrql: '', warnings: [], unsupported: [], errors: [] };
  }

  // Phase 2 will replace this with real AST → IR translation
  try {
    parser.parse(spl);
  } catch (e) {
    return {
      nrql: '',
      warnings: [],
      unsupported: [],
      errors: [`Failed to parse SPL: ${e.message}`],
    };
  }

  // Stub: return empty query
  const ir = SelectQuery();
  return {
    nrql: emitQuery(ir),
    warnings: ['V2 translator stub — not yet implemented'],
    unsupported: [],
    errors: [],
  };
}
```

- [ ] **Step 2: Export from index.js**

Add to `packages/nr-query-bridge/src/index.js`:

```js
export { translateSplToNrqlV2 } from './translateV2';
export { emitQuery, emitExpr } from './output/nrql/irToNrql';
export * from './ir/nodes';
```

- [ ] **Step 3: Commit**

```
feat: v2 translator stub and public exports
```

### Task 6: V1 vs V2 comparison harness

**Files:**
- Modify: `packages/nr-query-bridge/test/spl/spl.test.js`

- [ ] **Step 1: Add V2 comparison section to test file**

Append to the end of `spl.test.js` (before the final `afterAll`):

```js
// ── V1 vs V2 comparison harness ─────────────────────────────
//
// Runs both translators on every real-world query and categorizes:
//   match       — same output (green)
//   improvement — V2 works where V1 had parse error (green)
//   divergence  — both work but differ (flag for review)
//   regression  — V2 errors but V1 worked (red)

import { translateSplToNrqlV2 } from '../../src/translateV2';

const v2Stats = { match: 0, improvement: 0, divergence: 0, regression: 0, v2Stub: 0 };

describe('V1 vs V2 comparison', () => {
  realWorldEntries.forEach((entry, i) => {
    it(`[${i}] ${entry.spl.slice(0, 60)}`, () => {
      const v1 = translateSplToNrql(entry.spl);
      const v1Nrql = assembleNrql(v1) || null;

      const v2 = translateSplToNrqlV2(entry.spl);
      const v2Nrql = v2.nrql || null;

      // Categorize
      if (v2.warnings.includes('V2 translator stub — not yet implemented')) {
        v2Stats.v2Stub++;
        return; // Skip stub results
      }

      if (v2.errors.length > 0 && v1.errors.length === 0) {
        v2Stats.regression++;
        // Regressions are failures — uncomment to enforce:
        // expect(v2.errors).toEqual([]);
      } else if (v1.errors.length > 0 && v2.errors.length === 0) {
        v2Stats.improvement++;
      } else if (v1Nrql === v2Nrql) {
        v2Stats.match++;
      } else {
        v2Stats.divergence++;
      }
    });
  });
});
```

Update the `afterAll` to include V2 stats:

```js
afterAll(() => {
  const total = realWorldEntries.length;
  console.log(
    `\n  Real-world: ${total} queries — ${realWorldStats.parseErrors} parse errors, ` +
      `${realWorldStats.unsupported} unsupported, ${realWorldStats.warnings} warnings only, ` +
      `${realWorldStats.clean} clean\n`,
  );
  console.log(
    `  V2 comparison: ${v2Stats.match} match, ${v2Stats.improvement} improvement, ` +
      `${v2Stats.divergence} divergence, ${v2Stats.regression} regression, ` +
      `${v2Stats.v2Stub} stub\n`,
  );
});
```

- [ ] **Step 2: Run tests, verify V2 harness works**

Run: `ASDF_NODEJS_VERSION=20.19.0 packages/nr-query-bridge/node_modules/.bin/jest --no-coverage --config packages/nr-query-bridge/jest.config.js`

Expected: All 767 V1 tests pass. V2 comparison shows 339 stubs (all queries hit the stub).

- [ ] **Step 3: Commit**

```
feat: v1 vs v2 comparison test harness
```

---

## Success Criteria

1. `packages/nr-query-bridge/src/ir/nodes.js` exports all IR node constructors
2. `packages/nr-query-bridge/src/output/nrql/irToNrql.js` emits valid NRQL from IR trees
3. Hand-built IR → NRQL emission tested for: simple SELECT, WHERE, FACET, WITH, JOIN, ORDER BY, LIMIT, TIMESERIES, PREDICT, subquery, nested aggregation
4. V2 stub parses SPL and returns placeholder results
5. V1 vs V2 comparison harness categorizes every real-world query
6. All existing 767 V1 tests still pass
