# Importer Sweep Bug Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. **Worktree caveat:** commits must be made by the controller, not by subagents (subagents in a worktree commit to the wrong branch — see project memory).

**Goal:** Close the 14 pending canaries from the 2026-06-18 integration sweep (8 bugs + 2 time-token rules) so the Splunk dashboard importer never emits silently-wrong output.

**Architecture:** BUG1 is a translator (`@newrelic/query-bridge`) grammar+IR change; the rest are importer-only. `translateWidgets` becomes the single placeholder chokepoint, fed by a new first-class `Widget.unsupportedReason`. The translator stays dashboard-agnostic.

**Tech Stack:** Pure ESM JS, Peggy grammar (`npm run build:parsers` after grammar edits), Vitest, fast-xml-parser (importer only), Terraform `newrelic/newrelic` provider for validation.

## Global Constraints

- Dev requires Node 24: prefix every command `ASDF_NODEJS_VERSION=24.14.0 <cmd>`.
- Commit messages: lowercase subject ≤72 chars; body lines ≤100 (commitlint); conventional (`feat:`/`fix:`/`chore:`); use `git commit -F <file>` for multi-line bodies.
- NRQL is built only via the query builders / `nrqlEncoding.js` — never string concatenation.
- Loud failure over silent wrong: an untranslatable widget becomes a markdown placeholder, never a dropped or silently-wrong widget.
- AI-DEV markers go on a test ONLY after it passes the full red-green (or mutation) cycle — never cargo-culted.
- `verified` may only be set to `false` by AI; humans promote to `'llm'`/`'human'`.
- After any grammar change: `npm run build:parsers`, then the full `spl` suite + fuzz/corpus.
- Branch `fix/importer-sweep-bugs` is cut from the PR #35 HEAD (canaries live there); rebase onto `master` once #35 merges. Sidekick review required (S-5).

---

## File map

- `packages/nr-query-bridge/src/input/spl/spl.grammar` — `search_value`, WHERE RHS, `template_var_name`, `time_constraint` (token recognition; `TimeToken`).
- `packages/nr-query-bridge/src/input/spl/splToIR.js` — Comparison handler (TemplateVariable RHS → `Identifier({{name}})`); TimeToken/time-bound drop.
- `packages/nr-query-bridge/test/spl/spl.test.js` — translator token unit cases.
- `packages/nr-dashboard-importer/src/model.js` — add `Widget.unsupportedReason`.
- `packages/nr-dashboard-importer/src/parseSimpleXml.js` — classify-every-viz, panel title, per-panel time, fieldset/inputs, base resolution.
- `packages/nr-dashboard-importer/src/translateWidgets.js` — placeholder chokepoint; empty-query; dynamic-variable source translation.
- `packages/nr-dashboard-importer/src/emitTerraform.js` — WIDGET_BLOCK extension + loud throw + emittable-set export; `variableBlock()`.
- `packages/nr-dashboard-importer/test/integration/dashboards.integration.test.js` — the 14 canaries (un-skip per task) + new canaries.
- `packages/nr-dashboard-importer/test/**/*.test.js` — parser/emitter/translate units.

---

## Phase 0 — Recon (verify at HEAD before building)

### Task 0: Establish the true starting state

The experts flagged that some "fixes" may already be shipped. Measure before building.

- [ ] **Step 1: Run every canary to record current pass/fail.** Temporarily un-skip all 14 (`it.skip`→`it`) in the integration suite, run `ASDF_NODEJS_VERSION=24.14.0 npm run test -- dashboards.integration`, and record which already pass. Re-skip afterward (revert — this is measurement, not a commit).
- [ ] **Step 2: Probe the token + time-token paths directly.** Run:
  - `node packages/nr-query-bridge/bin/spl2nrql.js "index=app environment=\$env\$ | stats count by host"`
  - `node packages/nr-query-bridge/bin/spl2nrql.js "index=app earliest=\$tr.earliest\$ | timechart count"`
  - `node packages/nr-query-bridge/bin/spl2nrql.js "index=app | timechart span=\$sp\$ count"`
  Record exactly what each emits (quoted `'$..$'`? dropped? unsupported?).
