import { describe, it, expect } from 'vitest';
import { parseStudio } from '../src/parseStudio.js';

describe('parseStudio — skeleton', () => {
  it('reads title/description and one inline-search line widget', () => {
    const doc = JSON.stringify({
      title: 'Gadget Board',
      description: 'synthetic',
      dataSources: {
        ds_alpha: {
          type: 'ds.search',
          options: { query: 'search wibble > 5' },
        },
      },
      visualizations: {
        viz_one: {
          type: 'splunk.line',
          title: 'Wibbles',
          dataSources: { primary: 'ds_alpha' },
        },
      },
      layout: {
        structure: [
          { item: 'viz_one', position: { x: 0, y: 0, w: 600, h: 100 } },
        ],
        options: { width: 1200 },
      },
    });
    const m = parseStudio(doc);
    expect(m.title).toBe('Gadget Board');
    expect(m.sourceFormat).toBe('studio');
    expect(m.widgets).toHaveLength(1);
    expect(m.widgets[0].vizType).toBe('line');
    expect(m.widgets[0].title).toBe('Wibbles');
    expect(m.widgets[0].rawSpl).toBe('search wibble > 5');
    expect(m.widgets[0].layout).toEqual({ x: 0, y: 0, w: 6, h: 1 });
  });
});
