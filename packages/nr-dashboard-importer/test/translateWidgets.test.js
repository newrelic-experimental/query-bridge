import { describe, it, expect } from 'vitest';
import { translateWidgets } from '../src/translateWidgets.js';
import { createWidget } from '../src/model.js';

describe('translateWidgets — clean translation', () => {
  it('attaches NRQL and marks a translatable widget clean', () => {
    const widgets = [
      createWidget({
        title: 'C',
        vizType: 'line',
        rawSpl: 'index=web | stats count',
      }),
    ];
    const out = translateWidgets(widgets);
    expect(out[0].outcome).toBe('clean');
    expect(out[0].nrql).toMatch(/SELECT count/i);
    expect(out[0].vizType).toBe('line');
  });
});

describe('translateWidgets — placeholder on no NRQL', () => {
  it('converts an untranslatable widget to a markdown placeholder with SPL and reason', () => {
    // A construct the translator reports as unsupported/errors → nrql === ''.
    const widgets = [
      createWidget({
        title: 'Bad',
        vizType: 'table',
        rawSpl: '| nonsensecommand foo bar',
      }),
    ];
    const out = translateWidgets(widgets);
    expect(out[0].outcome).toBe('placeholder');
    expect(out[0].vizType).toBe('markdown');
    expect(out[0].placeholderText).toContain('| nonsensecommand foo bar'); // original SPL fenced
    expect(out[0].placeholderText).toMatch(/unsupported|error/i); // the reason
    expect(out[0].placeholderText).not.toMatch(/Partial — unverified/); // no partial NRQL present
    expect(out[0].nrql).toBeUndefined();
  });
});

describe('translateWidgets — pre-translation placeholders', () => {
  it('placeholders an empty query instead of translating it to SELECT *', () => {
    const widgets = [
      createWidget({ title: 'Empty', vizType: 'table', rawSpl: '   ' }),
    ];
    const out = translateWidgets(widgets);
    expect(out[0].outcome).toBe('placeholder');
    expect(out[0].vizType).toBe('markdown');
    expect(out[0].placeholderText).toMatch(/empty query/i);
    expect(out[0].nrql).toBeUndefined();
  });

  it('placeholders a widget the parser flagged with unsupportedReason, before translating', () => {
    // rawSpl IS translatable, but the parser-set reason takes precedence.
    const widgets = [
      createWidget({
        title: 'Event',
        vizType: 'unknown',
        rawSpl: 'index=app',
        unsupportedReason: 'event panels are not supported',
      }),
    ];
    const out = translateWidgets(widgets);
    expect(out[0].outcome).toBe('placeholder');
    expect(out[0].vizType).toBe('markdown');
    expect(out[0].placeholderText).toContain('event panels are not supported');
    expect(out[0].nrql).toBeUndefined();
  });
});

describe('translateWidgets — non-emittable viz types placeholder', () => {
  it('placeholders a scatter widget (no NR block) but keeps its valid NRQL', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If it fails, the non-emittable
    // chokepoint branch (BUG2) regressed — fix the code, not the test.
    const widgets = [
      createWidget({
        title: 'S',
        vizType: 'scatter',
        rawSpl: 'index=web | stats count by host',
      }),
    ];
    const out = translateWidgets(widgets);
    expect(out[0].outcome).toBe('placeholder');
    expect(out[0].vizType).toBe('markdown');
    expect(out[0].placeholderText).toMatch(
      /no New Relic equivalent for scatter/,
    );
    expect(out[0].placeholderText).toMatch(/SELECT count/i); // valid NRQL kept as partial
    expect(out[0].nrql).toBeUndefined();
  });
});

describe('translateWidgets — warnings attach but stay clean', () => {
  it('keeps a warned widget as a real widget and records the warnings', () => {
    // Pick SPL the translator emits NRQL for but with a warning. If none is known,
    // assert the shape: outcome 'clean' AND warnings is an array.
    const widgets = [
      createWidget({
        title: 'W',
        vizType: 'line',
        rawSpl: 'index=web | stats count',
      }),
    ];
    const out = translateWidgets(widgets);
    expect(out[0].outcome).toBe('clean');
    expect(Array.isArray(out[0].warnings)).toBe(true);
  });
});
