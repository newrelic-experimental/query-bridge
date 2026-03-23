import { translateSplToNrql } from '../../src/translate.js';

const queries = ['* | stats count by host'];

describe('show output', () => {
  queries.forEach((spl, i) => {
    it(`[${i}] ${spl}`, () => {
      const r = translateSplToNrql(spl);
      console.log(`  SPL:  ${spl}`);
      console.log(`  NRQL: ${JSON.stringify(r.nrql)}`);
      if (r.warnings.length)
        console.log(`  W:    ${JSON.stringify(r.warnings)}`);
      if (r.unsupported.length)
        console.log(`  U:    ${JSON.stringify(r.unsupported)}`);
      if (r.errors.length) console.log(`  E:    ${JSON.stringify(r.errors)}`);
    });
  });
});
