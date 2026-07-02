import { describe, it, expect } from 'vitest';
import { splFormatToJava } from '../../src/input/spl/splFormatCodes.js';

describe('splFormatToJava', () => {
  it('maps the core date codes', () => {
    expect(splFormatToJava('%Y-%m-%d').pattern).toBe('yyyy-MM-dd');
  });

  it('maps the core time codes', () => {
    expect(splFormatToJava('%H:%M:%S').pattern).toBe('HH:mm:ss');
  });

  it('maps the long tail (DDD/zzz/Z/yy/MMMM/EEEE/a)', () => {
    expect(splFormatToJava('%j %Z %z %y %B %A %p').pattern).toBe(
      'DDD zzz Z yy MMMM EEEE a',
    );
  });

  it('maps sub-second width variants', () => {
    expect(splFormatToJava('%H:%M:%S.%3N').pattern).toBe('HH:mm:ss.SSS');
    expect(splFormatToJava('%6N').pattern).toBe('SSSSSS');
    expect(splFormatToJava('%9N').pattern).toBe('SSSSSSSSS');
    expect(splFormatToJava('%N').pattern).toBe('SSSSSSSSS'); // bare = nanos
  });

  it('treats %% as a literal percent (quoted, so no bare % survives)', () => {
    expect(splFormatToJava('%Y%%').pattern).toBe("yyyy'%'");
  });

  it('quotes literal letters so they are not pattern tokens', () => {
    expect(splFormatToJava('%Y GMT').pattern).toBe("yyyy 'GMT'");
  });

  it('passes non-letter literals through unquoted', () => {
    expect(splFormatToJava('%Y/%m').pattern).toBe('yyyy/MM');
  });

  it('escapes a literal single quote as two single quotes', () => {
    expect(splFormatToJava("%H o'clock").pattern).toBe("HH 'o''clock'");
  });

  it('collects unmappable codes and still returns a (partial) pattern', () => {
    const r = splFormatToJava('%Y %s %c');
    expect(r.unmappable).toEqual(['%s', '%c']);
  });

  it('reports no unmappable codes for a fully-mapped format', () => {
    expect(splFormatToJava('%Y-%m-%d %H:%M:%S').unmappable).toEqual([]);
  });
});
