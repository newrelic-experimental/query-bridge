/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  escapeAttributeNameForNrql,
  escapeStringLiteralForNrql,
  escapeStringWildcardForNrql,
  escapeRegexPatternForNrql,
  formatJsonPathForNrql,
} from '../../src/output/nrql/nrqlEncoding.js';

describe('escapeAttributeNameForNrql', () => {
  it('escapes a backtick with a backslash', () => {
    expect(escapeAttributeNameForNrql('a`b')).toBe('a\\`b');
  });
  it('escapes a backslash by doubling it', () => {
    expect(escapeAttributeNameForNrql('a\\b')).toBe('a\\\\b');
  });
  it('escapes a newline control character', () => {
    expect(escapeAttributeNameForNrql('a\nb')).toBe('a\\nb');
  });
  it('leaves a plain name unchanged', () => {
    expect(escapeAttributeNameForNrql('plain_name')).toBe('plain_name');
  });
});

describe('escapeStringLiteralForNrql', () => {
  it('escapes a single quote with a backslash', () => {
    expect(escapeStringLiteralForNrql("a'b")).toBe("a\\'b");
  });
  it('escapes a backslash by doubling it', () => {
    expect(escapeStringLiteralForNrql('a\\b')).toBe('a\\\\b');
  });
  it('escapes a tab control character', () => {
    expect(escapeStringLiteralForNrql('a\tb')).toBe('a\\tb');
  });
  it('returns a non-string number unchanged', () => {
    expect(escapeStringLiteralForNrql(42)).toBe(42);
  });
  it('returns null unchanged', () => {
    expect(escapeStringLiteralForNrql(null)).toBeNull();
  });
});

describe('escapeStringWildcardForNrql', () => {
  it('escapes a percent wildcard character', () => {
    expect(escapeStringWildcardForNrql('a%b')).toBe('a\\%b');
  });
  it('escapes a single quote', () => {
    expect(escapeStringWildcardForNrql("a'b")).toBe("a\\'b");
  });
  it('escapes a backslash by doubling it', () => {
    expect(escapeStringWildcardForNrql('a\\b')).toBe('a\\\\b');
  });
});

describe('escapeRegexPatternForNrql', () => {
  it('escapes a single quote inside the pattern', () => {
    expect(escapeRegexPatternForNrql("it's")).toBe("it\\'s");
  });
  it('does NOT double the pattern own backslashes (regex semantics preserved)', () => {
    expect(escapeRegexPatternForNrql('\\d+')).toBe('\\d+');
  });
  it('returns a non-string value unchanged', () => {
    expect(escapeRegexPatternForNrql(42)).toBe(42);
  });
});

describe('formatJsonPathForNrql', () => {
  it('leaves a dotted path of plain keys unchanged', () => {
    expect(formatJsonPathForNrql('meta.responseTime')).toBe(
      'meta.responseTime',
    );
  });
  it('leaves plain keys with array indexes unchanged', () => {
    expect(formatJsonPathForNrql('reservations[*].system')).toBe(
      'reservations[*].system',
    );
  });
  it('brackets every key when one key contains a hyphen', () => {
    expect(formatJsonPathForNrql('csp-report.blocked-uri')).toBe(
      '["csp-report"]["blocked-uri"]',
    );
  });
  it('brackets plain keys too when any key is not plain (no mixing)', () => {
    expect(formatJsonPathForNrql('x-region[*].a-b.c')).toBe(
      '["x-region"][*]["a-b"]["c"]',
    );
  });
  it('keeps a numeric index in the bracketed form', () => {
    expect(formatJsonPathForNrql('x-region[0].c')).toBe('["x-region"][0]["c"]');
  });
  it('brackets a key containing a space', () => {
    expect(formatJsonPathForNrql('body.Some Name[*]')).toBe(
      '["body"]["Some Name"][*]',
    );
  });
  it('escapes a double quote inside a bracketed key', () => {
    expect(formatJsonPathForNrql('a-"b')).toBe('["a-\\"b"]');
  });
  it('leaves an already-bracketed path unchanged', () => {
    expect(formatJsonPathForNrql('["a.b"]')).toBe('["a.b"]');
  });
});
