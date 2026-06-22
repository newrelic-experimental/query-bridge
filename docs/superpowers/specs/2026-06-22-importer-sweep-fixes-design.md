# Design: fix the 8 importer bugs from the 2026-06-18 integration sweep

## Context

The 2026-06-18 integration sweep (PR #35) added 14 `it.skip` canaries to
`packages/nr-dashboard-importer/test/integration/dashboards.integration.test.js`
plus a `GAP_INVENTORY.md`, pinning every known gap to a failing test. The canaries
cover **8 numbered bugs plus 2 time-token rules**. Several bugs make the importer
emit **silently-wrong output** — which violates the project's first principle,
"loud failure over silent wrong results." The rest are missing features (template
variables, time handling, base searches).

The goal is to close all 14 canaries. This is one spec by explicit choice; it is
built in dependency order (see Sequencing) so the suite stays green at each step.

## The 14 canaries → bugs

| Canary (line) | Bug |
|---|---|
| 155, 164 | **BUG1** value-position tokens (`field=$tok$`, `index=$tok$`) emit `'$tok$'` not `{{tok}}` |
| 176, 189, 199 | **BUG6** `<fieldset>/<input>` never parsed into variables; no Terraform `variable {}` blocks |
| 215 | **BUG5/6** time `<input>` default never captured into `defaultTimeRange` |
| 233 | **BUG5** per-panel `<search><earliest>/<latest>` ignored (no SINCE) |
| 247 | time rule: inline `earliest=$tok$` must be dropped, never leaked to SINCE |
| 259 | time rule: `span=$tok$` must escalate to a placeholder, no TIMESERIES |
| 273 | **BUG2** area/bar/column/pie/scatter emit `widget_markdown { nrql_query }` (invalid HCL) |
| 285 | **BUG3** event/map/html panels silently dropped |
| 295 | **BUG4** panel-level `<title>` ignored (only viz-level read) |
| 309 | **BUG7** base-search / post-process loses the base scope |
| 326 | **BUG8** empty `<query>` becomes a clean `SELECT *` instead of a placeholder |

## Decisions (resolved during brainstorming)

1. **Scope:** all 8 bugs / 14 canaries in one spec.
2. **Token fix (BUG1):** parse-time. Reuse the existing `template_variable` grammar
   rule inside `search_value` (and the WHERE RHS), producing a typed node — not a
   string heuristic at IR or emit time.
3. **Placeholder signal:** a new first-class `Widget.unsupportedReason: string|null`.
   `translateWidgets` becomes the single placeholder chokepoint.
4. **Time tokens:** a distinct `TimeToken` AST node, minted by the grammar for
   `earliest=`/`latest=` + `$tok$`, dropped unconditionally in `splToIR`. The drop
   is structural, guarded by an AI-DEV note + canary 5 + a unit test.
5. **Base search (BUG7):** lexical compose `base | post-process` into one SPL string,
   translated in a single call; placeholder fallback when unresolvable.
6. **Dynamic variables (BUG6):** full support — a search-backed dropdown's inner SPL
   is translated to NRQL and emitted as `type="nrql"`.

## Verified facts (provider + NerdGraph schema, 2026-06-22)

- **Widget blocks** (`newrelic/terraform-provider-newrelic` `one_dashboard`): real
  blocks include `widget_area`, `widget_bar`, `widget_billboard`, `widget_line`,
  `widget_markdown`, `widget_pie`, `widget_stacked_bar`, `widget_table`. **No
  `widget_column`, no `widget_scatter`.** All chart blocks use `nrql_query`.
- **`variable {}` schema** (corroborated by NerdGraph `DashboardVariableInput`):
  `name` (req), `type` (`enum`|`nrql`|`string`), `title`, `default_values` (list),
  `is_multi_selection`, `item { value, title }` (enum), `nrql_query { account_ids,
  query }` (nrql — note `account_ids` is a **list**, unlike widgets' `account_id`),
  `replacement_strategy` (`default`|`identifier`|`number`|`string`).
- **No dashboard-level time range.** NerdGraph `DashboardInput` is only
  Description/Name/Pages/Permissions/Variables; `DashboardPageInput` is
  Description/GUID/Name/Widgets. The only time-window in the schema is
  `DashboardSnapshotURLTimeWindowInput` (snapshot/live-URL links — a separate
  mutation) and per-variable `ignoreTimeRange`. So `defaultTimeRange` is **captured
  only** (canary 3); there is no slot to emit it to.

## Architecture & data flow

The pipeline is unchanged: `parseSimpleXml → DashboardModel → translateWidgets →
emitTerraform`. No new stage. The model already declares `variables`,
`defaultTimeRange`, `baseRef`, a `Variable` typedef, and a `VIZ_TYPES` enum that
includes area/bar/column/pie/scatter/map — only `Widget.unsupportedReason` is new.

**Package boundary.** BUG1 is the only translator (`@newrelic/query-bridge`) change.
Everything else is importer-only. The translator stays a pure, dashboard-agnostic
SPL→NRQL function — it never learns what a token, time range, or base search *means*
to a dashboard.

**`translateWidgets` is the single placeholder chokepoint.** A widget becomes a
markdown placeholder if any of: (1) the parser set `unsupportedReason`; (2) `rawSpl`
is empty; (3) the translator returns `unsupported`/`errors` (today's only trigger);
(4) the `vizType` has no NR widget block. Otherwise it is clean. Condition (4)
consults the emittable-vizType set **exported from the emitter**, so parser,
translateWidgets, and emitter never disagree.

## Translator changes — BUG1 + TimeToken (`@newrelic/query-bridge`)

**Root cause.** A bare `$tok$` parses as a `TemplateVariable` node and emits `{{tok}}`.
But in `field=$tok$`, the RHS is parsed by `search_value` (`spl.grammar` ~L1380),
which has no template-variable alternative, so `$tok$` falls through to a plain
string → `Literal('string')` → quoted `'$tok$'` by `irToNrql`.

**Grammar (`spl.grammar`).** Reusing the existing `template_variable` rule:
- Add `template_variable` as the **first** alternative in `search_value` (before the
  `search_value_char+` catch-all that currently eats `$tok$`).
- Add it to the WHERE RHS on the bare `where_value` fallback (kept last, per the
  precedence invariant — a specific `$…$` pattern, not a tier widening).
- Widen `template_var_name` to permit **dots, hyphens, colons** (plus alphanumerics
  and underscore). `$tr.earliest$`, `$cluster-id$`, `$ns:token$` all parse; the
  `$…$` delimiters keep it unambiguous.
- For `earliest=`/`latest=`/`*.earliest`/`*.latest` + a token, the comparison rule
  mints a distinct **`TimeToken`** node instead of a plain comparison.

**`splToIR.js`.** Comparison handler (~L372–440): a `TemplateVariable` RHS builds
`BinOp(op, Identifier(field), Identifier("{{"+name+"}}"))` directly — bypassing
`buildComparison`'s `Literal` path and applying **no** `numeric()` coercion. A
`TimeToken` node is dropped: push a warning, emit nothing. The drop carries an
AI-DEV note so it is never "optimized" into emitting.

**`span=$tok$`** is independent (parsed by the timechart-option rule as `SpanToken`
→ `span_token_unsupported`). Confirm it already emits `unsupported` (red first); the
chokepoint then placeholders it.

**Build + test.** `npm run build:parsers`; unit cases in `spl.test.js`
(`index=$tok$`→`index = {{tok}}`, `where env=$tok$`→`{{tok}}`, dotted/hyphen/colon
names, `earliest=$tok$`→dropped+warned, `span=$tok$`→unsupported); then the full
`spl` suite + fuzz/corpus, since `search_value` is the blast-radius path (quoted
values, `!=`, separator/quote-as-token-boundary leniency). Graduate the
design-decisions "Tokens emitted unquoted" bullet once green.

## Importer changes (`@newrelic/dashboard-importer`)

**Model (`model.js`).** Add `Widget.unsupportedReason: string|null` to the typedef
and `createWidget`. Existing fields (`variables`, `defaultTimeRange`, `baseRef`,
`Variable`, `VIZ_TYPES`) are reused as-is.

**Parser (`parseSimpleXml.js`).**
- **BUG3 — no silent drops.** Replace the hardcoded `['chart','table','single']`
  loop with a classify-every-viz-child walk. Supported (`chart`/`table`/`single`) →
  real widget; known-unsupported (`event`/`map`/`html`/`viz`/`list`) → widget with
  `unsupportedReason` set; non-viz children (`title`, `input`, `search`) skipped *by
  name*, never by silent fall-through.
- **BUG4 — panel-title fallback.** `panel` is in scope; widget title =
  `vizTitle || panelTitle || ''`.
- **BUG5 — per-panel time.** `queryOf` also reads `<search><earliest>/<latest>`
  siblings and folds literal values into the SPL string (`… earliest=<v> latest=<v>`)
  so the translator's existing `earliest=`→SINCE path applies. A `$tok$` value rides
  the TimeToken drop — no leak.
- **BUG5/6 — time input.** `<input type="time"><default><earliest>/<latest>` →
  `model.defaultTimeRange`. Capture only (no emit slot — see Verified facts).
- **BUG6 — variables.** `<fieldset>/<input>` → `model.variables`: dropdown + static
  `<choice>` → `{type:'enum', choices, defaultValue}`; dropdown + `<search>` →
  `{type:'enum', sourceQuery:<inner SPL>}`; text → `{type:'string', defaultValue}`.
- **BUG7 — base search.** First pass collects `<search id="…">` into an id→query map;
  a panel `<search base="id">` composes `base | post-process` into `rawSpl` and
  records `baseRef`. Unresolvable / nested / dynamic base → `unsupportedReason`.

**Translate stage (`translateWidgets.js`).**
- The single placeholder chokepoint (the four conditions above), including the
  empty-`rawSpl` check (BUG8).
- New: translate each dynamic variable's `sourceQuery` SPL→NRQL, attaching the result
  for the emitter (keeps the emitter pure).

**Emitter (`emitTerraform.js`).**
- **BUG2 — widget blocks.** `WIDGET_BLOCK` gains `area→widget_area`, `bar→widget_bar`,
  `column→widget_bar` (no `widget_column`), `pie→widget_pie`. `scatter`/`map`/
  `unknown` have no block → already placeholdered by the chokepoint, so the current
  `?? 'widget_markdown'` fallback becomes a **loud throw** (a clean widget with an
  unmappable vizType is a bug, not a silent markdown). Export the emittable-vizType
  set for the chokepoint.
- **BUG6 — variable blocks.** New `variableBlock()` rendered as siblings of `page {}`:
  static → `type="enum"` + `item{value,title}` + `default_values`; dynamic →
  `type="nrql"` + `nrql_query{account_ids=[…], query=<translated NRQL>}`; text →
  `type="string"`. `replacement_strategy="string"` so substituted values are quoted,
  matching the `field = {{tok}}` emission.

## Testing

- **Per-canary red-green.** Un-skip each canary → confirm red → fix → green. AI-DEV
  markers go on only *after* the cycle (never cargo-culted onto fresh tests).
- **Cleanroom independent list.** After this spec is committed and **before** any
  tests are built, a fresh subagent is fed **only the behavioral intent** (no code,
  no rule/field names) and asked to propose its own test cases. Its list is merged
  with the code-derived cases; every divergence is investigated. This guards against
  the code-under-test poisoning the tests.
- **Translator:** `spl.test.js` units (above) + full `spl` suite + fuzz/corpus.
- **Importer:** integration canaries end-to-end; `emitTerraform` units for the new
  widget + variable blocks; `parseSimpleXml` units for viz classification,
  panel-title, time-input, fieldset/inputs, base resolution.
- **`terraform validate`** (real `newrelic/newrelic` provider) on an emitted dashboard
  exercising area/bar/pie + variables.
- `GAP_INVENTORY.md` regenerates (CI asserts match); update the importer spec's
  "Verified gaps" as each closes. Full workspace suite green, no regressions.

## Sequencing

One spec, built in dependency order, suite green at each step:
1. **BUG1 tokens + TimeToken** (translator) — priority; the time-token guard lands
   with it.
2. **`Widget.unsupportedReason` + the translateWidgets chokepoint** — the backbone the
   correctness fixes depend on.
3. **BUG3 / BUG4 / BUG8 + BUG2 widget blocks** — correctness cluster.
4. **BUG5 + time input (BUG5/6)** — time handling.
5. **BUG6 variables** — parser + translate + emit.
6. **BUG7 base search.**

Lands after PR #35 merges (this branch is cut from its HEAD because the canaries live
on it; rebase onto `master` once #35 merges). Sidekick review required (S-5).

## Risks

- **`search_value` grammar blast radius** — guarded by the full `spl` suite + fuzz/
  corpus after `build:parsers`.
- **`TimeToken` must drop on every path** — AI-DEV note + canary 5 + a unit test.
- **Dynamic-variable inner-search translation** may surface translator edge cases (the
  inner SPL is arbitrary); de-scope to a warning-and-skip if it balloons.
- **`replacement_strategy` correctness** — schema confirms only
  `default`/`identifier`/`number`/`string`; verify end-to-end.
- **Base composition + stats-after-stats** hits the separately-tracked subquery-
  wrapping bugs; the common case (raw base + transforming post-process) is clean.

## Out of scope

The translator subquery-wrapping bugs (eval-after-stats, timechart→stats,
head-between-stats) tracked in `docs/superpowers/specs/2026-06-18-subquery-wrapping-design.md`
are a separate investigation, not part of this sweep's canaries.
