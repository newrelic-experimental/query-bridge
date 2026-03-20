import { translateSplToNrqlV2 } from '../../src/translateV2.js';

const queries = [
  '* | where match(host, "^web[0-9]+$")',
  '* | regex message="error\\\\d+"',
  '* | regex status!="^2\\\\d{2}$"',
  '* | regex "fatal|critical"',
  'status=500 | regex message="timeout"',
  '* | regex uri_path="^/api/v[0-9]+"',
];

describe('V2 show output', () => {
  queries.forEach((spl, i) => {
    it(`[${i}] ${spl}`, () => {
      const v2 = translateSplToNrqlV2(spl);
      console.log(`  SPL:  ${spl}`);
      console.log(`  V2:   ${v2.nrql}`);
      if (v2.warnings.length) console.log(`  W:    ${v2.warnings.join('; ')}`);
      if (v2.unsupported.length)
        console.log(`  U:    ${v2.unsupported.join('; ')}`);
      if (v2.errors.length) console.log(`  E:    ${v2.errors.join('; ')}`);
    });
  });
});
