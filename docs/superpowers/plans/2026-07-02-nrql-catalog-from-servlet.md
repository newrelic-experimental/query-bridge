# NRQL Function Catalog from NRQLDocServlet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three hand-maintained NRQL function-name lists with a checked-in catalog generated from NRDB's NRQLDocServlet, consumed offline and dependency-free.

**Architecture:** An NR-employee refresh script (prod-VPN-only) fetches the servlet JSON, a pure transform filters/normalizes it, and it writes two committed artifacts — a data snapshot (`.json`) and a materialized JS module (`.js`). The translator imports the `.js` module offline. `NRQL_AGG_FUNCS` becomes catalog-derived; `FOLD_SAFE_FUNCS` stays a curated overlay guarded by an offline subset test; `ROW_WISE_UNIMPLEMENTED` is untouched.

**Tech Stack:** Node 24 (dev/build; global `fetch`), pure ESM JavaScript, Vitest, `jq` for verification. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-07-02-nrql-catalog-from-servlet-design.md`

## Global Constraints

- **Runtime is offline + zero-dependency.** The shipped module (`src/ir/nrqlCatalog.js`) imports nothing at runtime and issues no network call; its Sets are materialized literals, not a JSON import. Verified via ground truth 2026-07-02.
- **Prod-VPN-only source.** The servlet (`https://staging-nrql-query-gateway.vip.cf.nr-ops.net/nrql_doc.json`) is reachable only on the NR prod VPN. The refresh script and the live-drift test must degrade gracefully off-VPN; the committed artifact is the only thing consumers touch.
- **OSS hygiene.** No `INTERNAL_STABLE`-staged or `nrAdminOnly` function names, and no internal `stageDate`s, land in any tracked file. The one exception is `extractfield`/`getField` (INTERNAL_STABLE aggregator, STABLE function), admitted only into `NRQL_DISTRIBUTED_FUNCS` because the translator already emits it.
- **Deterministic output.** Generated files carry no wall-clock timestamp, so a regeneration is byte-comparable; git history is the date of record.
- **Loud failure over silent wrong results.** A servlet non-200, malformed JSON, or a missing array is a thrown error, never a partial write.
- **Node 24 for dev commands:** prefix `ASDF_NODEJS_VERSION=24.14.0`. Conventional commits (lowercase subject ≤72 chars). Run `npm run` wrappers, never raw tools.
- **Naming:** catalog canonical names are lowercase; friendly forms are aliases (`percentile`→`nrpercentile`, `getField`→`extractfield`). All catalog-derived Sets are lowercased and alias-expanded; every consumer lowercases the lookup key.

---

## File structure

- `packages/nr-query-bridge/scripts/buildCatalog.mjs` — **new.** Pure transforms, no I/O: `buildCatalog(raw)` → catalog data object; `renderModule(data)` → the `.js` module source string. Imported by the refresh CLI and by the drift test.
- `packages/nr-query-bridge/scripts/refresh-nrql-catalog.mjs` — **new.** Thin CLI: fetch → `buildCatalog` → write both artifacts → `prettier --write`. Dev-only tooling (I/O glue, not unit-tested — like `scripts/scan-*.sh`).
- `packages/nr-query-bridge/src/ir/nrqlCatalog.snapshot.json` — **new, generated.** The catalog data (arrays + stage map). The reviewable diff of catalog change and the drift test's comparison target.
- `packages/nr-query-bridge/src/ir/nrqlCatalog.js` — **new, generated.** Materialized `NRQL_AGGREGATE_FUNCS`, `NRQL_SCALAR_FUNCS`, `NRQL_DISTRIBUTED_FUNCS` Sets + `stageOf`/`isAggregate`/`isDistributed`. Runtime consumable.
- `packages/nr-query-bridge/test/ir/nrqlCatalog.test.js` — **new.** Offline unit tests for `buildCatalog`/`renderModule` (synthetic input) and the committed module's shape.
- `packages/nr-query-bridge/test/ir/nrqlCatalog.drift.test.js` — **new.** Offline invariants (always run) + live drift (skips off-VPN).
- `packages/nr-query-bridge/src/ir/foldPostAggregation.js` — **modify** (PR2 export, PR3 derive). Currently defines `FOLD_SAFE_FUNCS` (line 14) and `NRQL_AGG_FUNCS` (line 34) inline; `isAggregateExpr` at line 56.
- `packages/nr-query-bridge/package.json` — **modify.** Add `"refresh:nrql-catalog"` script.

