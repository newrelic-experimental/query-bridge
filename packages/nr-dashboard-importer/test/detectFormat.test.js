import { describe, it, expect } from 'vitest';
import { detectFormat } from '../src/detectFormat.js';

describe('detectFormat', () => {
  it('detects <form> as simple-xml', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.
    expect(detectFormat('<form>\n<label>X</label>\n</form>')).toBe(
      'simple-xml',
    );
  });

  it('detects <dashboard version="1.1"> as simple-xml', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.
    expect(
      detectFormat('<dashboard version="1.1"><label>X</label></dashboard>'),
    ).toBe('simple-xml');
  });

  it('detects a leading-whitespace / xml-decl prefixed <form> as simple-xml', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.
    expect(
      detectFormat('<?xml version="1.0"?>\n  <form><label>X</label></form>'),
    ).toBe('simple-xml');
  });

  it('throws a clear error for a Studio v2 dashboard (Phase 3, not yet supported)', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.
    expect(() =>
      detectFormat(
        '<dashboard version="2"><definition><![CDATA[{}]]></definition></dashboard>',
      ),
    ).toThrow(/Dashboard Studio.*Phase 3/);
  });

  it('throws a clear error for a REST envelope (Phase 2, not yet supported)', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.
    expect(() =>
      detectFormat('{"entry":[{"content":{"eai:data":"<form/>"}}]}'),
    ).toThrow(/REST envelope.*Phase 2/);
  });
});
