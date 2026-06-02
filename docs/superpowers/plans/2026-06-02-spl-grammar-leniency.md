# SPL Grammar Leniency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SPL parser accept valid SPL it currently rejects, reclaiming the 292 corpus parse failures (45% from timechart alone) and lifting the clean-translate rate.

**Architecture:** Edit the Peggy grammar (`src/input/spl/spl.grammar`), regenerate the parser, and extend IR/emit only where a newly-parseable construct needs translation. One command per commit, frequency-ordered. A reusable diagnostic harness measures error-count reclaim after each commit.

**Tech Stack:** Peggy PEG grammar, ESM JavaScript, Vitest, Node 24 (`ASDF_NODEJS_VERSION=24.14.0`).

**Spec:** `docs/superpowers/specs/2026-06-02-spl-grammar-leniency-design.md`

---

## Conventions for every task

- **Node version:** prefix every `npm`/`node` command with `ASDF_NODEJS_VERSION=24.14.0`.
- **After ANY grammar edit:** run `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers` to regenerate `src/input/spl/splParser.js` BEFORE running tests. Tests import the generated parser, not the grammar.
- **Test location:** append cases to the `cases` array in `test/spl/spl.test.js`. Each case: `{ spl, nrql, warningFunc?, unsupportedFunc?, verified: false, doc }`. `warningFunc`/`unsupportedFunc` are arrays of message-key names from `src/messages.js` and are EXHAUSTIVE — list every message fn that fires, none that don't.
- **verified:** every new case is `verified: false`. Never promote (humans only).
- **Ad-hoc check:** `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "<query>"` prints NRQL + warnings/unsupported/errors for one query.
- **Commit format:** lowercase conventional-commit subject, ≤72 chars. Commit with `ASDF_NODEJS_VERSION=24.14.0 git commit`. Stage specific files (grammar, generated parser, handler, test) — not `-A`.
- **Regression gate before each commit:** run the diagnostic harness (Task 0). Error count must drop; clean/warnings must not drop. Any query going clean→error blocks the commit — investigate before proceeding.

---

## Task 0: Diagnostic harness (committed tool)

A reusable script that runs the whole corpus through the translator and reports the error-count + per-command attribution. Used as the regression gate after every later task.

**Files:**
- Create: `scripts/corpus-diagnostic.mjs`
- Modify: `package.json` (add `diag` script)

- [ ] **Step 1: Create the diagnostic script**

Create `scripts/corpus-diagnostic.mjs`:

```javascript
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { translateSplToNrql } from '../src/translate.js';

const corpusPath = path.join(import.meta.dirname, '..', 'test', 'spl', 'spl-real-world.json');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')).map((e) => e.spl);

function splitTopLevel(spl) {
  const segs = [];
  let depth = 0, inStr = null, cur = '';
  for (let k = 0; k < spl.length; k++) {
    const c = spl[k];
    if (inStr) { cur += c; if (c === inStr && spl[k - 1] !== '\\') inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (c === '|' && depth === 0) { segs.push(cur); cur = ''; continue; }
    cur += c;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

function leadKeyword(seg, isFirst) {
  const m = seg.match(/^([a-zA-Z_]+)/);
  if (isFirst && !/^\s*\|/.test(seg)) return 'search';
  return m ? m[1].toLowerCase() : '(other)';
}

const counters = { clean: 0, warningsOnly: 0, unsupported: 0, errors: 0, thrown: 0 };
const byKw = new Map();

for (let i = 0; i < corpus.length; i++) {
  let r;
  try { r = translateSplToNrql(corpus[i]); } catch { counters.thrown++; continue; }
  if (r.errors.length > 0) {
    counters.errors++;
    const segs = splitTopLevel(corpus[i]);
    let kw = '(whole-query-only)';
    for (let s = 0; s < segs.length; s++) {
      const isFirst = s === 0;
      const probe = isFirst ? segs[s] : `index=_probe | ${segs[s]}`;
      let pr;
      try { pr = translateSplToNrql(probe); } catch { pr = { errors: ['THROWN'] }; }
      if (pr.errors && pr.errors.length > 0) { kw = leadKeyword(segs[s], isFirst); break; }
    }
    byKw.set(kw, (byKw.get(kw) || 0) + 1);
  } else if (r.unsupported.length > 0) counters.unsupported++;
  else if (r.warnings.length > 0) counters.warningsOnly++;
  else counters.clean++;
}

const total = corpus.length;
const pct = (n) => ((n / total) * 100).toFixed(1) + '%';
console.log(`CORPUS (${total} queries)`);
console.log(`  clean:       ${counters.clean} (${pct(counters.clean)})`);
console.log(`  warningsOnly: ${counters.warningsOnly} (${pct(counters.warningsOnly)})`);
console.log(`  unsupported: ${counters.unsupported} (${pct(counters.unsupported)})`);
console.log(`  errors:      ${counters.errors} (${pct(counters.errors)})`);
console.log(`  thrown:      ${counters.thrown} (${pct(counters.thrown)})`);
console.log('\nERRORS BY ATTRIBUTED COMMAND:');
for (const [kw, n] of [...byKw.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${kw}`);
}
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add to `"scripts"`:

