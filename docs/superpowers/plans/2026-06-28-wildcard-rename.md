# Wildcard rename (`rename a.* as *`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `rename <prefix>.* as *` (and, in a follow-on PR, `rename * as <prefix>_*`) from the single largest placeholder bucket into a faithful translation: rewrite eligible downstream bare field references through the prefix instead of throwing away the whole panel — but *only* when the rewrite is provably safe (Option C, conservative). Every ambiguous or non-single-affix shape stays a loud `unsupported`.

**Architecture:** A new pure module `src/input/spl/wildcardRename.js` recognizes a clean single-affix wildcard rename (`recognizeWildcardRename`) and snapshots the names referenced before the rename (`collectRefs`). `handleRename` records a `ir._wildcardRenames` marker instead of unconditionally emitting `unsupported`. A post-pipeline pass `applyWildcardRenames(ir)` (called in the `splToIR` post-loop, alongside the other pipeline-level detections) classifies each *downstream* bare reference and registers `<bare> → <prefix>.<bare>` into the **existing** `ir._fieldReplacements` map — which the existing `applyFieldReplacements` optimizer pass then substitutes across select/where/facet/orderBy. Guards (multiple wildcard renames, an ambiguous reference that also existed before the rename, no eligible reference) are loud `unsupported`/drop-warning. No emitter change; no grammar change.

**Tech Stack:** Pure ESM JavaScript, zero runtime deps; IR factory in `src/ir/nodes.js`; `_fieldReplacements` + `applyFieldReplacements` in `src/ir/optimize.js`; message catalog in `src/messages.js`; Vitest + the data-driven `cases` array in `test/spl/spl.test.js`.

**Branch:** `feat/wildcard-rename` off `origin/master`. Spec: `docs/superpowers/specs/2026-06-27-wildcard-rename-design.md`.

## Global Constraints

- Dev requires **Node 24**: prefix every command `ASDF_NODEJS_VERSION=24.14.0` (hooks + commit need it).
- Run one package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- <filter>`. Root `npm test` chains `--workspaces` and aborts later packages on a failure — use the per-package form while iterating.
- Conventional commits, lowercase subject ≤72 chars, body lines ≤100. `git commit -F <file>` for multi-line bodies. `git push origin HEAD` (never bare, never to master).
- **Loud failure over silent-wrong:** an ambiguous or non-single-affix wildcard rename → `messages.*` `unsupported`, never a guessed rewrite. The conservative eligibility rule (rewrite a bare name **only** when it appears nowhere except downstream of the rename and is not otherwise bound) is the whole safety story — do not loosen it.
- Messages live in `src/messages.js`; handlers call `messages.key()` — **no inline strings**. There is **no separate `test/messages.test.js`**; `test/spl/spl.test.js` is the key enforcer — every `warningFunc`/`unsupportedFunc` entry is validated against `messages` (an undefined key fails the case) and the spy check asserts the arrays are **exhaustive** (list ALL fired keys).
- New/changed translations land at `verified: false` (only a human promotes to `'llm'`/`'human'`).
- **Test `spl` uses `*` as the leading term, byte-matched to `node bin/spl2nrql.js`.** A bare leading search term (e.g. `web_logs`) injects `WHERE message LIKE '%web_logs%'`; the spec's acceptance criteria use `web_logs` for readability but the tests must use `*` to avoid that noise. `eval x=f(...)` emits a `WITH f(...) AS x SELECT *` binding (not `SELECT f(...) AS x`).
- **`'loglines'`, not `'events'`**, in any prose/comments (NR reserves "event").
- **Fuzz ×20** before trusting a translator change (it reseeds each run; one green is a false-green): `for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done`.
- NRQL validation via `run_nerdgraph_query` (5-min windows, acct 1), never a lone `execute_nrql_query` verdict (older grammar — see CLAUDE.md). The emitted shapes here (`FACET \`log.level\``, `WHERE \`log.level\` = 'error'`) use only core constructs, so this is a spot-check, not a false-reject risk.

## Scope

This plan implements the two **clean single-affix** shapes as **separate PRs**: leading-prefix strip (`<prefix>.* as *`) first, then re-prefix (`* as <prefix>_*`). Genuinely messy shapes — mid-string (`a.*.b as *`), multiple `*`, or more than one wildcard rename in a pipeline — stay loud `unsupported` (the existing `rename_wildcard` path, unchanged). The Family-A/C rename-alias work (`2026-06-25-rename-alias-resolution`) is a sibling effort on a different surface (`_renameMap`); this plan touches only `_fieldReplacements` + `handleRename`'s wildcard branch and does not depend on it.