---

## Task 1: Generator + committed catalog artifacts (inert)

Nothing in `src/` imports the new module yet. The generator's pure logic is unit-tested offline against synthetic input; the committed artifacts are produced from a real VPN fetch.

**Files:**
- Create: `packages/nr-query-bridge/scripts/buildCatalog.mjs`
- Create: `packages/nr-query-bridge/scripts/refresh-nrql-catalog.mjs`
- Create (generated): `packages/nr-query-bridge/src/ir/nrqlCatalog.snapshot.json`
- Create (generated): `packages/nr-query-bridge/src/ir/nrqlCatalog.js`
- Test: `packages/nr-query-bridge/test/ir/nrqlCatalog.test.js`
- Modify: `packages/nr-query-bridge/package.json`

**Interfaces:**
- Produces: `buildCatalog(raw) → { aggregators: string[], scalars: string[], distributed: string[], stages: Record<string,'STABLE'|'BETA'|'EXPERIMENTAL'> }` — all name arrays lowercased, alias-expanded, unique, sorted. `renderModule(data) → string`. `isCustomerFacing(entry) → boolean`.
- Produces (generated module exports): `NRQL_AGGREGATE_FUNCS: Set<string>`, `NRQL_SCALAR_FUNCS: Set<string>`, `NRQL_DISTRIBUTED_FUNCS: Set<string>`, `stageOf(name): string|null`, `isAggregate(name): boolean`, `isDistributed(name): boolean`.

- [ ] **Step 1: Write failing tests for `buildCatalog` against a synthetic raw catalog**

Create `packages/nr-query-bridge/test/ir/nrqlCatalog.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildCatalog, isCustomerFacing } from '../../scripts/buildCatalog.mjs';

// A synthetic raw catalog exercising every filter/normalize rule. Not real data.
const RAW = {
  aggregators: [
    { name: 'count', aliases: [], stage: 'STABLE', nrAdminOnly: false },
    { name: 'nrpercentile', aliases: ['percentile'], stage: 'STABLE', nrAdminOnly: false },
    { name: 'abs', aliases: [], stage: 'STABLE', nrAdminOnly: false }, // in both -> distributed
    { name: 'extractfield', aliases: ['getfield'], stage: 'INTERNAL_STABLE', nrAdminOnly: false }, // internal agg, but in both
    { name: 'secretAgg', aliases: [], stage: 'STABLE', nrAdminOnly: true }, // admin-only -> dropped
    { name: 'internalAgg', aliases: [], stage: 'INTERNAL_STABLE', nrAdminOnly: false }, // internal -> dropped
    { name: 'betaAgg', aliases: [], stage: 'BETA', nrAdminOnly: false }, // BETA kept
  ],
  functions: [
    { name: 'abs', aliases: [], stage: 'STABLE', nrAdminOnly: false }, // in both -> distributed
    { name: 'extractfield', aliases: ['getfield'], stage: 'STABLE', nrAdminOnly: false }, // in both -> distributed
    { name: 'lower', aliases: [], stage: 'STABLE', nrAdminOnly: false }, // scalar only
    { name: 'internalFn', aliases: [], stage: 'INTERNAL_STABLE', nrAdminOnly: false }, // dropped
  ],
  eventFilters: [],
};

describe('isCustomerFacing', () => {
  it('drops nrAdminOnly', () => {
    expect(isCustomerFacing({ stage: 'STABLE', nrAdminOnly: true })).toBe(false);
  });
  it('drops INTERNAL_STABLE', () => {
    expect(isCustomerFacing({ stage: 'INTERNAL_STABLE', nrAdminOnly: false })).toBe(false);
  });
  it('keeps STABLE and BETA', () => {
    expect(isCustomerFacing({ stage: 'STABLE', nrAdminOnly: false })).toBe(true);
    expect(isCustomerFacing({ stage: 'BETA', nrAdminOnly: false })).toBe(true);
  });
});

describe('buildCatalog', () => {
  const cat = buildCatalog(RAW);

  it('aggregators are customer-facing, lowercased, alias-expanded, sorted', () => {
    // count, nrpercentile(+percentile), abs, betaAgg(->betaagg); NOT secretAgg/internalAgg/extractfield
    expect(cat.aggregators).toEqual(['abs', 'betaagg', 'count', 'nrpercentile', 'percentile']);
  });
  it('scalars exclude internal functions and include aliases', () => {
    expect(cat.scalars).toEqual(['abs', 'extractfield', 'getfield', 'lower']);
  });
  it('distributed = intersection of UNFILTERED arrays, so extractfield survives despite INTERNAL_STABLE', () => {
    // abs (both) + extractfield (both, internal agg) -> plus aliases getfield
    expect(cat.distributed).toEqual(['abs', 'extractfield', 'getfield']);
  });
  it('stages map covers customer-facing names + aliases only', () => {
    expect(cat.stages.percentile).toBe('STABLE');
    expect(cat.stages.betaagg).toBe('BETA');
    expect(cat.stages.internalagg).toBeUndefined();
    expect(cat.stages.secretagg).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- nrqlCatalog`
