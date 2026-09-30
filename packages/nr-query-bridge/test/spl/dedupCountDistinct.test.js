/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isDedupCountDistinct } from '../../src/input/spl/dedupCountDistinct.js';

const dedupId = { type: 'DedupCommand', count: 1, fields: ['id'] };

describe('isDedupCountDistinct', () => {
  it('accepts dedup followed directly by a bare count', () => {
    const stats = {
      type: 'StatsCommand',
      functions: [{ name: 'count', args: [] }],
      groupBy: ['host'],
    };
    expect(isDedupCountDistinct(dedupId, [stats])).toBe(true);
  });

  it('accepts count(*) in a timechart', () => {
    const timechart = {
      type: 'TimechartCommand',
      functions: [{ name: 'count', args: ['*'] }],
      groupBy: [],
    };
    expect(isDedupCountDistinct(dedupId, [timechart])).toBe(true);
  });

  it('accepts where, search, join, bin and a non-key eval before the count', () => {
    const downstream = [
      { type: 'WhereCommand', expression: {} },
      { type: 'SearchCommand', expression: {} },
      { type: 'JoinCommand', field: 'id', subsearch: 'search x' },
      { type: 'BinCommand', field: '_time', span: '1h' },
      { type: 'EvalCommand', assignments: [{ field: 's', expr: 'status' }] },
      { type: 'ChartCommand', functions: [{ name: 'count', args: [] }] },
    ];
    expect(isDedupCountDistinct(dedupId, downstream)).toBe(true);
  });

  it('rejects dedup N (keeps N rows per key)', () => {
    const stats = {
      type: 'StatsCommand',
      functions: [{ name: 'count', args: [] }],
    };
    expect(isDedupCountDistinct({ ...dedupId, count: 3 }, [stats])).toBe(false);
  });

  it('rejects multi-key dedup', () => {
    const stats = {
      type: 'StatsCommand',
      functions: [{ name: 'count', args: [] }],
    };
    expect(
      isDedupCountDistinct({ ...dedupId, fields: ['id', 'host'] }, [stats]),
    ).toBe(false);
  });

  it('rejects count(field), which counts non-null values', () => {
    const stats = {
      type: 'StatsCommand',
      functions: [{ name: 'count', args: ['status'] }],
    };
    expect(isDedupCountDistinct(dedupId, [stats])).toBe(false);
  });

  it('rejects count(eval(...)), a filtered count', () => {
    const stats = {
      type: 'StatsCommand',
      functions: [{ name: 'count', args: [], evalFilter: {} }],
    };
    expect(isDedupCountDistinct(dedupId, [stats])).toBe(false);
  });

  it('rejects an aggregation mixing count with another function', () => {
    const stats = {
      type: 'StatsCommand',
      functions: [
        { name: 'count', args: [] },
        { name: 'avg', args: ['duration'] },
      ],
    };
    expect(isDedupCountDistinct(dedupId, [stats])).toBe(false);
  });

  it('rejects an eval that reassigns the dedup key', () => {
    const downstream = [
      { type: 'EvalCommand', assignments: [{ field: 'id', expr: 'x' }] },
      { type: 'StatsCommand', functions: [{ name: 'count', args: [] }] },
    ];
    expect(isDedupCountDistinct(dedupId, downstream)).toBe(false);
  });

  it('rejects a raw-text eval it cannot inspect', () => {
    const downstream = [
      { type: 'EvalCommand', assignments: [], rawText: 'x=?' },
      { type: 'StatsCommand', functions: [{ name: 'count', args: [] }] },
    ];
    expect(isDedupCountDistinct(dedupId, downstream)).toBe(false);
  });

  it('rejects a bin of the dedup key', () => {
    const downstream = [
      { type: 'BinCommand', field: 'id', width: 10 },
      { type: 'StatsCommand', functions: [{ name: 'count', args: [] }] },
    ];
    expect(isDedupCountDistinct(dedupId, downstream)).toBe(false);
  });

  it('rejects a command outside the row-wise allowlist', () => {
    const downstream = [
      { type: 'HeadCommand', count: 5 },
      { type: 'StatsCommand', functions: [{ name: 'count', args: [] }] },
    ];
    expect(isDedupCountDistinct(dedupId, downstream)).toBe(false);
  });

  it('rejects a dedup with no aggregation after it', () => {
    expect(
      isDedupCountDistinct(dedupId, [{ type: 'WhereCommand', expression: {} }]),
    ).toBe(false);
  });
});