## File Structure

All paths under `packages/nr-query-bridge/`.

- **Create** `src/input/spl/wildcardRename.js` — pure recognizer + ref-collector + the consumption pass: `recognizeWildcardRename(from, to)`, `collectRefs(ir)`, `applyWildcardRenames(ir)`. One responsibility: decide and register the prefix rewrite.
- **Create** `test/spl/wildcardRename.test.js` — explicit unit tests for `recognizeWildcardRename` + `collectRefs` (one scenario per `it()`, per project test-authoring style; NOT a fixture loop).
- **Modify** `src/ir/nodes.js` — add `_wildcardRenames` to the `SelectQuery` factory.
- **Modify** `src/input/spl/rowHandlers.js` — `handleRename` wildcard branch records the marker (Task 1) and stops emitting `unsupported` for the recognized shape (Task 2).
- **Modify** `src/input/spl/splToIR.js` — call `applyWildcardRenames(ir)` in the post-loop (Task 2).
- **Modify** `src/messages.js` — `wildcard_rename_ambiguous`, `wildcard_rename_multiple`, `wildcard_rename_dropped` (Task 2). `rename_wildcard` stays (non-single-affix shapes).
- **Modify** `test/spl/spl.test.js` — data-driven `cases`.

---

### Task 1 (PR 1): recognizer module + IR marker + inert marker recording

**Goal:** Recognize the prefix-strip shape and record a structured `ir._wildcardRenames` marker, while keeping the existing `rename_wildcard` `unsupported` output **unchanged** (inert — nothing consumes the marker yet).

**Files:**
- Create: `src/input/spl/wildcardRename.js`
- Test: `test/spl/wildcardRename.test.js`
- Modify: `src/ir/nodes.js` (`SelectQuery` factory), `src/input/spl/rowHandlers.js` (`handleRename`)

**Interfaces:**
- `recognizeWildcardRename(from: string, to: string) → { direction: 'strip', affix: string } | null`. `affix` is the prefix including its separator (`'log.'` from `'log.*'`). Returns `null` for any non-single-affix-strip shape (caller keeps `rename_wildcard`). (The `'reprefix'` direction is added in Task 3.)
- `collectRefs(ir) → Set<string>` — every Identifier name referenced in `ir.select`/`where`/`facet`/`orderBy`/`bindings[].expr`, not crossing into subqueries.

- [ ] **Step 1: Write the failing unit tests** in `test/spl/wildcardRename.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import {
  recognizeWildcardRename,
  collectRefs,
} from '../../src/input/spl/wildcardRename.js';
import { SelectQuery, Identifier, Alias, Func, BinOp, Literal } from '../../src/ir/nodes.js';

describe('recognizeWildcardRename', () => {
  it('recognizes a leading-prefix strip and returns the dotted affix', () => {
    expect(recognizeWildcardRename('log.*', '*')).toEqual({ direction: 'strip', affix: 'log.' });
  });
  it('recognizes a deeper-prefix strip', () => {
    expect(recognizeWildcardRename('meta.annotations.*', '*')).toEqual({
      direction: 'strip',
      affix: 'meta.annotations.',
    });
  });
  it('rejects a mid-string wildcard (a.*.b as *)', () => {
    expect(recognizeWildcardRename('a.*.b', '*')).toBe(null);
  });
  it('rejects multiple wildcards in the source', () => {
    expect(recognizeWildcardRename('a.*.*', '*')).toBe(null);
  });
  it('rejects a bare * as * (nothing to strip)', () => {
    expect(recognizeWildcardRename('*', '*')).toBe(null);
  });
  it('rejects the re-prefix shape in Task 1 (added in Task 3)', () => {
    expect(recognizeWildcardRename('*', 'fld_*')).toBe(null);
  });
});

describe('collectRefs', () => {
  it('collects identifier names from select/where/facet', () => {
    const ir = SelectQuery({
      select: [Func('count', [])],
      where: [BinOp('=', Identifier('status'), Literal('500', 'string'))],
      facet: [Identifier('host')],
    });
    expect(collectRefs(ir)).toEqual(new Set(['status', 'host']));
  });
  it('collects from binding expressions but not the alias name itself', () => {
    const ir = SelectQuery({ bindings: [{ name: 'lvl', expr: Func('upper', [Identifier('severity')]) }] });
    expect(collectRefs(ir)).toEqual(new Set(['severity'])); // 'lvl' is a binding NAME, not a ref
  });
  it('returns an empty set for a bare query', () => {
    expect(collectRefs(SelectQuery())).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- wildcardRename`
  Expected: FAIL — module missing.

