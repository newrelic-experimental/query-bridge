# Dashboard Studio Importer (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Worktree caveat:** the controller makes every commit — subagents in a worktree commit to the wrong branch (project memory).

**Goal:** Add a Dashboard Studio parser and REST-envelope unwrapping to `@newrelic/dashboard-importer` so a real Splunk `dashboards.json` export imports end to end.

**Architecture:** `detectFormat` unwraps the REST envelope and returns a `{format,payload}[]` list; a dispatcher routes each unit to `parseSimpleXml` (existing) or `parseStudio` (new); both target the unchanged `DashboardModel`. Studio chains delegate composition to the translator (approach A) behind a narrow interim guard for the shapes master can't yet wrap. No translator (`@newrelic/query-bridge`) changes.

**Tech Stack:** Pure ESM JS, `fast-xml-parser` (importer only), Vitest, Terraform `newrelic/newrelic` provider for validation. Spec: `docs/superpowers/specs/2026-06-25-dashboard-studio-phase-3-design.md`.

## Global Constraints

- Dev requires Node 24: prefix every command `ASDF_NODEJS_VERSION=24.14.0 <cmd>`.
- Commit messages: lowercase subject ≤72 chars; body lines ≤100 (commitlint); conventional (`feat:`/`fix:`/`chore:`); `git commit -F <file>` for multi-line bodies.
- Run one package in isolation: `npm run test --workspace=@newrelic/dashboard-importer -- <file>`.
- Loud failure over silent wrong: every source viz → a real widget or a loud placeholder; nothing untranslatable emitted as correct. Only pure-shape decorations (rectangle/ellipse, and image with no usable URL) are silently dropped.
- NRQL is built only via the translator / query builders — the importer never hand-writes NRQL.
- AI-DEV markers go on a test ONLY after it passes the full red-green (or mutation) cycle — never cargo-culted.
- `verified` may only be set to `false` by AI; humans promote to `'llm'`/`'human'`.
- All synthetic test data uses INVENTED field names/values — never names copied from the corpus.

---

## Task 0: Recon (read-only — no commit)

Measure before building. Findings feed Tasks 5–7; record them in a scratch note (not committed).

- [ ] **Step 1: Confirm Studio viz `type` strings.** From the sibling corpus, list exact dotted `visualizations.<id>.type` values and counts. Confirm: `splunk.choropleth.svg` (not `splunk.choropleth`), `splunk.singlevalueicon`, the three gauges. Command (read-only): `grep -oE 'splunk\.[a-zA-Z.]+' <corpus>/dashboards.json | sort | uniq -c | sort -rn`.
- [ ] **Step 2: Quantify the interim-guard cost.** Using the sibling `corpus-diagnostic.mjs` harness, count how many `ds.chain` dataSources resolve to a *transforming* root whose post-process is `eval`/`head` (the shapes the interim guard placeholders). Record the percentage — this is the coverage the guard defers until `fix/subquery-wrapping` lands.
- [ ] **Step 3: Confirm layout pixel conventions.** From a sample of wrapped-Studio entries, record the typical `layout.options.width` (canvas width px) and item `position.h` values, to fix `CANVAS_W`/`ROW_PX` constants in Task 4. Default assumptions if absent: `CANVAS_W = 1200`, `ROW_PX = 100`.
- [ ] **Step 4: Confirm `input.timerange` default shapes.** Sample `options.defaultValue` values; confirm both the comma-pair form (`"-24h@h,now"`) and any named-preset (non-comma) form exist. Record examples (de-identified).

No commit — this is measurement.

---

## Task 1: `detectFormat` returns `{format, payload}[]`

Change the contract from a single format string to a list of unwrapped units. This task keeps behavior identical for single Simple XML input and preserves the loud throws for envelope/Studio (Tasks 2–3 replace those).

**Files:**
- Modify: `packages/nr-dashboard-importer/src/detectFormat.js`
- Modify: `packages/nr-dashboard-importer/src/detectFormat.js` consumers — `packages/nr-dashboard-importer/bin/spl-dashboard.js:31`
- Test: `packages/nr-dashboard-importer/test/detectFormat.test.js`

**Interfaces:**
- Produces: `detectFormat(input: string): {format: 'simple-xml'|'studio', payload: string}[]`. A single Simple XML document → a 1-element array. `payload` is the clean, parser-ready string.

- [ ] **Step 1: Update the existing simple-xml tests to expect an array.**

```javascript
it('detects <form> as a single simple-xml unit', () => {
  expect(detectFormat('<form>\n<label>X</label>\n</form>')).toEqual([
    { format: 'simple-xml', payload: '<form>\n<label>X</label>\n</form>' },
  ]);
});

it('detects <dashboard version="1.1"> as a single simple-xml unit', () => {
  const xml = '<dashboard version="1.1"><label>X</label></dashboard>';
  expect(detectFormat(xml)).toEqual([{ format: 'simple-xml', payload: xml }]);
});

it('detects a leading-whitespace / xml-decl prefixed <form> as simple-xml', () => {
  const xml = '<?xml version="1.0"?>\n  <form><label>X</label></form>';
  expect(detectFormat(xml)).toEqual([{ format: 'simple-xml', payload: xml }]);
});
```

- [ ] **Step 2: Run the tests, confirm they fail.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- detectFormat`
Expected: FAIL — `detectFormat` returns the string `'simple-xml'`, not an array.

- [ ] **Step 3: Change the simple-xml return to a 1-element array.**

In `detectFormat.js`, replace `return 'simple-xml';` with:

```javascript
return [{ format: 'simple-xml', payload: input }];
```

Leave the REST-envelope and Studio `throw`s in place for now (Tasks 2–3 replace them). The two throw-tests still pass unchanged.

- [ ] **Step 4: Run the tests, confirm they pass.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- detectFormat`
Expected: PASS (all five).

- [ ] **Step 5: Update the `runImport` caller so the suite stays green.**

In `bin/spl-dashboard.js`, `runImport` currently does `detectFormat(xml);` for its throw side-effect then `parseSimpleXml(xml)`. Keep behavior for now — Task 8 rewrites `runImport` to consume the list. For this task, change line 31 to assert the single-unit shape so nothing silently regresses:

