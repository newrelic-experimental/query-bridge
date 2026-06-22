import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runImport } from '../bin/spl-dashboard.js';

const xml = readFileSync(
  new URL('./fixtures/realistic-deidentified.xml', import.meta.url),
  'utf-8',
);

describe('end-to-end: realistic Simple XML → Terraform', () => {
  it('never throws — every dashboard produces output', () => {
    expect(() => runImport(xml, { account: 12345 })).not.toThrow();
  });

  it('emits one resource, three widgets, and a report', () => {
    const out = runImport(xml, { account: 12345 });
    const tf = out.files[`${out.slug}.tf`];
    expect(tf).toContain('resource "newrelic_one_dashboard"');
    expect((tf.match(/widget_/g) || []).length).toBe(3); // line + single + table
    expect(out.files[`${out.slug}.report.md`]).toContain('3 widgets');
  });

  it('re-running produces byte-identical output (idempotent)', () => {
    const a = runImport(xml, { account: 12345 });
    const b = runImport(xml, { account: 12345 });
    expect(a.files).toEqual(b.files);
  });

  it('contains no customer-identifying names (de-identification guard)', () => {
    const all = Object.values(runImport(xml, { account: 12345 }).files).join(
      '\n',
    );
    expect(all.toLowerCase()).not.toContain('REDACTED');
    expect(all.toLowerCase()).not.toContain('REDACTED');
  });
});
