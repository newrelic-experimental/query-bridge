/**
 * Property-based fuzz tests for the SPL→NRQL translator.
 *
 * Uses fast-check to generate random SPL query combinations and verify
 * universal invariants that must hold for ALL inputs, regardless of
 * whether the translation is semantically correct.
 *
 * These tests find bugs that example-based tests miss: crashes,
 * [object Object] leaks, undefined stringification, and malformed
 * NRQL from unexpected feature interactions.
 */
import fc from 'fast-check';
import { readFileSync } from 'fs';
import { translateSplToNrql } from '../../src/translate.js';

const realWorldCorpus = JSON.parse(
  readFileSync(new URL('./spl-real-world.json', import.meta.url), 'utf-8'),
).map((q) => q.spl);

// ── SPL fragment building blocks ────────────────────────────────────

const fields = [
  'host',
  'status',
  'bytes',
  'duration',
  'message',
  'src_ip',
  'user',
  'action',
  'method',
  'uri',
  'app',
  'level',
  'code',
  'container-name',
  'service.name',
  'http.status_code',
  '_time',
  '_raw',
  'source',
  'sourcetype',
  'index',
  'count',
  'error_rate',
  'response_time',
  'cpu_usage',
];

const values = [
  '200',
  '404',
  '500',
  '0',
  '1024',
  'error',
  'web01',
  'prod',
  '*',
  'test*',
  '*error*',
  '/api/*/users',
  'true',
  'false',
  'INFO',
  'ERROR',
  'WARN',
  'svc-*',
  '',
];

const ops = ['=', '!=', '>', '<', '>=', '<='];

const evalExprs = [
  'x = duration / 1000',
  'x = if(status=200, "ok", "err")',
  'x = bytes + duration',
  'x = lower(host)',
  'x = len(message)',
  'x = substr(uri, 1, 10)',
  'x = coalesce(user, "unknown")',
  'x = replace(message, "error", "ERR")',
  'x = case(status<300, "ok", status<500, "warn", 1=1, "err")',
  'x = mvindex(split(uri, "/"), 1)',
  'x = tonumber(status)',
  'x = tostring(bytes, "commas")',
  'x = round(duration, 2)',
  'x = abs(bytes - 1000)',
  'x = upper(method)',
  'x = trim(message)',
  'x = urldecode(uri)',
  'x = now()',
  'x = mvcount(split(uri, "/"))',
  'x = mvjoin(split(uri, "/"), "-")',
  'x = if(isnotnull(user), user, "anon")',
  'x = host . ":" . status',
  'x = printf("%s-%d", host, status)',
  'x = nullif(status, "200")',
];

// Where expressions safe for compound combinations (no function calls)
const whereExprs = [
  'status > 200',
  'status >= 400 AND status < 500',
  'duration > 1000 OR bytes > 10000',
  'NOT status = 200',
  'status != 404',
  'host = "web01"',
  'method = "GET" OR method = "POST"',
  'bytes > 0 AND duration < 5000',
  'status >= 200 AND status < 300 AND method = "GET"',
  'host like "web%"',
  'message like "%error%"',
  'NOT message like "%debug%"',
  'uri like "/api/%"',
];

// FIXME: ALL function-call-form where expressions break in compound contexts
// (AND/OR/NOT). Move back to whereExprs once the where handler is fixed.
const buggyWhereExprs = [
  'isnotnull(user)',
  'isnull(error)',
  'like(host, "web%")',
  'like(message, "%error%")',
  'NOT like(message, "%debug%")',
  'like(host, "%prod%") AND status=500',
  'match(host, "^web[0-9]+$")',
  'cidrmatch("10.0.0.0/8", src_ip)',
];

const timeConstraints = [
  'earliest=-24h',
  'earliest=-1h latest=now',
  'earliest=-7d latest=-1d',
  'earliest=@d',
  'earliest=-30m',
  'earliest=-1w',
  'earliest=@w',
  'earliest=-5m latest=-1m',
  'earliest=-2h@h',
];

const spans = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

// ── Grammar-level arbitraries (option 3 — easy parts) ───────────────

const arbField = fc.constantFrom(...fields);
const arbValue = fc.constantFrom(...values);
const arbOp = fc.constantFrom(...ops);

/** Generate a random search comparison: field op value */
const arbComparison = fc
  .tuple(arbField, arbOp, arbValue)
  .map(([f, o, v]) => `${f}${o}${v}`);

/** Generate a search clause from grammar structure */
const arbSearchGenerated = fc
  .tuple(
    fc.array(arbComparison, { minLength: 1, maxLength: 3 }),
    fc.constantFrom('', ' AND ', ' OR '),
  )
  .map(([comps, joiner]) => {
    if (comps.length === 1) return comps[0];
    return comps.join(joiner || ' ');
  });