- [ ] **Step 3: Implement** `src/input/spl/wildcardRename.js`:

```javascript
/**
 * Wildcard rename (`rename <prefix>.* as *`) → scoped prefix rewrite (Option C).
 *
 * NRQL has no bulk-rename and the translator has no schema context, so a faithful
 * expansion is impossible. Instead we treat a clean single-affix wildcard rename as
 * a downstream field-replacement rule and register it into ir._fieldReplacements,
 * but ONLY for bare references that are provably safe to rewrite (see
 * applyWildcardRenames). Anything ambiguous stays a loud `unsupported`.
 */

/**
 * Recognize a clean single-affix wildcard rename.
 * @param {string} from
 * @param {string} to
 * @returns {{ direction: 'strip', affix: string } | null}
 */
export function recognizeWildcardRename(from, to) {
  const fromStars = (from.match(/\*/g) || []).length;
  // Leading-prefix strip: `<affix>.* as *` — one trailing `*` in `from`, `to` is exactly `*`.
  if (to === '*' && fromStars === 1 && from.endsWith('*')) {
    const affix = from.slice(0, -1); // 'log.' from 'log.*'
    if (affix.length === 0) return null; // bare `* as *` — nothing to strip
    return { direction: 'strip', affix };
  }
  // (Task 3 adds the re-prefix shape `* as <affix>*` here.)
  return null;
}

/**
 * Every Identifier name referenced in the consumer surfaces, not crossing into
 * subqueries. Used both to snapshot pre-rename names (ambiguity guard) and to find
 * downstream candidates. Mirrors transform.js's enumerate-every-property walk.
 * @param {object} ir
 * @returns {Set<string>}
 */
export function collectRefs(ir) {
  const refs = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.type === 'Identifier') {
      refs.add(node.name);
      return;
    }
    if (node.type === 'SubqueryExpr' || node.type === 'SubquerySource') return;
    for (const key of Object.keys(node)) {
      if (key !== 'type') visit(node[key]);
    }
  };
  for (const s of ir.select) visit(s);
  for (const w of ir.where) visit(w);
  for (const f of ir.facet) visit(f);
  if (ir.orderBy) visit(ir.orderBy);
  for (const b of ir.bindings) visit(b.expr);
  return refs;
}
```

- [ ] **Step 4: Add `_wildcardRenames` to the IR factory.** In `src/ir/nodes.js`, inside `SelectQuery` (immediately after the `_timeBucketAliases` field at line 119, before `...overrides`):

```javascript
  /** @type {Array<{direction:string,affix:string,beforeNames:Set<string>}>|undefined} internal: pending wildcard-rename markers, consumed post-loop by applyWildcardRenames */
  _wildcardRenames: undefined,
```

- [ ] **Step 5: Record the marker in `handleRename`** (still emit the existing `unsupported` — inert). In `src/input/spl/rowHandlers.js`, add the import near the top:

```javascript
import { recognizeWildcardRename, collectRefs } from './wildcardRename.js';
```

Change the wildcard branch of `handleRename` (currently lines 68-71):

```javascript
    if (rename.from.includes('*') || rename.to.includes('*')) {
      const mark = recognizeWildcardRename(rename.from, rename.to);
      if (mark) {
        ir._wildcardRenames = ir._wildcardRenames || [];
        ir._wildcardRenames.push({ ...mark, beforeNames: collectRefs(ir) });
      }
      // PR 1: still emit the existing unsupported (inert) — PR 2 removes this for
      // the recognized shape and lets applyWildcardRenames consume the marker.
      ir.unsupported.push(messages.rename_wildcard(rename.from, rename.to));
      continue;
    }
```

- [ ] **Step 6: Add a behavior-lock `case`** to the `cases` array in `test/spl/spl.test.js` (the recognized shape STILL emits `unsupported` in PR 1 — the marker is internal):

```javascript
{
  // PR 1 inert: marker recorded internally, but output is unchanged (still unsupported).
  spl: '* | rename log.* as *',
  unsupportedFunc: ['rename_wildcard'],
  doc: 'fields-rename', verified: false,
},
```

(The existing `* | rename properties.* as *` human-verified case also still passes.)

- [ ] **Step 7: Run, confirm green** (both files). `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- wildcardRename spl.test`