- [ ] **Step 3: Confirm token charset.** Grep `template_var_name` in `spl.grammar`; confirm whether `.:-_` are already allowed (expert says yes, ~L1255).
- [ ] **Step 4: Record findings** in a scratch note (not committed). This determines whether Task 3 (TimeToken) fixes a leak or hardens an existing drop, and whether the charset edit is a no-op. No commit.

---

## Phase 1 — Tokens + time tokens (translator)

### Task 1: Value-position tokens → `{{tok}}` (BUG1, canaries 1a/1b)

**Files:**
- Modify: `packages/nr-query-bridge/src/input/spl/spl.grammar` (`search_value`; WHERE `where_value`; `template_var_name` only if Phase 0 shows `.:-` missing)
- Modify: `packages/nr-query-bridge/src/input/spl/splToIR.js` (Comparison handler ~L372-440)
- Test: `packages/nr-query-bridge/test/spl/spl.test.js`; canaries 155/164

**Interfaces:**
- Produces: a `TemplateVariable` AST node from `search_value`; `splToIR` maps a `TemplateVariable` comparison RHS to `BinOp(op, Identifier(field), Identifier("{{"+name+"}}"))` — no `numeric()` coercion. Consumed downstream by the existing `irToNrql` `{{`-passthrough.

- [ ] **Step 1: Add translator unit cases (failing).** In `spl.test.js`, add cases: `index=$idx$` → `… WHERE index = {{idx}}`; `environment=$env_tok$` → `… WHERE environment = {{env_tok}}`; `where env=$tok$` → `{{tok}}`. (`verified: false`.)
- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl` → these cases FAIL (emit `'$idx$'`).
- [ ] **Step 3: Grammar — add token alternative to `search_value`.** Add `template_variable` as the FIRST alternative of `search_value` (before the `search_value_char+` catch-all). Add it on the bare `where_value` fallback (last position) for WHERE RHS. `npm run build:parsers`.
- [ ] **Step 4: splToIR — handle TemplateVariable RHS.** In the Comparison handler, before `buildComparison`: if the value node is `{type:'TemplateVariable', name}`, return `BinOp(op, Identifier(field), Identifier("{{"+name+"}}"))`.
- [ ] **Step 5: Run, confirm green.** `npm run test -- spl` (the new units) + un-skip canaries 1a/1b → `npm run test -- dashboards.integration` → PASS.
- [ ] **Step 6: Full regression.** `npm run test -- spl` (whole suite + fuzz) → no regressions on quoted values, `!=`, separators.
- [ ] **Step 7: AI-DEV markers + commit.** Add markers to the now-green canaries and units. `git add` grammar, splParser.js, splToIR.js, tests; commit `fix: emit value-position dashboard tokens as {{tok}} not quoted literal`.

### Task 2: Quoted standalone token `field="$tok$"` (new canary)

**Files:** same grammar/test files.

- [ ] **Step 1: Add a canary (failing).** `index=app environment="$env$" | stats count` → `… WHERE environment = {{env}}` (not `'$env$'`).
- [ ] **Step 2: Run, confirm red.** The double-quoted `search_value` alternative consumes `"$env$"` as a literal first.
- [ ] **Step 3: Implement.** In the `search_value` quoted-string actions (or splToIR), detect a quoted body matching exactly `^\$[A-Za-z0-9_.:-]+\$$` and route to the `{{name}}` path. Prefer doing it in `splToIR` (the quoted string is already a plain value there) to keep the grammar simple: where a string `Literal` value matches that exact pattern in a comparison RHS, emit `Identifier({{name}})`. `npm run build:parsers` if grammar touched.
- [ ] **Step 4: Run, confirm green.** Canary + units PASS; full `spl` suite green.
- [ ] **Step 5: AI-DEV + commit.** `fix: treat a fully-quoted "$tok$" as a template variable`.

### Task 3: Time-token drop — `earliest=$tok$` (canary 5) + TimeToken node

**Depends on Phase 0.** If canary 5 is already green at HEAD, this task *hardens* the existing `TimeConstraint` drop into a typed `TimeToken` node and verifies BUG1's `search_value` change didn't open a leak; it does not fix a regression.

**Files:** `spl.grammar` (`time_constraint`), `splToIR.js` (time-bound drop ~L505), tests.

- [ ] **Step 1: Un-skip canary 5; run.** Record red/green. Also add a unit: `index=app earliest=$tr.earliest$ | timechart count` → no `SINCE`, warning `time_token_bound_dropped` (or equivalent).
- [ ] **Step 2: If green at HEAD —** add an AI-DEV note at the drop site (`splToIR` ~L505) stating the time token MUST be dropped, never emitted, then go to Step 5. If red — proceed to Step 3.
- [ ] **Step 3: Mint `TimeToken`.** In `spl.grammar`, where `earliest`/`latest`/`*.earliest`/`*.latest` is compared to a `$tok$`, produce `{type:'TimeToken', field, name}`. `npm run build:parsers`.
- [ ] **Step 4: Drop in splToIR.** Handle `TimeToken`: push the `time_token_bound_dropped` warning, emit no node. Add the AI-DEV note.
- [ ] **Step 5: Run, confirm green** (canary 5 + unit); full `spl` suite green.
- [ ] **Step 6: AI-DEV + commit.** `fix: drop dashboard time tokens (earliest/latest=$tok$) loudly, never to SINCE`.

### Task 4: `span=$tok$` → placeholder (canary 6)

**Depends on Phase 0.** Likely already `unsupported` at the translator (`span_token_unsupported`); this task confirms the importer placeholders it.

- [ ] **Step 1: Un-skip canary 6; run.** Record. The canary asserts `outcome:'placeholder'`, no `TIMESERIES`.
- [ ] **Step 2: If translator already emits `unsupported`** for `span=$tok$`, the chokepoint (Task 5) will placeholder it — order this after Task 5 and just confirm green. If the translator does NOT, add `span_token_unsupported` emission in the timechart-option handler.
- [ ] **Step 3: Run, confirm green.**
- [ ] **Step 4: AI-DEV + commit.** `fix: escalate span=$tok$ timechart to a placeholder`.

---

## Phase 2 — Chokepoint + correctness cluster (importer)

### Task 5: `Widget.unsupportedReason` + the placeholder chokepoint + empty query (BUG8, canary 11)

**Files:**
- Modify: `packages/nr-dashboard-importer/src/model.js` (Widget typedef + `createWidget`)
- Modify: `packages/nr-dashboard-importer/src/translateWidgets.js`
- Modify: `packages/nr-dashboard-importer/src/emitTerraform.js` (export emittable set)
- Test: canary 326; `test/translateWidgets.test.js`

**Interfaces:**
- Produces: `Widget.unsupportedReason: string|null`; `EMITTABLE_VIZ_TYPES` (Set) exported from `emitTerraform.js`; `translateWidgets` placeholders a widget when `unsupportedReason` is set OR `rawSpl` is empty OR translation returns unsupported/errors OR `vizType ∉ EMITTABLE_VIZ_TYPES`.

- [ ] **Step 1: Un-skip canary 11 (empty query); run → red.** It expects `outcome:'placeholder'`; today empty SPL → `FROM Log SELECT *`.
- [ ] **Step 2: Add the field.** `model.js`: add `@property {string|null} unsupportedReason` to the Widget typedef and `unsupportedReason: fields.unsupportedReason ?? null` to `createWidget`.
- [ ] **Step 3: Export emittable set.** `emitTerraform.js`: `export const EMITTABLE_VIZ_TYPES = new Set(Object.keys(WIDGET_BLOCK));` (after WIDGET_BLOCK is extended in Task 8 this set grows automatically).
- [ ] **Step 4: Extend the chokepoint.** In `translateWidgets`, before translating: if `widget.unsupportedReason` → placeholder (reason = it); if `widget.rawSpl.trim() === ''` → placeholder (reason "empty query"); after translating, if `!EMITTABLE_VIZ_TYPES.has(widget.vizType)` and not already a placeholder → placeholder (reason "no New Relic equivalent for <type> charts"). Keep the existing translation-failure branch.
- [ ] **Step 5: Run → green** (canary 11 + a `translateWidgets` unit for each new branch).
- [ ] **Step 6: AI-DEV + commit.** `feat: add unsupportedReason and unify the placeholder chokepoint`.

### Task 6: No silent viz-type drops (BUG3, canary 8)

**Files:** `parseSimpleXml.js`; canary 285; `test/parseSimpleXml.test.js`.

- [ ] **Step 1: Un-skip canary 8 (event panel); run → red.** Today the `['chart','table','single']` loop skips `<event>` entirely → no widget.
- [ ] **Step 2: Implement classify-every-child.** Replace the hardcoded tuple loop: iterate the panel's element children; map `chart`/`table`/`single` to real widgets (existing logic); for `event`/`map`/`html`/`viz`/`list` create a widget with `unsupportedReason: "<tag> panels are not supported"` and `vizType:'unknown'` (or `'map'` for `<map>`), `rawSpl: queryOf(el)` when present; skip non-viz children (`title`, `input`, `search`, `fieldset`) by name.
- [ ] **Step 3: Run → green** (canary 8 + a parser unit asserting an event panel yields a placeholder-bound widget, not a drop).
- [ ] **Step 4: AI-DEV + commit.** `fix: emit placeholders for unsupported panel viz types, never drop`.

### Task 7: Panel-level title fallback (BUG4, canary 9)

**Files:** `parseSimpleXml.js`; canary 295; parser test.

- [ ] **Step 1: Un-skip canary 9; run → red.** Panel-level `<title>` ignored when viz has none.
- [ ] **Step 2: Implement.** Compute `panelTitle` (string-or-`#text` of `panel.title`); widget title = `vizTitle || panelTitle || ''`.
- [ ] **Step 3: Run → green** (canary 9 + a parser unit for each of: viz-only title, panel-only title, both → viz wins, neither → '').
- [ ] **Step 4: AI-DEV + commit.** `fix: fall back to panel-level title when the viz has none`.

