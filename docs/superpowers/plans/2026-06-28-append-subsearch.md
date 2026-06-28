# `append` / `appendcols` — keep-and-fix two silent-wrong cases — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the faithful `filter()`-merge that `handleAppend` already produces for the dominant `stats`-merge idiom, and fix exactly two families that today emit silently-wrong NRQL by turning each into a loud `unsupported`: (1) **cross-source** — the two sides differ by a leading `index=`/`sourcetype=`/`source=` discriminator; (2) **divergent per-side time window** — the subsearch carries its own `earliest`/`latest` that differs from the main query's. Do NOT rewrite `handleAppend` wholesale; do NOT "fix" the already-correct `appendcols` conflation or the total-row pattern.

**Architecture:** Both defects are *detection-only* additions inside `handleAppend` (`src/input/spl/enrichmentHandlers.js`) — no new NRQL shapes are emitted. Defect 1 adds a pure local helper `collectSourceDiscriminators(whereList)` that walks each WHERE condition tree (descending `AND`/`OR`) and returns a normalized signature of any `index`/`sourcetype`/`source` equality; if the main and sub signatures differ, push `append_cross_source` and bail. Defect 2 compares the subsearch's `since`/`until` (already computed by `translateAstToIR(subAst)`) against the main query's; if the subsearch sets its own window that differs, push `append_divergent_timerange` and bail. Both guards are placed **after** the existing no-agg and facet-mismatch guards and **before** the WHERE-merge — so every shape those guards already reject stays rejected by them, and only shapes that reach the merge are re-examined.

**Tech Stack:** Pure ESM JavaScript; IR node factories in `src/ir/nodes.js` (`BinOp`, `Identifier`, `Literal`); message catalog in `src/messages.js` (handlers call `messages.key()` — no inline strings); Vitest with the data-driven `cases` array in `test/spl/spl.test.js`.

