# SPL→NRQL Playground Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a browser-based SPL→NRQL playground (per-line input + live/Submit translation, color-coded output) seeded with 10 curated demo queries, deployed to GitHub Pages.

**Architecture:** Three static files under `docs/playground/` plus one CI workflow. `playground.js` imports the real `src/index.js` translator as a native ES module — no build step, no bundler. The translator is already zero-dependency and browser-clean. A Vitest unit test guards the 10 demo queries against translator regressions.

**Tech Stack:** Vanilla ESM JavaScript, HTML/CSS, Vitest (existing), GitHub Actions Pages deploy.

**Spec:** `docs/superpowers/specs/2026-06-03-spl-playground-design.md`

**Commit env:** All commits use `ASDF_NODEJS_VERSION=24.14.0 git commit` (hooks need Node 24). Conventional commits, lowercase subject ≤72 chars.

---

## File Structure

- Create: `docs/playground/examples.js` — exports `EXAMPLES`, the 10 demo queries. Single source of truth, imported by both the page and the test.
- Create: `docs/playground/index.html` — page skeleton + CSS. Left rail, right column of stacked rows, loads `playground.js` as a module.
- Create: `docs/playground/playground.js` — all DOM behavior; imports translator + examples.
- Create: `test/playground/examples.test.js` — guards the 10 demos translate to expected result type.
- Modify: `eslint.config.js` — add a browser-globals block scoped to `docs/playground/**/*.js` (eslint lints `docs/` even though prettier ignores it).
- Create: `.github/workflows/pages.yml` — Pages deploy on push to `master`.
- Modify: `README.md` — add a "Playground" section.

---

## Task 1: Examples module (single source of truth)

**Files:**
- Create: `docs/playground/examples.js`

- [ ] **Step 1: Create the examples module**

Each entry is `{ label, spl }`. The `spl` strings are copied verbatim from the spec (verified against the live CLI).

```js
// docs/playground/examples.js
// The 10 curated SPL→NRQL demo queries. Single source of truth for the
// playground examples rail AND test/playground/examples.test.js.
// Ordered: breadth → benefits → drawbacks → failures.

export const EXAMPLES = [
  {
    label: '1. Filter + aggregation',
    spl: 'index=web status=500 | stats count by host',
  },
  {
    label: '2. Time series',
    spl: 'sourcetype=access_* | timechart span=1h count by status',
  },
  {
    label: '3. Regex extraction',
    spl: '* | rex field=message "user=(?<username>\\w+) status=(?<code>\\d+)" | stats count by username, code',
  },
  {
    label: '4. Conditional counting',
    spl: '* | stats count(eval(status>=400)) as errors, count(eval(status<400)) as ok',
  },
  {
    label: '5. eventstats → JOIN',
    spl: '* | eventstats count by host | where count > 100',
  },
  {
    label: '6. append → filter()',
    spl: 'index=main "Cache hit" | stats count as Hits | append [search index=main "Cache miss" | stats count as Misses]',
  },
  {
    label: '7. Unsupported: transaction',
    spl: '* | transaction clientip maxspan=10m | stats avg(duration)',
  },
  {
    label: '8. Semantic-divergence warning',
    spl: '* | top 5 status by host',
  },
  {
    label: '9. Unsupported: mvexpand',
    spl: 'index=main | eval perms=split(permissions, ",") | mvexpand perms | stats count by perms',
  },
  {
    label: '10. Unsupported: mvcombine',
    spl: '* | mvcombine delim="," values',
  },
];
```

- [ ] **Step 2: Sanity-check it parses as a module**

Run: `ASDF_NODEJS_VERSION=24.14.0 node --input-type=module -e "import('./docs/playground/examples.js').then(m => console.log(m.EXAMPLES.length))"`
Expected: `10`

(This is a one-off module-load check, not a committed script. Per CLI safety rules `node -e` is not auto-approved — run interactively.)

- [ ] **Step 3: Commit**

```bash
git add docs/playground/examples.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: add playground demo examples module"
```

---

## Task 2: Examples regression test

