# `spath` without `path=` (auto-extract) → per-field `jparse` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When SPL `spath` with **no `path=`** (auto-extract-all) is followed by a small, confidently-enumerable set of downstream field references, bind each referenced field as `WITH jparse(<source>, '<field>') AS <field>` (Option B — the exact form `spath path=` already emits) so the panel survives. Refuse loudly (`unsupported`, the existing `spath_no_path`) for auto-extract-all / non-enumerable downstreams (`spath | table *`, `spath` as the last command, or any downstream shape we can't fully enumerate). Never emit a partial/guessed `jparse`.

**Architecture:** A pure, inert helper `collectAutoExtractFields(downstream) → string[] | null` (new file) scans the commands that follow the no-path `spath` and returns the bare field names to bind, or `null` when the auto-extract is not safely enumerable. The pipeline loop in `splToIR.js` computes it for a no-path `SpathCommand` and stashes it on the command (`cmd._autoExtractFields`); `handleSpath` consumes it — a non-empty list pushes one `jparse` binding per field, `null`/empty falls through to the existing loud `spath_no_path`. Reuses the established `jparse(field,'path')` form (already validated), so no new emitter or NRQL surface.

**Tech Stack:** Pure ESM JavaScript; IR node factories in `src/ir/nodes.js` (`Binding`, `Func`, `Identifier`, `Literal`); message catalog in `src/messages.js`; Vitest (unit tests for the helper + the data-driven `cases` array in `test/spl/spl.test.js`). No grammar change → no `npm run build:parsers`.

