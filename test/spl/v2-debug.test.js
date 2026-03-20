import { translateSplToNrql } from '../../src/input/spl/spl.js';
import { translateSplToNrqlV2 } from '../../src/translateV2.js';

import { assembleNrql } from './assembleNrql.js';

import fs from 'fs';
import path from 'path';

describe('V2 migration patcher', () => {
  it('patches spl.test.js with v2nrql fields', () => {
    const testFile = path.join(import.meta.dirname, 'spl.test.js');
    let source = fs.readFileSync(testFile, 'utf8');

    const splRegex =
      /spl:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g;
    let match;
    const entries = [];
    while ((match = splRegex.exec(source)) !== null) {
      const spl = match[1] ?? match[2] ?? match[3] ?? null;
      entries.push({ spl, index: match.index });
    }

    let patchCount = 0;
    let skipCount = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const { spl, index } = entries[i];
      if (spl === null || spl === undefined) continue;

      const caseEnd = source.indexOf('},', index);
      const caseAlt = source.indexOf('}\n', index);
      const end = Math.min(
        caseEnd >= 0 ? caseEnd : Infinity,
        caseAlt >= 0 ? caseAlt : Infinity,
      );
      if (end === Infinity) continue;

      const caseSlice = source.substring(index, end);
      if (caseSlice.includes('v2nrql')) {
        skipCount++;
        continue;
      }

      const v1 = translateSplToNrql(spl);
      const v1Nrql = assembleNrql(v1) || '';
      const v2 = translateSplToNrqlV2(spl);
      const v2Nrql = v2.nrql || '';

      if (v1.errors.length > 0 || v2.errors.length > 0 || !v2Nrql) continue;

      const isExact = v1Nrql === v2Nrql;
      const isSemantic =
        !isExact && v1Nrql.replace(/`/g, '') === v2Nrql.replace(/`/g, '');

      if (!isExact && !isSemantic) continue;

      const caseText = source.substring(index, end + 1);
      let insertBefore = null;
      const docMatch = caseText.match(/\n(\s+)doc:/);
      const verifiedMatch = caseText.match(/\n(\s+)verified:/);

      if (docMatch) {
        insertBefore = index + docMatch.index + 1;
      } else if (verifiedMatch) {
        insertBefore = index + verifiedMatch.index + 1;
      }

      if (!insertBefore) continue;

      const indent = (docMatch || verifiedMatch)[1];
      // Use double-quoted string to avoid escaping issues with single quotes
      const escaped = v2Nrql.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const insertLine = `${indent}v2nrql: "${escaped}",\n`;

      source =
        source.substring(0, insertBefore) +
        insertLine +
        source.substring(insertBefore);
      patchCount++;
    }

    console.log(
      `\nPatched ${patchCount} cases, skipped ${skipCount} (already have v2nrql)`,
    );
    fs.writeFileSync(testFile, source);
    console.log('Wrote patched spl.test.js');
  });
});

describe('V2 divergence dump', () => {
  it('lists all divergent unit cases', () => {
    const testFile = path.join(import.meta.dirname, 'spl.test.js');
    const testSource = fs.readFileSync(testFile, 'utf8');
    const splRegex =
      /spl:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g;
    let match;
    const spls = [];
    while ((match = splRegex.exec(testSource)) !== null) {
      const spl = match[1] ?? match[2] ?? match[3] ?? null;
      spls.push(spl);
    }

    const divergences = [];
    spls.forEach((spl, i) => {
      if (spl === null || spl === undefined) return;
      const v1 = translateSplToNrql(spl);
      const v1Nrql = assembleNrql(v1) || '';
      const v2 = translateSplToNrqlV2(spl);
      const v2Nrql = v2.nrql || '';

      if (v1.errors.length > 0) return;
      if (v2.errors.length > 0) {
        divergences.push({
          i,
          spl,
          v1nrql: v1Nrql,
          v2nrql: '(V2 ERROR: ' + v2.errors.join('; ') + ')',
          type: 'v2error',
        });
        return;
      }
      if (!v2Nrql) return;

      const isExact = v1Nrql === v2Nrql;
      const isSemantic =
        !isExact && v1Nrql.replace(/`/g, '') === v2Nrql.replace(/`/g, '');

      if (!isExact && !isSemantic) {
        divergences.push({
          i,
          spl,
          v1nrql: v1Nrql,
          v2nrql: v2Nrql,
          type: 'divergence',
        });
      }
    });

    const tmpDir = path.resolve(import.meta.dirname, '../../tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'v2-divergences.json'),
      JSON.stringify(divergences, null, 2),
    );
    console.log(`\nFound ${divergences.length} divergences`);
  });
});
