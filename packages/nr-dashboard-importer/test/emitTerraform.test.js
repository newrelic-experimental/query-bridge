/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  emitTerraform,
  slugify,
  EMITTABLE_VIZ_TYPES,
} from '../src/emitTerraform.js';

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

describe('emitTerraform — chart widget blocks', () => {
  const chartModel = (vizType) => ({
    title: 'Charts',
    description: '',
    widgets: [
      {
        title: vizType,
        vizType,
        outcome: 'clean',
        nrql: 'FROM Log SELECT count(*) FACET status',
        warnings: [],
        layout: { x: 0, y: 0, w: 6, h: 3 },
      },
    ],
  });

  it('emits widget_pie with an nrql_query, never widget_markdown, for a pie chart', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If it fails, the area/bar/pie
    // widget blocks (BUG2) regressed — fix the code, not the test.
    const { 'dashboard.tf': tf } = emitTerraform(chartModel('pie'), {
      accountId: 1,
    });
    expect(tf).toContain('widget_pie {');
    expect(tf).toContain('nrql_query {');
    expect(tf).not.toContain('widget_markdown');
  });

  it('maps area→widget_area, bar→widget_bar, and column→widget_bar', () => {
    expect(
      emitTerraform(chartModel('area'), { accountId: 1 })['dashboard.tf'],
    ).toContain('widget_area {');
    expect(
      emitTerraform(chartModel('bar'), { accountId: 1 })['dashboard.tf'],
    ).toContain('widget_bar {');
    expect(
      emitTerraform(chartModel('column'), { accountId: 1 })['dashboard.tf'],
    ).toContain('widget_bar {');
  });

  it('throws loudly when a non-emittable vizType reaches the emitter', () => {
    // AI-DEV: AI **MUST NOT** touch this test. The chokepoint placeholders
    // scatter/map/unknown upstream; one reaching emit is a pipeline bug.
    expect(() =>
      emitTerraform(chartModel('scatter'), { accountId: 1 }),
    ).toThrow(/unmappable vizType/);
  });

  it('excludes scatter, map, and unknown from EMITTABLE_VIZ_TYPES', () => {
    expect(EMITTABLE_VIZ_TYPES.has('pie')).toBe(true);
    expect(EMITTABLE_VIZ_TYPES.has('scatter')).toBe(false);
    expect(EMITTABLE_VIZ_TYPES.has('map')).toBe(false);
    expect(EMITTABLE_VIZ_TYPES.has('unknown')).toBe(false);
  });
});