### Task 8: Real widget blocks; invalid HCL gone (BUG2, canary 7)

**Files:** `emitTerraform.js`; canary 273; `test/emitTerraform.test.js`.

**Interfaces:** `WIDGET_BLOCK` gains `area`/`bar`/`column`/`pie`; the `?? 'widget_markdown'` fallback becomes a throw.

- [ ] **Step 1: Un-skip canary 7 (pie); run → red.** Pie → `widget_markdown { nrql_query }` (invalid HCL).
- [ ] **Step 2: Extend the map.** `WIDGET_BLOCK`: add `area:'widget_area', bar:'widget_bar', column:'widget_bar', pie:'widget_pie'`. (`EMITTABLE_VIZ_TYPES` from Task 5 picks these up.)
- [ ] **Step 3: Make the fallback loud.** Replace `const block = WIDGET_BLOCK[widget.vizType] ?? 'widget_markdown'` with: if vizType is `markdown` → `widget_markdown`; else `const block = WIDGET_BLOCK[widget.vizType]; if (!block) throw new Error('unmappable vizType reached emit: ' + widget.vizType)`. (scatter/map/unknown were placeholdered by the chokepoint, so they arrive as `markdown`.)
- [ ] **Step 4: Run → green** (canary 7; emitTerraform units: pie→`widget_pie`+`nrql_query`; a clean `scatter` widget is placeholdered upstream so emits `widget_markdown`+`text`; `terraform validate` on an area/bar/pie dashboard).
- [ ] **Step 5: AI-DEV + commit.** `fix: emit real widget blocks for area/bar/column/pie; throw on unmappable`.