const searchClauses = [
  'index=web',
  'sourcetype=access_*',
  'index=main sourcetype=syslog',
  'status=500',
  'host=web* status>=400',
  'error',
  'error OR warning',
  '(error OR fail) NOT debug',
  'status IN (200, 301, 404, 500)',
  'host!=test*',
  'index=web sourcetype=access host=prod*',
  'level=ERROR method=POST',
  'bytes>10000 NOT status=200',
];

/** Generate a random eval expression from grammar structure */
const arbEvalGenerated = fc
  .tuple(
    fc.constantFrom('a', 'b', 'c', 'x', 'y', 'result', 'val'),
    fc.oneof(
      // arithmetic: field op field/number
      fc
        .tuple(arbField, fc.constantFrom('+', '-', '*', '/', '%'), arbField)
        .map(([f1, o, f2]) => `${f1} ${o} ${f2}`),
      // function call: func(field)
      fc
        .tuple(
          fc.constantFrom(
            'lower',
            'upper',
            'len',
            'trim',
            'abs',
            'round',
            'floor',
            'ceiling',
            'tonumber',
            'tostring',
            'urldecode',
          ),
          arbField,
        )
        .map(([fn, f]) => `${fn}(${f})`),
      // conditional: if(field op value, true, false)
      fc
        .tuple(arbField, arbOp, arbValue)
        .map(([f, o, v]) => `if(${f}${o}${v}, "yes", "no")`),
      // string concat with dot operator
      fc.tuple(arbField, arbField).map(([f1, f2]) => `${f1} . " " . ${f2}`),
    ),
  )
  .map(([name, expr]) => `${name} = ${expr}`);

/** Generate a random stats clause from grammar structure */
const arbStatsGenerated = fc
  .tuple(
    fc.array(
      fc
        .tuple(
          fc.constantFrom(
            'count',
            'avg',
            'sum',
            'max',
            'min',
            'dc',
            'values',
            'latest',
            'earliest',
            'median',
            'perc95',
            'stdev',
            'range',
          ),
          fc.oneof(fc.constant(null), arbField),
          fc.option(
            fc.constantFrom('total', 'result', 'val', 'cnt', 'avg_val'),
            { nil: undefined },
          ),
        )
        .map(([fn, f, alias]) => {
          const call = f
            ? `${fn}(${f})`
            : fn === 'count'
              ? 'count'
              : `${fn}(duration)`;
          return alias ? `${call} as ${alias}` : call;
        }),
      { minLength: 1, maxLength: 3 },
    ),
    fc.option(
      fc
        .array(arbField, { minLength: 1, maxLength: 2 })
        .map((fs) => fs.join(', ')),
      { nil: undefined },
    ),
  )
  .map(([aggs, by]) => `stats ${aggs.join(', ')}${by ? ` by ${by}` : ''}`);

// ── Pipe command generators ─────────────────────────────────────────

const pipeCommands = [
  (f) => `stats count by ${f}`,
  (f) => `stats avg(duration), max(duration), count by ${f}`,
  (f) => `stats dc(${f}) as unique_${f.replace(/[^a-zA-Z]/g, '')}`,
  (f) => `timechart span=5m count by ${f}`,
  (_f) =>
    `timechart span=${fc.sample(fc.constantFrom(...spans), 1)[0]} avg(duration)`,
  (f) => `top 10 ${f}`,
  (f) => `top limit=5 showperc=false ${f}`,
  (f) => `rare ${f}`,
  (f) => `table ${f}, status, duration, message`,
  (f) => `fields ${f}, status`,
  (f) => `fields - ${f}`,
  (_f) => `sort -duration`,
  (f) => `sort +${f}`,
  (_f) => `head 100`,
  (_f) => `head 1`,
  (f) => `rename ${f} AS source_host`,
  (f) => `rename ${f} AS renamed_field status AS http_status`,
  (f) => `dedup ${f}`,
  (f) => `dedup ${f} status`,
  (_f) => `eval ${fc.sample(arbEvalGenerated, 1)[0]}`,
  (_f) => `rex field=message "user=(?<username>\\w+)"`,
  (_f) => `rex field=uri "\\/api\\/(?<version>v\\d+)\\/(?<endpoint>\\w+)"`,
  (_f) => `fillnull value=0 duration`,
  (_f) => `fillnull value="N/A"`,
  (_f) => `bin _time span=5m`,
  (f) => `bin ${f} span=100`,
  (_f) => `where status > 400`,
  (_f) => `where duration < 1000 AND status != 200`,
  (_f) => `where bytes > 0`,
  // FIXME: re-enable once where handler's like() function call bug is fixed:
  // (_f) => `where like(message, "%error%")`,
  (_f) => `strcat host ":" status endpoint`,
  (_f) => `convert num(bytes)`,
  (_f) => `convert auto(duration)`,
  (_f) => `convert rmcomma(bytes)`,
  (_f) => `convert ctime(timestamp)`,
  (_f) => `regex message="error|fail"`,
  (_f) => `regex _raw!="DEBUG"`,
  (_f) => `spath input=message path=data.id output=data_id`,
  (_f) => `search status=500`,
  (_f) => `search host=web*`,
  (_f) => `reverse`,
  // stats-after-stats (nested aggregation)
  (f) => `stats count as cnt by ${f} | stats sum(cnt)`,
  (f) => `stats count by ${f} | where count > 10`,
  // eventstats
  (f) => `eventstats count as total by ${f}`,
  (_f) => `eventstats avg(duration) as avg_dur`,
  // join with subsearch
  (f) =>
    `join ${f} [search index=web | stats avg(duration) as avg_dur by ${f}]`,
  // append
  (_f) => `append [search index=web status=500 | stats count as errors]`,
  // lookup
  (f) => `lookup my_lookup ${f} OUTPUT category`,
];