Expected: FAIL — `buildCatalog`/`isCustomerFacing` not found (module doesn't exist).

- [ ] **Step 3: Implement `buildCatalog.mjs`**

Create `packages/nr-query-bridge/scripts/buildCatalog.mjs`:

```js
// Pure, I/O-free transforms for the NRQL catalog. Imported by the refresh CLI
// and the drift test. No fetch, no fs here.

/** A function entry is customer-facing unless it is admin-only or internal-stage. */
export function isCustomerFacing(entry) {
  return entry.nrAdminOnly === false && entry.stage !== 'INTERNAL_STABLE';
}

/** All names (canonical + aliases) of a set of entries, lowercased, unique, sorted. */
function names(entries) {
  const out = new Set();
  for (const e of entries) {
    out.add(String(e.name).toLowerCase());
    for (const a of e.aliases || []) out.add(String(a).toLowerCase());
  }
  return [...out].sort();
}

/**
 * @param {{aggregators:object[], functions:object[], eventFilters:object[]}} raw
 * @returns {{aggregators:string[], scalars:string[], distributed:string[], stages:Record<string,string>}}
 */
export function buildCatalog(raw) {
  if (!raw || !Array.isArray(raw.aggregators) || !Array.isArray(raw.functions)) {
    throw new Error('nrql catalog: raw JSON missing aggregators/functions arrays');
  }
  const aggCF = raw.aggregators.filter(isCustomerFacing);
  const fnCF = raw.functions.filter(isCustomerFacing);

  // Fold-safe capability is stage-independent: compute the distributed set from the
  // UNFILTERED intersection so extractfield/getField (INTERNAL_STABLE aggregator,
  // STABLE function; already emitted by the translator) survives.
  const aggAll = new Set(raw.aggregators.map((e) => String(e.name).toLowerCase()));
  const fnAll = new Set(raw.functions.map((e) => String(e.name).toLowerCase()));
  const distributedEntries = [...raw.aggregators, ...raw.functions].filter((e) => {
    const n = String(e.name).toLowerCase();
    return aggAll.has(n) && fnAll.has(n);
  });

  const stages = {};
  for (const e of [...aggCF, ...fnCF]) {
    const stage = e.stage;
    stages[String(e.name).toLowerCase()] = stage;
    for (const a of e.aliases || []) stages[String(a).toLowerCase()] = stage;
  }

  return {
    aggregators: names(aggCF),
    scalars: names(fnCF),
    distributed: names(distributedEntries),
    stages,
  };
}

/** Render the committed runtime module source (materialized Sets, no timestamp). */
export function renderModule(data) {
  const set = (arr) =>
    `new Set([\n${arr.map((n) => `  '${n}',`).join('\n')}\n])`;
  const stageEntries = Object.keys(data.stages)
    .sort()
    .map((k) => `  '${k}': '${data.stages[k]}',`)
    .join('\n');
  return `// @generated by scripts/refresh-nrql-catalog.mjs from NRQLDocServlet — do not edit by hand.
// Regenerate: npm run refresh:nrql-catalog (requires the NR prod VPN).
// Source: staging-nrql-query-gateway.vip.cf.nr-ops.net/nrql_doc.json (customer-facing).

export const NRQL_AGGREGATE_FUNCS = ${set(data.aggregators)};

export const NRQL_SCALAR_FUNCS = ${set(data.scalars)};

// Fold-safe / distributed capability set (computed from the unfiltered intersection).
export const NRQL_DISTRIBUTED_FUNCS = ${set(data.distributed)};

const STAGE_BY_NAME = {
${stageEntries}
};

export function stageOf(name) {
  return STAGE_BY_NAME[String(name).toLowerCase()] ?? null;
}

export function isAggregate(name) {
  return NRQL_AGGREGATE_FUNCS.has(String(name).toLowerCase());
}

export function isDistributed(name) {
  return NRQL_DISTRIBUTED_FUNCS.has(String(name).toLowerCase());
}
`;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- nrqlCatalog`
Expected: PASS (all `buildCatalog`/`isCustomerFacing` tests green).

- [ ] **Step 5: Add a `renderModule` test, run, verify pass**

Append to `test/ir/nrqlCatalog.test.js`:

```js
import { renderModule } from '../../scripts/buildCatalog.mjs';

describe('renderModule', () => {
  const src = renderModule({
    aggregators: ['abs', 'count'],
    scalars: ['lower'],
    distributed: ['abs'],
    stages: { abs: 'STABLE', count: 'STABLE', lower: 'BETA' },
  });
  it('emits materialized Sets and no wall-clock timestamp', () => {
    expect(src).toContain("export const NRQL_AGGREGATE_FUNCS = new Set([");
    expect(src).toContain("'abs',");
    expect(src).toContain('export function isDistributed(name)');
    expect(src).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no ISO timestamp
  });
  it('does not import the snapshot json (runtime stays pure)', () => {
    expect(src).not.toContain('.json');
    expect(src).not.toContain('import ');
  });
});
```

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- nrqlCatalog`
Expected: PASS.

- [ ] **Step 6: Implement the refresh CLI and add the endpoint constant**

Add to the top of `scripts/buildCatalog.mjs` (shared by CLI and drift test):

```js
export const NRQL_DOC_ENDPOINT =
  'https://staging-nrql-query-gateway.vip.cf.nr-ops.net/nrql_doc.json';
```

Create `packages/nr-query-bridge/scripts/refresh-nrql-catalog.mjs`:

```js
#!/usr/bin/env node
// NR-employee tool (requires the prod VPN). Fetches the NRQL catalog, filters it
// to customer-facing functions, and writes the two committed artifacts. Not
// unit-tested (network + fs glue); its pure logic lives in buildCatalog.mjs.
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NRQL_DOC_ENDPOINT, buildCatalog, renderModule } from './buildCatalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const IR = join(here, '..', 'src', 'ir');
const SNAPSHOT = join(IR, 'nrqlCatalog.snapshot.json');
const MODULE = join(IR, 'nrqlCatalog.js');