---

## Phase 3 — Time handling (importer)

### Task 9: Per-panel `<search><earliest>/<latest>` → SINCE (BUG5, canary 4)

**Files:** `parseSimpleXml.js` (`queryOf`); canary 233; parser test.

- [ ] **Step 1: Un-skip canary 4; run → red.** SINCE missing.
- [ ] **Step 2: Implement.** In `queryOf` (or the widget build), read `<search><earliest>`/`<latest>` siblings; if literal, append ` earliest=<v> latest=<v>` to the returned SPL so the translator's existing `earliest=`→SINCE path applies. A `$tok$` value rides the Task-3 TimeToken drop (no leak).
- [ ] **Step 3: Run → green** (canary 4 + a parser unit: literal earliest/latest appended; token earliest dropped).
- [ ] **Step 4: AI-DEV + commit.** `fix: fold per-panel search earliest/latest into the query for SINCE`.

### Task 10: Time `<input>` default → `defaultTimeRange` (BUG5/6, canary 3)

**Files:** `parseSimpleXml.js`; canary 215; parser test. (Capture only — no emit slot.)

- [ ] **Step 1: Un-skip canary 3; run → red.** `defaultTimeRange` stays null.
- [ ] **Step 2: Implement.** Parse `<fieldset>/<input type="time"><default><earliest>/<latest>` → `model.defaultTimeRange = {earliest, latest}`.
- [ ] **Step 3: Run → green** (canary 3 + parser unit).
- [ ] **Step 4: AI-DEV + commit.** `feat: capture dashboard time-input default into defaultTimeRange`.

