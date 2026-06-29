import { describe, it, expect } from 'vitest';
import * as parser from '../../src/input/spl/splParser.js';
import { translateAstToIR } from '../../src/input/spl/splToIR.js';
import { optimize } from '../../src/ir/optimize.js';
import { emitQuery } from '../../src/output/nrql/irToNrql.js';

const buildIr = (spl) => translateAstToIR(parser.parse(spl));

describe('orderByOnAggregation — fold-stability', () => {
  it('optimize is a fixed point on a restructured subquery (rare)', () => {
    // AI-DEV: AI **MUST NOT** weaken this test. The restructured SubquerySource must
    // survive a second optimize pass unchanged — foldPostAggregationPass must not
    // collapse the intentional ordering subquery back to the flat (ignored-ORDER BY) form.
    const once = optimize(buildIr('* | rare host'));
    const twice = optimize(once);
    expect(emitQuery(once)).toContain('FROM ('); // really restructured
    expect(emitQuery(once)).toContain('ORDER BY count ASC');
    expect(emitQuery(twice)).toBe(emitQuery(once)); // idempotent
  });

  it('optimize is a fixed point on a restructured facet-key sort', () => {
    // AI-DEV: AI **MUST NOT** weaken this test. See the rare case above.
    const once = optimize(buildIr('* | stats count by host | sort host'));
    const twice = optimize(once);
    expect(emitQuery(once)).toContain('FROM (');
    expect(emitQuery(twice)).toBe(emitQuery(once));
  });
});
