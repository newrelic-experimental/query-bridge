# HTML-to-Markdown Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Splunk Simple XML `<html>` panels into clean New Relic markdown widgets (instead of loud placeholders) in `@newrelic/dashboard-importer`.

**Architecture:** A new one-function module wraps `turndown` (HTML→Markdown). `parseSimpleXml` reads `<html>` panel bodies as raw HTML (via the parser's `stopNodes`) and emits a `{vizType:'markdown', options:{text}}` widget — the exact shape the Studio path already produces, which `translateWidgets` emits as a clean `widget_markdown`. So no change to `translateWidgets` or the emitter.

**Tech Stack:** Pure ESM JavaScript; `fast-xml-parser` (already a dep); `turndown` (new dep); Vitest with a per-file v8 coverage gate.

**Spec:** `docs/superpowers/specs/2026-06-27-html-to-markdown-design.md`. Read it for the why; this plan is self-contained for the how.

## Global Constraints

- **Node 24 for all dev/test/commit:** prefix every command `ASDF_NODEJS_VERSION=24.14.0` (hooks and CI need it). Consumers only need Node 20+.
- **Run this package in isolation:** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer` (root `npm test` chains all workspaces; iterate on this one).
- **`turndown` dependency floor `>=7.2.4`** — not exact-pinned, not major-pinned (project preference). `package-lock.json` resolves the concrete version. (CVE-2025-9670 ReDoS is fixed at 7.2.2; `>=7.2.4` clears it.)
- **Conventional commits**, lowercase subject ≤72 chars, body lines ≤100 chars. Use multiple `-m` (each a paragraph) or `git commit -F <file>`. End the message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Loud failure over silent-wrong:** never emit a broken widget; an unconvertible/empty `<html>` body produces no widget (dropped), never a malformed one.
- **No customer data in tests:** every field/label/URL is synthetic (`Money in`, `/app/x/board`, `index=web`). Pre-commit runs `scripts/scan-customer-names.sh`.
- **Per-file coverage gate (Vitest v8, `perFile:true`):** statements ≥78, branches ≥72, functions ≥90, lines ≥78. `all:true` reports every `src/**/*.js`, so a new untested file fails the gate — its tests ship in the same PR.
- **US English** in all identifiers, comments, and copy.
- Push with `git push origin HEAD`.

## File Structure

- **`packages/nr-dashboard-importer/src/htmlToMarkdown.js`** (new, PR1) — sole owner of the turndown dependency. Exports `htmlToMarkdown(html: string) => string`. One responsibility: HTML fragment → Markdown, `''` when empty.
- **`packages/nr-dashboard-importer/package.json`** (modify, PR1) — add the `turndown` dependency.
- **`packages/nr-dashboard-importer/src/parseSimpleXml.js`** (modify, PR2) — parser `stopNodes` config; remove `html` from `UNSUPPORTED_VIZ_TAGS`; add the `<html>`-panel→markdown-widget handler.
- **Tests:** `test/htmlToMarkdown.test.js` (new, PR1), additions to `test/parseSimpleXml.test.js` and `test/e2e.test.js` (PR2).
- **Unchanged (verify, don't edit):** `src/translateWidgets.js` (already emits a `{vizType:'markdown', options.text}` widget as clean), `src/emitTerraform.js` (already renders `widget_markdown`), `src/parseStudio.js` (Studio path untouched — its markdown is already native).

**PR mapping:** Task 1 → **PR1** (inert module + dependency, with its own unit tests). Task 2 → **PR2** (wire it on, with parser + e2e tests). PR1 lands first; PR2 depends on it.

---

### Task 1 (PR1): `htmlToMarkdown` module + turndown dependency

**Files:**
- Modify: `packages/nr-dashboard-importer/package.json` (dependencies)
- Create: `packages/nr-dashboard-importer/src/htmlToMarkdown.js`
- Test: `packages/nr-dashboard-importer/test/htmlToMarkdown.test.js`

**Interfaces:**
- Produces: `htmlToMarkdown(html: string): string` — Markdown for a `<html>` panel body; `''` when the input is empty, whitespace-only, or not a string. Task 2 consumes it.

- [ ] **Step 1: Add the turndown dependency.** Edit `package.json` `dependencies` to add `"turndown": ">=7.2.4"` (keep `fast-xml-parser` as-is), then install to update the lockfile:

```bash
cd packages/nr-dashboard-importer    # or use --workspace from the root
ASDF_NODEJS_VERSION=24.14.0 npm install turndown@">=7.2.4" --workspace=@newrelic/dashboard-importer
```

Expected: `package.json` shows `"turndown": ">=7.2.4"`; `package-lock.json` resolves a concrete 7.x and pulls its only runtime dep `@mixmark-io/domino`.

- [ ] **Step 2: Write the failing test** at `test/htmlToMarkdown.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../src/htmlToMarkdown.js';

describe('htmlToMarkdown', () => {
  it('converts <b> to bold markdown', () => {
    expect(htmlToMarkdown('<b>Money in</b>')).toBe('**Money in**');
  });

  it('converts an http(s) link to a markdown link', () => {
    expect(htmlToMarkdown('<a href="https://example.com">Docs</a>')).toBe(
      '[Docs](https://example.com)',
    );
  });

  it('keeps a relative link as a markdown link', () => {
    expect(htmlToMarkdown('<a href="/app/x/board">Board</a>')).toBe(
      '[Board](/app/x/board)',
    );
  });

  it('drops a <head><style> CSS block, keeping only the visible text', () => {
    const md = htmlToMarkdown(
      '<head><style>.k{color:red}</style></head><p>Status OK</p>',
    );
    expect(md).toBe('Status OK');
  });

  it('drops a <script> block', () => {
    expect(htmlToMarkdown('<script>alert(1)</script><p>Hi</p>')).toBe('Hi');
  });

  it('converts a styled div header to its bold text', () => {
    expect(
      htmlToMarkdown('<div style="background:#003352"><b>Totals:</b></div>'),
    ).toBe('**Totals:**');
  });

  it('converts a paragraph with a relative link', () => {
    expect(
      htmlToMarkdown('<p>See <a href="/app/x/board">the board</a></p>'),
    ).toBe('See [the board](/app/x/board)');
  });

  it('returns empty string for an empty body', () => {
    expect(htmlToMarkdown('')).toBe('');
  });

  it('returns empty string for a whitespace-only body', () => {
    expect(htmlToMarkdown('   \n  ')).toBe('');
  });

  it('returns empty string for non-string input', () => {
    expect(htmlToMarkdown(undefined)).toBe('');
  });
});
```

**Note on the exact expected strings:** these are turndown 7.x defaults (strong → `**`, link → `[text](href)`, `head`/`style`/`script` removed). If the installed version differs only in escaping or trailing whitespace, adjust the literal expected value to turndown's actual output — the *behavior* each test names (bold kept, link kept incl. relative, CSS/script dropped, empty → `''`) is the contract, not the exact bytes.

- [ ] **Step 3: Run the test, confirm it fails.**

```bash
ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- htmlToMarkdown
```

Expected: FAIL — `Failed to resolve import "../src/htmlToMarkdown.js"` (module doesn't exist yet).

- [ ] **Step 4: Implement** `src/htmlToMarkdown.js`:

```js
import TurndownService from 'turndown';

// One configured turndown instance, reused across calls. ATX headings (`# H`),
// and strip non-content elements so a Splunk <head><style>…</style> block never
// renders as literal CSS text. Links use turndown's default — `[text](href)` for
// every scheme — because New Relic's markdown renderer is the display-time
// sanitizer; the importer does no scheme filtering. See
// .claude/references/nrql-reference.md, "Markdown (text) widgets."
const service = new TurndownService({ headingStyle: 'atx' });
service.remove(['style', 'script', 'head', 'noscript']);

/**
 * Convert a Splunk Simple XML <html> panel body to Markdown for an NR markdown
 * widget. Returns '' when there is no visible content (empty, whitespace-only,
 * CSS/script-only, or non-string) — the caller drops such panels rather than
 * emitting an empty widget.
 *
 * @param {string} html raw inner HTML of an <html> panel
 * @returns {string} Markdown, trimmed; '' when there is nothing to show
 */
export function htmlToMarkdown(html) {
  if (typeof html !== 'string' || html.trim() === '') return '';
  return service.turndown(html).trim();
}
```

- [ ] **Step 5: Run the test, confirm it passes** (reconcile any escaping-only diffs per the Step 2 note):

```bash
ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- htmlToMarkdown
```

Expected: PASS (10/10). If `import TurndownService from 'turndown'` errors under ESM, the import is wrong — turndown ships CJS with a default export; `import TurndownService from 'turndown'` is the correct ESM-interop form.

- [ ] **Step 6: Run the full package suite with coverage, lint, and types.** The new file must clear the per-file gate (its tests exercise every line, so it will):

```bash
ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer
ASDF_NODEJS_VERSION=24.14.0 npm run lint --workspace=@newrelic/dashboard-importer
ASDF_NODEJS_VERSION=24.14.0 npm run types:check
```

Expected: all green; coverage report lists `htmlToMarkdown.js` at/near 100%, no per-file threshold failure. `htmlToMarkdown.js` is present but not yet imported by the pipeline (inert) — that's intentional; it's fully exercised by its own tests, so the `all:true` gate passes.

- [ ] **Step 7: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-dashboard-importer/package.json packages/nr-dashboard-importer/package-lock.json packages/nr-dashboard-importer/src/htmlToMarkdown.js packages/nr-dashboard-importer/test/htmlToMarkdown.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit \
  -m "feat: add htmlToMarkdown converter (inert)" \
  -m "Wrap turndown to convert <html> panel bodies to Markdown; not yet wired in." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(If `package-lock.json` lives at the repo root in this workspace setup, stage the root lockfile instead — check `git status` and stage whichever lockfile changed.)

---

### Task 2 (PR2): wire `<html>` panels into `parseSimpleXml`

**Files:**
- Modify: `packages/nr-dashboard-importer/src/parseSimpleXml.js`
- Test: `packages/nr-dashboard-importer/test/parseSimpleXml.test.js`, `packages/nr-dashboard-importer/test/e2e.test.js`

**Interfaces:**
- Consumes: `htmlToMarkdown(html)` from Task 1.
- Produces: nothing new for later tasks — this is the final wire-on.

- [ ] **Step 1: Write the failing tests.** Append to `test/parseSimpleXml.test.js`:

```js
describe('parseSimpleXml — <html> panels become clean markdown widgets', () => {
  it('converts an <html> panel to a markdown widget carrying options.text', () => {
    const xml = `<dashboard><label>D</label><row><panel>
      <title>Notes</title>
      <html><b>Money in</b></html>
    </panel></row></dashboard>`;
    const m = parseSimpleXml(xml);
    expect(m.widgets).toHaveLength(1);
    expect(m.widgets[0].vizType).toBe('markdown');
    expect(m.widgets[0].title).toBe('Notes');
    expect(m.widgets[0].options.text).toBe('**Money in**');
    expect(m.widgets[0].unsupportedReason).toBeNull();
  });

  it('drops an empty <html> panel — no widget, no placeholder', () => {
    const xml = `<dashboard><label>D</label><row><panel>
      <html>   </html>
    </panel></row></dashboard>`;
    expect(parseSimpleXml(xml).widgets).toHaveLength(0);
  });

  it('still parses a normal <chart> panel after the stopNodes change', () => {
    const xml = `<dashboard><label>D</label><row><panel>
      <chart><title>Reqs</title><search><query>index=web | timechart count</query></search></chart>
    </panel></row></dashboard>`;
    const m = parseSimpleXml(xml);
    expect(m.widgets).toHaveLength(1);
    expect(m.widgets[0].vizType).toBe('line');
    expect(m.widgets[0].rawSpl).toBe('index=web | timechart count');
  });
});
```

Then append to `test/e2e.test.js`:

```js
describe('end-to-end: <html> panel → clean markdown widget', () => {
  it('emits a clean widget_markdown for an <html> panel alongside a chart', () => {
    const xml = `<dashboard><label>HTML demo</label><row>
      <panel><chart><title>Reqs</title><search><query>index=web | timechart count</query></search></chart></panel>
      <panel><title>Legend</title><html><b>Key</b></html></panel>
    </row></dashboard>`;
    const [out] = runImport(xml, { account: 12345 });
    const tf = out.files[`${out.slug}.tf`];
    expect((tf.match(/widget_/g) || []).length).toBe(2);
    expect(tf).toContain('widget_markdown');
    expect(tf).toContain('widget_line');
    expect(tf).toContain('**Key**'); // converted content, not a fenced placeholder
    expect(tf).not.toContain('```'); // a placeholder fences the original; a clean widget doesn't
  });
});
```

- [ ] **Step 2: Run the tests, confirm they fail.**

```bash
ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- parseSimpleXml e2e
```

Expected: FAIL — the `<html>` panel currently becomes an `unknown`/placeholder, so the markdown-widget assertions fail (and the empty-`<html>` case still produces a placeholder widget, so length is 1 not 0).

- [ ] **Step 3: Implement — five edits to `src/parseSimpleXml.js`.**

(a) Add the import below the existing imports (after the `./model.js` import line):

```js
import { htmlToMarkdown } from './htmlToMarkdown.js';
```

(b) Add `stopNodes` to the `XMLParser` config:

```js
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep single children as objects; we normalize to arrays ourselves.
  isArray: () => false,
  trimValues: true,
  // Keep <html> panel bodies as RAW HTML (unparsed) for htmlToMarkdown. '*.html'
  // matches an <html> element at any depth (fast-xml-parser 5.x rewrites '*.x' to
  // '..x'). <html> is the only raw-HTML element in Simple XML, so this is targeted.
  stopNodes: ['*.html'],
});
```

(c) Add the `htmlRaw` helper just after the `asArray` function:

```js
/**
 * Raw inner HTML of a stopNode <html> element. With stopNodes it arrives as a
 * bare string, or as { '#text': '<raw>', '@_attr': … } when the <html> tag had
 * attributes (e.g. <html encoded="true">). Anything else → '' (dropped upstream).
 * @param {unknown} node
 * @returns {string}
 */
