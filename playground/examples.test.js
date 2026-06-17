// playground/examples.test.js — repo-level guard that the playground demo's
// color-coding stays honest as the translator evolves (the playground is repo
// docs, not part of the shipped translator package).
import { EXAMPLES } from './examples.js';
import { translateSplToNrql } from '../packages/nr-query-bridge/src/index.js';

// Expected result type per demo, by index (0-based), matching the playground
// examples ordering.
// 'green'  → has nrql, no warnings
// 'amber'  → has nrql, with warnings
// 'red'    → unsupported or errors present (no nrql)
const EXPECTED_TYPES = [
  'amber', // 1. stats by host → FACET-limit warning
  'amber', // 2. timechart → FACET-limit warning
  'amber', // 3. rex + stats → FACET-limit warning
  'green', // 4. count(eval) → clean
  'amber', // 5. eventstats → JOIN-limit warning
  'amber', // 6. append → filter() caveat warning
  'red', // 7. transaction → unsupported
  'amber', // 8. top by host → semantic-divergence warning
  'red', // 9. mvexpand → unsupported
  'red', // 10. mvcombine → unsupported
];

function classify(result) {
  if (result.unsupported?.length || result.errors?.length) return 'red';
  if (result.warnings?.length) return 'amber';
  if (result.nrql) return 'green';
  return 'empty';
}

describe('playground demo examples', () => {
  it('has 10 examples', () => {
    expect(EXAMPLES).toHaveLength(10);
  });

  it('every example translates without throwing', () => {
    for (const { spl } of EXAMPLES) {
      expect(() => translateSplToNrql(spl)).not.toThrow();
    }
  });

  it('each example produces its expected result type', () => {
    EXAMPLES.forEach(({ spl }, i) => {
      const result = translateSplToNrql(spl);
      expect(classify(result), `example ${i + 1}: ${spl}`).toBe(
        EXPECTED_TYPES[i],
      );
    });
  });
});
