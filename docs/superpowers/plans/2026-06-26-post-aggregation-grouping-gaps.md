# Post-Aggregation & Time/Calendar Grouping Gaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six post-aggregation/grouping gaps from the spec (`docs/superpowers/specs/2026-06-26-post-aggregation-grouping-gaps-design.md`) so each input translates faithfully or emits a loud `unsupported`/warning — never silent-wrong or parse-invalid NRQL. F additionally makes the eval-after-stats fold additive for scalar source columns (keeps the scalar columns Splunk keeps).

**Architecture:** Six small, mostly-independent fixes across the existing pipeline (F couples with C — see its Sequencing note). B/C are post-aggregation-chain guards in the SPL handlers (`rowHandlers.js`, `evalHandlers.js`, consumed in `aggregationHandlers.js`). D1 and F are fixes in the `foldPostAggregation` optimizer pass (D1 one branch; F makes `foldEvalLayer` additive). D2 and E are facet-key rewrites — D2 in the `splToIR` post-loop, E in `handleStats`'s group-by construction. No grammar change, no emitter change (the emitter already renders `Func` nodes in `FACET` and any string in `TIMESERIES`).

**Tech Stack:** Pure ESM JS; IR node factories in `src/ir/nodes.js`; message catalog in `src/messages.js`; Vitest data-driven `cases` in `test/spl/spl.test.js`.

**Branch:** cut a fresh branch off `origin/master` (e.g. `fix/post-aggregation-grouping-gaps`). One PR; one commit per task.

## Global Constraints (apply to every task)

- **Node 24:** prefix every command — including `git commit` (hooks need it) — with `ASDF_NODEJS_VERSION=24.14.0`.
- **Conventional commits:** lowercase subject ≤72 chars; body lines ≤100. Use `git commit -F <file>` for multi-line bodies. Push with `git push origin HEAD`.
- **Loud failure over silent wrong:** any path that can't translate faithfully pushes a `messages.*` `unsupported`, never compiling-but-wrong or parse-invalid NRQL. When `unsupported` is non-empty the emitter returns `''`.
- **Messages:** all user-facing text lives in `src/messages.js`; handlers call `messages.key()` — no inline strings. Lead each message with a meaningful word (the `SPL_TO_NRQL.md` generator backticks the first token). Consistency is enforced in `test/spl/spl.test.js`: every `warningFunc`/`unsupportedFunc` entry is validated against `messages` (an undefined key fails), and the spy check asserts the arrays are **exhaustive** (every fired message is listed). There is no separate `messages.test.js`.
- **Verified level:** new/changed cases land at `verified: false`. Only a human promotes to `'llm'`/`'human'`. Do not set `'llm'`/`'human'`.
- **Run one package:** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl` (root `npm test` chains workspaces and aborts on the first failure).
- **Fuzz after any handler/IR change:** `for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npx vitest run spl-fuzz || break; done` (fast-check reseeds each run; a single green is a false-green).
- **Staging re-validation** (before any human promotes past `verified: false`): emitted NRQL runs via `run_nerdgraph_query` on acct **10671289** `FROM Transaction` with a short window (acct 1 `Log` times out). SINCE on the outer only — an inner-subquery `SINCE` is a parse error.
- **Exhaustive `warningFunc` reality:** the post-loop `facet_default_limit` warning fires whenever the final query has a non-empty `FACET` and `limit == null`. Several cases below therefore list it; confirm the exact fired set in each red/green step and match `warningFunc` to it.

## Engine-Grounded Facts (verified — do not re-derive)

Verified on staging (acct 10671289) + Splunk docs during the spec's double-check pass:

- NRDB has **no `_time` attribute**: bare `FACET _time` is a parse error; backticked `` FACET `_time` `` runs but returns `[]` (silent-wrong). `timestamp` is epoch-ms; `FACET timestamp` is degenerate (≈one bucket per ms).
- `TIMESERIES` caps at **366 buckets** (`TIMESERIES 1 second` over 65 min → "maximum of 366 buckets. Query has 3900"). `TIMESERIES MAX` returns the finest bucketing ≤366, adapts to the window, never errors. Emitter renders `TIMESERIES ${q.timeseries}`, so `ir.timeseries = 'MAX'` → `TIMESERIES MAX`.
- A nested per-bucket re-aggregation needs `TIMESERIES` on **both** inner and outer; inner subquery carries no `SINCE`.
- An output alias equal to a `FACET` key resolves to the **facet value**, discarding the computed expression (verified `count(*)*2 AS appName FACET appName`). Only demonstrable against a *real* attribute; the post-`stats` `host` is one.
- `*Of` folding functions return **string labels**: `hourOf`→`"14:00"`, `minuteOf`→`"48"`, `weekdayOf`→`"Friday"` (capitalized), `dayOfMonthOf`→`"26"`, `yearOf`→`"2026"`. `monthOf`→`"June 2026"` **pins the year** (no cross-year fold). No `secondOf`/timezone-offset function exists.
- Splunk `date_*` value shapes (docs): `date_hour` 0–23, `date_minute`/`date_second` 0–59, `date_mday` 1–31 (all integers); `date_wday` lowercase name (`date_wday="sunday"`); `date_month` numeric (`date_month=1`); `date_year` 4-digit; `date_zone` UTC-offset minutes. These fold across periods. `stats` never buckets time on its own — only `bin`/`bucket _time span=`/`timechart` do.

---

### Task 1: B — `dedup` between two aggregations → loud `unsupported`

**Commit:** `fix: mark dedup between aggregations as unsupported`

**Files:**
- Modify: `src/input/spl/rowHandlers.js` — `handleDedup` (line 99).
- Modify: `src/input/spl/aggregationHandlers.js` — `handleStats` guard (after line 29).
- Modify: `src/messages.js` — add `dedup_between_aggregations`.
- Test: `test/spl/spl.test.js`.

**Interfaces:**
- Produces: `ir._dedupBetweenAgg` (boolean marker), consumed by `handleStats`. Mirrors the existing `ir._headBetweenAgg` pattern.

**Design.** `head`/`tail` between aggregations is already loud: `handleHead`/`handleTail` set `ir._headBetweenAgg` when `ir._hasAggregation`, and the next `handleStats` consumes it (`aggregationHandlers.js:26`). `dedup` is the missing sibling. Set a separate `ir._dedupBetweenAgg` marker (keeps the `head_between_aggregations` wording intact for head/tail) and consume it the same way. Mirror head's pattern exactly — set the marker but keep `handleDedup`'s normal body — so a `dedup` after a *single* `stats` with no trailing aggregation is unchanged (the marker is set but never consumed). The unsupported B case therefore still carries the two dedup warnings `handleDedup` emits; that is correct (loud is loud) and the test lists them.

- [ ] **Step 1: Write failing cases** in the `cases` array of `test/spl/spl.test.js`:
  ```js
  {
    spl: '* | stats count by host, region | dedup host | stats sum(count)',
    nrql: '',
    unsupportedFunc: ['dedup_between_aggregations'],
    warningFunc: ['dedup_facet_warning', 'dedup_limit_max_cap'],
    verified: false,
  },
  // Negative control: dedup after a SINGLE stats, no trailing aggregation — unchanged.
  // Only dedup_facet_warning fires: dedup_limit_max_cap is pushed in the splToIR loop
  // only when a dedup is FOLLOWED by an aggregation command, which this case lacks.
  {
    spl: '* | stats count by host | dedup host',
    nrql: 'FROM Log SELECT count(*) FACET host LIMIT MAX',
    warningFunc: ['dedup_facet_warning'],
    verified: false,
  },
  ```
- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl`. The positive case fails (currently emits NRQL, not unsupported). If the negative control already exists in the suite, drop the duplicate and skip its assertion here.
- [ ] **Step 3: Add the message** to `src/messages.js`, next to `head_between_aggregations`:
  ```js
  dedup_between_aggregations: () =>
    'dedup between two aggregations cannot be translated faithfully: SPL keeps the first row per key in stats order, while a nested subquery selects by aggregate value (a different selection)',
  ```