- [ ] **Step 8: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/wildcardRename.js packages/nr-query-bridge/test/spl/wildcardRename.test.js packages/nr-query-bridge/src/ir/nodes.js packages/nr-query-bridge/src/input/spl/rowHandlers.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: recognize prefix-strip wildcard rename into an inert ir marker"
```

---

### Task 2 (PR 2): apply leading-prefix strip as scoped field replacement + guards

**Goal:** Consume the marker. Register `<bare> → <prefix>.<bare>` into `ir._fieldReplacements` for downstream bare references that appear nowhere except downstream and are not otherwise bound; add the loud guards; stop emitting `unsupported` for the recognized strip shape.

**Files:**
- Modify: `src/input/spl/wildcardRename.js` (add `applyWildcardRenames`), `src/input/spl/rowHandlers.js` (`handleRename`), `src/input/spl/splToIR.js` (post-loop call), `src/messages.js` (3 keys)
- Test: `test/spl/spl.test.js`

**Interfaces:**
- `applyWildcardRenames(ir) → void` — mutates `ir`: registers `ir._fieldReplacements[name] = Identifier(affix + name)` for each eligible name, OR pushes `ir.unsupported` (multiple-rename / ambiguous), OR pushes `ir.warnings` (no eligible reference → drop). Runs in the `splToIR` post-loop **before** the optimizer's `applyFieldReplacements` pass substitutes the map.
- Consumes: `collectRefs` (Task 1); `Identifier` from `src/ir/nodes.js`; `messages`.

- [ ] **Step 1: Add failing data-driven `cases`** to `test/spl/spl.test.js`. (Confirm every `nrql`/`warningFunc` byte-for-byte against `node bin/spl2nrql.js` in Step 6 — the strings below are the expected target, derived from the spec's acceptance criteria.)

```javascript
// prefix-strip: a downstream FACET key is rewritten through the prefix.
// `facet_default_limit` fires because FACET has no LIMIT (existing pipeline warning).
{
  spl: '* | rename log.* as * | stats count by level',
  nrql: 'FROM Log SELECT count(*) FACET `log.level`',
  warningFunc: ['facet_default_limit'],
  doc: 'wildcard-rename', verified: false,
},
// prefix-strip in WHERE.
{
  spl: '* | rename log.* as * | where level="error" | stats count',
  nrql: "FROM Log SELECT count(*) WHERE `log.level` = 'error'",
  doc: 'wildcard-rename', verified: false,
},
// no downstream reference → drop the rename with a warning (Option B safe sub-case).
{
  spl: '* | rename log.* as *',
  nrql: 'FROM Log SELECT *',
  warningFunc: ['wildcard_rename_dropped'],
  doc: 'wildcard-rename', verified: false,
},
// eval-bound name is NOT rewritten (and, being the only downstream ref, the rename
// drops). `flag` is a binding name, so it is skipped — it stays `flag`, not `log.flag`.
{
  spl: '* | rename log.* as * | eval flag = "high" | table flag',
  nrql: "FROM Log WITH 'high' AS flag SELECT flag",
  warningFunc: ['wildcard_rename_dropped'],
  doc: 'wildcard-rename', verified: false,
},
// ambiguity guard: `level` exists BEFORE the rename (pre-rename WHERE) AND after it
// (FACET) → cannot attribute it to the rename → loud unsupported.
{
  spl: '* | where level="x" | rename log.* as * | stats count by level',
  unsupportedFunc: ['wildcard_rename_ambiguous'],
  doc: 'wildcard-rename', verified: false,
},
// multiple wildcard renames → cannot attribute a bare name to one prefix → unsupported.
{
  spl: '* | rename log.* as * | rename app.* as * | stats count by level',
  unsupportedFunc: ['wildcard_rename_multiple'],
  doc: 'wildcard-rename', verified: false,
},
// non-single-affix shape stays the existing unsupported (unchanged).
{
  spl: '* | rename a.*.b as * | stats count by level',
  unsupportedFunc: ['rename_wildcard'],
  doc: 'wildcard-rename', verified: false,
},
```

Then **remove** the Task 1 inert lock case (`* | rename log.* as *` → `rename_wildcard`) — it is replaced by the drop-warning case above (that exact SPL now translates).

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
  Expected: FAIL — the strip cases still emit `rename_wildcard`; the new message keys don't exist yet.

- [ ] **Step 3: Add the messages** to `src/messages.js` (next to the existing rename keys, ~line 56-66):

```javascript
  // SPL: `* | where level=x | rename log.* as * | ... level ...` — `level` exists both
  // before and after the rename, so we can't tell the real field from the stripped form.
  wildcard_rename_ambiguous: (name) =>
    `Wildcard rename is ambiguous for "${name}": it is referenced both before and after the ` +
    'rename, so it cannot be safely attributed to the prefix. Rename the specific field instead.',

  // SPL: two `rename <prefix>.* as *` in one pipeline — competing prefixes.
  wildcard_rename_multiple: () =>
    'More than one wildcard rename in the pipeline; a bare field cannot be attributed to a ' +
    'single prefix. Rename the specific fields instead.',

  // SPL: `* | rename log.* as *` with no downstream reference — the rename is a no-op in NRQL.
  wildcard_rename_dropped: (affix) =>
    `Wildcard rename (${affix}* as *) dropped: no downstream field references it, so fields ` +
    'keep their original names.',
