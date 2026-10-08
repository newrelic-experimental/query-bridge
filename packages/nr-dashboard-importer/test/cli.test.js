/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { runImport, parseArgs } from '../bin/spl-dashboard.js';
import { PREVIEW_FLAG_NAMES } from '@newrelic/query-bridge';

const xml = `<form><label>CLI Dash</label><row><panel><chart>
  <title>T</title><search><query>index=web | stats count</query></search>
  <option name="charting.chart">line</option>
</chart></panel></row></form>`;

describe('runImport', () => {
  it('produces the three tf files and a report keyed by slug', () => {
    const [out] = runImport(xml, { account: null });
    expect(out.files['versions.tf']).toContain('newrelic/newrelic');
    expect(out.files['variables.tf']).toContain('variable "account_id"');
    expect(out.files['cli-dash.tf']).toContain('newrelic_one_dashboard');
    expect(out.files['cli-dash.report.md']).toContain('1 widgets');
    expect(out.slug).toBe('cli-dash');
  });

  it('bakes the account id when --account is given', () => {
    const [out] = runImport(xml, { account: 999 });
    expect(out.files['cli-dash.tf']).toContain('account_id = 999');
  });

  it('threads --region into the provider block', () => {
    const [out] = runImport(xml, { account: 1, region: 'Staging' });
    expect(out.files['variables.tf']).toMatch(/region\s+= "Staging"/);
  });

  it('imports a REST envelope of two dashboards (XML + Studio) as two results', () => {
    const studioDef =
      '{"title":"Gizmo Board","dataSources":{"d":{"type":"ds.search","options":{"query":"search a=1"}}},"visualizations":{"v":{"type":"splunk.table","title":"W","dataSources":{"primary":"d"}}},"layout":{"structure":[{"item":"v","position":{"x":0,"y":0,"w":1200,"h":100}}],"options":{"width":1200}}}';
    const env = JSON.stringify({
      entry: [
        { content: { version: '1.1', isDashboard: true, 'eai:data': xml } },
        {
          content: {
            version: '2',
            isDashboard: true,
            'eai:data': `<dashboard version="2"><definition><![CDATA[${studioDef}]]></definition></dashboard>`,
          },
        },
      ],
    });
    const results = runImport(env, { account: null });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.slug).sort()).toEqual([
      'cli-dash',
      'gizmo-board',
    ]);
  });

  it('isolates a malformed entry: emits the good dashboard, records the bad one', () => {
    const badStudio =
      '<dashboard version="2"><definition><![CDATA[{ not valid json ]]></definition></dashboard>';
    const env = JSON.stringify({
      entry: [
        { content: { version: '1.1', isDashboard: true, 'eai:data': xml } },
        { content: { version: '2', isDashboard: true, 'eai:data': badStudio } },
      ],
    });
    const results = runImport(env, { account: null });
    const dashboards = results.filter((r) => !r.skipped);
    const skipped = results.filter((r) => r.skipped);
    expect(dashboards.map((d) => d.slug)).toEqual(['cli-dash']); // sibling survives
    expect(skipped).toHaveLength(1);
    expect(skipped[0].index).toBe(1);
    expect(skipped[0].reason).toMatch(/JSON/i); // loud reason recorded
  });

  it('de-duplicates slugs when two dashboards share a title', () => {
    const env = JSON.stringify({
      entry: [
        { content: { version: '1.1', isDashboard: true, 'eai:data': xml } },
        { content: { version: '1.1', isDashboard: true, 'eai:data': xml } },
      ],
    });
    const results = runImport(env, { account: null });
    expect(results.map((r) => r.slug)).toEqual(['cli-dash', 'cli-dash-2']);
    // each result's files are keyed by its own (unique) slug
    expect(results[1].files['cli-dash-2.tf']).toContain(
      'newrelic_one_dashboard',
    );
  });
});

describe('parseArgs — --region validation', () => {
  it('parses and canonicalizes --region case-insensitively', () => {
    expect(parseArgs(['x.xml', '--region', 'staging']).region).toBe('Staging');
  });
  it('throws a clear error on an unknown --region', () => {
    expect(() => parseArgs(['x.xml', '--region', 'Mars'])).toThrow(/--region/);
  });
  it('leaves region undefined when --region is absent', () => {
    expect(parseArgs(['x.xml']).region).toBeUndefined();
  });
});

describe('parseArgs — --account validation', () => {
  it('throws a clear error when --account is not a number', () => {
    expect(() => parseArgs(['x.xml', '--account', 'abc'])).toThrow(
      /--account must be a number/,
    );
  });
  it('parses a numeric --account', () => {
    expect(parseArgs(['x.xml', '--account', '999']).account).toBe(999);
  });
  it('defaults account to null when --account is absent', () => {
    expect(parseArgs(['x.xml']).account).toBeNull();
  });
});

describe('parseArgs — --preview validation', () => {
  it('leaves preview undefined when no preview flag is given', () => {
    expect(parseArgs(['x.xml']).preview).toBeUndefined();
  });

  it('parses a comma list in the --preview=a,b form', () => {
    expect(parseArgs(['x.xml', '--preview=expand,split']).preview).toEqual({
      expand: true,
      split: true,
    });
  });

  it('parses a comma list in the --preview a,b form', () => {
    expect(parseArgs(['x.xml', '--preview', 'expand,split']).preview).toEqual({
      expand: true,
      split: true,
    });
  });

  it('accumulates repeated --preview flags', () => {
    expect(
      parseArgs(['x.xml', '--preview=expand', '--preview=trim']).preview,
    ).toEqual({ expand: true, trim: true });
  });

  it('enables every flag for --preview-all', () => {
    const preview = parseArgs(['x.xml', '--preview-all']).preview;
    expect(Object.keys(preview).sort()).toEqual([...PREVIEW_FLAG_NAMES].sort());
    expect(Object.values(preview).every((v) => v === true)).toBe(true);
  });

  it('rejects an unknown preview flag by name instead of ignoring it', () => {
    // AI-DEV: A typo'd CLI flag MUST fail loudly — silently ignoring it means
    // the user believes a Beta gate is on and gets the GA translation instead.
    // (The library-level `normalizePreview` ignores unknown keys on purpose;
    // that is a version-skew concession, not the CLI contract.)
    expect(() => parseArgs(['x.xml', '--preview=expnd'])).toThrow(/expnd/);
  });

  it('names the valid flags in the unknown-flag error', () => {
    expect(() => parseArgs(['x.xml', '--preview=nope'])).toThrow(
      /valid flags:/,
    );
  });
});

describe('runImport — preview pass-through', () => {
  const trimXml = `<form><label>Trim Dash</label><row><panel><chart>
  <title>T</title><search><query>index=web | eval x=trim(name) | stats count by x</query></search>
  <option name="charting.chart">line</option>
</chart></panel></row></form>`;

  it('emits the GA capture() form when no preview flags are passed', () => {
    const [out] = runImport(trimXml, { account: null });
    expect(out.files['trim-dash.tf']).toContain('capture(name');
    expect(out.files['trim-dash.tf']).not.toContain('trim(name)');
  });

  it('threads the trim gate through to the translated widget query', () => {
    const [out] = runImport(trimXml, {
      account: null,
      preview: { trim: true },
    });
    expect(out.files['trim-dash.tf']).toContain('trim(name)');
    expect(out.files['trim-dash.tf']).not.toContain('capture(name');
  });
});