**Files:**
- Create: `test/playground/examples.test.js`

This test is the CI guard: if a future translator change breaks a demo line, it fails. It asserts each demo produces the expected *result type* (green/amber/red), classified from the translator's return shape.

- [ ] **Step 1: Write the failing test**

```js
// test/playground/examples.test.js
import { EXAMPLES } from '../../docs/playground/examples.js';
import { translateSplToNrql } from '../../src/index.js';

// Expected result type per demo, by index (0-based), matching the spec ordering.
// 'green'  → has nrql, no warnings
// 'amber'  → has nrql, with warnings
// 'red'    → unsupported or errors present (no nrql)
const EXPECTED_TYPES = [
  'amber', // 1. stats by host → FACET-limit warning
  'amber', // 2. timechart → FACET-limit warning
  'amber', // 3. rex + stats → FACET-limit warning
  'green', // 4. count(eval) → clean
  'amber', // 5. eventstats → JOIN-limit warning
  'amber', // 6. append → filter() caveat warning
  'red', // 7. transaction → unsupported
  'amber', // 8. top by host → semantic-divergence warning
  'red', // 9. mvexpand → unsupported
  'red', // 10. mvcombine → unsupported
];

function classify(result) {
  if (result.unsupported?.length || result.errors?.length) return 'red';
  if (result.warnings?.length) return 'amber';
  if (result.nrql) return 'green';
  return 'empty';
}

describe('playground demo examples', () => {
  it('has 10 examples', () => {
    expect(EXAMPLES).toHaveLength(10);
  });

  it('every example translates without throwing', () => {
    for (const { spl } of EXAMPLES) {
      expect(() => translateSplToNrql(spl)).not.toThrow();
    }
  });

  it('each example produces its expected result type', () => {
    EXAMPLES.forEach(({ spl }, i) => {
      const result = translateSplToNrql(spl);
      expect(classify(result), `example ${i + 1}: ${spl}`).toBe(
        EXPECTED_TYPES[i],
      );
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it passes (translator + examples already exist)**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- test/playground/examples.test.js`
Expected: PASS (3 tests). 

> **If a result-type assertion fails:** the translator's actual output for that line differs from the spec's expectation. Do NOT blindly edit `EXPECTED_TYPES` to match — first translate the line via `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '<spl>'` and confirm the real behavior. The spec classifications were verified against the live CLI during brainstorming; a mismatch means either the translator regressed or the env differs. Update `EXPECTED_TYPES` only after confirming the CLI output is correct and intended.

- [ ] **Step 3: Commit**

```bash
git add test/playground/examples.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "test: guard playground demo examples against regressions"
```

---

## Task 3: Page skeleton + styling (`index.html`)

**Files:**
- Create: `docs/playground/index.html`

Layout A2 from brainstorming: left rail (examples), right column of stacked rows. Dark theme. No inline JS logic — only the module `<script>` tag loading `playground.js`. CSS classes here are referenced by `playground.js` in Task 4; names must match exactly: `.rail`, `.rail-item`, `.rows`, `.row`, `.row-top`, `.row-input`, `.row-submit`, `.row-remove`, `.row-output`, `.add-line`, `.banner`, and output state classes `.is-green`, `.is-amber`, `.is-red`, `.is-neutral`, plus `.warn-line` and `.crash-line`. (Element IDs used by JS: `#rail-items`, `#rows`, `#banner`, `#add-line`.)