function htmlRaw(node) {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object' && typeof node['#text'] === 'string') {
    return node['#text'];
  }
  return '';
}
```

(d) Remove the `html` entry from `UNSUPPORTED_VIZ_TAGS` (leave `event`/`map`/`viz`/`list`):

```js
const UNSUPPORTED_VIZ_TAGS = {
  event: 'unknown',
  map: 'map',
  viz: 'unknown',
  list: 'unknown',
};
```

(e) Add the `<html>`-panel handler in the panel loop — immediately after the `chart`/`table`/`single` `for` loop closes and **before** the `// Recognized-but-unsupported viz tags…` comment / `UNSUPPORTED_VIZ_TAGS` loop:

```js
      // <html> panels are static text → clean NR markdown widgets (mirrors the
      // Studio splunk.markdown path; translateWidgets emits a {vizType:'markdown',
      // options.text} widget as a clean widget_markdown). An empty/CSS-only body
      // converts to '' → dropped (no widget, no placeholder), like Studio's
      // image-without-URL drop. NR's renderer sanitizes link schemes, so we emit
      // every link faithfully and add no scheme filtering.
      for (const htmlEl of asArray(panel.html)) {
        const text = htmlToMarkdown(htmlRaw(htmlEl));
        if (text === '') continue;
        widgets.push(
          createWidget({
            title: panelTitle,
            vizType: 'markdown',
            options: { text },
            layout,
          }),
        );
      }
```

