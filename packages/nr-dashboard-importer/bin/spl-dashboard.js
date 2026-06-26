#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectFormat } from '../src/detectFormat.js';
import { parseSimpleXml } from '../src/parseSimpleXml.js';
import { parseStudio } from '../src/parseStudio.js';
import { translateWidgets } from '../src/translateWidgets.js';
import { translateVariables } from '../src/translateVariables.js';
import { emitTerraform, slugify } from '../src/emitTerraform.js';
import { buildReport } from '../src/report.js';

// Provider regions the importer can target. `Staging` routes the New Relic
// provider to staging-api.newrelic.com (internal). Validated at the CLI boundary;
// keys are lowercased input, values are the canonical provider region string.
const REGIONS = { us: 'US', eu: 'EU', jp: 'JP', staging: 'Staging' };

const usage = `Usage:
  spl-dashboard <file.xml>              translate a Splunk Simple XML dashboard to Terraform
  cat dash.xml | spl-dashboard          read from stdin
  spl-dashboard <file.xml> --out ./dir  output directory (default: .)
  spl-dashboard <file.xml> --account 12345  bake a literal account_id
  spl-dashboard <file.xml> --region Staging  provider region: US (default), EU, JP, Staging`;

function parseUnit(unit) {
  return unit.format === 'studio'
    ? parseStudio(unit.payload)
    : parseSimpleXml(unit.payload);
}

/**
 * Pure pipeline: raw input → array of { slug, files }. A REST envelope yields many.
 * @param {string} input
 * @param {{account:number|null, region?:string}} opts
 * @returns {{slug:string, files:Record<string,string>}[]}
 */
export function runImport(input, opts) {
  return detectFormat(input).map((unit) => {
    const model = parseUnit(unit);
    const multiSelectTokens = new Set(
      model.variables.filter((v) => v.multi).map((v) => v.name),
    );
    const translated = translateWidgets(model.widgets, { multiSelectTokens });
    const variables = translateVariables(model.variables);
    const emitModel = { ...model, widgets: translated, variables };
    const tf = emitTerraform(emitModel, {
      accountId: opts.account,
      region: opts.region,
    });
    const slug = slugify(model.title);
    const report = buildReport(model.title, translated);
    return {
      slug,
      files: {
        [`${slug}.tf`]: tf['dashboard.tf'],
        'versions.tf': tf['versions.tf'],
        'variables.tf': tf['variables.tf'],
        [`${slug}.report.md`]: report,
      },
    };
  });
}

export function parseArgs(argv) {
  const opts = { out: '.', account: null, file: null };
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
    results = runImport(xml, { account: opts.account, region: opts.region });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }
  for (const r of results) {
    const dir = results.length > 1 ? join(opts.out, r.slug) : opts.out;
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
