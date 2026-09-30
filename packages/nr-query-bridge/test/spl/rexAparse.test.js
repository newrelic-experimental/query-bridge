/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { formatRexAsAparse } from '../../src/input/spl/rexAparse.js';

describe('formatRexAsAparse', () => {
  it('turns a negated class read up to its stop character into %anchor*stop%', () => {
    expect(formatRexAsAparse('"bookingId":"(?<id>[^"]+)"')).toBe(
      '%"bookingId":"*"%',
    );
  });

  it('accepts escaped punctuation as literal anchor text', () => {
    expect(formatRexAsAparse('email\\":\\"(?<e>[^\\"]+)\\"')).toBe(
      '%email":"*"%',
    );
  });

  it('turns a lazy .*? group followed by literal text into *', () => {
    expect(formatRexAsAparse('name=(?<n>.*?);')).toBe('%name=*;%');
  });

  it('keeps several groups in order', () => {
    expect(formatRexAsAparse('a=(?<a>[^,]+),b=(?<b>[^,]+),')).toBe(
      '%a=*,b=*,%',
    );
  });

  it('drops the leading % for a pattern anchored with ^', () => {
    expect(formatRexAsAparse('^id=(?<id>[^ ]+) ')).toBe('id=* %');
  });

  it('drops the trailing % for a pattern anchored with $', () => {
    expect(formatRexAsAparse('id=(?<id>[^;]+);$')).toBe('%id=*;');
  });

  it('refuses a group whose stop character is not the next literal', () => {
    expect(formatRexAsAparse('id=(?<id>[^"]+),')).toBeNull();
  });

  it('refuses a group with nothing after it to end the capture', () => {
    expect(formatRexAsAparse('id=(?<id>[^"]+)')).toBeNull();
  });

  it('refuses a group body other than a negated class or lazy dot', () => {
    expect(formatRexAsAparse('id=(?<id>\\d+);')).toBeNull();
  });

  it('refuses a group with no anchor text before it', () => {
    expect(formatRexAsAparse('(?<id>[^;]+);')).toBeNull();
  });

  it('refuses a regex escape such as \\t in the anchor text', () => {
    expect(formatRexAsAparse('ERROR\\t(?<c>[^ ]+) ')).toBeNull();
  });

  it("refuses anchor text containing aparse's own % wildcard", () => {
    expect(formatRexAsAparse('pct=100%(?<x>[^;]+);')).toBeNull();
  });

  it('refuses a pattern with no named group', () => {
    expect(formatRexAsAparse('error;')).toBeNull();
  });
});