describe('emitTerraform — variable blocks', () => {
  const withVars = (variables) => ({
    title: 'V',
    description: '',
    widgets: [
      {
        title: 'W',
        vizType: 'line',
        outcome: 'clean',
        nrql: 'FROM Log SELECT count(*)',
        warnings: [],
        layout: { x: 0, y: 0, w: 6, h: 3 },
      },
    ],
    variables,
  });

  it('emits a full enum variable block with items, default, and string strategy', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If it fails, enum variable block
    // emission (BUG6) regressed — fix the code, not the test.
    const v = {
      name: 'env',
      type: 'enum',
      defaultValue: '*',
      choices: [
        { value: '*', title: 'All' },
        { value: 'prod', title: 'Prod' },
      ],
      multi: false,
      sourceQuery: null,
    };
    const { 'dashboard.tf': tf } = emitTerraform(withVars([v]), {
      accountId: 1,
    });
    expect(tf).toContain('variable {');
    expect(tf).toContain('name  = "env"');
    expect(tf).toContain('type = "enum"');
    expect(tf).toContain('default_values = ["*"]');
    expect(tf).toContain('is_multi_selection = false');
    expect(tf).toContain('replacement_strategy = "string"');
    expect(tf).toContain('value = "prod"');
    expect(tf).toContain('title = "Prod"');
  });

  it('chooses replacement_strategy "number" when all choice values are numeric', () => {
    // AI-DEV: AI **MUST NOT** touch this test. If it fails, the numeric
    // replacement_strategy heuristic regressed — fix the code, not the test.
    const v = {
      name: 'code',
      type: 'enum',
      defaultValue: '*',
      choices: [
        { value: '*', title: 'All' },
        { value: '404', title: '404' },
        { value: '500', title: '500' },
      ],
      multi: false,
      sourceQuery: null,
    };
    const { 'dashboard.tf': tf } = emitTerraform(withVars([v]), {
      accountId: 1,
    });
    expect(tf).toContain('replacement_strategy = "number"');
  });

  it('emits a string variable block for a text input', () => {
    const v = {
      name: 'needle',
      type: 'string',
      defaultValue: 'err',
      choices: [],
      multi: false,
      sourceQuery: null,
    };
    const { 'dashboard.tf': tf } = emitTerraform(withVars([v]), {
      accountId: 1,
    });
    expect(tf).toContain('type = "string"');
    expect(tf).toContain('default_values = ["err"]');
  });

  it('emits is_multi_selection = true for a multiselect variable', () => {
    const v = {
      name: 'hosts',
      type: 'enum',
      defaultValue: '',
      choices: [{ value: 'a', title: 'A' }],
      multi: true,
      sourceQuery: null,
    };
    const { 'dashboard.tf': tf } = emitTerraform(withVars([v]), {
      accountId: 1,
    });
    expect(tf).toContain('is_multi_selection = true');
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

  it('defaults the provider region to US', () => {
    const { 'variables.tf': vars } = emitTerraform(model, { accountId: null });
    expect(vars).toMatch(/region\s+= "US"/);
  });

  it('emits the provider region from opts.region', () => {
    const { 'variables.tf': vars } = emitTerraform(model, {
      accountId: null,
      region: 'Staging',
    });
    expect(vars).toMatch(/region\s+= "Staging"/);
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

  it.skipIf(!hasTerraform())(
    'enum and string variable blocks pass terraform validate',
    () => {
      const varsModel = {
        title: 'V',
        description: '',
        widgets: [
          {
            title: 'W',
            vizType: 'line',
            outcome: 'clean',
            nrql: 'FROM Log SELECT count(*)',
            warnings: [],
            layout: { x: 0, y: 0, w: 6, h: 3 },
          },
        ],
        variables: [
          {
            name: 'env',
            type: 'enum',
            defaultValue: '*',
            choices: [
              { value: '*', title: 'All' },
              { value: 'prod', title: 'Prod' },
            ],
            multi: false,
            sourceQuery: null,
          },
          {
            name: 'needle',
            type: 'string',
            defaultValue: 'err',
            choices: [],
            multi: false,
            sourceQuery: null,
          },
        ],
      };
      const files = emitTerraform(varsModel, { accountId: 12345 });
      const dir = mkdtempSync(join(tmpdir(), 'tf-vars-'));
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

  it.skipIf(!hasTerraform())(
    'a type="nrql" variable block passes terraform validate',
    () => {
      const nrqlVarModel = {
        title: 'NV',
        description: '',
        widgets: [
          {
            title: 'W',
            vizType: 'line',
            outcome: 'clean',
            nrql: 'FROM Log SELECT count(*)',
            warnings: [],
            layout: { x: 0, y: 0, w: 6, h: 3 },
          },
        ],
        variables: [
          {
            name: 'host',
            type: 'nrql',
            defaultValue: '',
            choices: [],
            multi: false,
            sourceQuery: 'FROM Log SELECT count(*) FACET host',
          },
        ],
      };
      const files = emitTerraform(nrqlVarModel, { accountId: 12345 });
      const dir = mkdtempSync(join(tmpdir(), 'tf-nrqlvar-'));
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

  it.skipIf(!hasTerraform())(
    'area/bar/pie widget blocks pass terraform validate',
    () => {
      const chartsModel = {
        title: 'Charts',
        description: '',
        widgets: ['area', 'bar', 'column', 'pie'].map((vizType, i) => ({
          title: vizType,
          vizType,
          outcome: 'clean',
          nrql: 'FROM Log SELECT count(*) FACET status',
          warnings: [],
          layout: { x: (i % 2) * 6, y: Math.floor(i / 2) * 3, w: 6, h: 3 },
        })),
      };
      const files = emitTerraform(chartsModel, { accountId: 12345 });
      const dir = mkdtempSync(join(tmpdir(), 'tf-charts-'));
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