const res = await fetch(NRQL_DOC_ENDPOINT);
if (!res.ok) throw new Error(`NRQLDocServlet returned ${res.status} (are you on the prod VPN?)`);
const raw = await res.json();
const data = buildCatalog(raw);

writeFileSync(SNAPSHOT, JSON.stringify(data, null, 2) + '\n');
writeFileSync(MODULE, renderModule(data));
execFileSync('npx', ['prettier', '--write', SNAPSHOT, MODULE], { stdio: 'inherit' });
console.error(
  `wrote ${data.aggregators.length} aggregate, ${data.scalars.length} scalar, ` +
    `${data.distributed.length} distributed function names`,
);
```

Add to `packages/nr-query-bridge/package.json` `scripts`:

```json
"refresh:nrql-catalog": "node scripts/refresh-nrql-catalog.mjs"
```

- [ ] **Step 7: Generate the committed artifacts (requires prod VPN)**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run refresh:nrql-catalog --workspace=@newrelic/query-bridge`
Expected: stderr reports counts (~58 aggregate, ~74 scalar, 21 distributed); `src/ir/nrqlCatalog.snapshot.json` and `src/ir/nrqlCatalog.js` are created, prettier-formatted.

If off-VPN: fetch fails with a clear error. The artifacts must be generated on VPN before this task can complete — do not hand-write them.

- [ ] **Step 8: Add module-shape tests against the committed artifacts, run, verify pass**

Append to `test/ir/nrqlCatalog.test.js`:

```js
import {
  NRQL_AGGREGATE_FUNCS,
  NRQL_DISTRIBUTED_FUNCS,
  stageOf,
  isAggregate,
  isDistributed,
} from '../../src/ir/nrqlCatalog.js';
import snapshot from '../../src/ir/nrqlCatalog.snapshot.json';

describe('committed catalog module', () => {
  it('module Sets match the committed snapshot data', () => {
    expect([...NRQL_AGGREGATE_FUNCS].sort()).toEqual([...snapshot.aggregators].sort());
    expect([...NRQL_DISTRIBUTED_FUNCS].sort()).toEqual([...snapshot.distributed].sort());
  });
  it('lookups are case-insensitive and alias-aware', () => {
    expect(isAggregate('COUNT')).toBe(true);
    expect(isAggregate('percentile')).toBe(true); // alias of nrpercentile
    expect(isAggregate('definitely_not_a_func')).toBe(false);
    expect(isDistributed('getField')).toBe(true); // alias of extractfield
  });
  it('stageOf returns a customer-facing stage or null', () => {
    expect(['STABLE', 'BETA', 'EXPERIMENTAL']).toContain(stageOf('count'));
    expect(stageOf('definitely_not_a_func')).toBeNull();
  });
  it('no INTERNAL_STABLE or admin-only name leaked into the inventory sets', () => {
    // every published aggregate/scalar name has a customer-facing stage
    for (const n of [...NRQL_AGGREGATE_FUNCS, ...NRQL_SCALAR_FUNCS]) {
      expect(['STABLE', 'BETA', 'EXPERIMENTAL']).toContain(stageOf(n));
    }
  });
});
```

Add `NRQL_SCALAR_FUNCS` to the import from `nrqlCatalog.js`.

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- nrqlCatalog`
Expected: PASS.

- [ ] **Step 9: Full gate — lint, types, coverage**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check && ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge`
Expected: all pass. The generated `nrqlCatalog.js` must clear the per-file coverage gate (its three functions are exercised by Step 8). If ESLint flags the generated module, add it to the flat-config `ignores` alongside `splParser.js` — but prefer prettier-clean output that passes as-is.

- [ ] **Step 10: Commit**

```bash
cd /Users/chuck/ghe/nr-query-bridge
git add packages/nr-query-bridge/scripts/buildCatalog.mjs \
        packages/nr-query-bridge/scripts/refresh-nrql-catalog.mjs \
        packages/nr-query-bridge/src/ir/nrqlCatalog.snapshot.json \
        packages/nr-query-bridge/src/ir/nrqlCatalog.js \
        packages/nr-query-bridge/test/ir/nrqlCatalog.test.js \
        packages/nr-query-bridge/package.json
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: generate NRQL function catalog from NRQLDocServlet (inert)"
```

---

## Task 2: Offline invariants + live drift test; reconcile dead `case`

Adds the guard test and makes the curated `FOLD_SAFE_FUNCS` overlay honest against the catalog. The subset invariant runs offline (always); the byte-for-byte drift check runs only on VPN.

**Files:**
- Modify: `packages/nr-query-bridge/src/ir/foldPostAggregation.js` (export `FOLD_SAFE_FUNCS`; remove dead `case`)
- Test: `packages/nr-query-bridge/test/ir/nrqlCatalog.drift.test.js`

**Interfaces:**
- Consumes: `NRQL_DISTRIBUTED_FUNCS` (Task 1), `buildCatalog`/`NRQL_DOC_ENDPOINT` (Task 1), `snapshot` json (Task 1).
- Produces: `FOLD_SAFE_FUNCS: Set<string>` now exported from `foldPostAggregation.js`.

- [ ] **Step 1: Export `FOLD_SAFE_FUNCS`**

In `packages/nr-query-bridge/src/ir/foldPostAggregation.js` line 14, change `const FOLD_SAFE_FUNCS = new Set([` to `export const FOLD_SAFE_FUNCS = new Set([`.

- [ ] **Step 2: Write the offline subset invariant test, run, verify it FAILS on `case`**