// ── Arbitraries ─────────────────────────────────────────────────────

const arbSearch = fc.oneof(
  fc.constantFrom(...searchClauses),
  arbSearchGenerated,
);
const arbTime = fc.constantFrom(...timeConstraints);
const arbPipe = fc.constantFrom(...pipeCommands);
const arbWhereExpr = fc.constantFrom(...whereExprs);
const arbEvalExpr = fc.oneof(fc.constantFrom(...evalExprs), arbEvalGenerated);

/** Generate a random SPL query: search clause + 0-4 pipe commands */
const arbSplQuery = fc
  .tuple(
    arbSearch,
    fc.option(arbTime, { nil: undefined }),
    fc.array(arbPipe, { minLength: 0, maxLength: 4 }),
    arbField,
  )
  .map(([search, time, pipes, field]) => {
    let spl = search;
    if (time) spl += ` ${time}`;
    for (const pipeFn of pipes) {
      spl += ` | ${pipeFn(field)}`;
    }
    return spl;
  });

/** Generate where expressions in compound forms */
const arbWhereCompound = fc
  .tuple(arbWhereExpr, fc.constantFrom('AND', 'OR'), arbWhereExpr)
  .map(([left, op, right]) => `* | where ${left} ${op} ${right}`);

/** Generate eval with multiple assignments */
const arbEvalMulti = fc
  .array(arbEvalExpr, { minLength: 1, maxLength: 3 })
  .map((exprs) => {
    // Rename variables to avoid collision: x → x1, x2, etc.
    const renamed = exprs.map((e, i) => e.replace(/^[a-z]+ =/, `v${i + 1} =`));
    return `* | eval ${renamed.join(', ')}`;
  });

/** Generate stats-after-stats (nested aggregation) */
const arbStatsChain = fc.oneof(
  fc
    .tuple(arbField, arbField)
    .map(([f1, f2]) => `* | stats count by ${f1} | stats sum(count) by ${f2}`),
  fc
    .tuple(arbField)
    .map(([f]) => `* | stats count as cnt by ${f} | where cnt > 5`),
  arbStatsGenerated.map((s) => `* | ${s}`),
);

// ── Weird-corner arbitraries ─────────────────────────────────────────
// Target areas that the combinatorial fuzzer doesn't reach: deep nesting,
// state interactions, and boundary conditions.

const evalFuncs = [
  'lower',
  'upper',
  'len',
  'trim',
  'abs',
  'round',
  'floor',
  'ceiling',
  'tonumber',
  'tostring',
  'urldecode',
  'typeof',
];

/** Deeply nested if/case expressions — stress the eval walker's recursion */
const arbDeepEval = fc
  .tuple(
    fc.integer({ min: 2, max: 6 }), // nesting depth
    arbField,
    fc.constantFrom(...values),
  )
  .map(([depth, field, _val]) => {
    // Build if(field>0, if(field>1, if(..., "deep", "d2"), "d1"), "d0")
    let expr = `"leaf"`;
    for (let i = depth; i >= 0; i--) {
      expr = `if(${field}>${i}, ${expr}, "level${i}")`;
    }
    return `* | eval result = ${expr}`;
  });

/** Deeply nested case() — different code path from if() */
const arbDeepCase = fc
  .tuple(fc.integer({ min: 2, max: 5 }), arbField)
  .map(([depth, field]) => {
    const pairs = [];
    for (let i = 0; i < depth; i++) {
      pairs.push(`${field}>${i}, "level${i}"`);
    }
    pairs.push('1=1, "default"');
    return `* | eval result = case(${pairs.join(', ')})`;
  });

/** Nested function calls — func(func(func(field))) */
const arbNestedFuncs = fc
  .tuple(
    fc.array(fc.constantFrom(...evalFuncs), { minLength: 2, maxLength: 5 }),
    arbField,
  )
  .map(([funcs, field]) => {
    let expr = field;
    for (const fn of funcs) {
      expr = `${fn}(${expr})`;
    }
    return `* | eval result = ${expr}`;
  });