- [ ] **Step 1: Create the HTML page**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SPL → NRQL Playground</title>
    <style>
      :root {
        --bg: #0d1117;
        --panel: #161b22;
        --border: #30363d;
        --text: #c9d1d9;
        --muted: #8b949e;
        --accent: #58a6ff;
        --green: #7fd17f;
        --amber: #e0b85a;
        --red: #e06a6a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
      }
      header {
        padding: 16px 20px;
        border-bottom: 1px solid var(--border);
      }
      header h1 { margin: 0; font-size: 18px; }
      header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
      .layout { display: flex; min-height: calc(100vh - 70px); }
      .rail {
        width: 240px;
        flex-shrink: 0;
        border-right: 1px solid var(--border);
        padding: 12px;
        overflow-y: auto;
      }
      .rail .label {
        text-transform: uppercase;
        font-size: 11px;
        color: var(--muted);
        letter-spacing: 0.05em;
        margin-bottom: 8px;
      }
      .rail-item {
        display: block;
        width: 100%;
        text-align: left;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text);
        padding: 8px 10px;
        margin-bottom: 6px;
        cursor: pointer;
        font-size: 13px;
      }
      .rail-item:hover { border-color: var(--accent); }
      .main { flex: 1; padding: 16px 20px; overflow-y: auto; }
      .banner {
        display: none;
        background: #3d1d1d;
        border: 1px solid var(--red);
        color: var(--red);
        padding: 10px 12px;
        border-radius: 6px;
        margin-bottom: 12px;
      }
      .rows { display: flex; flex-direction: column; gap: 10px; }
      .row {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 10px;
      }
      .row-top { display: flex; gap: 8px; }
      .row-input {
        flex: 1;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text);
        padding: 8px 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
      }
      .row-input:focus { outline: none; border-color: var(--accent); }
      .row-submit {
        background: var(--accent);
        border: none;
        border-radius: 6px;
        color: #04101f;
        font-weight: 600;
        padding: 0 14px;
        cursor: pointer;
      }
      .row-remove {
        background: transparent;
        border: none;
        color: var(--muted);
        cursor: pointer;
        font-size: 18px;
        padding: 0 4px;
      }
      .row-output {
        margin-top: 8px;
        padding: 8px 10px;
        border-left: 3px solid transparent;
        border-radius: 4px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        white-space: pre-wrap;
        word-break: break-word;
        min-height: 0;
      }
      .row-output:empty { display: none; }
      .is-neutral { border-left-color: var(--border); color: var(--muted); }
      .is-green { border-left-color: var(--green); color: var(--green); }
      .is-amber { border-left-color: var(--green); color: var(--green); }
      .is-red { border-left-color: var(--red); color: var(--red); }
      .warn-line { color: var(--amber); display: block; margin-top: 4px; }
      .crash-line { color: var(--red); display: block; }
      .add-line {
        margin-top: 12px;
        background: transparent;
        border: 1px dashed var(--border);
        border-radius: 6px;
        color: var(--accent);
        padding: 8px 12px;
        cursor: pointer;
      }
      .add-line:hover { border-color: var(--accent); }
    </style>
  </head>
  <body>
    <header>
      <h1>SPL → NRQL Playground</h1>
      <p>Type or pick an SPL line. Green = valid NRQL · amber = read the warning · red = no faithful translation.</p>
    </header>
    <div class="layout">
      <nav class="rail">
        <div class="label">Examples</div>
        <div id="rail-items"></div>
      </nav>
      <main class="main">
        <div id="banner" class="banner"></div>
        <div id="rows" class="rows"></div>
        <button id="add-line" class="add-line">+ Add line</button>
      </main>
    </div>
    <script type="module" src="./playground.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add docs/playground/index.html
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: add playground page skeleton and styling"
```

---

## Task 4: Playground behavior (`playground.js`)

**Files:**
- Create: `docs/playground/playground.js`
- Modify: `eslint.config.js` (add browser-globals block — eslint lints `docs/` JS)

- [ ] **Step 1: Add browser globals to eslint config**

Append a new config object to the array in `eslint.config.js`, after the existing `test/**/*.js` block (before the closing `]`):

```js
  {
    files: ['docs/playground/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        clearTimeout: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
```

- [ ] **Step 2: Create the playground module**

```js
// docs/playground/playground.js
import { translateSplToNrql } from '../../src/index.js';
import { EXAMPLES } from './examples.js';

const DEBOUNCE_MS = 250;

// Classify a translator result into a visual state.
function classify(result) {
  if (result.unsupported?.length || result.errors?.length) return 'red';
  if (result.warnings?.length) return 'amber';
  if (result.nrql) return 'green';
  return 'neutral';
}

// Render one translation result into a row's output element.
function renderOutput(outputEl, spl) {
  outputEl.className = 'row-output';
  outputEl.textContent = '';
  if (!spl.trim()) {
    outputEl.classList.add('is-neutral');
    return;
  }

  let result;
  try {
    result = translateSplToNrql(spl);
  } catch (e) {
    outputEl.classList.add('is-red');
    const crash = document.createElement('span');
    crash.className = 'crash-line';
    crash.textContent = `translator crashed: ${e.message}`;
    outputEl.appendChild(crash);
    return;
  }

  const state = classify(result);
  outputEl.classList.add(`is-${state}`);

  if (result.nrql) {
    outputEl.appendChild(document.createTextNode(result.nrql));
  }
  for (const w of result.warnings || []) {
    const line = document.createElement('span');
    line.className = 'warn-line';
    line.textContent = `⚠ ${w}`;
    outputEl.appendChild(line);
  }
  for (const u of result.unsupported || []) {
    const line = document.createElement('span');
    line.className = 'crash-line';
    line.textContent = `✕ unsupported: ${u}`;
    outputEl.appendChild(line);
  }
  for (const err of result.errors || []) {
    const line = document.createElement('span');
    line.className = 'crash-line';
    line.textContent = `✕ error: ${err}`;
    outputEl.appendChild(line);
  }
}

// Build one SPL row. Returns the row element.
function createRow(initialSpl = '') {
  const row = document.createElement('div');
  row.className = 'row';

  const top = document.createElement('div');
  top.className = 'row-top';

  const input = document.createElement('input');
  input.className = 'row-input';
  input.type = 'text';
  input.placeholder = 'index=web status=500 | stats count by host';
  input.value = initialSpl;

  const submit = document.createElement('button');
  submit.className = 'row-submit';
  submit.textContent = 'Submit';

  const remove = document.createElement('button');
  remove.className = 'row-remove';
  remove.textContent = '×';
  remove.title = 'Remove line';

  const output = document.createElement('div');
  output.className = 'row-output';

  const translate = () => renderOutput(output, input.value);

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(translate, DEBOUNCE_MS);
  });
  submit.addEventListener('click', () => {
    clearTimeout(timer);
    translate();
  });
  remove.addEventListener('click', () => row.remove());

  top.appendChild(input);
  top.appendChild(submit);
  top.appendChild(remove);
  row.appendChild(top);
  row.appendChild(output);

  if (initialSpl) translate();
  return row;
}

