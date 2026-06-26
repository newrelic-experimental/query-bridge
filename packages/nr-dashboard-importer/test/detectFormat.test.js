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

  it('unwraps an XML-wrapped Studio dashboard to its JSON payload', () => {
    const xml =
      '<dashboard version="2"><definition><![CDATA[{"dataSources":{},"visualizations":{}}]]></definition></dashboard>';
    const units = detectFormat(xml);
    expect(units).toHaveLength(1);
    expect(units[0].format).toBe('studio');
    expect(JSON.parse(units[0].payload)).toEqual({
      dataSources: {},
      visualizations: {},
    });
  });

  it('passes a pure-JSON Studio dashboard straight through', () => {
    const json = '{"dataSources":{},"visualizations":{},"layout":{}}';
    const units = detectFormat(json);
    expect(units).toHaveLength(1);
    expect(units[0].format).toBe('studio');
    expect(units[0].payload).toBe(json);
  });

  it('expands a REST envelope into one unit per dashboard entry', () => {
    const env = JSON.stringify({
      entry: [
        {
          content: {
            version: '1.1',
            isDashboard: true,
            'eai:data': '<form><label>A</label></form>',
          },
        },
        {
          content: {
            version: '2',
            isDashboard: true,
            'eai:data':
              '<dashboard version="2"><definition><![CDATA[{"dataSources":{},"visualizations":{}}]]></definition></dashboard>',
          },
        },
      ],
    });
    const units = detectFormat(env);
    expect(units).toHaveLength(2);
    expect(units[0].format).toBe('simple-xml');
    expect(units[1].format).toBe('studio');
  });

  it('strips CDATA from a Studio entry arriving via the REST envelope', () => {
    const env = JSON.stringify({
      entry: [
        {
          content: {
            version: '2',
            isDashboard: true,
            'eai:data':
              '<dashboard version="2"><definition><![CDATA[{"dataSources":{},"visualizations":{}}]]></definition></dashboard>',
          },
        },
      ],
    });
    const units = detectFormat(env);
    expect(units).toHaveLength(1);
    expect(units[0].format).toBe('studio');
    expect(JSON.parse(units[0].payload)).toEqual({
      dataSources: {},
      visualizations: {},
    });
  });

  it('skips entries with isDashboard === false', () => {
    const env = JSON.stringify({
      entry: [
        {
          content: {
            version: '1.1',
            isDashboard: false,
            'eai:data': '<form/>',
          },
        },
        {
          content: {
            version: '1.1',
            isDashboard: true,
            'eai:data': '<form><label>B</label></form>',
          },
        },
      ],
    });
    const units = detectFormat(env);
    expect(units).toHaveLength(1);
    expect(units[0].format).toBe('simple-xml');
  });

  it('returns an empty list for an all-skipped envelope (not an error)', () => {
    const env = JSON.stringify({
      entry: [{ content: { isDashboard: false, 'eai:data': '<form/>' } }],
    });
    expect(detectFormat(env)).toEqual([]);
  });
});