- [ ] **Step 4: Run the tests, confirm they pass.**

```bash
ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer -- parseSimpleXml e2e
```

Expected: PASS. In particular, the existing test "emits an event panel as a widget carrying an unsupportedReason" (`test/parseSimpleXml.test.js`) must stay green — it proves removing `html` from `UNSUPPORTED_VIZ_TAGS` left `event`/`map`/`viz`/`list` placeholdering intact.

- [ ] **Step 5: Run the full package suite + lint + types.**

```bash
ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer
ASDF_NODEJS_VERSION=24.14.0 npm run lint --workspace=@newrelic/dashboard-importer
ASDF_NODEJS_VERSION=24.14.0 npm run types:check
```

Expected: all green; `parseSimpleXml.js` coverage unchanged or improved; no per-file regression. `parseStudio.js` is untouched, so its existing markdown tests prove the Studio path is unaffected.

- [ ] **Step 6: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-dashboard-importer/src/parseSimpleXml.js packages/nr-dashboard-importer/test/parseSimpleXml.test.js packages/nr-dashboard-importer/test/e2e.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit \
  -m "feat: convert Simple XML <html> panels to markdown widgets" \
  -m "Read <html> bodies as raw HTML (stopNodes), convert via htmlToMarkdown, emit clean markdown widgets; drop empty bodies." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Global Verification

