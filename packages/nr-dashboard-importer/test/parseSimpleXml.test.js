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
