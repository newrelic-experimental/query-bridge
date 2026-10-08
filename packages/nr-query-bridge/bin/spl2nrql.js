#!/usr/bin/env node

/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { translateSplToNrql, PREVIEW_FLAG_NAMES } from '../src/index.js';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const usage = `Usage:
  spl2nrql "index=web status=500 | stats count by host"
  echo "index=web | stats count" | spl2nrql
  spl2nrql -i                     # interactive REPL

Options:
  --preview=<flag>[,<flag>...]    opt in to NRQL Limited Preview syntax
                                  (repeatable). Each flag requires the matching
                                  NRQL Beta feature flag on the target account.
  --preview-all                   enable every preview flag
  -i, --interactive               interactive REPL
  -h, --help                      show this help

Preview flags: ${PREVIEW_FLAG_NAMES.join(', ')}`;

/** @type {import('../src/previewFlags.js').TranslateOptions} */
let options = {};

function translate(spl) {
  const result = translateSplToNrql(spl, options);
  if (result.nrql) {
    process.stdout.write(result.nrql + '\n');
  }
  if (result.warnings?.length) {
    for (const w of result.warnings) {
      process.stderr.write(`warning: ${w}\n`);
    }
  }
  if (result.unsupported?.length) {
    for (const u of result.unsupported) {
      process.stderr.write(`unsupported: ${u}\n`);
    }
  }
  if (result.errors?.length) {
    for (const e of result.errors) {
      process.stderr.write(`error: ${e}\n`);
    }
    process.exitCode = 1;
  }
}

function repl() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'spl> ',
  });
  rl.prompt();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed) translate(trimmed);
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

// Real argv parsing, not `args.includes(...)`: the positional SPL must be
// separated from the flags, or an unrecognized flag gets joined into the query
// string and surfaces as a baffling SPL parse error.
let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: 'string', short: 'h' },
      interactive: { type: 'string', short: 'i' },
      preview: { type: 'string', multiple: true },
      'preview-all': { type: 'boolean' },
    },
    allowPositionals: true,
    // `-h`/`-i` are historically bare; declaring them as strings would demand a
    // value, so accept them loosely and treat presence as the signal.
    strict: false,
  });
} catch (e) {
  process.stderr.write(`error: ${e.message}\n\n${usage}\n`);
  process.exit(1);
}

const flagValues = parsed.values;
const requested = new Set(
  [].concat(flagValues.preview ?? []).flatMap((v) => String(v).split(',')),
);
requested.delete('');

if (flagValues['preview-all']) {
  for (const name of PREVIEW_FLAG_NAMES) requested.add(name);
}

const unknown = [...requested].filter((f) => !PREVIEW_FLAG_NAMES.includes(f));
if (unknown.length > 0) {
  process.stderr.write(
    `error: unknown preview flag(s): ${unknown.join(', ')}\n` +
      `valid flags: ${PREVIEW_FLAG_NAMES.join(', ')}\n`,
  );
  process.exit(1);
}

if (requested.size > 0) {
  options = {
    preview: Object.fromEntries([...requested].map((f) => [f, true])),
  };
}

const args = parsed.positionals;

if ('help' in flagValues || 'h' in flagValues) {
  console.log(usage);
} else if ('interactive' in flagValues || 'i' in flagValues) {
  repl();
} else if (args.length > 0) {
  translate(args.join(' '));
} else if (!process.stdin.isTTY) {
  readStdin().then((input) => {
    if (input) translate(input);
  });
} else {
  console.log(usage);
}
