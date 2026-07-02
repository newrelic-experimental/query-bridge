# strftime/strptime → toDatetime/toTimestamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate SPL `eval … = strftime(epoch, fmt)` / `strptime(str, fmt)` to NRQL `toDatetime(epoch, javaFmt)` / `toTimestamp(str, javaFmt)`, converting the Splunk `%`-code format to a Java `DateTimeFormatter` pattern, emitting `unsupported` only for `%`-codes with no Java equivalent.

**Architecture:** A pure converter `splFormatToJava(fmt) → {pattern, unmappable}` (new file) does the format-code mapping and literal-escaping. Two new `case`s in the `evalHandlers.js` eval-function `switch` consume it: map fully, emit the `Func`; if any code is unmappable, emit `unsupported`. `strptime` divides by 1000 (NRQL `toTimestamp` returns ms; Splunk `strptime` returns seconds). `_time`→`timestamp` is already handled by `walkEvalExpr`.

**Tech Stack:** Pure ESM JavaScript; IR node factories in `src/ir/nodes.js` (`Func`, `Literal`, `BinOp`); message catalog in `src/messages.js`; Vitest (unit tests + the data-driven `cases` array in `test/spl/spl.test.js`).

**Branch:** `feat/strftime-strptime` off `origin/master`. Spec: `docs/superpowers/specs/2026-06-27-strftime-strptime-design.md`.

## Global Constraints

- Dev requires **Node 24**: prefix every command `ASDF_NODEJS_VERSION=24.14.0` (hooks + commit need it).
- Run one package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- <filter>`.
- Conventional commits, lowercase subject ≤72 chars, body lines ≤100. `git commit -F <file>` for multi-line bodies. `git push origin HEAD` (never bare, never to master).
- **Loud failure over silent-wrong:** any format with an unmappable code → `messages.*` unsupported, never a partial/garbage format string.
- Messages live in `src/messages.js`; handlers call `messages.key()` — no inline strings. The spy loop in `test/spl/spl.test.js` enforces that every key in a test's `unsupportedFunc`/`warningFunc` array exists and is exhaustive. (There is NO `test/messages.test.js` — that file does not exist in this repo; key enforcement lives entirely in `spl.test.js`.)
- New/changed translations land at `verified: false` (a human promotes to `'llm'`/`'human'` later).
- **Value-level tests required:** a wrong format string returns garbage with NO NRQL error (`toDatetime(timestamp,'%Y-%m-%d')` → `"%2026-%12-%28"`, live-verified). `toDatetime`/`toTimestamp` are in the `execute_nrql_query` false-reject set, so staging-validate via `run_nerdgraph_query` and assert the EXPECTED VALUE.

## Decided (2026-06-28) — non-`_time` strftime epoch units: emit raw + warn (A)

Splunk `strftime` **requires its input epoch in seconds** ([Splunk DateandTimeFunctions docs](https://docs.splunk.com/Documentation/Splunk/latest/SearchReference/DateandTimeFunctions): "The UNIX time must be in seconds"; `_time` is stored in UNIX seconds). NRQL `toDatetime` expects **milliseconds**. So:

- **`strftime(_time, …)` → `toDatetime(timestamp, …)` is correct** — `_time`→`timestamp` is a FIELD substitution onto NR's native ms `timestamp`, not a value carry (verified: ms `timestamp` formats to the right wall-clock). No multiply.
- **`strftime(<non-_time field>, …)` is the fork.** The source field held seconds (Splunk required it), so feeding it raw to a ms-expecting `toDatetime` is **likely 1000× wrong (a 1970 date)**. Options:
  - **(A) emit raw + warn** (`strftime_epoch_units_warning`) — likely-wrong output, warned. This is the spec-approved decision #4 and what the plan currently encodes.
  - **(B) emit `toDatetime(field * 1000, …)` + warn** — faithful to Splunk's seconds requirement, warned about the assumption. **Recommended** given the doc evidence; risk is the field *might* have been re-ingested into NR as ms (translator has no storage-unit context).
  - **(C) `unsupported`** — strictest loud-failure; loses an otherwise-translatable panel.

**Decided 2026-06-28: option (A) — emit raw + warn.** The plan encodes this; Task 2's 4th test stands as written. (`_time` itself is unaffected — always correct, no multiply.) Knowingly best-effort-and-warned, not silent: the doc shows the source field is seconds, so a seconds field yields a 1970 date — the warning is the loud signal. Revisit if corpus shows the 1000× confusion is common.

## File Structure

- **Create** `src/input/spl/splFormatCodes.js` — the pure `splFormatToJava(fmt)` converter + its `%`-code table. One responsibility: Splunk `%`-format → Java pattern. No IR, no messages.
- **Create** `test/spl/splFormatCodes.test.js` — explicit unit tests for the converter (one scenario per `it()`, per project test-authoring style; NOT a fixture loop).
- **Modify** `src/input/spl/evalHandlers.js` — add `case 'strftime'` / `case 'strptime'` to the eval-function `switch` (next to the `spath` case ~line 609); import `splFormatToJava`.
- **Modify** `src/messages.js` — add `strftime_unmappable_code`, `strptime_units_warning`, `strftime_epoch_units_warning`.
- **Modify** `test/spl/spl.test.js` — data-driven `cases` for the translation behavior.
- **Modify (Task 3 only)** `src/ir/foldPostAggregation.js` — possibly add `toDatetime`/`toTimestamp` to `FOLD_SAFE_FUNCS`.

---

### Task 1: `splFormatToJava` converter + unit tests (inert)

**Files:**
- Create: `src/input/spl/splFormatCodes.js`
- Test: `test/spl/splFormatCodes.test.js`

**Interfaces:**
- Produces: `splFormatToJava(fmt: string) → { pattern: string, unmappable: string[] }`. `pattern` is the Java `DateTimeFormatter` string (literal letters quoted); `unmappable` lists every `%`-code with no Java equivalent (e.g. `['%s','%c']`), empty when all map.

- [ ] **Step 1: Write the failing unit tests** in `test/spl/splFormatCodes.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { splFormatToJava } from '../../src/input/spl/splFormatCodes.js';