---

## Phase 4 — Template variables (importer)

### Task 11: Parse fieldset/inputs → `model.variables` (static enum + text) (BUG6, canaries 2a/2b)

**Files:** `parseSimpleXml.js`; canaries 176/189; parser test.

**Interfaces:** Produces `model.variables` entries: dropdown+static `<choice>` → `{name, type:'enum', choices:[{value,title}], defaultValue, multi:false, sourceQuery:null}`; text → `{name, type:'string', defaultValue}`. (`name` = the input `token` attribute.)

- [ ] **Step 1: Un-skip canaries 2a/2b; run → red.** `model.variables` empty.
- [ ] **Step 2: Implement parsing.** Walk `<fieldset>/<input>`: branch on `@_type` (`dropdown`/`text`/`time`/`multiselect`); time → Task 10's path; dropdown with `<choice>` → enum; dropdown with `<search>` → enum with `sourceQuery` = inner query (Task 13); text → string. Capture `<default>`.
- [ ] **Step 3: Run → green** (canaries 2a/2b + parser units for dropdown-static and text).
- [ ] **Step 4: AI-DEV + commit.** `feat: parse dashboard fieldset inputs into model variables`.

### Task 12: Emit static `variable {}` blocks (BUG6, canary 2c)

**Files:** `emitTerraform.js`; canary 199; `test/emitTerraform.test.js`.

**Interfaces:** `variableBlock(v)` renders an HCL `variable {}` sibling of `page {}`. Static enum: `name`, `title`, `type = "enum"`, `default_values = ["…"]`, `item { value title }` per choice, `replacement_strategy`. String: `type = "string"` + `default_values`. Use a dedicated `account_ids = [<id>]` **list** renderer for nrql variables (NOT the singular widget `accountIdLine`).

- [ ] **Step 1: Un-skip canary 2c; run → red.** No `variable {` block emitted.
- [ ] **Step 2: Implement `variableBlock()` + wire into `emitTerraform`** (render all `model.variables` after the `page {}` block).
- [ ] **Step 3: `replacement_strategy` per-position.** Default `"string"`; if a variable's token is used ONLY in numeric comparisons across panels → `"number"`. (Scan widget rawSpl for `name=<numeric-RHS>` vs `name=<string>`; document the mixed-position residual silent-zero.)
- [ ] **Step 4: Run → green** (canary 2c + emitTerraform units asserting the FULL block shape: enum with items, string, and a numeric token → `number`). `terraform validate` with a static enum + string variable.
- [ ] **Step 5: AI-DEV + commit.** `feat: emit Terraform variable blocks for dashboard inputs`.

### Task 13: Dynamic (search-backed) dropdown → `type="nrql"` (single-field only)

**Files:** `translateWidgets.js` (translate variable `sourceQuery`); `emitTerraform.js` (`type="nrql"` branch); new canary; tests.

- [ ] **Step 1: Add a canary (failing).** A dropdown backed by `<search><query>… | stats count by host</query></search>` → a `type = "nrql"` variable whose `nrql_query.query` is the single-field source; a multi-field `by` dropdown → placeholder/warn.
- [ ] **Step 2: Run → red.**
- [ ] **Step 3: Implement.** In `translateWidgets`, translate each variable `sourceQuery` SPL→NRQL. Accept only when it reduces to one field's distinct values (single `FACET` or rewrite to `SELECT uniques(field)`); otherwise mark the variable unsupported (warn, drop to a static/empty enum or omit). Emitter: when a variable has translated nrql → `type="nrql"` + `nrql_query { account_ids=[…] query=… }`.
- [ ] **Step 4: Run → green** (canary + units: single-field accepted, multi-field rejected).
- [ ] **Step 5: AI-DEV + commit.** `feat: support single-field search-backed dropdowns as nrql variables`.

