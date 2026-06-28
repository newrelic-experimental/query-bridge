# Simple XML `<html>` panels → clean New Relic markdown widgets

- [ ] I, the human author, have read this end-to-end and stand behind it. Until this is checked, please don't spend time reviewing.

## Summary

Splunk Simple XML `<html>` panels currently become loud placeholders in the dashboard importer — every one is lost as a real widget. They hold static text (section-header labels, descriptive paragraphs, links), which maps cleanly to a New Relic markdown widget. This change converts each `<html>` panel to markdown with the `turndown` library and emits it through the importer's existing clean-markdown path. Constraint: New Relic's `widget_markdown` renders its text as Markdown (confirmed via the NerdGraph `viz.markdown` schema and the importer's own `terraform validate` test), so the output must be real markdown, never passed-through HTML.

## Problem

The importer routes Simple XML `<html>` panels to `vizType: 'unknown'` (`parseSimpleXml.js:230`, inside `UNSUPPORTED_VIZ_TAGS`), so the placeholder chokepoint replaces them with a markdown placeholder that just fences the original markup. The panel's content never reaches the dashboard.

Measured impact (today's `dashboard-diagnostic.mjs` run):

- **One donated Simple XML corpus (149 views): 44 placeholder widgets** across 15 views.
- **~1,600 widgets combined** across both donated corpora (mostly from the larger REST-export corpus).

What the `<html>` panels actually contain:

- Section-header labels — the dominant use: `<b>Section heading:</b>`, styled `<div>` headers used as visual dividers between panels.
- Descriptive text with links: `<p>For details see <a href="/app/...">a linked dashboard</a></p>`.
- Noise to discard: `<head><style>…</style>` CSS blocks, and empty `<html tokens="true" encoded="true"><![CDATA[ ]]></html>` token-driven panels (empty in a static export).

**Solved looks like:** a non-empty `<html>` panel emits a clean `widget_markdown` (bold, links, headings preserved); an empty/CSS-only one is dropped (no widget, no placeholder); the importer's placeholder count for `html panels are not supported` goes to zero on both corpora.

This is Simple-XML-only. Dashboard Studio retired the `<html>` panel and replaced it with the `splunk.markdown` viz, which stores markdown natively in `options.markdown` and already passes through (`parseStudio.js:108-119`). No `splunk.html` exists in the Studio corpus (0 hits). Running turndown on Studio content would corrupt it, since its input is already markdown.

## Proposed approach

Most of the path already exists. The Studio side already builds `{vizType:'markdown', options:{text}}` widgets from `splunk.image` and `splunk.markdown` (`parseStudio.js:96-119`), and `translateWidgets.js:77-88` already emits any such widget as a **clean** markdown widget, which `emitTerraform.js:152` renders as `widget_markdown`. So `translateWidgets` and the emitter need no change — the Simple XML path just has to produce the same widget shape.

Three components:

1. **New `src/htmlToMarkdown.js`** — a one-function seam, `htmlToMarkdown(html) → string`, wrapping a configured `turndown` instance. This isolates the whole turndown/domino dependency behind one testable boundary. Config that matters: `headingStyle: 'atx'`, and `.remove(['style','script','head','noscript'])` so CSS/JS blocks are dropped rather than rendered as literal text. Returns `''` when the conversion trims to empty (drives the drop in component 3). Links use turndown's default with **no** custom rule: every `<a href>` becomes `[text](href)` (`http(s)`, relative/internal, `mailto:`, all schemes). We add no scheme filtering — NR's markdown renderer is the display-time sanitizer (see Consequences), and relative/internal links are an intended NR use. turndown's other defaults apply: `<img>`→`![](src)`, `<pre>`→code block, `<table>`→flattened text (no GFM plugin), and Markdown-significant characters in decoded text are escaped.

2. **`parseSimpleXml.js` extraction** — add `stopNodes: ['*.html']` to the `XMLParser` config so `<html>` inner content arrives as a raw HTML string instead of a parsed sub-tree. turndown needs the string.

3. **`parseSimpleXml.js` wiring** — remove `html` from `UNSUPPORTED_VIZ_TAGS`; when a panel has an `<html>` child, build `createWidget({vizType:'markdown', options:{text: htmlToMarkdown(raw)}})`. When the converted text is empty, drop the widget (emit nothing), mirroring the Studio image-without-URL drop at `parseStudio.js:106`.

**Data flow:** `<html>raw</html>` → `htmlToMarkdown` → `{vizType:'markdown', options:{text}}` → existing clean-markdown path → `widget_markdown`. Empty → dropped.

## Alternatives considered

- **Extraction by re-serializing the parsed sub-tree** (instead of `stopNodes`). Rejected: fast-xml-parser drops text/tag ordering and entities when it parses mixed HTML content, so re-serializing is lossy. `stopNodes` is the parser's purpose-built mechanism for "keep this element's body as raw text."
- **Conversion fidelity** was the one real fork. Plain-text strip (drops bold/links) and a hand-rolled tag map (zero-dependency) were both on the table; we chose `turndown` for faithful, robust conversion of arbitrary HTML. The importer already carries runtime dependencies (`fast-xml-parser`), so a dependency here is in-band.

## Consequences, risk, and tradeoffs

- **Two new runtime dependencies in `@newrelic/dashboard-importer`:** `turndown` (MIT, range `>=7.2.4` — not exact- or major-pinned, per project preference; `package-lock.json` resolves the concrete version) and its only dep `@mixmark-io/domino` (BSD-2-Clause, a pure-JS server DOM — no jsdom). Both licenses are permissive, so the OSS-bound importer stays clean; FOSSA/OSPO will see them at publish. domino is a chunky ~7.7 MB on disk — acceptable for a CLI, but it is the cost we accept. The translator `@newrelic/query-bridge` gains nothing and stays zero-dependency; the importer→translator dependency direction is unchanged.
- **CVE-2025-9670** (ReDoS in turndown's `commonmark-rules.js`) affects versions ≤7.2.1 and is fixed in 7.2.2+. Our `>=7.2.4` floor clears it. The importer also processes export files in batch, not adversarial input at scale.
- **Links: emitted faithfully; NR's renderer owns safety.** turndown converts every `<a>` to `[text](href)` with no scheme filtering — `http(s)`, relative/internal (an intended NR dashboard use), `mailto:`, even `javascript:`. We add nothing special for `javascript:`: NR's markdown renderer is the display-time sanitizer (standard SaaS practice; NR renders GitHub-flavored Markdown, which neutralizes `javascript:`), and the input is the user's *own* imported dashboards, not adversarial third-party content — a `javascript:` link would be self-inflicted. Not independently render-verified; if NR somehow didn't sanitize, the blast radius is the importing user's own account. See `.claude/references/nrql-reference.md`, "Markdown (text) widgets."
- **Dropping empty panels leaves a gap in the grid.** Widget positions are computed per-panel from row/panel index (`parseSimpleXml.js:262-268`), so a dropped `<html>` panel leaves empty space at its slot; neighbors keep their positions and do not reflow. This matches the Studio precedent (decorations and image-less panels already drop) and is correct — there is nothing to show — but it is a layout change versus today's placeholder.
- **Reversible:** a two-way door. Reverting both PRs restores the placeholder behavior; no migration, no persisted state.

## Dependency verification (turndown)

| Check | Result |
|---|---|
| Version range / license | `>=7.2.4`, MIT (lockfile pins the resolved version) |
| Only runtime dep | `@mixmark-io/domino` 2.2.0, BSD-2-Clause (pure-JS server DOM; no jsdom) |
| Popularity | 6.1M downloads/week |
| `engines` | `node >=18` (consumers need 20+) |
| CVE-2025-9670 (ReDoS, ≤7.2.1) | fixed in 7.2.2+; `>=7.2.4` floor clears it |

## PR breakdown

Two dependency-ordered PRs, each well under 400 lines, following "inert engine with its own tests first, wire it on last."

1. **`htmlToMarkdown` module + turndown dependency (inert).** Add `turndown` (range `>=7.2.4`) to the importer `package.json`; create `src/htmlToMarkdown.js` (configured turndown wrapper). Unit tests exercise it directly: bold label, `<a href>` → `[text](href)` (http(s) and relative both), `<head><style>` dropped, empty → `''`, the real-world panel shapes. Not yet called by the pipeline, but fully exercised, so the per-file coverage gate passes. ~100 lines.
2. **Wire `<html>` panels into Simple XML parsing (turn it on).** `parseSimpleXml.js`: add `stopNodes:['*.html']`; remove `html` from `UNSUPPORTED_VIZ_TAGS`; emit a markdown widget from `<html>` panels, dropping when the converted text is empty. `parseSimpleXml.test.js` unit cases plus one e2e case proving a real-shaped `<html>` panel lands as a clean `widget_markdown` end-to-end. ~120 lines.

A finer three-way split was considered and rejected: a middle PR with extraction wired but still placeholdering is a valueless half-state.

## Testing

- **PR1 unit tests** (`test/htmlToMarkdown.test.js`): one `it()` per behavior — `<b>` → `**bold**`, `http(s)` and relative `<a href>` → `[text](href)`, `<head><style>` and `<script>` removed, empty/whitespace → `''`, and the three real-world shapes (bold label, styled `<div>` header, paragraph-with-link). Follow the project's explicit-test style (no fixture loops; inline the HTML under test).
- **PR2 unit tests** (`test/parseSimpleXml.test.js`): an `<html>` panel yields a `vizType:'markdown'` widget carrying `options.text`; an empty `<html>` panel yields no widget; viz-level vs panel-level title still resolves; a malformed `<html>` (unclosed tag) degrades to text without throwing.
- **PR2 e2e + regression** (`test/e2e.test.js`): a dashboard with one chart panel and one `<html>` panel emits both a `widget_line` and a clean `widget_markdown`, no placeholder for the html panel, and the chart's grid slot is unchanged. Two guards prove the change is **html-only**: a non-html unsupported panel (`event`/`map`) still becomes a placeholder, and a Studio `splunk.markdown` widget is byte-identical to today (the new path never touches Studio).
- The full case list — formatting (bold/link/heading/paragraph/list), entity decoding, CSS/script-only drop — is enumerated in the clean-room test suite produced during review; the plan turns it into `it()`s.
- New cases land at `verified: 'llm'` at most; only a human promotes to `'human'`.

## Concerns / open questions

1. **`stopNodes: ['*.html']` output shape.** Verified against the installed fast-xml-parser 5.8.0 source: `*.html` auto-converts to `..html` ("html anywhere") and keeps the element body raw/unparsed. The PR2 nuance to pin in a parser unit test: a bare `<html>…</html>` surfaces the raw string directly, but `<html tokens="true" encoded="true">` (with attributes) surfaces the body under `#text`, and the `encoded="true"` variant carries entity-encoded CDATA. Extraction must handle the string and `#text` shapes; the encoded/empty panels resolve to empty → dropped.
2. **Dashboard `$token$` in `<html>` text — scoped out, but now a confirmed opportunity.** New Relic **does** substitute `{{var}}` inside markdown-widget text — a documented, supported feature ([NR docs, "Use variables in markdown widgets"](https://docs.newrelic.com/docs/query-your-data/explore-query-data/dashboards/dashboard-template-variables/): "when you save and view the dashboard, the variables are replaced with their actual values"). So converting `$tok$`→`{{tok}}` in markdown text (as the importer already does for queries) would make them live — but only for tokens that map to a defined dashboard variable. The 6 corpus occurrences are Splunk *environment* tokens (`$env:page$`/`$env:app$` — current app/page), which have no NR variable equivalent, so converting them would help nothing; they stay literal. This feature leaves all `$token$` text literal; converting *user-defined* dashboard tokens in markdown is a real follow-up now that the NR capability is confirmed.
3. **`encoded="true"` / CDATA bodies (verify in PR2).** stopNodes keeps CDATA content raw and the parser unwraps it, so CDATA-wrapped HTML reaches turndown normally. An `<html encoded="true">` body is entity-encoded (`&lt;b&gt;`), so it needs an entity pre-decode before turndown or the tags render as literal text. The corpus's encoded panels are all empty (→ dropped), so this is unverified on non-empty input — confirm against the larger REST-export corpus in PR2 and add a decode step only if a non-empty case exists.

## Review checklist

- [ ] `htmlToMarkdown` strips `style`/`script`/`head` (CSS not rendered as literal text) and returns `''` for empty input
- [ ] `stopNodes` change does not alter parsing of any non-`html` element — confirm with a parser test
- [ ] Empty `<html>` panels drop cleanly (no widget, no placeholder), matching the Studio image-without-URL precedent
- [ ] turndown floored at `>=7.2.4` (≥ the CVE-2025-9670 fix; not exact- or major-pinned); both licenses permissive; translator stays zero-dependency
- [ ] Links emitted faithfully via turndown default (`[text](href)`, all schemes, no custom rule) — NR's renderer is the sanitizer; input is the user's own dashboards
- [ ] No change to `translateWidgets`/`emitTerraform` — the Simple XML path reuses the existing clean-markdown shape