```javascript
const units = detectFormat(xml);
const model = parseSimpleXml(units[0].payload);
```

- [ ] **Step 6: Run the full importer suite.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer`
Expected: PASS (all existing tests green — behavior unchanged).

- [ ] **Step 7: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-dashboard-importer/src/detectFormat.js packages/nr-dashboard-importer/bin/spl-dashboard.js packages/nr-dashboard-importer/test/detectFormat.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "refactor: detectFormat returns a {format,payload}[] list"
```

---

## Task 2: `detectFormat` — REST envelope expansion

A Splunk REST export is `{entry:[{content:{...}}]}`. SPL/JSON lives only in `content["eai:data"]`. Skip `content.isDashboard === false`. Route each entry by `content.version` (`"2"`→studio, else simple-xml).

**Files:**
- Modify: `packages/nr-dashboard-importer/src/detectFormat.js`
- Test: `packages/nr-dashboard-importer/test/detectFormat.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `detectFormat` on a REST envelope → one unit per dashboard entry; non-dashboard entries omitted.

- [ ] **Step 1: Write failing tests.**

```javascript
it('expands a REST envelope into one unit per dashboard entry', () => {
  const env = JSON.stringify({
    entry: [
      { content: { version: '1.1', isDashboard: true, 'eai:data': '<form><label>A</label></form>' } },
      { content: { version: '2', isDashboard: true, 'eai:data': '<dashboard version="2"><definition><![CDATA[{"dataSources":{},"visualizations":{}}]]></definition></dashboard>' } },
    ],
  });
  const units = detectFormat(env);
  expect(units).toHaveLength(2);
  expect(units[0].format).toBe('simple-xml');
  expect(units[1].format).toBe('studio');
});

it('skips entries with isDashboard === false', () => {
  const env = JSON.stringify({
    entry: [
      { content: { version: '1.1', isDashboard: false, 'eai:data': '<form/>' } },
      { content: { version: '1.1', isDashboard: true, 'eai:data': '<form><label>B</label></form>' } },
    ],
  });
  const units = detectFormat(env);
  expect(units).toHaveLength(1);
  expect(units[0].format).toBe('simple-xml');
});

it('returns an empty list for an all-skipped envelope (not an error)', () => {
  const env = JSON.stringify({ entry: [{ content: { isDashboard: false, 'eai:data': '<form/>' } }] });
  expect(detectFormat(env)).toEqual([]);
});
```

Also delete the old `throws ... REST envelope ... Phase 2` test (replaced by the above).

- [ ] **Step 2: Run, confirm fail.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- detectFormat`
Expected: FAIL — current code throws on the envelope.

- [ ] **Step 3: Implement envelope expansion.**

Replace the REST-envelope `throw` block in `detectFormat.js` with expansion. At the top of `detectFormat`, before the single-payload sniffing:

```javascript
if (trimmed.startsWith('{') && /"eai:data"/.test(trimmed)) {
  const env = JSON.parse(trimmed);
  if (!Array.isArray(env.entry)) {
    throw new Error('Splunk REST envelope has no entry[] array.');
  }
  const units = [];
  for (const e of env.entry) {
    const content = e?.content ?? {};
    if (content.isDashboard === false) continue; // non-dashboard view
    const payload = content['eai:data'];
    if (typeof payload !== 'string') continue;
    const format = String(content.version ?? '') === '2' ? 'studio' : 'simple-xml';
    // Re-run the single-payload unwrap (Task 3 handles Studio CDATA strip).
    units.push(...detectUnit(payload, format));
  }
  return units;
}
```

Refactor the single-payload sniff (the `<form>`/`<dashboard>` branch + Studio branch) into a helper `detectUnit(payload, hint)` that returns `{format, payload}[]`; `detectFormat` calls `detectUnit(input)` for the non-envelope path. The `hint` lets the envelope path trust `content.version` over sniffing.

- [ ] **Step 4: Run, confirm pass.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- detectFormat`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-dashboard-importer/src/detectFormat.js packages/nr-dashboard-importer/test/detectFormat.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: expand the Splunk REST envelope in detectFormat"
```

---

## Task 3: `detectFormat` — Studio unwrapping (CDATA strip + pure JSON)

Studio arrives XML-wrapped (`<dashboard version="2"><definition><![CDATA[{JSON}]]></definition></dashboard>`) or as pure JSON. Strip the wrapper to clean JSON. Route to `format: 'studio'`.

**Files:**
- Modify: `packages/nr-dashboard-importer/src/detectFormat.js`
- Test: `packages/nr-dashboard-importer/test/detectFormat.test.js`

**Interfaces:**
- Produces: a `{format:'studio', payload}` whose `payload` is the inner JSON string (CDATA stripped), ready for `parseStudio` (Task 4).

- [ ] **Step 1: Write failing tests.**

```javascript
it('unwraps an XML-wrapped Studio dashboard to its JSON payload', () => {
  const xml = '<dashboard version="2"><definition><![CDATA[{"dataSources":{},"visualizations":{}}]]></definition></dashboard>';
  const units = detectFormat(xml);
  expect(units).toHaveLength(1);
  expect(units[0].format).toBe('studio');
  expect(JSON.parse(units[0].payload)).toEqual({ dataSources: {}, visualizations: {} });
});

it('passes a pure-JSON Studio dashboard straight through', () => {
  const json = '{"dataSources":{},"visualizations":{},"layout":{}}';
  const units = detectFormat(json);
  expect(units).toHaveLength(1);
  expect(units[0].format).toBe('studio');
  expect(units[0].payload).toBe(json);
});
```

Delete the old `throws ... Dashboard Studio ... Phase 3` test.

