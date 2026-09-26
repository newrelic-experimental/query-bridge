/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { collectAutoExtractFields } from '../../src/input/spl/spathAutoExtract.js';

const statsCountBy = (groupBy) => ({
  type: 'StatsCommand',
  functions: [{ name: 'count', args: [], alias: null, evalFilter: null }],
  groupBy,
});

describe('collectAutoExtractFields', () => {
  it('returns null for an empty downstream (spath is the last command)', () => {
    expect(collectAutoExtractFields([])).toBeNull();
  });

  it('collects stats `by` fields when every function is a field-free count', () => {
    expect(collectAutoExtractFields([statsCountBy(['status'])])).toEqual([
      'status',
    ]);
  });

  it('collects a where comparison field', () => {
    const where = {
      type: 'WhereCommand',
      expression: { type: 'Comparison', field: 'code', operator: '=' },
    };
    expect(collectAutoExtractFields([where, statsCountBy([])])).toEqual([
      'code',
    ]);
  });

  it('walks a boolean where tree and de-duplicates fields', () => {
    const where = {
      type: 'WhereCommand',
      expression: {
        type: 'BooleanOp',
        left: { type: 'Comparison', field: 'code', operator: '=' },
        right: { type: 'Comparison', field: 'code', operator: '!=' },
      },
    };
    expect(collectAutoExtractFields([where])).toEqual(['code']);
  });

  it('returns null for `table *` (auto-extract-all, no enumerable reference)', () => {
    expect(
      collectAutoExtractFields([{ type: 'TableCommand', fields: ['*'] }]),
    ).toBeNull();
  });

  it('binds a field a stats function reads, alongside the by fields', () => {
    const stats = {
      type: 'StatsCommand',
      functions: [
        { name: 'sum', args: ['bytes'], alias: null, evalFilter: null },
      ],
      groupBy: ['status'],
    };
    expect(collectAutoExtractFields([stats])).toEqual(['bytes', 'status']);
  });

  it('collects a search pipe comparison field', () => {
    const search = {
      type: 'SearchCommand',
      expression: { type: 'Comparison', field: 'tenant', operator: '=' },
    };
    expect(collectAutoExtractFields([search, statsCountBy([])])).toEqual([
      'tenant',
    ]);
  });

  it('collects eval references but not the name the eval defines', () => {
    const evalCmd = {
      type: 'EvalCommand',
      assignments: [{ field: 'z', expr: 'tenant' }],
    };
    expect(collectAutoExtractFields([evalCmd, statsCountBy(['z'])])).toEqual([
      'tenant',
    ]);
  });

  it('collects table fields', () => {
    expect(
      collectAutoExtractFields([
        { type: 'TableCommand', fields: ['tenant', 'region'] },
      ]),
    ).toEqual(['tenant', 'region']);
  });

  it('collects dedup, sort and top fields', () => {
    expect(
      collectAutoExtractFields([
        { type: 'DedupCommand', fields: ['tenant'] },
        { type: 'SortCommand', fields: [{ field: 'ts', direction: 'desc' }] },
        { type: 'TopCommand', fields: ['a{}.c'], groupBy: [] },
      ]),
    ).toEqual(['tenant', 'ts', 'a{}.c']);
  });

  it('does not bind Splunk default fields such as index or host', () => {
    const where = {
      type: 'WhereCommand',
      expression: { type: 'Comparison', field: 'index', operator: '=' },
    };
    expect(
      collectAutoExtractFields([where, statsCountBy(['host'])]),
    ).toBeNull();
  });

  it('stops at the first aggregation (later references are aggregated columns)', () => {
    const where = {
      type: 'WhereCommand',
      expression: { type: 'Comparison', field: 'count', operator: '>' },
    };
    expect(collectAutoExtractFields([statsCountBy(['status']), where])).toEqual(
      ['status'],
    );
  });

  it('returns null for a wildcard field in a table', () => {
    expect(
      collectAutoExtractFields([{ type: 'TableCommand', fields: ['Totals*'] }]),
    ).toBeNull();
  });

  it('returns null for any non-enumerable downstream command type', () => {
    expect(
      collectAutoExtractFields([{ type: 'RexCommand', field: '_raw' }]),
    ).toBeNull();
  });

  it('returns null when a where tree contains a non-comparison node', () => {
    const where = {
      type: 'WhereCommand',
      expression: { type: 'FuncComparison', name: 'cidrmatch' },
    };
    expect(collectAutoExtractFields([where])).toBeNull();
  });

  it('returns null when stats has no `by` and contributes no fields', () => {
    expect(collectAutoExtractFields([statsCountBy([])])).toBeNull();
  });

  it('treats count(*) (string arg) as a field-free count', () => {
    expect(
      collectAutoExtractFields([
        {
          type: 'StatsCommand',
          functions: [{ name: 'count', args: ['*'] }],
          groupBy: ['status'],
        },
      ]),
    ).toEqual(['status']);
  });

  it('treats count(*) (object-wrapped wildcard) as a field-free count', () => {
    expect(
      collectAutoExtractFields([
        {
          type: 'StatsCommand',
          functions: [{ name: 'count', args: [{ name: '*' }] }],
          groupBy: ['status'],
        },
      ]),
    ).toEqual(['status']);
  });

  it('binds a JSON field that count() reads', () => {
    expect(
      collectAutoExtractFields([
        {
          type: 'StatsCommand',
          functions: [{ name: 'count', args: ['reqId'] }],
          groupBy: ['status'],
        },
      ]),
    ).toEqual(['reqId', 'status']);
  });

  it('collects fields from a stats count(eval(...)) filter', () => {
    expect(
      collectAutoExtractFields([
        {
          type: 'StatsCommand',
          functions: [
            {
              name: 'count',
              args: [],
              evalFilter: {
                type: 'EvalComparison',
                op: '=',
                left: 'level',
                right: { type: 'StringLiteral', value: 'error' },
              },
            },
          ],
          groupBy: [],
        },
      ]),
    ).toEqual(['level']);
  });

  it('collects eventstats function and by fields', () => {
    expect(
      collectAutoExtractFields([
        {
          type: 'EventstatsCommand',
          functions: [{ name: 'avg', args: ['latency'] }],
          groupBy: ['svc'],
        },
      ]),
    ).toEqual(['latency', 'svc']);
  });

  it('collects rare field and by fields', () => {
    expect(
      collectAutoExtractFields([
        { type: 'RareCommand', field: 'code', groupBy: ['svc'] },
      ]),
    ).toEqual(['code', 'svc']);
  });

  it('collects fields list fields', () => {
    expect(
      collectAutoExtractFields([{ type: 'FieldsCommand', fields: ['a', 'b'] }]),
    ).toEqual(['a', 'b']);
  });

  it('collects a rename source but not its target', () => {
    expect(
      collectAutoExtractFields([
        { type: 'RenameCommand', renames: [{ from: 'usr', to: 'user' }] },
        statsCountBy(['user']),
      ]),
    ).toEqual(['usr']);
  });

  it('passes over head, tail and reverse', () => {
    expect(
      collectAutoExtractFields([
        { type: 'HeadCommand', count: 5 },
        { type: 'TailCommand', count: 5 },
        { type: 'ReverseCommand' },
        statsCountBy(['svc']),
      ]),
    ).toEqual(['svc']);
  });

  it('returns null for an eval body the ladder could not parse', () => {
    expect(
      collectAutoExtractFields([
        { type: 'EvalCommand', assignments: [], rawText: 'x = a LIKE b' },
      ]),
    ).toBeNull();
  });

  it('walks every eval expression node type', () => {
    const expr = {
      type: 'EvalBoolOp',
      op: 'AND',
      left: {
        type: 'EvalNot',
        operand: {
          type: 'EvalParens',
          inner: {
            type: 'EvalArith',
            op: '+',
            left: 'a',
            right: '1',
          },
        },
      },
      right: {
        type: 'EvalFunc',
        name: 'len',
        args: ['b', { type: 'StringLiteral', value: 'x' }],
      },
    };
    expect(
      collectAutoExtractFields([
        { type: 'EvalCommand', assignments: [{ field: 'z', expr }] },
      ]),
    ).toEqual(['a', 'b']);
  });

  it('returns null for an eval expression node it does not understand', () => {
    expect(
      collectAutoExtractFields([
        {
          type: 'EvalCommand',
          assignments: [{ field: 'z', expr: { type: 'Mystery' } }],
        },
      ]),
    ).toBeNull();
  });

  it('walks NOT, IN, function calls and field-free search nodes', () => {
    const search = {
      type: 'SearchCommand',
      expression: {
        type: 'BooleanOp',
        left: {
          type: 'Not',
          operand: { type: 'InComparison', field: 'region', values: ['x'] },
        },
        right: {
          type: 'BooleanOp',
          left: { type: 'BareKeyword', value: 'timeout' },
          right: {
            type: 'BooleanOp',
            left: { type: 'ConstComparison' },
            right: {
              type: 'BooleanOp',
              left: { type: 'TimeConstraint', param: 'earliest' },
              right: { type: 'FunctionCall', name: 'isnull', args: ['uid'] },
            },
          },
        },
      },
    };
    expect(collectAutoExtractFields([search])).toEqual(['region', 'uid']);
  });

  it('collects fields on a where comparison right-hand side', () => {
    const where = {
      type: 'WhereCommand',
      expression: {
        type: 'Comparison',
        field: 'used',
        operator: '>',
        rhsExpr: 'quota',
      },
    };
    expect(collectAutoExtractFields([where])).toEqual(['used', 'quota']);
  });

  it('returns null for a where comparison with no field name', () => {
    const where = {
      type: 'WhereCommand',
      expression: { type: 'Comparison', field: '', operator: '=' },
    };
    expect(collectAutoExtractFields([where])).toBeNull();
  });

  it('returns null for a search node it does not understand', () => {
    expect(
      collectAutoExtractFields([
        { type: 'SearchCommand', expression: { type: 'Macro', name: 'm' } },
      ]),
    ).toBeNull();
  });

  it('returns null for a stats-column name in a table', () => {
    expect(
      collectAutoExtractFields([{ type: 'TableCommand', fields: ['max(b)'] }]),
    ).toBeNull();
  });

  it('returns null when a stats aggregation contributes a wildcard field', () => {
    expect(
      collectAutoExtractFields([
        {
          type: 'StatsCommand',
          functions: [{ name: 'sum', args: ['tcp.*'] }],
          groupBy: ['svc'],
        },
      ]),
    ).toBeNull();
  });

  it('returns null when top is fed only default fields', () => {
    expect(
      collectAutoExtractFields([
        { type: 'TopCommand', fields: ['host'], groupBy: [] },
      ]),
    ).toBeNull();
  });
});
