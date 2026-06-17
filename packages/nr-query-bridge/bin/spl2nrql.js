#!/usr/bin/env node

import { translateSplToNrql } from '../src/index.js';
import { createInterface } from 'node:readline';

const usage = `Usage:
  spl2nrql "index=web status=500 | stats count by host"
  echo "index=web | stats count" | spl2nrql
  spl2nrql -i                     # interactive REPL`;

function translate(spl) {
  const result = translateSplToNrql(spl);
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

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log(usage);
} else if (args.includes('-i') || args.includes('--interactive')) {
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
