# Splunk Dashboard Importer Design

**Goal:** Import a Splunk dashboard export, translate every panel's SPL to NRQL through the existing bridge, and emit a New Relic dashboard. The importer is a *consumer* of the translator layered on top of it — it adds no translation logic and does not touch `src/translate.js` or the IR pipeline. Output is file-based (Terraform first, NerdGraph JSON later); live API push is a deferred phase.

**Relationship to the time-token spec.** This builds directly on `docs/superpowers/specs/2026-06-11-dashboard-time-tokens-design.md` (shipped). Splunk dashboards are the *source* of the `$tok.earliest$` / `$earliest$` / `span=$timespan$` tokens that spec handles. The importer inherits correct behavior for free: time-bound tokens drop-and-warn, `span=$token$` is unsupported, and the **NR dashboard's own time picker owns the window** — exactly the "dashboard owns the whole range" case that spec was written for. The importer adds nothing in the time-token path; it relies on it.

## Scope

**In scope (all of it — staged, not dropped):**
- Both Splunk dashboard formats: **Simple XML** (classic `<form>`/`<dashboard version="1.1">`) and **Dashboard Studio** (`<dashboard version="2">` JSON-in-CDATA, and pure-JSON).
- Both delivery shapes: standalone `.xml` view files, and the Splunk REST API export envelope (`dashboards.json` — `{entry:[{content:{"eai:data":"…"}}]}`).
- Output: New Relic dashboard as **Terraform** (`newrelic_one_dashboard`) first; NerdGraph `DashboardInput` JSON in a later phase.
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

A pipeline of small, pure stages, mirroring the translator's own `SPL → AST → IR → NRQL` shape. A neutral **`DashboardModel`** sits between Splunk-parsing and NR-emission — both parsers target it, both emitters consume it. This is the load-bearing seam: two structurally different parsers (XML tree-walk vs. Studio JSON-graph) feed one emitter, and two output formats (Terraform, NerdGraph JSON) read one model, without either side multiplying against the other.

```
import (path/string)
  → detectFormat        ┌─ parseSimpleXml ─┐
  → (route per format) ─┤                  ├─→ DashboardModel ─→ translateWidgets ─→ emit{Terraform|NrJson} ─→ files
                        └─ parseStudio ────┘   (neutral IR)      (per widget,         (+ report.md)
                                                                  via translate())
                                                              [later] → pushDashboard (NerdGraph, network)
```

All stages are pure (string/object in → object out) except the two endpoints: file read at the front, file write at the back. No stage downstream of the parsers branches on source format — the model absorbs the difference.

### File layout — importer is self-contained

The importer lives entirely under `src/dashboard/`, separate from the translation pipeline (`src/input/`, `src/ir/`, `src/output/`). One-way dependency: `src/dashboard/ → src/translate.js`, never the reverse. The translator stays a pure zero-dep library that knows nothing about dashboards.

```
src/
  input/ ir/ output/ translate.js   ← translator (UNTOUCHED, zero-dep)
  dashboard/                        ← NEW, self-contained
    detectFormat.js     ← sniff envelope/format, unwrap, route
    parseSimpleXml.js   ← <form>/<dashboard v1> tree-walk → DashboardModel
    parseStudio.js      ← Studio JSON graph → DashboardModel
    model.js            ← DashboardModel factory + neutral vizType enum + viz maps
    translateWidgets.js ← THE bridge into translate(); base/chain resolution
    emitTerraform.js    ← DashboardModel → newrelic_one_dashboard .tf  (Phase 1)
    emitNrJson.js       ← DashboardModel → NerdGraph DashboardInput     (later phase)
    report.js           ← per-dashboard coverage report
    pushDashboard.js    ← NerdGraph mutation (DEFERRED phase, only network stage)
bin/
  spl-dashboard.js                  ← NEW CLI entry
test/
  dashboard/                        ← NEW, mirrors src/dashboard/
    fixtures/                       ← scrubbed sample exports (synthetic + de-identified)
```

### Dependency decision — XML parser

Parsing Simple XML requires an XML parser; the repo currently has **zero runtime dependencies**. Decision: use **`fast-xml-parser` 5.8.0** (MIT; pure-JS, no native bindings; browser-compatible — `"module": "./src/fxp.js"`, `sideEffects:false`; ~72.9M weekly downloads; maintainer Amit Gupta / NaturalIntelligence). Verified real against two independent npm endpoints (registry record + downloads API) 2026-06-12 — not a hallucinated or typosquatted package.

