import { translateSplToNrqlV2 } from '../../src/translateV2.js';

const queries = [
  '* | where like(host, "web*")',
  '* | where cidrmatch("10.0.0.0/8", src_ip)',
  '* | join type=left src_ip [search index=geo | table src_ip, country]',
  '* | stats count | predict count',
  '* | bin size span=10',
  '* | fillnull value=0',
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
