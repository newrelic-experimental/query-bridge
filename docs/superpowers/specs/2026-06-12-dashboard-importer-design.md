# Splunk Dashboard Importer Design

**Goal:** Import a Splunk dashboard export, translate every panel's SPL to NRQL through the existing bridge, and emit a New Relic dashboard. The importer is a *consumer* of the translator layered on top of it — it adds no translation logic and does not touch `src/translate.js` or the IR pipeline. Output is file-based (Terraform first, NerdGraph JSON later); live API push is a deferred phase.

**Relationship to the time-token spec.** This builds directly on `docs/superpowers/specs/2026-06-11-dashboard-time-tokens-design.md` (shipped). Splunk dashboards are the *source* of the `$tok.earliest$` / `$earliest$` / `span=$timespan$` tokens that spec handles. The importer inherits correct behavior for free: time-bound tokens drop-and-warn, `span=$token$` is unsupported, and the **NR dashboard's own time picker owns the window** — exactly the "dashboard owns the whole range" case that spec was written for. The importer adds nothing in the time-token path; it relies on it.

## Scope

**In scope (all of it — staged, not dropped):**
- Both Splunk dashboard formats: **Simple XML** (classic `<form>`/`<dashboard version="1.1">`) and **Dashboard Studio** (`<dashboard version="2">` JSON-in-CDATA, and pure-JSON).
- Both delivery shapes: standalone `.xml` view files, and the Splunk REST API export envelope (`dashboards.json` — `{entry:[{content:{"eai:data":"…"}}]}`).
- **Three first-class output targets**, all reading the same neutral model: **Terraform** (`newrelic_one_dashboard` + provider/variables skeleton), **NerdGraph `dashboardCreate` input** (the mutation argument), and **NR1-UI-paste JSON** (the blob a human pastes into NR1's "Import dashboard" dialog). These are *not* interchangeable — see Emit targets.
- Per-dashboard **coverage report** (clean / warned / placeholder widgets).

**Deferred (later phase, designed here so the seam exists):**
- **Live push** via NerdGraph `dashboardCreate`/`dashboardUpdate` with US/EU/staging env selection and GUID-tracked idempotent update. Settled direction: explicit `--env` flag, no default (a prod push is always deliberate); needs a `.import-state.json` GUID map. NOT built in the near-term phases.

**Out of scope:**
- Modifying the translator. The importer calls `translate()` and consumes its result; it never reaches into IR.
- Drilldowns, Splunk `<drilldown>`/`<link>` navigation, custom app vizzes (`splunk.<app>`), and `<event>` raw-event search semantics beyond a best-effort table.
- Splunk `ds.savedSearch` bodies — the SPL is not in the export (referenced by name only); these become placeholder widgets.

## Corpus reality (verified 2026-06-12)

Against `../nr-query-bridge-corpus/sources/REDACTED.saved/dashboards.json` (the only sample, a Splunk REST export, 4,665 entries):

- **Delivery:** one vehicle — the REST envelope. Each `entry[].content` has exactly six keys; **SPL lives only in the `eai:data` string**. No separate parsed-definition field.
- **Format discriminator:** `content.version` — `"2"` = Studio (844), `"1.1"`/`""` = Simple XML. `content.isDashboard === false` on 110 entries (non-dashboard views — skip).
- **Distribution:** 3,417 Simple XML, 391 XML-wrapped Studio, **0 pure-JSON**. Pure-JSON Studio is real in the wild (Studio export/clipboard) but absent here — handled synthetically, marked non-corpus-verified in tests.
- **The nesting:** `.json` envelope → `eai:data` string-of-XML → (Studio only) `<definition><![CDATA[ {JSON} ]]>`. Three layers for Studio, two for Simple XML. The detector owns all unwrapping so downstream parsers each get one clean format.

## Architecture

A pipeline of small, pure stages, mirroring the translator's own `SPL → AST → IR → NRQL` shape. A neutral **`DashboardModel`** sits between Splunk-parsing and NR-emission — both parsers target it, all three emitters consume it. This is the load-bearing seam: two structurally different parsers (XML tree-walk vs. Studio JSON-graph) feed one model, and three output targets (Terraform, NerdGraph input, UI-paste) read one model, without either side multiplying against the other.

```
import (path/string)
  → detectFormat        ┌─ parseSimpleXml ─┐                     ┌─ emitTerraform ─┐
  → (route per format) ─┤                  ├─→ DashboardModel ──→ translateWidgets ─┼─ emitNerdGraph ─┼─→ files
                        └─ parseStudio ────┘   (neutral model)   (per widget,      └─ emitUiPaste ───┘  (+ report.md)
                                                                  via translate())
                                                              [later] → pushDashboard (NerdGraph, network)
```

All stages are pure (string/object in → object out) except the two endpoints: file read at the front, file write at the back. No stage downstream of the parsers branches on source format — the model absorbs the difference.

### Component × phase matrix (read this first for plan-writing)

Each component is described once, in full, in its own section below; this table says which phase delivers which slice of it and the exit test for each phase. Walk the rows in phase order to generate the implementation plan.

| Component | Phase 0 | Phase 1 (vertical slice) | Phase 2 (Simple XML breadth) | Phase 3 (Studio) | Phase 4 (emitters) |
|---|---|---|---|---|---|
| repo → workspaces; translator → `packages/nr-query-bridge/` | **all** | — | — | — | — |
| `detectFormat.js` | — | single-file Simple XML only | + REST envelope bulk, `isDashboard` skip | + Studio routing (wrapped + pure-JSON) | — |
| `parseSimpleXml.js` | — | `<chart>`/`<table>`/`<single>` only | + all viz, variables, base/post-process, time | — | — |
| `parseStudio.js` | — | — | — | **full** | — |
| `model.js` | — | minimal model + 3 vizTypes | full vizType enum + variables | (no change) | — |
| `translateWidgets.js` | — | translate + clean/placeholder | + base/chain resolution, partial-NRQL | + `ds.chain` walk | — |
| `emitTerraform.js` | — | resource + versions/variables skeleton | + variables, time range, placeholders | (no change) | — |
| `emitNerdGraph.js` / `emitUiPaste.js` | — | — | — | — | **both** |
| `report.js` | — | one-dashboard summary | + roll-up over REST bulk | (no change) | — |
| `bin/spl-dashboard.js` | — | single-file, `--account`, `--out` | + bulk dir, report | + `--format` routing-ready | + `--format nerdgraph\|ui-paste` |

**Done-when (phase exit criteria):**
- **Phase 0:** repo builds as workspaces; translator lives in `packages/nr-query-bridge/`; its 681-test suite is green unchanged; `packages/nr-dashboard-importer/` scaffold exists with a passing trivial test. No importer logic.
- **Phase 1:** one real (de-identified) Simple XML file → valid `dashboard.tf` + `versions.tf` + `variables.tf`; `terraform validate` passes (if available in CI); re-run overwrites identically. Line/table/billboard widgets only.
- **Phase 2:** the de-identified corpus Simple XML subset runs with `threw === 0`; coverage scorecard recorded; variables, base/post-process, all viz types, and placeholders all exercised by tests.
- **Phase 3:** Studio fixtures (XML-wrapped from corpus + synthetic pure-JSON) produce the same `DashboardModel` shape and valid output; `ds.chain` nesting resolved.
- **Phase 4:** `emitNerdGraph` output validates against the `DashboardInput` schema (introspection-checked); `emitUiPaste` output round-trips through NR1's import dialog (manual check documented).

### Packaging — monorepo, two packages

The importer has a fundamentally different dependency profile from the translator: the translator is pure string→string and legitimately **zero runtime dependency** (a selling point for embedding it anywhere); the importer needs an XML parser, file I/O, and a NerdGraph client. Forcing both into one package would make every translate-only consumer pay for XML deps they never use, or contort a single package with `optionalDependencies`/subpath exports to *fake* the separation. Instead, make the boundary real with **npm workspaces** — mirrors how `nr-query-bridge-corpus` is already a sibling repo to keep heavy/optional concerns out of the shippable core.

```
nr-query-bridge/ (repo root — becomes a workspace root)
  package.json                      ← workspaces: ["packages/*"]
  packages/
    nr-query-bridge/                ← the translator, UNCHANGED, stays zero-dep
      src/ input/ ir/ output/ translate.js
      package.json   (no "dependencies")
    nr-dashboard-importer/          ← NEW package
      package.json   (dependencies: @datanerd/nr-query-bridge, fast-xml-parser)
      src/
        detectFormat.js     ← sniff envelope/format, unwrap, route
        parseSimpleXml.js   ← <form>/<dashboard v1> tree-walk → DashboardModel
        parseStudio.js      ← Studio JSON graph → DashboardModel
        model.js            ← DashboardModel factory + neutral vizType enum + viz maps
        translateWidgets.js ← bridge into translate(); base/chain resolution
        emitTerraform.js    ← → newrelic_one_dashboard + provider/vars skeleton (Phase 1)
        emitNerdGraph.js    ← → dashboardCreate mutation input               (later)
        emitUiPaste.js      ← → NR1 "Import dashboard" JSON blob              (later)
        report.js           ← per-dashboard coverage report
        pushDashboard.js    ← NerdGraph mutation (DEFERRED, only network stage)
      bin/spl-dashboard.js  ← CLI entry
      test/ + test/fixtures/ ← de-identified sample exports
```

One-way dependency: `nr-dashboard-importer → @datanerd/nr-query-bridge`, never the reverse. The translator package never imports the importer and keeps an empty `dependencies` block, so a consumer running `npm install @datanerd/nr-query-bridge` still pulls **zero** runtime deps. Workspaces let the importer consume the translator's local source during development (no publish-to-test cycle), while keeping them independently publishable.

*Migration note:* moving the existing translator into `packages/nr-query-bridge/` is a path change across the repo (imports, configs, CI, husky hooks, the corpus harness's `../nr-query-bridge` reference). This is real work and is called out as Phase 0 below — do it as a mechanical move with the full test suite green before and after, in its own commit, separate from any importer code.

### Dependency decision — XML parser

Parsing Simple XML requires an XML parser. **DOMParser is NOT a Node global** — verified by probe under both Node v24.14.0 (the project-pinned version) and v25.2.1: `typeof globalThis.DOMParser === "undefined"` in both. DOMParser is a browser-only API; Node has never shipped it as a global and still doesn't as of v25. So a "use native DOMParser, shim only in Node" approach would *always* need a Node-side dependency (`linkedom`/`@xmldom/xmldom`/jsdom) — it is strictly worse than a single cross-environment parser, not better. Node 24 does not change this.

Decision: **`fast-xml-parser` 5.8.0**, as a dependency of the `nr-dashboard-importer` package only (MIT; pure-JS, no native bindings; runs in both Node and browser — `"module": "./src/fxp.js"`, `sideEffects:false`; ~72.9M weekly downloads; maintainer Amit Gupta / NaturalIntelligence). Verified real against two independent npm endpoints (registry record + downloads API) 2026-06-12 — not hallucinated or typosquatted. It pulls 5 transitive deps (`@nodable/entities`, `fast-xml-builder`, `path-expression-matcher`, `strnum`, `xml-naming`); these land only in the importer package's tree, never the translator's. Re-confirm the transitive licenses are all permissive before merge (the security rules require it).

## The neutral model (`model.js`)

```
DashboardModel = {
  title,                  // <label> / Studio label
  description,
  sourceFormat,           // 'simple-xml' | 'studio' — for the report only, NOT branched on downstream
  variables: [{
    name,                 // Splunk token name (e.g. 'tok_category')
    type,                 // 'enum' | 'string'
    defaultValue,         // '*' → "any" (no filter)
    choices,              // static <choice> list, if present
    sourceQuery,          // populating <search><query> SPL (translated separately), if present
  }],
  defaultTimeRange,       // { earliest, latest } from the time picker | null
  widgets: [{
    title,
    vizType,              // NEUTRAL enum (below) — never a Splunk or NR name
    rawSpl,               // the panel's SPL, base/chain UNRESOLVED at parse time
    baseRef,              // id of a base/chain search to prepend (resolved in translateWidgets)
    options,              // viz-specific carry-through (unit, precision, stack mode…)
    layout,               // { x, y, w, h } — px (Studio) or computed (Simple XML)
  }],
}
```

**Neutral `vizType` enum:** `line | area | bar | column | pie | scatter | billboard | table | markdown | map | unknown`. Each parser maps its format's names into this once; each emitter maps out of it once. The enum is the contract between them — adding a viz type means touching one map per side, never the pipeline.

| Neutral | Simple XML source | Studio source |
|---|---|---|
| `line` | `<chart>` + `charting.chart=line` | `splunk.line` |
| `area` | `charting.chart=area` | `splunk.area` |
| `bar` | `charting.chart=bar` | `splunk.bar` |
| `column` | `charting.chart=column` | `splunk.column` |
| `pie` | `charting.chart=pie` | `splunk.pie` |
| `scatter` | `charting.chart=scatter` | `splunk.scatter` |
| `billboard` | `<single>`, gauges (`radialGauge`/`fillerGauge`/`markerGauge`) | `splunk.singlevalue`, `splunk.singlevalueradial`, `splunk.markergauge`, `splunk.fillergauge` |
| `table` | `<table>`, `<event>` | `splunk.table`, `splunk.events` |
| `markdown` | `<html>` | `splunk.markdown` |
| `map` | `<map>` | `splunk.choropleth` |
| `unknown` | anything else (→ placeholder) | `splunk.<app>` (custom app vizzes → placeholder); `splunk.rectangle`/`ellipse`/`image` (pure decorations, no query → skip, not placeholder) |

(`splunk.markdown` maps to neutral `markdown` as real content. The decoration vizzes — rectangle/ellipse/image — carry no query and are skipped entirely, never placeholdered; see Risks.)

## Parser 1 — Simple XML (`parseSimpleXml.js`)

`fast-xml-parser` → object tree, then walk:
- `<label>` → `title`; `<description>` → `description`.
- `<fieldset><input>` → `variables[]`. `type="time"` → `defaultTimeRange` from `<default><earliest>/<latest>`. `type="dropdown"|"text"|"multiselect"|"radio"` → a variable; a populating `<search><query>` → `sourceQuery`; `<choice>` list → `choices`; `<default>` → `defaultValue`.
- `<row><panel>` → iterate viz children in document order. Viz element + `<option name="charting.chart">` → neutral `vizType` (table above). `<option>`s carried into `widget.options`.
- `<search><query>` → `rawSpl`. `<search base="id">` → `baseRef = "id"`; its `<query>` is the leading-pipe post-process fragment (stored as `rawSpl`, resolved later). Global `<search id="id">` blocks collected into a base-search map passed to `translateWidgets`.
- Inline `<earliest>/<latest>` on a panel search → per-widget time (rare; carried but the NR page-level range dominates).
- **Layout:** Simple XML has no explicit coordinates. Compute from row order and panels-per-row: row index → `y`, panel index within row → `x`, width = `12 / panelCount` columns (NR's 12-col grid).
- `depends`/`rejects` token-visibility attrs on `<row>`/`<panel>` → recorded in `options` as a caveat (NR has conditional visibility via variables, but v1 notes rather than wires it).

## Parser 2 — Dashboard Studio (`parseStudio.js`)

Input already unwrapped by the detector to the JSON definition object (CDATA stripped, or pure-JSON passed straight through). Walk the graph:
- `dataSources.<id>`: `ds.search` → `rawSpl = options.query`. `ds.chain` → `baseRef = options.extend` (parent dataSource id) + `rawSpl = options.query` (the chain's post-process SPL). `ds.savedSearch` → no inline SPL → widget flagged `unknown`/placeholder. Chains can nest (chain→chain→search); `translateWidgets` walks `extend` to the root.
- `visualizations.<id>`: `type` (`splunk.<x>`) → neutral `vizType`; `dataSources.primary` → the dataSource id supplying `rawSpl`/`baseRef`; `title` → widget title; `options` carried.
- `inputs.<id>`: `input.timerange` → `defaultTimeRange` (`options.defaultValue` like `"-24h@h,now"`); `input.dropdown`/`input.text`/`input.multiselect` → `variables[]`.
- `layout.structure[]`: `{item: vizId, position:{x,y,w,h}}` → `widget.layout` (px; scaled to 12-col grid in emit).
- `defaults.dataSources.global` → fallback time/query params if no explicit timerange input.

Both parsers converge on the identical `DashboardModel`; nothing downstream knows which ran.

## Detector (`detectFormat.js`)

Owns ALL unwrapping so each parser receives one clean single-format input. Routing ladder:

```
input is REST envelope ({entry:[…]} with content."eai:data")
  → for each entry:
       skip if content.isDashboard === false           (110 non-dashboards in corpus)
       fmt = content.version === "2" ? studio : simple-xml   (version is the reliable discriminator)
       payload = content["eai:data"]                    (the ONLY place SPL lives)
       → recurse on payload with known fmt

payload starts "{" and has dataSources/visualizations  → studio (pure JSON)        → parseStudio
payload is <dashboard version="2">…<definition><![CDATA[{…}]]>  → studio (XML-wrapped) → strip wrapper+CDATA → parseStudio
payload is <form> | <dashboard version="1…">           → simple-xml               → parseSimpleXml
```

Returns `DashboardModel[]` (a REST export yields many; a single file yields one). **String-prefix sniffing is the fallback;** when the REST `content.version` field is present, trust it over sniffing. CDATA-unwrap and XML-entity-decode happen here, not in the parsers.

## Translate stage (`translateWidgets.js`) — the one bridge into the translator

For each widget, in order:

1. **Resolve base/chain first.** A widget with `baseRef` holds a leading-pipe fragment, not standalone SPL — translating it raw is a parse error. Simple XML: look up `baseRef` in the base-search map, `resolved = baseQuery + " " + fragment`. Studio: follow `ds.chain.extend` to the parent dataSource, concatenating up the chain to the root `ds.search`. If `baseRef` can't be resolved (missing id, or `ds.savedSearch` with no inline SPL) → placeholder widget (step 4), not a crash.
2. **Translate.** One call to `translate(resolvedSpl)`. Returns `{ nrql, warnings, unsupported, errors }` — the existing contract, untouched.
3. **Time tokens are already handled.** The shipped time-token spec means `$tok.earliest$`/`$earliest$` drop-and-warn and `span=$timespan$` is unsupported. The dashboard's `defaultTimeRange` becomes the NR page-level range (emit stage), so the picker owns the window. Nothing added here.
4. **Decide the widget's fate by outcome:**
   - **Clean / warnings-only** → real widget with its NRQL. Warnings attach (widget description suffix + report).
   - **`unsupported` or `errors`** → a **`markdown` placeholder widget** in the same grid slot, containing: panel title, original SPL (fenced), the unsupported/error message text, and — *only if the translator produced partial NRQL alongside* — that NRQL labeled "Partial — unverified." Per the project's error/unsupported rule, when the translator returns NO nrql, the placeholder omits the NRQL section rather than showing an empty fence. Nothing silently vanishes; layout is preserved.
5. **Filter tokens pass through.** Non-time `$tok_category$` → `{{tok_category}}` in NRQL (translator's existing `TemplateVariable` behavior; correct per the time-token spec's non-goal #1). The Splunk `<input>` becomes an NR dashboard variable in emit; the `{{var}}` reference resolves against it.

## Emit targets — three, not interchangeable

The NerdGraph mutation input, the NR1 UI-paste blob, and Terraform HCL are three *related but distinct* shapes (verified via NerdGraph introspection 2026-06-12). Conflating them causes import failures. All three read the same `DashboardModel`; each is one `emit*.js`.

Key divergences:
- **`accountId` placement.** `DashboardInput` (the `dashboardCreate` mutation arg) takes `accountId` as a *separate mutation parameter*. The UI-paste JSON embeds it *inside each widget* at `rawConfiguration.nrqlQueries[].accountId`. Terraform puts it in `nrql_query { account_id }`.
- **GUIDs/IDs.** A dashboard *exported* from NR1 carries `guid`/page `id`. On *import*, those must be **omitted** or the import fails / dangles. Our emitters never invent them.
- **`rawConfiguration`** is a free-form JSON scalar (`DashboardWidgetRawConfiguration` is a `SCALAR` in the schema) holding `nrqlQueries`, `platformOptions`, viz settings — the same payload across all three forms.

### Terraform (`emitTerraform.js`, Phase 1) — resource + provider/variables skeleton

A `newrelic_one_dashboard` resource alone is **not a runnable TF project** — the customer also needs a provider declaration, variable declarations, and (environment-specific) backend/state config. We emit a runnable *skeleton* but NOT the backend, which is theirs:

- `dashboard.tf` — the `newrelic_one_dashboard` resource(s).
- `versions.tf` — `terraform { required_providers { newrelic = { source = "newrelic/newrelic", version = "~> 3" } } }`.
- `variables.tf` — `variable "account_id"` and `variable "newrelic_api_key" { sensitive = true }`, plus a `provider "newrelic"` block sourcing the key from the variable (which the user feeds from `NEW_RELIC_API_KEY` / `TF_VAR_newrelic_api_key` env — **never a literal key in the file**, per secrets rules).
- **NO `backend` block.** State backend (S3 bucket, lock table, TF Cloud) is environment-specific; generating one would be wrong or harmful. The report/README notes the user must add their own backend and run `terraform init`.

**Terraform is the Phase-1 target** because `terraform apply` gives idempotent create-and-update on re-run for free — no GUID-tracking needed to prove the pipeline. Aligns with NR observability-as-code standard D-5.

Mapping (shared conceptually across all three emitters):
- Dashboard → `name`, `description`, one `page` (one Splunk view → one NR page).
- Widget → `widget_<type>` block: `line→widget_line`, `area→widget_area`, `bar→widget_bar`, `column→widget_bar` (NR has no column; orientation is config), `pie→widget_pie`, `billboard→widget_billboard`, `table→widget_table`, `markdown→widget_markdown`, `scatter→widget_scatter`, `map→widget_markdown`+note (NR choropleth needs geo fields SPL won't carry — flag, don't fake), `unknown→widget_markdown` placeholder.
- **Layout → 12-col grid:** Studio px scaled to columns 1–12; Simple XML computed (`12/panelCount`→width). Placeholders take the failed widget's slot.
- **Variables → `variable` blocks:** static `<choice>` → `enum` items; populating `sourceQuery` → translated → variable's `nrql_query`; `*`-default → "any". Token names resolved so `{{tok_category}}` in widget NRQL matches the variable.
- **Time range → page default:** `-60m@m` → NR `since`/`duration`; snap `@m` dropped with a note (NR has no snap — loud-not-silent).
- Exact `newrelic_one_dashboard` field names/nesting **verified against the provider docs during implementation** (registry page is JS-rendered; not guessed here).

**Stable filenames** — `<slug>.tf` + `versions.tf` + `variables.tf`. Re-running overwrites; `terraform apply` reconciles. A REST export yields a directory of dashboard `.tf` files sharing one `versions.tf`/`variables.tf`, plus one roll-up report.

### NerdGraph input (`emitNerdGraph.js`) and UI-paste (`emitUiPaste.js`) — later phases

Same `DashboardModel` in. `emitNerdGraph` produces the `dashboardCreate(accountId:…, dashboard:{…})` argument (accountId hoisted out, no GUIDs). `emitUiPaste` produces the NR1 import-dialog JSON (accountId embedded per-widget, no GUIDs) — the most human-useful artifact since it needs no API key or TF toolchain, just a paste. Built after Terraform per the staging decision.

## Report (`report.js`)

Per dashboard: N widgets, M clean, K warned, J placeholders (with reason each). Emitted as `<slug>.report.md` and printed to stderr. A bulk REST import produces a directory of reports + one roll-up — an auditable coverage trail, not a silent pile of HCL. Mirrors the translator's own corpus-diagnostic ethos.

## CLI (`bin/spl-dashboard.js`)

```
spl-dashboard <file>                      # → <slug>.tf + versions.tf + variables.tf + report (Phase 1)
spl-dashboard <dashboards.json>           # REST export → directory of .tf + reports
cat dash.xml | spl-dashboard              # stdin
spl-dashboard <file> --out ./dir          # output directory
spl-dashboard <file> --account 12345      # account_id baked into emitted nrql_query blocks
spl-dashboard <file> --format terraform   # default; also: nerdgraph | ui-paste (later phases)
# --push / --env: DEFERRED phase, not in near-term build
```

`--account <id>` (Phase 1) supplies the `account_id`; defaults to a placeholder `var.account_id` so the `.tf` is valid without one. `--format` selects the emit target (terraform default; `nerdgraph`/`ui-paste` land in later phases). `--push`/`--env` are the only DEFERRED flags. The bin lives in the `nr-dashboard-importer` package.

## Build phases

All formats are in scope; this is build order. **Phase 1 is a vertical slice** (thinnest end-to-end path to prove the pipeline); then breadth.

- **Phase 0 — monorepo migration.** Convert the repo to npm workspaces; move the existing translator into `packages/nr-query-bridge/`; create the empty `packages/nr-dashboard-importer/` scaffold. Mechanical path/config/CI/hook updates only — full test suite green before and after, in its own commit, no importer logic. (See Packaging migration note.)
- **Phase 1 — vertical slice, Terraform-only.** One Simple XML file → `detectFormat` (single-file path) → `parseSimpleXml` (minimal: `<chart>`/`<table>`/`<single>` → `line`/`table`/`billboard`, no variables, no base/post-process) → `translateWidgets` → `emitTerraform` → `<slug>.tf` + `versions.tf` + `variables.tf` skeleton. CLI single-file mode. Proves model + translate + emit end-to-end. Stable filename re-run. One de-identified dashboard fixture + synthetic edge fixtures.
- **Phase 2 — Simple XML breadth.** All viz types incl. `<html>`/`<map>`/gauges; template variables (static + populating-search); base/post-process resolution; placeholder widgets for unsupported/errors; `defaultTimeRange` → page range; REST-envelope bulk path (skip `isDashboard:false`); per-dashboard + roll-up reports.
- **Phase 3 — Dashboard Studio.** `parseStudio` for both XML-wrapped (CDATA) and pure-JSON; `ds.search`/`ds.chain`/`ds.savedSearch`; viz/dataSource graph linkage; `layout.structure` px→grid; Studio inputs → variables. Pure-JSON path synthetic (no corpus sample).
- **Phase 4 — NerdGraph + UI-paste emitters** (`emitNerdGraph.js`, `emitUiPaste.js`; `--format nerdgraph|ui-paste`). Same model → mutation input / UI-paste blob.
- **Phase 5 (DEFERRED, separate spec likely) — live push.** `pushDashboard.js`, `--push`/`--env US|EU|staging` (explicit, no default), GUID-tracked `dashboardUpdate` via `.import-state.json`, `NEW_RELIC_API_KEY` env var. Verify emitted NRQL via the `nrql-validation` path before claiming a widget works.

## Testing

Vitest, in `packages/nr-dashboard-importer/test/` mirroring its `src/`. Pure functions (string/object in → object out) — no mocking, consistent with project-testing rules. Fixtures live in `test/fixtures/`, **de-identified** (corpus carries customer index/host/app names — scrub before committing, per the no-customer-data rule). Phase 0's migration must keep the translator package's existing 681-test suite green unchanged.

- **detectFormat:** one test per input shape — REST envelope (multi-entry, mixed formats, `isDashboard:false` skipped), standalone Simple XML, Studio XML-wrapped (CDATA unwrap), Studio pure-JSON (synthetic, marked non-corpus). Assert correct format routing + count.
- **parseSimpleXml:** `<label>`→title; each viz element→neutral vizType; `<search base>`→baseRef + fragment; time input→defaultTimeRange; dropdown w/ populating search→variable+sourceQuery; computed layout for N-panel rows.
- **parseStudio:** `ds.search`/`ds.chain`(extend)/`ds.savedSearch`; viz→dataSource linkage via `primary`; nested chain→root resolution; `layout.structure` coords; inputs→variables.
- **translateWidgets:** base/chain concatenation produces translatable SPL (not leading-pipe parse error); clean→real widget; unsupported→markdown placeholder WITH SPL+reason, and WITHOUT an NRQL section when translator returns none; partial-NRQL labeled "unverified"; `{{tok}}` passthrough for non-time tokens; **time tokens already drop-and-warn** (assert no SINCE leaks — inherited from the shipped spec, regression-guarded here).
- **emitTerraform:** each vizType→correct `widget_*` block; layout→12-col grid (Studio px scaled, Simple XML computed); variable blocks (enum + nrql_query); `defaultTimeRange`→page range w/ snap-drop note; placeholder→`widget_markdown`. Emitted HCL parses (`terraform validate` in a Phase-2 integration check, if available).
- **Corpus gate (Phase 2+):** run the importer over the de-identified corpus sample; assert `threw === 0` (no dashboard crashes the importer — every failure is a placeholder, never an exception), and a coverage scorecard (clean/warned/placeholder counts) that must not regress.
- **AI-DEV markers** added to confirmed tests after the red-green-refactor cycle, per `llm-test-verification.md`.

## Risks

- **Dependency tree growth.** `fast-xml-parser` + 5 transitive deps. Isolated in the `nr-dashboard-importer` package, so the translator package keeps its empty `dependencies` block and zero-dep guarantee for translate-only consumers. Verifying the package is genuine: done. Re-confirm all transitive licenses are permissive before merge — run the license check the security rules require.
- **Monorepo migration blast radius (Phase 0).** Moving the translator into `packages/nr-query-bridge/` touches every relative import, the husky hooks, CI workflows, package exports, and the sibling corpus harness's `../nr-query-bridge` path. A mistake here breaks the shipping translator, not just the new importer. Mitigate: do it mechanically in one isolated commit, full suite green before and after, no behavior change.
- **`terraform validate` only checks syntax, not semantics.** Valid HCL ≠ a dashboard NR will accept. Phase 5's `nrql-validation` path is where widget NRQL correctness is actually proven; until then, "emits valid `.tf`" is the honest claim — not "produces a working dashboard." State this in the report.
- **Base/post-process resolution is load-bearing and easy to get wrong.** A `<search base>` fragment translated without its base is a leading-pipe parse error → placeholder. Nested Studio `ds.chain` must walk to root. A bug here silently turns translatable panels into placeholders (under-reporting coverage). Test the concatenation directly.
- **Layout fidelity is approximate.** Simple XML has no coordinates; computed row/column layout won't match Splunk pixel-perfect. Acceptable — semantic fidelity (right query, right viz) matters more than exact placement. Note in report, don't chase.
- **`charting.chart` defaulting.** A `<chart>` with no `charting.chart` option defaults to `line` (per Splunk docs). The parser must apply that default, or such panels become `unknown`/placeholder wrongly.
- **Studio `theme`/decoration vizzes** (`splunk.rectangle`/`ellipse`/`image`/`markdown`-as-label) carry no query. Don't translate them; either skip or emit as static markdown. Don't placeholder-spam the dashboard with "unsupported" for pure decorations.
- **Customer data in fixtures.** The corpus is real customer dashboards (REDACTED index/host/app names). Every committed fixture MUST be de-identified. Synthetic-first; de-identify the one real sample. Gitignore raw corpus pulls.

## Deferred gaps (FIXME-tracked)

1. **Live NerdGraph push** (Phase 5) — env selection, GUID-tracked idempotent update, NRQL validation gate. Designed (seam exists) but not built near-term.
2. **Drilldowns / navigation** — Splunk `<drilldown>`/`<link>` → NR widget links. Dropped in v1; flag per widget that had one.
3. **`ds.savedSearch` bodies** — SPL not in the export; would need a second fetch of the saved-search definition (the corpus has `saved_searches.json` alongside — a future cross-reference could resolve these instead of placeholdering them).
4. **`depends`/`rejects` conditional visibility** — Splunk token-gated panel visibility → NR variable-conditional widgets. Recorded as a caveat in v1, not wired.
5. **Snap-to time** (`-60m@m`) — snap dropped with a note (NR has no snap); same class as the time-token spec's deferred literal-snap gap.