**Branch:** `feat/spath-auto-extract` off `origin/master` (cut **after PR #72 lands** — see Execution Handoff). Spec: `docs/superpowers/specs/2026-06-27-spath-auto-extract-design.md`.

## Global Constraints

- Dev requires **Node 24**: prefix every command `ASDF_NODEJS_VERSION=24.14.0` (hooks + commit need it).
- Run one package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- <filter>`.
- Conventional commits, lowercase subject ≤72 chars, body lines ≤100. `git commit -F <file>` for multi-line bodies. `git push origin HEAD` (never bare, never to master).
- **Loud failure over silent-wrong:** auto-extract with no enumerable downstream reference, or any downstream shape this plan does not confidently enumerate, → `messages.spath_no_path()` (`unsupported`), never a partial or guessed `jparse`. "Explode if unsure."
- Messages live in `src/messages.js`; handlers call `messages.key()` — no inline strings. The spy check inside `test/spl/spl.test.js` enforces that every key in a test's `unsupportedFunc`/`warningFunc` array exists AND asserts the arrays are **exhaustive** (every fired message listed). There is NO separate `test/messages.test.js` in this repo.
- New/changed translations land at `verified: false` (a human promotes to `'llm'`/`'human'` later).
- **`jparse` is the only mechanism.** Native JSON property access is deferred (`design-decisions.md` → "Native JSON access (deferred — keep `jparse()`-first)"). Emit `jparse(<source>, '<field>')`, never `field['k']`.
- **Test `spl` uses `*` as the leading term**, not a bare word: a bare leading term (`web_logs`) injects `WHERE message LIKE '%web_logs%'` (verified via `node bin/spl2nrql.js`), which the spec's acceptance NRQL does not have. Byte-match every expected `nrql` to `node bin/spl2nrql.js` output.
- **Fuzz ×20** for any translator change (it reseeds each run; a single green is a false-green): `for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done`.
- Convention: call raw records **loglines**, not "events".

## Ground-truth byte shapes (captured from the already-working `spath path=` analog, 2026-06-28)

These are the exact targets the auto-extract path must reproduce (the `path=` form is already `verified: 'human'`):

```
* | spath path=status output=status | stats count by status
→ FROM Log WITH jparse(message, 'status') AS status SELECT count(*) FACET status

* | spath input=payload path=code output=code | where code="500" | stats count
→ FROM Log WITH jparse(payload, 'code') AS code SELECT count(*) WHERE code = '500' OR numeric(code) = 500
```

Note the second emits the **DualCheck** RHS (`code = '500' OR numeric(code) = 500`) — that comes from the downstream `where`, not from `spath`, and must appear verbatim in the auto-extract case's expected `nrql`.

## Double-check targets (FLAGGED uncertainties — resolve before/while building, do NOT guess)

1. **Exact warning set for the stats case (EXHAUSTIVE `warningFunc`).** The path= analog `spath path=… | stats count by …` fires `['spath_json_only', 'facet_default_limit']` (test line ~2025). The auto-extract path replaces `spath_json_only` with the new `spath_auto_extract` (see Task 2), and `facet_default_limit` still fires post-loop because there's a FACET with no LIMIT. **So the stats case should be `['spath_auto_extract', 'facet_default_limit']` and the where+stats case `['spath_auto_extract']`** — but CLI-confirm both via `node bin/spl2nrql.js` and set the arrays to exactly what fires (the spy check is exhaustive). Decide deliberately whether `spath_json_only` ALSO fires; this plan folds the JSON caveat into `spath_auto_extract` and does NOT also push `spath_json_only`.
2. **`count(*)` arg shape.** The grammar gives bare `count` → `{name:'count', args:[]}` and `count(*)` → `{name:'count', args:<function_args>}`. The `isFieldFreeCount` check in Task 1 must accept both. Confirm what `count(*)`'s `args[0]` is (a `'*'` string vs an object) before finalizing the predicate — a debug print or reading `function_args` in the grammar. If unsure, bail (return null) for anything that isn't bare `count` with `args.length === 0`; that still satisfies acceptance #1/#2 (both use plain `count`).
3. **`where` comparison AST.** Confirmed: a `Comparison` node carries the bare field in `node.field` (see `splToIR.js` Comparison case, ~line 241), and boolean trees use `BooleanOp` with `left`/`right`. The Task 1 walker enumerates ONLY `Comparison` (collect `.field`) and `BooleanOp` (recurse); any other node type (`FuncComparison`, `InComparison`, `Not`, `Macro`, `TemplateVariable`, subsearch, …) → return null. Re-confirm `node.field` is a plain string for the simple `code="500"` form.
4. **Scope of the enumerable set (the load-bearing design call).** v1 enumerates downstream references ONLY from (a) `stats`/`chart`/`timechart` `groupBy` fields when every function is field-free `count`, and (b) `where` `Comparison.field` trees. ANY other downstream command, a `*`, or a stats function reading a bare field → `null` → loud `spath_no_path`. This is the conservative, spec-approved ("explode if unsure") choice; broadening (stats function-arg fields, `table <fields>`, `fields`, `sort`, `rename`, …) is explicit future work, not this PR. Confirm the human is comfortable with `* | spath | stats sum(bytes) by status` staying `unsupported` in v1.

## File Structure

- **Create** `src/input/spl/spathAutoExtract.js` — the pure `collectAutoExtractFields(downstream)` scanner + its small per-command rules. One responsibility: given the commands after a no-path `spath`, return the bare field names to bind or `null`. No IR, no messages.
- **Create** `test/spl/spathAutoExtract.test.js` — explicit unit tests for the scanner (one scenario per `it()`, per project test-authoring style; NOT a fixture loop).
- **Modify** `src/input/spl/splToIR.js` — in the pipeline loop, compute `cmd._autoExtractFields` for a no-path `SpathCommand`; import `collectAutoExtractFields`.
- **Modify** `src/input/spl/extractionHandlers.js` — `handleSpath` consumes `cmd._autoExtractFields` (push one `jparse` binding per field + `spath_auto_extract` warning), else existing `spath_no_path`.
- **Modify** `src/messages.js` — add `spath_auto_extract`.
- **Modify** `test/spl/spl.test.js` — data-driven `cases` for the translation behavior.

---

### Task 1: `collectAutoExtractFields` scanner + unit tests (inert)

**Files:**
- Create: `src/input/spl/spathAutoExtract.js`
- Test: `test/spl/spathAutoExtract.test.js`

**Interfaces:**
- Produces: `collectAutoExtractFields(downstream: object[]) → string[] | null`. `downstream` is `ast.commands` AFTER the no-path `spath`. Returns the de-duplicated bare field names referenced by an enumerable downstream, or `null` when the auto-extract is not safely enumerable (empty downstream, an un-enumerable command, a `*`, or a stats function reading a field).

- [ ] **Step 1: Write the failing unit tests** in `test/spl/spathAutoExtract.test.js`. The scanner takes parsed-command objects; build them as plain literals matching the real AST shapes (`StatsCommand` → `groupBy: string[]`, `functions: {name,args,alias,evalFilter}[]`; `WhereCommand` → `expression` tree of `Comparison {field}` / `BooleanOp {left,right}`):

```javascript
import { describe, it, expect } from 'vitest';
import { collectAutoExtractFields } from '../../src/input/spl/spathAutoExtract.js';

const statsCountBy = (groupBy) => ({
  type: 'StatsCommand',
  functions: [{ name: 'count', args: [], alias: null, evalFilter: null }],
  groupBy,
});

describe('collectAutoExtractFields', () => {
  it('returns null for an empty downstream (spath is the last command)', () => {
    expect(collectAutoExtractFields([])).toBeNull();
  });

  it('collects stats `by` fields when every function is a field-free count', () => {
    expect(collectAutoExtractFields([statsCountBy(['status'])])).toEqual([
      'status',
    ]);
  });

  it('collects a where comparison field', () => {
    const where = {
      type: 'WhereCommand',
      expression: { type: 'Comparison', field: 'code', operator: '=' },
    };
    expect(collectAutoExtractFields([where, statsCountBy([])])).toEqual([
      'code',
    ]);
  });

  it('walks a boolean where tree and de-duplicates fields', () => {
    const where = {
      type: 'WhereCommand',
      expression: {
        type: 'BooleanOp',
        left: { type: 'Comparison', field: 'code', operator: '=' },
        right: { type: 'Comparison', field: 'code', operator: '!=' },
      },
    };
    expect(collectAutoExtractFields([where])).toEqual(['code']);
  });

  it('returns null for `table *` (auto-extract-all, no enumerable reference)', () => {
    expect(
      collectAutoExtractFields([{ type: 'TableCommand', fields: ['*'] }]),
    ).toBeNull();
  });

  it('returns null when a stats function reads a bare field (would leave it unbound)', () => {
    const stats = {
      type: 'StatsCommand',
      functions: [{ name: 'sum', args: ['bytes'], alias: null, evalFilter: null }],
      groupBy: ['status'],
    };
    expect(collectAutoExtractFields([stats])).toBeNull();
  });

  it('returns null for any non-enumerable downstream command type', () => {
    expect(
      collectAutoExtractFields([{ type: 'RexCommand', field: '_raw' }]),
    ).toBeNull();
  });

  it('returns null when a where tree contains a non-comparison node', () => {
    const where = {
      type: 'WhereCommand',
      expression: { type: 'FuncComparison', name: 'cidrmatch' },
    };
    expect(collectAutoExtractFields([where])).toBeNull();
  });

  it('returns null when stats has no `by` and contributes no fields', () => {
    expect(collectAutoExtractFields([statsCountBy([])])).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spathAutoExtract`
  Expected: FAIL — `collectAutoExtractFields` is not defined / module missing.

- [ ] **Step 3: Implement** `src/input/spl/spathAutoExtract.js`:

```javascript
/**
 * Decide which fields a `spath` (no `path=`) auto-extract must bind, by scanning
 * the commands that FOLLOW it in the pipeline.
 *
 * Returns the de-duplicated list of bare field names referenced by an
 * enumerable downstream, or `null` when the auto-extract is NOT safely
 * enumerable — in which case the caller emits the loud `spath_no_path`
 * `unsupported`. LOUD over silent-wrong: when in doubt, return null.
 *
 * v1 enumerates ONLY:
 *   - `stats`/`chart`/`timechart … by <fields>` whose functions are all
 *     field-free `count` (bare `count` or `count(*)`); its `groupBy` fields are
 *     collected. A function reading a bare field (`sum(bytes)`, `count(host)`)
 *     would itself need a binding we are not enumerating → null.
 *   - `where <field> <op> …` trees of `Comparison` (collect `.field`) and
 *     `BooleanOp` (recurse left/right).
 * Any other command type, a `*` reference, or an un-walkable where node → null.
 *
 * @param {Array<object>} downstream  commands after the no-path spath
 * @returns {string[] | null}
 */
export function collectAutoExtractFields(downstream) {
  if (!downstream || downstream.length === 0) return null;
  const fields = [];
  const add = (name) => {
    if (typeof name === 'string' && name && name !== '*' && !fields.includes(name)) {
      fields.push(name);
    }
  };
  for (const cmd of downstream) {
    switch (cmd.type) {
      case 'StatsCommand':
      case 'ChartCommand':
      case 'TimechartCommand': {
        // Every function must be a field-free count, else a JSON-derived metric
        // field would be left unbound (silent-wrong). Bail loudly instead.
        const fns = cmd.functions || [];
        const allFieldFreeCount = fns.every((fn) => isFieldFreeCount(fn));
        if (!allFieldFreeCount) return null;
        for (const f of cmd.groupBy || []) add(f);
        break;
      }
      case 'WhereCommand': {
        if (!collectWhereFields(cmd.expression || cmd.expr, add)) return null;
        break;
      }
      default:
        // Any command we do not confidently enumerate → not safely enumerable.
        return null;
    }
  }
  return fields.length > 0 ? fields : null;
}

// A `count` with no field argument: bare `count` (args:[]) or `count(*)`.
// Anything else (count(field), sum/avg/dc/…) reads a field we don't bind.
function isFieldFreeCount(fn) {
  if (!fn || fn.evalFilter) return false;
  if (typeof fn.name !== 'string' || fn.name.toLowerCase() !== 'count') return false;
  const args = fn.args || [];
  return args.every((a) => isStar(a));
}

function isStar(arg) {
  if (arg === '*') return true;
  // Tolerate an object-wrapped wildcard (e.g. { name: '*' } / { value: '*' }).
  return !!arg && typeof arg === 'object' && (arg.name === '*' || arg.value === '*');
}

// Walk a where expression collecting Comparison `.field` names. Returns false
// (→ caller bails) on any node we don't confidently understand.
function collectWhereFields(node, add) {
  if (!node || typeof node !== 'object') return false;
  switch (node.type) {
    case 'Comparison':
      if (typeof node.field !== 'string' || !node.field) return false;
      add(node.field);
      return true;
    case 'BooleanOp':
      return (
        collectWhereFields(node.left, add) && collectWhereFields(node.right, add)
      );
    default:
      return false;
  }
}
```

- [ ] **Step 4: Run, confirm green** (same command). All `collectAutoExtractFields` tests pass.

- [ ] **Step 5: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/spathAutoExtract.js packages/nr-query-bridge/test/spl/spathAutoExtract.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: add spath auto-extract downstream-field scanner (inert)"
```

---

### Task 2: Wire the scanner into the pipeline + handleSpath + message + cases

**Files:**
- Modify: `src/input/spl/splToIR.js` — import `collectAutoExtractFields`; in the pipeline loop, set `cmd._autoExtractFields` for a no-path `SpathCommand`.
- Modify: `src/input/spl/extractionHandlers.js` — `handleSpath` consumes `cmd._autoExtractFields`.
- Modify: `src/messages.js` — add `spath_auto_extract`.
- Test: `test/spl/spl.test.js` (data-driven `cases`; its spy check also validates message-key existence + exhaustiveness — there is no separate `test/messages.test.js`).

**Interfaces:**
- Consumes: `collectAutoExtractFields(downstream) → string[] | null` (Task 1); `Binding(name, expr)`, `Func(name, args)`, `Identifier(name)`, `Literal(value, kind)` from `src/ir/nodes.js`; `messages.spath_auto_extract(fields)`.

**Behavior (from the spec):** A no-path `spath` followed by an enumerable downstream binds each referenced field `f` as `WITH jparse(<source>, '<f>') AS <f>` (`<source>` = `input=` field with `_raw`→`message`, else `message`), then the downstream `f` references resolve to the binding. Non-enumerable / auto-extract-all → existing `spath_no_path` (`unsupported`), unchanged.

- [ ] **Step 1: Add failing data-driven `cases`** to the `cases` array in `test/spl/spl.test.js`, in the spath block (after the existing `* | spath` → `spath_no_path` case ~line 2020). Use `*` as the leading term; the `warningFunc` arrays are the **best current expectation** — confirm exhaustively against the CLI in Step 5 (Double-check target #1):

```javascript
  // Auto-extract (no path) rewritten to per-field jparse — downstream `stats by`.
  {
    spl: '* | spath | stats count by status',
    nrql: "FROM Log WITH jparse(message, 'status') AS status SELECT count(*) FACET status",
    warningFunc: ['spath_auto_extract', 'facet_default_limit'],
    doc: 'fields-spath',
    verified: false,
  },
  // Auto-extract with input= + downstream `where` (DualCheck RHS from the where).
  {
    spl: '* | spath input=payload | where code="500" | stats count',
    nrql: "FROM Log WITH jparse(payload, 'code') AS code SELECT count(*) WHERE code = '500' OR numeric(code) = 500",
    warningFunc: ['spath_auto_extract'],
    doc: 'fields-spath',
    verified: false,
  },
  // Auto-extract-all for display → stays unsupported (no enumerable reference).
  {
    spl: '* | spath | table *',
    unsupportedFunc: ['spath_no_path'],
    doc: 'fields-spath',
    verified: false,
  },
```

(The existing `* | spath` last-command case at ~line 2016 already asserts `spath_no_path` and stays `verified: 'human'` — do NOT modify it; Task 1's empty-downstream → null keeps it correct.)

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
  Expected: FAIL — the two new translatable cases currently emit `unsupported: spath_no_path`, so `nrql`/`warningFunc` don't match.

- [ ] **Step 3: Add the message** to `src/messages.js` (next to `spath_no_path` ~line 35; keep the SPL example comment style):

```javascript
  // SPL: `* | spath | stats count by status`
  spath_auto_extract: (fields) =>
    `spath without path= auto-extracts all fields; rewrote downstream reference(s) ${fields} as jparse(<source>, '<field>') — confirm each is a JSON property of the source`,
```

- [ ] **Step 4: Wire the scanner** in `src/input/spl/splToIR.js`. Add the import near the other handler imports (top of file):

```javascript
import { collectAutoExtractFields } from './spathAutoExtract.js';
```

Then in the pipeline loop (the `for (const cmd of ast.commands)` at ~line 152), before `applyCommand(cmd, ir)`, compute the field set for a no-path spath. Convert the loop to an indexed form so the downstream slice is available:

```javascript
  for (let i = 0; i < ast.commands.length; i++) {
    const cmd = ast.commands[i];
    if (cmd.type === 'DedupCommand') sawDedup = true;
    if (cmd.type === 'MvexpandCommand') mvexpandCount++;
    // Gap #2, #9: warn when dedup precedes aggregation
    if (
      sawDedup &&
      (cmd.type === 'StatsCommand' ||
        cmd.type === 'TimechartCommand' ||
        cmd.type === 'ChartCommand')
    ) {
      ir.warnings.push(messages.dedup_limit_max_cap());
      if (cmd.type === 'TimechartCommand') {
        ir.warnings.push(messages.dedup_timeseries_warning());
      }
    }
    // spath auto-extract (no path=): enumerate the fields referenced downstream
    // so handleSpath can bind each as jparse(<source>, '<field>'). null when not
    // safely enumerable → handleSpath emits the loud spath_no_path.
    if (cmd.type === 'SpathCommand' && !cmd.path) {
      cmd._autoExtractFields = collectAutoExtractFields(ast.commands.slice(i + 1));
    }
    applyCommand(cmd, ir);
  }
```

- [ ] **Step 5: Implement the consumer** in `handleSpath` (`src/input/spl/extractionHandlers.js`). Replace the early `if (!cmd.path)` bail with the auto-extract branch:

```javascript
export function handleSpath(cmd, ir) {
  if (!cmd.path) {
    const fields = cmd._autoExtractFields;
    if (!fields || fields.length === 0) {
      // Auto-extract-all / non-enumerable downstream — no NRQL target.
      ir.unsupported.push(messages.spath_no_path());
      return;
    }
    const rawInput = cmd.input || 'message';
    const input = rawInput === '_raw' ? 'message' : rawInput;
    for (const f of fields) {
      ir.bindings.push(
        Binding(f, Func('jparse', [Identifier(input), Literal(f, 'string')])),
      );
    }
    ir.warnings.push(messages.spath_auto_extract(fields.join(', ')));
    return;
  }
  const rawInput = cmd.input || 'message';
  const input = rawInput === '_raw' ? 'message' : rawInput;
  // Default output name is last segment of path (SPL convention)
  const output =
    cmd.output ||
    cmd.path
      .split('.')
      .pop()
      .replace(/[{}[\]*]/g, '');
  const jsonPath = cmd.path.replace(/\{[^}]*\}/g, '[*]');
  ir.bindings.push(
    Binding(
      output,
      Func('jparse', [Identifier(input), Literal(jsonPath, 'string')]),
    ),
  );
  ir.warnings.push(messages.spath_json_only());
}
```

(`Binding`, `Func`, `Identifier`, `Literal` are already imported in this file — verify the import line; `Literal` and `Func` are present, confirm `Binding`/`Identifier` too.)

- [ ] **Step 6: Run, confirm green.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test` — the three new cases pass. Then the whole package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge` (no regressions; the existing `* | spath` and `spath path=…` cases still pass).

- [ ] **Step 7: CLI spot-check + match the test `nrql` and EXHAUSTIVE warnings.** Run each and byte-match the `nrql` field; set each `warningFunc` array to exactly the warnings printed (Double-check target #1):

```bash
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | spath | stats count by status'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | spath input=payload | where code="500" | stats count'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | spath | table *'
```

- [ ] **Step 8: Staging-validate the multi-/single-field emitted NRQL via `run_nerdgraph_query`** (acct 1; `jparse` is in the `execute_nrql_query` false-reject set, so use NerdGraph or the UI). The emitted `WITH jparse(field,'k')` form is the same one `spath path=` already produces (effectively pre-validated), but confirm the auto-extract case runs end-to-end — e.g. `FROM Log WITH jparse(message,'status') AS status SELECT count(*) FACET status SINCE 30 minutes ago` executes without error. Record the result.

- [ ] **Step 9: Fuzz ×20** (mandated for translator changes):

```bash
for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done
```

- [ ] **Step 10: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/splToIR.js packages/nr-query-bridge/src/input/spl/extractionHandlers.js packages/nr-query-bridge/src/messages.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: rewrite spath auto-extract to per-field jparse bindings"
```

---

### Task 3: Graduate (docs) — after staging validation

**Files:**
- Modify: `.claude/rules/design-decisions.md` (add the invariant)
- Modify: `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` (reclassify the `spath-auto-extract` row)
- Modify: `test/spl/spl.test.js` (`verified: false` → `'llm'` once staging-validated)

> **FLAG — concurrent edit on the laundry-list file.** `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` is ALSO edited by PR #72 (the specs-landing PR this branch is cut after) and by sibling laundry-list build branches. Rebase onto the latest master before editing the row, change ONLY the `spath-auto-extract` line (line ~84), and expect a possible conflict — resolve by keeping both this row's reclassification and any sibling rows.

- [ ] **Step 1: Promote the validated cases** in `test/spl/spl.test.js` from `verified: false` to `verified: 'llm'` — only the two translatable cases whose emitted NRQL was staging-confirmed in Task 2 Step 8 (the `table *` case stays as-is; it asserts an unsupported, no NRQL to validate). Per project rule, only a human promotes to `'human'`.

- [ ] **Step 2: Graduate the invariant** to `.claude/rules/design-decisions.md`, under the SPL Grammar Leniency or a spath/extraction bullet:

```markdown
- **`spath` without `path=` (auto-extract) → per-field `jparse`**: a no-path `spath` is rewritten by
  binding each downstream-referenced field `f` as `WITH jparse(<source>, '<f>') AS <f>` (the same form
  `spath path=` emits; `<source>` = `input=` field with `_raw`→`message`, else `message`). The field set
  comes from `collectAutoExtractFields(downstream)` (`src/input/spl/spathAutoExtract.js`), which v1
  enumerates ONLY from `stats`/`chart`/`timechart … by` fields (functions must be field-free `count`) and
  `where` `Comparison.field` trees; ANY other downstream command, a `*`, or a stats function reading a
  bare field → `null` → loud `spath_no_path` `unsupported` (never a partial/guessed `jparse`). The
  pipeline loop in `splToIR.js` computes the set and stashes it on `cmd._autoExtractFields`; `handleSpath`
  consumes it. `jparse` is the only mechanism (native JSON access is deferred).
```

- [ ] **Step 3: Reclassify the laundry-list row** (line ~84): change `spath-auto-extract` from `GAP` ("has no NRQL equivalent") to a shipped PARTIAL — auto-extract followed by an enumerable downstream now translates via per-field `jparse`; auto-extract-all (`table *`, last-command) stays `unsupported`. Update the Status column from `Placeholder` accordingly.

- [ ] **Step 4: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add .claude/rules/design-decisions.md docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: graduate spath auto-extract translation"
```

---

## Global Verification

- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm test` — full workspace suite green.
- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check` — clean (Prettier/format included; never acceptable to leave failing).
- [ ] No `npm run build:parsers` needed — no grammar change.
- [ ] Fuzz ×20 green (Task 2 Step 9).
- [ ] Staging validation of the emitted auto-extract NRQL (Task 2 Step 8) recorded.
- [ ] Open the PR (the three commits above); invoke `write-gooder` for the body (100–200 words, summary + test plan).

## Self-Review

1. **Spec coverage:** scanner (Task 1) ✓; pipeline wiring + handleSpath rewrite + message + acceptance `cases` (Task 2) ✓; graduate + laundry-list reclass (Task 3) ✓. All four spec acceptance criteria map to cases: `spath | stats count by status` (Task 2 case 1), `spath input=payload | where code="500" | stats count` (case 2), `spath | table *` (case 3), `spath` last-command (existing human-verified case, unchanged — Task 1 empty-downstream → null keeps it loud).
2. **Loud-failure:** non-enumerable downstream → `collectAutoExtractFields` returns `null` → `handleSpath` pushes `spath_no_path` (`unsupported`); never a partial/guessed `jparse`. `stats sum(bytes)` and any non-`{stats,where}` downstream bail loudly (Task 1 tests assert this).
3. **Type consistency:** `collectAutoExtractFields` returns `string[] | null` (Task 1) — consumed with that exact contract (Task 2 wiring + handleSpath). `Binding(name, expr)`, `Func(name, args)`, `Identifier(name)`, `Literal(value, kind)` match `src/ir/nodes.js`; no null args to factories (fields are validated non-empty strings before `Binding`).
4. **Message consistency:** one new key `spath_auto_extract(fields)` referenced in the `cases` array; `spath_no_path` reused unchanged. `warningFunc`/`unsupportedFunc` arrays must be set to exactly what fires (Double-check target #1 — confirm via CLI; the spy check is exhaustive).
5. **Reuse:** emits the identical `jparse(<source>,'<field>')` form `spath path=` already produces (ground-truth byte shapes captured) — no new emitter/NRQL surface, effectively pre-validated.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-28-spath-auto-extract.md`. The branch (`feat/spath-auto-extract`) is cut off `master` **after PR #72 lands** (it edits the shared laundry-list spec — see Task 3 FLAG). Run `/double-check` on this plan first (clean-room test suite for the scanner + the enumerable-set decision), then execute via **subagent-driven-development**. Resolve the four Double-check targets — especially #4 (the v1 enumerable-set scope) — with the human before finalizing, since they shape how many panels survive vs stay `unsupported`.
