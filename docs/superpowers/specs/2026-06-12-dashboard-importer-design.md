# Splunk Dashboard Importer Design

**Goal:** Import a Splunk dashboard export, translate every panel's SPL to NRQL through the existing bridge, and emit a New Relic dashboard. The importer is a *consumer* of the translator layered on top of it. The output is files for three targets: Terraform (built first), JSON intended for NerdGraph, and JSON intended to be pasted into the NR1 UI.

**Depends on:** dashboard time-tokens (`docs/superpowers/specs/2026-06-11-dashboard-time-tokens-design.md`) for Phase 2+ — Phase 2 ingests time pickers and needs the translator to degrade tokens cleanly. Phase 0/1 (plan: `docs/superpowers/plans/2026-06-16-dashboard-importer-phase-0-1.md`) is independent and can proceed now. **Blocks:** nothing.

## Scope

**In scope** — everything below is committed work, built across Phases 0–5 (see "Build phases"), not omitted. "In scope" here means *will be built*, just not all at once:
- Both Splunk dashboard formats: **Simple XML** (classic `<form>`/`<dashboard version="1.1">`) and **Dashboard Studio** (`<dashboard version="2">` JSON-in-CDATA, and pure-JSON).
- Both delivery shapes: standalone `.xml` view files, and the Splunk REST API export envelope (`dashboards.json` — `{entry:[{content:{"eai:data":"…"}}]}`).
- **Three first-class output targets**, all reading the same neutral model: **Terraform** (`newrelic_one_dashboard` + provider/variables skeleton), **NerdGraph `dashboardCreate` input** (the mutation argument), and **NR1-UI-paste JSON** (the blob a human pastes into NR1's "Import dashboard" dialog). These are *not* interchangeable — see Emit targets.
- Per-dashboard **coverage report** (clean / warned / placeholder widgets).

**Deferred (later phase, designed here so the seam exists):**
- **Live push** — the *network call* that sends a generated `dashboardCreate`/`dashboardUpdate` payload to NerdGraph, with US/EU/staging env selection and GUID-tracked idempotent update. (Generating the `dashboardCreate` *input* is a Phase-4 emit target; only the push itself is deferred.) Settled direction: explicit `--env` flag, no default (a prod push is always deliberate); needs a `.import-state.json` GUID map.

**Out of scope:**
- Modifying the translator. The importer calls `translateSplToNrql()` and consumes its result; it never reaches into IR.
- Drilldowns, Splunk `<drilldown>`/`<link>` navigation, custom app vizzes (`splunk.<app>`), and `<event>` raw-event search semantics beyond a best-effort table.
- Splunk `ds.savedSearch` bodies — the SPL is not in the export (referenced by name only); these become placeholder widgets.
- Time-token handling — already shipped (`docs/superpowers/specs/2026-06-11-dashboard-time-tokens-design.md`). The importer inherits it and adds nothing: `$tok.earliest$`/`$earliest$` drop-and-warn, `span=$timespan$` is unsupported, and the NR dashboard's own picker owns the window. Do NOT re-implement time-token logic in the importer.

## Confidence convention

Claims in this spec are tagged so the implementer inherits the right confidence and verifies before building on sand:

- **[verified]** — checked this session against the corpus, live NerdGraph introspection, or live docs (date noted).
- **[assumed]** — domain knowledge or convention, NOT independently confirmed; **verify before relying on it.** Most NR-schema and Studio-type-string claims are `[assumed]` until the Phase-4 introspection pass.

When `[verified]` and `[assumed]` conflict, trust `[verified]` and re-check the other.

## Corpus reality

Two distinct sources in `../nr-query-bridge-corpus/sources/` (verified 2026-06-12) — both are translation/test material:

1. **`REDACTED.saved/dashboards.json`** — a real customer's Splunk REST export, 4,665 entries.
2. **`REDACTED/`** — a real customer's SRE Splunk-app tree with **149 standalone `.xml` view files** on disk.

So **standalone-`.xml`-file input is corpus-real, not hypothetical** — the detector's single-file path has 149 real fixtures, and Phase 1 can use a real (de-identified) one.

From the REST export (`[verified]` 2026-06-12):
- **Delivery:** the REST envelope. Each `entry[].content` has exactly six keys; **SPL lives only in the `eai:data` string**. No separate parsed-definition field.
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
                                                                  via translator)
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
- **Phase 0:** repo builds as workspaces; translator lives in `packages/nr-query-bridge/`; its test suite is green with no behavior change (shipped: package suite 706 + root playground guard 3 = 709 passed | 6 skipped); `packages/nr-dashboard-importer/` scaffold exists with a passing trivial test. No importer logic. (Shipped in PR #33.)
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
      package.json   (dependencies: @newrelic/query-bridge, fast-xml-parser)
      src/
        detectFormat.js     ← sniff envelope/format, unwrap, route
        parseSimpleXml.js   ← <form>/<dashboard v1> tree-walk → DashboardModel
        parseStudio.js      ← Studio JSON graph → DashboardModel
        model.js            ← DashboardModel factory + neutral vizType enum + viz maps
        translateWidgets.js ← bridge into translateSplToNrql(); base/chain resolution
        emitTerraform.js    ← → newrelic_one_dashboard + provider/vars skeleton (Phase 1)
        emitNerdGraph.js    ← → dashboardCreate mutation input               (later)
        emitUiPaste.js      ← → NR1 "Import dashboard" JSON blob              (later)
        report.js           ← per-dashboard coverage report
        pushDashboard.js    ← NerdGraph mutation (DEFERRED, only network stage)
      bin/spl-dashboard.js  ← CLI entry
      test/ + test/fixtures/ ← de-identified sample exports
```

One-way dependency: `nr-dashboard-importer → @newrelic/query-bridge`, never the reverse. The translator package never imports the importer and keeps an empty `dependencies` block, so a consumer running `npm install @newrelic/query-bridge` still pulls **zero** runtime deps. Workspaces let the importer consume the translator's local source during development (no publish-to-test cycle), while keeping them independently publishable.

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
- A global `<search id>` can carry its own `<earliest>/<latest>`, which applies to **every** panel chaining off it. Dropping it for the page picker changes those panels' results — **warn when a base search has an explicit time range** (`[verified]` spl-expert 2026-06-12).
- A `<search>` can sit at panel level (not viz level) and be shared by all sibling vizzes in that panel — associate it with each.
- Inline `<earliest>/<latest>` on a panel search → per-widget time (rare; carried but the NR page-level range dominates).
- **Layout:** Simple XML has no explicit coordinates. Compute from row order and panels-per-row: row index → `y`, panel index within row → `x`, width = `12 / panelCount` columns (NR's 12-col grid).
- `depends`/`rejects` token-visibility attrs on `<row>`/`<panel>` → recorded in `options` as a caveat (NR has conditional visibility via variables, but v1 notes rather than wires it).

## Parser 2 — Dashboard Studio (`parseStudio.js`)

Input already unwrapped by the detector to the JSON definition object (CDATA stripped, or pure-JSON passed straight through). Walk the graph:
- `dataSources.<id>`: `ds.search` → `rawSpl = options.query`. `ds.chain` → `baseRef = options.extend` (parent dataSource id) + `rawSpl = options.query` (the chain's post-process SPL). `ds.savedSearch` → no inline SPL → widget flagged `unknown`/placeholder. Chains can nest (chain→chain→search); `translateWidgets` walks `extend` to the root.
- `visualizations.<id>`: `type` (`splunk.<x>`) → neutral `vizType`; `dataSources.primary` → the dataSource id supplying `rawSpl`/`baseRef`; `title` → widget title; `options` carried. The literal gauge type strings (`splunk.singlevalueradial`/`markergauge`/`fillergauge`) are `[assumed]` — Studio's type strings shift across versions; confirm against the 391 wrapped-Studio corpus entries before relying on them, or they silently fall to `unknown`/placeholder.
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

1. **Resolve base/chain first.** A widget with `baseRef` holds a leading-pipe fragment, not standalone SPL. Simple XML: look up `baseRef` in the base-search map, `resolved = baseQuery + " " + fragment`. Studio: follow `ds.chain.extend` to the parent dataSource, concatenating up the chain to the root.
   - **Concatenation is an approximation, not a semantic identity** (`[verified]` Splunk behavior, spl-expert 2026-06-12). Splunk runs the base once and the post-process on its *materialized result set* (capped ~500k rows transforming / ~10k events non-transforming), not on the raw event stream. For a *transforming* base (ends in `stats`/`timechart`/`chart`/`top`) the concatenation matches Splunk closely. For a **non-transforming** base, the capped/truncated event set means the concatenated NRQL can disagree with Splunk on large data — **warn when the base is non-transforming**, don't claim equivalence.
   - **The root may be a `ds.savedSearch`** (SPL not inline) even when the chain's own fragment is translatable. The chain walker must terminate on "reached root, root has no inline SPL" → placeholder, the same as a missing id.
   - Failure is **not only** a leading-pipe parse error: a fragment referencing a field the base's transform already collapsed produces NRQL that's confidently wrong (Splunk errors on it too, so it's at least faithful) — flag field-set mismatch as an under-tested edge.
   - Unresolvable `baseRef` (missing id, or savedSearch root) → placeholder widget (step 4), not a crash.
2. **Translate.** One call to `translateSplToNrql(resolvedSpl)`. Returns `{ nrql, warnings, unsupported, errors }` — the existing contract, untouched.
3. **Time tokens are already handled.** The shipped time-token spec means `$tok.earliest$`/`$earliest$` drop-and-warn and `span=$timespan$` is unsupported, so the NR dashboard's own picker owns the window. (The Splunk default range surfaces as a report note, not an emitted field — see Emit → Time range.) Nothing added here.
4. **Decide the widget's fate by outcome:**
   - **Clean / warnings-only** → real widget with its NRQL. Warnings attach (widget description suffix + report).
   - **`unsupported` or `errors`** → a **`markdown` placeholder widget** in the same grid slot, containing: panel title, original SPL (fenced), the unsupported/error message text, and — *only if the translator produced partial NRQL alongside* — that NRQL labeled "Partial — unverified." Per the project's error/unsupported rule, when the translator returns NO nrql, the placeholder omits the NRQL section rather than showing an empty fence. Nothing silently vanishes; layout is preserved.
5. **Filter tokens pass through.** Non-time `$tok_category$` → `{{tok_category}}` in NRQL (translator's existing `TemplateVariable` behavior; `[verified]` `{{var}}` is valid in WHERE/SELECT/FACET/IN/LIKE per `nrql-reference.md`). The Splunk `<input>` becomes an NR dashboard variable in emit.
   - **Quoting trap (most-likely silent bug, nrql-expert 2026-06-12):** NR substitutes a string variable's value *already quoted* (`x = {{v}}` → `x = 'US'`), and **a `{{var}}` inside quotes is NOT substituted**. So if SPL `category="$tok$"` translates to `category = '{{tok_category}}'`, the dashboard runs against the literal text `{{tok_category}}` and silently matches nothing. The emitter MUST produce the token **unquoted** (`category = {{tok_category}}`). Add a test asserting this, and choose the NR variable type (enum vs string) deliberately — they quote differently.

## Emit targets — three, not interchangeable

The NerdGraph mutation input, the NR1 UI-paste blob, and Terraform HCL are three *related but distinct* shapes (verified via NerdGraph introspection 2026-06-12). Conflating them causes import failures. All three read the same `DashboardModel`; each is one `emit*.js`.

Key divergences (`[verified]` via NerdGraph introspection 2026-06-12 except where noted):
- **`accountId` placement.** `dashboardCreate(accountId: Int!, dashboard: DashboardInput!)` takes `accountId` as a *separate mutation arg*. The UI-paste JSON embeds it *per-widget* at `rawConfiguration.nrqlQueries[].accountId`. Terraform uses `nrql_query { account_id }`.
- **GUIDs/IDs.** A dashboard *exported* from NR1 carries `guid`/page `id`. On *import*, those must be **omitted** or the import fails / dangles. Our emitters never invent them.
- **`rawConfiguration`** is a free-form JSON `SCALAR` (`DashboardWidgetRawConfiguration`) holding `nrqlQueries`, `platformOptions`, viz settings.
- **The UI-paste blob is NOT simply "`DashboardInput` minus guids"** (`[assumed]`, nrql-expert 2026-06-12). The exported envelope differs in `permissions` placement, per-widget `id`/`linkedEntityGuids`/`layout` expression, and possibly a top-level wrapper the import dialog expects. **Diff it field-by-field during Phase 4 introspection** — "minus guids" is an oversimplification that will bite.

### Terraform (`emitTerraform.js`, Phase 1) — resource + provider/variables skeleton

A `newrelic_one_dashboard` resource alone is **not a runnable TF project** — the customer also needs a provider declaration, variable declarations, and (environment-specific) backend/state config. We emit a runnable *skeleton* but NOT the backend, which is theirs:

- `dashboard.tf` — the `newrelic_one_dashboard` resource(s).
- `versions.tf` — `terraform { required_providers { newrelic = { source = "newrelic/newrelic", version = "~> 3" } } }`.
- `variables.tf` — `variable "account_id"` and `variable "newrelic_api_key" { sensitive = true }`, plus a `provider "newrelic"` block sourcing the key from the variable (which the user feeds from `NEW_RELIC_API_KEY` / `TF_VAR_newrelic_api_key` env — **never a literal key in the file**, per secrets rules).
- **NO `backend` block.** State backend (S3 bucket, lock table, TF Cloud) is environment-specific; generating one would be wrong or harmful. The report/README notes the user must add their own backend and run `terraform init`.

**Terraform is the Phase-1 target** because `terraform apply` gives idempotent create-and-update on re-run for free — no GUID-tracking needed to prove the pipeline. Aligns with NR observability-as-code standard D-5.

Mapping (shared conceptually across all three emitters):
- Dashboard → `name`, `description`, one `page` (one Splunk view → one NR page).
- Widget → `widget_<type>` block. **This map is `[assumed]` — pin every id via NerdGraph `Visualization` introspection + the provider schema before writing it (nrql-expert 2026-06-12).** Known-good: `line→widget_line`, `area→widget_area`, `bar→widget_bar`, `column→widget_bar` (NR has no column; orientation is config), `pie→widget_pie`, `billboard→widget_billboard`, `table→widget_table`, `markdown→widget_markdown`. **Known-suspect: `scatter→widget_scatter` is probably WRONG** — NR likely has no `viz.scatter`/`widget_scatter`; scatter is `viz.line` + config. `map→widget_markdown`+note (NR geo viz needs lat/long or region fields SPL won't carry — flag, don't fake; confirm the geo viz id is `viz.geo` not `choropleth`). `unknown→widget_markdown` placeholder. If `options.stackMode` is set, plain `widget_bar` loses stacking — NR has `widget_stacked_bar`; note the tradeoff.
- **`rawConfiguration` minimum shapes differ by widget kind** (`[assumed]`, confirm at introspection): an NRQL widget needs `{ "nrqlQueries": [ { "accountId": <int>, "query": "<nrql>" } ] }`; a **markdown widget needs `{ "text": "..." }` and NO `nrqlQueries`.** The placeholder/`<html>` path MUST emit the `text` shape — reusing the nrqlQueries shape for `widget_markdown` makes the widget fail to render.
- **Layout → 12-col grid:** Studio px scaled to columns 1–12; Simple XML computed (`12/panelCount`→width). Placeholders take the failed widget's slot.
- **Variables → `variable` blocks:** static `<choice>` → `enum` items; populating `sourceQuery` → translated → variable's `nrql_query`; `*`-default → "any". Token names resolved so `{{tok_category}}` in widget NRQL matches the variable.
- **Time range → report note, probably NOT an emitted field.** `[assumed]` NR dashboards have **no** per-page/dashboard default-time field in `DashboardInput`/`PageInput` (nrql-expert 2026-06-12) — the window is the viewer's picker. So the "dashboard owns the window" story holds, but emitting `-60m` into Terraform may have nowhere to land. **Demote the Splunk default time to a report note** ("set the picker to last 60m") unless introspection proves a page-level time field exists. Snap `@m` dropped regardless (NR has no snap — loud-not-silent).
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

- **Phase 0 — monorepo migration. Its OWN PR, merged before any importer work.** Convert the repo to npm workspaces; move the translator into `packages/nr-query-bridge/`; create the empty `packages/nr-dashboard-importer/` scaffold. Mechanical path/config/CI/hook updates only — the test suite green before and after with no behavior change, no importer logic. A standalone PR keeps the giant path-move diff from tangling with any logic change, so reviewers can see the move *is* just a move.
- **Phase 1 — vertical slice, Terraform-only.** One Simple XML file → `detectFormat` (single-file path) → `parseSimpleXml` (minimal: `<chart>`/`<table>`/`<single>` → `line`/`table`/`billboard`, no variables, no base/post-process) → `translateWidgets` → `emitTerraform` → `<slug>.tf` + `versions.tf` + `variables.tf` skeleton. CLI single-file mode. Proves model + translate + emit end-to-end. Stable filename re-run. One de-identified dashboard fixture + synthetic edge fixtures.
- **Phase 2 — Simple XML breadth.** All viz types incl. `<html>`/`<map>`/gauges; template variables (static + populating-search); base/post-process resolution; placeholder widgets for unsupported/errors; `defaultTimeRange` → page range; REST-envelope bulk path (skip `isDashboard:false`); per-dashboard + roll-up reports.
- **Phase 3 — Dashboard Studio.** `parseStudio` for both XML-wrapped (CDATA) and pure-JSON; `ds.search`/`ds.chain`/`ds.savedSearch`; viz/dataSource graph linkage; `layout.structure` px→grid; Studio inputs → variables. Pure-JSON path synthetic (no corpus sample).
- **Phase 4 — NerdGraph + UI-paste emitters** (`emitNerdGraph.js`, `emitUiPaste.js`; `--format nerdgraph|ui-paste`). Same model → mutation input / UI-paste blob.
- **Phase 5 (DEFERRED, separate spec likely) — live push.** `pushDashboard.js`, `--push`/`--env US|EU|staging` (explicit, no default), GUID-tracked `dashboardUpdate` via `.import-state.json`, `NEW_RELIC_API_KEY` env var. Verify emitted NRQL via the `nrql-validation` path before claiming a widget works.

## Testing

Vitest, in `packages/nr-dashboard-importer/test/` mirroring its `src/`. Pure functions (string/object in → object out) — no mocking, consistent with project-testing rules. Fixtures live in `test/fixtures/`, **de-identified** (corpus carries customer index/host/app names — scrub before committing, per the no-customer-data rule). Phase 0's migration must keep the translator package's test suite green with no behavior change.

- **detectFormat:** one test per input shape — REST envelope (multi-entry, mixed formats, `isDashboard:false` skipped), standalone Simple XML, Studio XML-wrapped (CDATA unwrap), Studio pure-JSON (synthetic, marked non-corpus). Assert correct format routing + count.
- **parseSimpleXml:** `<label>`→title; each viz element→neutral vizType; `<search base>`→baseRef + fragment; time input→defaultTimeRange; dropdown w/ populating search→variable+sourceQuery; computed layout for N-panel rows.
- **parseStudio:** `ds.search`/`ds.chain`(extend)/`ds.savedSearch`; viz→dataSource linkage via `primary`; nested chain→root resolution; `layout.structure` coords; inputs→variables.
- **translateWidgets:** base/chain concatenation produces translatable SPL (not leading-pipe parse error); clean→real widget; unsupported→markdown placeholder WITH SPL+reason, and WITHOUT an NRQL section when translator returns none; partial-NRQL labeled "unverified"; `{{tok}}` passthrough for non-time tokens; **time tokens already drop-and-warn** (assert no SINCE leaks — inherited from the shipped spec, regression-guarded here).
- **emitTerraform:** each vizType→correct `widget_*` block; layout→12-col grid (Studio px scaled, Simple XML computed); variable blocks (enum + nrql_query); `defaultTimeRange`→page range w/ snap-drop note; placeholder→`widget_markdown`. Emitted HCL parses (`terraform validate` in a Phase-2 integration check, if available).
- **Corpus gate (Phase 2+):** run the importer over the de-identified corpus sample; assert `threw === 0` (no dashboard crashes the importer — every failure is a placeholder, never an exception), and a coverage scorecard (clean/warned/placeholder counts) that must not regress.
- **AI-DEV markers** added to confirmed tests after the red-green-refactor cycle, per `llm-test-verification.md`.

## Verified gaps — 2026-06-18 integration sweep

A functional sweep (`test/integration/`: 10 fixtures — Splunk's own published Simple XML dashboards + corpus-SHAPED synthetics using generic field names only; results regenerated into `test/integration/GAP_INVENTORY.md`) surfaced two real bugs the unit suite misses because it only exercises chart/table/single with viz-level titles. Both are `it.skip` canaries that flip green when fixed. Neither crashes — emitted HCL still `terraform validate`s — so both are usefulness/fidelity gaps, not blockers.

1. **Silent viz-type drop — violates "loud placeholders, never drops" (priority: data loss).** `parseSimpleXml` iterates only `chart`/`table`/`single` (`parseSimpleXml.js:77-84`), so `event`/`map`/`html`/`viz` panels yield NO widget and NO placeholder — they vanish, grid slot included. ~63 such panels on the real corpus (49 html, 10 event, 4 map). The Testing section's "each viz element → neutral vizType" is aspirational, not shipped. **Fix:** iterate every viz tag; an unsupported viz TYPE that has a query → markdown placeholder (title + fenced SPL + reason); `<html>` (no query) → static markdown widget. Only then does the never-drops invariant actually hold.
2. **Panel-level titles dropped (priority: cosmetic, but pervasive).** Only the viz-level `<title>` is read; `<panel><title>` is ignored. On the real corpus ~70% of titles are panel-level (935 vs 406 viz-level), so the importer blanks the majority of widget titles (~48% untitled across the fixtures). Confirmed valid + common in Splunk's Simple XML reference (panel `<title>` is `0..1`, distinct from the per-viz title). **Fix:** in `parseSimpleXml`, use the viz title if present, else fall back to the panel-level `<title>`.

## Risks

- **Dependency tree growth.** `fast-xml-parser` + 5 transitive deps. Isolated in the `nr-dashboard-importer` package, so the translator package keeps its empty `dependencies` block and zero-dep guarantee for translate-only consumers. Verifying the package is genuine: done. Re-confirm all transitive licenses are permissive before merge — run the license check the security rules require.
- **Monorepo migration blast radius (Phase 0).** Moving the translator into `packages/nr-query-bridge/` touches every relative import, the husky hooks, CI workflows, package exports, and the sibling corpus harness's `../nr-query-bridge` path. A mistake here breaks the shipping translator, not just the new importer. Mitigate: do it mechanically in one isolated commit, full suite green before and after, no behavior change.
- **`terraform validate` only checks syntax, not semantics.** Valid HCL ≠ a dashboard NR will accept. Phase 5's `nrql-validation` path is where widget NRQL correctness is actually proven; until then, "emits valid `.tf`" is the honest claim — not "produces a working dashboard." State this in the report.
- **Base/post-process resolution is load-bearing and easy to get wrong.** A `<search base>` fragment translated without its base is a leading-pipe parse error → placeholder. Nested Studio `ds.chain` must walk to root. A bug here silently turns translatable panels into placeholders (under-reporting coverage). Test the concatenation directly.
- **Layout fidelity is approximate.** Simple XML has no coordinates; computed row/column layout won't match Splunk pixel-perfect. Acceptable — semantic fidelity (right query, right viz) matters more than exact placement. Note in report, don't chase.
- **`charting.chart` defaulting.** A `<chart>` with no `charting.chart` option defaults to `line` (per Splunk docs). The parser must apply that default, or such panels become `unknown`/placeholder wrongly.
- **Studio `theme`/decoration vizzes** (`splunk.rectangle`/`ellipse`/`image`/`markdown`-as-label) carry no query. Don't translate them; either skip or emit as static markdown. Don't placeholder-spam the dashboard with "unsupported" for pure decorations.
- **Customer data in fixtures.** The corpus is real customer dashboards (real customer index/host/app names). Every committed fixture MUST be de-identified. Synthetic-first; de-identify the one real sample. Gitignore raw corpus pulls.

## Open questions — verify before building on these

The load-bearing `[assumed]` calls a planner must resolve, each with what breaks if it's wrong:

1. **NR viz ids / Terraform widget block names** (Emit). The map is assumed; `scatter` is probably wrong. If wrong, widgets fail to emit or render. **Resolve:** introspect `Visualization` + read the provider schema before writing `model.js`'s emit map. Cheapest first step — one introspection query settles most of it.
2. **`{{var}}` must be emitted unquoted** (Translate §5). If the translator emits `'{{var}}'`, filters silently match nothing — a silent-wrong bug, the class this project most wants to avoid. **Resolve:** a test asserting unquoted emission; decide enum-vs-string variable type.
3. **NR dashboards may have no default-time field** (Emit). If true, Splunk default time can't be emitted anywhere — demote to a report note, don't invent a Terraform field. **Resolve:** introspect `PageInput`/`DashboardInput` for a time field.
4. **UI-paste envelope ≠ DashboardInput-minus-guids** (Emit). If we assume sameness, the paste blob fails NR1 import. **Resolve:** export one real dashboard from NR1, diff its JSON field-by-field against `DashboardInput` during Phase 4.
5. **Non-transforming base searches** (Translate §1). Concatenation can disagree with Splunk on large data. **Resolve:** detect transforming-vs-not; warn on non-transforming; don't claim equivalence.
6. **Studio gauge type strings** (Parser 2). Literal `splunk.*gauge` strings are version-dependent. **Resolve:** sample the 391 wrapped-Studio corpus entries.

The single highest-value pre-build check (settles 1, 2, 3, 4 at once): generate one UI-paste blob, paste it into NR1's import dialog against staging, with one widget carrying a `{{var}}`. One round-trip confirms the schema shape, the quoting, and the time-field question together.

## Deferred gaps (FIXME-tracked)

1. **Live NerdGraph push** (Phase 5) — env selection, GUID-tracked idempotent update, NRQL validation gate. Designed (seam exists) but not built near-term.
2. **Drilldowns / navigation** — Splunk `<drilldown>`/`<link>` → NR widget links. Dropped in v1; flag per widget that had one.
3. **`ds.savedSearch` bodies** — SPL not in the export; would need a second fetch of the saved-search definition (the corpus has `saved_searches.json` alongside — a future cross-reference could resolve these instead of placeholdering them).
4. **`depends`/`rejects` conditional visibility** — Splunk token-gated panel visibility → NR variable-conditional widgets. Recorded as a caveat in v1, not wired.
5. **Snap-to time** (`-60m@m`) — snap dropped with a note (NR has no snap); same class as the time-token spec's deferred literal-snap gap.

## Open-source publishing tasks (owed by the importer package)

The open-source readiness effort (PR #34; remaining publish runbook tracked in Jira NR-578293) scaffolded the translator package and the repo root, but **deferred the importer package's OSS files** because `packages/nr-dashboard-importer/` was empty when that work ran. The importer effort owned these (all landed in the importer PR):

1. **Switch the translator dependency to its public name.** The readiness work renamed the translator `@datanerd/nr-query-bridge` → `@newrelic/query-bridge`. Update the importer's `package.json` dependency and every `import … from '@datanerd/nr-query-bridge'` to `@newrelic/query-bridge`, or the workspace won't resolve once the readiness branch merges. (This spec's prose and diagram above now use `@newrelic/query-bridge` directly; the Phase 1 plan uses the new name throughout.)
2. **Set the importer's public publish metadata** in its `package.json`: `name: @newrelic/dashboard-importer`, `repository.directory: packages/nr-dashboard-importer`, and `publishConfig.access: public` (required for a scoped public package). The `@newrelic/` scope is pending OSPO approval; fallback is the unscoped `nr-dashboard-importer`.
3. **Add the importer's `LICENSE`** (copy the root Apache-2.0) and a short **npm-facing `README.md`** (experimental banner + install line + link back to the monorepo).
4. **Generate `THIRD_PARTY_NOTICES.md`** with `newrelic/newrelic-oss-cli`. Unlike the zero-dep translator, the importer ships `fast-xml-parser` + its 5 transitive deps, so this is a real file. Re-confirm those transitive licenses are permissive at the same time (the security rules require it — already flagged under Risks).
5. **Add the importer's dependabot npm entry** — `package-ecosystem: npm`, `directory: /packages/nr-dashboard-importer` in `.github/dependabot.yml` (the readiness PR added only the translator's entry).