### Task 14: Multiselect + `*`-means-all (new canaries)

**Files:** `parseSimpleXml.js`, `emitTerraform.js`, `translateWidgets.js`; new canaries; tests.

- [ ] **Step 1: Add canaries (failing).** (a) `<input type="multiselect" token="hosts">` used as `host=$hosts$` → either `host IN ({{hosts}})` + `is_multi_selection = true`, or a placeholder; plain `host = {{hosts}}` is wrong. (b) A dropdown with `<default>*</default>` → a warning that `field = '*'` matches the literal `*`, not "all".
- [ ] **Step 2: Run → red.**
- [ ] **Step 3: Implement.** Multiselect → set `multi:true`; emit `is_multi_selection = true` and (where the token is used in a comparison) rewrite to `IN ({{tok}})`, else placeholder. `*` default → emit a warning (message catalog) flagging the literal-match mismatch.
- [ ] **Step 4: Run → green** (canaries + units).
- [ ] **Step 5: AI-DEV + commit.** `feat: handle multiselect inputs and warn on Splunk *-means-all defaults`.

---

## Phase 5 — Base search / post-process (BUG7)

### Task 15: Resolve base searches; compose non-transforming, placeholder the rest (canary 10)

**Files:** `parseSimpleXml.js`; canary 309; parser test.

**Interfaces:** A document-wide first pass builds an `id → query` map from every `<search id="…">` (global + inline). A panel `<search base="id">` composes `base | post-process` into `rawSpl` and records `baseRef`.

- [ ] **Step 1: Un-skip canary 10; run → red.** Base scope lost.
- [ ] **Step 2: Collect the id map** document-wide (walk the whole tree, not just panel descendants).
- [ ] **Step 3: Compose or placeholder.** For a panel with `base="id"`: if the resolved base is **non-transforming** (no `stats`/`timechart`/`chart`/`top`/`rare`/`dedup`/`eval`), set `rawSpl = baseQuery + ' | ' + stripLeadingPipe(postProcess)`. Otherwise — or if the id is missing, is a `ref=` saved-search reference, or is itself chained (`<search id base=>`) — set `unsupportedReason` (placeholder). Record `baseRef` either way.
- [ ] **Step 4: Run → green** (canary 10 + parser units: non-transforming base composes; transforming base → placeholder; missing id → placeholder; `ref=` → placeholder).
- [ ] **Step 5: AI-DEV + commit.** `fix: resolve non-transforming base searches; placeholder transforming/unresolvable`.

---

## Self-review

- **Spec coverage:** every spec section maps to a task — BUG1→T1/T2, time tokens→T3/T4, chokepoint+BUG8→T5, BUG3→T6, BUG4→T7, BUG2→T8, BUG5→T9, BUG5/6→T10, BUG6→T11/T12/T13, expert new-canaries→T2/T13/T14, BUG7→T15. Phase 0 covers verify-at-HEAD.
- **Placeholders:** none — every task names exact files and references the existing canary (the test) or gives the new canary's assertion; implementation steps name the exact function/rule and approach. Grammar/IR code is described precisely rather than pre-written because Phase 0 red-tests determine the exact current behavior (pre-writing unvalidated PEG would be a fabrication).
- **Type consistency:** `unsupportedReason` (T5) consumed by T6/T13/T15; `EMITTABLE_VIZ_TYPES` (T5) consumed by T8; `Variable` fields (T11) consumed by T12/T13/T14; `baseRef`/`rawSpl` (T15) flow into the existing translate stage.

## Execution handoff

Per the worktree caveat, the **controller** runs each step and makes every commit (no subagent commits). Execution is inline (this session), batch with red-green checkpoints per task. Phase 0 runs first and may collapse Tasks 3/4 to confirmations.
