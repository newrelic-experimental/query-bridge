# SPL→NRQL Playground — Design

**Date:** 2026-06-03
**Status:** Approved (design), pending implementation plan
**Author:** brainstormed with Claude

## Goal

A browser-based **SPL→NRQL playground**: a single page where a visitor adds SPL
query lines, each line gets a Submit button and live-as-you-type translation, and
the resulting NRQL (or warning / unsupported / error) renders welded directly
beneath its input. The page is seeded with the 10 curated sales-demo queries in a
left-rail examples list. It is published to GitHub Pages so anyone can open a URL
and play, and it also runs locally via a one-line static server.

The motivating use case: a technical-sales demo where the presenter pastes or picks
SPL and shows the live translation, including the warnings and clean failures that
demonstrate the translator's "loud failure over silent wrong results" philosophy.

## Scope

### In scope

- A static, client-side playground under `docs/playground/`.
- Per-line interaction model: each SPL line is its own input row with a Submit
  button and its translation rendered directly beneath it (mockup option "A2").
- Live-as-you-type translation (debounced) **and** explicit per-line Submit. Both
  call the same translate path; Submit is an immediate trigger.
- Left-rail examples list seeded with the 10 curated demo queries; clicking one
  appends a pre-filled row.
- Color-coded output: green (valid NRQL), amber (valid NRQL + precision-loss
  warnings), red (unsupported or error).
- GitHub Pages deployment via a GitHub Actions workflow on push to `master`.
- A small Vitest unit test asserting the 10 demo queries still translate to their
  expected result *type*.
- README "Playground" section with the live link and the local-serve command.

### Out of scope (YAGNI)

- Replacing, editing, or restructuring `docs/SPL_TO_NRQL.md`. The doc remains the
  authoritative teaching reference (prose + verified examples). The playground only
  links from it.
- Loading the full `spl.test.js` corpus into the playground. Only the 10 curated
  demo lines ship. (Full-corpus browsing is a possible future extension, not built
  now.)
- Persistence, sharing, or permalinking of typed queries.
- Any backend, server, or API. The translator runs entirely client-side.
- A browser test harness (Playwright/e2e). Consistent with the project's
  "pure library, no e2e" stance.

## Why this is feasible: the zero-dependency unlock

The translator in `src/` is pure, browser-clean ESM:

- Zero runtime dependencies.
- No Node-only APIs anywhere in `src/` (verified: no `require`, no `node:` imports,
  no `process`, no `fs`, no `__dirname`).
- The Peggy-generated parser (`src/input/spl/splParser.js`) is pure ESM.
- Public API: `translateSplToNrql(spl)` → `{ nrql, warnings, unsupported, errors }`
  (from `src/index.js` → `src/translate.js`).

This means the browser can `import` the real source files directly as ES modules.
No bundler, no build step, no inlining. The playground always reflects the current
translator code.

## Architecture

Three new files. **No changes to `src/`.**

```
docs/playground/
  index.html      structure + styling (dark theme, left rail + stacked rows)
  playground.js   ES module: DOM behavior, imports the real translator
  examples.js     ES module: the 10 demo queries as [{label, spl}]
```

### Component responsibilities

- **`index.html`** — page skeleton and CSS only. Left rail for examples, right
  column hosting the stacked SPL rows and an "Add line" affordance. Loads
  `playground.js` as `<script type="module">`. No inline logic.

- **`playground.js`** — owns all behavior:
  - `import { translateSplToNrql } from '../../src/index.js'`
  - `import { EXAMPLES } from './examples.js'`
  - Render the examples rail from `EXAMPLES`.
  - Add/remove rows; each row = SPL `<input>` + Submit button + output area.
  - Wire the debounced keystroke handler (~250ms) and the Submit click — both call
    one `translateRow(row)` function.
  - Color-code output by result type (see Data Flow).
  - Wrap every translate call in try/catch (see Error Handling).
  - Detect `file://` protocol and show a served-not-opened banner.

- **`examples.js`** — exports `EXAMPLES`, the single source of truth for the
  examples rail. Each entry: `{ label, spl }`. Also imported by the unit test.

### Import path

`playground.js` lives at `docs/playground/` and imports `src/index.js` at the repo
root via `../../src/index.js`. On GitHub Pages the whole repo is served as static
files, so this relative path resolves. **Must be verified during implementation**
that `../../src/index.js` resolves from `docs/playground/playground.js` both under a
local static server rooted at the repo and under the Pages path.

## Data flow (one row's lifecycle)

1. **Input** — visitor types SPL into a row's `<input>`, or clicks an example in
   the left rail (appends a new row pre-filled with that query).
2. **Trigger** — debounced keystroke (~250ms after typing stops) OR the row's
   Submit button. Both call the same `translateRow`.
