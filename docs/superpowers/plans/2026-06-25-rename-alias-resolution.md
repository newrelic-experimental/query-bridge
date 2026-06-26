# Rename & Alias Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a name introduced by `rename`/`stats … as`/`eval`/`convert`/`rex`/`spath`/`eventstats` survive into every downstream clause (SELECT, FACET, ORDER BY, WHERE) instead of being overwritten, emitted bare, or silently dropped.

**Architecture:** Add one alias registry to the IR (`ir._renameMap`) plus a small shared resolver module. Producers record bindings; consumers *resolve* a requested name (against existing `ir.select` items, then `_renameMap`) instead of overwriting/emitting-bare. The NRQL emitter already prints the faithful forms (`expr AS 'label'`, `FACET source AS 'label'`) — no emitter change except a self-referential-WITH guard.

**Tech Stack:** Pure ESM JavaScript, zero runtime deps, Vitest, Peggy parser. Spec: `docs/superpowers/specs/2026-06-25-rename-alias-resolution-design.md`.

## Global Constraints

- **Node 24 for all dev commands:** prefix every command with `ASDF_NODEJS_VERSION=24.14.0`.
- **Pure functions, no mocking:** the translator is string-in/object-out (`.claude/rules/project-testing.md`).
- **Loud failure over silent-wrong:** an untranslatable rename emits `unsupported`, never wrong NRQL.
- **All user-facing strings live in `packages/nr-query-bridge/src/messages.js`** — handlers call `messages.key()`; never inline a literal. Message-key consistency is enforced in `packages/nr-query-bridge/test/spl/spl.test.js` (there is no separate `messages.test.js`): every `warningFunc`/`unsupportedFunc` array entry is validated against `messages`, and the spy check asserts the arrays are exhaustive.
- **Test cases are data-driven** in `packages/nr-query-bridge/test/spl/spl.test.js` (`cases` array), `verified: false` until a human promotes; `warningFunc`/`unsupportedFunc` arrays must be **exhaustive**.
- **NRQL validation via `run_nerdgraph_query`** (5-minute windows on account 1), never `execute_nrql_query` (older grammar — see CLAUDE.md).
- **Conventional commits**, lowercase subject ≤72 chars. Commit with `ASDF_NODEJS_VERSION=24.14.0 git commit`. Do not commit unless the human asks per-step in execution.
- **SPL fact (verified):** `rename A as B` *rebinds* — downstream the field is `B`, `A` is gone. NRQL has no rename primitive, so we map `B`→source `A` and emit the relabel form. This is a target-language workaround, not "display-only SPL."

## Scope

