import { describe, it, expect } from 'vitest';
import { runImport } from '../bin/spl-dashboard.js';

const xml = `<form><label>CLI Dash</label><row><panel><chart>
  <title>T</title><search><query>index=web | stats count</query></search>
  <option name="charting.chart">line</option>
</chart></panel></row></form>`;

describe('runImport', () => {
  it('produces the three tf files and a report keyed by slug', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.
    const out = runImport(xml, { account: null });
    expect(out.files['versions.tf']).toContain('newrelic/newrelic');
    expect(out.files['variables.tf']).toContain('variable "account_id"');
    expect(out.files['cli-dash.tf']).toContain('newrelic_one_dashboard');
    expect(out.files['cli-dash.report.md']).toContain('1 widgets');
    expect(out.slug).toBe('cli-dash');
  });

  it('bakes the account id when --account is given', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.
    const out = runImport(xml, { account: 999 });
    expect(out.files['cli-dash.tf']).toContain('account_id = 999');
  });
});
