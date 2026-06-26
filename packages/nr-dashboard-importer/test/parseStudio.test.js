import { describe, it, expect } from 'vitest';
import { parseStudio } from '../src/parseStudio.js';

describe('parseStudio — viz behavior', () => {
  const wrap = (visualizations, structure) =>
    JSON.stringify({
      title: 'T',
      dataSources: {},
      visualizations,
      layout: { structure, options: { width: 1200 } },
    });

  it('drops pure-shape decorations (no widget)', () => {
    const m = parseStudio(
      wrap(
        {
          v_rect: { type: 'splunk.rectangle' },
          v_ell: { type: 'splunk.ellipse' },
        },
        [
          { item: 'v_rect', position: { x: 0, y: 0, w: 100, h: 100 } },
          { item: 'v_ell', position: { x: 0, y: 100, w: 100, h: 100 } },
        ],
      ),
    );
    expect(m.widgets).toHaveLength(0);
  });

  it('turns an image WITH an http(s) URL into a markdown widget', () => {
    const m = parseStudio(
      wrap(
        {
          v_img: {
            type: 'splunk.image',
            options: { src: 'https://cdn.test/zonk.png' },
          },
        },
        [{ item: 'v_img', position: { x: 0, y: 0, w: 600, h: 100 } }],
      ),
    );
    expect(m.widgets).toHaveLength(1);
    expect(m.widgets[0].vizType).toBe('markdown');
    expect(m.widgets[0].options.text).toBe('![](https://cdn.test/zonk.png)');
  });

  it('drops an image with no usable URL', () => {
    const m = parseStudio(
      wrap(
        {
          v_img: {
            type: 'splunk.image',
            options: { src: 'file:///tmp/zonk.png' },
          },
        },
        [{ item: 'v_img', position: { x: 0, y: 0, w: 600, h: 100 } }],
      ),
    );
    expect(m.widgets).toHaveLength(0);
  });

  it('placeholders an unrecognized viz type (loud, never guessed)', () => {
    const m = parseStudio(
      wrap(
        {
          v_x: {
            type: 'splunk.sankey',
            title: 'Flow',
            dataSources: { primary: 'ds_x' },
          },
        },
        [{ item: 'v_x', position: { x: 0, y: 0, w: 600, h: 100 } }],
      ),
    );
    expect(m.widgets).toHaveLength(1);
    expect(m.widgets[0].vizType).toBe('unknown');
    expect(m.widgets[0].unsupportedReason).toMatch(
      /no New Relic equivalent.*splunk\.sankey/,
    );
    expect(m.widgets[0].title).toBe('Flow');
  });

  it('falls back to empty title and trims whitespace-only titles', () => {
    const m = parseStudio(
      wrap(
        {
          v_a: { type: 'splunk.line' },
          v_b: { type: 'splunk.line', title: '   ' },
        },
        [
          { item: 'v_a', position: { x: 0, y: 0, w: 600, h: 100 } },
          { item: 'v_b', position: { x: 6, y: 0, w: 600, h: 100 } },
        ],
      ),
    );
    expect(m.widgets[0].title).toBe('');
    expect(m.widgets[1].title).toBe('');
  });

  it('yields finite grid coords when structure item has no position', () => {
    const m = parseStudio(
      wrap({ v_a: { type: 'splunk.line' } }, [{ item: 'v_a' }]),
    );
    const g = m.widgets[0].layout;
    expect(Number.isFinite(g.x)).toBe(true);
    expect(Number.isFinite(g.y)).toBe(true);
    expect(Number.isFinite(g.w)).toBe(true);
    expect(Number.isFinite(g.h)).toBe(true);
  });
});

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
