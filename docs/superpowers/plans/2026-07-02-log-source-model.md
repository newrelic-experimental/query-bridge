# Log Source Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller supply a `logSourceModel` that maps Splunk's `index`/`sourcetype`/`source` metadata fields onto the New Relic log data model — as a partition (`FROM Log_<name>`), a kept `WHERE` attribute, or dropped — instead of the translator blindly emitting `WHERE index = '…'`.

**Architecture:** The metadata-field predicates are *collected* during the search-expression walk (returning `null` so they drop out of the `WHERE` tree, exactly like the existing relative-time `SINCE`/`UNTIL` handling) and *resolved* once, after the walk, against the caller's ordered routing rules. Resolution sets `ir.dataSource` (the `FROM` target — `EventType(names)` already supports a comma-list union), pushes `keep` fields back as `WHERE` conditions, and emits warnings/unsupported. A new pure module owns rule matching and resolution so it is unit-testable in isolation.

**Tech Stack:** Pure ESM JavaScript, zero runtime dependencies. Vitest. Peggy parser (unchanged — no grammar work). The design spec is `docs/superpowers/specs/2026-07-02-log-source-model-design.md`.

## Global Constraints

- **Node 24 for all dev commands:** prefix every command with `ASDF_NODEJS_VERSION=24.14.0`.
- **Zero runtime dependencies** in `@newrelic/query-bridge` — hand-roll glob matching, no libs.
- **Loud failure over silent wrong results:** a construct with no faithful NRQL form pushes to `ir.unsupported` (→ `nrql: ''`), never a wrong query.
- **All user-facing strings live in `src/messages.js`** as keyed functions with a JSDoc SPL example; handlers call `messages.key(...)` — no inline template literals. Lead each message with a meaningful word.
- **Message-key test contract:** every `warningFunc`/`unsupportedFunc` entry in a `spl.test.js` case must be a real key in `messages`, and the arrays must be *exhaustive* (list every message that fires).
- **Commits:** conventional (`feat:`/`fix:`/`chore:`), lowercase subject ≤72 chars, body lines ≤100. Commit with `ASDF_NODEJS_VERSION=24.14.0 git commit`.
- **Run `npm run build:parsers` only if the grammar changes** — it does not here.
- **No customer identifiers** in code, tests, or fixtures — use placeholders (`web`, `api`, `access`).
- **Monorepo paths:** translator package root is `packages/nr-query-bridge/`. All `src/…`, `test/…`, `bin/…` paths below are relative to that root. The dashboard importer is `packages/nr-dashboard-importer/`.

---

## File Structure

- **Create** `packages/nr-query-bridge/src/input/spl/logSourceModel.js` — pure resolver: normalize a `logSourceModel`, match a predicate set against the ordered rules (literal + glob), resolve `{ partitions, keep, consumed, dropped, unsupportedKey, warnDefault }`, validate partition names. No IR, no imports from the pipeline.
- **Create** `packages/nr-query-bridge/test/spl/logSourceModel.test.js` — unit tests for the module (explicit `it()` per scenario).
- **Modify** `packages/nr-query-bridge/src/messages.js` — add the metadata/partition message keys.
- **Modify** `packages/nr-query-bridge/src/translate.js` — thread an `options` argument into `translateAstToIR`.
- **Modify** `packages/nr-query-bridge/src/input/spl/splToIR.js` — `translateAstToIR(ast, options)`; collect metadata predicates during the walk; resolve + apply after the walk.
- **Modify** `packages/nr-query-bridge/test/spl/spl.test.js` — add a per-case `logSourceModel` field to the runner; add the data-driven metadata cases.
- **Modify** `packages/nr-query-bridge/bin/spl2nrql.js` — add `--log-source-model <file.json>` (imports `translateSplToNrql` via `../src/index.js`).
- **Modify** `packages/nr-dashboard-importer/bin/spl-dashboard.js` — add `--log-source-model`, thread through `runImport(input, opts)` → `translateWidgets`/`translateVariables`.
- **Modify** `packages/nr-dashboard-importer/src/translateWidgets.js:113` and `src/translateVariables.js:43` — pass `{ logSourceModel }` into each `translateSplToNrql` call.

Dependency order: module (PR 1) → wire single-partition (PR 2) → multi-FROM union (PR 3) → CLI + importer (PR 4).

---

## PR 1 — Source-model resolver module (pure, inert)

Ships a fully unit-tested module that nothing in the pipeline calls yet. ~200 lines.

### Task 1.1: Partition-name validation + glob matching

**Files:**
- Create: `packages/nr-query-bridge/src/input/spl/logSourceModel.js`
- Test: `packages/nr-query-bridge/test/spl/logSourceModel.test.js`

**Interfaces:**
- Produces: `validatePartitionName(name: string): boolean` — accepts `Log` and `Log_<alnum/underscore>`. `isGlobMatch(value: string, pattern: string): boolean` — `*` is the only wildcard; exact match when no `*`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { validatePartitionName, isGlobMatch } from '../../src/input/spl/logSourceModel.js';

