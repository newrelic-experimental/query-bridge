import { describe, it, expect } from 'vitest';
import { detectFormat } from '../src/detectFormat.js';

describe('detectFormat', () => {
  it('detects <form> as a single simple-xml unit', () => {
    expect(detectFormat('<form>\n<label>X</label>\n</form>')).toEqual([
      { format: 'simple-xml', payload: '<form>\n<label>X</label>\n</form>' },
    ]);
  });

  it('detects <dashboard version="1.1"> as a single simple-xml unit', () => {
    const xml = '<dashboard version="1.1"><label>X</label></dashboard>';
    expect(detectFormat(xml)).toEqual([{ format: 'simple-xml', payload: xml }]);
  });

  it('detects a leading-whitespace / xml-decl prefixed <form> as simple-xml', () => {
    const xml = '<?xml version="1.0"?>\n  <form><label>X</label></form>';
    expect(detectFormat(xml)).toEqual([{ format: 'simple-xml', payload: xml }]);
  });

  it('throws a clear error for a Studio v2 dashboard (Phase 3, not yet supported)', () => {
    expect(() =>
      detectFormat(
        '<dashboard version="2"><definition><![CDATA[{}]]></definition></dashboard>',
      ),
    ).toThrow(/Dashboard Studio.*Phase 3/);
  });

  it('throws a clear error for a REST envelope (Phase 2, not yet supported)', () => {
    expect(() =>
      detectFormat('{"entry":[{"content":{"eai:data":"<form/>"}}]}'),
    ).toThrow(/REST envelope.*Phase 2/);
  });
});