Create `packages/nr-query-bridge/test/ir/nrqlCatalog.drift.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { NRQL_DISTRIBUTED_FUNCS } from '../../src/ir/nrqlCatalog.js';
import { NRQL_AGGREGATE_FUNCS } from '../../src/ir/nrqlCatalog.js';
import { FOLD_SAFE_FUNCS } from '../../src/ir/foldPostAggregation.js';
import { NRQL_DOC_ENDPOINT, buildCatalog } from '../../scripts/buildCatalog.mjs';
import snapshot from '../../src/ir/nrqlCatalog.snapshot.json';

describe('catalog invariants (offline)', () => {
  it('every curated FOLD_SAFE_FUNCS member is a catalog-distributed function', () => {
    const missing = [...FOLD_SAFE_FUNCS]
      .map((n) => n.toLowerCase())
      .filter((n) => !NRQL_DISTRIBUTED_FUNCS.has(n));
    expect(missing).toEqual([]); // conservatism (omitting) is fine; over-claiming is not
  });
  it('committed aggregate set equals the snapshot aggregators', () => {
    expect([...NRQL_AGGREGATE_FUNCS].sort()).toEqual([...snapshot.aggregators].sort());
  });
});
```

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- nrqlCatalog.drift`
Expected: FAIL — `missing` is `['case']` (our `case` is not a catalog-distributed function; the nearest catalog name is the scalar-only `cases`).

- [ ] **Step 3: Remove the dead `case` entry from `FOLD_SAFE_FUNCS`**

In `packages/nr-query-bridge/src/ir/foldPostAggregation.js`, delete the `'case',` line (was line 28). `case` is not an NRQL function name and is never emitted (`isFoldSafe` is only called with emitted function names; grep confirms no `Func('case'`).

- [ ] **Step 4: Run the full package suite, verify green (proves `case` was dead)**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge`
Expected: PASS — the subset invariant is now green AND no other test regresses (confirms removing `case` broke nothing).

- [ ] **Step 5: Add the live drift test (skips off-VPN), run offline, verify it skips**

Append to `test/ir/nrqlCatalog.drift.test.js`:

```js
// Reachability probe: the servlet is prod-VPN-only. Off-VPN, skip the live check
// (mirrors scripts/scan-customer-names.sh skipping when its source is absent).
async function probeCatalog() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(NRQL_DOC_ENDPOINT, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
const live = await probeCatalog();

describe.skipIf(!live)('live catalog drift (VPN only)', () => {
  it('committed snapshot matches a fresh customer-facing fetch', () => {
    expect(buildCatalog(live)).toEqual(snapshot);
  });
});
```

Run (off-VPN or with VPN down): `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- nrqlCatalog.drift`
Expected: the offline invariants PASS; the "live catalog drift" describe is SKIPPED (no red).

- [ ] **Step 6: On VPN, verify the drift test runs and bites**

Run (on VPN): same command. Expected: "live catalog drift" runs and PASSES (committed == fresh).
Then temporarily edit `nrqlCatalog.snapshot.json` (delete one name from `aggregators`), re-run: expected FAIL. Revert the edit.

- [ ] **Step 7: Commit**

```bash
cd /Users/chuck/ghe/nr-query-bridge
git add packages/nr-query-bridge/src/ir/foldPostAggregation.js \
        packages/nr-query-bridge/test/ir/nrqlCatalog.drift.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "test: guard NRQL catalog drift + fold-safe subset; drop dead case"
```

---

## Task 3: Derive `NRQL_AGG_FUNCS` from the catalog (behavior change)

Replaces the 15-name inline recognition set with the ~58-name catalog set. This is the only task that changes translator output, so it lands last, behind the inert module and the guard test. Verified against the full corpus and fuzz.

**Files:**
- Modify: `packages/nr-query-bridge/src/ir/foldPostAggregation.js` (import catalog; replace inline `NRQL_AGG_FUNCS`; case-insensitive `isAggregateExpr`; export `isAggregateExpr` for testing)
- Test: `packages/nr-query-bridge/test/ir/foldPostAggregation.test.js` (recognition-preserved + newly-recognized cases)

**Interfaces:**
- Consumes: `NRQL_AGGREGATE_FUNCS` (Task 1).
- Produces: `isAggregateExpr(node): boolean` now exported.

- [ ] **Step 1: Write failing recognition tests**

Append to `packages/nr-query-bridge/test/ir/foldPostAggregation.test.js`:

```js
import { isAggregateExpr } from '../../src/ir/foldPostAggregation.js';

describe('isAggregateExpr (catalog-derived recognition)', () => {
  // Strict superset of the pre-existing 15: 14 are catalog aggregators; the 15th,
  // standarddeviation, is preserved via AGG_ADDITIONS (it is the subquery-exposed
  // column name of stddev — staging-verified lowercase — not a callable function).
  const preserved = ['count', 'sum', 'average', 'min', 'max', 'median',
    'percentile', 'stddev', 'standarddeviation', 'uniqueCount', 'uniques',
    'latest', 'earliest', 'rate', 'percentage'];
  it.each(preserved)('still recognizes %s (case-insensitive)', (name) => {
    expect(isAggregateExpr(Func(name, []))).toBe(true);
  });
  it('recognizes a newly-catalogued aggregate (apdex)', () => {
    expect(isAggregateExpr(Func('apdex', [Identifier('duration')]))).toBe(true);
  });
  it('does not treat a scalar function as an aggregate', () => {
    expect(isAggregateExpr(Func('lower', [Identifier('name')]))).toBe(false);
  });
});
```

`Func`/`Identifier` are already imported at the top of this test file.

- [ ] **Step 2: Run, verify failure**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- foldPostAggregation`
Expected: FAIL — `isAggregateExpr` is not exported, and `apdex`/camelCase `uniqueCount` are not recognized by the old inline set.

- [ ] **Step 3: Derive the set, make recognition case-insensitive, export the predicate**

In `packages/nr-query-bridge/src/ir/foldPostAggregation.js`:

Add to the imports at the top:

```js
import { NRQL_AGGREGATE_FUNCS } from './nrqlCatalog.js';
```

Replace the entire inline `const NRQL_AGG_FUNCS = new Set([ ... ]);` block with:

```js
// Aggregate-function recognition, derived from the NRQL catalog (nrqlCatalog.js,
// regenerated from NRQLDocServlet). AGG_ADDITIONS keeps names the servlet omits
// but the fold logic still classifies: 'standarddeviation' is the subquery-exposed
// column name of a bare stddev() (staging-verified lowercase; NOT a callable
// function — standardDeviation() is Unknown). Keeping it makes this set a strict
// superset of the pre-existing 15 (no narrowing).
const AGG_ADDITIONS = ['standarddeviation'];
const NRQL_AGG_FUNCS = new Set([...NRQL_AGGREGATE_FUNCS, ...AGG_ADDITIONS]);
```

Change the `isAggregateExpr` Function-node branch to lowercase the name, and export the function:

```js
export function isAggregateExpr(node) {
  if (!node) return false;
  if (node.type === 'Alias') return isAggregateExpr(node.expr);
  if (node.type === 'Function') {
    return (
      NRQL_AGG_FUNCS.has(String(node.name).toLowerCase()) ||
      node.args.some(isAggregateExpr)
    );
  }
  if (node.type === 'BinOp')
    return isAggregateExpr(node.left) || isAggregateExpr(node.right);
  return false;
}
```

- [ ] **Step 4: Run the recognition tests, verify pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- foldPostAggregation`
Expected: PASS.

- [ ] **Step 5: Measure corpus blast radius**

Run the full package suite (the real-world corpus lives in `test/spl/spl.test.js` + `spl-real-world.json`):

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge`
Expected: either all green (broadening changed no output — ideal), or a bounded set of `spl.test.js` failures where a query now classifies as post-aggregation.

For EACH failing case:
1. Read the produced NRQL vs the expected `nrql`.
2. Validate the produced NRQL against staging (invoke the `nrql-validation` skill / `nrql-validator`, per project rules — never promote `verified` without it).
3. If the new NRQL is correct, update the case's expected `nrql` (and `warningFunc`/`unsupportedFunc` if they shifted). If it is wrong, the broadening exposed a real fold bug — fix the fold logic, do not paper over it by narrowing the set silently.

- [ ] **Step 6: Check the timeseries-function caveat**

Run: `grep -rn "derivative\|predictLinear" packages/nr-query-bridge/test/spl ../nr-query-bridge-corpus 2>/dev/null | head`
- If absent from corpus and tests: add a code comment in `foldPostAggregation.js` noting `derivative`/`predictLinear` are catalog aggregators that return null without TIMESERIES, and no corpus query exercises them. No further action.
- If present: construct an IR fold case for the offending shape, verify the output on staging, and if it misclassifies, add the name to a documented subtractions overlay (`const AGG_SUBTRACTIONS = ['derivative','predictlinear'];` filtered out of `NRQL_AGG_FUNCS`) with a comment and a test.

- [ ] **Step 7: Fuzz 20× (reseeds each run; one green is a false-green)**

Run: `cd packages/nr-query-bridge && for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npx vitest run spl-fuzz || break; done`
Expected: 20 consecutive passes.

- [ ] **Step 8: Full gate + commit**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check && ASDF_NODEJS_VERSION=24.14.0 npm test`
Expected: all pass.

```bash
cd /Users/chuck/ghe/nr-query-bridge
git add packages/nr-query-bridge/src/ir/foldPostAggregation.js \
        packages/nr-query-bridge/test/ir/foldPostAggregation.test.js
# add any test/spl/spl.test.js cases updated in Step 5
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: derive aggregate-function recognition from the NRQL catalog"
```

---

## Task 4 (optional): Widen `FOLD_SAFE_FUNCS` toward the catalog

Only do this if a real query would benefit. The subset invariant (Task 2) already passes with the conservative set; this task ADDS distributed functions the catalog confirms but we currently omit (`clamp_max`, `clamp_min`, `filter`, `todatetime`, `totimestamp`). Each addition changes fold behavior and must be corpus-proven.

**Files:**
- Modify: `packages/nr-query-bridge/src/ir/foldPostAggregation.js` (`FOLD_SAFE_FUNCS`)
- Test: `packages/nr-query-bridge/test/ir/foldPostAggregation.test.js`

- [ ] **Step 1: Decide per candidate**

For each of `clamp_max`, `clamp_min`, `filter`, `todatetime`, `totimestamp`: is there a corpus query where an eval built on it currently forces an unnecessary subquery? Run `grep` over the corpus. If none benefits, STOP — leave the conservative set and close this task as not-needed (the subset test already guarantees we never over-claim).

- [ ] **Step 2: Add a proven-safe candidate with a test**

Example, if `clamp_max` is justified: add `'clamp_max',` to `FOLD_SAFE_FUNCS`, then add a fold test:

```js
it('folds a clamp_max eval into the aggregation without a subquery', () => {
  // construct the SubquerySource IR the handlers produce for
  // `... | stats sum(x) as s | eval c = clamp_max(s, 100)` and assert the pass
  // folds it flat (no SubquerySource in the result).
  // (build the exact IR as the existing fold tests in this file do)
});
```

Verify the folded NRQL on staging before committing.

- [ ] **Step 3: Full gate + commit** (as Task 3 Step 8, message `feat: fold-safe <name> (catalog-confirmed distributed)`).

---

## Self-review

**Spec coverage:**
- Success criterion 1 (one artifact, one command) → Task 1 (`refresh:nrql-catalog`, snapshot + module).
- Criterion 2 (drift test fails on divergence, skips off-VPN) → Task 2 Steps 5–6.
- Criterion 3 (offline, zero-dep consumers) → Task 1 (materialized Sets; `renderModule` test asserts no import/json); Global Constraints.
- Criterion 4 (no internal names leak) → Task 1 `isCustomerFacing` + Step 8 no-leak test.
- "distributed computed pre-filter" → Task 1 `buildCatalog` (unfiltered intersection) + its test.
- "NRQL_AGG_FUNCS derived, superset check, case-insensitive" → Task 3 (recognition tests + lowercasing); `standarddeviation` preserved via `AGG_ADDITIONS` so the set is a strict superset of the current 15.
- "FOLD_SAFE curated subset, flags case" → Task 2 Steps 2–4.
- "ROW_WISE untouched" → not modified in any task (correct).
- PR4 (fold-safe widening) → Task 4.

**Placeholder scan:** No TBD/TODO. Task 3 Step 5 and Task 4 are investigative by nature (blast radius is discovered at run time), but each gives an explicit decision procedure and validation gate, not a vague "handle it." Task 4 Step 2's test body is described, not coded, because the exact candidate is chosen at Step 1 — acceptable for an explicitly-optional, contingent task.

**Type consistency:** `buildCatalog`/`renderModule`/`isCustomerFacing`/`NRQL_DOC_ENDPOINT` (Task 1) are consumed with matching signatures in Task 2. `NRQL_AGGREGATE_FUNCS`/`NRQL_DISTRIBUTED_FUNCS`/`NRQL_SCALAR_FUNCS`/`stageOf`/`isAggregate`/`isDistributed` exports are consistent across Tasks 1–3. `FOLD_SAFE_FUNCS` exported in Task 2, consumed in Task 2's test. `isAggregateExpr` exported in Task 3, consumed in Task 3's test.
