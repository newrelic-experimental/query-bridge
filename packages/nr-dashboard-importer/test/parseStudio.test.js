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

  it('renders a native markdown panel body as a clean markdown widget', () => {
    const m = parseStudio(
      wrap(
        {
          v_md: {
            type: 'splunk.markdown',
            options: { markdown: '## Gadget notes\nfree text' },
          },
        },
        [{ item: 'v_md', position: { x: 0, y: 0, w: 600, h: 100 } }],
      ),
    );
    expect(m.widgets).toHaveLength(1);
    expect(m.widgets[0].vizType).toBe('markdown');
    expect(m.widgets[0].options.text).toBe('## Gadget notes\nfree text');
    expect(m.widgets[0].unsupportedReason).toBeNull();
  });

  it('leaves a markdown panel with no body for the empty-query placeholder', () => {
    const m = parseStudio(
      wrap({ v_md: { type: 'splunk.markdown', options: {} } }, [
        { item: 'v_md', position: { x: 0, y: 0, w: 600, h: 100 } },
      ]),
    );
    // vizType still markdown, but no options.text and empty rawSpl → the
    // translateWidgets chokepoint placeholders it loudly downstream.
    expect(m.widgets[0].vizType).toBe('markdown');
    expect(m.widgets[0].options.text).toBeUndefined();
    expect(m.widgets[0].rawSpl).toBe('');
  });
});

describe('parseStudio — chain resolution', () => {
  const oneViz = (dataSources, primary) =>
    JSON.stringify({
      title: 'T',
      dataSources,
      visualizations: {
        v: { type: 'splunk.table', title: 'W', dataSources: { primary } },
      },
      layout: {
        structure: [{ item: 'v', position: { x: 0, y: 0, w: 1200, h: 100 } }],
        options: { width: 1200 },
      },
    });

  it('composes a chain root | fragment', () => {
    const m = parseStudio(
      oneViz(
        {
          ds_root: { type: 'ds.search', options: { query: 'search gizmo=7' } },
          ds_pp: {
            type: 'ds.chain',
            options: { extend: 'ds_root', query: '| where zone_q=3' },
          },
        },
        'ds_pp',
      ),
    );
    expect(m.widgets[0].rawSpl).toBe('search gizmo=7 | where zone_q=3');
    expect(m.widgets[0].unsupportedReason).toBeNull();
  });

  it('composes a nested chain (chain -> chain -> search) in order', () => {
    const m = parseStudio(
      oneViz(
        {
          ds_root: { type: 'ds.search', options: { query: 'search gizmo=7' } },
          ds_pp1: {
            type: 'ds.chain',
            options: { extend: 'ds_root', query: '| fields a' },
          },
          ds_pp2: {
            type: 'ds.chain',
            options: { extend: 'ds_pp1', query: '| where a>1' },
          },
        },
        'ds_pp2',
      ),
    );
    expect(m.widgets[0].rawSpl).toBe('search gizmo=7 | fields a | where a>1');
  });

  it('placeholders a chain whose root is a saved search (no inline SPL)', () => {
    const m = parseStudio(
      oneViz(
        {
          ds_saved: { type: 'ds.savedSearch', options: { ref: 'some_report' } },
          ds_pp: {
            type: 'ds.chain',
            options: { extend: 'ds_saved', query: '| head 5' },
          },
        },
        'ds_pp',
      ),
    );
    expect(m.widgets[0].unsupportedReason).toMatch(
      /ds\.savedSearch|no inline query/,
    );
  });

  it('placeholders a chain that extends a missing id', () => {
    const m = parseStudio(
      oneViz(
        {
          ds_pp: {
            type: 'ds.chain',
            options: { extend: 'ds_ghost', query: '| head 5' },
          },
        },
        'ds_pp',
      ),
    );
    expect(m.widgets[0].unsupportedReason).toMatch(/not found/);
  });

  it('placeholders a chain cycle without hanging', () => {
    const m = parseStudio(
      oneViz(
        {
          ds_a: {
            type: 'ds.chain',
            options: { extend: 'ds_b', query: '| where x=1' },
          },
          ds_b: {
            type: 'ds.chain',
            options: { extend: 'ds_a', query: '| where y=2' },
          },
        },
        'ds_a',
      ),
    );
    expect(m.widgets[0].unsupportedReason).toMatch(/cycle/);
  });

  it('composes eval after a transforming root (translator folds it downstream)', () => {
    const m = parseStudio(
      oneViz(
        {
          ds_root: {
            type: 'ds.search',
            options: { query: 'search gizmo=7 | stats count by zone_q' },
          },
          ds_pp: {
            type: 'ds.chain',
            options: { extend: 'ds_root', query: '| eval rate = count / 60' },
          },
        },
        'ds_pp',
      ),
    );
    expect(m.widgets[0].rawSpl).toBe(
      'search gizmo=7 | stats count by zone_q | eval rate = count / 60',
    );
    expect(m.widgets[0].unsupportedReason).toBeNull();
  });

  it('non-transforming root + eval fragment composes (delegates to translator)', () => {
    const m = parseStudio(
      oneViz(
        {
          ds_root: { type: 'ds.search', options: { query: 'search gizmo=7' } },
          ds_pp: {
            type: 'ds.chain',
            options: { extend: 'ds_root', query: '| eval k = a + b' },
          },
        },
        'ds_pp',
      ),
    );
    expect(m.widgets[0].rawSpl).toBe('search gizmo=7 | eval k = a + b');
    expect(m.widgets[0].unsupportedReason).toBeNull();
  });
});

