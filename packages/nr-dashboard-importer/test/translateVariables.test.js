/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  translateVariables,
  singleFacetField,
} from '../src/translateVariables.js';
import { createVariable } from '../src/model.js';

describe('singleFacetField', () => {
  it('returns the field for a single FACET', () => {
    expect(singleFacetField('FROM Log SELECT count(*) FACET host')).toBe(
      'host',
    );
  });

  it('returns the field when a LIMIT follows the FACET', () => {
    expect(singleFacetField('FROM Log SELECT host FACET host LIMIT MAX')).toBe(
      'host',
    );
  });

  it('returns null for multiple FACET fields', () => {
    expect(
      singleFacetField('FROM Log SELECT count(*) FACET host, region'),
    ).toBeNull();
  });

  it('returns null when there is no FACET', () => {
    expect(singleFacetField('FROM Log SELECT count(*)')).toBeNull();
  });
});

describe('translateVariables — search-backed dropdowns', () => {
  it('turns a single-field search-backed dropdown into a type="nrql" variable', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If it fails, dynamic-dropdown
    // translation regressed — fix the code, not the test.
    const v = createVariable({
      name: 'host',
      type: 'enum',
      sourceQuery: 'index=app | stats count by host',
    });
    const [out] = translateVariables([v]);
    expect(out.type).toBe('nrql');
    expect(out.sourceQuery).toMatch(/FACET host$/);
  });

  it('keeps a multi-field search-backed dropdown without static choices as a string variable', () => {
    // AI-DEV: AI **MUST NOT** touch this test. A dropdown we cannot reduce to a
    // single field must degrade safely, never to an invalid empty enum.
    const v = createVariable({
      name: 'hr',
      type: 'enum',
      sourceQuery: 'index=app | stats count by host, region',
    });
    const [out] = translateVariables([v]);
    expect(out.type).toBe('string');
  });

  it('keeps a static enum (with choices) when its source query is multi-field', () => {
    const v = createVariable({
      name: 'hr',
      type: 'enum',
      choices: [{ value: 'a', title: 'A' }],
      sourceQuery: 'index=app | stats count by host, region',
    });
    const [out] = translateVariables([v]);
    expect(out.type).toBe('enum');
    expect(out.choices).toHaveLength(1);
  });

  it('leaves a static enum and a text variable untouched', () => {
    const enumVar = createVariable({
      name: 'env',
      type: 'enum',
      choices: [{ value: '*', title: 'All' }],
    });
    const textVar = createVariable({ name: 'q', type: 'string' });
    const out = translateVariables([enumVar, textVar]);
    expect(out[0].type).toBe('enum');
    expect(out[1].type).toBe('string');
  });
});