- [ ] **Step 4: Set the marker** in `handleDedup` (`src/input/spl/rowHandlers.js`), as the first statement inside the function (before the `for` loop):
  ```js
  export function handleDedup(cmd, ir) {
    // A dedup sitting between two aggregations has no faithful NRQL (see handleStats).
    // Mirror handleHead: flag it but keep the normal dedup→FACET body, so a dedup after
    // a single stats (no trailing aggregation) is unchanged — the marker is never consumed.
    if (ir._hasAggregation) ir._dedupBetweenAgg = true;
    for (const field of cmd.fields) {
  ```
- [ ] **Step 5: Consume the marker** in `handleStats` (`src/input/spl/aggregationHandlers.js`), immediately after the existing `_headBetweenAgg` block (after line 29):
  ```js
    if (ir._dedupBetweenAgg) {
      ir.unsupported.push(messages.dedup_between_aggregations());
      return;
    }
  ```
- [ ] **Step 6: Run, confirm green.** Same command. Confirm the positive case is `''` + `['dedup_between_aggregations']`, and the negative control is unchanged. If the green run shows a different warning set on the positive case, set `warningFunc` to exactly what fired (exhaustive rule).
- [ ] **Step 7: Whole-package + fuzz.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge` then the fuzz loop. No regressions.
- [ ] **Step 8: Commit.**

---

### Task 2: C — `eval` output-alias equal to a facet key → loud `unsupported`

**Commit:** `fix: mark eval aliasing a facet key as unsupported`

**Files:**
- Modify: `src/input/spl/evalHandlers.js` — `handleEval` after-aggregation block (line 54).
- Modify: `src/messages.js` — add `eval_shadows_facet_key`.
- Test: `test/spl/spl.test.js`.

**Design.** After `stats count by host`, `eval host = count*2` asks to overwrite the group-by field. The translator folds it to `SELECT count(*)*2 AS host FACET host`; NRDB resolves the `host` output column to the facet value and silently discards `count(*)*2`. There is no faithful form. Guard **before the wrap** (the very top of the `if (ir._hasAggregation)` block) so the result is a clean `unsupported` with no stray `eval_after_agg_drops_source` warning. The guard fires only on a name collision, so the negative control (`eval host2 = …`) is byte-identical to today, including its existing `eval_after_agg_drops_source` warning. `ir.facet` still holds the raw group-by keys at this point (the post-loop `_time` strip runs later), so a plain name match is correct.

- [ ] **Step 1: Write failing cases** in `test/spl/spl.test.js`:
  ```js
  {
    spl: '* | stats count by host | eval host = count*2',
    nrql: '',
    unsupportedFunc: ['eval_shadows_facet_key'],
    verified: false,
  },
  // Negative control: distinct alias name still folds flat (unchanged).
  // NOTE: Task 6 (F) makes the fold additive and NARROWS eval_after_agg_drops_source to
  // non-scalar sources — it does NOT delete the key (median/percentile/list sources still
  // fire it). This case's source `count` is scalar, so F keeps it: rewrites this nrql to the
  // additive form and clears its warningFunc to []. Leave it as-is here (HEAD-accurate at
  // this task); F updates it.
  {
    spl: '* | stats count by host | eval host2 = count*2',
    nrql: "FROM Log SELECT count(*) * 2 AS 'host2' FACET host LIMIT MAX",
    warningFunc: ['eval_after_agg_drops_source'],
    verified: false,
  },
  ```
- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl`. The positive case currently emits `count(*) * 2 AS 'host' FACET host`.
- [ ] **Step 3: Add the message** to `src/messages.js`, near `eval_after_agg_nonscalar`:
  ```js
  eval_shadows_facet_key: (field) =>
    `eval output field '${field}' collides with a group-by (FACET) key; New Relic resolves the output column to the facet value and discards the computed expression, so this cannot be translated faithfully`,
  ```
