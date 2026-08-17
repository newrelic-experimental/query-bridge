/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createDashboardModel, createWidget, VIZ_TYPES } from '../src/model.js';

describe('createDashboardModel', () => {
  it('builds a model with defaults for omitted fields', () => {
    const m = createDashboardModel({ title: 'My Dash' });
    expect(m.title).toBe('My Dash');
    expect(m.description).toBe('');
    expect(m.sourceFormat).toBe('simple-xml');
    expect(m.variables).toEqual([]);
    expect(m.defaultTimeRange).toBeNull();
    expect(m.widgets).toEqual([]);
  });
});

describe('createWidget', () => {
  it('builds a widget carrying vizType, rawSpl, and layout', () => {
    const w = createWidget({
      title: 'Errors',
      vizType: 'line',
      rawSpl: 'index=web | timechart count',
      layout: { x: 0, y: 0, w: 6, h: 3 },
    });
    expect(w.title).toBe('Errors');
    expect(w.vizType).toBe('line');
    expect(w.rawSpl).toBe('index=web | timechart count');
    expect(w.baseRef).toBeNull();
    expect(w.options).toEqual({});
    expect(w.layout).toEqual({ x: 0, y: 0, w: 6, h: 3 });
  });
});

describe('VIZ_TYPES', () => {
  it('is the frozen neutral enum', () => {
    expect(VIZ_TYPES).toContain('line');
    expect(VIZ_TYPES).toContain('table');
    expect(VIZ_TYPES).toContain('billboard');
    expect(VIZ_TYPES).toContain('markdown');
    expect(VIZ_TYPES).toContain('unknown');
    expect(Object.isFrozen(VIZ_TYPES)).toBe(true);
  });
});