3. **Translate** — `translateSplToNrql(spl)` runs synchronously, returns
   `{ nrql, warnings, unsupported, errors }`.
4. **Render** — output area updates by which fields are populated:

   | Condition | Border | Content |
   |---|---|---|
   | `nrql` present, no warnings | green | the NRQL |
   | `nrql` present + warnings | green | green NRQL + amber warning lines beneath |
   | `unsupported` non-empty | red | the unsupported message (no NRQL) |
   | `errors` non-empty | red | the parse/error message |
   | empty/whitespace input | neutral | cleared |

Each row owns its own state; rows never interfere. The color semantics map to the
demo's mental model: **green = ship it, amber = read the warning, red = we told you
instead of lying.**

## Error handling & edge cases

- **Translator throws** (unexpected bug, not a clean `errors` return): every
  `translateSplToNrql` call is wrapped in try/catch. On throw, render a red
  "translator crashed: <message>" line for that row only. One bad row must not
  white-screen the page.
- **Loaded over `file://`** (ESM/CORS trap — browsers refuse `import` over
  `file://`): detect `location.protocol === 'file:'` and render a visible banner
  ("This page must be served, not opened directly. From the repo root run
  `npx serve` (or `python3 -m http.server`) and open `/docs/playground/`, or see
  the README.") instead of a blank page.

  > **Serve from the repo root, never from inside `docs/playground/`.** The page
  > imports `../../src/index.js`, which escapes a root anchored at the playground
  > directory and 404s. Every serve instruction in this spec and the README must
  > root the static server at the repo root.
- **Empty / whitespace line**: cleared output, neutral state, no error. (The
  translator returns `FROM Log SELECT *` for empty input; the playground shows
  neutral rather than that default, to avoid implying the user wrote a query.)
- **Very long paste**: no artificial input cap; debounce prevents live-translate
  thrashing.

## The 10 seeded demo queries

These are the curated demo lines (breadth → benefits → drawbacks → failures). All
verified against the live CLI during brainstorming.

1. `index=web status=500 | stats count by host` — basic filter + aggregation
2. `sourcetype=access_* | timechart span=1h count by status` — time series
3. `* | rex field=message "user=(?<username>\w+) status=(?<code>\d+)" | stats count by username, code` — regex extraction
4. `* | stats count(eval(status>=400)) as errors, count(eval(status<400)) as ok` — conditional counting
5. `* | eventstats count by host | where count > 100` — subquery JOIN enrichment
6. `index=main "Cache hit" | stats count as Hits | append [search index=main "Cache miss" | stats count as Misses]` — append → filter()
7. `* | transaction clientip maxspan=10m | stats avg(duration)` — clean unsupported
8. `* | top 5 status by host` — semantic-divergence warning
9. `index=main | eval perms=split(permissions, ",") | mvexpand perms | stats count by perms` — unsupported with migration guidance
10. `* | mvcombine delim="," values` — hard unsupported with a reason

The exact label text for each rail entry is an implementation detail; the `spl`
strings above are authoritative.

## Testing

- **`examples.js` unit test** (Vitest): assert all 10 demo queries translate without
  throwing and produce the expected result *type* (green = has `nrql` & no
  warnings; amber = has `nrql` & warnings; red = has `unsupported` or `errors`). A
  future translator change that breaks a demo line then fails CI.
- **DOM wiring**: verified manually in a browser before the work is called done.
  No automated browser harness.

## Deployment

- **Workflow**: `.github/workflows/pages.yml` deploys to GitHub Pages on push to
  `master` using the standard `actions/configure-pages`,
  `actions/upload-pages-artifact`, `actions/deploy-pages` flow. The artifact is the
  repo (or the subset needed: at minimum `docs/playground/` and `src/`).
- **One-time manual step**: repo Settings → Pages → Source → "GitHub Actions".
- **Live URL**: this repo is `logging/nr-query-bridge` on `source.<GHE_DOMAIN>`
  (GHE). GHE Pages URLs use the `pages.<GHE_DOMAIN>` host, so the URL is expected to
  be roughly `https://pages.<GHE_DOMAIN>/logging/nr-query-bridge/docs/playground/` —
  **exact host/path must be confirmed during implementation**, not asserted.
- **README**: add a "Playground" section with the live link and the local-serve
  command — **served from the repo root** (`npx serve` or `python3 -m http.server`
  from the repo root), then navigate to `/docs/playground/`.

## Open risks / flags

- **GHE Pages may be disabled org-wide.** If Actions-based Pages is not enabled on
  `source.<GHE_DOMAIN>` for the `logging` org, the workflow is ready but the public
  URL will not light up until an admin enables it. The local-serve path works
  regardless, so this does not block the build.
- **Import path resolution** under the Pages path must be verified, not assumed.
- **Pages URL host/path** must be confirmed against an actual deploy, not guessed.
