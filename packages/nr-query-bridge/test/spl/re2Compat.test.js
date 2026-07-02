import { describe, it, expect } from 'vitest';
import {
  getRe2Compatibility,
  resolveConstructMessageKey,
} from '../../src/input/spl/re2Compat.js';

describe('getRe2Compatibility', () => {
  // ── Fidelity gate: these accept/reject verdicts are the staging-verified
  // capture() behaviour (spec §"Pre-adoption gate"). If re2js ever diverges,
  // this suite fails and the gate is no longer trustworthy.
  it('accepts a plain named-group pattern', () => {
    expect(getRe2Compatibility('user=(?P<user_id>\\w+)').compatible).toBe(true);
  });
  it('accepts a bare inline flag', () => {
    expect(getRe2Compatibility('(?i)foo(?P<a>\\w+)').compatible).toBe(true);
  });
  it('accepts a scoped inline flag', () => {
    expect(getRe2Compatibility('(?i:foo)(?P<a>\\w+)').compatible).toBe(true);
  });
  it('accepts an escaped backslash followed by a digit (not a backref)', () => {
    expect(getRe2Compatibility('a\\\\1b').compatible).toBe(true);
  });
  it('rejects a numbered backreference and reports a reason', () => {
    const r = getRe2Compatibility('(?P<a>\\w+)=\\1');
    expect(r.compatible).toBe(false);
    expect(r.reason).toBeTruthy();
  });
  it('rejects a backreference inside a character class', () => {
    expect(getRe2Compatibility('x[\\1]y(?P<a>\\w+)').compatible).toBe(false);
  });
  it('rejects lookahead', () => {
    expect(getRe2Compatibility('(?=foo)(?P<a>\\w+)').compatible).toBe(false);
  });
  it('rejects lookbehind', () => {
    expect(getRe2Compatibility('(?<=foo)(?P<a>\\w+)').compatible).toBe(false);
  });
  it('rejects an atomic group', () => {
    expect(getRe2Compatibility('(?>(?P<a>\\w+))').compatible).toBe(false);
  });
  it('rejects a possessive quantifier', () => {
    expect(getRe2Compatibility('(?P<a>\\w++)').compatible).toBe(false);
  });
});

describe('resolveConstructMessageKey', () => {
  it('names a numbered backreference', () => {
    expect(resolveConstructMessageKey('(?P<a>\\w+)=\\1')).toBe(
      'rex_backreference',
    );
  });
  it('names a named backreference (\\k<name>)', () => {
    expect(resolveConstructMessageKey('(?P<a>\\w+)\\k<a>')).toBe(
      'rex_backreference',
    );
  });
  it('names a named backreference ((?P=name))', () => {
    expect(resolveConstructMessageKey('(?P<a>\\w+)(?P=a)')).toBe(
      'rex_backreference',
    );
  });
  it('names an atomic group', () => {
    expect(resolveConstructMessageKey('(?>(?P<a>\\w+))')).toBe(
      'rex_atomic_group',
    );
  });
  it('names a possessive quantifier', () => {
    expect(resolveConstructMessageKey('(?P<a>\\w++)')).toBe(
      'rex_possessive_quantifier',
    );
  });
  it('names a recursion/subroutine reference', () => {
    expect(resolveConstructMessageKey('(?P<a>\\w+)(?1)')).toBe('rex_recursion');
  });
  it('names a conditional', () => {
    expect(resolveConstructMessageKey('(?(1)yes|no)(?P<a>\\w+)')).toBe(
      'rex_conditional',
    );
  });
  it('returns null for a pattern with no known construct', () => {
    expect(resolveConstructMessageKey('plain(?P<a>\\w+)')).toBeNull();
  });
});
