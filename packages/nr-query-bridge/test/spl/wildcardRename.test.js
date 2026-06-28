import { describe, it, expect } from 'vitest';
import {
  recognizeWildcardRename,
  collectRefs,
} from '../../src/input/spl/wildcardRename.js';
import {
  SelectQuery,
  Identifier,
  Func,
  BinOp,
  Literal,
} from '../../src/ir/nodes.js';

describe('recognizeWildcardRename', () => {
  it('recognizes a leading-prefix strip and returns the dotted affix', () => {
    expect(recognizeWildcardRename('log.*', '*')).toEqual({
      direction: 'strip',
      affix: 'log.',
    });
  });
  it('recognizes a deeper-prefix strip', () => {
    expect(recognizeWildcardRename('meta.annotations.*', '*')).toEqual({
      direction: 'strip',
      affix: 'meta.annotations.',
    });
  });
  it('rejects a mid-string wildcard (a.*.b as *)', () => {
    expect(recognizeWildcardRename('a.*.b', '*')).toBe(null);
  });
  it('rejects multiple wildcards in the source', () => {
    expect(recognizeWildcardRename('a.*.*', '*')).toBe(null);
  });
  it('rejects a bare * as * (nothing to strip)', () => {
    expect(recognizeWildcardRename('*', '*')).toBe(null);
  });
  it('recognizes the re-prefix shape', () => {
    expect(recognizeWildcardRename('*', 'fld_*')).toEqual({
      direction: 'reprefix',
      affix: 'fld_',
    });
  });
  it('rejects a mid-string wildcard in the re-prefix target', () => {
    expect(recognizeWildcardRename('*', 'fld_*_x')).toBe(null);
  });
});

describe('collectRefs', () => {
  it('collects identifier names from select/where/facet', () => {
    const ir = SelectQuery({
      select: [Func('count', [])],
      where: [BinOp('=', Identifier('status'), Literal('500', 'string'))],
      facet: [Identifier('host')],
    });
    expect(collectRefs(ir)).toEqual(new Set(['status', 'host']));
  });
  it('collects from binding expressions but not the alias name itself', () => {
    const ir = SelectQuery({
      bindings: [
        { name: 'lvl', expr: Func('upper', [Identifier('severity')]) },
      ],
    });
    expect(collectRefs(ir)).toEqual(new Set(['severity'])); // 'lvl' is a binding NAME, not a ref
  });
  it('returns an empty set for a bare query', () => {
    expect(collectRefs(SelectQuery())).toEqual(new Set());
  });
});