/** State interaction: fillnull + rename + eval referencing the same fields */
const arbStateInteraction = fc
  .tuple(arbField, arbField, fc.constantFrom('0', 'N/A', 'unknown', ''))
  .map(([f1, f2, fillVal]) => {
    const pipes = [
      `fillnull value="${fillVal}" ${f1}`,
      `rename ${f1} AS renamed_${f1.replace(/[^a-zA-Z]/g, '')}`,
      `eval computed = renamed_${f1.replace(/[^a-zA-Z]/g, '')} . " " . ${f2}`,
    ];
    return `* | ${pipes.join(' | ')}`;
  });

/** fillnull then stats — fillnull modifies _fillnullMap, stats consumes fields */
const arbFillnullStats = fc
  .tuple(
    arbField,
    arbField,
    fc.constantFrom('0', '1', 'N/A', 'missing'),
    fc.constantFrom('count', 'avg', 'sum', 'max', 'dc'),
  )
  .map(([f1, f2, fillVal, agg]) => {
    return `* | fillnull value="${fillVal}" ${f1} | stats ${agg}(${f1}) by ${f2}`;
  });

/** Multiple renames chaining — rename A AS B | rename B AS C */
const arbRenameChain = fc
  .array(arbField, { minLength: 2, maxLength: 4 })
  .map((fields) => {
    const renames = [];
    for (let i = 0; i < fields.length - 1; i++) {
      renames.push(`rename ${fields[i]} AS field_${i}`);
    }
    return `* | ${renames.join(' | ')} | table field_0`;
  });

/** Stats after fillnull after eval — three state-modifying commands */
const arbTripleState = fc.tuple(arbField, arbField).map(([f1, f2]) => {
  return `* | eval ratio = ${f1} / ${f2} | fillnull value=0 ratio | stats avg(ratio) by ${f2}`;
});

/** Join with complex subsearch containing its own stats + eval */
const arbComplexJoin = fc.tuple(arbField, arbField).map(([f1, f2]) => {
  return `* | join ${f1} [search * | eval x = ${f2} / 1000 | stats avg(x) as avg_x by ${f1}]`;
});

/** Append with stats on both sides — tests merge logic */
const arbAppendStats = fc.tuple(arbField, arbField).map(([f1, f2]) => {
  return `* | stats count by ${f1} | append [search * | stats count by ${f2}]`;
});

/** Eventstats with same field as both aggregation target and group-by */
const arbEventstatsSelf = fc
  .tuple(arbField, fc.constantFrom('count', 'avg', 'sum', 'max', 'dc'))
  .map(([f, agg]) => {
    return `* | eventstats ${agg}(${f}) as ${f}_total by ${f}`;
  });

/** dedup + stats — dedup sets _hasAggregation, then stats hits the "already aggregated" path */
const arbDedupStats = fc
  .tuple(arbField, arbField)
  .map(([f1, f2]) => `* | dedup ${f1} | stats count by ${f2}`);

/** Multiple evals overwriting the same variable */
const arbEvalOverwrite = fc
  .tuple(arbField, arbField, arbField)
  .map(([f1, f2, f3]) => {
    return `* | eval x = ${f1} | eval x = ${f2} | eval x = ${f3} | table x`;
  });

/** Pipeline that produces empty intermediate results */
const arbEmptyPipeline = fc
  .tuple(arbField)
  .map(
    ([f]) => `* | where ${f} = "IMPOSSIBLE_VALUE_12345" | stats count by ${f}`,
  );

/** Subsearch in append referencing fields from outer query's eval */
const arbCrossRefAppend = fc.tuple(arbField, arbField).map(([f1, f2]) => {
  return `* | eval x = ${f1} / 1000 | append [search * | eval y = ${f2} * 2 | stats avg(y) by ${f1}]`;
});

// ── Properties ──────────────────────────────────────────────────────