function init() {
  // file:// guard — ESM imports are blocked over file://, so the page would
  // otherwise be silently blank.
  if (location.protocol === 'file:') {
    const banner = document.getElementById('banner');
    banner.style.display = 'block';
    banner.textContent =
      'This page must be served, not opened directly. From the repo root run `npx serve` (or `python3 -m http.server`) and open /docs/playground/.';
  }

  const rows = document.getElementById('rows');
  const rail = document.getElementById('rail-items');

  // Examples rail — clicking appends a pre-filled row.
  for (const { label, spl } of EXAMPLES) {
    const btn = document.createElement('button');
    btn.className = 'rail-item';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      rows.appendChild(createRow(spl));
    });
    rail.appendChild(btn);
  }

  // Seed with one starter row (gallery model: editor seeded with one query).
  rows.appendChild(createRow(EXAMPLES[0].spl));

  document.getElementById('add-line').addEventListener('click', () => {
    rows.appendChild(createRow(''));
  });
}

init();
```

- [ ] **Step 3: Run lint to confirm the eslint globals block works**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run lint`
Expected: PASS, no `'document' is not defined` / `'location' is not defined` errors.

- [ ] **Step 4: Manually verify in a browser**

From the repo root:
```bash
npx serve
```
Open the printed URL + `/docs/playground/`. Confirm:
- Page loads (no blank screen, no console import errors).
- Starter row shows example 1 with green NRQL + amber warning beneath.
- Clicking rail item 7 (transaction) appends a row with a red `✕ unsupported` line.
- Typing in a row live-updates after ~250ms; Submit updates immediately.
- `×` removes a row; `+ Add line` adds an empty one.

