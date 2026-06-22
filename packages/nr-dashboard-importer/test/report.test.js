import { describe, it, expect } from 'vitest';
import { buildReport } from '../src/report.js';

const translated = [
  { title: 'A', outcome: 'clean', warnings: [] },
  { title: 'B', outcome: 'clean', warnings: ['precision loss on foo'] },
  {
    title: 'C',
    outcome: 'placeholder',
    placeholderText: 'reason: unsupported xyz',
    warnings: [],
  },
];

describe('buildReport', () => {
  it('counts clean, warned, and placeholder widgets', () => {
    const md = buildReport('Web Health', translated);
    expect(md).toContain('Web Health');
    expect(md).toContain('3 widgets');
    expect(md).toContain('2 clean'); // A and B both translated
    expect(md).toContain('1 warned'); // B carries a warning
    expect(md).toContain('1 placeholder'); // C
  });

  it('lists each placeholder with its title', () => {
    const md = buildReport('Web Health', translated);
    expect(md).toContain('C');
  });

  it('states the validate-is-syntax-only caveat', () => {
    const md = buildReport('Web Health', translated);
    expect(md).toMatch(/valid.*does not.*working|syntax.*not.*semantic/i);
  });
});