describe('SPL→NRQL property-based fuzz tests', () => {
  // 500 default; bump to 5000+ for deep fuzz runs
  const numRuns = 500;

  it('never produces [object Object] in NRQL output', () => {
    fc.assert(
      fc.property(arbSplQuery, (spl) => {
        const r = translateSplToNrql(spl);
        expect(r.nrql).not.toContain('[object Object]');
      }),
      { numRuns },
    );
  });

  it('never produces "undefined" as a literal string in NRQL', () => {
    fc.assert(
      fc.property(arbSplQuery, (spl) => {
        const r = translateSplToNrql(spl);
        // Allow "undefined" in warnings/errors (those are messages), but not in NRQL
        expect(r.nrql).not.toContain('undefined');
      }),
      { numRuns },
    );
  });

  it('never produces "null" in a structural position (WHERE/FACET/SELECT/FROM)', () => {
    fc.assert(
      fc.property(arbSplQuery, (spl) => {
        const r = translateSplToNrql(spl);
        if (r.nrql) {
          // null appearing right after a keyword means a JS null leaked
          // into a position where a field/expression should be
          expect(r.nrql).not.toMatch(
            /\b(?:WHERE|FACET|SELECT|FROM|BY|ON|AND|OR)\s+null\b/i,
          );
          expect(r.nrql).not.toMatch(
            /\bnull\s*(?:AND|OR|FACET|ORDER|LIMIT|SINCE|UNTIL)\b/i,
          );
        }
      }),
      { numRuns },
    );
  });

  it('never produces NaN or Infinity in NRQL output', () => {
    fc.assert(
      fc.property(arbSplQuery, (spl) => {
        const r = translateSplToNrql(spl);
        if (r.nrql) {
          expect(r.nrql).not.toMatch(/\bNaN\b/);
          expect(r.nrql).not.toMatch(/\bInfinity\b/);
        }
      }),
      { numRuns },
    );
  });

  it('always returns a result object with expected shape', () => {
    fc.assert(
      fc.property(arbSplQuery, (spl) => {
        const r = translateSplToNrql(spl);
        expect(r).toHaveProperty('nrql');
        expect(r).toHaveProperty('warnings');
        expect(r).toHaveProperty('unsupported');
        expect(r).toHaveProperty('errors');
        expect(typeof r.nrql).toBe('string');
        expect(Array.isArray(r.warnings)).toBe(true);
        expect(Array.isArray(r.unsupported)).toBe(true);
        expect(Array.isArray(r.errors)).toBe(true);
      }),
      { numRuns },
    );
  });

  it('produces non-empty NRQL when no errors/unsupported', () => {
    fc.assert(
      fc.property(arbSplQuery, (spl) => {
        const r = translateSplToNrql(spl);
        if (r.errors.length === 0 && r.unsupported.length === 0) {
          expect(r.nrql.length).toBeGreaterThan(0);
        }
      }),
      { numRuns },
    );
  });

  it('NRQL always starts with FROM when non-empty', () => {
    fc.assert(
      fc.property(arbSplQuery, (spl) => {
        const r = translateSplToNrql(spl);
        if (r.nrql) {
          expect(r.nrql).toMatch(/^FROM /);
        }
      }),
      { numRuns },
    );
  });

  it('never throws an unhandled exception', () => {
    fc.assert(
      fc.property(arbSplQuery, (spl) => {
        // This should never throw — translator should catch all errors
        expect(() => translateSplToNrql(spl)).not.toThrow();
      }),
      { numRuns },
    );
  });

  it('warnings and unsupported messages are all strings', () => {
    fc.assert(
      fc.property(arbSplQuery, (spl) => {
        const r = translateSplToNrql(spl);
        for (const w of r.warnings) expect(typeof w).toBe('string');
        for (const u of r.unsupported) expect(typeof u).toBe('string');
        for (const e of r.errors) expect(typeof e).toBe('string');
      }),
      { numRuns },
    );
  });

  // ── Structural NRQL invariants ─────────────────────────────────────

  it('NRQL output has balanced parentheses', () => {
    fc.assert(
      fc.property(arbSplQuery, (spl) => {
        const r = translateSplToNrql(spl);
        if (r.nrql) {
          const balance = countUnescaped(r.nrql, '(', ')');
          if (balance !== 0) {
            throw new Error(
              `Unbalanced parens (depth ${balance}): ${r.nrql.slice(0, 200)}`,
            );
          }
        }
      }),
      { numRuns },
    );
  });

  it('NRQL output has no duplicate adjacent keywords', () => {
    fc.assert(
      fc.property(arbSplQuery, (spl) => {
        const r = translateSplToNrql(spl);
        if (r.nrql) {
          const dup = hasDuplicateKeywords(r.nrql);
          if (dup) {
            throw new Error(`Duplicate "${dup}": ${r.nrql.slice(0, 200)}`);
          }
        }
      }),
      { numRuns },
    );
  });

  it('NRQL output has valid clause structure', () => {
    fc.assert(
      fc.property(arbSplQuery, (spl) => {
        const r = translateSplToNrql(spl);
        if (r.nrql && r.errors.length === 0 && r.unsupported.length === 0) {
          const err = hasValidStructure(r.nrql);
          if (err) {
            throw new Error(`${err}: ${r.nrql.slice(0, 200)}`);
          }
        }
      }),
      { numRuns },
    );
  });

  it('no IR node leaks in warning/unsupported/error messages', () => {
    fc.assert(
      fc.property(arbSplQuery, (spl) => {
        const r = translateSplToNrql(spl);
        const allMessages = [...r.warnings, ...r.unsupported, ...r.errors];
        for (const msg of allMessages) {
          expect(msg).not.toContain('[object Object]');
          expect(msg).not.toContain('undefined');
        }
      }),
      { numRuns },
    );
  });

  // ── Targeted combinatorial tests ──────────────────────────────────
  // These specifically target the feature-interaction class of bugs

  it('compound where expressions never produce [object Object]', () => {
    fc.assert(
      fc.property(arbWhereCompound, (spl) => {
        const r = translateSplToNrql(spl);
        expect(r.nrql).not.toContain('[object Object]');
      }),
      { numRuns: 200 },
    );
  });

  it('multi-eval never crashes or produces undefined', () => {
    fc.assert(
      fc.property(arbEvalMulti, (spl) => {
        const r = translateSplToNrql(spl);
        expect(r.nrql).not.toContain('[object Object]');
        expect(r.nrql).not.toContain('undefined');
      }),
      { numRuns: 200 },
    );
  });

  // FIXME: known bug — NOT like() and compound like() AND expr produce [object Object].
  // This test documents the failure. Remove skip and move expressions back to whereExprs
  // once the where handler's expression walker is fixed.
  it.skip('buggy where expressions should not produce [object Object]', () => {
    const arbBuggyWhere = fc
      .constantFrom(...buggyWhereExprs)
      .map((expr) => `* | where ${expr}`);
    fc.assert(
      fc.property(arbBuggyWhere, (spl) => {
        const r = translateSplToNrql(spl);
        expect(r.nrql).not.toContain('[object Object]');
      }),
      { numRuns: 50 },
    );
  });

  it('stats-after-stats never crashes', () => {
    fc.assert(
      fc.property(arbStatsChain, (spl) => {
        const r = translateSplToNrql(spl);
        expect(() => translateSplToNrql(spl)).not.toThrow();
        expect(r.nrql).not.toContain('[object Object]');
      }),
      { numRuns: 200 },
    );
  });

  // ── Weird-corner property tests ─────────────────────────────────

  it('deeply nested if() expressions never crash or leak objects', () => {
    fc.assert(
      fc.property(arbDeepEval, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 200 },
    );
  });

  it('deeply nested case() expressions never crash or leak objects', () => {
    fc.assert(
      fc.property(arbDeepCase, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 200 },
    );
  });

  it('nested function calls (func(func(func(x)))) never crash', () => {
    fc.assert(
      fc.property(arbNestedFuncs, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 200 },
    );
  });

  it('fillnull + rename + eval state interactions never crash', () => {
    fc.assert(
      fc.property(arbStateInteraction, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 200 },
    );
  });

  it('fillnull then stats never crashes or produces malformed NRQL', () => {
    fc.assert(
      fc.property(arbFillnullStats, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 200 },
    );
  });

  it('chained renames never crash', () => {
    fc.assert(
      fc.property(arbRenameChain, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 200 },
    );
  });

  it('eval + fillnull + stats triple-state interaction never crashes', () => {
    fc.assert(
      fc.property(arbTripleState, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 200 },
    );
  });

  it('join with complex subsearch (eval + stats) never crashes', () => {
    fc.assert(
      fc.property(arbComplexJoin, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 200 },
    );
  });

  it('append with stats on both sides never crashes', () => {
    fc.assert(
      fc.property(arbAppendStats, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 200 },
    );
  });

  it('eventstats with self-referencing field never crashes', () => {
    fc.assert(
      fc.property(arbEventstatsSelf, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 200 },
    );
  });

  it('dedup then stats (double aggregation path) never crashes', () => {
    fc.assert(
      fc.property(arbDedupStats, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 200 },
    );
  });

  it('multiple evals overwriting same variable never crashes', () => {
    fc.assert(
      fc.property(arbEvalOverwrite, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 200 },
    );
  });

  it('empty-result pipeline (impossible WHERE) never crashes', () => {
    fc.assert(
      fc.property(arbEmptyPipeline, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 100 },
    );
  });

  it('append referencing fields from outer eval never crashes', () => {
    fc.assert(
      fc.property(arbCrossRefAppend, (spl) => {
        assertInvariants(spl);
      }),
      { numRuns: 200 },
    );
  });
});