Caveat recorded honestly: it pulls **5 transitive deps** (`@nodable/entities`, `fast-xml-builder`, `path-expression-matcher`, `strnum`, `xml-naming`), so it does expand the dependency tree. Mitigation: it is imported **only under `src/dashboard/`**. The core translator entry (`src/translate.js`) never imports it, so package consumers who only translate SPL strings pull zero new deps. If the importer is later split into its own package, this seam already isolates it. The browser-compatibility bar was the user's explicit constraint — `fast-xml-parser` meets it; a Node-only parser (e.g. `@xmldom/xmldom` requiring Node globals) was rejected for that reason.

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

## Emit — Terraform first (`emitTerraform.js`, Phase 1)

`DashboardModel` → a `newrelic_one_dashboard` resource (HCL). **Terraform is the Phase-1 target because `terraform apply` gives idempotent create-and-update on re-run for free** — no GUID-tracking, no file-overwrite logic to prove the pipeline. Aligns with NR observability-as-code standard D-5 (infrastructure as testable idempotent code).

- Dashboard → one `newrelic_one_dashboard` with `name`, `description`, one `page` block (one Splunk view → one NR page).
- Widget → a `widget_<type>` block (`widget_line`, `widget_billboard`, `widget_table`, `widget_markdown`, …) with `title`, grid `column`/`row`/`width`/`height`, and `nrql_query { account_id, query }`.
- Neutral `vizType` → Terraform widget block: `line→widget_line`, `area→widget_area`, `bar→widget_bar`, `column→widget_bar` (NR has no column; orientation is config), `pie→widget_pie`, `billboard→widget_billboard`, `table→widget_table`, `markdown→widget_markdown`, `scatter→widget_scatter`, `map→widget_markdown`+note (NR choropleth needs geo fields the SPL won't carry — flag, don't fake), `unknown→widget_markdown` placeholder.
- **Layout → 12-col grid:** Studio px coords scaled to columns 1–12; Simple XML computed (row→row, `12/panelCount`→width). Placeholders take the failed widget's slot.
- **Variables → `variable` blocks:** static `<choice>` → `enum` items; populating `sourceQuery` → translated and emitted as the variable's `nrql_query`; `*`-default → "any". Resolve token names so `{{tok_category}}` in widget NRQL matches the variable name.
- **Time range → page/dashboard default:** `defaultTimeRange` `-60m@m` → NR `since`/`duration`; snap suffix `@m` dropped with a note (NR has no snap — loud-not-silent, consistent with the token spec).
- The exact `newrelic_one_dashboard` field names/nesting are **verified against the provider docs during implementation** (the registry page is JS-rendered; not guessed here).

**Filenames are stable** — slugified Splunk dashboard name → `<slug>.tf`. Re-running overwrites in place; `terraform apply` reconciles. A REST export yields a directory of `.tf` files plus one roll-up report.

NerdGraph JSON emit (`emitNrJson.js`) is a later phase, same model in, `DashboardInput` out.

## Report (`report.js`)

Per dashboard: N widgets, M clean, K warned, J placeholders (with reason each). Emitted as `<slug>.report.md` and printed to stderr. A bulk REST import produces a directory of reports + one roll-up — an auditable coverage trail, not a silent pile of HCL. Mirrors the translator's own corpus-diagnostic ethos.

## CLI (`bin/spl-dashboard.js`)

```
spl-dashboard <file>                 # → <slug>.tf + <slug>.report.md (Phase 1)
spl-dashboard <dashboards.json>      # REST export → directory of .tf + reports
cat dash.xml | spl-dashboard         # stdin
spl-dashboard <file> --out ./dir     # output directory
spl-dashboard <file> --account 12345 # account_id baked into emitted nrql_query blocks
spl-dashboard <file> --format json   # NerdGraph JSON instead of .tf (later phase)
# --push / --env: DEFERRED phase, not in near-term build
```

`--account <id>` (Phase 1) supplies the `account_id` baked into emitted `nrql_query` blocks (required by Terraform); defaults to a placeholder `var.account_id` so the `.tf` is valid without one. `--push`/`--env` are the only DEFERRED flags.