describe('parseStudio — inputs', () => {
  const withInputs = (inputs) =>
    JSON.stringify({
      title: 'T',
      dataSources: {},
      visualizations: {},
      layout: { structure: [] },
      inputs,
    });

  it('parses a comma time-range default into defaultTimeRange', () => {
    const m = parseStudio(
      withInputs({
        i_t: {
          type: 'input.timerange',
          options: { token: 'tr', defaultValue: '-24h@h,now' },
        },
      }),
    );
    expect(m.defaultTimeRange).toEqual({ earliest: '-24h@h', latest: 'now' });
    expect(m.variables).toHaveLength(0); // time input is not a variable
  });

  it('skips a named-preset time default (no comma)', () => {
    const m = parseStudio(
      withInputs({
        i_t: {
          type: 'input.timerange',
          options: { defaultValue: 'last_cycle_preset' },
        },
      }),
    );
    expect(m.defaultTimeRange).toBeNull();
  });

  it('first time input wins when several exist', () => {
    const m = parseStudio(
      withInputs({
        i_a: { type: 'input.timerange', options: { defaultValue: '-7d,now' } },
        i_b: { type: 'input.timerange', options: { defaultValue: '-1h,now' } },
      }),
    );
    expect(m.defaultTimeRange).toEqual({ earliest: '-7d', latest: 'now' });
  });

  it('maps a static dropdown to an enum variable', () => {
    const m = parseStudio(
      withInputs({
        i_d: {
          type: 'input.dropdown',
          options: {
            token: 'zone',
            defaultValue: 'z_a',
            items: [
              { label: 'Zone A', value: 'z_a' },
              { label: 'Zone B', value: 'z_b' },
            ],
          },
        },
      }),
    );
    expect(m.variables[0]).toMatchObject({
      name: 'zone',
      type: 'enum',
      defaultValue: 'z_a',
      multi: false,
    });
    expect(m.variables[0].choices).toEqual([
      { value: 'z_a', title: 'Zone A' },
      { value: 'z_b', title: 'Zone B' },
    ]);
  });

  it('maps a text input to a string variable and a multiselect to multi', () => {
    const m = parseStudio(
      withInputs({
        i_x: { type: 'input.text', options: { token: 'q', defaultValue: '' } },
        i_m: {
          type: 'input.multiselect',
          options: { token: 'tags', items: [{ label: 'P', value: 'p' }] },
        },
      }),
    );
    expect(m.variables.find((v) => v.name === 'q')).toMatchObject({
      type: 'string',
    });
    expect(m.variables.find((v) => v.name === 'tags')).toMatchObject({
      type: 'enum',
      multi: true,
    });
  });

  it('degrades a dropdown with no items (search-backed/empty) to a string variable', () => {
    const m = parseStudio(
      withInputs({
        i_dyn: {
          type: 'input.dropdown',
          options: { token: 'host_pick', defaultValue: 'host_alpha' },
        },
      }),
    );
    expect(m.variables[0]).toMatchObject({
      name: 'host_pick',
      type: 'string',
      defaultValue: 'host_alpha',
    });
    expect(m.variables[0].choices).toEqual([]);
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