```

- [ ] **Step 4: Implement `applyWildcardRenames`** in `src/input/spl/wildcardRename.js`. Add imports at the top:

```javascript
import { Identifier } from '../../ir/nodes.js';
import { messages } from '../../messages.js';
```

Append:

```javascript
/**
 * Consume the ir._wildcardRenames markers (post-pipeline). For the strip shape,
 * register `<bare> → <affix><bare>` into ir._fieldReplacements for each downstream
 * bare reference that is eligible (appears nowhere except downstream, and is not a
 * binding/alias). Loud `unsupported` for >1 marker or an ambiguous (also-pre-rename)
 * reference; drop-with-warning when nothing eligible references the rename.
 * @param {object} ir
 */
export function applyWildcardRenames(ir) {
  const marks = ir._wildcardRenames;
  if (!marks || marks.length === 0) return;
  if (marks.length > 1) {
    ir.unsupported.push(messages.wildcard_rename_multiple());
    return;
  }
  const mark = marks[0];

  // Names bound by a real computed column — never rewritten (they are not the
  // stripped form of a wildcard-matched field).
  const bound = new Set();
  for (const s of ir.select) if (s.type === 'Alias') bound.add(s.name);
  for (const b of ir.bindings) bound.add(b.name);
  for (const f of ir.facet) if (f.type === 'Alias') bound.add(f.name);

  const downstream = collectRefs(ir);
  const candidates = [...downstream].filter((n) => isAffixCandidate(n, mark));

  // Ambiguity guard FIRST (bail before any partial rewrite): a candidate that also
  // existed before the rename could be a real top-level field as well as the stripped
  // form — never guess.
  for (const n of candidates) {
    if (!bound.has(n) && mark.beforeNames.has(n)) {
      ir.unsupported.push(messages.wildcard_rename_ambiguous(n));
      return;
    }
  }

  const replacements = {};
  for (const n of candidates) {
    if (bound.has(n)) continue; // a real computed column — leave as-is
    replacements[n] = Identifier(affixTarget(n, mark));
  }
  if (Object.keys(replacements).length === 0) {
    ir.warnings.push(messages.wildcard_rename_dropped(mark.affix));
    return;
  }
  ir._fieldReplacements = ir._fieldReplacements || {};
  Object.assign(ir._fieldReplacements, replacements);
}

/** strip: every bare name is a candidate. (Task 3 adds the reprefix predicate.) */
function isAffixCandidate(name, mark) {
  if (mark.direction === 'strip') return true;
  return false;
}

/** strip: `level` → `log.level`. (Task 3 adds the reprefix direction.) */
function affixTarget(name, mark) {
  return mark.affix + name; // 'log.' + 'level'
}
```

- [ ] **Step 5: Stop emitting `unsupported` for the recognized shape, and wire the post-loop call.**

In `src/input/spl/rowHandlers.js`, change the `handleRename` wildcard branch so a recognized marker no longer pushes `unsupported`:

```javascript
    if (rename.from.includes('*') || rename.to.includes('*')) {
      const mark = recognizeWildcardRename(rename.from, rename.to);
      if (mark) {
        ir._wildcardRenames = ir._wildcardRenames || [];
        ir._wildcardRenames.push({ ...mark, beforeNames: collectRefs(ir) });
        continue; // consumed post-loop by applyWildcardRenames
      }
      ir.unsupported.push(messages.rename_wildcard(rename.from, rename.to));
      continue;
    }