describe('validatePartitionName', () => {
  it('accepts the base Log target', () => {
    expect(validatePartitionName('Log')).toBe(true);
  });
  it('accepts Log_ names with underscores', () => {
    expect(validatePartitionName('Log_AIR_EU')).toBe(true);
  });
  it('rejects names missing the Log_ prefix', () => {
    expect(validatePartitionName('web')).toBe(false);
  });
  it('rejects names with spaces or dots', () => {
    expect(validatePartitionName('Log_a b')).toBe(false);
    expect(validatePartitionName('Log_a.b')).toBe(false);
  });
});

describe('isGlobMatch', () => {
  it('matches exact when no wildcard', () => {
    expect(isGlobMatch('audit_login', 'audit_login')).toBe(true);
    expect(isGlobMatch('audit_login', 'access')).toBe(false);
  });
  it('matches a trailing-star prefix glob', () => {
    expect(isGlobMatch('audit_login', 'audit_*')).toBe(true);
    expect(isGlobMatch('access', 'audit_*')).toBe(false);
  });
  it('does not let the glob dot leak (regex-escapes literals)', () => {
    expect(isGlobMatch('axccess', 'a.ccess')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- logSourceModel`
Expected: FAIL — `validatePartitionName is not a function` (module has no exports yet).

- [ ] **Step 3: Write minimal implementation**

```js
// packages/nr-query-bridge/src/input/spl/logSourceModel.js
/**
 * Resolves Splunk metadata-field predicates (index/sourcetype/source) against a
 * caller-supplied logSourceModel. Pure — no IR, no pipeline imports.
 */

/** A partition FROM target: the base `Log`, or `Log_<alnum/underscore>`. */
export function validatePartitionName(name) {
  return /^Log(_[A-Za-z0-9_]+)?$/.test(name);
}

/** Glob match where `*` is the only wildcard; exact-equality when no `*`. */
export function isGlobMatch(value, pattern) {
  if (!pattern.includes('*')) return value === pattern;
  const rx =
    '^' +
    pattern
      .split('*')
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*') +
    '$';
  return new RegExp(rx).test(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- logSourceModel`
Expected: PASS (9 assertions).

- [ ] **Step 5: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/logSourceModel.js packages/nr-query-bridge/test/spl/logSourceModel.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: partition-name + glob helpers for log source model"
```

### Task 1.2: `resolveLogSource` — zero-config default and single-value rule matching

**Files:**
- Modify: `packages/nr-query-bridge/src/input/spl/logSourceModel.js`
- Test: `packages/nr-query-bridge/test/spl/logSourceModel.test.js`

**Interfaces:**
- Consumes: a predicate list, each `{ field: 'index'|'sourcetype'|'source', values: string[], negated: boolean, wildcard: boolean }`, and a `model` (`{ routing: [{when,partition,keep}], default: {partition,keep} | 'unsupported' }`) or `null`/`undefined`.
- Produces: `resolveLogSource(predicates, model): { partitions: string[], keep: string[], consumed: string[], dropped: string[], warnDefault: boolean, unsupportedKey: string|null, errorKey: string|null }`.

- [ ] **Step 1: Write the failing test**

```js
import { resolveLogSource } from '../../src/input/spl/logSourceModel.js';

const P = (field, value) => ({ field, values: [value], negated: false, wildcard: false });

describe('resolveLogSource — zero config', () => {
  it('keeps all present metadata fields as attributes and flags warnDefault', () => {
    const r = resolveLogSource([P('index', 'web')], null);
    expect(r).toEqual({ partitions: ['Log'], keep: ['index'], consumed: [], dropped: [], warnDefault: true, unsupportedKey: null, errorKey: null });
  });
});

describe('resolveLogSource — rule matching', () => {
  const model = {
    routing: [
      { when: { index: 'web', sourcetype: 'audit_*' }, partition: 'Log_compliance', keep: [] },
      { when: { index: 'web' }, partition: 'Log_web', keep: ['sourcetype'] },
    ],
    default: { partition: 'Log', keep: ['index', 'sourcetype'] },
  };
  it('first-match-wins with a glob, consuming both matched fields (keep empty)', () => {
    const r = resolveLogSource([P('index', 'web'), P('sourcetype', 'audit_login')], model);
    expect(r.partitions).toEqual(['Log_compliance']);
    expect(r.consumed.sort()).toEqual(['index', 'sourcetype']);
    expect(r.keep).toEqual([]);
    expect(r.unsupportedKey).toBeNull();
  });
  it('keeps a kept field as attribute while consuming the routing field', () => {
    const r = resolveLogSource([P('index', 'web'), P('sourcetype', 'access')], model);
    expect(r.partitions).toEqual(['Log_web']);
    expect(r.consumed).toEqual(['index']);
    expect(r.keep).toEqual(['sourcetype']);
  });
  it('falls to a rule default (no warnDefault) when no rule matches', () => {
    const r = resolveLogSource([P('index', 'payments')], model);
    expect(r).toEqual({ partitions: ['Log'], keep: ['index'], consumed: [], dropped: [], warnDefault: false, unsupportedKey: null, errorKey: null });
  });
  it('drops a present field absent from the matched keep', () => {
    const r = resolveLogSource([P('index', 'web'), P('source', '/var/log/x')], model);
    expect(r.partitions).toEqual(['Log_web']);
    expect(r.dropped).toEqual(['source']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- logSourceModel`
Expected: FAIL — `resolveLogSource is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `logSourceModel.js`)

```js
function collectRoutingFields(model) {
  const fields = new Set();
  for (const rule of model.routing || []) {
    for (const f of Object.keys(rule.when || {})) fields.add(f);
  }
  return fields;
}

function ruleMatches(when, lits) {
  return Object.keys(when).every(
    (f) => lits[f] !== undefined && isGlobMatch(lits[f], when[f]),
  );
}

function result(over = {}) {
  return {
    partitions: ['Log'], keep: [], consumed: [], dropped: [],
    warnDefault: false, unsupportedKey: null, errorKey: null, errorName: null, ...over,
  };
}

export function resolveLogSource(predicates, model) {
  const present = predicates.map((p) => p.field);
  if (!model) {
    return result({ keep: present, warnDefault: true });
  }
  const lits = Object.fromEntries(predicates.map((p) => [p.field, p.values[0]]));
  const rule = (model.routing || []).find((r) => ruleMatches(r.when, lits));
  if (rule) {
    if (!validatePartitionName(rule.partition)) {
      return result({ errorKey: 'partition_name_invalid', errorName: rule.partition });
    }
    const matched = Object.keys(rule.when);
    const keep = present.filter((f) => (rule.keep || []).includes(f));
    const consumed = matched.filter((f) => !keep.includes(f));
    const dropped = present.filter((f) => !keep.includes(f) && !consumed.includes(f));
    return result({ partitions: [rule.partition], keep, consumed, dropped });
  }
  if (model.default === 'unsupported') {
    return result({ unsupportedKey: 'partition_underspecified_unsupported' });
  }
  const d = model.default;
  if (!validatePartitionName(d.partition)) {
    return result({ errorKey: 'partition_name_invalid', errorName: d.partition });
  }
  const keep = present.filter((f) => (d.keep || []).includes(f));
  const dropped = present.filter((f) => !keep.includes(f));
  return result({ partitions: [d.partition], keep, dropped });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- logSourceModel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/logSourceModel.js packages/nr-query-bridge/test/spl/logSourceModel.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: resolveLogSource zero-config + single-value rule matching"
```

### Task 1.3: `resolveLogSource` guards (negation, wildcard, multi-value, underspecified)

**Files:**
- Modify: `packages/nr-query-bridge/src/input/spl/logSourceModel.js`
- Test: `packages/nr-query-bridge/test/spl/logSourceModel.test.js`

**Interfaces:**
- Produces: same signature; adds `unsupportedKey` values `partition_selection_negation_unsupported`, `partition_selection_wildcard_unsupported`, `partition_selection_mixed_unsupported` (the last is the interim multi-value verdict; PR 3 upgrades it to a union), and `partition_underspecified_unsupported` for a bare (no-metadata) query against `default: 'unsupported'`.

- [ ] **Step 1: Write the failing test**

```js
const model = { routing: [{ when: { index: 'web' }, partition: 'Log_web', keep: [] }], default: 'unsupported' };

describe('resolveLogSource — guards', () => {
  it('negation on a routing field is unsupported', () => {
    const r = resolveLogSource([{ field: 'index', values: ['web'], negated: true, wildcard: false }], model);
    expect(r.unsupportedKey).toBe('partition_selection_negation_unsupported');
  });
  it('wildcard on a routing field is unsupported', () => {
    const r = resolveLogSource([{ field: 'index', values: ['web*'], negated: false, wildcard: true }], model);
    expect(r.unsupportedKey).toBe('partition_selection_wildcard_unsupported');
  });
  it('multiple values on a routing field is (interim) unsupported', () => {
    const r = resolveLogSource([{ field: 'index', values: ['web', 'api'], negated: false, wildcard: false }], model);
    expect(r.unsupportedKey).toBe('partition_selection_mixed_unsupported');
  });
  it('a query with no metadata field against an unsupported default is underspecified', () => {
    const r = resolveLogSource([], model);
    expect(r.unsupportedKey).toBe('partition_underspecified_unsupported');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- logSourceModel`
Expected: FAIL — negation/wildcard/multi return a partition instead of an `unsupportedKey`.

- [ ] **Step 3: Write minimal implementation** — insert the guard loop right after `const lits = …` (before the `rule` lookup) in `resolveLogSource`:

```js
  const routingFields = collectRoutingFields(model);
  for (const p of predicates) {
    if (!routingFields.has(p.field)) continue;
    if (p.negated) return result({ unsupportedKey: 'partition_selection_negation_unsupported' });
    if (p.wildcard) return result({ unsupportedKey: 'partition_selection_wildcard_unsupported' });
    if (p.values.length > 1) return result({ unsupportedKey: 'partition_selection_mixed_unsupported' });
  }
```

(The empty-predicates + `default: 'unsupported'` case already returns `partition_underspecified_unsupported` from Task 1.2's no-rule branch — the new test just pins it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- logSourceModel`
Expected: PASS (all module tests green).

- [ ] **Step 5: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/logSourceModel.js packages/nr-query-bridge/test/spl/logSourceModel.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: resolveLogSource guards for negation/wildcard/multi/underspecified"
```

---

## PR 2 — Wire single-partition resolution into `splToIR`

Threads the model in and applies single-value resolution: sets `FROM`, keeps/consumes/drops fields, and fires the guards. `OR`/`IN` over a routing field is `unsupported` here (PR 3 upgrades it to a union). ~300–400 lines.

### Task 2.1: Thread an `options` argument through the entry points

**Files:**
- Modify: `packages/nr-query-bridge/src/translate.js:31` and `:57`
- Modify: `packages/nr-query-bridge/src/input/spl/splToIR.js:132`
- Test: `packages/nr-query-bridge/test/spl/spl.test.js` (new `it()` block near the top)

**Interfaces:**
- Produces: `translateSplToNrql(spl: string, options?: { logSourceModel?: object }): TranslateResult`; `translateAstToIR(ast, options?: object): IR`.

- [ ] **Step 1: Write the failing test** (add to `spl.test.js`, outside the `cases` loop)

```js
it('accepts an options argument without changing default output', () => {
  const a = translateSplToNrql('index=web error');
  const b = translateSplToNrql('index=web error', {});
  expect(b.nrql).toBe(a.nrql);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
Expected: PASS already (JS ignores extra args) — so this step just pins the contract. If it errors, fix the signature first.

- [ ] **Step 3: Add the parameter plumbing**

In `translate.js`, change the signature and the IR call:

```js
export function translateSplToNrql(spl, options = {}) {
```
```js
  // Pass 1: SPL AST → IR
  const ir = translateAstToIR(ast, options);
```

In `splToIR.js`:
```js
export function translateAstToIR(ast, options = {}) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/translate.js packages/nr-query-bridge/src/input/spl/splToIR.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: thread options argument into translateAstToIR"
```

### Task 2.2: Collect + resolve metadata predicates; add messages; add cases

**Files:**
- Modify: `packages/nr-query-bridge/src/messages.js` (add keys)
- Modify: `packages/nr-query-bridge/src/input/spl/splToIR.js` (interception + apply)
- Modify: `packages/nr-query-bridge/test/spl/spl.test.js` (runner passes `logSourceModel`; add cases)

**Interfaces:**
- Consumes: `resolveLogSource`, `validatePartitionName` from `./logSourceModel.js`; `EventType` from `../../ir/nodes.js` (already imported in splToIR).
- Produces: `translateSearchExpr(node, ir, collectMetadata = false)` — when `collectMetadata`, its return object additionally carries `metaPreds: Array<{field,values,negated,wildcard}>`.

- [ ] **Step 1: Add the message keys** to `src/messages.js` (place near other partition/field messages; each with a JSDoc SPL example):

```js
  // SPL: `index=web error` (no logSourceModel supplied)
  metadata_field_attribute_default: (field) =>
    `${field} is Splunk metadata; its New Relic representation is deployment-specific (often a partition — FROM Log_<value> — not an attribute). Emitted as a WHERE attribute by default; supply a logSourceModel to confirm.`,

  // SPL: `index=web source="/var/log/x"` with a model whose matched rule does not keep `source`
  metadata_field_dropped: (field) =>
    `${field} predicate was neither routed to a partition nor kept as an attribute by the log source model, so it was dropped; results may be broader than the SPL.`,

  // SPL: `index=web OR index=api` (index is a routing field) — interim; PR 3 emits a union
  partition_selection_mixed_unsupported: () =>
    'a partition-routing field selected by OR/IN resolves to more than one partition or an incoherent mix; not yet translatable',

  // SPL: `index=web*` (index is a routing field)
  partition_selection_wildcard_unsupported: () =>
    'a partition-routing field selected by wildcard has no NRQL equivalent (there is no FROM Log_*)',

  // SPL: `index!=web` (index is a routing field)
  partition_selection_negation_unsupported: () =>
    'a negated partition-routing field would require every partition except one, which cannot be enumerated',

  // SPL: `status=500` with a model whose default is 'unsupported'
  partition_underspecified_unsupported: () =>
    'no routing rule matched and the log source model default is unsupported; the query cannot be answered from FROM Log',

  // SPL: a logSourceModel rule whose partition name is not Log_-prefixed
  partition_name_invalid: (name) =>
    `log source model partition name '${name}' is invalid; it must be 'Log' or begin with 'Log_' and contain only letters, digits, and underscores`,
```

- [ ] **Step 2: Write the failing cases** in `spl.test.js` (add to the `cases` array; the runner change in Step 4 makes `logSourceModel` live):

```js
{
  spl: 'index=web sourcetype=access status=500',
  logSourceModel: {
    routing: [{ when: { index: 'web' }, partition: 'Log_web', keep: ['sourcetype'] }],
    default: { partition: 'Log', keep: ['index', 'sourcetype'] },
  },
  nrql: "FROM Log_web SELECT * WHERE sourcetype = 'access' AND status = '500' OR numeric(status) = 500",
  warningFunc: [],
  unsupportedFunc: [],
  verified: false,
},
{
  spl: 'index=web error',
  nrql: "FROM Log SELECT * WHERE index = 'web' AND message LIKE '%error%'",
  warningFunc: ['metadata_field_attribute_default'],
  unsupportedFunc: [],
  verified: false,
},
{
  spl: 'index=web*',
  logSourceModel: { routing: [{ when: { index: 'web' }, partition: 'Log_web', keep: [] }], default: 'unsupported' },
  nrql: '',
  unsupportedFunc: ['partition_selection_wildcard_unsupported'],
  verified: false,
},
{
  spl: 'index!=web',
  logSourceModel: { routing: [{ when: { index: 'web' }, partition: 'Log_web', keep: [] }], default: 'unsupported' },
  nrql: '',
  unsupportedFunc: ['partition_selection_negation_unsupported'],
  verified: false,
},
```

- [ ] **Step 3: Run to verify the cases fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
Expected: FAIL — model ignored: `index=web sourcetype=access …` still emits `FROM Log … WHERE index = 'web' …`; the `metadata_field_attribute_default` warning is absent.

- [ ] **Step 4: Implement interception + apply.**

(a) In `splToIR.js`, near the top-level constants add:
```js
const METADATA_FIELDS = new Set(['index', 'sourcetype', 'source']);

function metaPredToCondition(pred) {
  const id = Identifier(pred.field);
  if (pred.values.length > 1) return In(id, pred.values.map((v) => coerceValue(v)));
  const v = pred.values[0];
  if (pred.wildcard) {
    const like = Like(id, escapeWildcard(v));
    return pred.negated ? Not(like) : like;
  }
  return buildComparison(pred.field, pred.negated ? '!=' : '=', v);
}
```
(Ensure `Identifier`, `In`, `Like`, `Not`, `EventType`, `coerceValue`, `escapeWildcard`, `buildComparison` are imported — all are already used elsewhere in this file except confirm `EventType`.)

(b) Change `translateSearchExpr(node, ir)` to `translateSearchExpr(node, ir, collectMetadata = false)`. Add closure state beside the other walk vars:
```js
  const metaPreds = [];
  let disjunctiveDepth = 0;
```
Wrap the `BooleanOp` `OR` and `Not` descents to bump the depth:
```js
      case 'BooleanOp': {
        const disj = node.operator === 'OR';
        if (disj) disjunctiveDepth++;
        const left = walk(node.left);
        const right = walk(node.right);
        if (disj) disjunctiveDepth--;
        if (!left && !right) return null;
        if (!left) return right;
        if (!right) return left;
        return BinOp(node.operator, left, right);
      }

      case 'Not': {
        disjunctiveDepth++;
        const inner = walk(node.operand);
        disjunctiveDepth--;
        if (!inner) return null;
        return Not(inner);
      }
```
At the very top of `case 'Comparison':` (before the `rhsExpr` branch) and `case 'InComparison':` (before its body), intercept metadata:
```js
        if (collectMetadata && METADATA_FIELDS.has(node.field)) {
          if (disjunctiveDepth > 0) {
            unsupported.push(messages.partition_selection_mixed_unsupported());
            return null;
          }
          const values = node.type === 'InComparison' ? node.values : [node.value];
          metaPreds.push({
            field: node.field,
            values,
            negated: node.operator === '!=',
            wildcard: values.some((v) => typeof v === 'string' && v.includes('*')),
          });
          return null;
        }
```
Add `metaPreds` to the returned object of `translateSearchExpr`.

(c) In `translateAstToIR`, call the top-level walk with `true` and apply the resolution. Replace the `if (ast.search) { … }` block's destructure to include `metaPreds`, and after the existing since/until handling add:
```js
    const res = resolveLogSource(metaPreds, options.logSourceModel);
    if (res.errorKey) {
      ir.errors.push(messages[res.errorKey](res.errorName));
    } else if (res.unsupportedKey) {
      ir.unsupported.push(messages[res.unsupportedKey]());
    } else {
      ir.dataSource = EventType(res.partitions);
      for (const f of res.keep) {
        ir.where.push(metaPredToCondition(metaPreds.find((p) => p.field === f)));
      }
      for (const f of res.dropped) ir.warnings.push(messages.metadata_field_dropped(f));
      if (res.warnDefault) {
        for (const p of metaPreds) ir.warnings.push(messages.metadata_field_attribute_default(p.field));
      }
    }
```
Change the destructure/call to: `const { expr, warnings, unsupported, since, until, sawTimeToken, sawTimeLiteral, metaPreds } = translateSearchExpr(ast.search, ir, true);`

Note for the implementer: `partition_name_invalid` is an *error* (not unsupported) — routed to `ir.errors` via `errorKey`, with the offending name in `res.errorName` (set by the module in PR 1).

- [ ] **Step 5: Change the runner to pass the model**

In `spl.test.js`, find the `cases.forEach`/`for` loop that calls `translateSplToNrql(...)` and pass the per-case model:
```js
const result = translateSplToNrql(c.spl, c.logSourceModel ? { logSourceModel: c.logSourceModel } : undefined);
```

- [ ] **Step 6: Run all tests**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge`
Expected: PASS — the four new cases plus the whole existing suite (no regression: with no model, `index=web` still emits `WHERE index = 'web'`, now with the `metadata_field_attribute_default` warning).

- [ ] **Step 7: Fix pre-existing cases that now warn.** Any existing `cases` entry whose SPL names `index`/`sourcetype`/`source` and has no `logSourceModel` now fires `metadata_field_attribute_default`. For each, add `warningFunc: ['metadata_field_attribute_default']` (merge with any existing keys). Re-run Step 6 until green.

- [ ] **Step 8: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/messages.js packages/nr-query-bridge/src/input/spl/splToIR.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: resolve log source model metadata fields in splToIR"
```

---

## PR 3 — Multi-partition `FROM` union for `OR` / `IN` over a routing field

Upgrades the interim `partition_selection_mixed_unsupported` verdict to a real `FROM Log_web, Log_api` union. Needs no emitter or apply change — PR 2 already emits `EventType(res.partitions)`; PR 3 just makes `res.partitions` a resolved multi-list and collates an `OR` subtree into one multi-value predicate. ~150–250 lines.

### Task 3.1: `resolveLogSource` — resolve a multi-value routing field to a partition union

**Files:**
- Modify: `packages/nr-query-bridge/src/input/spl/logSourceModel.js`
- Test: `packages/nr-query-bridge/test/spl/logSourceModel.test.js`

**Interfaces:**
- Produces: `resolveLogSource` now returns `partitions` of length ≥ 1 for a single multi-value routing predicate whose every value matches a rule with an identical `keep` set; otherwise `unsupportedKey: 'partition_selection_mixed_unsupported'`. Adds `errorName` to the result when `errorKey` is `partition_name_invalid`.

- [ ] **Step 1: Write the failing test**

```js
describe('resolveLogSource — multi-value union', () => {
  const model = {
    routing: [
      { when: { index: 'web' }, partition: 'Log_web', keep: [] },
      { when: { index: 'api' }, partition: 'Log_api', keep: [] },
    ],
    default: 'unsupported',
  };
  it('unions the partitions when every value matches a rule with the same keep set', () => {
    const r = resolveLogSource([{ field: 'index', values: ['web', 'api'], negated: false, wildcard: false }], model);
    expect(r.partitions).toEqual(['Log_web', 'Log_api']);
    expect(r.consumed).toEqual(['index']);
    expect(r.unsupportedKey).toBeNull();
  });
  it('is mixed-unsupported when one value hits no rule', () => {
    const r = resolveLogSource([{ field: 'index', values: ['web', 'payments'], negated: false, wildcard: false }], model);
    expect(r.unsupportedKey).toBe('partition_selection_mixed_unsupported');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- logSourceModel`
Expected: FAIL — the Task 1.3 guard returns `partition_selection_mixed_unsupported` for *both* (it blanket-rejects `values.length > 1`).

- [ ] **Step 3: Implement.** In `resolveLogSource`, (a) delete the guard line `if (p.values.length > 1) return result({ unsupportedKey: 'partition_selection_mixed_unsupported' });`, and (b) insert a multi-value block after the negation/wildcard guard loop and before the single-value `lits`/`rule` block:

```js
  const multi = predicates.filter((p) => routingFields.has(p.field) && p.values.length > 1);
  if (multi.length > 1) return result({ unsupportedKey: 'partition_selection_mixed_unsupported' });
  if (multi.length === 1) {
    const mp = multi[0];
    const others = Object.fromEntries(
      predicates.filter((p) => p !== mp).map((p) => [p.field, p.values[0]]),
    );
    const rules = mp.values.map((v) =>
      (model.routing || []).find((r) => ruleMatches(r.when, { ...others, [mp.field]: v })),
    );
    if (rules.some((r) => !r)) return result({ unsupportedKey: 'partition_selection_mixed_unsupported' });
    const keepSig = (r) => JSON.stringify([...(r.keep || [])].sort());
    if (rules.some((r) => keepSig(r) !== keepSig(rules[0]))) {
      return result({ unsupportedKey: 'partition_selection_mixed_unsupported' });
    }
    const bad = rules.map((r) => r.partition).find((n) => !validatePartitionName(n));
    if (bad) return result({ errorKey: 'partition_name_invalid', errorName: bad });
    const present = predicates.map((p) => p.field);
    const ruleKeep = rules[0].keep || [];
    const keep = present.filter((f) => ruleKeep.includes(f) && f !== mp.field);
    const matched = new Set(rules.flatMap((r) => Object.keys(r.when)));
    const consumed = [...matched].filter((f) => !keep.includes(f));
    const dropped = present.filter((f) => !keep.includes(f) && !consumed.includes(f));
    return result({ partitions: [...new Set(rules.map((r) => r.partition))], keep, consumed, dropped });
  }
```

(The single-value `partition_name_invalid` returns already carry `errorName` from PR 1, and `splToIR` already passes `res.errorName` — no extra change needed here.)

- [ ] **Step 4: Run test to verify it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- logSourceModel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/logSourceModel.js packages/nr-query-bridge/test/spl/logSourceModel.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: resolveLogSource multi-value partition union"
```

### Task 3.2: Collate an `OR`-of-single-metadata-field subtree in the walk

**Files:**
- Modify: `packages/nr-query-bridge/src/input/spl/splToIR.js`
- Test: `packages/nr-query-bridge/test/spl/spl.test.js`

**Interfaces:**
- Consumes: `METADATA_FIELDS` (from PR 2). Produces: no new exports — a pure `OR`-subtree of `field=<lit>` (or `field IN (…)`) on a single metadata field collates into one multi-value `metaPred`; an `OR` mixing metadata with anything else pushes `partition_selection_mixed_unsupported`.

- [ ] **Step 1: Write the failing cases** (add to `spl.test.js` `cases`)

```js
{
  spl: 'index=web OR index=api error',
  logSourceModel: {
    routing: [
      { when: { index: 'web' }, partition: 'Log_web', keep: [] },
      { when: { index: 'api' }, partition: 'Log_api', keep: [] },
    ],
    default: 'unsupported',
  },
  nrql: "FROM Log_web, Log_api SELECT * WHERE message LIKE '%error%'",
  warningFunc: [],
  unsupportedFunc: [],
  verified: false,
},
{
  spl: 'index=web OR status=500',
  logSourceModel: { routing: [{ when: { index: 'web' }, partition: 'Log_web', keep: [] }], default: 'unsupported' },
  nrql: '',
  unsupportedFunc: ['partition_selection_mixed_unsupported'],
  verified: false,
},
```

- [ ] **Step 2: Run to verify they fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
Expected: FAIL — the OR currently hits the `disjunctiveDepth` guard so both cases return `partition_selection_mixed_unsupported` (the union case wrongly fails).

- [ ] **Step 3: Implement.** Add two helpers near `METADATA_FIELDS`:

```js
function subtreeMetaField(node) {
  if (!node || typeof node !== 'object') return null;
  if ((node.type === 'Comparison' || node.type === 'InComparison') && METADATA_FIELDS.has(node.field)) {
    return node.field;
  }
  if (node.type === 'BooleanOp') return subtreeMetaField(node.left) || subtreeMetaField(node.right);
  return null;
}

function collectMetaOrValues(node, field) {
  if (node.type === 'Comparison' && node.field === field && node.operator === '=' && node.value != null) {
    return [node.value];
  }
  if (node.type === 'InComparison' && node.field === field) return node.values;
  if (node.type === 'BooleanOp' && node.operator === 'OR') {
    const l = collectMetaOrValues(node.left, field);
    const r = collectMetaOrValues(node.right, field);
    if (l && r) return [...l, ...r];
  }
  return null;
}
```

At the very top of `case 'BooleanOp':`, before the `disj` bookkeeping added in PR 2:

```js
        if (collectMetadata && node.operator === 'OR') {
          const mf = subtreeMetaField(node);
          if (mf) {
            const values = collectMetaOrValues(node, mf);
            if (values) {
              metaPreds.push({
                field: mf,
                values,
                negated: false,
                wildcard: values.some((v) => String(v).includes('*')),
              });
              return null;
            }
            unsupported.push(messages.partition_selection_mixed_unsupported());
            return null;
          }
        }
```

- [ ] **Step 4: Run to verify they pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge`
Expected: PASS — the union emits `FROM Log_web, Log_api …`; the mixed OR is `unsupported`.

- [ ] **Step 5: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/splToIR.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: collate OR-of-metadata into a partition union"
```

---

## PR 4 — CLI + dashboard-importer wiring

Surfaces the model on both CLIs. No new translation behavior — pure plumbing + integration tests. ~150 lines.

### Task 4.1: `--log-source-model` on `spl2nrql.js`

**Files:**
- Modify: `packages/nr-query-bridge/bin/spl2nrql.js`
- Test: `packages/nr-query-bridge/test/spl/spl2nrql-cli.test.js` (create) — or extend an existing CLI test if present.

**Interfaces:**
- Consumes: `translateSplToNrql(spl, { logSourceModel })`.

- [ ] **Step 1: Write the failing test** (spawn the CLI with a model file)

```js
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('applies a --log-source-model file to the query', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsm-'));
  const modelPath = join(dir, 'm.json');
  writeFileSync(modelPath, JSON.stringify({
    routing: [{ when: { index: 'web' }, partition: 'Log_web', keep: [] }],
    default: { partition: 'Log', keep: ['index'] },
  }));
  const out = execFileSync('node', ['bin/spl2nrql.js', '--log-source-model', modelPath, 'index=web error'], {
    cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8',
  });
  expect(out).toContain('FROM Log_web');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl2nrql-cli`
Expected: FAIL — output is `FROM Log …` (flag ignored) or the flag is treated as the query.

- [ ] **Step 3: Implement.** In `spl2nrql.js` add near the top:

```js
import { readFileSync } from 'node:fs';

function extractModel(args) {
  const i = args.indexOf('--log-source-model');
  if (i === -1) return { options: undefined, rest: args };
  const model = JSON.parse(readFileSync(args[i + 1], 'utf8'));
  const rest = args.slice(0, i).concat(args.slice(i + 2));
  return { options: { logSourceModel: model }, rest };
}
```

Then, where `const args = process.argv.slice(2)` is set (line ~60), destructure and use `rest` for the query/flag detection and `options` in the translate call:

```js
const { options, rest: args } = extractModel(process.argv.slice(2));
```

Update the non-interactive translate call (line ~12 helper and its caller) so the query string is translated with the options: `translateSplToNrql(spl, options)`. Thread `options` into whatever function wraps line 12 (pass it as a parameter).

- [ ] **Step 4: Run to verify it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl2nrql-cli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/bin/spl2nrql.js packages/nr-query-bridge/test/spl/spl2nrql-cli.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: --log-source-model flag on spl2nrql CLI"
```

### Task 4.2: Thread the model through the dashboard importer

**Files:**
- Modify: `packages/nr-dashboard-importer/bin/spl-dashboard.js` (`runImport` at :40, CLI arg parse, calls at :50–51, :125)
- Modify: `packages/nr-dashboard-importer/src/translateWidgets.js:113`
- Modify: `packages/nr-dashboard-importer/src/translateVariables.js:40,43`
- Test: `packages/nr-dashboard-importer/test/…` — add an integration test (mirror an existing `runImport`/`translateWidgets` test file).

**Interfaces:**
- Produces: `runImport(input, { account, region, logSourceModel })`; `translateWidgets(widgets, { multiSelectTokens, logSourceModel })`; `translateVariables(variables, { logSourceModel })`.

- [ ] **Step 1: Write the failing test** (a widget whose SPL names a partitioned index)

```js
it('routes a widget query to its partition when a logSourceModel is supplied', () => {
  const widgets = [{ rawSpl: 'index=web error', vizType: 'table', title: 't', grid: { x: 0, y: 0, w: 4, h: 3 } }];
  const out = translateWidgets(widgets, {
    logSourceModel: { routing: [{ when: { index: 'web' }, partition: 'Log_web', keep: [] }], default: 'unsupported' },
  });
  expect(JSON.stringify(out)).toContain('FROM Log_web');
});
```

(Match the real `Widget` shape used by the existing `translateWidgets` tests — copy the field names from a neighbouring test in the same file.)

- [ ] **Step 2: Run to verify it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- translateWidgets`
Expected: FAIL — output contains `FROM Log`, not `FROM Log_web` (model not threaded).

- [ ] **Step 3: Implement the threading.**

`translateWidgets.js:113` — pass the model:
```js
    const result = translateSplToNrql(widget.rawSpl, { logSourceModel: opts.logSourceModel });
```

`translateVariables.js:40` — add the opts param, and at :43:
```js
export function translateVariables(variables, opts = {}) {
```
```js
    const result = translateSplToNrql(v.sourceQuery, { logSourceModel: opts.logSourceModel });
```

`spl-dashboard.js` — `runImport` and its inner calls:
```js
export function runImport(input, opts) {
```
```js
      const translated = translateWidgets(model.widgets, { multiSelectTokens, logSourceModel: opts.logSourceModel });
      const variables = translateVariables(model.variables, { logSourceModel: opts.logSourceModel });
```
CLI arg parse (near the existing `--account`/`--region` handling): read `--log-source-model <path>` into `opts.logSourceModel = JSON.parse(readFileSync(path, 'utf8'))`, and pass it at :125:
```js
    results = runImport(xml, { account: opts.account, region: opts.region, logSourceModel: opts.logSourceModel });
```

- [ ] **Step 4: Run to verify it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer`
Expected: PASS (new test + no regression).

- [ ] **Step 5: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-dashboard-importer
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: thread log source model through dashboard importer"
```

---

## Notes for the implementer

- **Confirm imports in `splToIR.js`:** `EventType` must be imported from `../../ir/nodes.js` (add it if absent); `Identifier`, `In`, `Like`, `Not`, `coerceValue`, `escapeWildcard`, `buildComparison` are already used in the file.
- **Subsearches are intentionally untouched:** only the top-level `translateSearchExpr(ast.search, ir, true)` call passes `collectMetadata`. Do not pass it from the `NotSubsearch` / `TopLevelSubsearch` recursion, or a subsearch's `index=…` filter would be silently dropped.
- **After the whole feature**, run the full gate: `ASDF_NODEJS_VERSION=24.14.0 npm run test && npm run lint && npm run types:check`, and validate the new `FROM Log_<name>` / `FROM Log_a, Log_b` cases with the `validate-test-cases` skill before promoting any `verified` field above `false`.
