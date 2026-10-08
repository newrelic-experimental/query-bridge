#!/usr/bin/env node

/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectFormat } from '../src/detectFormat.js';
import { parseSimpleXml } from '../src/parseSimpleXml.js';
import { parseStudio } from '../src/parseStudio.js';
import { translateWidgets } from '../src/translateWidgets.js';
import { translateVariables } from '../src/translateVariables.js';
import { emitTerraform, slugify } from '../src/emitTerraform.js';
import { buildReport } from '../src/report.js';
import { PREVIEW_FLAG_NAMES } from '@newrelic/query-bridge';

// Provider regions the importer can target. `Staging` routes the New Relic
// provider to staging-api.newrelic.com (internal). Validated at the CLI boundary;
// keys are lowercased input, values are the canonical provider region string.
const REGIONS = { us: 'US', eu: 'EU', jp: 'JP', staging: 'Staging' };

const usage = `Usage:
  spl-dashboard <file.xml>              translate a Splunk Simple XML dashboard to Terraform
  cat dash.xml | spl-dashboard          read from stdin
  spl-dashboard <file.xml> --out ./dir  output directory (default: .)
  spl-dashboard <file.xml> --account 12345  bake a literal account_id
  spl-dashboard <file.xml> --region Staging  provider region: US (default), EU, JP, Staging
  spl-dashboard <file.xml> --preview=expand,split   opt in to NRQL Limited Preview syntax
  spl-dashboard <file.xml> --preview-all            enable every preview flag

Preview flags (each needs the matching NRQL Beta flag on the target account):
  ${PREVIEW_FLAG_NAMES.join(', ')}`;

function parseUnit(unit) {
  return unit.format === 'studio'
    ? parseStudio(unit.payload)
    : parseSimpleXml(unit.payload);
}

/**
 * Pure pipeline: raw input → one result per detected unit (a REST envelope yields
 * many). Each result is either a built dashboard `{slug, files}` or a skipped entry
 * `{skipped, index, reason}` — one malformed entry never aborts its siblings. A
 * malformed envelope itself still throws at `detectFormat` (a loud, top-level error).
 * @param {string} input
 * @param {{account:number|null, region?:string, preview?:object}} opts
 * @returns {({skipped:false, slug:string, files:Record<string,string>}|{skipped:true, index:number, reason:string})[]}
 */
export function runImport(input, opts) {
  // De-duplicate slugs so two same-title dashboards in one bulk export don't
  // overwrite each other's output dir (first wins the bare slug, then -2, -3…).
  const seenSlugs = new Map();
  return detectFormat(input).map((unit, index) => {
    try {
      const model = parseUnit(unit);
      const multiSelectTokens = new Set(
        model.variables.filter((v) => v.multi).map((v) => v.name),
      );
      const translated = translateWidgets(model.widgets, {
        multiSelectTokens,
        preview: opts.preview,
      });
      const variables = translateVariables(model.variables, {
        preview: opts.preview,
      });
      const emitModel = { ...model, widgets: translated, variables };
      const tf = emitTerraform(emitModel, {
        accountId: opts.account,
        region: opts.region,
      });
      const baseSlug = slugify(model.title);
      const n = (seenSlugs.get(baseSlug) ?? 0) + 1;
      seenSlugs.set(baseSlug, n);
      const slug = n === 1 ? baseSlug : `${baseSlug}-${n}`;
      const report = buildReport(model.title, translated);
      return {
        skipped: false,
        slug,
        files: {
          [`${slug}.tf`]: tf['dashboard.tf'],
          'versions.tf': tf['versions.tf'],
          'variables.tf': tf['variables.tf'],
          [`${slug}.report.md`]: report,
        },
      };
    } catch (e) {
      // Isolate a bad entry: record it loudly, never abort the siblings or emit a
      // half-built dashboard. The CLI surfaces the reason on stderr.
      return { skipped: true, index, reason: e.message };
    }
  });
}

export function parseArgs(argv) {
  const opts = { out: '.', account: null, file: null, preview: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--account') {
      const n = Number(argv[++i]);
      if (Number.isNaN(n)) throw new Error('--account must be a number');
      opts.account = n;
    } else if (a === '--region') {
      const r = REGIONS[String(argv[++i]).toLowerCase()];
      if (!r) throw new Error('--region must be one of US, EU, JP, Staging');
      opts.region = r;
    } else if (a === '--preview' || a.startsWith('--preview=')) {
      // `--preview=a,b` or `--preview a,b`; repeatable.
      const raw = a.startsWith('--preview=') ? a.slice(10) : argv[++i];
      const names = String(raw ?? '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
      const unknown = names.filter((n) => !PREVIEW_FLAG_NAMES.includes(n));
      if (unknown.length > 0) {
        throw new Error(
          `--preview has unknown flag(s): ${unknown.join(', ')}; ` +
            `valid flags: ${PREVIEW_FLAG_NAMES.join(', ')}`,
        );
      }
      opts.preview = opts.preview ?? {};
      for (const n of names) opts.preview[n] = true;
    } else if (a === '--preview-all') {
      opts.preview = opts.preview ?? {};
      for (const n of PREVIEW_FLAG_NAMES) opts.preview[n] = true;
    } else if (a === '--format')
      i++; // accepted, terraform-only in Phase 1
    else if (!a.startsWith('-')) opts.file = a;
  }
  return opts;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(usage);
    return;
  }
  let opts, results;
  try {
    opts = parseArgs(argv);
    const xml = opts.file
      ? readFileSync(opts.file, 'utf-8')
      : await readStdin();
    if (!xml.trim()) {
      console.log(usage);
      return;
    }
    results = runImport(xml, {
      account: opts.account,
      region: opts.region,
      preview: opts.preview,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }
  // Surface skipped entries loudly; never silently drop one. An all-skipped or
  // empty export is still a success (zero dashboards), per the bulk-import design.
  for (const r of results) {
    if (r.skipped) {
      process.stderr.write(`skipped entry ${r.index}: ${r.reason}\n`);
    }
  }
  const dashboards =
    /** @type {{skipped:false, slug:string, files:Record<string,string>}[]} */ (
      results.filter((r) => !r.skipped)
    );
  for (const r of dashboards) {
    const dir = dashboards.length > 1 ? join(opts.out, r.slug) : opts.out;
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(r.files)) {
      const path = join(dir, name);
      writeFileSync(path, body);
      process.stdout.write(`${path}\n`);
    }
  }
}

// Only run main when invoked as a script, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('spl-dashboard.js')) {
  main();
}
