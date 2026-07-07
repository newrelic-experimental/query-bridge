# Architecture

`@newrelic/dashboard-importer` turns a **Splunk dashboard export** into a runnable
**New Relic Terraform** dashboard. It does *not* translate queries itself — it
parses the dashboard's structure (panels, layout, variables) and bridges each
panel's SPL through `@newrelic/query-bridge` (the SPL→NRQL translator documented
in that package's `ARCHITECTURE.md`).

The one-sentence mental model: **many Splunk export formats → one neutral
`DashboardModel` → a New Relic output**, with the query translator called as a
black box for each panel. Only one emitter exists today (Terraform), but the
model is emitter-agnostic so more can be added without touching the parsers.

## Pipeline

```
Splunk export (XML / Studio JSON / REST envelope)
   │
   ▼  detectFormat          split envelope, sniff/strip each unit → [{format, payload}]
   ▼  parseSimpleXml / parseStudio   payload → DashboardModel  (the seam)
   ▼  translateWidgets       each widget's SPL → NRQL, or a markdown placeholder
   ▼  translateVariables     Splunk <input>/token → NR variable block
   ▼  emitTerraform          DashboardModel → .tf files
   ▼  buildReport            coverage summary (.report.md)
New Relic Terraform
```

| Stage | What it does | Entry point |
|---|---|---|
| **Detect** | Split a bulk export, route each unit by format, strip envelopes/CDATA | `detectFormat.js` |
| **Parse** | One single-format payload → `DashboardModel` | `parseSimpleXml.js`, `parseStudio.js` |
| **Translate widgets** | Bridge each panel's SPL → NRQL, or flag a placeholder | `translateWidgets.js` |
| **Translate variables** | Splunk inputs/tokens → NR variable blocks | `translateVariables.js` |
| **Emit** | `DashboardModel` → Terraform (`.tf`) | `emitTerraform.js` |
| **Report** | Per-dashboard coverage summary | `report.js` |

Top-level orchestration: `runImport(input, opts)` in `bin/spl-dashboard.js`.

## File Map

- `bin/spl-dashboard.js` — CLI entry + `runImport` orchestrator (bulk loop, slug
  de-dup, per-unit isolation).
- `src/detectFormat.js` — format sniffing + envelope/CDATA unwrapping.
- `src/model.js` — the neutral `DashboardModel`, `Variable`, `Widget` shapes and
  their constructors; the `VIZ_TYPES` enum.
- `src/parseSimpleXml.js` — Splunk **Simple XML** → `DashboardModel`.
- `src/parseStudio.js` — Splunk **Dashboard Studio** JSON → `DashboardModel`.
- `src/translateWidgets.js` — the single placeholder chokepoint (SPL→NRQL or
  markdown placeholder).
- `src/translateVariables.js` — variable/token → NR variable block.
- `src/emitTerraform.js` — `DashboardModel` → three `.tf` files.
- `src/htmlToMarkdown.js` — Simple XML `<html>` panel bodies → markdown.
- `src/report.js` — coverage summary generator.

## The seam: `DashboardModel`

**Where it lives:** `src/model.js`.

This is the pivot of the whole design — the same "narrow waist" idea the query
translator uses for queries, applied one level up to whole dashboards. Two
parsers produce a `DashboardModel`; the emitter (and report) consume it.
**Nothing downstream of the parsers branches on `sourceFormat`.** Simple XML and
Studio JSON look nothing alike, but by the time they've been parsed, they're the
same shape and the rest of the pipeline can't tell them apart.

```
DashboardModel {
  title, description, sourceFormat,
  variables: Variable[],           // dropdowns/text inputs → NR variables
  defaultTimeRange: {earliest, latest} | null,
  widgets: Widget[],               // panels, in layout order
}

Widget {
  title, vizType,                  // neutral enum: line|area|bar|…|markdown|unknown
  rawSpl,                          // the panel's SPL, to be translated
  baseRef,                         // base-search id, if any
  unsupportedReason,               // set by the parser → forces a placeholder
  options,                         // viz-specific extras (e.g. markdown text)
  layout: {x, y, w, h},            // NR 12-column grid slot
}
```

The **`vizType` enum is the parser↔emitter contract.** Adding a visualization
type touches one map on each side (a parser's format→vizType map, the emitter's
vizType→block map) — never the stages in between.

## The chokepoint: `translateWidgets`

**Where it lives:** `src/translateWidgets.js`.

Every widget passes through exactly one function that decides its fate. This is
the codebase's guarantee that **nothing is ever silently dropped or emitted
wrong** — the same "loud failure over silent wrong results" policy the query
translator enforces. A widget becomes a **markdown placeholder** (which preserves
the original SPL and the reason, in the same grid slot) when any of these hold:

