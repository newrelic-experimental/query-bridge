import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSimpleXml } from '../src/parseSimpleXml.js';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');

describe('parseSimpleXml — title and a single chart', () => {
  it('reads the label as the model title', () => {
    const m = parseSimpleXml(fixture('single-chart.xml'));
    expect(m.title).toBe('Web Health');
    expect(m.description).toBe('Synthetic fixture');
    expect(m.sourceFormat).toBe('simple-xml');
  });

  it('produces one line widget carrying the query SPL', () => {
    const m = parseSimpleXml(fixture('single-chart.xml'));
    expect(m.widgets).toHaveLength(1);
    expect(m.widgets[0].vizType).toBe('line');
    expect(m.widgets[0].title).toBe('Requests over time');
    expect(m.widgets[0].rawSpl).toBe('index=web | timechart count');
  });
});

describe('parseSimpleXml — viz types and layout', () => {
  it('defaults a <chart> with no charting.chart option to line', () => {
    const m = parseSimpleXml(fixture('multi-panel.xml'));
    const chart = m.widgets.find((w) => w.title === 'No explicit type');
    expect(chart.vizType).toBe('line');
  });

  it('maps <table> to table and <single> to billboard', () => {
    const m = parseSimpleXml(fixture('multi-panel.xml'));
    expect(m.widgets.find((w) => w.title === 'Top hosts').vizType).toBe(
      'table',
    );
    expect(m.widgets.find((w) => w.title === 'Total').vizType).toBe(
      'billboard',
    );
  });

  it('computes a 12-col layout from row and panel position', () => {
    const m = parseSimpleXml(fixture('multi-panel.xml'));
    // Row 0 has 2 panels → each width 6; row 1 has 1 panel → width 6 (12/1 floored is 12).
    const chart = m.widgets.find((w) => w.title === 'No explicit type');
    const table = m.widgets.find((w) => w.title === 'Top hosts');
    const single = m.widgets.find((w) => w.title === 'Total');
    expect(chart.layout).toEqual({ x: 0, y: 0, w: 6, h: 3 });
    expect(table.layout).toEqual({ x: 6, y: 0, w: 6, h: 3 });
    expect(single.layout).toEqual({ x: 0, y: 3, w: 12, h: 3 });
  });
});

describe('parseSimpleXml — unsupported viz tags never silently drop', () => {
  it('emits an event panel as a widget carrying an unsupportedReason', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If it fails, the parser stopped
    // classifying unsupported viz tags (BUG3 regression) — fix the code, not the test.
    const xml = `<dashboard><label>Ev</label><row><panel>
      <event><title>Stream</title><search><query><![CDATA[index=app]]></query></search></event>
    </panel></row></dashboard>`;
    const m = parseSimpleXml(xml);
    expect(m.widgets).toHaveLength(1);
    expect(m.widgets[0].unsupportedReason).toBe(
      'event panels are not supported',
    );
    expect(m.widgets[0].vizType).toBe('unknown');
    expect(m.widgets[0].title).toBe('Stream');
    expect(m.widgets[0].rawSpl).toBe('index=app');
  });

  it('keeps a <map> panel as a map-typed widget with an unsupportedReason', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If it fails, the parser stopped
    // classifying unsupported viz tags (BUG3 regression) — fix the code, not the test.
    const xml = `<dashboard><label>M</label><row><panel>
      <map><search><query><![CDATA[index=app | geostats count]]></query></search></map>
    </panel></row></dashboard>`;
    const m = parseSimpleXml(xml);
    expect(m.widgets).toHaveLength(1);
    expect(m.widgets[0].vizType).toBe('map');
    expect(m.widgets[0].unsupportedReason).toBe('map panels are not supported');
  });
});

describe('parseSimpleXml — panel-level title fallback', () => {
  const chart = (vizTitle) =>
    `<chart>${vizTitle}<search><query><![CDATA[index=app | timechart count]]></query></search><option name="charting.chart">line</option></chart>`;

  it('uses the viz <title> when present', () => {
    const xml = `<dashboard><label>D</label><row><panel><title>Panel</title>${chart('<title>Viz</title>')}</panel></row></dashboard>`;
    expect(parseSimpleXml(xml).widgets[0].title).toBe('Viz');
  });

  it('falls back to the panel <title> when the viz has none', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If it fails, the panel-title
    // fallback (BUG4) regressed — fix the code, not the test.
    const xml = `<dashboard><label>D</label><row><panel><title>Panel</title>${chart('')}</panel></row></dashboard>`;
    expect(parseSimpleXml(xml).widgets[0].title).toBe('Panel');
  });

  it('is empty when neither viz nor panel has a title', () => {
    const xml = `<dashboard><label>D</label><row><panel>${chart('')}</panel></row></dashboard>`;
    expect(parseSimpleXml(xml).widgets[0].title).toBe('');
  });
});

describe('parseSimpleXml — per-panel search time folds into the base search', () => {
  it('prepends literal <search><earliest>/<latest> as time modifiers', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If it fails, the per-panel time
    // fold (BUG5) regressed — fix the code, not the test.
    const xml = `<dashboard><label>E</label><row><panel><chart>
      <search><query><![CDATA[index=app | timechart count]]></query>
        <earliest>-60m</earliest><latest>now</latest></search>
      <option name="charting.chart">line</option>
    </chart></panel></row></dashboard>`;
    expect(parseSimpleXml(xml).widgets[0].rawSpl).toBe(
      'earliest=-60m latest=now index=app | timechart count',
    );
  });

  it('leaves the query unchanged when there are no time siblings', () => {
    const xml = `<dashboard><label>E</label><row><panel><chart>
      <search><query><![CDATA[index=app | timechart count]]></query></search>
      <option name="charting.chart">line</option>
    </chart></panel></row></dashboard>`;
    expect(parseSimpleXml(xml).widgets[0].rawSpl).toBe(
      'index=app | timechart count',
    );
  });
});

describe('parseSimpleXml — dashboard time picker default', () => {
  it('captures a <input type="time"> default earliest/latest into defaultTimeRange', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If it fails, time-input default
    // capture (BUG5/6) regressed — fix the code, not the test.
    const xml = `<form><label>TP</label>
      <fieldset><input type="time" token="tr">
        <default><earliest>-24h@h</earliest><latest>now</latest></default>
      </input></fieldset>
      <row><panel><chart><search><query><![CDATA[index=app | timechart count]]></query></search></chart></panel></row>
    </form>`;
    const m = parseSimpleXml(xml);
    expect(m.defaultTimeRange).toEqual({ earliest: '-24h@h', latest: 'now' });
  });

  it('leaves defaultTimeRange null when there is no time input', () => {
    const xml = `<dashboard><label>D</label><row><panel><chart>
      <search><query><![CDATA[index=app | timechart count]]></query></search>
    </chart></panel></row></dashboard>`;
    expect(parseSimpleXml(xml).defaultTimeRange).toBeNull();
  });
});