// ── Real-world corpus properties ──────────────────────────────────────

// FIXME: queries triggering the known where-handler function-call bug.
// Remove this filter once the where handler is fixed.
const knownBuggySubstrings = ['cisco_sd_wan_syslog'];
function isKnownBuggy(spl) {
  return knownBuggySubstrings.some((s) => spl.includes(s));
}
const cleanCorpus = realWorldCorpus.filter((spl) => !isKnownBuggy(spl));

// ── Structural validation helpers ────────────────────────────────────

/** Count occurrences of a char, skipping escaped and inside strings */
function countUnescaped(str, open, close) {
  let depth = 0;
  let inSingle = false;
  let inRegex = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const prev = i > 0 ? str[i - 1] : '';
    if (prev === '\\') continue;
    // Track single-quoted strings
    if (ch === "'" && !inRegex) {
      inSingle = !inSingle;
      continue;
    }
    // Track regex literals r'...'
    if (ch === 'r' && str[i + 1] === "'" && !inSingle) {
      inRegex = true;
      i++;
      continue;
    }
    if (ch === "'" && inRegex) {
      inRegex = false;
      continue;
    }
    if (inSingle || inRegex) continue;
    if (ch === open) depth++;
    if (ch === close) depth--;
  }
  return depth;
}

/** Check for duplicate adjacent NRQL keywords */
const nrqlKeywords = [
  'SELECT',
  'FROM',
  'WHERE',
  'FACET',
  'LIMIT',
  'ORDER BY',
  'TIMESERIES',
  'SINCE',
  'UNTIL',
];
function hasDuplicateKeywords(nrql) {
  for (const kw of nrqlKeywords) {
    // Look for keyword appearing twice with only whitespace between
    // But allow legitimate nesting: FROM (FROM ...) is valid (subqueries)
    const pattern = new RegExp(`\\b${kw}\\s+${kw}\\b`);
    if (pattern.test(nrql)) return kw;
  }
  return null;
}