1. The parser already flagged it (`widget.unsupportedReason` is set — e.g. an
   event/map panel, or an unresolvable base search).
2. The query is empty (never translate `''` into a silent `FROM Log SELECT *`).
3. The query translator returns `unsupported` or `errors`.
4. The translated viz type has no New Relic widget block
   (`vizType ∉ EMITTABLE_VIZ_TYPES`).

Otherwise the widget is **clean** and carries its NRQL forward. Two shapes are
never interchangeable: a placeholder emits a `markdown` text widget, never an
`nrql_query` block. Conversely, a widget that already *is* markdown (a Studio
image rendered `![](url)`, or a native `splunk.markdown` body carried in
`options.text`) is emitted as clean markdown — there's nothing to translate.

`EMITTABLE_VIZ_TYPES` is derived from the emitter's `WIDGET_BLOCK` map and shared
here, so the two can't drift. The emitter *throws* if a non-emittable vizType
reaches it — the chokepoint guarantees that can't happen, so a throw means a
pipeline bug, never a silent degrade.

## Detect & unwrap: `detectFormat`

**Where it lives:** `src/detectFormat.js`.

Splunk exports arrive in three shapes, and this stage is the *only* place that
untangles them — downstream parsers each receive one clean, single-format
payload and never re-unwrap:

- **REST export envelope** — `{"entry":[…]}` where each entry's `content` has an
  `eai:data` string. One envelope can carry *many* dashboards. `detectFormat`
  expands it to one unit per entry, skips non-dashboard views
  (`content.isDashboard === false`), and routes each by `content.version` (`2` →
  Studio, else Simple XML).
- **Dashboard Studio** — either XML-wrapped (`<dashboard version="2">` with the
  real JSON inside a `<definition><![CDATA[…]]>`) or pure JSON. Either way,
  `detectFormat` hands the parser the stripped inner JSON.
- **Simple XML** — `<form>` or `<dashboard>` (no version 2).

It returns `{format, payload}[]`. A malformed envelope (missing `entry[]`, or a
Studio v2 with no `<definition>` CDATA) throws loudly — a top-level error, never
a half-parse.

## The two parsers

Both target `DashboardModel`; that's the whole point of the seam. They differ
only in how they read their source format.

### `parseSimpleXml`

Simple XML is Splunk's older declarative dashboard format: `<row>` → `<panel>` →
a viz child (`<chart>`, `<table>`, `<single>`, `<event>`, `<map>`, `<html>`).
The parser:

- **Classifies every viz child** — `chart`/`table`/`single` become real widgets;
  `event`/`map`/`html`/`viz`/`list` become placeholder-bound widgets (with an
  `unsupportedReason`). It never iterates a fixed tuple that lets an unknown viz
  tag silently vanish.
- **Folds per-panel time into the base search** — a panel `<search>` with literal
  `<earliest>/<latest>` siblings is prepended as `earliest=… latest=…` so the
  query translator emits `SINCE`/`UNTIL`.
- **Resolves base searches** — a document-wide `id→query` map resolves
  `<search base="id">`. A non-transforming base composes as `base | post-process`;
  a transforming, missing, or saved-search base becomes a placeholder.
