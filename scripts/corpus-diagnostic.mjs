import { readFileSync } from 'node:fs';
import path from 'node:path';
import { translateSplToNrql } from '../src/translate.js';

const corpusPath = path.join(import.meta.dirname, '..', 'test', 'spl', 'spl-real-world.json');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')).map((e) => e.spl);

function splitTopLevel(spl) {
  const segs = [];
  let depth = 0,
    inStr = null,
    cur = '';
  for (let k = 0; k < spl.length; k++) {
    const c = spl[k];
    if (inStr) {
      cur += c;
      if (c === inStr && spl[k - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      cur += c;
      continue;
    }
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (c === '|' && depth === 0) {
      segs.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

function leadKeyword(seg, isFirst) {
  const m = seg.match(/^([a-zA-Z_]+)/);
  if (isFirst && !/^\s*\|/.test(seg)) return 'search';
  return m ? m[1].toLowerCase() : '(other)';
}

const counters = { clean: 0, warningsOnly: 0, unsupported: 0, errors: 0, thrown: 0 };
const byKw = new Map();

for (let i = 0; i < corpus.length; i++) {
  let r;
  try {
    r = translateSplToNrql(corpus[i]);
  } catch {
    counters.thrown++;
    continue;
  }
  if (r.errors.length > 0) {
    counters.errors++;
    const segs = splitTopLevel(corpus[i]);
    let kw = '(whole-query-only)';
    for (let s = 0; s < segs.length; s++) {
      const isFirst = s === 0;
      const probe = isFirst ? segs[s] : `index=_probe | ${segs[s]}`;
      let pr;
      try {
        pr = translateSplToNrql(probe);
      } catch {
        pr = { errors: ['THROWN'] };
      }
      if (pr.errors && pr.errors.length > 0) {
        kw = leadKeyword(segs[s], isFirst);
        break;
      }
    }
    byKw.set(kw, (byKw.get(kw) || 0) + 1);
  } else if (r.unsupported.length > 0) counters.unsupported++;
  else if (r.warnings.length > 0) counters.warningsOnly++;
  else counters.clean++;
}

const total = corpus.length;
const pct = (n) => ((n / total) * 100).toFixed(1) + '%';
console.log(`CORPUS (${total} queries)`);
console.log(`  clean:       ${counters.clean} (${pct(counters.clean)})`);
console.log(`  warningsOnly: ${counters.warningsOnly} (${pct(counters.warningsOnly)})`);
console.log(`  unsupported: ${counters.unsupported} (${pct(counters.unsupported)})`);
console.log(`  errors:      ${counters.errors} (${pct(counters.errors)})`);
console.log(`  thrown:      ${counters.thrown} (${pct(counters.thrown)})`);
console.log('\nERRORS BY ATTRIBUTED COMMAND:');
for (const [kw, n] of [...byKw.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${kw}`);
}
