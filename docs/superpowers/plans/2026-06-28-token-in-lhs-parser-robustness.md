# Token in comparison LHS — parser robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dashboard `$token$` in a comparison **LHS/field position** must not poison the whole command. Make the grammar accept a `template_variable` in comparison LHS (base-search position — currently a hard parse error; and `where`/`search` pipeline position — currently degrades to `unsupported_command('where')`). Then, for the common Splunk multiselect "means-all" idiom (`($tok$="*" OR field="$tok$")`), emit a faithful **operand flip** (`'*' = {{tok}}`) instead of placeholdering the panel.

**Architecture:** ONE grammar change (this is the only laundry-list spec needing one). The Peggy comparison rules (`comparison` for base search, `where_comparison` for the `where` pipeline command) gain a token-LHS alternative that produces a `Comparison{ lhsToken: TemplateVariable, operator, value }` AST node. `splToIR.js`'s `case 'Comparison'` gains an early `node.lhsToken` branch: an equality (`=`/`!=`) comparison with one non-token operand is rewritten by **B′ — a mechanical operand flip** that moves the template var to value position (`'*' = {{tok}}`, `'lit' = {{tok}}`); a non-equality operator or a token-vs-token comparison can't flip → **A — loud clause-level `unsupported`**, never a silent `{{tok}}` in field position. The means-all sentinel (`$tok$ = "*"`) additionally fires a `means_all_token` warning. The importer's multiselect→`IN ({{tok}})` (Option B) is **not** owned here — the translator default is B′, which needs no idiom recognition or multiselect hint.

**Tech Stack:** Pure ESM JavaScript. Grammar: `src/input/spl/spl.grammar` → generated `src/input/spl/splParser.js` via `npm run build:parsers`. AST→IR: `src/input/spl/splToIR.js`. IR factories: `src/ir/nodes.js` (`BinOp`, `Literal`, `Identifier`). Messages: `src/messages.js`. Vitest data-driven `cases` array in `test/spl/spl.test.js` (message-key consistency is enforced *there* — there is no separate `messages.test.js`; the per-case spy check validates every `warningFunc`/`unsupportedFunc` key against `messages` and asserts exhaustiveness). Importer integration: `packages/nr-dashboard-importer/test/integration/`.

**Branch:** `feat/token-in-lhs` off `origin/master`. Spec: `docs/superpowers/specs/2026-06-27-token-in-lhs-parser-robustness-design.md`. Laundry-list row: `supported-command-reported-unsupported`.

## Global Constraints