```

In `src/input/spl/splToIR.js`, add the import (with the other `./*Handlers`/util imports) and the post-loop call. Place the call **inside the post-loop, before** the FACET-default-limit warning so a dropped/ambiguous rename short-circuits cleanly; the registered `_fieldReplacements` is applied later by the optimizer. After the command loop (`for (const cmd of ast.commands)` ends at line 168), insert:

```javascript
  // Wildcard rename (`rename <prefix>.* as *`): register the prefix rewrite for
  // eligible downstream references, or emit a loud guard / drop-warning.
  applyWildcardRenames(ir);
```

Import line near the top of `splToIR.js`:

```javascript
import { applyWildcardRenames } from './wildcardRename.js';
```

(`applyWildcardRenames` must run *before* `optimize()` — it does, since `splToIR` returns `ir` and `optimize` is a later stage. The `_fieldReplacements` it registers is substituted by the existing `applyFieldReplacements` optimizer pass; the marker `_wildcardRenames` is left on the IR and harmlessly ignored by the emitter, like other internal `_`-fields.)

- [ ] **Step 6: Run, confirm green + byte-match the CLI.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`, then for each new positive case:

```bash
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | rename log.* as * | stats count by level'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | rename log.* as * | where level="error" | stats count'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | rename log.* as *'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | rename log.* as * | eval flag = "high" | table flag'
```

Fix the `nrql`/`warningFunc` strings to match the real output (especially the `log.level` backticking and whether `eval flag = "high"` emits `'high'` vs `"high"`). Then whole-package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge` (no regressions; non-single-affix renames still `rename_wildcard`).

- [ ] **Step 7: Staging-validate the two happy-path emitted queries** via `run_nerdgraph_query` (acct 1, 5-min window) — `FROM Log SELECT count(*) FACET \`log.level\`` and `FROM Log SELECT count(*) WHERE \`log.level\` = 'error'` execute without error (the rewrite produces only core NRQL; this is a sanity spot-check).

- [ ] **Step 8: Fuzz ×20.** `for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done`

- [ ] **Step 9: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/wildcardRename.js packages/nr-query-bridge/src/input/spl/rowHandlers.js packages/nr-query-bridge/src/input/spl/splToIR.js packages/nr-query-bridge/src/messages.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: translate prefix-strip wildcard rename via scoped field replacement"
```

---

### Task 3 (PR 3): re-prefix shape (`* as <prefix>_*`)

**Goal:** The inverse single-affix transform: `rename * as fld_*` records `<prefix>_<bare> → <bare>`, so a downstream `fld_level` resolves to its stored name `level`. Same eligibility + guards.

**Files:**
- Modify: `src/input/spl/wildcardRename.js` (extend `recognizeWildcardRename`, `isAffixCandidate`, `affixTarget`)
- Test: `test/spl/wildcardRename.test.js`, `test/spl/spl.test.js`

**Interfaces:** `recognizeWildcardRename` now also returns `{ direction: 'reprefix', affix }` for `* as <affix>*`. `applyWildcardRenames` is unchanged — only the two direction-switching helpers gain a reprefix branch.

- [ ] **Step 1: Add failing unit + behavior cases.** In `test/spl/wildcardRename.test.js`, replace the "rejects the re-prefix shape" test with:

```javascript
  it('recognizes the re-prefix shape', () => {
    expect(recognizeWildcardRename('*', 'fld_*')).toEqual({ direction: 'reprefix', affix: 'fld_' });
  });
  it('rejects a mid-string wildcard in the re-prefix target', () => {
    expect(recognizeWildcardRename('*', 'fld_*_x')).toBe(null);
  });
```

In `test/spl/spl.test.js`, add:

```javascript
// re-prefix: a downstream `fld_level` maps back to its stored name `level`.
{
  spl: '* | rename * as fld_* | stats count by fld_level',
  nrql: 'FROM Log SELECT count(*) FACET level',
  warningFunc: ['facet_default_limit'],
  doc: 'wildcard-rename', verified: false,
},
```

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- wildcardRename spl.test`

- [ ] **Step 3: Extend the recognizer** in `src/input/spl/wildcardRename.js` — add, before the final `return null` of `recognizeWildcardRename`:

```javascript
  // Re-prefix: `* as <affix>*` — `from` is exactly `*`, `to` has one trailing `*`.
  const toStars = (to.match(/\*/g) || []).length;
  if (from === '*' && toStars === 1 && to.endsWith('*')) {
    const affix = to.slice(0, -1); // 'fld_' from 'fld_*'
    if (affix.length === 0) return null; // bare `* as *`
    return { direction: 'reprefix', affix };
  }
```

And the two helpers:

```javascript
function isAffixCandidate(name, mark) {
  if (mark.direction === 'strip') return true; // every bare name maps
  return name.startsWith(mark.affix); // reprefix: only affixed names map back
}

