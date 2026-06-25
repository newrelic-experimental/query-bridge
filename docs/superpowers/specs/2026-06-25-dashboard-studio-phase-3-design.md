# Dashboard Studio Importer (Phase 3) — Design

**Date:** 2026-06-25
**Status:** Draft — pending review
**Scope:** `@newrelic/dashboard-importer` only. No `@newrelic/query-bridge` (translator) changes.

## Summary

The importer translates Splunk **Simple XML** dashboards to New Relic Terraform today (Phases 0–2,
merged). It cannot read **Dashboard Studio** — the second Splunk format — nor the **REST export
envelope** (`dashboards.json`) that real exports ship as. This phase adds `parseStudio.js` and
teaches `detectFormat` to unwrap the REST envelope, so a real bulk export imports end to end.

Studio dashboards exist *only* inside the REST envelope in the corpus (844 raw `version:"2"` matches;
the dashboard subset is smaller after the `isDashboard` filter — Phase 0 recon reconciles the exact
count; 0 standalone Studio files, 0 pure-JSON — verified 2026-06-25). So the envelope path is the only
way to verify the Studio parser against real data, not optional breadth. Constraint: the seam
(`DashboardModel` → `translateWidgets` → `emitTerraform`) stays untouched — both new parsers target
the same neutral model, and nothing downstream branches on source format.

## Problem

- **No Studio support.** `detectFormat` throws `"Dashboard Studio (version 2) is not yet supported"`
  for both XML-wrapped and pure-JSON Studio. Studio is ~18% of the corpus (844/4,665) — a real gap.
- **No REST envelope support.** `detectFormat` throws on `{entry:[…]}` with `eai:data`. The importer
  reads one standalone payload; it cannot ingest the `dashboards.json` a Splunk admin actually exports.
- **Chain dataSources are common and unhandled.** Studio's `ds.chain` (post-process on a parent
  dataSource) appears 1,201 times in the corpus. Without chain resolution those panels lose their base
  scope.

**Success criteria (measurable):**
1. A real `dashboards.json` imports with `threw === 0` across its wrapped-Studio entries.
2. Zero silently-dropped widgets (every source viz → a real widget or a loud placeholder), matching
   the Simple XML `GAP_INVENTORY.md` bar.
3. `ds.chain` resolves to the root dataSource; an unresolvable root (savedSearch/csv) → placeholder.
4. A real Studio dashboard emits valid Terraform (`terraform validate` passes where available).

## Proposed approach

### Data flow (the structural change)

```
file/stdin ─▶ detectFormat ─▶ {format, payload}[]   (REST envelope → many; single file → one)
                                    │  dispatch per unit on format
                        ┌────────────┴────────────┐
                  parseSimpleXml             parseStudio (NEW)
                        └────────────┬────────────┐
                              DashboardModel[] ─▶ translateWidgets ─▶ emitTerraform  (UNCHANGED)
```

**`detectFormat(input)` now returns `{format:'simple-xml'|'studio', payload:string}[]`** (was a single
format string used only for its throw). It owns all unwrapping:
- REST envelope: iterate `entry[]`; skip `content.isDashboard === false` (110 in corpus); route each by
  `content.version` (`"2"`→studio, else simple-xml); payload = `content["eai:data"]`.
- Studio XML-wrapped: `<dashboard version="2">…<definition><![CDATA[{JSON}]]></definition>` → strip
  wrapper + CDATA → JSON string.
- Studio pure-JSON: starts `{`, has `dataSources`/`visualizations` → pass through (synthetic; 0 in corpus).
- Single Simple XML / single Studio file → a 1-element array.

**`runImport` returns `{slug, files}[]`** (was one). The CLI writes each dashboard under `out/<slug>/`
for a multi-dashboard export; a single-file input keeps today's flat output.

### `parseStudio.js` (new) — JSON graph → `DashboardModel`

- **dataSources** → `id → {type, query, extend}`. `ds.search`→`query=options.query`;
  `ds.chain`→`extend=options.extend` + `query=options.query`; `ds.savedSearch`/`ds.csv`→no inline SPL.
- **Chain resolution (delegate; approach A).** Walk `extend` to the root and compose `root | mid | leaf`
  into `rawSpl` **unconditionally** — no transforming-base check in the parser. A cycle or a root with no
  inline SPL → `unsupportedReason` (placeholder). The translator then either subquery-wraps the composed
  SPL (real widget) or returns `unsupported` (→ chokepoint placeholder). The importer builds **no**
  wrapping logic; it rides the translator's `wrapAsSubquery` (and the in-flight `compound-chain-collapse`
  improvements — coverage grows with zero importer change).
- **visualizations** → widgets via the viz map (below). `dataSources.primary` → source dsId; `title`,
  `options` carried. Decoration vizzes (`rectangle`/`ellipse`/`image`) have no dataSource → **skipped,
  never placeholdered**.
- **inputs** → `input.timerange`→`defaultTimeRange` (parse `options.defaultValue` like `"-24h@h,now"`);
  `input.dropdown`/`text`/`multiselect`→`variables[]`, mirroring the shipped Simple XML variable logic
  (static items→enum, search-backed→nrql/static fallback, multiselect→`multi`).
- **layout** → iterate `layout.structure[]` (gives widget order + px `{x,y,w,h}`); **normalize px→NR
  12-col grid in the parser**, so `model.layout` is always grid units. This keeps the seam format-agnostic
  (Simple XML already emits grid units) and lets Studio emit correctly now.