- Dev requires **Node 24**: prefix every command `ASDF_NODEJS_VERSION=24.14.0` (hooks + commit need it).
- Run one package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- <filter>` (importer tasks use `--workspace=@newrelic/dashboard-importer`).
- **After ANY grammar edit:** `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers` to regenerate `src/input/spl/splParser.js`, then **commit the regenerated parser** (it is excluded from lint/format but MUST be tracked, or CI's no-uncommitted-changes gate fails). Then **fuzz ×20** — the change is parser-surface, fuzz is the safety net: `for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done`.
- Conventional commits, lowercase subject ≤72 chars, body lines ≤100. `git commit -F <file>` for multi-line bodies. `git push origin HEAD` (never bare, never to master).
- **Loud failure over silent-wrong:** a token-LHS comparison that cannot be faithfully flipped → `unsupported`, never a `{{tok}}` emitted in field position (NR never substitutes it there → a dead/invalid query).
- **Grammar leniency is scoped** (see `design-decisions.md` → "SPL Grammar Leniency"). This change adds a token-LHS *alternative*; it must not broaden separator/quote leniency. The safety argument: `search_field`/`field_name` start with `[a-zA-Z_]` and never match `$`, so the new alternative changes the parse of **only** inputs that previously errored (base) or degraded to `UnsupportedCommand` (where). No previously-successful parse changes — fuzz confirms.
- Messages live in `src/messages.js`; handlers call `messages.key()` — no inline strings.
- New/changed translations land at `verified: false` (a human promotes to `'llm'`/`'human'` later).
- **Test `spl` uses a leading `*` (match-all), not a bare keyword** — a bare leading term injects `WHERE message LIKE '%term%'` noise. A no-aggregation query emits `FROM Log SELECT * WHERE …`; a `| stats count` emits `FROM Log SELECT count(*) WHERE …`. **Byte-match every `nrql` field to `node bin/spl2nrql.js` output and fix the string if it differs** (the OR-group parenthesization in particular must be CLI-confirmed — see Double-check targets).
- `doc:` tag — reuse the registered `'dashboard-time-tokens'` tag (the existing value-position token cases already use it); a new tag would need a matching SPL_TO_NRQL.md sentinel.
- Convention: call raw records "loglines", never "events".

## Design decisions (A / B / B′) — what applies when

Per the spec's Resolved decisions, the **translator** implements exactly two of the three options:

- **B′ (mechanical operand flip) — DEFAULT for token-LHS *equality* (`=`/`!=`) with one non-token operand.** `$tok$ = "*"` → `'*' = {{tok}}`; `$tok$ = "lit"` → `'lit' = {{tok}}`. Live-verified valid NRQL (`WHERE '*' = '*'` matches all rows; `WHERE '*' = 'prod'` matches 0 — acct 1). No idiom recognition; means-all falls out naturally. A surrounding `OR field = {{tok}}` disjunct already translates on its own, so no BooleanOp-level surgery is needed.
- **A (loud clause-level `unsupported`) — for un-flippable token-LHS:** a non-equality operator (`>`,`<`,`>=`,`<=`) or token-vs-token (`$tok$ = $other$`). Never a silent `{{tok}}` in field position. A-only still placeholders the panel (the importer chokepoint placeholders on any `unsupported`) — accepted; A is the honest fallback for the shapes B′ can't salvage.
- **B (drop the always-true disjunct → `field IN ({{tok}})`) is the IMPORTER's multiselect handling — NOT owned by the translator here.** The translator default is B′; B is deferred to the importer's per-variable path (Task 3 verifies alignment, it does not add an idiom-recognition rewrite).

> **Lead-steer discrepancy (see Double-check targets):** the assignment summarized the steer as "B′ as the default for *numeric operations* … plus a *multiple-rename guard*." Neither "numeric operations" nor a "multiple-rename guard" maps to anything in the spec's A/B/B′ decisions (B′ is keyed on *equality*, not numeric type; the spec/grammar `rename` rules are untouched by a comparison-LHS fix). This plan follows the spec verbatim and **flags those two phrases for clarification** rather than inventing a guard.

## File Structure

- **Modify** `src/input/spl/spl.grammar` — add a token-LHS alternative to `comparison` (base) and `where_comparison` (pipeline).
- **Regenerate + commit** `src/input/spl/splParser.js` via `npm run build:parsers`.
- **Modify** `src/input/spl/splToIR.js` — early `node.lhsToken` branch in `case 'Comparison'`.
- **Modify** `src/messages.js` — add `token_lhs_unsupported`, `means_all_token`.
- **Modify** `test/spl/spl.test.js` — data-driven `cases`.
- **Add** `packages/nr-dashboard-importer/test/integration/fixtures/synthetic/<name>.xml` + regenerate `GAP_INVENTORY.md` (Task 3).
- **Modify** `.claude/rules/design-decisions.md` + `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` (Task 4).

---

### Task 1: Grammar accepts a token LHS; handler emits a loud clause-level unsupported (PR 1)

**Scope:** ~150 lines (grammar + regenerated parser + handler + tests). Kills the parse error AND the whole-command `unsupported_command('where')` poisoning. NO means-all special-casing yet — every token-LHS comparison becomes a *specific* clause-level `unsupported`. Dependency: none.

**Files:**
- Modify: `src/input/spl/spl.grammar`, `src/input/spl/splToIR.js`, `src/messages.js`
- Regenerate + commit: `src/input/spl/splParser.js`
- Test: `test/spl/spl.test.js`

**Interfaces:**
- Grammar produces `{ type: 'Comparison', lhsToken: <TemplateVariable node>, operator, value }` — `lhsToken` is the `{ type: 'TemplateVariable', name }` node (NOT a string `field`). `value` is a `search_value` (base: a string OR a `TemplateVariable` node) or a `where_value` (where: always a string).
- `messages.token_lhs_unsupported(name) → string`.

- [ ] **Step 1: Add the failing `cases`** to the `cases` array in `test/spl/spl.test.js` (next to the existing token cases ~line 845). PR1 expectation = parses, **specific** clause-level unsupported (NOT a parse error, NOT `unsupported_command`):

```javascript
  // ── Token in comparison LHS/field position (parser robustness) ──────────
  // Base-search position: `$tok$="*"` used to be a HARD PARSE ERROR. PR1: it
  // parses and produces a LOCAL clause-level unsupported — no whole-command poison.
  {
    spl: '* $cat$="*" | stats count',
    unsupportedFunc: ['token_lhs_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  // Pipeline (where) position: used to degrade to unsupported_command('where').
  // PR1: parses to a Comparison and emits the SPECIFIC token-LHS unsupported.
  // (The `category="$cat$"` disjunct translates fine; the token-LHS disjunct is
  // the only thing that fires a message.)
  {
    spl: '* | where ($cat$="*" OR category="$cat$")',
    unsupportedFunc: ['token_lhs_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  // Token-vs-token can never flip → stays unsupported in PR1 AND PR2 (Option A).
  {
    spl: '* | where $cat$ = $other$',
    unsupportedFunc: ['token_lhs_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: false,
  },
```

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
  Expected: FAIL — the base case throws a parse error (no `nrql`/message match) and the `where` case fires `unsupported_command` (not `token_lhs_unsupported`, which doesn't exist yet → its spy is undefined).

- [ ] **Step 3: Add the message** to `src/messages.js` (near the other token messages ~line 392, after `wildcard_token_like`):

```javascript
  // SPL: `$tok$="*"` / `$tok$ = field` — a dashboard token in comparison FIELD
  // position. New Relic substitutes a dashboard variable only in VALUE position,
  // so a token can never stay in field position. An equality comparison is
  // flipped (B′, see means_all_token); a non-equality operator or a token-vs-token
  // comparison can't flip → this loud clause-level unsupported (never a dead
  // {{tok}} in field position).
  token_lhs_unsupported: (token) =>
    `$${token}$ appears in comparison field position; New Relic substitutes a ` +
    'dashboard variable only in value position, so only an equality comparison ' +
    'with a non-token operand can be rewritten — this one cannot be translated.',
```

- [ ] **Step 4: Edit the grammar** `src/input/spl/spl.grammar`.

  (a) **Base `comparison` rule** (~line 1347) — add a third alternative (the quoted-field and `search_field` alternatives never match `$`, so order is safe):

```pegjs
comparison
  = '"' field:double_string_char* '"' _* op:comparison_op _* value:search_value
    {
      return {
        type: 'Comparison',
        field: field.join(''),
        operator: op,
        value: value
      };
    }
  / field:search_field _* op:comparison_op _* value:search_value
    {
      return {
        type: 'Comparison',
        field: field,
        operator: op,
        value: value
      };
    }
  / lhs:template_variable _* op:comparison_op _* value:search_value
    {
      // Dashboard token in LHS/field position ($tok$ = …). `lhsToken` is the
      // TemplateVariable node; splToIR decides flip (B′) vs unsupported (A).
      return {
        type: 'Comparison',
        lhsToken: lhs,
        operator: op,
        value: value
      };
    }
```

  (b) **Pipeline `where_comparison` rule** (~line 287) — add a token-LHS alternative FIRST (`field_name` never matches `$`, so this is safe and explicit):

```pegjs
where_comparison
  = lhs:template_variable _* op:comparison_op _* value:where_value
    {
      // Dashboard token in `where` LHS/field position. value is a where_value
      // (a string, e.g. "*", a field name, or "$other$"); splToIR flips (B′) or
      // marks unsupported (A).
      return { type: 'Comparison', lhsToken: lhs, operator: op, value: value };
    }
  / field:field_name _+ 'like'i _+ value:where_value
    {
      return { type: 'Comparison', field: field, operator: 'like', value: value };
    }
  / field:field_name _* op:comparison_op _* rhs:u_add
    &{
      if (rhs && typeof rhs === 'object' && rhs.type === 'StringLiteral') return false;
      if (typeof rhs === 'string' && /^[0-9]/.test(rhs)) return false;
      return true;
    }
    {
      return { type: 'Comparison', field: field, operator: op, rhsExpr: rhs };
    }
  / field:field_name _* op:comparison_op _* value:where_value
    {
      return { type: 'Comparison', field: field, operator: op, value: value };
    }
```

- [ ] **Step 5: Regenerate the parser + confirm it parses.** `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`. Spot-check that token-LHS no longer parse-errors: `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* $cat$="*" | stats count'` should emit an `unsupported` (not a parse error).

- [ ] **Step 6: Add the handler branch** to `src/input/spl/splToIR.js` as the **very first** statement in `case 'Comparison': {` (~line 236) — before the `node.rhsExpr` branch and before `let { field, value, operator: op } = node;`. PR1 emits unsupported for ALL token-LHS:

```javascript
      case 'Comparison': {
        // Dashboard token in comparison LHS/field position ($tok$ = …). The
        // grammar emits `lhsToken` (a TemplateVariable node). New Relic
        // substitutes {{var}} in VALUE position only, so a token can never stay
        // in field position. PR1: loud clause-level unsupported for ALL token-LHS
        // (kills the parse error / whole-command poisoning). PR2 replaces this
        // block with the B′ operand flip for the flippable shapes.
        if (node.lhsToken) {
          unsupported.push(messages.token_lhs_unsupported(node.lhsToken.name));
          return null;
        }

        // New typed-node RHS (grammar `field op u_add`). Branch before the
        // legacy flat-`value` path, which assumes `value` is a string.
        if (node.rhsExpr) {
          // … existing body unchanged …
```

- [ ] **Step 7: Run, confirm green** (`-- spl.test`), then the whole package (`npm run test --workspace=@newrelic/query-bridge`) — no regressions (existing value-position token cases at ~line 794–847 still pass: those are `field=$tok$`, not `$tok$=…`, so they keep their path).

- [ ] **Step 8: Commit, then fuzz ×20** (grammar change — mandatory).

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/spl.grammar packages/nr-query-bridge/src/input/spl/splParser.js packages/nr-query-bridge/src/input/spl/splToIR.js packages/nr-query-bridge/src/messages.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: parse token in comparison LHS, emit loud clause-level unsupported"
for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done
```

---

### Task 2: Means-all operand flip (B′) + `means_all_token` warning (PR 2)

**Scope:** ~120 lines (handler + messages + tests). Replaces PR1's blanket-unsupported with the B′ flip for flippable equality; keeps A for the rest. Dependency: PR 1. **Gate:** re-confirm the `'*' = {{tok}}` substitution at the dashboardCreate layer before promoting past `verified: false`.

**Files:**
- Modify: `src/input/spl/splToIR.js` (replace the PR1 `node.lhsToken` block), `src/messages.js` (add `means_all_token`)
- Test: `test/spl/spl.test.js` (convert the PR1 unsupported cases to B′ output; add an ordering-op A case)

**Interfaces:**
- Consumes: `BinOp(op, left, right)`, `Literal(value, kind)`, `Identifier(name)` from `src/ir/nodes.js` (all already imported in `splToIR.js`). `Identifier(\`{{${tok}}}\`)` emits the bare `{{tok}}` (the established value-position token convention).
- `messages.means_all_token(token) → string`.

- [ ] **Step 1: Convert the PR1 cases to the B′ expectation** in `test/spl/spl.test.js`, and add an ordering-op A case. (Token-vs-token stays unsupported — Option A — unchanged.) **The `nrql` strings below are best-effort; byte-match each to `node bin/spl2nrql.js` in Step 5 and fix if the emitter renders the OR-group parens or `SELECT`/`FROM` shape differently.**

```javascript
  // Standalone means-all sentinel: `$tok$="*"` flips to `'*' = {{tok}}` (B′) + warning.
  {
    spl: '* $cat$="*" | stats count',
    nrql: "FROM Log SELECT count(*) WHERE '*' = {{cat}}",
    warningFunc: ['means_all_token'],
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  // The full multiselect means-all idiom (base-search position). The sentinel
  // disjunct flips (B′ + warning); the value-position disjunct translates as usual.
  {
    spl: '* ($cat$="*" OR category="$cat$") | stats count',
    nrql: "FROM Log SELECT count(*) WHERE ('*' = {{cat}} OR category = {{cat}})",
    warningFunc: ['means_all_token'],
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  // Same idiom in `where` pipeline position (no aggregation → SELECT *).
  {
    spl: '* | where ($cat$="*" OR category="$cat$")',
    nrql: "FROM Log SELECT * WHERE ('*' = {{cat}} OR category = {{cat}})",
    warningFunc: ['means_all_token'],
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  // Token-vs-token can never flip → Option A (unsupported), unchanged from PR1.
  {
    spl: '* | where $cat$ = $other$',
    unsupportedFunc: ['token_lhs_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  // Non-equality operator can't flip (would need operator inversion) → Option A.
  {
    spl: '* | where $cat$ > 5',
    unsupportedFunc: ['token_lhs_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: false,
  },
```

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
  Expected: FAIL — PR1 still emits `token_lhs_unsupported` for the sentinel cases, so `nrql`/`means_all_token` don't match.

- [ ] **Step 3: Add the message** to `src/messages.js` (next to `token_lhs_unsupported`):

```javascript
  // SPL: `$tok$="*"` (the multiselect "means-all" sentinel). Flipped to
  // `'*' = {{tok}}` (B′): when the variable is "*" the literal self-match is true
  // (match all); otherwise a surrounding `OR field = {{tok}}` filters. "All" is
  // realized by the New Relic variable's values, not a literal asterisk match.
  means_all_token: (token) =>
    `The means-all sentinel $${token}$ = "*" was rewritten as '*' = {{${token}}}; ` +
    `"all" is realized by the New Relic variable ${token}'s values, not a literal ` +
    'asterisk match (NRQL `= \'*\'` matches a literal asterisk, i.e. nothing).',
```

- [ ] **Step 4: Replace the PR1 `node.lhsToken` block** in `src/input/spl/splToIR.js` with the B′/A logic:

```javascript
        if (node.lhsToken) {
          const tok = node.lhsToken.name;
          const op = node.operator;
          const value = node.value;
          // RHS is itself a token? (a TemplateVariable node in base position, or
          // a `$other$` string in where position) → can't flip → Option A.
          const rhsIsToken =
            (value &&
              typeof value === 'object' &&
              value.type === 'TemplateVariable') ||
            (typeof value === 'string' &&
              /^\$[A-Za-z0-9_.:-]+\$$/.test(value));
          // Only equality is commutative; an ordering op would need operator
          // inversion (out of scope) → Option A.
          const flippable = op === '=' || op === '!=';
          if (!flippable || rhsIsToken) {
            unsupported.push(messages.token_lhs_unsupported(tok));
            return null;
          }
          // B′ operand flip: <literal> op {{tok}}. Base-search comparison RHS
          // values are literals, so the flipped LHS is a string literal. The
          // means-all sentinel ('*') is realized by the NR variable, not a
          // literal asterisk match → warn.
          if (value === '*') {
            warnings.push(messages.means_all_token(tok));
          }
          return BinOp(op, Literal(value, 'string'), Identifier(`{{${tok}}}`));
        }
```

- [ ] **Step 5: Run, confirm green** (`-- spl.test`), then CLI-byte-match each `nrql`:

```bash
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* $cat$="*" | stats count'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* ($cat$="*" OR category="$cat$") | stats count'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | where ($cat$="*" OR category="$cat$")'
```
  Confirm each emitted NRQL byte-matches the `nrql` field (fix the test string — especially OR-group parens — if it differs). Then whole package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge`.

- [ ] **Step 6: Validate the flipped shape on staging.** `'*' = {{tok}}` can't run as raw NRQL (no variable definition), so split the check:
  - **Shape runs (raw):** via `run_nerdgraph_query` (acct 1) confirm `FROM Log SELECT count(*) WHERE '*' = 'prod' SINCE 30 minutes ago` runs and returns 0, and `WHERE '*' = '*'` matches rows (spec live-verified — re-confirm).
  - **Substitution (dashboardCreate):** use the `project_nr_dashboard_var_substitution` harness to create a dashboard widget whose NRQL is `… WHERE '*' = {{cat}}` with a `cat` variable, and confirm NR substitutes value-position `{{cat}}` (the established value-position rule). Record the verdict in the PR description (gate for promoting past `verified: false`).

- [ ] **Step 7: Fuzz ×20** (handler change is small but the surface is parser-adjacent):

```bash
for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done
```

- [ ] **Step 8: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/splToIR.js packages/nr-query-bridge/src/messages.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: flip token-LHS equality to value position (means-all idiom)"
```

---

### Task 3: Importer integration — means-all panel → real widget (PR 3)

**Scope:** ~80 lines (a synthetic fixture + regenerated `GAP_INVENTORY.md` + an explicit `translateWidgets` assertion). Dependency: PR 2. This is a **verification/alignment** task — the translator already emits the right shape; we confirm the importer chokepoint now produces a clean widget (not a placeholder) for a means-all panel, and that the emitted `field = {{tok}}` is compatible with the importer's multiselect variable handling. **Option B (multiselect → `IN ({{tok}})`) is NOT added here** — the translator default is B′; B remains the importer's per-variable concern (see Double-check targets).

**Files:**
- Add: `packages/nr-dashboard-importer/test/integration/fixtures/synthetic/means-all-token.xml`
- Regenerate: `packages/nr-dashboard-importer/test/integration/GAP_INVENTORY.md` (the integration test sweeps the fixtures dir and rewrites it locally; CI asserts it is up to date)
- Test: `packages/nr-dashboard-importer/test/translateWidgets.test.js` (one explicit assertion)

- [ ] **Step 1: Read the integration harness** `packages/nr-dashboard-importer/test/integration/dashboards.integration.test.js` and an existing `synthetic/*.xml` fixture to match the Simple XML shape (a `<dashboard><row><panel><chart><search><query>…</query></search></chart></panel></row></dashboard>`). The sweep counts a widget as `clean` when `outcome !== 'placeholder'`.

- [ ] **Step 2: Add the fixture** `synthetic/means-all-token.xml` with a means-all panel (generic field names only — no customer identifiers):

```xml
<dashboard>
  <label>Means-all token</label>
  <row>
    <panel>
      <chart>
        <title>Requests by category</title>
        <search>
          <query>index=web ($cat$="*" OR category="$cat$") | stats count by category</query>
        </search>
        <option name="charting.chart">bar</option>
      </chart>
    </panel>
  </row>
</dashboard>
```

- [ ] **Step 3: Add an explicit assertion** to `translateWidgets.test.js` (one scenario per `it()`, inline setup — per project test-authoring style; do NOT loop fixtures):

```javascript
it('translates a means-all multiselect panel to a real widget, not a placeholder', () => {
  const xml =
    '<dashboard><row><panel><chart><title>By category</title>' +
    '<search><query>index=web ($cat$="*" OR category="$cat$") | stats count by category</query></search>' +
    '<option name="charting.chart">bar</option></chart></panel></row></dashboard>';
  const widgets = translateWidgets(parseSimpleXml(xml).widgets);
  expect(widgets).toHaveLength(1);
  expect(widgets[0].outcome).not.toBe('placeholder');
  expect(widgets[0].query).toContain("'*' = {{cat}}");
});
```
  (Confirm `translateWidgets`/`parseSimpleXml` import names and the `outcome`/`query` field names against the file before writing — adjust to match.)

- [ ] **Step 4: Run, confirm red→green.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- translateWidgets` — the new assertion fails first only if a wiring gap exists; with PR 2 landed it should pass (the chokepoint sees a translated query, not unsupported). Investigate loudly if it placeholders.

- [ ] **Step 5: Regenerate `GAP_INVENTORY.md`.** Run the integration test locally (non-CI rewrites the file): `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- integration`. Confirm the new `synthetic/means-all-token.xml` row shows `placeholder: 0` and `dropped: 0`.

- [ ] **Step 6: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-dashboard-importer/test/integration/fixtures/synthetic/means-all-token.xml packages/nr-dashboard-importer/test/integration/GAP_INVENTORY.md packages/nr-dashboard-importer/test/translateWidgets.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "test: means-all panel now imports as a real widget"
```

---

### Task 4: Graduate (docs) (PR 4, optional)

**Scope:** ~30 lines. Promote validated cases, graduate the invariant, reclassify the laundry-list row. Dependency: PR 3 + staging validation (Task 2 Step 6).

**Files:**
- Modify: `test/spl/spl.test.js` (`verified: false` → `'llm'` for staging-validated cases)
- Modify: `.claude/rules/design-decisions.md` (add the invariant)
- Modify: `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` (reclassify the row) — **FLAG: this file is also edited by PR #72; rebase/coordinate to avoid a conflict.**

- [ ] **Step 1: Promote** the B′ cases in `test/spl/spl.test.js` from `verified: false` to `verified: 'llm'` (only those whose flipped NRQL + substitution were staging-confirmed in Task 2 Step 6). Leave the Option-A `unsupported` cases at `verified: false` (nothing to validate).

- [ ] **Step 2: Graduate the invariant** to `.claude/rules/design-decisions.md` under a new bullet in the "SPL Grammar Leniency" or "WHERE Comparison RHS" section:

```markdown
- **Token in comparison LHS/field position**: the grammar accepts a `template_variable`
  in comparison LHS — base `comparison` and pipeline `where_comparison` each gain a
  token-LHS alternative producing `Comparison{ lhsToken: TemplateVariable }` (NOT a string
  `field`). `splToIR`'s `case 'Comparison'` intercepts `node.lhsToken` FIRST (before the
  string-`field` paths, which would throw on an object). An **equality** (`=`/`!=`) with one
  non-token operand → **B′ mechanical operand flip** `BinOp(op, Literal(value,'string'),
  Identifier('{{tok}}'))` (`$tok$="*"` → `'*' = {{tok}}`), with a `means_all_token` warning
  when the literal is the `*` sentinel. A non-equality operator or token-vs-token →
  `token_lhs_unsupported` (loud; never a `{{tok}}` in field position — NR substitutes
  variables in value position only). The grammar change touches ONLY inputs that previously
  parse-errored (base) or degraded to `UnsupportedCommand` (where).
```

- [ ] **Step 3: Reclassify the laundry-list row** in `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` — the `supported-command-reported-unsupported` row: mark the isolated `$token$`-in-LHS trigger as **fixed** (B′ flip + grammar), noting the row may still cover other (not-yet-isolated) triggers if the corpus shows them.

- [ ] **Step 4: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/test/spl/spl.test.js .claude/rules/design-decisions.md docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: graduate token-in-LHS parser robustness"
```

---

## Global Verification

- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm test` — full workspace suite green (both packages).
- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check` — clean (generated `splParser.js` is excluded from both).
- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers` then `git status` — regenerated `splParser.js` is committed; working tree clean.
- [ ] Fuzz ×20 green (Task 1 Step 8 and Task 2 Step 7).
- [ ] Staging re-validation of the `'*' = {{tok}}` shape + dashboardCreate substitution (Task 2 Step 6) recorded in the PR.
- [ ] Open the PR(s) (per the stacked-PR breakdown); invoke `write-gooder` for each body (100–200 words, summary + test plan).

## Self-Review

1. **Spec coverage:** grammar accepts token LHS in BOTH positions + loud clause-level unsupported (Task 1 — spec PR 1) ✓; B′ operand flip + `means_all_token`, A for un-flippable (Task 2 — spec PR 2) ✓; importer integration + GAP regen (Task 3 — spec PR 3) ✓; graduate + laundry-list reclass (Task 4 — spec PR 4) ✓. All five acceptance-criteria rows have a matching `cases` entry.
2. **Loud-failure:** un-flippable token-LHS (non-equality / token-vs-token) → `token_lhs_unsupported` (returns null after pushing); never a `{{tok}}` in field position.
3. **Type consistency:** grammar emits `lhsToken` (a `TemplateVariable` node), intercepted FIRST so the string-`field` paths never see an object. B′ builds `BinOp(op, Literal(value,'string'), Identifier(\`{{${tok}}}\`))` — `BinOp`/`Literal`/`Identifier` match `src/ir/nodes.js` and are already imported.
4. **Message consistency:** two new keys (`token_lhs_unsupported`, `means_all_token`) referenced in the `cases` arrays; the spl.test.js per-case spy check enforces existence + exhaustiveness (an undefined key fails; an unlisted fired message fails).
5. **Grammar safety:** the token-LHS alternatives only match `$name$ op …` — inputs that previously errored/degraded. `search_field`/`field_name` never match `$`, so no previously-successful parse changes; fuzz ×20 is the net.

## Double-check targets (flagged uncertainties)

1. **Lead-steer vs spec mismatch (resolve before building).** The assignment said "B′ as the default for *numeric operations* … plus a *multiple-rename guard*." The spec keys B′ on **equality** (not numeric type) and contains **no** rename guard; the grammar `rename`/`as`-pair rules are untouched by a comparison-LHS fix. This plan follows the spec. **Confirm with the lead** whether (a) "numeric operations" was shorthand for "equality" (assumed yes), and (b) the "multiple-rename guard" is a real requirement from elsewhere or a stray phrase.
2. **`$tok$ = field` (RHS-as-identifier) interpretation.** The spec's prose lists `$tok$ = field → field = {{tok}}` (RHS as a *field identifier*). This plan flips RHS-as-**literal** (`'field' = {{tok}}`), because base-search comparison RHS values are literals (not field references) and no acceptance row tests field-to-field. If field-identifier RHS is required (mainly a `where` concern), the handler needs to distinguish a bare field name from a literal — defer unless the corpus shows demand. **Decide before promoting past `verified:false`.**
3. **OR-group parenthesization + `SELECT`/`FROM` shape.** The expected `nrql` strings (`WHERE ('*' = {{cat}} OR category = {{cat}})`, `SELECT *` for where-only) are best-effort. NRQL OR binds tighter than AND, so the emitter may render the standalone OR group without parens. **Byte-match via `node bin/spl2nrql.js` (Task 2 Step 5) and fix the test strings** — do not assume.
4. **Means-all sentinel = `*` only.** The spec notes the all-sentinel is "conventionally `*` but not always (some dashboards use `\"ALL\"`)". This plan fires `means_all_token` only for the literal `*`; a non-`*` literal still flips mechanically (correct NRQL, no warning). Broadening sentinel detection risks misclassifying a real value `"ALL"` — keep narrow unless corpus evidence says otherwise.
5. **Importer field-name vs query-name fields (Task 3).** The explicit `translateWidgets` assertion assumes `widget.outcome` and `widget.query`. Confirm the actual field names in `translateWidgets.test.js`/the widget model before writing the assertion; adjust if they differ.
6. **`$tok$ IN (...)` is out of scope.** Only `comparison`/`where_comparison` gain token-LHS; a token in `in_comparison` LHS (`$tok$ IN (a,b)`) still won't parse. Flag as a known limitation; no corpus demand cited.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-06-28-token-in-lhs-parser-robustness.md`. Branch `feat/token-in-lhs` is cut off `master` **after PR #72 lands** (it edits the shared laundry-list spec — Task 4). Run `/double-check` on this plan first (clean-room test list for the grammar + B′/A behavior; pay attention to Double-check target #1, the lead-steer mismatch, and #3, the byte-match). Then execute task-by-task via subagent-driven-development. The four tasks map 1:1 to the spec's PR breakdown (PRs 1–4); PR 4 (graduate) is optional and gated on staging validation.
