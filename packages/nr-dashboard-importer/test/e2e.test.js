/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

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
    const [out] = runImport(xml, { account: 12345 });
    const tf = out.files[`${out.slug}.tf`];
    expect(tf).toContain('resource "newrelic_one_dashboard"');
    expect((tf.match(/widget_/g) || []).length).toBe(3); // line + single + table
    expect(out.files[`${out.slug}.report.md`]).toContain('3 widgets');
  });

  it('re-running produces byte-identical output (idempotent)', () => {
    const [a] = runImport(xml, { account: 12345 });
    const [b] = runImport(xml, { account: 12345 });
    expect(a.files).toEqual(b.files);
  });
});

describe('end-to-end: <html> panel → clean markdown widget', () => {
  it('emits a clean widget_markdown for an <html> panel alongside a chart', () => {
    const xml = `<dashboard><label>HTML demo</label><row>
      <panel><chart><title>Reqs</title><search><query>index=web | timechart count</query></search></chart></panel>
      <panel><title>Legend</title><html><b>Key</b></html></panel>
    </row></dashboard>`;
    const [out] = runImport(xml, { account: 12345 });
    const tf = out.files[`${out.slug}.tf`];
    expect((tf.match(/widget_/g) || []).length).toBe(2);
    expect(tf).toContain('widget_markdown');
    expect(tf).toContain('widget_line');
    expect(tf).toContain('**Key**'); // converted content, not a fenced placeholder
    expect(tf).not.toContain('```'); // a placeholder fences the original; a clean widget doesn't
  });
});