- **Reads `<fieldset>/<input>`** into `model.variables`; a `<chart>` with no
  charting option defaults to `line` (Splunk's default).

### `parseStudio`

**Where it lives:** `src/parseStudio.js`.

Dashboard Studio is the newer JSON format: a `layout.structure[]` for widget
order and pixel positions, a `visualizations` map, and a `dataSources` map.

- **`VIZ_MAP`** matches the `visualizations.<id>.type` field exactly (never a
  substring): `splunk.line`/`column`/`bar`/`area`/`pie`/`scatter` → the matching
  neutral type; `splunk.table`/`events` → table; `splunk.singlevalue`* →
  billboard; `splunk.markdown` → markdown; `splunk.choropleth.svg` → map. An
  unrecognized `splunk.*` → `unknown` + a loud `unsupportedReason`.
- **`resolveDataSource`** walks `ds.chain` back to its root and composes
  `parent | fragment` SPL — building **no** subquery logic of its own (the
  one-way dependency: importer → translator, never the reverse). A cycle, a
  missing dsId, or a `ds.savedSearch`/`ds.csv` root → placeholder.
- **`pxToGrid`** is a deliberately lossy map from Studio pixels to NR's 12-column
  grid (via `CANVAS_W` and `ROW_PX`): proportions preserved, exact pixels not.
  Normalization lives in the parser so the seam stays grid-only.
- **Decorations** (`splunk.rectangle`/`ellipse`) are dropped, not placeholdered;
  `splunk.image` becomes clean markdown only if its `src` is `http(s)`.

> **Interim guard.** Because the query translator historically emitted silently
> wrong NRQL for `eval`/`head` *after* a transforming base (`stats`, `timechart`,
> …), `resolveDataSource` placeholders exactly that shape (`TRANSFORMING` regex +
> `GUARDED_POST` regex). This is temporary — once the translator's
> post-aggregation subquery/fold work lands, the guard is removed and those
> chains upgrade from placeholders to real widgets. Do **not** broaden it into a
> blanket transforming-base placeholder.

## Emitter: `emitTerraform`

**Where it lives:** `src/emitTerraform.js`. Produces **three files**:

- `<slug>.tf` — the `newrelic_one_dashboard` resource (pages, widgets, variables).
- `versions.tf` — the provider pin (`newrelic ~> 3`). No `backend` block — that's
  the consumer's concern.
- `variables.tf` — the `account_id` variable, a sensitive `newrelic_api_key`, and
  the provider block. **Never** contains a literal API key.

`WIDGET_BLOCK` maps each neutral vizType to a real provider widget block. Most
map one-to-one (`line`→`widget_line`, `area`→`widget_area`, `pie`→`widget_pie`,
`table`, `billboard`, `markdown`); `column` is the one that collapses onto
another type's block (`widget_bar`). There is no scatter/map block — those were
placeholdered upstream. `EMITTABLE_VIZ_TYPES` is `Object.keys(WIDGET_BLOCK)` —
the single source of truth shared with the chokepoint.

Two properties the emitter guarantees:

- **Deterministic** — re-running on the same input produces byte-identical
  output, so `terraform apply` reconciles cleanly.
- **Safe identifiers** — `slugify` prefixes digit-leading names (Terraform
  identifiers can't start with a digit), and emitted HCL escapes Terraform's
  `${…}`/`%{…}` and Splunk `$token$` delimiters so the `.tf` stays valid.

The provider `region` (`--region`, default `US`) is validated at the CLI
boundary; `Staging` routes the provider to `staging-api.newrelic.com`.

## Bulk import & per-unit isolation

`runImport` maps over `detectFormat`'s units, **each in its own try/catch**. One
malformed entry in a bulk export never aborts its siblings or emits a half-built
dashboard — it's recorded as `{skipped:true, index, reason}` and surfaced on
stderr. An all-skipped export is still success (exit 0). Slugs are de-duplicated
across the export (first wins the bare slug, then `-2`, `-3`).

## Worked Example

Input — a Simple XML panel with a per-panel time range:

```xml
<dashboard>
  <label>Web Health</label>
  <row><panel>
    <title>Errors by host</title>
    <chart>
      <search>
        <query>index=web status=500 | stats count by host</query>
        <earliest>-24h</earliest><latest>now</latest>
      </search>
      <option name="charting.chart">bar</option>
    </chart>
  </panel></row>
</dashboard>
```

### Stage 1: detect → `[{format:'simple-xml', payload:<xml>}]`

Not an envelope, not Studio — one Simple XML unit.

### Stage 2: parse → `DashboardModel`

```js
{
  title: 'Web Health', sourceFormat: 'simple-xml', variables: [],
  widgets: [{
    title: 'Errors by host',
    vizType: 'bar',
    rawSpl: 'earliest=-24h latest=now index=web status=500 | stats count by host',
    layout: { x: 0, y: 0, w: 12, h: 3 },
    unsupportedReason: null,
  }],
}
```

The `<earliest>/<latest>` folded into `rawSpl`; the `charting.chart=bar` option
set `vizType: 'bar'`.

### Stage 3: translateWidgets → clean widget

`translateSplToNrql(rawSpl)` returns clean NRQL, and `bar ∈ EMITTABLE_VIZ_TYPES`:

```sql
FROM Log SELECT count(*) WHERE index = 'web'
  AND status = '500' OR numeric(status) = 500
FACET host SINCE 24 hours ago
```

### Stage 4: emit → Terraform

```hcl
resource "newrelic_one_dashboard" "web_health" {
  name = "Web Health"
  page {
    name = "Web Health"
    widget_bar {
      title  = "Errors by host"
      row = 1  column = 1  width = 12  height = 3
      nrql_query {
        account_id = var.account_id
        query = "FROM Log SELECT count(*) WHERE …"
      }
    }
  }
}
```

Plus `versions.tf`, `variables.tf`, and `web_health.report.md`.

## See also

- `packages/nr-query-bridge/docs/ARCHITECTURE.md` — the SPL→NRQL translator this
  package delegates to.
- `packages/nr-query-bridge/docs/PATTERNS.md` — the textbook compiler patterns
  (the seam, chokepoint, and loud-failure ideas here are the same ones, applied
  to dashboards).
- `.claude/rules/design-decisions.md` — the authoritative, load-bearing
  invariants for both packages (Dashboard Importer / Dashboard Studio sections).