- [ ] **Step 2: Run, confirm fail.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- detectFormat`
Expected: FAIL — current code throws on Studio.

- [ ] **Step 3: Implement Studio unwrapping in `detectUnit`.**

Replace the two Studio `throw`s with:

```javascript
// Studio XML-wrapped: strip the wrapper + CDATA to the inner JSON.
if (/^<dashboard\b[^>]*\bversion\s*=\s*["']2/.test(body)) {
  const m = body.match(/<definition>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/definition>/);
  if (!m) throw new Error('Studio v2 dashboard has no <definition> CDATA JSON.');
  return [{ format: 'studio', payload: m[1].trim() }];
}
// Studio pure JSON.
if (body.startsWith('{') && /"dataSources"|"visualizations"/.test(body)) {
  return [{ format: 'studio', payload: input }];
}
```

- [ ] **Step 4: Run, confirm pass.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- detectFormat`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-dashboard-importer/src/detectFormat.js packages/nr-dashboard-importer/test/detectFormat.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: unwrap XML-wrapped and pure-JSON Studio in detectFormat"
```

---

## Task 4: `parseStudio` — skeleton (title, inline source, one widget, layout)

The new parser: JSON string → `DashboardModel`. This task handles the happy path — a dashboard `title`, an inline `ds.search`, recognized viz types, and px→grid layout. Decorations/image/unknown/title-fallback (Task 5), chains (Task 6), inputs (Task 7) follow.

**Files:**
- Create: `packages/nr-dashboard-importer/src/parseStudio.js`
- Test: `packages/nr-dashboard-importer/test/parseStudio.test.js`

**Interfaces:**
- Consumes: `createDashboardModel`, `createWidget` from `model.js`; the `{format:'studio', payload}` from `detectFormat`.
- Produces: `parseStudio(json: string): DashboardModel`; module-level `VIZ_MAP` (Studio type → neutral vizType) and `DECORATION` (Set) reused by Task 5.

- [ ] **Step 1: Write the failing happy-path test.** All-synthetic invented names.

```javascript
import { describe, it, expect } from 'vitest';
import { parseStudio } from '../src/parseStudio.js';

describe('parseStudio — skeleton', () => {
  it('reads title/description and one inline-search line widget', () => {
    const doc = JSON.stringify({
      title: 'Gadget Board',
      description: 'synthetic',
      dataSources: { ds_alpha: { type: 'ds.search', options: { query: 'search wibble > 5' } } },
      visualizations: { viz_one: { type: 'splunk.line', title: 'Wibbles', dataSources: { primary: 'ds_alpha' } } },
      layout: { structure: [{ item: 'viz_one', position: { x: 0, y: 0, w: 600, h: 100 } }], options: { width: 1200 } },
    });
    const m = parseStudio(doc);
    expect(m.title).toBe('Gadget Board');
    expect(m.sourceFormat).toBe('studio');
    expect(m.widgets).toHaveLength(1);
    expect(m.widgets[0].vizType).toBe('line');
    expect(m.widgets[0].title).toBe('Wibbles');
    expect(m.widgets[0].rawSpl).toBe('search wibble > 5');
    expect(m.widgets[0].layout).toEqual({ x: 0, y: 0, w: 6, h: 1 });
  });
});
```

- [ ] **Step 2: Run, confirm fail.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- parseStudio`
Expected: FAIL — `parseStudio.js` does not exist.

- [ ] **Step 3: Write `parseStudio.js`.**

```javascript
import { createDashboardModel, createWidget } from './model.js';

const CANVAS_W = 1200; // Studio default canvas width (confirm in Task 0 recon)
const ROW_PX = 100; // Studio row-height assumption (confirm in Task 0 recon)

/** Studio visualization type → neutral vizType. Corpus-confirmed 2026-06-25. */
const VIZ_MAP = {
  'splunk.table': 'table',
  'splunk.events': 'table',
  'splunk.singlevalue': 'billboard',
  'splunk.singlevalueradial': 'billboard',
  'splunk.markergauge': 'billboard',
  'splunk.fillergauge': 'billboard',
  'splunk.markdown': 'markdown',
  'splunk.line': 'line',
  'splunk.column': 'column',
  'splunk.bar': 'bar',
  'splunk.area': 'area',
  'splunk.pie': 'pie',
  'splunk.scatter': 'scatter',
  'splunk.choropleth.svg': 'map',
};
/** Pure-shape decorations: no query, no widget (silently dropped). */
const DECORATION = new Set(['splunk.rectangle', 'splunk.ellipse']);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Studio pixel position → NR 12-column grid {x,y,w,h}. */
function pxToGrid(pos, canvasW) {
  const W = canvasW || CANVAS_W;
  const x = clamp(Math.round((pos.x / W) * 12), 0, 11);
  const w = clamp(Math.round((pos.w / W) * 12), 1, 12 - x);
  const y = Math.max(0, Math.round((pos.y ?? 0) / ROW_PX));
  const h = Math.max(1, Math.round((pos.h ?? ROW_PX) / ROW_PX));
  return { x, y, w, h };
}

/** Resolve a dataSource id to SPL. ds.chain / savedSearch / csv handled in Task 6. */
function resolveDataSource(dsId, dataSources) {
  const ds = dataSources[dsId];
  if (!ds) {
    return { rawSpl: '', unsupportedReason: dsId ? `data source "${dsId}" not found` : null };
  }
  if (ds.type === 'ds.search') return { rawSpl: ds.options?.query ?? '', unsupportedReason: null };
  return { rawSpl: '', unsupportedReason: `data source type "${ds.type}" not yet handled` };
}

function buildWidget(viz, dataSources, layout) {
  const vizType = VIZ_MAP[viz.type] ?? 'unknown';
  const resolved = resolveDataSource(viz.dataSources?.primary, dataSources);
  return createWidget({
    title: viz.title ?? '',
    vizType,
    rawSpl: resolved.rawSpl,
    unsupportedReason:
      vizType === 'unknown'
        ? `no New Relic equivalent for Studio visualization "${viz.type}"`
        : resolved.unsupportedReason,
    layout,
  });
}

/** @param {string} json Studio dashboard JSON (CDATA already stripped by detectFormat). */
export function parseStudio(json) {
  const doc = JSON.parse(json);
  const dataSources = doc.dataSources ?? {};
  const visualizations = doc.visualizations ?? {};
  const structure = doc.layout?.structure ?? [];
  const canvasW = doc.layout?.options?.width ?? CANVAS_W;

  const widgets = [];
  for (const item of structure) {
    const viz = visualizations[item.item];
    if (!viz) continue; // structure points at a missing viz — nothing to emit
    widgets.push(buildWidget(viz, dataSources, pxToGrid(item.position ?? {}, canvasW)));
  }
  return createDashboardModel({
    title: doc.title ?? doc.label ?? '',
    description: doc.description ?? '',
    sourceFormat: 'studio',
    widgets,
  });
}
```

- [ ] **Step 4: Run, confirm pass.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- parseStudio`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-dashboard-importer/src/parseStudio.js packages/nr-dashboard-importer/test/parseStudio.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: add parseStudio skeleton (inline search, viz map, layout)"
```

---

## Task 5: `parseStudio` — decorations, image, unknown, title fallback

Resolve the clean-room edge cases: pure-shape decorations drop; `splunk.image` → markdown widget iff it has an `http(s)` URL, else drop; unrecognized types → loud placeholder; title falls back then trims to empty.

**Files:**
- Modify: `packages/nr-dashboard-importer/src/parseStudio.js`
- Test: `packages/nr-dashboard-importer/test/parseStudio.test.js`

**Interfaces:**
- Produces: `buildWidget` returns `Widget | null` (null = dropped); `parseStudio`'s loop skips nulls.

- [ ] **Step 1: Write failing tests.**

```javascript
describe('parseStudio — viz behavior', () => {
  const wrap = (visualizations, structure) =>
    JSON.stringify({ title: 'T', dataSources: {}, visualizations, layout: { structure, options: { width: 1200 } } });

  it('drops pure-shape decorations (no widget)', () => {
    const m = parseStudio(wrap(
      { v_rect: { type: 'splunk.rectangle' }, v_ell: { type: 'splunk.ellipse' } },
      [{ item: 'v_rect', position: { x: 0, y: 0, w: 100, h: 100 } }, { item: 'v_ell', position: { x: 0, y: 100, w: 100, h: 100 } }],
    ));
    expect(m.widgets).toHaveLength(0);
  });

  it('turns an image WITH an http(s) URL into a markdown widget', () => {
    const m = parseStudio(wrap(
      { v_img: { type: 'splunk.image', options: { src: 'https://cdn.test/zonk.png' } } },
      [{ item: 'v_img', position: { x: 0, y: 0, w: 600, h: 100 } }],
    ));
    expect(m.widgets).toHaveLength(1);
    expect(m.widgets[0].vizType).toBe('markdown');
    expect(m.widgets[0].options.text).toBe('![](https://cdn.test/zonk.png)');
  });

  it('drops an image with no usable URL', () => {
    const m = parseStudio(wrap(
      { v_img: { type: 'splunk.image', options: { src: 'file:///tmp/zonk.png' } } },
      [{ item: 'v_img', position: { x: 0, y: 0, w: 600, h: 100 } }],
    ));
    expect(m.widgets).toHaveLength(0);
  });

  it('placeholders an unrecognized viz type (loud, never guessed)', () => {
    const m = parseStudio(wrap(
      { v_x: { type: 'splunk.sankey', title: 'Flow', dataSources: { primary: 'ds_x' } } },
      [{ item: 'v_x', position: { x: 0, y: 0, w: 600, h: 100 } }],
    ));
    expect(m.widgets).toHaveLength(1);
    expect(m.widgets[0].vizType).toBe('unknown');
    expect(m.widgets[0].unsupportedReason).toMatch(/no New Relic equivalent.*splunk\.sankey/);
    expect(m.widgets[0].title).toBe('Flow');
  });

  it('falls back to empty title and trims whitespace-only titles', () => {
    const m = parseStudio(wrap(
      { v_a: { type: 'splunk.line' }, v_b: { type: 'splunk.line', title: '   ' } },
      [{ item: 'v_a', position: { x: 0, y: 0, w: 600, h: 100 } }, { item: 'v_b', position: { x: 6, y: 0, w: 600, h: 100 } }],
    ));
    expect(m.widgets[0].title).toBe('');
    expect(m.widgets[1].title).toBe('');
  });
});
```

- [ ] **Step 2: Run, confirm fail.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- parseStudio`
Expected: FAIL — decorations currently become `unknown` placeholders; image isn't special-cased; titles aren't trimmed.

- [ ] **Step 3: Revise `buildWidget` + add `titleOf`; skip nulls in the loop.**

Replace `buildWidget` with:

```javascript
function titleOf(viz) {
  return String(viz.title ?? viz.options?.title ?? '').trim();
}

function buildWidget(viz, dataSources, layout) {
  if (DECORATION.has(viz.type)) return null; // pure shape — dropped, no widget
  if (viz.type === 'splunk.image') {
    const src = viz.options?.src ?? '';
    if (/^https?:\/\//i.test(src)) {
      return createWidget({ title: titleOf(viz), vizType: 'markdown', options: { text: `![](${src})` }, layout });
    }
    return null; // image without a usable URL — dropped, not placeholdered
  }
  const vizType = VIZ_MAP[viz.type] ?? 'unknown';
  const resolved = resolveDataSource(viz.dataSources?.primary, dataSources);
  return createWidget({
    title: titleOf(viz),
    vizType,
    rawSpl: resolved.rawSpl,
    unsupportedReason:
      vizType === 'unknown'
        ? `no New Relic equivalent for Studio visualization "${viz.type}"`
        : resolved.unsupportedReason,
    layout,
  });
}
```

In `parseStudio`, change the push to skip nulls:

```javascript
const widget = buildWidget(viz, dataSources, pxToGrid(item.position ?? {}, canvasW));
if (widget) widgets.push(widget);
```

- [ ] **Step 4: Run, confirm pass.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- parseStudio`
Expected: PASS (skeleton + viz-behavior).

- [ ] **Step 5: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-dashboard-importer/src/parseStudio.js packages/nr-dashboard-importer/test/parseStudio.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: studio decorations, image-to-markdown, unknown placeholders"
```

---

## Task 6: `parseStudio` — chain resolution + interim guard

Resolve `ds.chain` by walking `extend` to the root and composing `root | fragment...`. Unresolvable roots (savedSearch/csv), missing ids, and cycles → placeholder. The interim guard placeholders `eval`/`head` post-process on a *transforming* root (silently-wrong on master until `fix/subquery-wrapping` lands).

**Files:**
- Modify: `packages/nr-dashboard-importer/src/parseStudio.js`
- Test: `packages/nr-dashboard-importer/test/parseStudio.test.js`

**Interfaces:**
- Produces: `resolveDataSource(dsId, dataSources, seen?)` now handles `ds.chain` recursively; returns `{rawSpl, unsupportedReason}`.

- [ ] **Step 1: Write failing tests.**

```javascript
describe('parseStudio — chain resolution', () => {
  const oneViz = (dataSources, primary) => JSON.stringify({
    title: 'T', dataSources,
    visualizations: { v: { type: 'splunk.table', title: 'W', dataSources: { primary } } },
    layout: { structure: [{ item: 'v', position: { x: 0, y: 0, w: 1200, h: 100 } }], options: { width: 1200 } },
  });

  it('composes a chain root | fragment', () => {
    const m = parseStudio(oneViz({
      ds_root: { type: 'ds.search', options: { query: 'search gizmo=7' } },
      ds_pp: { type: 'ds.chain', options: { extend: 'ds_root', query: '| where zone_q=3' } },
    }, 'ds_pp'));
    expect(m.widgets[0].rawSpl).toBe('search gizmo=7 | where zone_q=3');
    expect(m.widgets[0].unsupportedReason).toBeNull();
  });

  it('composes a nested chain (chain -> chain -> search) in order', () => {
    const m = parseStudio(oneViz({
      ds_root: { type: 'ds.search', options: { query: 'search gizmo=7' } },
      ds_pp1: { type: 'ds.chain', options: { extend: 'ds_root', query: '| fields a' } },
      ds_pp2: { type: 'ds.chain', options: { extend: 'ds_pp1', query: '| where a>1' } },
    }, 'ds_pp2'));
    expect(m.widgets[0].rawSpl).toBe('search gizmo=7 | fields a | where a>1');
  });

  it('placeholders a chain whose root is a saved search (no inline SPL)', () => {
    const m = parseStudio(oneViz({
      ds_saved: { type: 'ds.savedSearch', options: { ref: 'some_report' } },
      ds_pp: { type: 'ds.chain', options: { extend: 'ds_saved', query: '| head 5' } },
    }, 'ds_pp'));
    expect(m.widgets[0].unsupportedReason).toMatch(/ds\.savedSearch|no inline query/);
  });

  it('placeholders a chain that extends a missing id', () => {
    const m = parseStudio(oneViz({
      ds_pp: { type: 'ds.chain', options: { extend: 'ds_ghost', query: '| head 5' } },
    }, 'ds_pp'));
    expect(m.widgets[0].unsupportedReason).toMatch(/not found/);
  });

  it('placeholders a chain cycle without hanging', () => {
    const m = parseStudio(oneViz({
      ds_a: { type: 'ds.chain', options: { extend: 'ds_b', query: '| where x=1' } },
      ds_b: { type: 'ds.chain', options: { extend: 'ds_a', query: '| where y=2' } },
    }, 'ds_a'));
    expect(m.widgets[0].unsupportedReason).toMatch(/cycle/);
  });

  it('interim guard: eval after a transforming root -> placeholder', () => {
    const m = parseStudio(oneViz({
      ds_root: { type: 'ds.search', options: { query: 'search gizmo=7 | stats count by zone_q' } },
      ds_pp: { type: 'ds.chain', options: { extend: 'ds_root', query: '| eval rate = count / 60' } },
    }, 'ds_pp'));
    expect(m.widgets[0].unsupportedReason).toMatch(/not yet translatable/);
  });

  it('non-transforming root + eval fragment composes (delegates to translator)', () => {
    const m = parseStudio(oneViz({
      ds_root: { type: 'ds.search', options: { query: 'search gizmo=7' } },
      ds_pp: { type: 'ds.chain', options: { extend: 'ds_root', query: '| eval k = a + b' } },
    }, 'ds_pp'));
    expect(m.widgets[0].rawSpl).toBe('search gizmo=7 | eval k = a + b');
    expect(m.widgets[0].unsupportedReason).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm fail.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- parseStudio`
Expected: FAIL — `ds.chain` currently returns "not yet handled".

- [ ] **Step 3: Replace `resolveDataSource` with the recursive chain walk.**

Add near the top of `parseStudio.js`:

```javascript
// Transforming commands: a base ending in one needs subquery wrapping to compose.
const TRANSFORMING = /\|\s*(stats|timechart|chart|top|rare|dedup)\b/i;
// Interim guard (remove when fix/subquery-wrapping lands): eval/head after a
// transforming base is silently-wrong NRQL on master — placeholder it instead.
const GUARDED_POST = /\|\s*(eval|head)\b/i;
```

Replace `resolveDataSource`:

```javascript
function resolveDataSource(dsId, dataSources, seen = new Set()) {
  const ds = dataSources[dsId];
  if (!ds) {
    return { rawSpl: '', unsupportedReason: dsId ? `data source "${dsId}" not found` : null };
  }
  if (ds.type === 'ds.search') {
    return { rawSpl: ds.options?.query ?? '', unsupportedReason: null };
  }
  if (ds.type === 'ds.chain') {
    if (seen.has(dsId)) {
      return { rawSpl: '', unsupportedReason: `data source chain cycles at "${dsId}"` };
    }
    seen.add(dsId);
    const parent = resolveDataSource(ds.options?.extend, dataSources, seen);
    if (parent.unsupportedReason) return parent; // propagate missing/savedSearch/cycle
    const fragment = (ds.options?.query ?? '').replace(/^\s*\|?\s*/, '').trim();
    if (!fragment) return { rawSpl: parent.rawSpl, unsupportedReason: null };
    if (TRANSFORMING.test(parent.rawSpl) && GUARDED_POST.test('| ' + fragment)) {
      const cmd = fragment.split(/\s+/)[0];
      return {
        rawSpl: '',
        unsupportedReason: `chain post-process "${cmd}" on a transforming base is not yet translatable (pending subquery-wrapping fix)`,
      };
    }
    return { rawSpl: `${parent.rawSpl} | ${fragment}`, unsupportedReason: null };
  }
  // ds.savedSearch / ds.csv — no inline SPL in the document.
  return { rawSpl: '', unsupportedReason: `data source "${dsId}" is a ${ds.type} (no inline query)` };
}
```

- [ ] **Step 4: Run, confirm pass.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- parseStudio`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-dashboard-importer/src/parseStudio.js packages/nr-dashboard-importer/test/parseStudio.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: resolve studio ds.chain with cycle and interim guards"
```

---

## Task 7: `parseStudio` — inputs → variables + defaultTimeRange

A time-range input sets `defaultTimeRange` (comma pair → `{earliest,latest}`; named preset → skip; first input wins). Dropdown/text/multiselect → `variables[]`. Search-backed dropdowns degrade to a free-text string in Phase 3 (nrql-backed Studio dropdowns are a noted follow-up — the Studio dynamic-source field shape needs recon before relying on it).

**Files:**
- Modify: `packages/nr-dashboard-importer/src/parseStudio.js`
- Test: `packages/nr-dashboard-importer/test/parseStudio.test.js`

**Interfaces:**
- Consumes: `createVariable` from `model.js`.
- Produces: `parseInputs(inputs): {variables: Variable[], defaultTimeRange: {earliest,latest}|null}`.

- [ ] **Step 1: Write failing tests.**

```javascript
describe('parseStudio — inputs', () => {
  const withInputs = (inputs) => JSON.stringify({ title: 'T', dataSources: {}, visualizations: {}, layout: { structure: [] }, inputs });

  it('parses a comma time-range default into defaultTimeRange', () => {
    const m = parseStudio(withInputs({ i_t: { type: 'input.timerange', options: { token: 'tr', defaultValue: '-24h@h,now' } } }));
    expect(m.defaultTimeRange).toEqual({ earliest: '-24h@h', latest: 'now' });
    expect(m.variables).toHaveLength(0); // time input is not a variable
  });

  it('skips a named-preset time default (no comma)', () => {
    const m = parseStudio(withInputs({ i_t: { type: 'input.timerange', options: { defaultValue: 'last_cycle_preset' } } }));
    expect(m.defaultTimeRange).toBeNull();
  });

  it('first time input wins when several exist', () => {
    const m = parseStudio(withInputs({
      i_a: { type: 'input.timerange', options: { defaultValue: '-7d,now' } },
      i_b: { type: 'input.timerange', options: { defaultValue: '-1h,now' } },
    }));
    expect(m.defaultTimeRange).toEqual({ earliest: '-7d', latest: 'now' });
  });

  it('maps a static dropdown to an enum variable', () => {
    const m = parseStudio(withInputs({ i_d: { type: 'input.dropdown', options: { token: 'zone', defaultValue: 'z_a', items: [{ label: 'Zone A', value: 'z_a' }, { label: 'Zone B', value: 'z_b' }] } } }));
    expect(m.variables[0]).toMatchObject({ name: 'zone', type: 'enum', defaultValue: 'z_a', multi: false });
    expect(m.variables[0].choices).toEqual([{ value: 'z_a', title: 'Zone A' }, { value: 'z_b', title: 'Zone B' }]);
  });

  it('maps a text input to a string variable and a multiselect to multi', () => {
    const m = parseStudio(withInputs({
      i_x: { type: 'input.text', options: { token: 'q', defaultValue: '' } },
      i_m: { type: 'input.multiselect', options: { token: 'tags', items: [{ label: 'P', value: 'p' }] } },
    }));
    expect(m.variables.find((v) => v.name === 'q')).toMatchObject({ type: 'string' });
    expect(m.variables.find((v) => v.name === 'tags')).toMatchObject({ type: 'enum', multi: true });
  });
});
```

- [ ] **Step 2: Run, confirm fail.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- parseStudio`
Expected: FAIL — `parseStudio` ignores `inputs`.

- [ ] **Step 3: Add `parseInputs` and wire it in.**

Add `createVariable` to the `model.js` import. Add:

```javascript
function parseInputs(inputs) {
  const variables = [];
  let defaultTimeRange = null;
  for (const [id, input] of Object.entries(inputs)) {
    const opts = input.options ?? {};
    const name = opts.token ?? id;
    if (input.type === 'input.timerange') {
      if (defaultTimeRange) continue; // first time input wins (NR has one picker)
      const dv = String(opts.defaultValue ?? '');
      if (dv.includes(',')) {
        const [earliest, latest] = dv.split(',');
        defaultTimeRange = { earliest: earliest.trim(), latest: latest.trim() };
      }
      continue; // named preset (no comma) → skip; time input never becomes a variable
    }
    if (input.type === 'input.text') {
      variables.push(createVariable({ name, type: 'string', defaultValue: String(opts.defaultValue ?? '') }));
      continue;
    }
    if (input.type === 'input.dropdown' || input.type === 'input.multiselect') {
      const multi = input.type === 'input.multiselect';
      const items = Array.isArray(opts.items) ? opts.items : [];
      if (items.length) {
        const choices = items.map((it) => ({
          value: String(it.value ?? it.label ?? ''),
          title: String(it.label ?? it.value ?? ''),
        }));
        variables.push(createVariable({ name, type: 'enum', choices, defaultValue: String(opts.defaultValue ?? ''), multi }));
      } else {
        // Search-backed or empty: degrade to free-text (nrql-backed Studio dropdowns deferred).
        variables.push(createVariable({ name, type: 'string', defaultValue: String(opts.defaultValue ?? ''), multi }));
      }
    }
    // Unknown input type → no variable (not silently wrong; simply absent).
  }
  return { variables, defaultTimeRange };
}
```

In `parseStudio`, replace the `return createDashboardModel({...})` with:

```javascript
const { variables, defaultTimeRange } = parseInputs(doc.inputs ?? {});
return createDashboardModel({
  title: doc.title ?? doc.label ?? '',
  description: doc.description ?? '',
  sourceFormat: 'studio',
  variables,
  defaultTimeRange,
  widgets,
});
```

- [ ] **Step 4: Run, confirm pass.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- parseStudio`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-dashboard-importer/src/parseStudio.js packages/nr-dashboard-importer/test/parseStudio.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: parse studio inputs into variables and default time range"
```

---

## Task 8: CLI — `runImport` returns an array; dispatch per unit; bulk output

`runImport` consumes the `detectFormat` list, dispatches each unit to the right parser, and returns `{slug, files}[]`. The CLI writes one dashboard's files flat (single input) or under `out/<slug>/` (bulk).

**Files:**
- Modify: `packages/nr-dashboard-importer/bin/spl-dashboard.js`
- Test: `packages/nr-dashboard-importer/test/cli.test.js`

**Interfaces:**
- Consumes: `detectFormat → {format,payload}[]`; `parseSimpleXml`, `parseStudio`.
- Produces: `runImport(input, opts): {slug, files}[]`.

- [ ] **Step 1: Update existing `runImport` tests to index `[0]`, add a bulk test.**

In `cli.test.js`, change the three `runImport` happy-path assertions to read the first result, and add a bulk case:

```javascript
it('produces the three tf files and a report keyed by slug', () => {
  const [out] = runImport(xml, { account: null });
  expect(out.files['versions.tf']).toContain('newrelic/newrelic');
  expect(out.files['variables.tf']).toContain('variable "account_id"');
  expect(out.files['cli-dash.tf']).toContain('newrelic_one_dashboard');
  expect(out.files['cli-dash.report.md']).toContain('1 widgets');
  expect(out.slug).toBe('cli-dash');
});

it('bakes the account id when --account is given', () => {
  const [out] = runImport(xml, { account: 999 });
  expect(out.files['cli-dash.tf']).toContain('account_id = 999');
});

it('threads --region into the provider block', () => {
  const [out] = runImport(xml, { account: 1, region: 'Staging' });
  expect(out.files['variables.tf']).toMatch(/region\s+= "Staging"/);
});

it('imports a REST envelope of two dashboards (XML + Studio) as two results', () => {
  const studioDef = '{"title":"Gizmo Board","dataSources":{"d":{"type":"ds.search","options":{"query":"search a=1"}}},"visualizations":{"v":{"type":"splunk.table","title":"W","dataSources":{"primary":"d"}}},"layout":{"structure":[{"item":"v","position":{"x":0,"y":0,"w":1200,"h":100}}],"options":{"width":1200}}}';
  const env = JSON.stringify({
    entry: [
      { content: { version: '1.1', isDashboard: true, 'eai:data': xml } },
      { content: { version: '2', isDashboard: true, 'eai:data': `<dashboard version="2"><definition><![CDATA[${studioDef}]]></definition></dashboard>` } },
    ],
  });
  const results = runImport(env, { account: null });
  expect(results).toHaveLength(2);
  expect(results.map((r) => r.slug).sort()).toEqual(['cli-dash', 'gizmo-board']);
});
```

- [ ] **Step 2: Run, confirm fail.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- cli`
Expected: FAIL — `runImport` returns a single object, not an array.

- [ ] **Step 3: Rewrite `runImport` + `main`'s write loop.**

Add the import: `import { parseStudio } from '../src/parseStudio.js';`. Replace `runImport`:

```javascript
function parseUnit(unit) {
  return unit.format === 'studio' ? parseStudio(unit.payload) : parseSimpleXml(unit.payload);
}

/**
 * Pure pipeline: raw input → array of { slug, files }. A REST envelope yields many.
 * @param {string} input
 * @param {{account:number|null, region?:string}} opts
 * @returns {{slug:string, files:Record<string,string>}[]}
 */
export function runImport(input, opts) {
  return detectFormat(input).map((unit) => {
    const model = parseUnit(unit);
    const multiSelectTokens = new Set(model.variables.filter((v) => v.multi).map((v) => v.name));
    const translated = translateWidgets(model.widgets, { multiSelectTokens });
    const variables = translateVariables(model.variables);
    const emitModel = { ...model, widgets: translated, variables };
    const tf = emitTerraform(emitModel, { accountId: opts.account, region: opts.region });
    const slug = slugify(model.title);
    const report = buildReport(model.title, translated);
    return {
      slug,
      files: {
        [`${slug}.tf`]: tf['dashboard.tf'],
        'versions.tf': tf['versions.tf'],
        'variables.tf': tf['variables.tf'],
        [`${slug}.report.md`]: report,
      },
    };
  });
}
```

Replace the write loop in `main` (after `out = runImport(...)`):

```javascript
const results = runImport(xml, { account: opts.account, region: opts.region });
for (const r of results) {
  const dir = results.length > 1 ? join(opts.out, r.slug) : opts.out;
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(r.files)) {
    const path = join(dir, name);
    writeFileSync(path, body);
    process.stdout.write(`${path}\n`);
  }
}
```

Remove the now-dead single-result `mkdirSync(opts.out, …)` block and the `out =` reassignment shape. (The `try/catch` around `runImport` stays.)

- [ ] **Step 4: Run, confirm pass.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- cli`
Expected: PASS.

- [ ] **Step 5: Full importer suite (catch any caller drift).**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-dashboard-importer/bin/spl-dashboard.js packages/nr-dashboard-importer/test/cli.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: runImport handles many dashboards; route studio vs simple-xml"
```

---

## Task 9: Integration — Studio fixture, GAP_INVENTORY, E2E smoke

Prove the whole pipeline on a Studio dashboard shaped like the corpus (chain + mixed viz + decoration + image + saved-search + unknown + inputs), all-synthetic. Extend the integration suite and regenerate `GAP_INVENTORY.md`.

**Files:**
- Create: `packages/nr-dashboard-importer/test/integration/fixtures/synthetic/shape-studio-wrapped.xml`
- Modify: `packages/nr-dashboard-importer/test/integration/dashboards.integration.test.js`
- Regenerate: `packages/nr-dashboard-importer/test/integration/GAP_INVENTORY.md`

**Interfaces:** consumes `runImport`; no new production code.

- [ ] **Step 1: Create the synthetic XML-wrapped Studio fixture.** All invented names.

```xml
<dashboard version="2">
  <definition><![CDATA[
{
  "title": "Synthetic Studio Board",
  "description": "synthetic studio fixture",
  "dataSources": {
    "ds_root":  { "type": "ds.search",      "options": { "query": "search widget_zone=alpha gadget_count>3" } },
    "ds_pp":    { "type": "ds.chain",        "options": { "extend": "ds_root", "query": "| where region_q=\"north\"" } },
    "ds_saved": { "type": "ds.savedSearch",  "options": { "ref": "some_saved_thing" } }
  },
  "visualizations": {
    "v_line":  { "type": "splunk.line",        "title": "Gadgets over time", "dataSources": { "primary": "ds_pp" } },
    "v_tbl":   { "type": "splunk.table",       "title": "Zones",             "dataSources": { "primary": "ds_root" } },
    "v_saved": { "type": "splunk.singlevalue", "title": "Saved-backed",      "dataSources": { "primary": "ds_saved" } },
    "v_rect":  { "type": "splunk.rectangle" },
    "v_img":   { "type": "splunk.image",       "options": { "src": "https://cdn.test/pic.png" } },
    "v_huh":   { "type": "splunk.sankey",      "title": "Flowy",             "dataSources": { "primary": "ds_root" } }
  },
  "layout": {
    "structure": [
      { "item": "v_line",  "position": { "x": 0,   "y": 0,   "w": 600,  "h": 200 } },
      { "item": "v_tbl",   "position": { "x": 600, "y": 0,   "w": 600,  "h": 200 } },
      { "item": "v_saved", "position": { "x": 0,   "y": 200, "w": 400,  "h": 100 } },
      { "item": "v_rect",  "position": { "x": 400, "y": 200, "w": 400,  "h": 100 } },
      { "item": "v_img",   "position": { "x": 800, "y": 200, "w": 400,  "h": 100 } },
      { "item": "v_huh",   "position": { "x": 0,   "y": 300, "w": 1200, "h": 100 } }
    ],
    "options": { "width": 1200 }
  },
  "inputs": {
    "i_time": { "type": "input.timerange", "options": { "token": "tr", "defaultValue": "-24h@h,now" } },
    "i_zone": { "type": "input.dropdown",  "options": { "token": "zone", "defaultValue": "alpha", "items": [{ "label": "Alpha", "value": "alpha" }, { "label": "Beta", "value": "beta" }] } }
  }
}
  ]]></definition>
</dashboard>
```

- [ ] **Step 2: Add an explicit Studio end-to-end test** to `dashboards.integration.test.js`.

```javascript
import { readFileSync } from 'node:fs';
import { runImport } from '../../bin/spl-dashboard.js';

describe('integration — Studio (synthetic)', () => {
  const xml = readFileSync(new URL('./fixtures/synthetic/shape-studio-wrapped.xml', import.meta.url), 'utf-8');

  it('imports the studio dashboard with correct widget fates', () => {
    const [result] = runImport(xml, { account: 1 });
    expect(result.slug).toBe('synthetic-studio-board');
    const tf = result.files['synthetic-studio-board.tf'];
    expect(tf).toContain('newrelic_one_dashboard');
    // 6 source viz: v_rect dropped; v_line + v_tbl + v_img(markdown) clean; v_saved + v_huh placeholders.
    // Placeholders render as markdown widgets carrying the reason.
    expect(tf).toContain('Saved-backed'); // placeholder keeps its title
    expect(tf).toContain('Flowy'); // unknown-type placeholder keeps its title
    expect(tf).toMatch(/zone/); // dropdown variable emitted
  });

  it('drops the rectangle decoration (no widget for it)', () => {
    const [result] = runImport(xml, { account: 1 });
    // Exactly 5 widgets reach Terraform (6 viz − 1 decoration). Count widget blocks.
    const blocks = (result.files['synthetic-studio-board.tf'].match(/widget_\w+\s*{/g) || []).length;
    expect(blocks).toBe(5);
  });
});
```

- [ ] **Step 3: Run, confirm pass + GAP_INVENTORY regenerates.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- integration`
Expected: PASS; `git status` shows `GAP_INVENTORY.md` updated with the new synthetic Studio fixture row, `dropped = 0`, `threw` blank.

- [ ] **Step 4: E2E `terraform validate` smoke (skips if terraform absent).**

Add to `dashboards.integration.test.js`, reusing the `skipIf(!hasTerraform())` pattern from `emitTerraform.test.js` (write the three files to a temp dir, run `terraform init -backend=false` + `terraform validate`, assert success). If `emitTerraform.test.js` exports `hasTerraform`, import it; otherwise copy its 3-line detection inline.

- [ ] **Step 5: Full importer suite + the root playground guard.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer`
Expected: PASS, all green.

- [ ] **Step 6: Commit (include the regenerated GAP_INVENTORY).**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-dashboard-importer/test/integration/
ASDF_NODEJS_VERSION=24.14.0 git commit -m "test: studio integration fixture, e2e smoke, gap inventory"
```

---

## Self-Review

- **Spec coverage:** detectFormat array + envelope (T1/T2) — spec §1 data flow; Studio unwrap (T3) — spec §1; parseStudio dataSources/viz/layout (T4/T5) — spec §2 + viz map; chain + interim guard (T6) — spec chain-resolution + interim-guard bullets; inputs (T7) — spec §2 inputs; CLI array + bulk (T8) — spec `runImport` shape change; integration + E2E + GAP (T9) — spec test plan. Resolved-edge-cases (spec) → covered across T5/T6/T7. Recon (T0) → spec Phase 0.
- **Deferred-by-design (noted, not gaps):** nrql-backed Studio dropdowns (T7 degrades to string); the interim guard's removal is gated on `fix/subquery-wrapping` (spec sequencing). Both are explicit in the spec.
- **Placeholder scan:** no TBD/"handle edge cases"/"similar to Task N" — every code step shows code; every test step shows assertions.
- **Type consistency:** `{format,payload}` unit (T1) consumed by T2/T3/T8; `resolveDataSource(dsId, dataSources, seen?)` (T4) extended in T6 same signature; `buildWidget → Widget|null` (T5) honored by the T4 loop edit; `parseInputs → {variables, defaultTimeRange}` (T7) consumed in parseStudio's return; `runImport → {slug,files}[]` (T8) consumed by T9 tests. `VIZ_MAP`/`DECORATION` defined T4, reused T5.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-25-dashboard-studio-phase-3.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session with batch checkpoints.

**Which approach?**
