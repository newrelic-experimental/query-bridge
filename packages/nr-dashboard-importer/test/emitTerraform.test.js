import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { emitTerraform, slugify } from '../src/emitTerraform.js';

const model = {
  title: 'Web Health',
  description: 'desc',
  widgets: [
    {
      title: 'Reqs',
      vizType: 'line',
      outcome: 'clean',
      nrql: 'FROM Log SELECT count(*)',
      warnings: [],
      layout: { x: 0, y: 0, w: 6, h: 3 },
    },
    {
      title: 'Note',
      vizType: 'markdown',
      outcome: 'placeholder',
      placeholderText: '### Note\nbad panel',
      warnings: [],
      layout: { x: 6, y: 0, w: 6, h: 3 },
    },
  ],
};

describe('emitTerraform — file set', () => {
  it('returns dashboard.tf, versions.tf, and variables.tf', () => {
    const files = emitTerraform(model, { accountId: null });
    expect(Object.keys(files).sort()).toEqual([
      'dashboard.tf',
      'variables.tf',
      'versions.tf',
    ]);
  });
});

describe('emitTerraform — dashboard.tf', () => {
  it('emits a newrelic_one_dashboard resource with the dashboard name', () => {
    const { 'dashboard.tf': tf } = emitTerraform(model, { accountId: null });
    expect(tf).toContain('resource "newrelic_one_dashboard"');
    expect(tf).toContain('name = "Web Health"');
  });

  it('emits a widget_line with an nrql_query carrying account_id and the NRQL', () => {
    const { 'dashboard.tf': tf } = emitTerraform(model, { accountId: null });
    expect(tf).toContain('widget_line {');
    expect(tf).toContain('account_id = var.account_id');
    expect(tf).toContain('query      = "FROM Log SELECT count(*)"');
  });

  it('emits a widget_markdown with text and NO nrql_query for placeholders', () => {
    const { 'dashboard.tf': tf } = emitTerraform(model, { accountId: null });
    const markdownBlock = tf.slice(tf.indexOf('widget_markdown {'));
    expect(markdownBlock).toContain('text =');
    expect(markdownBlock.slice(0, markdownBlock.indexOf('}'))).not.toContain(
      'nrql_query',
    );
  });

  it('bakes a literal account_id when provided', () => {
    const { 'dashboard.tf': tf } = emitTerraform(model, { accountId: 12345 });
    expect(tf).toContain('account_id = 12345');
    expect(tf).not.toContain('account_id = var.account_id');
  });
});

describe('emitTerraform — versions.tf and variables.tf', () => {
  it('pins the newrelic provider in versions.tf', () => {
    const { 'versions.tf': v } = emitTerraform(model, { accountId: null });
    expect(v).toContain('newrelic/newrelic');
    expect(v).toContain('required_providers');
  });

  it('declares a sensitive api key var and NO literal key in variables.tf', () => {
    const { 'variables.tf': vars } = emitTerraform(model, { accountId: null });
    expect(vars).toContain('variable "newrelic_api_key"');
    expect(vars).toContain('sensitive   = true');
    expect(vars).toContain('variable "account_id"');
    expect(vars).toContain('provider "newrelic"');
    expect(vars).not.toMatch(/NRAK-/); // never a literal key
  });

  it("emits no backend block (state config is the user's)", () => {
    const files = emitTerraform(model, { accountId: null });
    for (const tf of Object.values(files)) {
      expect(tf).not.toContain('backend "');
    }
  });
});

describe('emitTerraform — hclString HCL template interpolation escaping', () => {
  it('escapes ${ and %{ in widget title and markdown text so Terraform does not interpolate them', () => {
    const templateModel = {
      title: 'Dashboard ${env}',
      description: 'desc',
      widgets: [
        {
          title: 'Widget ${env} title',
          vizType: 'markdown',
          outcome: 'placeholder',
          placeholderText: 'SPL: index=${env} %{x}',
          warnings: [],
          layout: { x: 0, y: 0, w: 6, h: 3 },
        },
      ],
    };
    const { 'dashboard.tf': tf } = emitTerraform(templateModel, {
      accountId: null,
    });
    expect(tf).toContain('$${env}');
    expect(tf).toContain('%%{x}');
    // raw (unescaped) forms must not appear: check for ${env} not preceded by $, %{x} not preceded by %
    expect(tf).not.toMatch(/(?<!\$)\$\{env\}/);
    expect(tf).not.toMatch(/(?<!%)%\{x\}/);
  });
});

describe('slugify — digit-leading resource label', () => {
  it('prefixes an underscore when the slug starts with a digit', () => {
    expect(slugify('2024 Dashboard')).toMatch(/^[A-Za-z_]/);
    expect(slugify('2024 Dashboard')).toBe('_2024-dashboard');
  });

  it('leaves a normal title slug unchanged', () => {
    expect(slugify('Web Health')).toBe('web-health');
  });
});

function hasTerraform() {
  try {
    execFileSync('terraform', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('emitTerraform — terraform validate (integration)', () => {
  it.skipIf(!hasTerraform())(
    'emitted HCL passes terraform validate',
    () => {
      const files = emitTerraform(model, { accountId: 12345 });
      const dir = mkdtempSync(join(tmpdir(), 'tf-emit-'));
      for (const [name, body] of Object.entries(files))
        writeFileSync(join(dir, name), body);
      execFileSync('terraform', ['init', '-backend=false', '-input=false'], {
        cwd: dir,
        stdio: 'ignore',
      });
      execFileSync('terraform', ['validate'], { cwd: dir, stdio: 'pipe' });
      expect(existsSync(join(dir, 'dashboard.tf'))).toBe(true);
    },
    60_000,
  );
});