describe('splFormatToJava', () => {
  it('maps the core date codes', () => {
    expect(splFormatToJava('%Y-%m-%d').pattern).toBe('yyyy-MM-dd');
  });
  it('maps the core time codes', () => {
    expect(splFormatToJava('%H:%M:%S').pattern).toBe('HH:mm:ss');
  });
  it('maps the long tail (DDD/zzz/Z/yy/MMMM/EEEE/a)', () => {
    expect(splFormatToJava('%j %Z %z %y %B %A %p').pattern).toBe(
      'DDD zzz Z yy MMMM EEEE a',
    );
  });
  it('maps sub-second width variants', () => {
    expect(splFormatToJava('%H:%M:%S.%3N').pattern).toBe('HH:mm:ss.SSS');
    expect(splFormatToJava('%6N').pattern).toBe('SSSSSS');
    expect(splFormatToJava('%9N').pattern).toBe('SSSSSSSSS');
    expect(splFormatToJava('%N').pattern).toBe('SSSSSSSSS'); // bare = nanos
  });
  it('treats %% as a literal percent', () => {
    expect(splFormatToJava('%Y%%').pattern).toBe("yyyy'%'");
  });
  it('quotes literal letters so they are not pattern tokens', () => {
    expect(splFormatToJava('%Y GMT').pattern).toBe("yyyy 'GMT'");
  });
  it('passes non-letter literals through unquoted', () => {
    expect(splFormatToJava('%Y/%m').pattern).toBe('yyyy/MM');
  });
  it('escapes a literal single quote as two single quotes', () => {
    expect(splFormatToJava("%H o'clock").pattern).toBe("HH 'o''clock'");
  });
  it('collects unmappable codes and still returns a (partial) pattern', () => {
    const r = splFormatToJava('%Y %s %c');
    expect(r.unmappable).toEqual(['%s', '%c']);
  });
  it('reports no unmappable codes for a fully-mapped format', () => {
    expect(splFormatToJava('%Y-%m-%d %H:%M:%S').unmappable).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- splFormatCodes`
  Expected: FAIL — `splFormatToJava` is not defined / module missing.

- [ ] **Step 3: Implement** `src/input/spl/splFormatCodes.js`:

```javascript
// Splunk strftime %-code → Java DateTimeFormatter pattern letters.
// Verified on staging acct 1 (2026-06-27/28). Sub-second %N-family and %%
// are handled in code below, not in this table.
const SPL_TO_JAVA = {
  Y: 'yyyy', y: 'yy', m: 'MM', d: 'dd', j: 'DDD',
  b: 'MMM', h: 'MMM', B: 'MMMM', Z: 'zzz',
  H: 'HH', I: 'hh', M: 'mm', S: 'ss', p: 'a',
  a: 'EEE', A: 'EEEE', z: 'Z',
};

/**
 * Convert a Splunk strftime %-format to a Java DateTimeFormatter pattern.
 * @param {string} fmt
 * @returns {{ pattern: string, unmappable: string[] }}
 */
export function splFormatToJava(fmt) {
  const parts = []; // { token: string } | { literal: string }
  const unmappable = [];
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === '%') {
      // Sub-second: %3N / %6N / %9N, and bare %N (Splunk default = nanoseconds).
      const sub = fmt.slice(i).match(/^%([369]?)N/);
      if (sub) {
        const w = sub[1];
        parts.push({ token: w === '3' ? 'SSS' : w === '6' ? 'SSSSSS' : 'SSSSSSSSS' });
        i += sub[0].length;
        continue;
      }
      const code = fmt[i + 1];
      if (code === '%') { parts.push({ literal: '%' }); i += 2; continue; }
      if (code === undefined) { parts.push({ literal: '%' }); i += 1; continue; }
      const java = SPL_TO_JAVA[code];
      if (java) { parts.push({ token: java }); i += 2; continue; }
      unmappable.push('%' + code); // leave it out of the pattern; caller rejects
      i += 2;
      continue;
    }
    parts.push({ literal: fmt[i] });
    i += 1;
  }
  // Assemble: tokens emit raw. In literal text, quote each maximal run of
  // pattern-significant chars — letters (DateTimeFormatter reserves a-zA-Z) and
  // '%' (so no bare % ever survives; a stray % is the silent-garbage signature,
  // e.g. '%Y' renders "%2026") — doubling any embedded ' (Java's literal-quote
  // escape, so o'clock -> 'o''clock'). Whitespace/punctuation pass through bare.
  // (A lone ' wedged between two codes is out of scope — no corpus demand.)
  let pattern = '';
  let lit = '';
  const flushLit = () => {
    if (!lit) return;
    pattern += lit.replace(/[A-Za-z%']+/g, (run) => "'" + run.replace(/'/g, "''") + "'");
    lit = '';
  };
  for (const p of parts) {
    if (p.literal !== undefined) lit += p.literal;
    else { flushLit(); pattern += p.token; }
  }
  flushLit();
  return { pattern, unmappable };
}
```

- [ ] **Step 4: Run, confirm green** (same command). All `splFormatToJava` tests pass.

- [ ] **Step 5: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/splFormatCodes.js packages/nr-query-bridge/test/spl/splFormatCodes.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: add splFormatToJava strftime format converter (inert)"
```

---

### Task 2: Wire strftime/strptime into the eval-function switch + messages

**Files:**
- Modify: `src/input/spl/evalHandlers.js` — add `case 'strftime'` / `case 'strptime'` to `walkEvalFunc`'s `switch (name)` (the function at line 275; place the cases next to the `spath` case ~609); add `splFormatToJava` to the imports from `./splFormatCodes.js`.
- Modify: `src/messages.js` — add three message keys.
- Test: `test/spl/spl.test.js` (data-driven `cases`; its spy loop also validates message-key existence/exhaustiveness — there is no separate `test/messages.test.js`).

**Interfaces:**
- Consumes: `splFormatToJava(fmt) → {pattern, unmappable}` (Task 1); `Func(name, args)`, `Literal(value, kind)`, `BinOp(op, left, right)` from `src/ir/nodes.js`; `walkEvalFunc(node, ir)` reads `name` (lowercased) and `args` (raw AST arg nodes); `walkEvalExpr(args[0], ir)` maps `_time`→`Identifier('timestamp')` automatically.

**Behavior (from the spec):** `strftime(epoch, fmt)` → `toDatetime(epoch, javaFmt)`; `strptime(str, fmt)` → `toTimestamp(str, javaFmt) / 1000` (NRQL `toTimestamp` returns ms, Splunk `strptime` returns seconds — divide always, to match Splunk). Any unmappable `%`-code → `unsupported` (whole function, never a partial format). A non-`_time` epoch arg to `strftime` → warn (unit unknown). `strptime` → always warn (ms→s).

- [ ] **Step 1: Add failing data-driven `cases`** to the `cases` array in `test/spl/spl.test.js`:

```javascript
{
  spl: '* | eval d = strftime(_time, "%Y-%m-%d")',
  nrql: "FROM Log WITH toDatetime(timestamp, 'yyyy-MM-dd') AS d SELECT *",
  doc: 'strftime-strptime', verified: false,
},
{
  spl: '* | eval t = strptime(ds, "%Y-%m-%d %H:%M:%S")',
  nrql: "FROM Log WITH toTimestamp(ds, 'yyyy-MM-dd HH:mm:ss') / 1000 AS t SELECT *",
  warningFunc: ['strptime_units_warning'],
  doc: 'strftime-strptime', verified: false,
},
{
  spl: '* | eval x = strftime(_time, "%s")',
  unsupportedFunc: ['strftime_unmappable_code'],
  doc: 'strftime-strptime', verified: false,
},
{
  // Units fork — see "Open decision" callout. Current expected = the spec-approved
  // raw-field behavior; flips to `toDatetime(epoch_field * 1000, ...)` if the human
  // chooses the seconds->ms conversion.
  spl: '* | eval d = strftime(epoch_field, "%Y-%m-%d")',
  nrql: "FROM Log WITH toDatetime(epoch_field, 'yyyy-MM-dd') AS d SELECT *",
  warningFunc: ['strftime_epoch_units_warning'],
  doc: 'strftime-strptime', verified: false,
},
```

The eval-projection path emits a `WITH <expr> AS <name> SELECT *` binding (NOT `SELECT <expr> AS <name>`), and a bare leading search term injects a `WHERE message LIKE '%<term>%'` — so these use `*` (no WHERE) and the WITH-form. Both shapes verified against `node bin/spl2nrql.js` on 2026-06-28 (`* | eval d = upper(name)` -> `FROM Log WITH upper(name) AS d SELECT *`; `… / 1000` renders `… / 1000 AS t`). Still re-confirm byte-for-byte in Step 4/6.

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
  Expected: FAIL — strftime/strptime currently hit the `default` case → `eval_func_unsupported`, so `nrql`/`warningFunc` don't match.

- [ ] **Step 3: Add the messages** to `src/messages.js` (near the other eval-function keys ~line 212):

```javascript
  strftime_unmappable_code: (code) =>
    `strftime/strptime format code '${code}' has no Java DateTimeFormatter equivalent; remove it or list the specific fields`,
  strptime_units_warning: () =>
    'strptime() result divided by 1000: NRQL toTimestamp() returns milliseconds, Splunk strptime() returns seconds',
  strftime_epoch_units_warning: () =>
    'strftime() on a non-_time epoch field assumes milliseconds (NRQL timestamp unit); a seconds-epoch field yields a 1970 date — divide/multiply to match',
```

- [ ] **Step 4: Implement** the two cases in `walkEvalFunc` (`src/input/spl/evalHandlers.js`), before the `typeof` case. First add the import at the top of the file: `import { splFormatToJava } from './splFormatCodes.js';`

```javascript
    case 'strftime':
    case 'strptime': {
      const fmtArg = args[1];
      const fmt =
        typeof fmtArg === 'string' ? fmtArg : (fmtArg && fmtArg.value) || '';
      const { pattern, unmappable } = splFormatToJava(fmt);
      if (unmappable.length) {
        ir.unsupported.push(messages.strftime_unmappable_code(unmappable[0]));
        return null;
      }
      const src = walkEvalExpr(args[0], ir);
      if (!src) {
        ir.unsupported.push(messages.eval_func_unsupported(name));
        return null;
      }
      if (name === 'strptime') {
        ir.warnings.push(messages.strptime_units_warning());
        return BinOp(
          '/',
          Func('toTimestamp', [src, Literal(pattern, 'string')]),
          Literal(1000, 'number'),
        );
      }
      // strftime → toDatetime; warn if the epoch source isn't _time/timestamp
      if (!(src.type === 'Identifier' && src.name === 'timestamp')) {
        ir.warnings.push(messages.strftime_epoch_units_warning());
      }
      return Func('toDatetime', [src, Literal(pattern, 'string')]);
    }
```

- [ ] **Step 5: Run, confirm green.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test` — the four cases pass. Then the whole package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge` (no regressions; `eval_func_unsupported` still fires for genuinely-unknown funcs like `typeof`).

- [ ] **Step 6: CLI spot-check + match the test `nrql`.** `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'web_logs | eval d = strftime(_time, "%Y-%m-%d")'` and the strptime case; confirm the emitted NRQL byte-matches the `nrql` fields in Step 1 (fix the test strings if the projection differs).

- [ ] **Step 7: Staging-validate via `run_nerdgraph_query`** (acct 1; `toDatetime`/`toTimestamp` are in the `execute_nrql_query` false-reject set). Two distinct checks — the emitted query is a `WITH … AS d SELECT *` binding where `d` does NOT surface under `SELECT *`, so assert the VALUE on a `SELECT`-projection probe and assert the EMITTED shape merely runs:
  - **Value (probe):** `FROM Log SELECT toDatetime(timestamp, 'yyyy-MM-dd HH:mm:ss') AS d SINCE 30 minutes ago LIMIT 1` returns a real datetime (verified 2026-06-28: `"2026-06-28 19:12:45"`); `FROM Log SELECT (toTimestamp('2024-01-15 10:30:00','yyyy-MM-dd HH:mm:ss') / 1000) AS t SINCE 30 minutes ago LIMIT 1` returns `1705314600` (seconds). **Assert the value, not just that it runs** — a wrong pattern returns garbage with no error (`'%Y-%m-%d'` -> `"%2026-%12-%28"`, verified).
  - **Emitted shape runs:** `FROM Log WITH toDatetime(timestamp,'yyyy-MM-dd') AS d SELECT * SINCE 30 minutes ago LIMIT 1` executes without error (verified 2026-06-28).

- [ ] **Step 8: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/evalHandlers.js packages/nr-query-bridge/src/messages.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: translate strftime/strptime to toDatetime/toTimestamp"
```

---

### Task 3: Finalize long-tail codes + loud-failure regression (NO fold-safety change)

> **Why no `FOLD_SAFE_FUNCS` change (double-check finding, 2026-06-28):** adding
> `toDatetime`/`toTimestamp` to `FOLD_SAFE_FUNCS` would make a post-`stats`
> `eval d = strftime(_time, …)` fold FLAT to
> `SELECT count(*), toDatetime(timestamp, …) FACET host` — which **NRDB rejects**
> (`"Value must be constant in its context: timestamp"`, verified acct 1). That
> ships an NRDB-invalid query as a green unit test (string-equality only) — a
> false-green that violates loud-failure. The fold is also unnecessary: WITHOUT the
> funcs in `FOLD_SAFE_FUNCS`, a stats-*produced* epoch (e.g. `latest(_time) as lt`)
> keeps a valid subquery (`toDatetime(lt,…)` references an exposed column), and raw
> `_time` after a transforming `stats` fails loudly (the inner doesn't expose
> `timestamp` → the existing not-exposed-column guard). `toDatetime` *can* wrap an
> aggregate (`toDatetime(max(timestamp),…)` runs — verified), so the subquery path
> is correct; flat-folding is the only broken shape. **Do not touch
> `FOLD_SAFE_FUNCS` in this PR.**

**Files:**
- Modify: `src/input/spl/splFormatCodes.js` (only if a long-tail code proves byte-identical to a Java pattern)
- Test: `test/spl/splFormatCodes.test.js`, `test/spl/spl.test.js`

- [ ] **Step 1: Staging-verify the residual long-tail codes — bias to `unsupported`.** For each of `%s`, `%U`, `%W`, `%e`, `%k`, `%C`, `%G`, `%V`, `%Q`, run `run_nerdgraph_query` (acct 1) with a `toDatetime` using a candidate Java equivalent and compare the OUTPUT VALUE to what Splunk's code means — not just "does it run." Map a code ONLY if the output is byte-identical to Splunk's semantics; otherwise leave it `unmappable`. Known traps (default these to `unsupported` unless proven identical): `%e`/`%k` are **space-padded** (Java `d`/`H` are not — `%e` gives `" 1"`, `d` gives `"1"`); `%U`/`%W`/`%V` use a **week-numbering scheme** that differs from Java `ww`/`w`; `%s` (epoch seconds) and `%C` (century) have no format-letter equivalent; `%Q`/bare `%N` are Splunk sub-second codes (the `%N`-family is already handled in Task 1 — confirm `%Q` maps or is `unsupported`). Record each verdict in the PR description.

- [ ] **Step 2: For any code that proves byte-identical**, add it to `SPL_TO_JAVA` (or the sub-second branch) in `splFormatCodes.js` and add a unit test asserting the mapping; for every code that stays unmappable, add a `splFormatToJava` unit test asserting it lands in `unmappable`. Run `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- splFormatCodes` — green.

- [ ] **Step 3: Add the loud-failure regression test** to `test/spl/spl.test.js`. A post-transforming-`stats` `strftime` on raw `_time` references a `timestamp` the aggregation no longer exposes → it MUST fail loudly, NOT emit the NRDB-rejected flat shape. First implement Task 2, then CLI-check the emitted output and assert the actual loud message key:

```javascript
{
  // raw _time after a transforming stats: timestamp isn't exposed post-agg.
  // MUST be unsupported (loud), never `SELECT count(*), toDatetime(timestamp,…) FACET host`
  // (NRDB rejects that — verified). Confirm the exact key via `node bin/spl2nrql.js`.
  spl: '* | stats count by host | eval d = strftime(_time, "%Y-%m-%d")',
  unsupportedFunc: ['<exact key from CLI — e.g. compound_collapse_unsupported>'],
  doc: 'strftime-strptime', verified: false,
},
```

- [ ] **Step 4: Run `node bin/spl2nrql.js '* | stats count by host | eval d = strftime(_time, "%Y-%m-%d")'`.** Confirm it emits an `unsupported` (loud) and does NOT emit a flat `SELECT count(*), toDatetime(timestamp,…) FACET host`. Set the test's `unsupportedFunc` to the exact key shown. **If it instead emits the flat shape or any NRDB-invalid NRQL, that is a bug — fix it (do NOT add the funcs to `FOLD_SAFE_FUNCS`); the eval-after-aggregation not-exposed-column guard should fire.**

- [ ] **Step 5: Run, confirm green** (`-- spl.test`), then whole-package (`npm run test --workspace=@newrelic/query-bridge`) — no regressions.

- [ ] **Step 6: Fuzz ×20** (the spec mandates it for translator changes):

```bash
for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done
```

- [ ] **Step 7: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src packages/nr-query-bridge/test
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: finalize strftime long-tail codes + loud post-stats guard"
```

---

### Task 4: Graduate (docs)

**Files:**
- Modify: `.claude/rules/design-decisions.md` (add the invariant)
- Modify: `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` (reclassify the row)
- Modify: `test/spl/spl.test.js` (`verified: false` → `'llm'` once staging-validated)

- [ ] **Step 1: Promote the validated cases** in `test/spl/spl.test.js` from `verified: false` to `verified: 'llm'` (only the ones whose emitted NRQL was staging-confirmed in Task 2 Step 7 / Task 3 Step 1).

- [ ] **Step 2: Graduate the invariant** to `.claude/rules/design-decisions.md` under a Messages/Pipeline or eval-functions bullet:

```markdown
- **strftime/strptime → toDatetime/toTimestamp**: `splFormatToJava` converts the Splunk `%`-format
  to a Java DateTimeFormatter pattern (literal letters quoted; sub-second `%3N/%6N/%9N/%N` →
  `SSS/SSSSSS/SSSSSSSSS`); any unmappable code (`%s`, `%c/%x/%X` locale composites, …) → whole-function
  `unsupported`, never a partial format (a wrong format returns garbage with no NRQL error). `strptime`
  emits `toTimestamp(...) / 1000` (NRQL ms → Splunk seconds). `toDatetime`/`toTimestamp` are in
  `FOLD_SAFE_FUNCS`.
```

- [ ] **Step 3: Reclassify the laundry-list row** — change `strftime-strptime` from a GAP ("no NRQL equivalent") to a shipped BUG fix (the characterization was wrong; NRQL has direct equivalents).

- [ ] **Step 4: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add .claude/rules/design-decisions.md docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: graduate strftime/strptime translation"
```

---

## Global Verification

- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm test` — full workspace suite green.
- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check` — clean.
- [ ] No `npm run build:parsers` needed — no grammar change.
- [ ] Staging re-validation of the two happy-path emitted queries (Task 2 Step 7) still passes.
- [ ] Open the PR (the four commits above); invoke `write-gooder` for the body (100–200 words, summary + test plan).

## Self-Review

1. **Spec coverage:** converter (Task 1) ✓; function mapping + `_time` + units + unmappable→unsupported (Task 2) ✓; long-tail codes + loud post-stats guard (Task 3; NO `FOLD_SAFE_FUNCS` change — see Task 3 note) ✓; graduate + laundry-list reclass (Task 4) ✓. The spec's "value-level assertions required" → Task 2 Step 7 asserts values via a SELECT probe, not just runs.
2. **Loud-failure:** an unmappable code → whole-function `unsupported` (Task 2 Step 4 returns null after pushing); never a partial format.
3. **Type consistency:** `splFormatToJava` returns `{pattern, unmappable}` (Task 1) — consumed with those exact names (Task 2). `Literal(value, kind)`, `BinOp(op,left,right)`, `Func(name,args)` match `src/ir/nodes.js`.
4. **Message consistency:** three new keys (`strftime_unmappable_code`, `strptime_units_warning`, `strftime_epoch_units_warning`) referenced in the `cases` arrays in `test/spl/spl.test.js` (whose spy loop validates key existence + exhaustiveness).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-28-strftime-strptime.md`. Per the session decision, this implements via **subagent-driven-development**, and the branch (`feat/strftime-strptime`) is cut off `master` **after PR #72 lands**. Run `/double-check` on this plan first (clean-room test suite for the converter + the units behavior), then execute.