**Branch:** `feat/append-subsearch` off `origin/master` (cut **after PR #72 lands** — see Double-check targets). Spec: `docs/superpowers/specs/2026-06-28-append-subsearch-design.md`.

## Global Constraints

- Dev requires **Node 24**: prefix every command `ASDF_NODEJS_VERSION=24.14.0` (hooks + commit need it).
- Run one package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- <filter>`.
- Conventional commits, lowercase subject ≤72 chars, body lines ≤100. `git commit -F <file>` for multi-line bodies. `git push origin HEAD` (never bare, never to master).
- **Loud failure over silent-wrong:** the entire point of this plan — each defect becomes `messages.*` `unsupported`, never a partial/conflated NRQL result. An `unsupported` push must be followed by `return` so no half-merged SELECT is emitted.
- Messages live in `src/messages.js`; handlers call `messages.key()` — no inline strings. **There is no `test/messages.test.js` in this repo** — message-key consistency is enforced *inside* `test/spl/spl.test.js` (a `beforeEach` spies every `Object.keys(messages)` key; the per-case assertion requires `warningFunc`/`unsupportedFunc` to be the **exhaustive** set of message functions that fired). Adding a key to `src/messages.js` is sufficient; do not look for a separate messages test.
- **`warningFunc` / `unsupportedFunc` are EXHAUSTIVE** — list every message key that fires, including subsearch-forwarded ones (`append_subsearch_warning`, `facet_default_limit`). Subsearch forwarding can fire unexpected calls; if a regression case's subsearch emits a warning, it appears as `append_subsearch_warning`.
- New/changed translations land at `verified: false` (a human promotes to `'llm'`/`'human'` later).
- This codebase writes "loglines", not Splunk's "events", once data is in NR.
- Byte-match every `nrql` field against `node bin/spl2nrql.js "<query>"` before trusting the test string (the eval-projection `WITH … AS x SELECT *` shape and bare-term `WHERE message LIKE` injection bite — use `*` and explicit fields in test SPL).

## Background — current `handleAppend` behavior (verified `cceb76a`, 2026-06-28)

`handleAppend` (`src/input/spl/enrichmentHandlers.js:126`) serves **both** `append` and `appendcols` (routed together at `splToIR.js` `AppendCommand`/`AppendcolsCommand`; only the `label` differs). Order of operations today:

1. Parse + translate subsearch (`translateAstToIR`); on parse failure → `append_parse_failed` (loud).
2. **Forward** subsearch warnings → `append_subsearch_warning`, unsupported → `append_subsearch_unsupported`.
3. **No-agg guard:** either side has empty `select` → `append_no_agg` (loud). *(Fires before our new guards — keep it first.)*
4. **Facet-mismatch guard:** `mainFacetStr !== subFacetStr` → `append_facet_mismatch` (loud).
5. **WHERE-merge:** same WHERE (`exprsEqual`) → push sub's SELECTs, `append_merged`; different WHERE → wrap each side's SELECTs in `filter(expr, WHERE …)`, clear `ir.where`, `append_filter_warning`. **← the two new guards insert just before this step.**

Verified outputs (the contract the regression cases pin):

| SPL | current NRQL | disposition |
|---|---|---|
| `status=200 \| stats count \| append [search status=500 \| stats count]` | `SELECT filter(count(*), WHERE status = '200' OR numeric(status) = 200), filter(count(*), WHERE status = '500' OR numeric(status) = 500)` | **keep** (faithful) |
| `* \| stats count by host \| append [search error \| stats count by host]` | `SELECT count(*), filter(count(*), WHERE message LIKE '%error%') FACET host` | **keep** (faithful) |
| `index=web \| stats count \| append [search index=payments \| stats count]` | `SELECT filter(count(*), WHERE index = 'web'), filter(count(*), WHERE index = 'payments')` | **defect 1 → unsupported** |
| `earliest=-1d latest=now \| stats count \| append [search * earliest=-2d latest=-1d \| stats count]` | `SELECT count(*), count(*) SINCE 1 day ago` (sub window silently dropped) | **defect 2 → unsupported** |

Two relevant existing `cases` in `test/spl/spl.test.js` are currently `skip: true` in the "Append edge cases (TODO: verify…)" block:
- `index=web | stats count as web_count | append [search index=api | stats count as api_count]` (lines ~3781) — this is **the cross-source case**. PR 1 un-skips it and converts it to the `unsupported` expectation.
- `* | where status=500 | … | append [search * | …]` (pre-stats WHERE) — **not** cross-source; leave it `skip: true`.

---

### Task 1 (PR 1): cross-source discriminator → `unsupported`

**Files:**
- Modify: `src/input/spl/enrichmentHandlers.js` — add `collectSourceDiscriminators` helper + the guard in `handleAppend`.
- Modify: `src/messages.js` — add `append_cross_source`.
- Modify: `test/spl/spl.test.js` — convert the skipped cross-source case + add same-source regression cases.

**Interfaces:**
- Consumes: `ir.where` / `subIR.where` — each an `IRNode[]` of condition trees. A leading `index=web` renders as `BinOp('=', Identifier('index'), Literal('web','string'))`; nested under other terms it sits inside `BinOp('AND', …)` (e.g. `index=web error` → `index = 'web' AND message LIKE '%error%'`); a `$token$` index (`index="$env$"`) renders with a non-string-`Literal` RHS (the `{{env}}` passthrough) and must read as *dynamic/unknown*.
- Produces: nothing new in IR — pushes `messages.append_cross_source(label)` to `ir.unsupported` and returns.

- [ ] **Step 1: Add the failing/661 data-driven cases** to the `cases` array in `test/spl/spl.test.js`. First, **convert** the existing skipped cross-source case (find the block comment `// Different indexes on each side — filter() WHERE clauses must reflect different sources`) from this:

```javascript
  {
    skip: true,
    spl: 'index=web | stats count as web_count | append [search index=api | stats count as api_count]',
    nrql: "FROM Log SELECT filter(count(*), WHERE index = 'web') AS 'web_count', filter(count(*), WHERE index = 'api') AS 'api_count'",
    warningFunc: ['append_filter_warning'],
    doc: 'correlation-append',
    verified: false,
  },
```

to this (drop `skip`, drop `nrql`, expect the new `unsupported`):

```javascript
  // Defect 1: cross-source — different index per side has no single-FROM NRQL form.
  // Was a skipped filter() case that silently returned 0 (NR Log carries no `index`).
  {
    spl: 'index=web | stats count as web_count | append [search index=api | stats count as api_count]',
    unsupportedFunc: ['append_cross_source'],
    doc: 'correlation-append',
    verified: false,
  },
```

Then **add** these new cases next to the other `// ── Append command ──` cases (regressions that must NOT flip to `unsupported`):

```javascript
  // Regression: same-source, different-WHERE stays the faithful filter() merge.
  {
    spl: 'status=200 | stats count | append [search status=500 | stats count]',
    nrql: "FROM Log SELECT filter(count(*), WHERE status = '200' OR numeric(status) = 200), filter(count(*), WHERE status = '500' OR numeric(status) = 500)",
    warningFunc: ['append_filter_warning'],
    doc: 'correlation-append',
    verified: false,
  },
  // Regression: SAME index on both sides is not cross-source — stays faithful.
  {
    spl: 'index=web error | stats count | append [search index=web success | stats count]',
    nrql: "FROM Log SELECT filter(count(*), WHERE index = 'web' AND message LIKE '%error%'), filter(count(*), WHERE index = 'web' AND message LIKE '%success%')",
    warningFunc: ['append_filter_warning'],
    doc: 'correlation-append',
    verified: false,
  },
```

(All three NRQL/`unsupported` outputs above byte-verified against `node bin/spl2nrql.js`, 2026-06-28.)

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
  Expected: the cross-source case FAILS (today it warns + emits `filter()`, so `unsupportedFunc: ['append_cross_source']` is unmet and `append_cross_source` is an undefined message key → the exhaustive-key check also flags it). The two regression cases should already PASS (no behavior change yet) — confirms they pin existing behavior.

- [ ] **Step 3: Add the message** to `src/messages.js`. Replace the existing `append_filter_warning` comment-sentinel area is fine; place the new key next to `append_filter_warning` (~line 273):

```javascript
  // SPL: `index=web | stats count | append [search index=payments | stats count]`
  append_cross_source: (label) =>
    `${label} subsearch reads a different index/sourcetype/source than the main search; ` +
    'NR Log has no UNION or multi-source FROM, so one FROM Log query cannot read both datasets',
```

- [ ] **Step 4: Implement the helper + guard** in `src/input/spl/enrichmentHandlers.js`.

First, add the module-level helper (place it next to `exprsEqual`, after `wrapInFilter`):

```javascript
const SOURCE_DISCRIMINATOR_FIELDS = new Set(['index', 'sourcetype', 'source']);

// Walk a WHERE condition list and return a normalized signature of any
// index=/sourcetype=/source= equality discriminators. Descends AND/OR trees so a
// nested discriminator is found (`index=web error` → index='web' AND message LIKE …).
// A non-string-literal RHS (a $token$-driven index → {{tok}}) is recorded as
// `<field>=<dynamic>` so it never compares equal across the two sides.
function collectSourceDiscriminators(whereList) {
  const found = new Set();
  const visit = (node) => {
    if (!node || node.type !== 'BinOp') return;
    if (node.op === 'AND' || node.op === 'OR') {
      visit(node.left);
      visit(node.right);
      return;
    }
    if (
      node.op === '=' &&
      node.left &&
      node.left.type === 'Identifier' &&
      SOURCE_DISCRIMINATOR_FIELDS.has(node.left.name)
    ) {
      const rhs = node.right;
      const value =
        rhs && rhs.type === 'Literal' && typeof rhs.value === 'string'
          ? rhs.value
          : '<dynamic>';
      found.add(`${node.left.name}=${value}`);
    }
  };
  for (const cond of whereList) visit(cond);
  return [...found].sort().join('|');
}
```

Then add the guard in `handleAppend`, **after** the facet-mismatch `return` (line ~160) and **before** the `const mainWhere = ir.where;` WHERE-merge block:

```javascript
  // Defect 1 — cross-source discriminator. If the two sides carry different leading
  // index=/sourcetype=/source= filters, FROM Log cannot read both datasets; a filter()
  // merge silently returns 0 for at least one side (NR Log usually carries no `index`).
  // No faithful single-query NRQL exists (no UNION, no multi-source FROM).
  if (
    collectSourceDiscriminators(ir.where) !==
    collectSourceDiscriminators(subIR.where)
  ) {
    ir.unsupported.push(messages.append_cross_source(label));
    return;
  }
```

**Placement is load-bearing:** it must sit after the no-agg and facet-mismatch guards. The existing `index=web | append [search index=api]` case (no aggregation) must keep firing `append_no_agg`, NOT `append_cross_source` — the no-agg guard returns first.

- [ ] **Step 5: Run, confirm green.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test` — cross-source case now `unsupported`; both regressions still green; the existing `index=web | append [search index=api]` (no-agg) and same-`index=main` cases (lines ~3394, ~3707) still pass. Then whole package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge` (no regressions).

- [ ] **Step 6: CLI spot-check.** Confirm byte-for-byte:

```
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'index=web | stats count | append [search index=payments | stats count]'   # → unsupported: append_cross_source
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'sourcetype=access | stats count | append [search sourcetype=error | stats count]'   # → unsupported (sourcetype discriminator)
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'status=200 | stats count | append [search status=500 | stats count]'   # → faithful filter() merge (unchanged)
```

- [ ] **Step 7: Fuzz ×20** (mandatory for translator changes):

```bash
for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done
```

- [ ] **Step 8: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/enrichmentHandlers.js packages/nr-query-bridge/src/messages.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "fix: append/appendcols cross-source subsearch is unsupported"
```

---

### Task 2 (PR 2): divergent per-side time window → `unsupported`

**Files:**
- Modify: `src/input/spl/enrichmentHandlers.js` — add the divergent-window guard in `handleAppend`.
- Modify: `src/messages.js` — add `append_divergent_timerange`.
- Modify: `test/spl/spl.test.js` — add the divergent-window `unsupported` case + a same-window regression.

**Interfaces:**
- Consumes: `subIR.since` / `subIR.until` (strings like `'1 day ago'`, or `null`) — already computed by `translateAstToIR(subAst)` at the top of `handleAppend`; and `ir.since` / `ir.until` — the main query's window, set in `translateAstToIR` **before** the pipeline runs, so they reflect the main search by the time `handleAppend` executes. `handleAppend` today merges only `select`/`facet`/`where` and ignores `subIR.since`/`subIR.until`, so the sub window is silently dropped.
- Produces: nothing new in IR — pushes `messages.append_divergent_timerange(label)` and returns.

**Window semantics (all three verified `cceb76a`, 2026-06-28):**
- **same window** (`earliest=-1d latest=now` both sides) → today: `SELECT count(*), count(*) SINCE 1 day ago` (faithful) — `subIR.since === ir.since`, `subIR.until === ir.until` → **no trigger** (must stay faithful).
- **sub-only window** (main `*`, sub `earliest=-2d latest=-1d`) → today: `SELECT count(*), count(*)` (sub window silently DROPPED) → `subIR.since` set, `ir.since` null → **trigger**.
- **main-only window** (main `earliest=-1d latest=now`, sub `*`) → today: `SELECT count(*), count(*) SINCE 1 day ago` (main window applies to both) → `subIR.since`/`subIR.until` both null → **no trigger** (the sub didn't set its own window; spec's defect is "subsearch carries its OWN window").

- [ ] **Step 1: Add failing cases** to the `cases` array (next to the other append cases):

```javascript
  // Defect 2: subsearch carries its own time window that differs from the main query's.
  // NRQL applies one SINCE/UNTIL to the whole query; today the sub window is silently
  // dropped and both aggregates run over the main window (this-period-vs-last returns
  // the main count twice).
  {
    spl: 'earliest=-1d latest=now | stats count | append [search * earliest=-2d latest=-1d | stats count]',
    unsupportedFunc: ['append_divergent_timerange'],
    doc: 'correlation-append',
    verified: false,
  },
  // Regression: SAME window on both sides is not divergent — stays the faithful merge.
  {
    spl: 'earliest=-1d latest=now | stats count | append [search * earliest=-1d latest=now | stats count]',
    nrql: 'FROM Log SELECT count(*), count(*) SINCE 1 day ago',
    warningFunc: ['append_merged'],
    doc: 'correlation-append',
    verified: false,
  },
```

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
  Expected: the divergent case FAILS (`append_divergent_timerange` undefined + still emits `count(*), count(*) SINCE 1 day ago`); the same-window regression should already PASS.

- [ ] **Step 3: Add the message** to `src/messages.js` (next to `append_cross_source`):

```javascript
  // SPL: `earliest=-1d | stats count | append [search * earliest=-2d latest=-1d | stats count]`
  append_divergent_timerange: (label) =>
    `${label} subsearch defines its own time window (earliest/latest) that differs from ` +
    'the main search; NRQL applies a single SINCE/UNTIL to the whole query and cannot run ' +
    'the two sides over different windows',
```

- [ ] **Step 4: Implement the guard** in `handleAppend`, immediately after the Defect 1 cross-source guard (still before the WHERE-merge):

```javascript
  // Defect 2 — divergent per-side time window. The subsearch's own earliest/latest is
  // ignored by the merge below, so it would run over the main window. NRQL has no
  // per-column time window, so a sub window that differs from the main is untranslatable.
  if (
    (subIR.since || subIR.until) &&
    (subIR.since !== ir.since || subIR.until !== ir.until)
  ) {
    ir.unsupported.push(messages.append_divergent_timerange(label));
    return;
  }
```

- [ ] **Step 5: Run, confirm green.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test` then whole package — divergent case `unsupported`, same-window + main-only (if present) regressions green, no other regressions.

- [ ] **Step 6: CLI spot-check.** Byte-confirm the three window shapes:

```
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'earliest=-1d latest=now | stats count | append [search * earliest=-2d latest=-1d | stats count]'   # → unsupported
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'earliest=-1d latest=now | stats count | append [search * earliest=-1d latest=now | stats count]'   # → SINCE 1 day ago (faithful)
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'earliest=-1d latest=now | stats count | append [search * | stats count]'   # → SINCE 1 day ago (faithful; sub has no own window)
```

- [ ] **Step 7: Fuzz ×20.**

```bash
for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done
```

- [ ] **Step 8: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/enrichmentHandlers.js packages/nr-query-bridge/src/messages.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "fix: append divergent per-side time window is unsupported"
```

---

### Task 3 (PR 3): graduate (docs)

**Files:**
- Modify: `.claude/rules/design-decisions.md` (add the invariant).
- Modify: `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` (reclassify the `append-subsearch` row).
- Modify: `test/spl/spl.test.js` (`verified: false` → `'llm'` for the new cases, only if staging-validated — see note).

> **No new NRQL to staging-validate.** Both fixes are detection-only — they emit `unsupported`, not new NRQL. The faithful `filter()` merge shape is already staging-validated (existing `verified: 'human'` append cases). So promotion here is optional; leave the new cases at `verified: false` unless a human runs `validate-test-cases`. Only a human may promote to `'human'`.

- [ ] **Step 1: Graduate the invariant** to `.claude/rules/design-decisions.md`, under a new bullet near the other enrichment/handler notes (there is no existing append bullet — add one):

```markdown
- **`append`/`appendcols` keep-and-fix**: `handleAppend` serves both (only the `label` differs) and
  translates the `stats`-merge idiom to side-by-side `filter()` columns — faithful for the dominant
  corpus form, so it is NOT replaced. Guard order is load-bearing: parse → forward subsearch
  msgs → no-agg → facet-mismatch → **cross-source** → **divergent-timerange** → WHERE-merge. Two
  silent-wrong families are loud `unsupported`: (1) **cross-source** — `collectSourceDiscriminators`
  builds a normalized `index`/`sourcetype`/`source` `=` signature per side (descends AND/OR; a
  `$token$`/non-string-literal RHS reads as `<dynamic>`); differing signatures → `append_cross_source`
  (one FROM Log can't read two datasets — no UNION/multi-source FROM). (2) **divergent window** — a
  subsearch `since`/`until` that is set AND differs from the main query's → `append_divergent_timerange`
  (NRQL has one SINCE/UNTIL). Same-source, same-/no-window, and same-WHERE merges are unchanged.
  Non-defects (do NOT "fix"): the `appendcols` conflation (every shape reaching the merge is single-row
  or same-facet; positional-only shapes already die at no-agg/facet-mismatch) and the total-row pattern
  (already caught by facet-mismatch) are benign and stay as-is.
```

- [ ] **Step 2: Reclassify the laundry-list row** in `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md`. The current `append-subsearch` row (line ~88) reads `GAP/LOSSY … silently conflated`. Change it to reflect the shipped fix: the stats-merge is a faithful (kept) translation, and the two silent-wrong families (cross-source, divergent window) are now loud `unsupported`. New row text (keep the table's column shape — `| name | class | description | example | NRQL approach | priority | source |`):

```markdown
| `append-subsearch` | FIXED | Faithful `stats`-merge → side-by-side `filter()` (kept). Two silent-wrong families now loud `unsupported`: cross-source (`index=`/`sourcetype=`/`source=` differs per side) and divergent per-side time window. `appendcols`-conflation + total-row were already-guarded non-defects. | `index=web \| stats count \| append [search index=payments \| stats count]` → `unsupported` (`append_cross_source`) | faithful `filter()` merge, else `unsupported` | Medium | corpus |
```

> **FLAG:** this same file is edited by PR #72. Rebase onto master after #72 lands and re-confirm the row's line number + column header shape before editing (see Double-check targets).

- [ ] **Step 3: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add .claude/rules/design-decisions.md docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: graduate append keep-and-fix invariant"
```

---

## Global Verification

- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm test` — full workspace suite green.
- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check` — clean.
- [ ] No `npm run build:parsers` needed — no grammar change (the guards read the existing IR; no new SPL syntax).
- [ ] Fuzz ×20 green on both behavior PRs.
- [ ] Corpus before/after via the private `nr-query-bridge-corpus` diagnostic harness — expect a small number of current lossy `filter()`/dropped-window outputs to move to `unsupported` (deliberate loud-over-wrong, NOT a regression); confirm **no faithful merge flips** to `unsupported`.
- [ ] Open the PRs (three commits → likely PR 1 + PR 2 stacked, PR 3 docs); invoke `write-gooder` for each body (100–200 words, summary + test plan).

## Self-Review

1. **Spec coverage:** keep faithful merge (no rewrite) ✓; defect 1 cross-source → `unsupported` (Task 1) ✓; defect 2 divergent window → `unsupported` (Task 2) ✓; non-defects (`appendcols` conflation, total-row) explicitly left alone + captured in the graduated invariant ✓; graduate + laundry-list reclass (Task 3) ✓.
2. **Loud-failure:** each guard pushes `unsupported` then `return` — no half-merged SELECT emitted. Detection-only; no new NRQL shape that could be silently wrong.
3. **No regressions by construction:** new guards sit AFTER no-agg + facet-mismatch (so `index=web | append [search index=api]` stays `append_no_agg`) and only re-examine shapes that reach the WHERE-merge. Same-index, same-/no-window, and same-WHERE cases verified to keep firing their existing keys.
4. **Type consistency:** `collectSourceDiscriminators(IRNode[]) → string`; reads `BinOp`/`Identifier`/`Literal` exactly per `src/ir/nodes.js` (`{type:'BinOp',op,left,right}`, `{type:'Identifier',name}`, `{type:'Literal',value,kind}`).
5. **Message/exhaustiveness consistency:** two new keys (`append_cross_source`, `append_divergent_timerange`) added to `src/messages.js`; the spl.test.js spy loop auto-covers them. `warningFunc`/`unsupportedFunc` arrays are exhaustive (regression cases list `append_filter_warning`/`append_merged`; the `unsupported` cases have clean subsearches that forward no warnings — re-confirm in Step 5 of each task).

## Double-check targets (flagged uncertainties)

1. **PR #72 gate + laundry-list line/shape.** Branch off master **after PR #72 lands**. PR #72 also edits `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md`; the `append-subsearch` row's line number (~88) and the table's exact column header shape may shift. Re-read the row post-rebase before editing Task 3 Step 2 — do not trust the line number here.
2. **`$token$`-driven index RHS node type.** I treat any non-string-`Literal` RHS as `<dynamic>` (so token sides never compare equal). Verified `index="$env$"` renders `index = {{env}}` (cross-source path fires when sides differ), but I did **not** dump the IR node to confirm whether the RHS is an `Identifier('{{env}}')` or a `Literal` with a non-string value — the `typeof rhs.value === 'string'` test handles both, but confirm with a one-off during Task 1 Step 4 that two *identical* `$token$` indexes (`index="$env$"` both sides) still read equal (same `<dynamic>` on each side → no false `unsupported`). If identical tokens should merge faithfully, the signature is correct; if the desired behavior is "any token index → unsupported," tighten the helper.
3. **`doc` sentinel tag.** New cases use `doc: 'correlation-append'` (matching every existing append case). If `SPL_TO_NRQL.md` lacks a `correlation-append` sentinel section the doc generator may warn — confirm the tag resolves (grep `SPL_TO_NRQL.md` for `correlation-append`) or drop `doc` (it's optional).
4. **Same-window equality of `since`/`until` strings.** Task 2's no-trigger path relies on `subIR.since === ir.since` for byte-identical windows. Verified for `earliest=-1d latest=now` both sides (both resolve to `'1 day ago'`/`null`). If two *spellings* of the same window (e.g. `-1d` vs `-24h`) resolve to different strings, they'd (correctly, per spec) trigger `unsupported` — note this is intended loud-over-wrong, not a bug, but mention it in the PR body.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-28-append-subsearch.md`. Implement via **subagent-driven-development**; cut `feat/append-subsearch` off `master` **after PR #72 lands**. Run `/double-check` on this plan first (clean-room: confirm the guard placement keeps every existing append case green, and that the cross-source/divergent detection matches the spec's trigger conditions), then execute Task 1 → Task 2 → Task 3.