- [ ] **Step 4: Add the guard** in `handleEval` (`src/input/spl/evalHandlers.js`), as the first statements inside `if (ir._hasAggregation) {` — before `const facetKeys = [...ir.facet];`:
  ```js
    // An eval output alias equal to a group-by (facet) key would overwrite the group
    // label: NRDB resolves the output column to the facet value and discards the computed
    // expression (staging-verified). No faithful NRQL — bail loud BEFORE wrapping so no
    // partial warning (eval_after_agg_drops_source) leaks onto an unsupported result.
    const facetNames = new Set(ir.facet.map((f) => f.name).filter(Boolean));
    const shadowed = (cmd.assignments || []).find((a) => facetNames.has(a.field));
    if (shadowed) {
      ir.unsupported.push(messages.eval_shadows_facet_key(shadowed.field));
      return;
    }
  ```
- [ ] **Step 5: Run, confirm green.** The positive case is `''` + `['eval_shadows_facet_key']` with **no** warnings; the negative control is unchanged (still `eval_after_agg_drops_source`). Adjust `warningFunc` to the exact fired set if the green run differs.
- [ ] **Step 6: Whole-package + fuzz.** No regressions in the existing eval/where-after-stats cases.
- [ ] **Step 7: Commit.**

---

### Task 3: D1 — `_time` regroup over a TIMESERIES inner → outer TIMESERIES (faithful)

**Commit:** `fix: carry inner TIMESERIES to the outer on a time-bucket regroup`

**Files:**
- Modify: `src/ir/foldPostAggregation.js` — the trailing-regroup branch (the `if (missing)` block, ~line 602-615).
- Test: `test/spl/spl.test.js`.

**Design.** `timechart span=1m count by host | stats avg(count) by _time` re-aggregates per 1-minute bucket — faithful, keeps the time axis. `wrapAsSubquery` already moves `TIMESERIES 1 minute` into the inner; the trailing `stats … by _time` lands on the outer. The fold's regroup guard already *exempts* a time-bucket key from the unsupported check when the inner carries TIMESERIES (`innerHasTimeseries && isTimeBucketField`) — but then leaves `_time` in the outer `FACET`, emitting invalid `FACET _time`. The fix: in that exempted path, **strip the time-bucket key from the outer facet and set the outer `ir.timeseries` to the inner's interval** (`collapsedInner.timeseries`). Both levels then carry `TIMESERIES 1 minute` — without the outer one, NRDB collapses the series to a scalar (verified). The emitter already renders an outer `TIMESERIES` over a `SubquerySource`. The pre-existing `facet_default_limit` warning is pushed earlier (in `splToIR`, while the outer facet still held `_time`), so it rides along on the result; that is a benign known artifact, not this task's concern — list it in `warningFunc`.

- [ ] **Step 1: Write the failing case** in `test/spl/spl.test.js`:
  ```js
  {
    spl: '* | timechart span=1m count by host | stats avg(count) by _time',
    nrql: 'FROM (FROM Log SELECT count(*) FACET host LIMIT MAX TIMESERIES 1 minute) SELECT average(count) TIMESERIES 1 minute',
    warningFunc: ['facet_default_limit'],
    verified: false,
  },
  // Negative control: no `by _time` → collapses to the scalar form (unchanged).
  {
    spl: '* | timechart span=1m count by host | stats avg(count)',
    nrql: 'FROM (FROM Log SELECT count(*) FACET host LIMIT MAX TIMESERIES 1 minute) SELECT average(count)',
    verified: false,
  },
  ```
- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl`. The positive case currently emits `… SELECT average(count) FACET _time`. Confirm the exact current string with `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "* | timechart span=1m count by host | stats avg(count) by _time"`, and set the negative control's expected `nrql` to its actual current output (it must stay unchanged).
- [ ] **Step 3: Implement.** In `src/ir/foldPostAggregation.js`, find the `if (missing) { … }` block (the one pushing `compound_trailing_regroup_unsupported`) and insert the time-bucket carry-over **immediately after** that block's closing `}` (still inside the `aggregating && aggregating` branch, before its closing brace). The block to add:
  ```js
    // A trailing regroup by a time-bucket key (_time/timestamp/bin-alias) over a
    // TIMESERIES inner is faithful per-bucket re-aggregation: carry the inner's interval
    // onto the OUTER as TIMESERIES and strip the bucket key from the outer FACET. Bare
    // `FACET _time` is a parse error; backticked `_time` returns []. Without the outer
    // TIMESERIES the series collapses to a scalar; with it, one row per bucket (verified).
    if (innerHasTimeseries) {
      const keptFacet = ir.facet.filter(
        (f) => !(f.type === 'Identifier' && isTimeBucketField(f.name)),
      );
      if (keptFacet.length !== ir.facet.length) {
        ir = { ...ir, facet: keptFacet, timeseries: collapsedInner.timeseries };
      }
    }
  ```
  (`innerHasTimeseries`, `isTimeBucketField`, `collapsedInner`, and the reassignable `ir` are all already in scope in that branch.)
- [ ] **Step 4: Run, confirm green.** The positive case now emits the both-levels-TIMESERIES form with no `FACET _time`; the negative control is unchanged. Match `warningFunc` to the exact fired set (the green run reveals whether `facet_default_limit` fires).
- [ ] **Step 5: Whole-package + fuzz.** Watch the existing `timechart`/stats-after-stats and `compound_trailing_regroup_unsupported` cases — a non-time regroup over a TIMESERIES inner (e.g. `… | stats avg(count) by region`) must still be loud `unsupported` (the exemption is time-bucket-only).
- [ ] **Step 6: Commit.**

---

### Task 4: D2 — bare `stats … by _time` (no upstream bucket) → `TIMESERIES MAX` + warning

**Commit:** `fix: map bare stats-by-_time to TIMESERIES MAX with a warning`

**Files:**
- Modify: `src/input/spl/splToIR.js` — post-loop, immediately after the command loop (after `applyCommand(cmd, ir)` / the loop's closing `}`).
- Modify: `src/messages.js` — add `bare_time_facet_assumed_timeseries`.
- Test: `test/spl/spl.test.js`.

**Design.** `stats count by _time` with no prior `bin`/`timechart` groups by the source's native time resolution. NRDB has no `_time` attribute and `FACET timestamp` is degenerate (epoch-ms). Map it to `TIMESERIES MAX` (finest bucketing ≤366, window-adaptive, never errors) and warn that the exact resolution can't be reproduced. Scope the rewrite to the **non-subquery** case: a time-bucket regroup *over* a subquery is D1's job (`foldPostAggregation`) and must not be pre-empted. Run it **before** the post-loop `facet_default_limit` check so a sole `_time` key — once stripped — doesn't trigger a spurious "FACET defaults to 10 groups" warning on a query that has no FACET.

- [ ] **Step 1: Write failing cases** in `test/spl/spl.test.js`:
  ```js
  {
    spl: '* | stats count by _time',
    nrql: 'FROM Log SELECT count(*) TIMESERIES MAX',
    warningFunc: ['bare_time_facet_assumed_timeseries'],
    verified: false,
  },
  // Negative controls: real upstream bucketing is unchanged (concrete span, no warning).
  {
    // facet_default_limit fires: it is pushed (post-loop) while the facet still holds
    // `_time`, just before stripTimeBucketFacets removes it. Pre-existing, benign.
    spl: '* | bin _time span=1h | stats count by _time',
    nrql: 'FROM Log SELECT count(*) TIMESERIES 1 hour',
    warningFunc: ['facet_default_limit'],
    verified: false,
  },
  {
    spl: '* | timechart span=1h count',
    nrql: 'FROM Log SELECT count(*) TIMESERIES 1 hour',
    verified: false,
  },
  ```
- [ ] **Step 2: Run, confirm red.** The positive case currently emits `FROM Log SELECT count(*) FACET _time`. If the two negative controls already exist in the suite, drop the duplicates (they assert the no-regression baseline).
- [ ] **Step 3: Add the message** to `src/messages.js`:
  ```js
  bare_time_facet_assumed_timeseries: () =>
    'stats by _time/timestamp with no upstream bin/timechart was mapped to TIMESERIES MAX (the finest bucketing New Relic allows); the source’s exact native resolution cannot be reproduced and sub-second data is coarsened',
  ```
- [ ] **Step 4: Implement.** In `src/input/spl/splToIR.js`, insert this block immediately after the command loop closes and before the `// Gap #3: cascading mvexpand detection` comment:
  ```js
  // Bare `stats … by _time`/`timestamp`/bin-alias with NO upstream bucketing: NRDB has no
  // _time attribute and FACET timestamp is degenerate (epoch-ms). Approximate the native
  // resolution with TIMESERIES MAX and warn. Non-subquery only — a time-bucket regroup over
  // a subquery is D1's job (foldPostAggregation). Runs before facet_default_limit so a sole
  // _time key, once stripped, doesn't fire a spurious FACET warning.
  if (
    ir.dataSource?.type !== 'SubquerySource' &&
    !ir.timeseries &&
    ir.facet.length > 0
  ) {
    const timeAliases = ir._timeBucketAliases ?? new Set();
    const isTimeBucket = (f) =>
      f.type === 'Identifier' &&
      (f.name === '_time' || f.name === 'timestamp' || timeAliases.has(f.name));
    if (ir.facet.some(isTimeBucket)) {
      ir.facet = ir.facet.filter((f) => !isTimeBucket(f));
      ir.timeseries = 'MAX';
      ir.warnings.push(messages.bare_time_facet_assumed_timeseries());
    }
  }
  ```
- [ ] **Step 5: Run, confirm green.** Positive case → `FROM Log SELECT count(*) TIMESERIES MAX` + the one warning; negatives unchanged. Verify `* | stats count by host, _time` keeps `FACET host` and gains `TIMESERIES MAX` (mixed-key case — add a case if useful): `FROM Log SELECT count(*) FACET host TIMESERIES MAX` with `warningFunc: ['bare_time_facet_assumed_timeseries', 'facet_default_limit']`.
- [ ] **Step 6: Whole-package + fuzz.** Confirm D1 (Task 3) still emits `TIMESERIES 1 minute` (concrete span, no D2 warning) — the subquery guard keeps D2 off it.
- [ ] **Step 7: Commit.**

---

### Task 5: E — `date_*` calendar fields → `*Of(timestamp)` (foldable) or loud `unsupported`