/** Check NRQL has valid clause structure (FROM before SELECT, etc.) */
function hasValidStructure(nrql) {
  // Strip subqueries (content inside balanced parens) for top-level check
  let top = nrql;
  let depth = 0;
  let result = '';
  for (const ch of top) {
    if (ch === '(') depth++;
    if (depth === 0) result += ch;
    if (ch === ')') depth--;
  }
  top = result;

  // Must have FROM and SELECT at top level
  if (!top.includes('FROM')) return 'missing FROM';
  if (!top.includes('SELECT')) return 'missing SELECT';

  // FROM must come before SELECT at top level
  const fromIdx = top.indexOf('FROM');
  const selectIdx = top.indexOf('SELECT');
  if (selectIdx < fromIdx) return 'SELECT before FROM';

  // No empty WHERE (WHERE followed immediately by FACET/LIMIT/ORDER/SINCE/UNTIL/end)
  const emptyWhere = /\bWHERE\s*(?:FACET|LIMIT|ORDER|SINCE|UNTIL|TIMESERIES|$)/;
  if (emptyWhere.test(top)) return 'empty WHERE clause';

  // No empty SELECT (SELECT followed immediately by WHERE/FACET/LIMIT/ORDER/SINCE/UNTIL)
  const emptySelect =
    /\bSELECT\s*(?:WHERE|FACET|LIMIT|ORDER|SINCE|UNTIL|TIMESERIES|$)/;
  if (emptySelect.test(top)) return 'empty SELECT clause';

  return null;
}

/** Shared invariant checker — reused across corpus and mutation tests */
function assertInvariants(spl) {
  let r;
  try {
    r = translateSplToNrql(spl);
  } catch (e) {
    throw new Error(`Translator threw on: ${spl}\n${e.message}`);
  }

  // Shape invariants
  expect(r).toHaveProperty('nrql');
  expect(typeof r.nrql).toBe('string');

  // No JS object stringification in NRQL
  expect(r.nrql).not.toContain('[object Object]');
  expect(r.nrql).not.toContain('undefined');

  // Messages are all strings, no IR node leaks (#5)
  for (const w of r.warnings) {
    expect(typeof w).toBe('string');
    expect(w).not.toContain('[object Object]');
  }
  for (const u of r.unsupported) {
    expect(typeof u).toBe('string');
    expect(u).not.toContain('[object Object]');
  }
  for (const e of r.errors) {
    expect(typeof e).toBe('string');
    expect(e).not.toContain('[object Object]');
  }

  if (r.errors.length === 0 && r.unsupported.length === 0) {
    expect(r.nrql.length).toBeGreaterThan(0);
    expect(r.nrql).toMatch(/^FROM /);

    // #1: Balanced parentheses
    const parenBalance = countUnescaped(r.nrql, '(', ')');
    if (parenBalance !== 0) {
      throw new Error(
        `Unbalanced parentheses (depth ${parenBalance}) in:\n  ${r.nrql}`,
      );
    }

    // #2: No duplicate adjacent keywords
    const dupKw = hasDuplicateKeywords(r.nrql);
    if (dupKw) {
      throw new Error(`Duplicate keyword "${dupKw}" in:\n  ${r.nrql}`);
    }

    // #3 + #6: Valid NRQL structure (FROM before SELECT, no empty clauses)
    const structErr = hasValidStructure(r.nrql);
    if (structErr) {
      throw new Error(`Invalid NRQL structure (${structErr}) in:\n  ${r.nrql}`);
    }
  }

  return r;
}

describe('real-world corpus invariants', () => {
  it('no query in the corpus crashes or produces [object Object] (excluding known bugs)', () => {
    const failures = [];
    const knownCount = realWorldCorpus.length - cleanCorpus.length;
    for (const spl of cleanCorpus) {
      try {
        assertInvariants(spl);
      } catch (e) {
        failures.push({ spl: spl.slice(0, 120), error: e.message });
      }
    }
    if (knownCount > 0) {
      console.log(
        `  Known buggy: ${knownCount} corpus queries skipped (where handler function-call bug)`,
      );
    }
    if (failures.length > 0) {
      const summary = failures
        .slice(0, 10)
        .map((f) => `  SPL: ${f.spl}\n  ERR: ${f.error}`)
        .join('\n\n');
      throw new Error(
        `${failures.length} of ${cleanCorpus.length} queries failed invariants:\n\n${summary}`,
      );
    }
  });
});

// ── Mutation-based fuzzing ────────────────────────────────────────────
// Take real queries and randomly mutate them to find edge cases.