## Build phases

All formats are in scope; this is build order. **Phase 1 is a vertical slice** (thinnest end-to-end path to prove the pipeline); then breadth.

- **Phase 1 — vertical slice, Terraform-only.** One Simple XML file → `detectFormat` (single-file path) → `parseSimpleXml` (minimal: `<chart>`/`<table>`/`<single>` → `line`/`table`/`billboard`, no variables, no base/post-process) → `translateWidgets` → `emitTerraform` → `<slug>.tf`. CLI single-file mode. Proves model + translate + emit end-to-end. Stable filename re-run (overwrite). One real (de-identified) dashboard fixture + synthetic edge fixtures.
- **Phase 2 — Simple XML breadth.** All viz types incl. `<html>`/`<map>`/gauges; template variables (static + populating-search); base/post-process resolution; placeholder widgets for unsupported/errors; `defaultTimeRange` → page range; REST-envelope bulk path (skip `isDashboard:false`); per-dashboard + roll-up reports.
- **Phase 3 — Dashboard Studio.** `parseStudio` for both XML-wrapped (CDATA) and pure-JSON; `ds.search`/`ds.chain`/`ds.savedSearch`; viz/dataSource graph linkage; `layout.structure` px→grid; Studio inputs → variables. Pure-JSON path synthetic (no corpus sample).
- **Phase 4 — NerdGraph JSON emit** (`emitNrJson.js`, `--format json`). Same model → `DashboardInput`.
- **Phase 5 (DEFERRED, separate spec likely) — live push.** `pushDashboard.js`, `--push`/`--env US|EU|staging` (explicit, no default), GUID-tracked `dashboardUpdate` via `.import-state.json`, `NEW_RELIC_API_KEY` env var. Verify emitted NRQL via the `nrql-validation` path before claiming a widget works.

## Testing

Vitest, `test/dashboard/` mirroring `src/dashboard/`. Pure functions (string/object in → object out) — no mocking, consistent with project-testing rules. Fixtures live in `test/dashboard/fixtures/`, **de-identified** (corpus carries customer index/host/app names — scrub before committing, per the no-customer-data rule).

- **detectFormat:** one test per input shape — REST envelope (multi-entry, mixed formats, `isDashboard:false` skipped), standalone Simple XML, Studio XML-wrapped (CDATA unwrap), Studio pure-JSON (synthetic, marked non-corpus). Assert correct format routing + count.
- **parseSimpleXml:** `<label>`→title; each viz element→neutral vizType; `<search base>`→baseRef + fragment; time input→defaultTimeRange; dropdown w/ populating search→variable+sourceQuery; computed layout for N-panel rows.
- **parseStudio:** `ds.search`/`ds.chain`(extend)/`ds.savedSearch`; viz→dataSource linkage via `primary`; nested chain→root resolution; `layout.structure` coords; inputs→variables.
- **translateWidgets:** base/chain concatenation produces translatable SPL (not leading-pipe parse error); clean→real widget; unsupported→markdown placeholder WITH SPL+reason, and WITHOUT an NRQL section when translator returns none; partial-NRQL labeled "unverified"; `{{tok}}` passthrough for non-time tokens; **time tokens already drop-and-warn** (assert no SINCE leaks — inherited from the shipped spec, regression-guarded here).
- **emitTerraform:** each vizType→correct `widget_*` block; layout→12-col grid (Studio px scaled, Simple XML computed); variable blocks (enum + nrql_query); `defaultTimeRange`→page range w/ snap-drop note; placeholder→`widget_markdown`. Emitted HCL parses (`terraform validate` in a Phase-2 integration check, if available).
- **Corpus gate (Phase 2+):** run the importer over the de-identified corpus sample; assert `threw === 0` (no dashboard crashes the importer — every failure is a placeholder, never an exception), and a coverage scorecard (clean/warned/placeholder counts) that must not regress.
- **AI-DEV markers** added to confirmed tests after the red-green-refactor cycle, per `llm-test-verification.md`.

## Risks

- **Dependency tree growth.** `fast-xml-parser` + 5 transitive deps breaks the zero-runtime-dep property. Mitigated by confining imports to `src/dashboard/` (core translator stays clean) and verifying the package is genuine (done). Re-confirm license (MIT) survives transitive deps before merge — run the license check the security rules require.
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