This plan implements **Family A** (display-only resolution) and **Family C** (self-referential collision). **Family B** (rename across an aggregation boundary) is deferred to compose with the now-shipped compound-chain pass `packages/nr-query-bridge/src/ir/foldPostAggregation.js` (PR #44, merged; its invariants live in `.claude/rules/design-decisions.md` → "IR & Optimization"). Task 9 only records the seam and keeps the existing `unsupported`/subquery fallback. Tasks 1–6 (Family A core) are independent of the compound-chain work.

## File Structure

All paths are under the monorepo package `packages/nr-query-bridge/` (post-#44/#46 layout — there is no top-level `src/`).

- **Create** `packages/nr-query-bridge/src/input/spl/aliasResolution.js` — the shared resolver: `recordRename`, `resolveSelectField`, `resolveFacetField`, `freshAliasName` (Task 1), plus `pushBindingResolvingSelfRef` (added in Task 6). One responsibility: turn a requested name + the current IR into the right IR node. (Self-reference detection reuses the **existing** `exprReferencesField` from `splExprUtils.js`; do NOT add a duplicate helper.)
- **Modify** `packages/nr-query-bridge/src/ir/nodes.js` — add `_renameMap` to the `SelectQuery` factory.
- **Modify** `packages/nr-query-bridge/src/input/spl/rowHandlers.js` — `handleRename` (record), `handleTable`/`handleFields` (resolve), `handleSort` (resolve), `handleDedup` (resolve facet), `handleConvert`/`handleStrcat` (Family C guard).
- **Modify** `packages/nr-query-bridge/src/input/spl/aggregationHandlers.js` — FACET resolution (`handleStats` line 65; `handleTop`/`handleRare`).
- **Modify** `packages/nr-query-bridge/src/input/spl/evalHandlers.js` — Family C self-reference rewrite in the existing `exprReferencesField` branch of `translateEvalExpr`.
- **Modify** `packages/nr-query-bridge/src/input/spl/extractionHandlers.js` — `handleSpath` (Family C guard). (`handleRex` builds a *tuple*-named binding (`(a, b)`), which `exprReferencesField` cannot match — leave it unguarded; a rex self-reference is rare and the guard would be a no-op. `handleEventstats` builds **no** `Binding` — it emits a `SubqueryExpr` alias or a `JoinClause` — so Family C does not apply to it.)
- **Modify** `packages/nr-query-bridge/src/output/nrql/irToNrql.js` — self-referential-WITH guard.
- **Modify** `packages/nr-query-bridge/src/messages.js` — new/changed keys (key consistency is checked by `test/spl/spl.test.js`, not a separate `messages.test.js`).
- **Modify** `packages/nr-query-bridge/test/spl/spl.test.js` — data-driven cases (clean-room + matrix sets).

---

### Task 1: Add `_renameMap` to the IR and the resolver module

**Files:**
- Modify: `packages/nr-query-bridge/src/ir/nodes.js:93-122` (`SelectQuery` factory)
- Create: `packages/nr-query-bridge/src/input/spl/aliasResolution.js`
- Test: `packages/nr-query-bridge/test/spl/aliasResolution.test.js` (the repo tests input/spl handlers under `test/spl/`, not a mirrored `test/input/spl/`)

**Interfaces:**
- Produces:
  - `recordRename(ir, from, to)` → mutates `ir._renameMap[to] = from` (string→string; `from` is the source attribute name, `to` the new name).
  - `resolveSelectField(name, ir)` → returns an IR node **or `null`**: `null` when `name` is a current FACET key (FACET re-supplies it — must be dropped from SELECT, never emitted as a bare event field alongside an aggregation); an existing `ir.select` `Alias`/aggregate whose `name === name` (preserved); else `Alias(Identifier(from), name)` when `name` is in `_renameMap`; else `Identifier(name)`.
  - `resolveFacetField(name, ir)` → `Alias(Identifier(from), name)` when renamed, else `Identifier(name)`.
  - `freshAliasName(base, existingNames)` → deterministic fresh name (`base + '__r1'`, `__r2`, …) not in `existingNames`.
- Consumes: `exprReferencesField` from `splExprUtils.js` (existing — used by Tasks 6/8 for self-reference detection; this module does not redefine it).

- [ ] **Step 1: Write the failing test**

```javascript
// packages/nr-query-bridge/test/spl/aliasResolution.test.js
import { describe, it, expect } from 'vitest';
import {
  recordRename, resolveSelectField, resolveFacetField, freshAliasName,
} from '../../src/input/spl/aliasResolution.js';
import { SelectQuery } from '../../src/ir/nodes.js';
import { Identifier, Alias, Func } from '../../src/ir/nodes.js';

describe('aliasResolution', () => {
  it('records a rename into _renameMap', () => {
    const ir = SelectQuery();
    recordRename(ir, 'event.ServiceName', 'Policy Type');
    expect(ir._renameMap).toEqual({ 'Policy Type': 'event.ServiceName' });
  });

  it('resolveSelectField returns Alias(source, name) for a renamed name', () => {
    const ir = SelectQuery({ _renameMap: { 'Policy Type': 'event.ServiceName' } });
    expect(resolveSelectField('Policy Type', ir)).toEqual(
      Alias(Identifier('event.ServiceName'), 'Policy Type'),
    );
  });

  it('resolveSelectField preserves an existing stats aggregate alias', () => {
    const agg = Alias(Func('uniqueCount', [Identifier('host')]), 'cnt');
    const ir = SelectQuery({ select: [agg] });
    expect(resolveSelectField('cnt', ir)).toBe(agg);
  });

  it('resolveSelectField returns a bare Identifier for an unknown name', () => {
    const ir = SelectQuery();
    expect(resolveSelectField('host', ir)).toEqual(Identifier('host'));
  });

  it('resolveSelectField drops a name that is a FACET key (FACET re-supplies it)', () => {
    const ir = SelectQuery({ select: [Alias(Func('count', []), 'cnt')], facet: [Identifier('host')] });
    expect(resolveSelectField('host', ir)).toBe(null);
    expect(resolveSelectField('cnt', ir)).toEqual(Alias(Func('count', []), 'cnt'));
  });

  it('resolveFacetField relabels a renamed facet key', () => {
    const ir = SelectQuery({ _renameMap: { Server: 'host' } });
    expect(resolveFacetField('Server', ir)).toEqual(Alias(Identifier('host'), 'Server'));
  });

  it('freshAliasName avoids collisions deterministically', () => {
    expect(freshAliasName('total_MB', new Set(['total_MB']))).toBe('total_MB__r1');
    expect(freshAliasName('total_MB', new Set(['total_MB', 'total_MB__r1']))).toBe('total_MB__r2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- aliasResolution`
Expected: FAIL — `aliasResolution.js` does not exist.

- [ ] **Step 3: Add `_renameMap` to the IR factory**

In `packages/nr-query-bridge/src/ir/nodes.js`, inside the `SelectQuery` factory (after `_timeBucketAliases` at line 119, immediately before `...overrides`), add:

```javascript
  /** @type {Object<string,string>|undefined} internal: rename alias→source-attr map (display rebinds; NRQL has no rename primitive) */
  _renameMap: undefined,
```

- [ ] **Step 4: Implement the resolver module**

```javascript
// packages/nr-query-bridge/src/input/spl/aliasResolution.js
import { Identifier, Alias } from '../../ir/nodes.js';

/** Record a `rename from as to`: a downstream reference to `to` resolves to source `from`. */
export function recordRename(ir, from, to) {
  ir._renameMap = ir._renameMap || {};
  ir._renameMap[to] = from;
}

/** A FACET entry exposes a name: an Identifier's `name`, or an `AS label` Alias's `name`. */
function facetKeyNames(ir) {
  return (ir.facet || []).map((f) => f.name).filter(Boolean);
}

/**
 * Resolve a requested SELECT/projection field to the right IR node, or `null`
 * when the name is a current FACET key (FACET re-supplies it; emitting it as a
 * bare event field alongside an aggregation is invalid NRQL — "FACET cannot be
 * used when selecting on event fields").
 */
export function resolveSelectField(name, ir) {
  if (facetKeyNames(ir).includes(name)) return null; // dropped — FACET supplies it
  const existing = (ir.select || []).find(
    (s) => s.type === 'Alias' && s.name === name,
  );
  if (existing) return existing;
  if (ir._renameMap && name in ir._renameMap) {
    return Alias(Identifier(ir._renameMap[name]), name);
  }
  return Identifier(name);
}

/** Resolve a requested FACET key: relabel a rename to `source AS 'name'`, else bare. */
export function resolveFacetField(name, ir) {
  if (ir._renameMap && name in ir._renameMap) {
    return Alias(Identifier(ir._renameMap[name]), name);
  }
  return Identifier(name);
}

/** Deterministic fresh name not in `existingNames` (a Set of strings). */
export function freshAliasName(base, existingNames) {
  let i = 1;
  while (existingNames.has(`${base}__r${i}`)) i += 1;
  return `${base}__r${i}`;
}
```

(Self-reference detection — "does `expr` reference an Identifier named `X`?" — is **not** added here; Tasks 6 and 8 use the existing `exprReferencesField(expr, fieldName)` from `splExprUtils.js`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- aliasResolution`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/nr-query-bridge/src/ir/nodes.js packages/nr-query-bridge/src/input/spl/aliasResolution.js packages/nr-query-bridge/test/spl/aliasResolution.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: add ir._renameMap and alias resolution helpers"
```

---

### Task 2: `handleRename` records the rename into `_renameMap`

**Files:**
- Modify: `packages/nr-query-bridge/src/input/spl/rowHandlers.js:65-92` (`handleRename`)
- Test: `packages/nr-query-bridge/test/spl/spl.test.js` (cases array)

**Interfaces:**
- Consumes: `recordRename` (Task 1).
- Produces: after a `rename A as B` on a row attribute, `ir._renameMap['B'] === 'A'`.

The current `handleRename` keeps emitting its `Alias` + `Wildcard` (so a bare `rename` with no downstream projection still emits `SELECT A AS 'B', *` — the existing guard behavior). This task ONLY adds the map recording in the plain-attribute branch (not the fold-into-existing-alias branch, which is a post-aggregation relabel handled by Family B).

- [ ] **Step 1: Write the failing test** — add to the `cases` array in `packages/nr-query-bridge/test/spl/spl.test.js`:

```javascript
{
  spl: 'index=web | rename event.ServiceName as "Policy Type"',
  nrql: "FROM Log SELECT `event.ServiceName` AS 'Policy Type', * WHERE index = 'web'",
  warningFunc: ['rename_keeps_original'],
  verified: false,
},
```

(This guard already passes; the regression proof comes in Task 3. This case locks that bare rename is unchanged after we add map recording.)

- [ ] **Step 2: Run to verify current behavior**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: PASS (bare rename already emits this).

- [ ] **Step 3: Add the import and the `recordRename` call**

In `packages/nr-query-bridge/src/input/spl/rowHandlers.js`, add to the existing import from `./aliasResolution.js` (create the import line if absent):

```javascript
import { recordRename } from './aliasResolution.js';
```

(Task 3 extends this same import with `resolveSelectField`; keep Task 2's import to just `recordRename` so the intermediate commit has no unused import — the pre-push lint gate would reject it.)

In `handleRename`, in the `else` branch (the plain-attribute rename, where `existingIdx < 0`), after the `ir.select.push(...)` line, add:

```javascript
      recordRename(ir, mapFieldName(rename.from), rename.to);
```

- [ ] **Step 4: Run to verify still green**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: PASS (no output change; the map is internal).

- [ ] **Step 5: Commit**

```bash
git add packages/nr-query-bridge/src/input/spl/rowHandlers.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: record rename bindings into ir._renameMap"
```

---

### Task 3: `handleTable`/`handleFields` resolve instead of overwrite (CONFIRMED-7 A+B)

**Files:**
- Modify: `packages/nr-query-bridge/src/input/spl/rowHandlers.js:20-32` (`handleTable`, `handleFields`)
- Test: `packages/nr-query-bridge/test/spl/spl.test.js`

**Interfaces:**
- Consumes: `resolveSelectField` (Task 1), `recordRename` output (Task 2).

- [ ] **Step 1: Write the failing tests** — add to `cases`:

```javascript
// Symptom A — rename alias resolved through to source (was: bare `Policy Type` → null)
{
  spl: 'index=web | rename event.ServiceName as "Policy Type" | table _time, "Policy Type", message',
  nrql: "FROM Log SELECT timestamp, `event.ServiceName` AS 'Policy Type', message WHERE index = 'web'",
  verified: false,
},
// Symptom B — post-stats fields keeps the aggregate AND drops the facet key from
// SELECT (was: bare `host, cnt` → "FACET cannot be used when selecting on event
// fields"). `host` is a FACET key, so resolveSelectField returns null for it and
// the handler omits it; FACET re-supplies it.
{
  spl: 'index=web | stats count as cnt by host | fields host, cnt',
  nrql: "FROM Log SELECT count(*) AS 'cnt' WHERE index = 'web' FACET host",
  verified: false,
},
```

(Confirm the exact emitted strings by running, then verify via `run_nerdgraph_query` — the `cnt` alias quoting and the `host` drop must match real output.)

- [ ] **Step 2: Run to verify they fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: FAIL — current output emits bare `` `Policy Type` `` and bare `cnt` (the overwrite bug).

- [ ] **Step 3: Replace the overwrite with resolution**

In `packages/nr-query-bridge/src/input/spl/rowHandlers.js`, change `handleTable`:

```javascript
export function handleTable(cmd, ir) {
  ir.select = cmd.fields
    .map((f) => resolveSelectField(mapFieldName(f), ir))
    .filter((n) => n !== null); // drop FACET keys — FACET re-supplies them (justified null)
}
```

and the `else` branch of `handleFields`:

```javascript
    ir.select = cmd.fields
      .map((f) => resolveSelectField(mapFieldName(f), ir))
      .filter((n) => n !== null); // drop FACET keys — FACET re-supplies them (justified null)
}
```

(`resolveSelectField` reads the *current* `ir.select`/`ir.facet` for each field before the reassignment, so a prior `rename` Alias or `stats` aggregate is found and preserved, and a facet key resolves to `null`; `.map` completes before the assignment takes effect. The explicit `!== null` filter — not `.filter(Boolean)` — is the sanctioned justified-null drop per `.claude/rules/type-strictness.md`.)

- [ ] **Step 4: Run to verify they pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: PASS (both new cases). Also confirm no prior `table`/`fields` cases regressed.

- [ ] **Step 5: Commit**

```bash
git add packages/nr-query-bridge/src/input/spl/rowHandlers.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "fix: resolve rename/stats aliases in table/fields instead of overwriting"
```

---

### Task 4: `handleSort` resolves a renamed sort key

**Files:**
- Modify: `packages/nr-query-bridge/src/input/spl/rowHandlers.js:34-49` (`handleSort`)
- Test: `packages/nr-query-bridge/test/spl/spl.test.js`

**Interfaces:**
- Consumes: `resolveFacetField`/`_renameMap` (Task 1). For ORDER BY the faithful emission is the *source attribute* bare (NRQL fact: a SELECT alias is also a valid ORDER BY key, but a renamed row attribute must point at the real attribute).

- [ ] **Step 1: Write the failing test** — add to `cases`:

```javascript
{
  spl: 'index=web | rename responseTime as rt | sort rt',
  nrql: "FROM Log SELECT responseTime AS 'rt', * WHERE index = 'web' ORDER BY responseTime ASC",
  warningFunc: ['rename_keeps_original'],
  verified: false,
},
```

(`responseTime` is a simple name — emitted **bare**, not backticked; `smartEscape` only backticks names with dots/dashes/spaces/colons/curlies. Confirm the exact string by running.)

- [ ] **Step 2: Run to verify it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: FAIL — current output emits `ORDER BY rt` (a non-existent attribute).

- [ ] **Step 3: Resolve the sort field**

In `packages/nr-query-bridge/src/input/spl/rowHandlers.js`, resolve the sort key through `ir._renameMap` inline (a renamed row attribute must order by its real source attribute; no new helper needed). Change `handleSort`:

```javascript
export function handleSort(cmd, ir) {
  if (cmd.fields.length > 0) {
    const first = cmd.fields[0];
    const name = ir._renameMap && first.field in ir._renameMap
      ? ir._renameMap[first.field]
      : first.field;
    ir.orderBy = OrderBy(Identifier(name), first.direction === 'desc');
  }
  // ... rest unchanged (sort_single_field warning, limit handling) ...
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nr-query-bridge/src/input/spl/rowHandlers.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "fix: resolve renamed sort key to its source attribute"
```

---

### Task 5: FACET resolves a renamed group-by key (`FACET source AS 'label'`)

**Files:**
- Modify: `packages/nr-query-bridge/src/input/spl/aggregationHandlers.js:65` (`handleStats` group-by `ir.facet = cmd.groupBy.map(Identifier)`); also `handleTop` (facet at `:119` assign + `:121` push) and `handleRare` (facet at `:138` assign + `:140` push)
- Modify: `packages/nr-query-bridge/src/input/spl/rowHandlers.js:99-112` (`handleDedup`; the facet push is `:101`)
- Test: `packages/nr-query-bridge/test/spl/spl.test.js`

**Interfaces:**
- Consumes: `resolveFacetField` (Task 1). Verified NRQL: `FROM Log SELECT count(*) FACET level AS 'Severity'` groups on the real attribute and relabels the column (acct 1, 2026-06-25).

- [ ] **Step 1: Write the failing test** — add to `cases`:

```javascript
{
  spl: 'index=web | rename host as Server | timechart count by Server',
  nrql: "FROM Log SELECT count(*) WHERE index = 'web' FACET host AS 'Server' TIMESERIES AUTO",
  warningFunc: ['rename_keeps_original', 'facet_default_limit'],
  verified: false,
},
```

(Confirm the exact `warningFunc` keys by running once; `facet_default_limit` is the existing FACET-limit warning key — match its real name in `packages/nr-query-bridge/src/messages.js`.)

- [ ] **Step 2: Run to verify it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: FAIL — current output emits bare `` FACET `Server` `` (groups on null).

- [ ] **Step 3: Resolve facet keys**

In `packages/nr-query-bridge/src/input/spl/aggregationHandlers.js`, import `resolveFacetField` from `./aliasResolution.js`, then change the group-by mapping (line 65) from:

```javascript
  ir.facet = cmd.groupBy.map(Identifier);
```

to:

```javascript
  ir.facet = cmd.groupBy.map((g) => resolveFacetField(g, ir));
```

Apply the identical swap at the `handleTop` facet ops (`cmd.fields.map(Identifier)` at `:119` and the `cmd.groupBy.map(Identifier)` push at `:121`), the `handleRare` facet ops (`[Identifier(cmd.field)]` at `:138` and the `cmd.groupBy.map(Identifier)` push at `:140`), and in `handleDedup` (`rowHandlers.js:101`) change `const id = Identifier(field);` to `const id = resolveFacetField(field, ir);`.

- [ ] **Step 4: Run to verify it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: PASS. Spot-check the emitted NRQL via `run_nerdgraph_query` (5-min window).

- [ ] **Step 5: Commit**

```bash
git add packages/nr-query-bridge/src/input/spl/aggregationHandlers.js packages/nr-query-bridge/src/input/spl/rowHandlers.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "fix: relabel renamed facet keys as source AS label"
```

---

### Task 6: Family C — self-referential reassignment aliases to a fresh name

**Files:**
- Modify: `packages/nr-query-bridge/src/input/spl/evalHandlers.js` — the **existing** self-reference branch in `translateEvalExpr` (`:155-158`, the `else if (exprReferencesField(expr, assignment.field))` arm that today does `ir.select.push(expr)`).
- Modify: `packages/nr-query-bridge/src/input/spl/rowHandlers.js` — `handleConvert` (`Binding` at `:222`/`:224`) and `handleStrcat` (`Binding` at `:264`).
- Modify: `packages/nr-query-bridge/src/input/spl/extractionHandlers.js` — `handleSpath` (`Binding` at `:89-94`).
- Test: `packages/nr-query-bridge/test/spl/spl.test.js`

**Interfaces:**
- Consumes: `freshAliasName` (Task 1); the **existing** `exprReferencesField(expr, fieldName)` from `splExprUtils.js`; the `_fieldReplacements` mechanism (plain object string→IRNode, pattern at `rowHandlers.js:245-246`, applied by `optimize.js:applyFieldReplacements`).
- Verified NRQL (acct 1, 2026-06-25): `WITH X AS <expr referencing X>` → `Circular dependency` error; `WITH <expr not referencing X> AS X` compiles and shadows `X`. So only the self-referential shape needs rewriting.
- **Important — the eval path is NOT a `Binding` site for self-refs.** `translateEvalExpr` already routes `eval X = f(X)` to `else if (exprReferencesField(expr, assignment.field))` → `ir.select.push(expr)` (the silent-drop: the bare expr lands in SELECT with no `X` name, so a following `table … X` loses it). The fix **rewrites that existing branch**; it does not add a guard around the `else { ir.bindings.push(...) }` arm (self-refs never reach it).
- `handleEventstats` is **excluded**: it builds a `SubqueryExpr` alias / `JoinClause`, not a `Binding`, so the circular-WITH hazard cannot arise there. `handleRex` is **excluded**: its binding name is a tuple (`(a, b)`), which `exprReferencesField` cannot match — a rex self-ref guard would be a permanent no-op.

- [ ] **Step 1: Write the failing tests** — add to `cases`:

```javascript
// self-referential reassign — must alias to a fresh name + rewrite downstream.
// The downstream `total_MB` is rewritten to the fresh binding name via
// `_fieldReplacements` (the existing optimizer pass — applies uniformly to
// select/where/facet/orderBy), so the output column is the bare fresh name
// `total_MB__r1` (value-faithful). A cosmetic relabel back to `total_MB`
// (`total_MB__r1 AS 'total_MB'`) is valid NRQL — VERIFIED on staging acct
// 10671289, 2026-06-26: `WITH concat(level,'_x') AS level__r1 SELECT
// hostname, level__r1 AS 'level'` returns a column named `level` — but it is
// deferred: a relabel is select-only, whereas `_fieldReplacements` must also
// rewrite where/facet/orderBy references, where a bare name is required.
{
  spl: 'index=app | eval total_MB = round(total_MB/1024, 2) | table host, total_MB',
  nrql: "FROM Log WITH round(numeric(total_MB) / 1024, 0.01) AS total_MB__r1 SELECT host, total_MB__r1 WHERE index = 'app'",
  verified: false,
},
// GUARD: a NEW name needs no rewrite (must stay unchanged)
{
  spl: 'index=app | eval mb = round(total_MB/1024, 2) | table host, mb',
  nrql: "FROM Log WITH round(numeric(total_MB) / 1024, 0.01) AS mb SELECT host, mb WHERE index = 'app'",
  verified: false,
},
// GUARD: chained DISTINCT names forward-reference fine (must stay unchanged)
{
  spl: 'index=storage | eval a = src_GB, b = a/1024, c = b/1024 | table a, b, c',
  nrql: "FROM Log WITH src_GB AS a, numeric(a) / 1024 AS b, numeric(b) / 1024 AS c SELECT a, b, c WHERE index = 'storage'",
  verified: false,
},
```

(The exact emitted form of the rewritten case — the fresh-name backticking and the `AS 'total_MB'` re-label — must be confirmed by running; adjust the `nrql` string to the real output, then verify that output compiles via `run_nerdgraph_query`.)

- [ ] **Step 2: Run to verify the self-ref case fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: FAIL on case 1 (today the self-ref `expr` is inlined bare into SELECT with no `total_MB` name, then `table` overwrites SELECT and the transform is lost); the two guards already pass.

- [ ] **Step 3a: Add a shared `pushBindingResolvingSelfRef` helper to `aliasResolution.js`**

This is the one place the self-reference fix lives; all four call sites delegate to it. Add to `packages/nr-query-bridge/src/input/spl/aliasResolution.js` (extend the imports):

```javascript
import { Identifier, Alias, Binding } from '../../ir/nodes.js';
import { exprReferencesField } from './splExprUtils.js';

/**
 * Push a `WITH name AS expr` binding, rewriting a self-referential reassignment
 * (`eval X = f(X)`, `convert num(x) as x`, …) to a fresh name + a downstream
 * field-replacement. NRQL WITH rejects a circular binding (`WITH X AS …X…`);
 * a fresh alias plus `_fieldReplacements[name] → fresh` preserves the transform.
 */
export function pushBindingResolvingSelfRef(ir, name, expr) {
  if (exprReferencesField(expr, name)) {
    const known = new Set([
      ...ir.bindings.map((b) => b.name),
      ...ir.select.filter((s) => s.type === 'Alias').map((s) => s.name),
    ]);
    const fresh = freshAliasName(name, known);
    ir.bindings.push(Binding(fresh, expr));
    ir._fieldReplacements = ir._fieldReplacements || {};
    ir._fieldReplacements[name] = Identifier(fresh);
  } else {
    ir.bindings.push(Binding(name, expr));
  }
}
```

(Guard against an import cycle: `splExprUtils.js` is a leaf util — `aliasResolution.js` may import from it freely, the same way `rowHandlers.js`/`evalHandlers.js` already do. Run `ASDF_NODEJS_VERSION=24.14.0 npm run test -- aliasResolution` to confirm the module still loads.)

- [ ] **Step 3b: Replace the eval self-reference branch**

In `packages/nr-query-bridge/src/input/spl/evalHandlers.js`, `translateEvalExpr` currently has (lines ~154-161):

```javascript
        if (projectToSelect) {
          // ... nonScalar guard ...
          ir.select.push(Alias(expr, assignment.field));
        } else if (exprReferencesField(expr, assignment.field)) {
          // NRQL WITH clause can't alias to a field that the expression references
          // (circular dependency). In that case, inline into SELECT instead.
          ir.select.push(expr);
        } else {
          ir.bindings.push(Binding(assignment.field, expr));
        }
```

Collapse the `else if`/`else` into the shared helper (the helper subsumes both — self-ref → fresh name, otherwise plain binding):

```javascript
        if (projectToSelect) {
          // ... nonScalar guard unchanged ...
          ir.select.push(Alias(expr, assignment.field));
        } else {
          pushBindingResolvingSelfRef(ir, assignment.field, expr);
        }
```

Add `import { pushBindingResolvingSelfRef } from './aliasResolution.js';` to `evalHandlers.js`. (`exprReferencesField` stays imported — it is still used by the `nonScalarNames` guard at `:148`.)

- [ ] **Step 3c: Route the other three `Binding` sites through the helper**

Each currently does `ir.bindings.push(Binding(<name>, <expr>))`; replace with `pushBindingResolvingSelfRef(ir, <name>, <expr>)` and import it:

- `handleConvert` (`rowHandlers.js:222`/`:224`): both the `alias` and `outputName` branches — `pushBindingResolvingSelfRef(ir, alias, expr)` / `(ir, outputName, expr)`. (Covers `convert num(x) as x`.)
- `handleStrcat` (`rowHandlers.js:264`): `pushBindingResolvingSelfRef(ir, destField, Func('concat', concatArgs))`.
- `handleSpath` (`extractionHandlers.js:89-94`): `pushBindingResolvingSelfRef(ir, output, Func('jparse', [Identifier(input), Literal(jsonPath, 'string')]))`. (Covers `spath input=data output=data …`.)

Do NOT touch `handleRex` (tuple binding name — helper is a no-op there) or `handleEventstats` (no `Binding`).

- [ ] **Step 4: Run to verify pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: PASS (case 1 rewritten; guards unchanged). Verify the rewritten NRQL compiles via `run_nerdgraph_query`.

- [ ] **Step 5: Commit**

```bash
git add packages/nr-query-bridge/src/input/spl/aliasResolution.js packages/nr-query-bridge/src/input/spl/evalHandlers.js packages/nr-query-bridge/src/input/spl/rowHandlers.js packages/nr-query-bridge/src/input/spl/extractionHandlers.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "fix: alias self-referential reassignment to a fresh name"
```

---

### Task 7: Fix the backwards `rename_keeps_original` warning

**Files:**
- Modify: `packages/nr-query-bridge/src/input/spl/rowHandlers.js` (`handleRename`), `packages/nr-query-bridge/src/messages.js`
- Test: `packages/nr-query-bridge/test/spl/spl.test.js` (also where message-key consistency is enforced)

The warning currently fires only on the `!ir._hasAggregation` keep-original path (where the alias IS kept). It should instead signal a genuinely-dropped/unresolvable rename. Decide during implementation whether the post-resolution paths still need any warning at all (Tasks 3–5 now resolve them, so the lossy case is rarer).

- [ ] **Step 1:** Add/rename a message key in `packages/nr-query-bridge/src/messages.js` for an unresolvable rename. (No separate `messages.test.js` to update — `test/spl/spl.test.js` validates any new key the moment a case lists it in `warningFunc`/`unsupportedFunc`.)
- [ ] **Step 2:** Update `handleRename` so the warning fires only when a rename cannot be resolved by any downstream consumer (i.e. it would otherwise be dropped). Run `ASDF_NODEJS_VERSION=24.14.0 npm run test -- messages` and `-- spl.test`; update the `warningFunc` arrays of any case whose warning set changed (they must stay exhaustive).
- [ ] **Step 3: Commit** `fix: fire rename warning on dropped renames, not resolved ones`.

---

### Task 8: Emitter guard against a self-referential WITH binding

**Files:**
- Modify: `packages/nr-query-bridge/src/output/nrql/irToNrql.js:260-273` (WITH bindings loop)
- Test: `packages/nr-query-bridge/test/output/irToNrql.test.js` (emitter unit test)

A `WITH` binding whose name appears in its own expression would emit NRQL that fails NRDB's circular-dependency check. By the time the IR reaches the emitter, Task 6 should have rewritten it; a surviving self-reference is a translator bug. Add a guard that surfaces a loud `unsupported`/throw rather than emitting the broken NRQL.

- [ ] **Step 1:** Write an emitter test: an IR with `bindings: [Binding('x', <expr referencing x>)]` produces an `unsupported` (or throws a clear translator-bug error), not a `WITH x AS …x…` string. (Confirm how the emitter currently surfaces failures — whether it can push to `q.unsupported` or must throw — and match that mechanism.)
- [ ] **Step 2:** Run to verify it fails. **Step 3:** In the bindings loop (`:261`), reuse the existing `exprReferencesField(b.expr, b.name)` from `splExprUtils.js` (NOT a new helper) to detect the self-reference and surface the loud failure. **Step 4:** Run to verify pass. **Step 5: Commit** `fix: guard emitter against self-referential WITH bindings`.

---

### Task 9: Family B seam + validation (no new translation behavior)

**Files:** none changed (documentation + corpus check only).

Family B (rename after an aggregation) stays on the existing `unsupported`/subquery path. The compound-chain pass it must compose with has **already landed** (`foldPostAggregation.js`, PR #44), so the seam is concrete, not hypothetical. This task records the integration contract and runs the corpus diff.

- [ ] **Step 1:** Record (no code change) the Family-B integration contract: when Family B is built, `foldPostAggregation` (`packages/nr-query-bridge/src/ir/foldPostAggregation.js`) — which already walks the over-nested `SubquerySource` chain and projects/renames on the outer — must read `ir._renameMap` so a trailing `rename Y as Z` (Y = an inner-exposed stats alias) becomes `SELECT Y AS 'Z'` on the outer via `resolveSelectField`. `handleRename` is not in that pass's edit set, so `_renameMap` population (Task 2) already survives. Add a cross-reference in `.claude/rules/design-decisions.md` under the fold-pass bullet.
- [ ] **Step 2: Corpus baseline diff.** From the private sibling repo `nr-query-bridge-corpus`, snapshot per-query verdicts with `corpus-diagnostic.mjs` before this plan's first commit and after Task 8; diff verdicts by query (counts/verdicts only — never copy query text into this repo). Confirm the only changes are the rename/alias cases moving from wrong→correct (or →`unsupported`), with no regressions. **Note:** PR #44 flagged that `corpus-diagnostic.mjs` still imports a stale pre-monorepo path; fix the harness import to `packages/nr-query-bridge/...` first (in the sibling repo) or the diagnostic won't run.
- [ ] **Step 3:** Run the full suite once: `ASDF_NODEJS_VERSION=24.14.0 npm test`. Expected: green.

## Test sourcing note

The case set for Tasks 2–6 is the union of (1) the clean-room behavioral set generated from the spec with no code visibility, (2) the CONFIRMED-7 (A+B) and CONFIRMED-15 rows in `nr-query-bridge-corpus/TEST_MATRIX.md` (including the new-name and chained-distinct-name guards), and (3) the FACET-relabel / ORDER-BY-alias rows — with duplicates collapsed. Every regression case must FAIL on HEAD before its fix and PASS after; every guard case must pass throughout.