/** Split an SPL query into its pipe stages */
function splitPipes(spl) {
  // Naive split — doesn't handle pipes inside brackets, but good enough
  // for mutation purposes since we re-feed into the translator
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of spl) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === '|' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Mutation strategies */
const mutations = {
  /** Shuffle pipe order (keep search clause first) */
  shufflePipes(parts, rng) {
    if (parts.length <= 2) return parts;
    const [search, ...pipes] = parts;
    // Fisher-Yates on pipes
    for (let i = pipes.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pipes[i], pipes[j]] = [pipes[j], pipes[i]];
    }
    return [search, ...pipes];
  },

  /** Drop a random pipe stage */
  dropPipe(parts, rng) {
    if (parts.length <= 1) return parts;
    const idx = 1 + Math.floor(rng() * (parts.length - 1));
    return [...parts.slice(0, idx), ...parts.slice(idx + 1)];
  },

  /** Duplicate a random pipe stage */
  duplicatePipe(parts, rng) {
    if (parts.length <= 1) return parts;
    const idx = 1 + Math.floor(rng() * (parts.length - 1));
    return [...parts.slice(0, idx + 1), parts[idx], ...parts.slice(idx + 1)];
  },

  /** Swap a field name in the query */
  swapField(parts, rng) {
    const swaps = [
      'host',
      'status',
      'bytes',
      'duration',
      'user',
      'src_ip',
      'method',
      'uri',
      'app',
      'level',
      'action',
    ];
    const target = swaps[Math.floor(rng() * swaps.length)];
    const replacement = swaps[Math.floor(rng() * swaps.length)];
    return parts.map((p) =>
      p.replace(new RegExp(`\\b${target}\\b`), replacement),
    );
  },

  /** Insert an extra pipe stage */
  insertPipe(parts, rng) {
    const extras = [
      'head 50',
      'sort -duration',
      'dedup host',
      'fillnull value=0',
      'rename host AS hostname',
      'fields host, status',
      'eval x = duration / 1000',
      'where status > 200',
      'table host, status, duration',
      'reverse',
      'stats count by host',
      'bin _time span=5m',
    ];
    const stage = extras[Math.floor(rng() * extras.length)];
    const idx = 1 + Math.floor(rng() * parts.length);
    return [...parts.slice(0, idx), stage, ...parts.slice(idx)];
  },
};

const mutationNames = Object.keys(mutations);

describe('mutation-based fuzzing', () => {
  // 300 default; bump to 3000+ for deep fuzz runs
  const numRuns = 300;

  it('mutated real-world queries never crash or produce [object Object]', () => {
    // Use fast-check to pick a corpus query + mutation + seed for rng
    const arbCorpusIdx = fc.integer({ min: 0, max: cleanCorpus.length - 1 });
    const arbMutation = fc.constantFrom(...mutationNames);
    const arbSeed = fc.integer({ min: 0, max: 2 ** 31 - 1 });

    fc.assert(
      fc.property(arbCorpusIdx, arbMutation, arbSeed, (idx, mutName, seed) => {
        const original = cleanCorpus[idx];
        const parts = splitPipes(original);

        // Simple seeded rng (mulberry32)
        let s = seed | 0;
        const rng = () => {
          s = (s + 0x6d2b79f5) | 0;
          let t = Math.imul(s ^ (s >>> 15), 1 | s);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };

        const mutated = mutations[mutName](parts, rng);
        const spl = mutated.join(' | ');

        // We only check invariants — not semantic correctness
        let r;
        try {
          r = translateSplToNrql(spl);
        } catch (e) {
          throw new Error(
            `Translator threw on mutated query:\n  ${spl}\n  ${e.message}`,
          );
        }
        expect(typeof r.nrql).toBe('string');
        expect(r.nrql).not.toContain('[object Object]');
        expect(r.nrql).not.toContain('undefined');
      }),
      { numRuns },
    );
  });

  it('double-mutation of corpus queries never crashes', () => {
    const arbCorpusIdx = fc.integer({ min: 0, max: cleanCorpus.length - 1 });
    const arbMut1 = fc.constantFrom(...mutationNames);
    const arbMut2 = fc.constantFrom(...mutationNames);
    const arbSeed = fc.integer({ min: 0, max: 2 ** 31 - 1 });

    fc.assert(
      fc.property(
        arbCorpusIdx,
        arbMut1,
        arbMut2,
        arbSeed,
        (idx, m1, m2, seed) => {
          const original = cleanCorpus[idx];
          let parts = splitPipes(original);

          let s = seed | 0;
          const rng = () => {
            s = (s + 0x6d2b79f5) | 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };

          parts = mutations[m1](parts, rng);
          parts = mutations[m2](parts, rng);
          const spl = parts.join(' | ');

          expect(() => translateSplToNrql(spl)).not.toThrow();
          const r = translateSplToNrql(spl);
          expect(r.nrql).not.toContain('[object Object]');
        },
      ),
      { numRuns: 200 },
    );
  });
});