**Commit:** `fix: map date_* calendar group-by fields to *Of(timestamp) or unsupported`

**Files:**
- Modify: `src/input/spl/aggregationHandlers.js` — `handleStats` group-by construction (line 64-66).
- Modify: `src/messages.js` — add `date_field_label_shape`, `date_field_no_fold`.
- Test: `test/spl/spl.test.js`.

**Design.** Splunk auto-extracts folding calendar fields (`date_hour`, `date_minute`, `date_wday`, `date_mday`, `date_year`, …). NR logs carry no such attribute, so `FACET date_hour` returns empty (silent-wrong). Map the five foldable ones to `FACET <fn>(timestamp)` plus a value-shape warning (NR returns string labels — `"13:00"`, `"Friday"` — not Splunk's integers/lowercase names). `date_month` (NR `monthOf` pins the year), `date_second`, and `date_zone` have no faithful fold → loud `unsupported`. Match the **exact closed field-name set**, never a `date_*` prefix, so a user field like `date_created` stays an ordinary facet. The emitter already renders a `Func` node in `FACET`.

- [ ] **Step 1: Write failing cases** in `test/spl/spl.test.js`:
  ```js
  {
    spl: '* | stats count by date_hour',
    nrql: 'FROM Log SELECT count(*) FACET hourOf(timestamp)',
    warningFunc: ['date_field_label_shape', 'facet_default_limit'],
    verified: false,
  },
  { spl: '* | stats count by date_month', nrql: '', unsupportedFunc: ['date_field_no_fold'], verified: false },
  { spl: '* | stats count by date_second', nrql: '', unsupportedFunc: ['date_field_no_fold'], verified: false },
  { spl: '* | stats count by date_zone', nrql: '', unsupportedFunc: ['date_field_no_fold'], verified: false },
  // Negative control: not a calendar field — ordinary facet, no rewrite, no calendar warning.
  {
    spl: '* | stats count by date_created',
    nrql: 'FROM Log SELECT count(*) FACET date_created',
    warningFunc: ['facet_default_limit'],
    verified: false,
  },
  ```
- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl`. `date_hour` currently emits `FACET date_hour`.
- [ ] **Step 3: Add the messages** to `src/messages.js`:
  ```js
  date_field_label_shape: () =>
    'calendar field mapped to a *Of(timestamp) function; New Relic returns string labels (e.g. "13:00", "Friday") rather than Splunk’s integer/lowercase-name values, so downstream sorts or equality checks that assume the Splunk shape will differ',
  date_field_no_fold: (field) =>
    `${field} has no faithful NRQL fold: monthOf pins the year, and New Relic has no second-of-minute or timezone-offset function, so the calendar grouping cannot be reproduced`,
  ```
- [ ] **Step 4: Implement.** In `src/input/spl/aggregationHandlers.js`, replace the group-by block:
  ```js
  if (cmd.groupBy.length > 0) {
    ir.facet = cmd.groupBy.map(Identifier);
  }
  ```
  with:
  ```js
  if (cmd.groupBy.length > 0) {
    // Splunk date_* calendar fields fold (every day's 9am → date_hour=9). NR has no such
    // attribute. Map the foldable ones to *Of(timestamp) (+ string-label warning); the rest
    // are loud unsupported. EXACT field-name match against the closed set — never a `date_*`
    // prefix, so a user field like date_created stays an ordinary facet.
    const FOLD = {
      date_hour: 'hourOf',
      date_minute: 'minuteOf',
      date_wday: 'weekdayOf',
      date_mday: 'dayOfMonthOf',
      date_year: 'yearOf',
    };
    const NO_FOLD = new Set(['date_month', 'date_second', 'date_zone']);
    const bad = cmd.groupBy.find((name) => NO_FOLD.has(name));
    if (bad) {
      ir.unsupported.push(messages.date_field_no_fold(bad));
      return;
    }
    let sawCalendarFold = false;
    ir.facet = cmd.groupBy.map((name) => {
      const fn = FOLD[name];
      if (fn) {
        sawCalendarFold = true;
        return Func(fn, [Identifier('timestamp')]);
      }
      return Identifier(name);
    });
    if (sawCalendarFold) ir.warnings.push(messages.date_field_label_shape());
  }
  ```
  (`Func` and `Identifier` are already imported in this file.)
- [ ] **Step 5: Run, confirm green.** Match `warningFunc` to the exact fired order (`date_field_label_shape` is pushed in the loop, `facet_default_limit` in the post-loop, so `['date_field_label_shape', 'facet_default_limit']`). Confirm `date_created` is untouched.
- [ ] **Step 6: Whole-package + fuzz.** No regressions; confirm no existing case used a `date_*` field name as a plain facet (the closed-set match leaves non-listed names alone).
- [ ] **Step 7: Commit.**

---

### Task 6: F — additive eval-fold keeps the source aggregate columns Splunk keeps

**Commit:** `fix: keep source aggregate columns when folding eval after stats`

**Files:**
- Modify: `src/ir/foldPostAggregation.js` — `foldEvalLayer` (line 336): re-alias + keep the **scalar** source aggregates (with overwrite dedupe); narrow the `dropped`/`eval_after_agg_drops_source` block to non-scalar sources.
- Modify: `src/messages.js` — **reword** `eval_after_agg_drops_source` to the non-scalar-source case (do NOT delete it — it still fires for median/percentile/list sources).
- Test: `test/spl/spl.test.js` — the **scalar**-source cases asserting `eval_after_agg_drops_source` get the additive `nrql` + the key dropped from `warningFunc` (incl. Task 2's `host2` negative); the median/percentile cases are **unchanged** (still dropped + warned).

**Interfaces:**
- Produces: narrows (does not remove) `messages.eval_after_agg_drops_source`. Scalar-source cases stop firing it; non-scalar-source cases keep it.

**Sequencing (F ↔ C).** F is numbered after C and narrows `eval_after_agg_drops_source`, which Task 2 (C) asserts on its `host2` negative. `host2`'s source is the scalar `count`, so F keeps it (no drop) — this task rewrites that negative's `nrql` to the additive form and clears its `warningFunc` to `[]`.

**Design.** Splunk's `eval` ADDS a column and keeps the originals, so `stats count by host | eval pct = count*100` is `host, count, pct` in Splunk but `host, pct` in the current flat fold. Make the fold additive **for scalar source aggregates only**: re-project each scalar aggregate under its exposed name alongside the folded eval. A **non-scalar** source (`median`/`percentile`→keyed object `{50:v}`, `uniques`/`values`→list; detect with `extractNonScalar`, line 93) re-projects in the wrong shape (staging-verified bare `median(duration) AS p50` → `{"50":v}`, not Splunk's scalar), so it stays dropped and keeps the (reworded, narrowed) warning. **Dedupe is mandatory** — when an eval *reassigns* a scalar source's name (`eval count = count*2`), emitting both `count(*) AS count` and `count(*)*2 AS count` is silent-wrong: NRDB returns the *first* duplicate alias (staging-verified `SELECT count(*) AS c, count(*)*2 AS c` → the plain count). So drop any kept scalar aggregate whose name a folded eval also defines — the eval wins, matching Splunk's overwrite.

- [ ] **Step 1: Update the failing cases** in `test/spl/spl.test.js`. `grep -n eval_after_agg_drops_source test/spl/spl.test.js`; update only the **scalar**-source cases (change `nrql` to the additive form, drop the key from `warningFunc`). Anchors today:
  - `* | stats count by host | eval pct = count * 100` → `nrql: "FROM Log SELECT count(*) AS count, count(*) * 100 AS 'pct' FACET host LIMIT MAX"`, drop `warningFunc`.
  - Task 2's `host2` negative → `nrql: "FROM Log SELECT count(*) AS count, count(*) * 2 AS 'host2' FACET host LIMIT MAX"`, drop `warningFunc`.
  - **Leave the median/percentile cases unchanged** (`median(latency) as p50 … eval x = p50*2`, the `med`/`p95` siblings) — their source is non-scalar, so it stays dropped and still carries `warningFunc: ['eval_after_agg_drops_source']`.
  - New multi-aggregate case: `* | stats count, avg(bytes) as a by host | eval pct = count*100` → `nrql: "FROM Log SELECT count(*) AS count, average(bytes) AS a, count(*) * 100 AS 'pct' FACET host LIMIT MAX"`, `verified: false`.
  - New overwrite case: `* | stats count by host | eval count = count*2` → `nrql: "FROM Log SELECT count(*) * 2 AS count FACET host LIMIT MAX"` (one `count`; eval wins), `verified: false`.
  - **Exact alias quoting** (`AS count` vs `AS 'count'`) is the emitter's call — match each `nrql` to the actual `node bin/spl2nrql.js` output in Step 4.
- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl` — the updated cases fail (HEAD still drops the aggregate + warns).
- [ ] **Step 3: Implement** in `src/ir/foldPostAggregation.js` `foldEvalLayer`. Replace the `keptInner`/`dropped` block (lines 367–381) with a scalar-only additive merge that still warns on non-scalar drops:
  ```js
  const foldedNames = new Set(folded.map((f) => f.name));
  const keptInner = [];
  const dropped = []; // non-scalar source aggregates we still cannot re-project
  for (const item of inner.select) {
    if (!isBareAggregateEntry(item)) {        // prior eval-derived column — keep as-is
      keptInner.push(item);
    } else if (extractNonScalar(item)) {      // median/percentile keyed object, uniques list
      dropped.push(exposedNameOf(item));      // wrong shape if re-projected — drop + warn
    } else {                                  // scalar aggregate — re-alias and keep (additive)
      keptInner.push(item.type === 'Alias' ? item : Alias(item, exposedNameOf(item)));
    }
  }
  // Splunk's eval OVERWRITES a same-named field; emitting both is silent-wrong (flat dup
  // alias returns the first). Drop the kept scalar whose name a folded eval reassigns.
  const merged = keptInner.filter((item) => !foldedNames.has(exposedNameOf(item)));
  if (dropped.length > 0 && warnings) warnings.push(messages.eval_after_agg_drops_source(dropped));
  if (droppedAcc) for (const n of dropped) droppedAcc.add(n);
  ```
  Use `merged` where `keptInner` was used (`select: [...merged, ...folded]`). (`Alias`, `exposedNameOf`, `extractNonScalar`, `isBareAggregateEntry` are all already in scope.)
- [ ] **Step 4: Run, confirm green** + verify emitted alias quoting: `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "* | stats count by host | eval pct = count*100"`. If a bare `AS count` is later rejected on staging (reserved word), the emitter decides quoting — set the test `nrql` to whatever it actually emits.
- [ ] **Step 5: Reword the message.** Update `eval_after_agg_drops_source` in `src/messages.js` to describe the **non-scalar** source case (a median/percentile/list aggregate can't be re-projected as a scalar, so it's absent from the output). Keep the key — the median/percentile cases still reference it.
- [ ] **Step 6: Audit the `orderBy`-dropped guard.** `orderByRefsDropped` (`foldPostAggregation.js:696`) still fires for the still-dropped **non-scalar** names (`droppedAcc` keeps them). A *scalar* aggregate is now kept, so an `orderBy` on it is legal — if a case asserted an `orderBy`-on-a-scalar-aggregate `unsupported` (`compound_collapse_unsupported`), it now folds faithfully; update or remove it.
- [ ] **Step 7: Whole-package + fuzz** ×20. No regressions in the eval/where-after-stats cases.
- [ ] **Step 8: Staging re-validate** on acct 10671289 (`run_nerdgraph_query`, short window): the additive `count`+`pct` form returns both columns; the overwrite form returns one `count` = 2× the plain count; the median case still emits the scalar `x` only (`p50` dropped, warned).
- [ ] **Step 9: Commit.**

---

### Task 7: Graduate invariants; update the NRQL reference; retire the spec

**Commit:** `docs: graduate post-aggregation grouping invariants`

**Files:**
- Modify: `.claude/rules/design-decisions.md` — add the six invariants.
- Modify: `.claude/references/nrql-reference.md` — add the verified time/calendar facts (**guarded — see Step 2**).
- Delete: `docs/superpowers/specs/2026-06-26-post-aggregation-grouping-gaps-design.md` (git history is the archive; invariants captured first).

- [ ] **Step 1: Graduate invariants** into `.claude/rules/design-decisions.md`. Under **IR & Optimization**, fold these one-liners in (extend the existing `foldPostAggregationPass` and subquery-wrapping bullets rather than duplicating them):
  - `dedup` between two aggregations → `dedup_between_aggregations` (`handleDedup` sets `ir._dedupBetweenAgg`, next `handleStats` consumes it) — SPL first-per-key-in-order ≠ a subquery selection. Sibling of `head_between_aggregations`.
  - eval-after-stats whose output alias equals a facet key → `eval_shadows_facet_key`, guarded **before** the wrap in `handleEval` (NRDB resolves the output column to the facet value and discards the expression).
  - A trailing time-bucket regroup (`_time`/`timestamp`/bin-alias) over a TIMESERIES inner → `foldPostAggregation` strips the bucket key from the outer FACET and sets the outer `ir.timeseries` to the inner's interval (TIMESERIES on both levels; without the outer one the series collapses to a scalar).
  - Bare `stats … by _time`/`timestamp` with no upstream bucketing (non-subquery) → `splToIR` post-loop sets `ir.timeseries='MAX'`, strips the key, warns `bare_time_facet_assumed_timeseries`. Runs before `facet_default_limit`.
  - `stats … by date_<comp>` → `handleStats` maps the five foldable fields (`date_hour/minute/wday/mday/year` → `hourOf/minuteOf/weekdayOf/dayOfMonthOf/yearOf(timestamp)` + `date_field_label_shape`) by exact name; `date_month/second/zone` → `date_field_no_fold` unsupported. Exact closed set, never a `date_*` prefix.
  - eval-after-stats fold is **additive for scalar source aggregates** (`foldEvalLayer`): re-projects each scalar source under its exposed name alongside the folded eval (Splunk keeps the originals), deduping any source whose name a folded eval reassigns (the eval wins — flat duplicate aliases are silent-wrong). Non-scalar sources (`median`/`percentile` keyed objects, `uniques`/`values` lists) re-project in the wrong shape, so they stay dropped and the (narrowed) `eval_after_agg_drops_source` still warns for them.
- [ ] **Step 2: Update the NRQL reference — guarded.** First run `git status --porcelain .claude/references/nrql-reference.md`. If it shows **no** uncommitted changes, add to `.claude/references/nrql-reference.md`: the `*Of` fold-vs-pin split, the string-label return shapes, the 366-bucket cap, and `TIMESERIES MAX`. If it shows uncommitted changes (a parallel thread owns the file), **do not edit it** — note the pending addition in the PR description and hand the snippet to that thread instead.
- [ ] **Step 3: Delete the spec** and confirm nothing links to it: `grep -rn "2026-06-26-post-aggregation-grouping-gaps" docs .claude` should return only this plan. Remove `docs/superpowers/specs/2026-06-26-post-aggregation-grouping-gaps-design.md`.
- [ ] **Step 4: Commit.** (Markdown-only — no test run needed.)

---

## Global Verification

- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge` — translator suite green; all six new positive cases + negatives pass; no regressions.
- [ ] Fuzz loop ×20 clean: `for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npx vitest run spl-fuzz || break; done`.
- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check` — clean.
- [ ] No `npm run build:parsers` (no grammar change).
- [ ] CLI spot-checks (`ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "<q>"`): B → unsupported; C → unsupported; D1 → both-levels TIMESERIES, no `FACET _time`; D2 → `TIMESERIES MAX`; E `date_hour` → `FACET hourOf(timestamp)`, `date_month` → unsupported, `date_created` → plain `FACET date_created`; F `stats count by host | eval pct=count*100` → additive `count` + `pct`, no warning; `eval count=count*2` → one `count`.
- [ ] Staging re-validation (acct 10671289 `Transaction`, `run_nerdgraph_query`, short window) of the D1/D2/E/F happy-path NRQL before any human promotes past `verified: false`: D1 both-levels form returns one row per minute; D2 `TIMESERIES MAX` returns a bucketed series; E `FACET hourOf(timestamp)` returns hour labels; F additive form returns both `count` and `pct` columns.
- [ ] Open the PR (one PR, seven commits). Run `write-gooder` for the PR body; 100–200 words, summary + test plan.

## Self-Review (run before requesting review)

1. **Spec coverage:** all six gaps (B/C/D1/D2/E/F) have a task; each names its message key(s) and a negative control. The spec's "Notes for the implementation plan" items are resolved — C guards before the wrap (clean unsupported); D2 keeps `host` on the mixed-key case; E matches an exact closed set; F makes the eval fold additive for scalar sources (and supersedes C's drops-source-warning note by keeping scalar `count`, so C's `host2` stops warning).
2. **Loud-failure check:** every non-faithful path pushes `unsupported` (B, C, E-no-fold) or a warning for an unavoidable approximation (D2, E-fold); none emit compiling-but-wrong or parse-invalid NRQL.
3. **Blast-radius check:** B/C/E are gated on a marker or an exact name set (no effect on unrelated queries); D1 changes only the time-bucket-exempt fold branch; D2 is gated on non-subquery + `_time`/`timestamp` + no existing timeseries. D1↔D2 separation rests on the subquery guard — verify both in the same run.
4. **Message consistency:** five new keys (`dedup_between_aggregations`, `eval_shadows_facet_key`, `bare_time_facet_assumed_timeseries`, `date_field_label_shape`, `date_field_no_fold`), each referenced by a `cases` entry so the `spl.test.js` validation passes. F adds and removes no key — it **narrows** `eval_after_agg_drops_source` to non-scalar source drops (scalar-source cases stop firing it; median/percentile cases keep it).
5. **Verified levels:** all new cases `verified: false`; no `verified: 'human'` case touched.
6. **`warningFunc` exhaustiveness:** several cases carry the pre-existing `facet_default_limit` (and, until Task 6, C's `host2` negative carries `eval_after_agg_drops_source` — F then keeps the scalar `count`, so `host2` stops firing it and its `warningFunc` clears to `[]`; the key remains for non-scalar sources). Each task's green step matches `warningFunc` to the exact fired set rather than trusting the listed guess.

## PR breakdown

> Retrofit per CLAUDE.md "Small PRs" rule. Each PR below is independently reviewable and shippable; land in order.

1. **`dedup` between aggregations → unsupported (Task 1 / Gap B)** (~40 lines, behavior) — adds `dedup_between_aggregations` message key in `src/messages.js`, sets `ir._dedupBetweenAgg` in `handleDedup` (`src/input/spl/rowHandlers.js`) mirroring the existing `_headBetweenAgg` marker, consumes it in `handleStats` (`src/input/spl/aggregationHandlers.js`), plus the positive + negative-control `cases` in `test/spl/spl.test.js`. Dependency: independent.
2. **`eval` aliasing a facet key → unsupported (Task 2 / Gap C)** (~35 lines, behavior) — adds `eval_shadows_facet_key` message key and a pre-wrap guard in `handleEval`'s `if (ir._hasAggregation)` block (`src/input/spl/evalHandlers.js`) that bails loud on a `cmd.assignments` name colliding with an `ir.facet` key, plus positive + `host2` negative cases. Dependency: independent (its `host2` negative is later rewritten by PR 6).
3. **`_time` regroup over a TIMESERIES inner → outer TIMESERIES (Task 3 / Gap D1)** (~25 lines, behavior) — extends the `innerHasTimeseries` time-bucket-exempt branch in `foldPostAggregation.js` to strip the time-bucket key from the outer `ir.facet` and set the outer `ir.timeseries = collapsedInner.timeseries`, plus the positive (both-levels TIMESERIES) + scalar-collapse negative cases. Dependency: independent; must land before PR 4 so the D1↔D2 subquery-guard separation is testable together.
4. **Bare `stats … by _time` → `TIMESERIES MAX` + warning (Task 4 / Gap D2)** (~45 lines, behavior) — adds `bare_time_facet_assumed_timeseries` message key and a post-loop block in `src/input/spl/splToIR.js` (non-subquery + `_time`/`timestamp`/bin-alias, before the `facet_default_limit` check) that strips the key, sets `ir.timeseries='MAX'`, and warns, plus positive + the `bin`/`timechart` negative controls. Dependency: needs PR 3 (the subquery guard that keeps D2 off the D1 path is verified in the same run).
5. **`date_*` calendar group-by → `*Of(timestamp)` or unsupported (Task 5 / Gap E)** (~55 lines, behavior) — adds `date_field_label_shape` + `date_field_no_fold` message keys and replaces the group-by construction in `handleStats` (`src/input/spl/aggregationHandlers.js`) with the closed `FOLD` map / `NO_FOLD` set emitting `Func(fn, [Identifier('timestamp')])`, plus the five positive/unsupported cases + the `date_created` negative control. Dependency: independent.
6. **Additive eval-fold keeps scalar source aggregates (Task 6 / Gap F)** (~50 lines, behavior) — rewrites the `keptInner`/`dropped` block in `foldEvalLayer` (`src/ir/foldPostAggregation.js`) to re-alias and keep scalar aggregates (with overwrite dedupe vs `foldedNames`) while keeping non-scalar sources dropped, **narrows** (not deletes) `eval_after_agg_drops_source` in `src/messages.js`, audits the `orderByRefsDropped` guard, and updates the scalar-source test cases (additive `nrql`, cleared `warningFunc`) including PR 2's `host2` negative. Dependency: needs PR 2 (it rewrites PR 2's `host2` negative's expected `nrql`/`warningFunc`).
7. **Graduate invariants; update NRQL reference; retire spec (Task 7)** (~40 lines, docs) — folds the six invariants into `.claude/rules/design-decisions.md`, adds the fold-vs-pin / string-label / 366-bucket / `TIMESERIES MAX` facts to `.claude/references/nrql-reference.md` (guarded on a clean `git status` of that file), and deletes the design spec. Dependency: needs PRs 1–6 (graduates only invariants that exist in `src/`).