function affixTarget(name, mark) {
  if (mark.direction === 'strip') return mark.affix + name; // level → log.level
  return name.slice(mark.affix.length); // fld_level → level
}
```

- [ ] **Step 4: Run, confirm green + CLI byte-match.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- wildcardRename spl.test`, then `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | rename * as fld_* | stats count by fld_level'` — confirm `FROM Log SELECT count(*) FACET level`. Whole package green. Fuzz ×20.

- [ ] **Step 5: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/wildcardRename.js packages/nr-query-bridge/test/spl/wildcardRename.test.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: translate re-prefix wildcard rename (* as prefix_*)"
```

---

### Task 4 (PR 4): graduate — invariant + laundry-list reclass + promote

**Goal:** Record the durable invariant, reclassify the laundry-list row, promote the staging-validated cases. Docs/test-metadata only.

**Files:**
- Modify: `.claude/rules/design-decisions.md` (add the invariant)
- Modify: `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` (reclassify the `wildcard-rename` row)
- Modify: `test/spl/spl.test.js` (`verified: false` → `'llm'` for the staging-validated positive cases)

- [ ] **Step 1: Promote** the staging-validated positive cases (the two strip cases from Task 2 Step 7 and the re-prefix case if validated) from `verified: false` to `verified: 'llm'`. Leave the guard/unsupported cases as `false` unless individually re-checked. (Only a human promotes to `'human'`.)

- [ ] **Step 2: Graduate the invariant** to `.claude/rules/design-decisions.md` under a new bullet in the "Messages & Pipeline" (or a new "Rename") section:

```markdown
- **Wildcard rename → scoped prefix rewrite (Option C, conservative)**: `rename <prefix>.* as *`
  (strip) and `rename * as <prefix>_*` (re-prefix) are recognized by `recognizeWildcardRename`
  (`src/input/spl/wildcardRename.js`) into an `ir._wildcardRenames` marker; the post-loop
  `applyWildcardRenames(ir)` registers `<bare> → <prefix>.<bare>` (strip) / `<prefix>_<bare> →
  <bare>` (re-prefix) into `ir._fieldReplacements` for downstream bare references **only when the
  name appears nowhere except downstream of the rename and is not otherwise bound** (a binding/
  alias name is left alone). Loud `unsupported`: a reference that also existed before the rename
  (`wildcard_rename_ambiguous`), more than one wildcard rename in the pipeline
  (`wildcard_rename_multiple`), or any non-single-affix shape — mid-string `a.*.b as *`, multiple
  `*` (the existing `rename_wildcard`). No downstream reference → drop with `wildcard_rename_dropped`.
  Reuses the existing `_fieldReplacements`/`applyFieldReplacements` machinery; no grammar change.
```

- [ ] **Step 3: Reclassify the laundry-list row.** In `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md`, change the `wildcard-rename` row from a GAP/placeholder to a shipped partial fix (clean single-affix strip + re-prefix now translate; messy shapes stay `unsupported`). **FLAG (see Double-check targets): this file is also edited by PR #72** — coordinate the edit (rebase onto #72 once it lands, or land this after #72) to avoid a conflicting row edit.

- [ ] **Step 4: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add .claude/rules/design-decisions.md docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: graduate wildcard-rename translation"
```

---

## Global Verification

- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm test` — full workspace suite green.
- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check` — clean (Prettier-clean; no `format:check` failures).
- [ ] No `npm run build:parsers` needed — no grammar change (the wildcard `*` is already parsed into `cmd.renames[].from/to`).
- [ ] Fuzz ×20 green (Task 2 / Task 3).
- [ ] (Optional, private repo) Re-measure the corpus placeholder delta with `dashboard-diagnostic.mjs` before/after — confirm `wildcard-rename` placeholders dropped with no regressions.
- [ ] Open the PRs (4 commits → 4 PRs in order); invoke `write-gooder` for each body (100–200 words, summary + test plan).

## Self-Review