```json
"diag": "node scripts/corpus-diagnostic.mjs"
```

- [ ] **Step 3: Run it to capture the baseline**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run diag`
Expected: `errors: 292 (15.5%)`, top line of "ERRORS BY ATTRIBUTED COMMAND" is `132  timechart`. Record these numbers — they are the baseline for every later regression gate.

- [ ] **Step 4: Commit**

```bash
git add scripts/corpus-diagnostic.mjs package.json
ASDF_NODEJS_VERSION=24.14.0 git commit -m "chore: add corpus parse-failure diagnostic harness"
```

---

## Task 1: timechart — accept by-clause options (45% of failures)

Root cause: `by_field_list` consumes `limit`/`useother`/`usenull` as grouping
fields, so `by service limit=0` parses `service limit` as two fields then chokes
on `=`. Fix: a by-field is a `field_name` NOT immediately followed by `=`.
Verified end-to-end during planning: this single grammar change reclaims ~129 of
the 292 errors with no regression to multi-field `by a b`.

**Note:** `by_field_list` is shared by stats/timechart/eventstats/rare. This fix
correctly applies to all of them. The regression gate must confirm none regress.

**Files:**
- Modify: `src/input/spl/spl.grammar:158-160` (by_field_list)
- Regenerate: `src/input/spl/splParser.js` (via `npm run build:parsers`)
- Modify: `src/input/spl/aggregationHandlers.js:63-66` (handleTimechart — emit options)
- Test: `test/spl/spl.test.js` (append cases)

- [ ] **Step 1: Write failing tests**

Append to the `cases` array in `test/spl/spl.test.js`:

```javascript
  {
    spl: 'index=x | timechart span=1m count by service limit=0',
    nrql: "FROM Log SELECT count(*) WHERE index = 'x' FACET service TIMESERIES 1 minute LIMIT MAX",
    doc: 'timechart-by-options',
    verified: false,
  },
  {
    spl: 'index=x | timechart count by ua useother=false usenull=false limit=5',
    nrql: "FROM Log SELECT count(*) WHERE index = 'x' FACET ua TIMESERIES AUTO LIMIT 5",
    warningFunc: ['usenullNoEquivalent'],
    doc: 'timechart-by-options',
    verified: false,
  },
  {
    spl: 'index=x | stats count by host source',
    nrql: "FROM Log SELECT count(*) WHERE index = 'x' FACET host, source",
    doc: 'timechart-by-options-regression',
    verified: false,
  },
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: the two `timechart-by-options` cases FAIL (parse error). The
`timechart-by-options-regression` case PASSES already (proves we don't break it).

- [ ] **Step 3: Grammar fix — by_field_list**

In `src/input/spl/spl.grammar`, replace the `by_field_list` rule (lines 158-160):

```
by_field_list
  = first:by_field_item rest:((_* ',' _* / _+) name:by_field_item { return name; })*
    { return [first].concat(rest); }

// A by-field is a field name NOT immediately followed by '=' (which would make it
// a command option like limit=N / useother=false, not a grouping field).
by_field_item
  = name:field_name !(_* '=') { return name; }
```

- [ ] **Step 4: Regenerate the parser**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
Expected: no output errors; `src/input/spl/splParser.js` updated.

- [ ] **Step 5: Add the `usenullNoEquivalent` message**

In `src/messages.js`, add a warning message (follow the existing message-fn
pattern in that file — a function returning a string, registered in the catalog):

```javascript
  usenullNoEquivalent: () =>
    'Splunk timechart usenull option has no NRQL equivalent; null groups are included',
```

- [ ] **Step 6: Emit step — handleTimechart consumes options**

In `src/input/spl/aggregationHandlers.js`, replace `handleTimechart` (lines 63-66):

```javascript
export function handleTimechart(cmd, ir) {
  handleStats(cmd, ir);
  ir.timeseries = cmd.span ? formatSpan(cmd.span) : 'AUTO';
  for (const opt of cmd.options || []) {
    if (opt.type === 'limit') {
      ir.limit = opt.value === 0 ? 'MAX' : opt.value;
    } else if (opt.type === 'usenull') {
      ir.warnings.push(messages.usenullNoEquivalent());
    }
    // useother=false is a no-op: NRQL never synthesizes an OTHER bucket.
  }
}
```

Confirm `messages` is imported at the top of `aggregationHandlers.js`; if not, add
`import { messages } from '../../messages.js';` (match the existing import path
style in sibling handler files).

Confirm the emitter renders `ir.limit === 'MAX'` as `LIMIT MAX`. Check
`src/output/nrql/irToNrql.js:277-278` — it currently does `LIMIT ${q.limit}`, which
yields `LIMIT MAX` for the string `'MAX'` and `LIMIT 5` for the number. No emitter
change needed.

- [ ] **Step 7: Run tests, verify they pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: all three new cases PASS. Full suite still green.

- [ ] **Step 8: Regression gate — diagnostic**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run diag`
Expected: `errors` dropped from 292 to ~163 (timechart no longer the top bucket).
clean/warnings did not drop. No new command appears with MORE failures than
baseline. If any regression, STOP and investigate before committing.

- [ ] **Step 9: Lint + types**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/input/spl/spl.grammar src/input/spl/splParser.js \
        src/input/spl/aggregationHandlers.js src/messages.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "fix: parse timechart by-clause options (limit/useother/usenull)"
```

---

## Task 2: top — multi-field parse (percent ALREADY works)

Failures: 27. **Verified during review:** the percent column ALREADY emits correctly
as a WHERE-matched subquery — `top limit=5 host` →
`FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*) WHERE index = 'x') AS 'percent' WHERE index = 'x' FACET host ORDER BY count DESC LIMIT 5`.
So this task is NOT about percent. The only gap: the `top_command` rule
(`spl.grammar:393-394`) takes a SINGLE `field:field_name`, so `top a, b`
(multi-field) and `top limit=10 a, b` fail to parse. `Top` (capital) is already
`'top'i` — verify it works and add no case-fix if so. The emit just needs to FACET
all listed fields; the existing percent-subquery wiring already threads `ir.where`.

**Files:**
- Modify: `src/input/spl/spl.grammar:393-406` (top_command — multi-field)
- Regenerate: `src/input/spl/splParser.js`
- Modify: the top handler (find via `grep -rn "TopCommand" src/input/spl/*.js`)
- Test: `test/spl/spl.test.js`

- [ ] **Step 1: Reproduce the failures**

Run each and confirm a parse error:
```
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'index=x | top cs_user_agent, sc_status'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'index=x | top limit=10 a, b, c'
```
Confirm whether bare `Top` (capital) already works: `node bin/spl2nrql.js 'index=x | Top a'`. If it works, no case-fix needed.

- [ ] **Step 2: Write failing tests**

Append to `cases` in `test/spl/spl.test.js`:

```javascript
  {
    spl: 'index=x | top limit=10 cs_user_agent, sc_status',
    nrql: "FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*) WHERE index = 'x') AS 'percent' WHERE index = 'x' FACET cs_user_agent, sc_status ORDER BY count DESC LIMIT 10",
    doc: 'top-multifield',
    verified: false,
  },
```

Note: the form above mirrors the ACTUAL single-field emitter output observed in
review (subquery is `(FROM Log SELECT count(*) ...)`, not `(SELECT count(*) FROM
Log ...)`; only `percent` is aliased, `count` is bare; `ORDER BY count DESC`
present). After implementing multi-field, run the ad-hoc CLI to get the EXACT
output string and paste it into `nrql:` — do not hand-write it.

- [ ] **Step 3: Run tests, verify fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: the `top-multifield` case FAILS (parse error).

- [ ] **Step 4: Grammar fix — multi-field top**

In `src/input/spl/spl.grammar`, change `top_command` (line 394) so the single
`field:field_name` becomes a comma/space-separated `field_list`. Replace:

```
top_command
  = 'top'i _+ opts:top_options fields:field_list limit:(_+ 'limit'i '=' n:[0-9]+ { return parseInt(n.join(''), 10); })? by:by_clause?
    {
      return {
        type: 'TopCommand',
        count: opts.limit !== null ? opts.limit : (limit !== null && limit !== undefined ? limit : 10),
        fields: fields,
        groupBy: by || [],
        countfield: opts.countfield || null,
        percentfield: opts.percentfield || null,
        useother: opts.useother || false,
        showperc: opts.showperc !== null ? opts.showperc : true
      };
    }
```

Note the field is now `fields` (array). The handler in Step 6 must consume
`cmd.fields` instead of `cmd.field`.

- [ ] **Step 5: Regenerate the parser**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`

- [ ] **Step 6: Emit step — handler consumes fields + percent**

Read the current top handler (`grep -rn "TopCommand\|cmd.field" src/input/spl/*.js`).
The percent subquery (inner `(FROM Log SELECT count(*) <WHERE>)` carrying the outer
`ir.where`) ALREADY works for single-field top — do not rebuild it. The only change:
make the handler FACET ALL of `cmd.fields` (the array introduced in Step 4) instead
of the single `cmd.field`, and keep `ir.limit = cmd.count`. The existing percent
wiring is field-count-agnostic, so multi-field should "just work" once FACET takes
the array. Capture the exact NRQL via the CLI and update the test's `nrql:` string
to match (expect the `(FROM Log SELECT count(*) WHERE ...)` subquery form, `'percent'`
aliased, `ORDER BY count DESC`).

- [ ] **Step 7: Run tests, verify pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: new case PASSES, full suite green.

- [ ] **Step 8: Regression gate**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run diag`
Expected: `top` bucket drops toward 0; errors total drops by ~27; nothing regresses.

- [ ] **Step 9: Lint + types + commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check
git add src/input/spl/spl.grammar src/input/spl/splParser.js src/input/spl/*Handlers.js src/messages.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "fix: parse multi-field top with limit; emit percent column"
```

---

## Task 3: bin — accept `as` alias

Failures: 20. Cause: `bin_command` (`spl.grammar:670-680`) has no `as_clause`.
`bin span=1m _time as min` fails at `as`. **Guardrail (SPL expert):** `as min` is a
field RENAME, not the `min()` function — the grammar's `as_clause` already handles
quoted/bare aliases, so reuse it; do not introduce a path that resolves `min` as an
aggregation.

**Files:**
- Modify: `src/input/spl/spl.grammar` (bin_command, ~lines 670-690)
- Regenerate: `src/input/spl/splParser.js`
- Modify: the bin handler (`grep -rn "BinCommand\|'bin'" src/input/spl/*.js`)
- Test: `test/spl/spl.test.js`

- [ ] **Step 1: Reproduce**

Run: `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'index=x | bin span=1m _time as min | stats count by min'`
Confirm parse error at `as`.

- [ ] **Step 2: Write failing test**

Append to `cases`:

```javascript
  {
    spl: 'index=x | bin span=1m _time as min | stats count by min',
    nrql: "FROM Log SELECT count(*) WHERE index = 'x' TIMESERIES 1 minute",
    doc: 'bin-as-alias',
    verified: false,
  },
```

Note: per spec, the alias is dropped and the bin maps to `TIMESERIES`. Confirm the
exact NRQL via CLI after implementing and update `nrql:` to match. If the `min`
alias is referenced later in a way the translator cannot map to the time bucket,
the correct result is `unsupported` (loud failure) — adjust the test accordingly.

- [ ] **Step 3: Run test, verify fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`

- [ ] **Step 4: Grammar fix**

In `src/input/spl/spl.grammar`, add an optional `as_clause` to BOTH bin/bucket
productions (the `span=` first and `span=` last forms). Append `alias:as_clause?`
after the `field:field_name` in each, and include `alias: alias || null` in the
returned node.

- [ ] **Step 5: Regenerate parser**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`

- [ ] **Step 6: Emit step**

In the bin handler, accept the new `alias` property. The bin still sets
`ir.timeseries` from the span; the alias is recorded but not emitted (NRQL has no
named-time-bucket field). If later commands reference the alias as the time field,
that already flows through `TIMESERIES`; if referenced as a non-time field, push
`unsupported`.

- [ ] **Step 7: Run tests, verify pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`

- [ ] **Step 8: Regression gate + lint + types + commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 npm run diag    # bin bucket → ~0, errors -~20
ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check
git add src/input/spl/spl.grammar src/input/spl/splParser.js src/input/spl/*Handlers.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "fix: parse bin/bucket as-alias"
```

---

## Task 4: sort — space-after-sign, limit=N, multi-key, type hints

Failures: 19. Causes in `sort_command` (`spl.grammar:331-363`): (a) `sort_field`
allows `dir:[-+]?` then `_*` then name, so `sort - field` (space) may already work —
verify; (b) trailing `limit=N` not accepted (only leading numeric `sort_limit`);
(c) type-hint wrappers `num()/str()/ip()` around the field not accepted.

**Guardrail (SPL expert):** `-` applies only to the immediately-following field, so
`sort -aaa username` = `aaa` DESC + `username` ASC. Multi-key already supported via
`sort_field_list`; NRQL ORDER BY is single-field so 2nd+ key → existing warning.

**Verified during review:** `sort 0 host` already correctly emits NO limit
(`ORDER BY host ASC`) — the leading-`0` = unlimited case is handled; do not regress
it. A trailing `desc`/`asc` keyword can co-occur with a leading `-`/`+`
(`sort -field desc`); the existing `sort_order` rule lets the keyword override the
sign — add a test to lock this behavior.

**Files:**
- Modify: `src/input/spl/spl.grammar:331-363` (sort_command, sort_field)
- Regenerate: `src/input/spl/splParser.js`
- Modify: sort handler if needed (`grep -rn "SortCommand" src/input/spl/*.js`)
- Test: `test/spl/spl.test.js`

- [ ] **Step 1: Reproduce each**

```
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'index=x | sort - time_taken limit=10'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'index=x | sort -aaa username'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'index=x | sort num(duration)'
```
Record which fail and the exact error column.

- [ ] **Step 2: Write failing tests**

Append to `cases` (adjust `nrql` to actual emitter output after implementing; the
multi-key one should warn the 2nd key is dropped — find the existing message key
via `grep -rn "ORDER BY supports only one" src/messages.js`):

```javascript
  {
    spl: 'index=x | sort - time_taken limit=10',
    nrql: "FROM Log SELECT * WHERE index = 'x' ORDER BY time_taken DESC LIMIT 10",
    doc: 'sort-leniency',
    verified: false,
  },
  {
    spl: 'index=x | sort num(duration)',
    nrql: "FROM Log SELECT * WHERE index = 'x' ORDER BY duration",
    doc: 'sort-typehint',
    verified: false,
  },
```

- [ ] **Step 3: Run tests, verify fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`

- [ ] **Step 4: Grammar fix**

In `sort_command` (line 332), accept a trailing `limit=N` option after the field
list: add `limit2:(_+ 'limit'i '=' n:[0-9]+ { return parseInt(n.join(''),10); })?`
and prefer it over the leading `sort_limit` in the returned `limit`. In `sort_field`
(line 349-359), wrap the field matcher to optionally strip a `num(...)`/`str(...)`/
`ip(...)` type-hint: match `('num'i/'str'i/'ip'i) '(' name:field_name ')'` OR a bare
`field_name`. Keep `dir:[-+]?` applying only to the current field.

- [ ] **Step 5: Regenerate parser**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`

- [ ] **Step 6: Emit — confirm handler**

The sort handler already maps fields→ORDER BY and warns on extra keys. Confirm
`limit` flows to `ir.limit` and type-hint-stripped fields emit the bare field name.
No new message expected unless a multi-key case is added.

- [ ] **Step 7: Run tests, verify pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`

- [ ] **Step 8: Regression gate + lint + types + commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 npm run diag    # sort bucket → ~0, errors -~19
ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check
git add src/input/spl/spl.grammar src/input/spl/splParser.js src/input/spl/*Handlers.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "fix: parse sort space-sign, trailing limit, type hints"
```

---

## Task 5: where — `!` negation, leading-dot decimals, mvcount

Failures: 18. Causes in the `where_*` expression rules (`spl.grammar:228+`):
(a) `!` not accepted as NOT; (b) number-literal rule requires a leading digit, so
`.25` fails; (c) some multivalue funcs (`mvcount`) not resolved in where.

**Emit (verified against the live codebase during review):**
- `!(match(f,"re"))` → `NOT (f RLIKE 're')`. NRQL supports `NOT (...)`; use `RLIKE`
  for `match()` (regex), NOT `LIKE`.
- **`where`-after-`stats` does NOT emit HAVING.** The emitter (`irToNrql.js`) has
  zero HAVING support. `handleWhere` calls `wrapAsSubquery` when the upstream has an
  aggregation, so a `where count > 5` after `stats` emits a SUBQUERY:
  `FROM (FROM Log SELECT count(*) WHERE index = 'x' FACET f LIMIT MAX) SELECT * WHERE numeric(count) > 5`.
  Any test asserting HAVING is wrong.
- **Leading-dot decimal is a real EMIT BUG, not just a parse gap.** Today
  `where .25 > count` (after stats) emits `WHERE \`.25\` > 'count'` — the `.25` is
  wrongly backticked as an ATTRIBUTE and `count` becomes a STRING literal. Compare
  the correct `where count > 5` → `WHERE numeric(count) > 5`. So the fix must (i)
  let the number-literal rule match `.25` AND (ii) ensure the where-expression
  treats a leading-dot token as a NUMBER literal, not an identifier. After the fix,
  `.25` must emit as the numeric literal `.25` (or `0.25`), and the field on the
  other side must be treated as a field, not a string.

**Files:**
- Modify: `src/input/spl/spl.grammar` (where expression: NOT, number literal, funcs)
- Regenerate: `src/input/spl/splParser.js`
- Modify: where/eval handler + expr utils (`evalHandlers.js`, `splExprUtils.js`) for
  the leading-dot literal classification and any missing func mapping
- Test: `test/spl/spl.test.js`

- [ ] **Step 1: Reproduce each, recording the ACTUAL wrong output**

```
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'index=x | where !(match(f,"^SYS"))'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'index=x | stats count by f | where .25 > count'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'index=x | where mvcount(f) > 1'
```
The `!(match(...))` and `mvcount` cases error (parse). The `.25` case PARSES but
emits the WRONG NRQL (`WHERE \`.25\` > 'count'`) — capture it; this is the bug to
fix, not just a parse gap.

- [ ] **Step 2: Write failing tests (correct expected output)**

Append to `cases`. For the leading-dot case, assert the SUBQUERY shape (NOT HAVING),
with `.25` as a numeric literal and `count` as a field. Capture the EXACT post-fix
string via CLI before finalizing — the form below is the target shape, verify
byte-for-byte:

```javascript
  {
    spl: 'index=x | where !(match(f,"^SYS"))',
    nrql: "FROM Log SELECT * WHERE index = 'x' AND NOT (f RLIKE '^SYS')",
    doc: 'where-bang-negation',
    verified: false,
  },
  {
    spl: 'index=x | stats count by f | where .25 > count',
    nrql: "FROM (FROM Log SELECT count(*) WHERE index = 'x' FACET f LIMIT MAX) SELECT * WHERE .25 > numeric(count)",
    doc: 'where-leading-dot-decimal',
    verified: false,
  },
```

The leading-dot test is the regression guard for the emit bug: it must show `.25`
as a number and `count` as a field, NOT `` `.25` > 'count' ``.

- [ ] **Step 3: Run tests, verify fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test`
Expected: both new cases FAIL (the bang/mvcount on parse error, the leading-dot on
wrong NRQL).

- [ ] **Step 4: Grammar fix (with the `!=` guardrail)**

In the where-expression rules:
(a) **NOT via `!`** — add a `'!' _* operand` production in the where-NOT rule,
   producing the same node as the `NOT` keyword. **GUARDRAIL (SPL expert):** the
   `!=` comparison operator MUST be tried BEFORE the bare-`!`-NOT rule, and bare `!`
   must only match when followed by `(` or whitespace+expr — never when followed by
   `=`. Otherwise `where x != 5` mis-parses as `!(x = 5)`.
(b) **leading-dot literal** — extend the where number-literal rule to accept
   `'.' [0-9]+` in addition to `[0-9]+ ('.' [0-9]+)?`. The current
   `eval_number` (grammar ~line 586) requires a leading digit.
(c) **mvcount + siblings** — ensure they resolve in `src/input/spl/splExprUtils.js`
   `resolveEvalFunc`.

- [ ] **Step 5: Regenerate parser**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`

- [ ] **Step 6: Emit fix — leading-dot literal classification**

The parse fix alone is not enough: the where-expression evaluator must classify a
leading-dot token as a NUMBER, so the comparison builder treats the other operand as
a field (emitting `numeric(count)`), not flips them. Trace `where .25 > count`
through `handleWhere` (`evalHandlers.js`) and the comparison builder in
`splExprUtils.js`; ensure the number-vs-identifier branch sees `.25` as numeric.
Confirm `!`-NOT emits `NOT (...)` and `match()` emits `RLIKE`.

- [ ] **Step 7: Run tests + the `!=` regression check**

```
ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl.test
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'index=x | where count != 5'   # must stay != , NOT !(count=5)
```
Expected: new cases pass; `count != 5` still emits a `!=` comparison.

- [ ] **Step 8: Regression gate + lint + types + commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 npm run diag    # where bucket → ~0, errors -~18
ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check
git add src/input/spl/spl.grammar src/input/spl/splParser.js src/input/spl/*.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "fix: parse where bang-negation, leading-dot decimals, mvcount"
```

---

## Task 6: tokenizer leniency — separators, quote-boundary, empty items

Failures: the long tail (~37) across stats/join/eval/fields/lookup/chart/spath/rex/
table plus the 4 expert-confirmed tokenizer cases. Fix per-construct; the unifying
rules are the four below. **Run the diagnostic first** to see the exact remaining
buckets after Tasks 1-5 — the long tail will have shifted.

**Guardrails (SPL expert — do NOT violate):**
1. Comma/space/empty separator leniency applies to ALL list-context field rules
   (stats/top/fields/by/IN, and also dedup/fillnull/strcat which share `field_list`)
   EXCEPT `rename` pairs (space-separated; a comma breaks AS-pairing) and `eval`
   comma-chained assignments (commas separate assignments). It is NOT a closed
   whitelist — it's "all list rules minus rename/eval". If implemented at the shared
   `field_list` rule, dedup/fillnull/strcat are covered automatically — that's fine.
2. Quote-as-token-boundary (`"x"field` → two ANDed terms) is SEARCH-CONTEXT ONLY.
   Do not apply in eval/where (a closing quote there is a string terminator).
3. **IN-list space separator** (`IN ("a" "b", "c")`): the current `in_value` bare
   branch already stops at whitespace, so adding whitespace as a separator yields
   correct multi-value splitting — but spot-check it does NOT split a single intended
   value that contains internal whitespace. Add a test with both a space-separated
   and a comma-separated IN list and confirm identical multi-value results.

**Files:** `src/input/spl/spl.grammar` (search-clause tokenizer, IN list, field_list
empty-item tolerance), regenerate parser, `test/spl/spl.test.js`.

- [ ] **Step 1: Re-run diagnostic to get the current long tail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run diag`
List every remaining `ERRORS BY ATTRIBUTED COMMAND` bucket. These are the targets.

- [ ] **Step 2: Per-construct loop (repeat for each remaining bucket)**

For each remaining failing construct, in order of frequency:
  a. Reproduce via `node bin/spl2nrql.js "<corpus query>"`; note the error column.
  b. Confirm with the spl-expert (already consulted; re-ask only for NEW constructs
     not covered in the spec) that the SPL is valid.
  c. Write a `verified: false` failing test case in `cases` (real corpus query).
  d. Run the suite, confirm it fails.
  e. Make the smallest grammar change; `npm run build:parsers`.
  f. Run the suite, confirm it passes; confirm no guardrail (rename/eval/where)
     regressed by spot-checking: `node bin/spl2nrql.js 'index=x | rename a AS b c AS d'`
     and `node bin/spl2nrql.js 'index=x | eval a=1, b=2'`.
  g. Run `npm run diag`; confirm the bucket shrank and nothing regressed.

- [ ] **Step 3: Tokenizer cases — explicit tests**

Add `verified: false` cases for the four confirmed cases (set `nrql` from CLI):

```javascript
  {
    spl: 'index=x | table, _time, host',
    nrql: "FROM Log SELECT _time, host WHERE index = 'x'",
    doc: 'tokenizer-empty-list-item',
    verified: false,
  },
  {
    spl: 'index=x f IN ("a" "b", "c")',
    nrql: "FROM Log SELECT * WHERE index = 'x' AND f IN ('a', 'b', 'c')",
    doc: 'tokenizer-in-space-separated',
    verified: false,
  },
```

The quote-boundary cases (`"x"field`) are search-context only — add a case AND a
regression case proving a normal spaced search still parses identically.

- [ ] **Step 4: Final regression gate + lint + types + commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 npm run diag    # errors at new floor; record final number
ASDF_NODEJS_VERSION=24.14.0 npm run test
ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check
git add src/input/spl/spl.grammar src/input/spl/splParser.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "fix: tokenizer leniency for separators and quote boundaries"
```

---

## Final verification (after all tasks)

- [ ] Run `ASDF_NODEJS_VERSION=24.14.0 npm run diag` and compare to the Task 0
  baseline. Errors must be substantially down (from 292); clean + warnings up;
  unsupported roughly stable or up (some newly-parsed queries hit real NRQL gaps and
  become honest `unsupported` — that is correct, not a regression).
- [ ] Run the full suite once more: `ASDF_NODEJS_VERSION=24.14.0 npm run test`. Green.
- [ ] Confirm zero `verified` promotions occurred (all new cases `verified: false`).
- [ ] Spot-check guardrails one final time: `rename a AS b c AS d`, `eval a=1, b=2`,
  and a normal spaced search all parse unchanged.