> If the page is blank: open devtools console. A 404 on `../../src/index.js` means the server is rooted inside `docs/playground/` instead of the repo root — restart `npx serve` from the repo root.

- [ ] **Step 5: Commit**

```bash
git add docs/playground/playground.js eslint.config.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: add playground behavior and browser eslint globals"
```

---

## Task 5: GitHub Pages deploy workflow

**Files:**
- Create: `.github/workflows/pages.yml`

Standard Actions Pages flow. Uploads the whole repo as the Pages artifact (the playground needs both `docs/playground/` and `src/` reachable at their repo-relative paths, so uploading the repo root keeps `../../src/index.js` resolving). No build step.

- [ ] **Step 1: Create the workflow**

```yaml
name: Deploy Pages

on:
  push:
    branches: [master]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

# Allow one concurrent deployment; skip queued runs in favor of latest.
concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Configure Pages
        uses: actions/configure-pages@v5
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: '.'
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Lint the YAML mentally / confirm it commits clean**

No automated YAML linter in this repo. Confirm 2-space indentation and that the `path: '.'` uploads the repo root. Commit.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pages.yml
ASDF_NODEJS_VERSION=24.14.0 git commit -m "ci: deploy playground to github pages on master"
```

- [ ] **Step 4: Manual post-merge steps (NOT automated — note for the human)**

These happen after this branch merges to `master`; they cannot be done from the plan:
1. Repo Settings → Pages → Source → select **GitHub Actions**.
2. Push/merge to `master` to trigger the workflow.
3. Read the deployed `page_url` from the workflow's `deploy` job output.
4. Confirm the playground loads at `<page_url>docs/playground/`.

> **GHE caveat (from spec):** this repo is on `source.<GHE_DOMAIN>`. If Actions-based Pages is disabled org-wide for `logging`, the workflow runs but no URL lights up until an admin enables it. The local-serve path (Task 4 Step 4) works regardless, so this does not block the build. The exact Pages host (expected `pages.<GHE_DOMAIN>`) must be read from the actual deploy output, not assumed.

---

## Task 6: README "Playground" section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current README to find the insertion point**

Run: `cat README.md`
Insert the new section after the `## CLI` section and before `## API` (the playground is a usage surface, like the CLI).

- [ ] **Step 2: Add the Playground section**

Insert this block. Use the placeholder URL text exactly as shown — the real Pages URL is filled in by the human after the first deploy (Task 5 Step 4), since it cannot be known until then.

```markdown
## Playground

An interactive browser playground lets you paste SPL and see the live NRQL
translation, with color-coded warnings and unsupported messages.

**Live:** published via GitHub Pages once enabled — see the `Deploy Pages`
workflow run output for the URL (path: `…/docs/playground/`).

**Local:** the playground imports the translator as a native ES module, so it
must be *served* (browsers block module imports over `file://`). From the repo
root:

\`\`\`bash
npx serve          # or: python3 -m http.server
\`\`\`

Then open the printed URL with `/docs/playground/` appended. Serve from the
**repo root**, not from inside `docs/playground/` — the page imports
`../../src/index.js`.
```

(Replace the `\`\`\`` fences with real triple-backticks when editing — they are escaped here only to nest inside this plan's code block.)

- [ ] **Step 3: Commit**

```bash
git add README.md
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: add playground section to readme"
```

---

## Final verification

- [ ] **Step 1: Full test + lint pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test && ASDF_NODEJS_VERSION=24.14.0 npm run lint`
Expected: all tests PASS (including the new `test/playground/examples.test.js`), lint clean.

- [ ] **Step 2: Confirm the playground still loads after all changes**

From repo root: `npx serve`, open `/docs/playground/`, re-run the Task 4 Step 4 checklist once more.

- [ ] **Step 3: Decide on integration**

All work is on the current branch. Use `superpowers:finishing-a-development-branch` to decide merge/PR/cleanup.
