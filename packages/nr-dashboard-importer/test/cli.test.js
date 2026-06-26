import { describe, it, expect } from 'vitest';
import { runImport, parseArgs } from '../bin/spl-dashboard.js';

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
