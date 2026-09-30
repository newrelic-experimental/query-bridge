/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseSedScript } from '../../src/input/spl/regexReplace.js';

describe('parseSedScript', () => {
  it('parses a non-global substitution', () => {
    expect(parseSedScript('s/a+/b/')).toEqual({
      pattern: 'a+',
      replacement: 'b',
      global: false,
    });
  });

  it('parses the g flag', () => {
    expect(parseSedScript('s/a/b/g').global).toBe(true);
  });

  it('accepts any non-word delimiter', () => {
    expect(parseSedScript('s#/v1/x/[0-9]+#/v1/x#g')).toEqual({
      pattern: '/v1/x/[0-9]+',
      replacement: '/v1/x',
      global: true,
    });
  });

  it('unescapes an escaped delimiter inside the pattern', () => {
    expect(parseSedScript('s/a\\/b/c/').pattern).toBe('a/b');
  });

  it('keeps other escapes in the pattern for the regex', () => {
    expect(parseSedScript('s/\\d+/N/').pattern).toBe('\\d+');
  });

  it('rejects an Nth-match flag', () => {
    expect(parseSedScript('s/a/b/2')).toBeNull();
  });

  it('rejects a script that is not a substitution', () => {
    expect(parseSedScript('y/abc/xyz/')).toBeNull();
  });

  it('rejects a script with a missing section', () => {
    expect(parseSedScript('s/a/b')).toBeNull();
  });
});