1. **Spec coverage:** PR breakdown PR 1 (recognizer + inert marker) → Task 1 ✓; PR 2 (strip apply + guards + drop-warning) → Task 2 ✓; PR 3 (re-prefix) → Task 3 ✓; PR 4 (graduate + reclass) → Task 4 ✓. Acceptance criteria mapped: `stats count by level` strip ✓ (Task 2), `where level="error"` strip ✓, no-downstream-ref drop ✓, re-prefix `fld_*` ✓ (Task 3), mid-string `a.*.b` stays `unsupported` ✓, eval-bound name not rewritten ✓, collision/ambiguous → `unsupported` ✓.
2. **Loud-failure:** ambiguity, multiple renames, and non-single-affix all push `unsupported` (never a guessed rewrite); the conservative eligibility (nowhere-except-downstream + not-bound) is the only path to a rewrite.
3. **Type consistency:** `recognizeWildcardRename` returns `{direction, affix}|null`; `collectRefs` returns `Set<string>`; `_fieldReplacements[name] = Identifier(...)` matches the `{string → IRNode}` shape the existing `applyFieldReplacements` consumes (optimize.js:106 reads `map[node.name]` and returns the node).
4. **Message consistency:** three new keys (`wildcard_rename_ambiguous`, `wildcard_rename_multiple`, `wildcard_rename_dropped`) referenced in `cases` `warningFunc`/`unsupportedFunc`; `rename_wildcard` retained for messy shapes. No `messages.test.js` (this repo enforces keys via `spl.test.js`).
5. **Exhaustive arrays:** the strip success case lists `facet_default_limit` (fires on FACET-without-LIMIT — confirmed via CLI on HEAD); the WHERE case lists none; verify each array against the spy check in Step 6.

## Double-check targets (FLAGGED uncertainties — do NOT assume)

1. **`applyFieldReplacements` scoping claim is stale/inaccurate.** `design-decisions.md` says it "only replaces in select/where/facet/orderBy — NOT in bindings/expand/dataSource," but `transform.js`'s `SelectQuery` case **recurses into `bindings[].expr` and `dataSource`** (lines 87-95), and `applyFieldReplacements` uses plain `transformTree`. So a registered `{severity → log.severity}` **will** also rewrite an Identifier `severity` inside a `WITH … AS …` binding expression. For the strip shape this is usually *correct* (a downstream `eval x = upper(severity)` references the renamed field). **Verify the actual substitution surface before trusting the design-decisions bullet**, and confirm no binding-expression corruption in the eval-input cases (Task 2). If binding rewrite is unwanted, the consumption pass must register against a binding-aware exclusion — but current evidence says binding rewrite is desired here.
2. **Exact emitted NRQL strings are CLI-derived, not asserted from source.** All `nrql`/`warningFunc` values in the `cases` (especially `eval flag = "high"` → `'high'` vs `"high"`, and `log.level` backticking) **must be byte-matched against `node bin/spl2nrql.js`** in Task 2 Step 6 / Task 3 Step 4 and fixed there. The strings as written are the spec's expected target.
3. **Ambiguity-guard reliance on `beforeNames` alone.** The spec's "could plausibly be a real top-level field" is unknowable without schema; this plan operationalizes ambiguity as "the name also appears before the rename." A downstream field that is genuinely a real top-level field but appears *only* downstream will still be rewritten (the spec's accepted conservative trade-off). Confirm the SPL-expert agrees this matches `rename <prefix>.* as *` semantics (Splunk rebinds *all* matched fields, so a downstream-only bare name is, by SPL semantics, the stripped form).
4. **`collectRefs` duplicates `collectIdentifiers`** (foldPostAggregation.js:636, unexported). The plan writes a fresh local collector (project prefers explicit duplication over a forced shared import from an optimizer module into a handler-side module). If a reviewer prefers reuse, export `collectIdentifiers` and import it instead — behavior is identical.
5. **Laundry-list file edited by PR #72 (Task 4 Step 3).** `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` is touched by PR #72 (the 9-specs landing, task #85 — the GATE). Land this branch's PR 4 **after** #72, or rebase, to avoid a conflicting row edit.
6. **`mapFieldName` on the rewrite target.** The strip target is built as a literal `affix + name` (`'log.' + 'level'`). It is **not** passed through `mapFieldName` (the SPL→NR field map, e.g. `_time→timestamp`). This is almost certainly correct (a `log.*`-prefixed name is a customer attribute, not a Splunk special field), but confirm no corpus case needs `_time`-style mapping under a prefix.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-06-28-wildcard-rename.md`. Branch `feat/wildcard-rename` cuts off `master` **after PR #72 lands** (task #85 gate; it touches the shared laundry-list file). Run `/double-check` on this plan first (clean-room test set for `recognizeWildcardRename` eligibility + the four guard/drop paths), then execute task-by-task via subagent-driven-development. Resolve the Double-check targets (especially #1, the `applyFieldReplacements` scoping reality, and #2, CLI byte-matching) before promoting any case past `verified: false`.
