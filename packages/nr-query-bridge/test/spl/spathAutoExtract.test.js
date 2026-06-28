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

  it('returns null when a stats function reads a bare field (would leave it unbound)', () => {
    const stats = {
      type: 'StatsCommand',
      functions: [
        { name: 'sum', args: ['bytes'], alias: null, evalFilter: null },
      ],
      groupBy: ['status'],
    };
    expect(collectAutoExtractFields([stats])).toBeNull();
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

  it('returns null when count reads a real field (count(host) is not field-free)', () => {
    expect(
      collectAutoExtractFields([
        {
          type: 'StatsCommand',
          functions: [{ name: 'count', args: ['host'] }],
          groupBy: ['status'],
        },
      ]),
    ).toBeNull();
  });
});