After both tasks, on the PR2 branch:

- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/dashboard-importer` — full importer suite green, coverage gate satisfied (per-file ≥78/72/90/78).
- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run lint --workspace=@newrelic/dashboard-importer && ASDF_NODEJS_VERSION=24.14.0 npm run types:check` — clean.
- [ ] No `build:parsers` needed — no grammar change.
- [ ] CLI spot-check on a real-shaped dashboard with an `<html>` panel: run the importer and confirm the panel emits a `widget_markdown` with the converted text (not a placeholder fencing the original).
- [ ] `git diff master..HEAD --stat` shows only the four files (module + package.json/lockfile in PR1; parseSimpleXml + its two test files in PR2). No change to `translateWidgets.js`, `emitTerraform.js`, or `parseStudio.js`.

## Self-Review

1. **Spec coverage:** Component 1 (htmlToMarkdown module) → Task 1. Component 2 (stopNodes extraction) + Component 3 (wiring, drop-empty) → Task 2. The spec's link decision (no scheme filtering, NR renderer sanitizes) → the htmlToMarkdown comment + the relative/http(s) link tests. The "empty → drop" rule → the empty-`<html>` test. The "html-only" guard → the still-parses-chart test + the existing event-panel test staying green.
2. **Placeholder scan:** no TBD/TODO; every step has the exact code or command. The one soft spot (turndown's exact serialization) is called out with a reconciliation rule, not left vague.
3. **Type/name consistency:** `htmlToMarkdown(html: string): string` defined in Task 1, consumed in Task 2's import and handler. `htmlRaw` is local to parseSimpleXml. `createWidget({vizType:'markdown', options:{text}})` matches the model factory and the `translateWidgets` clean-markdown path.
4. **Loud-failure check:** the only new "drop" is an empty/CSS-only body (correctly no widget); a non-empty body always yields a clean widget; nothing emits silent-wrong NRQL.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-27-html-to-markdown.md`. Two tasks = two PRs (PR1 inert module, PR2 wire-on). Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