### Viz-type map (corpus-confirmed 2026-06-25)

| neutral | Studio type strings (corpus count) |
|---|---|
| `table` | `splunk.table` (2594), `splunk.events` (105) |
| `billboard` | `splunk.singlevalue` (1879), `splunk.singlevalueradial` (26), `splunk.markergauge` (5), `splunk.fillergauge` (1) |
| `markdown` | `splunk.markdown` (892) |
| `line` | `splunk.line` (732) |
| `column` | `splunk.column` (537) |
| `pie` | `splunk.pie` (279) |
| `area` | `splunk.area` (63) |
| `map` | `splunk.choropleth` (62) |
| `bar` | `splunk.bar` (61) |
| `scatter` | `splunk.scatter` (2) |
| (skip) | `splunk.rectangle` (310), `splunk.image` (58), `splunk.ellipse` (2) — decorations, no query |
| `unknown`→placeholder | `splunk.sankey` (4), `splunk.singlevalueicon` (3), any unrecognized `splunk.*` |

### Error handling — loud failure preserved

Everything funnels through the existing `translateWidgets` chokepoint: unresolvable chain root,
untranslatable composed SPL, unknown viz type → markdown placeholder (title + fenced original SPL +
reason), never silent-wrong. Malformed JSON or a missing `dataSources`/`visualizations` key → throw at
the detector with a clear message, consistent with today's loud-failure behavior.

## Alternatives considered

- **Build subquery-wrapping in the importer** (rejected): duplicates the translator's hardest machinery,
  breaks the one-way importer→translator dependency, and double-maintains the exact code being reworked
  on `fix/subquery-wrapping`.
- **Mirror Simple XML's parser-side transforming-base placeholder** (rejected for Studio): more
  conservative than the translator already is — it would placeholder `stats`-rooted chains the translator
  can wrap, and gets worse-relative as the rework lands. The reverse — converging Simple XML onto the
  delegate model — is the subject of a sibling spec.
- **Keep `detectFormat` a pure sniffer + add a separate dispatcher** (rejected): the
  `detectFormat owns unwrapping` invariant already lives in `design-decisions.md`; splitting unwrap from
  sniff would contradict it.

## Consequences, risk, and tradeoffs

- **Format divergence (accepted, temporary).** Studio chains delegate to the translator while Simple XML
  bases placeholder transforming bases in-parser. The two converge via the sibling Simple XML spec; until
  then they differ. Reversible — it's a code path, not data.
- **Placeholder rate on transforming chains is unknown until recon.** If many of the 1,201 chains root in
  a transforming base the translator can't yet wrap, Studio coverage starts lower and climbs as
  `compound-chain-collapse` lands. Phase 0 recon quantifies this; the bar is loud-failure, not coverage.
- **px→grid normalization is lossy.** Splunk's absolute pixel layout maps approximately onto NR's 12-col
  grid; widget proportions are preserved, exact pixel positions are not. Acceptable — NR has no px grid.
- **`runImport` shape change is a one-way contract break** for that internal function (single→array). Its
  only caller is the CLI; the integration tests move with it. Not published API.

## Scope

- **In:** `parseStudio.js`; REST-envelope + Studio unwrapping in `detectFormat`; chain composition
  (delegate); px→grid normalization; Studio inputs→variables; bulk CLI output (`out/<slug>/`).
- **Out (own specs/phases):** `emitNerdGraph`/`emitUiPaste` (Phase 4); live push (`pushDashboard`); the
  Simple XML→delegate convergence (sibling spec, `2026-06-25-simplexml-base-delegate-design.md`).

## Test plan

- **Phase 0 recon (read-only, before building).** Via `grep` + the sibling `corpus-diagnostic.mjs`
  harness: pin any long-tail viz strings, quantify the `ds.chain`→transforming-root rate (the placeholder
  cost), and confirm `input.timerange` `defaultValue` / input option shapes. Numbers land in the plan.
- **Fixtures.** Synthetic pure-JSON + synthetic XML-wrapped Studio (hand-written, generic field names),
  **plus** real de-identified Studio dashboards extracted from the corpus into fixture files.
- **Integration.** Extend `dashboards.integration.test.js` + `GAP_INVENTORY.md`; bar = `threw === 0`
  across the wrapped-Studio corpus subset, 0 silent drops, coverage scorecard recorded.
- **E2E smoke.** One real Studio dashboard → valid `.tf` (`terraform validate` where available).
- **Units** per the project's explicit-test style (no fixture loops): detector routing (envelope expand,
  `isDashboard` skip, CDATA strip, version routing), chain walk (search root, chain→chain→search,
  savedSearch root → placeholder, cycle guard), viz map (each row + decoration skip + unknown placeholder),
  layout normalization, inputs→variables.
- **NRQL validation caveat:** confirm any emitted NRQL via `run_nerdgraph_query`, never a single
  `execute_nrql_query` verdict (CLAUDE.md).

## Review checklist

- [ ] `detectFormat` return-shape change (`{format,payload}[]`) — is the array contract the right seam, vs.
  a separate dispatcher?
- [ ] Chain delegation (no transforming-base check in `parseStudio`) — agree this is the right division
  vs. the translator?
- [ ] px→grid normalization living in the parser (not deferred to emit) — agree?
- [ ] Decoration vizzes skipped (not placeholdered) — correct, or should they leave a trace?
- [ ] Bulk CLI output layout (`out/<slug>/`) — right convention for a multi-dashboard export?
