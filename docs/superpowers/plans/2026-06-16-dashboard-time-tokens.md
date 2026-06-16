# Dashboard Time Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SPL dashboard time tokens (`$tok.earliest$`, bare `$earliest$`/`$latest$`, custom `$x$` in `earliest=`/`latest=`, and `$timespan$` in `span=`) fail loud — drop the bound + warn for time-bound tokens, `unsupported` for `$timespan$`, and escalate a mixed literal+token window to `unsupported` — instead of silently binding the wrong time window or emitting non-compiling NRQL.

**Architecture:** Three guard sites in the existing SPL→IR walk plus one post-walk escalation check. No new IR nodes, no emitter change, no `parseSplTime` change. A token is recognized by shape (`$…$`). Two new scope-local flags (`sawTimeToken`, `sawTimeLiteral`) feed a mixed-bound check at the point `since`/`until` are committed to the IR. `span=` tokens are parsed into a tagged `SpanToken` so the pipe survives, then rejected at the `timechart`/`bin` consumers.

**Tech Stack:** Pure ESM JavaScript, Node 24 (`ASDF_NODEJS_VERSION=24.14.0`), Vitest, Peggy parser (regenerate after grammar change). Data-driven test cases in `test/spl/spl.test.js`.

**Source spec:** `docs/superpowers/specs/2026-06-11-dashboard-time-tokens-design.md`

---

## Layout note: PRE-migration paths

This plan targets the **current** repo layout (translator at repo root: `src/`, `test/`, `bin/`), to be done **before** the monorepo move in `docs/superpowers/plans/2026-06-16-dashboard-importer-phase-0-1.md`. All paths below are repo-root-relative. If the migration lands first, prefix translator paths with `packages/nr-query-bridge/`.

## Ground-truth facts (verified against the repo + MCP + NR docs, 2026-06-16)

Do not re-derive these. They were each checked against source, CLI, or live NRQL.

- **Entry/contract:** `translateSplToNrql(spl)` from `src/index.js` → `{ nrql, warnings, unsupported, errors }`. When `unsupported.length>0 || errors.length>0`, `nrql===''`.
- **Test mechanism:** data-driven `cases` array in `test/spl/spl.test.js`. Each case: `{ spl, nrql?, warningFunc?:[keys], unsupportedFunc?:[keys], errorIncludes?, verified, skip? }`. The runner (line ~3711) spies EVERY key in `messages` and asserts: each listed `warningFunc`/`unsupportedFunc` key fired AND no unlisted key fired (exhaustive, bidirectional). **There is NO `test/messages.test.js`.** New message keys are exercised purely by appearing in a case's arrays.
- **Message catalog:** `src/messages.js`, `export const messages = { key: (args) => 'text', ... }` (object literal, closes at line ~384). Handlers call `messages.key()`. Multi-arg example: `macro_translated: (name, nrqlMacro) => ...`.
- **Three guard sites in `src/input/spl/splToIR.js`:**
  - `translateSearchExpr` (line 196) declares `let since = null; let until = null; let consumedTime = false;` at top, returns `{ expr, warnings, unsupported, since, until, consumedTime }` (line 571). These are scope-local per call.
  - `TimeConstraint` handler: lines 487–495 (the `earliest=`/`latest=` path; calls `parseSplTime`).
  - `TemplateVariable` handler: lines 505–514 (standalone `$x$`; sets `since`/`until` to `{{…}}` by `.earliest`/`.latest` suffix, else `return Identifier('{{…}}')`).
  - `where _time` relative-time path: line ~295 sets `since = nrql` (spec A's lower-bound path) — a LITERAL time bound that must also set `sawTimeLiteral`.
  - Leading-search caller + `latest_without_earliest` default: `translateAstToIR` lines 120–134 (commits `since`/`until` onto `ir`; injects `SINCE 24 hours ago` when `until` set but `since` not).
  - Subsearches recurse via `translateAstToIR(subAst)` (line ~539) — naturally isolating their `since`/`until`/flags.
- **`span=` grammar + consumers:**
  - `span_value` rule: `src/input/spl/spl.grammar:197` (`[0-9]+[smhdwMy]` or bare word). Consumed by `timechart_command` (`:171`, `:194` span_clause) and `bin` (`:727`).
  - `handleTimechart` (`src/input/spl/aggregationHandlers.js:65`): `ir.timeseries = cmd.span ? formatSpan(cmd.span) : 'AUTO'`.
  - `handleBin` (`src/input/spl/rowHandlers.js:109`): branches on `cmd.field === '_time' && cmd.span`.
  - `formatSpan` (`src/input/spl/splExprUtils.js:35`): pure `string→string`. It has no `ir`, so the `SpanToken` reject lives at the CONSUMERS, before `formatSpan` is called — keep `formatSpan` pure.
- **Verified current (wrong) behavior — these are the red-state baselines each task flips:**
  - `index=web earliest=$tok.earliest$ latest=$tok.latest$ | stats count` → `FROM Log SELECT count(*) WHERE index = 'web'` + 2× `Unrecognized SPL time expression` warnings (bounds already dropped, but as an accident with the wrong message).
  - `index=web $earliest$ | stats count` → `FROM Log SELECT count(*) WHERE index = 'web' AND {{earliest}}` (global bare token leaks into WHERE — broken).
  - `index=web status=$sev$ | stats count` → `FROM Log SELECT count(*) WHERE index = 'web' AND status = '$sev$'` (value-position token is a raw literal; MUST stay unchanged — not in scope).
  - `index=web earliest=-24h latest=$tok.latest$ | stats count` → `... SINCE 24 hours ago` (literal survives, token silently dropped).
  - `index=web earliest=$tok.earliest$ latest=-2h | stats count` → `... SINCE 24 hours ago UNTIL 2 hours ago` (fabricated SINCE via `latest_without_earliest`; compiles but wrong window).
  - `index=web | timechart span=$timespan$ count` → `unsupported: SPL command 'timechart' has no known NRQL equivalent` (whole command rejected; wrong reason).
- **NRQL facts (live MCP account 1 + NR docs, 2026-06-16):** default SINCE = `1 hour ago` (docs `#sel-since`). `SINCE {{x}}`→`unexpected '{'`; `SINCE $x$`→`unexpected '$'`; `TIMESERIES {{x}}`→`unexpected '{'`. `SINCE 24 hours ago UNTIL 2 hours ago` compiles; `... UNTIL 25 hours ago` fails (inverted).
- **Commit discipline:** lowercase conventional subject ≤72 chars; `ASDF_NODEJS_VERSION=24.14.0 git commit`; never bare `git push`. DO NOT push or open PRs without the user asking. DO NOT COMMIT until the user approves (project rule) — each task's commit step is staged for when they do.
- **AI-DEV markers:** after a test passes its red-green confirmation, add `// AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.` inside each `it()`.

## File structure

```
src/messages.js                          ← MODIFY: add 3 message keys
src/input/spl/spl.grammar                ← MODIFY: span_value gets a SpanToken alternative
src/input/spl/splParser.js               ← REGENERATE from grammar (npm run build:parsers)
src/input/spl/splToIR.js                 ← MODIFY: 4 sites — TimeConstraint guard, TemplateVariable
                                            guard, sawTimeLiteral on where-_time + earliest/latest
                                            literal paths, mixed-bound check in translateAstToIR
src/input/spl/aggregationHandlers.js     ← MODIFY: handleTimechart rejects SpanToken
src/input/spl/rowHandlers.js             ← MODIFY: handleBin rejects SpanToken
test/spl/spl.test.js                     ← MODIFY: add cases (Path 1/2/3, mixed, subsearch, regressions)
```

No new files. No emitter (`irToNrql.js`) change. No `parseSplTime` (`splTime.js`) change. No `formatSpan` change.

## Task order

1. **Task 1** — add the 3 message keys (no behavior yet; unblocks every later task's assertions).
2. **Task 2** — Path 1: `TimeConstraint` token drop+warn.
3. **Task 3** — Path 2: `TemplateVariable` token drop+warn (dotted + global bare).
4. **Task 4** — flags + mixed-bound escalation (depends on 2 & 3 setting `sawTimeToken`).
5. **Task 5** — Path 3: `span=$timespan$` grammar + consumer reject.
6. **Task 6** — regression + subsearch cases, full-suite gate.

Each task is independently testable and commits on its own.

---

### Task 1: Add the three message-catalog keys

**Files:**
- Modify: `src/messages.js` (add keys near the `// ── splToIR ──` block, after `latest_without_earliest` at line 313)

No behavior change yet — this just registers the strings so later tasks' `warningFunc`/`unsupportedFunc` arrays resolve. There is no standalone messages test; the keys are validated when a real case lists them.

- [ ] **Step 1: Add the three keys**

In `src/messages.js`, immediately after the `latest_without_earliest` entry (line 313), insert:

```javascript
  // SPL: `earliest=$tok.earliest$` / `$earliest$` — a dashboard time-range token,
  // resolved only at dashboard run time, with no static NRQL bound.
  time_token_bound_dropped: (param, token) =>
    `${param}=${token} is a dashboard time-range token resolved only at run time; ` +
    `it has no static NRQL time bound. Dropped — the query uses the surrounding/default time range.`,

  // SPL: `earliest=-24h latest=$tok.latest$` — one literal bound, one token bound.
  mixed_token_literal_time_unsupported: () =>
    'This search mixes a literal time bound with a dashboard time-range token. ' +
    'Dropping only the token would silently widen or invert the window, so the whole ' +
    'time range is unsupported. Make both bounds literal, or both tokens.',

  // SPL: `| timechart span=$timespan$ count`
  span_token_unsupported: (token) =>
    `span=${token} is a dashboard token resolved only at run time; NRQL TIMESERIES needs a concrete duration ` +
    `(TIMESERIES AUTO would silently pick its own bucket size). Specify a literal span (e.g. 5 minutes) instead.`,
```

- [ ] **Step 2: Confirm the catalog still loads and the suite is green**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: full SPL suite passes unchanged (the new keys are unused so far; nothing references them, nothing breaks). If a syntax error in the object literal surfaces, fix the comma/brace.

- [ ] **Step 3: Commit**

```bash
git add src/messages.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: add time-token message keys"
```

---

### Task 2: Path 1 — `TimeConstraint` token drop + warn

**Files:**
- Modify: `src/input/spl/splToIR.js` (the `TimeConstraint` case, lines 487–495)
- Test: `test/spl/spl.test.js` (add cases to the `cases` array)

`earliest=$…$` / `latest=$…$` parse as a `TimeConstraint` whose `value` is the raw token string. Before calling `parseSplTime`, detect the token shape (`$…$`), drop the bound (return null, set neither `since`/`until`), and warn. Set `sawTimeToken = true` (the flag is added in Task 4; reference it now and Task 4 declares it — if running tasks strictly in order, add the `let sawTimeToken = false;` declaration alongside `consumedTime` in this task too. To keep tasks self-contained, this task adds the declaration; Task 4 also uses it).

- [ ] **Step 1: Add the failing test cases**

In `test/spl/spl.test.js`, add to the `cases` array (near other time-constraint cases; search for `latest_without_earliest` to find the neighborhood):

```javascript
  // ── Dashboard time tokens: Path 1 (TimeConstraint earliest=/latest=) ──
  {
    spl: "index=web earliest=$tok.earliest$ latest=$tok.latest$ | stats count",
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped', 'time_token_bound_dropped'],
    verified: false,
  },
  {
    spl: "index=web latest=$tok.latest$ | stats count",
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped'],
    verified: false,
  },
  {
    spl: "index=web earliest=$myStart$ latest=$myEnd$ | stats count",
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped', 'time_token_bound_dropped'],
    verified: false,
  },
  // The genuinely common dashboard form: a global time picker injects prefix-less
  // $earliest$/$latest$ as the earliest=/latest= RHS (a TimeConstraint → Path 1).
  // CLI-verified 2026-06-16: today this emits two `Unrecognized SPL time expression`
  // warnings and silently uses the default window — the exact silent-wrong bug.
  {
    spl: "index=web earliest=$earliest$ latest=$latest$ | stats count",
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped', 'time_token_bound_dropped'],
    verified: false,
  },
```

- [ ] **Step 2: Run, confirm they fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: FAIL. Today these emit a `parseSplTime` `Unrecognized SPL time expression` warning (not in the catalog as a keyed func — it is a raw string), so the runner reports an unexpected raw warning and the missing `time_token_bound_dropped` calls. Confirm the failure names `time_token_bound_dropped` as not-called.

- [ ] **Step 3: Add the token guard in the `TimeConstraint` handler**

In `src/input/spl/splToIR.js`, first ensure the flag is declared. Near the top of `translateSearchExpr` (after `let consumedTime = false;`, line ~204) add:

```javascript
  // True once a dashboard time-range TOKEN ($…$) was seen in a time bound, and
  // once a LITERAL time bound (earliest=/latest= or where _time) was applied.
  // A search carrying BOTH is a mixed window the caller escalates to unsupported.
  let sawTimeToken = false;
  let sawTimeLiteral = false;
```

Then replace the `TimeConstraint` case (lines 487–495):

```javascript
      case 'TimeConstraint': {
        if (/\$[^$]+\$/.test(node.value)) {
          sawTimeToken = true;
          warnings.push(
            messages.time_token_bound_dropped(node.param, node.value),
          );
          return null; // drop: leave since/until unset
        }
        const { nrql, warning } = parseSplTime(node.value);
        if (warning) warnings.push(warning);
        if (nrql) {
          sawTimeLiteral = true;
          if (node.param === 'earliest') since = nrql;
          else until = nrql;
        }
        return null;
      }
```

- [ ] **Step 4: Run, confirm pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: the three Path-1 cases PASS. The rest of the suite stays green (the `sawTimeLiteral` flag is set but unused until Task 4 — that is fine, it is a local var). If a pre-existing `earliest=`/`latest=` case regresses, STOP — the guard regex misfired on a literal; confirm `/\$[^$]+\$/` only matches `$…$`.

- [ ] **Step 5: Confirm regression coverage**

Manual red: change the guard test to `if (false)`, re-run — the three Path-1 cases must fail (tokens fall back to `parseSplTime`). Restore, green. This proves the cases are coupled to the guard.

- [ ] **Step 6: Add AI-DEV markers and commit**

Add the AI-DEV marker as the first line inside each of the three new cases' object is not possible (they are data, not `it()` bodies) — instead the marker convention for data-driven cases is a `// AI-DEV:` comment on the line above each case object. Add:
`// AI-DEV: AI **MUST NOT** change this case's expected nrql/warningFunc without re-validating via bin/spl2nrql.js.`

```bash
git add src/input/spl/splToIR.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: drop dashboard time tokens in earliest=/latest="
```

---

### Task 3: Path 2 — `TemplateVariable` token drop + warn (dotted AND global bare)

**Files:**
- Modify: `src/input/spl/splToIR.js` (the `TemplateVariable` case, lines 505–514)
- Test: `test/spl/spl.test.js`

A standalone `$x.earliest$` (a token used as a bare search term, NOT as an `earliest=` RHS) parses as `TemplateVariable`. The current code matches only the `.earliest`/`.latest` SUFFIX, so global bare `$earliest$`/`$latest$` (no dot) falls through to `return Identifier('{{earliest}}')` and leaks `{{earliest}}` into a WHERE term. The fix recognizes a time token by whole-name `earliest`/`latest` OR `.earliest`/`.latest` suffix, drops it, warns, and sets `sawTimeToken`. Non-time variables (`$sev$`) keep the existing value-position fall-through unchanged.

**Note on prevalence (SPL-expert review 2026-06-16):** the *common* dashboard form is `earliest=$earliest$` / `latest=$latest$` — the picker value as the `earliest=`/`latest=` RHS, which is a `TimeConstraint` handled by Path 1 (Task 2, now covered). A token standing alone in the search body (this Path 2) is defensive coverage for the less-common bare form, not the representative real-world case. Both must be handled; do not treat the standalone form as "the common one."

- [ ] **Step 1: Add the failing test cases**

In `test/spl/spl.test.js` `cases`:

```javascript
  // ── Dashboard time tokens: Path 2 (standalone TemplateVariable) ──
  {
    spl: "index=web $tok.earliest$ | stats count",
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped'],
    verified: false,
  },
  {
    spl: "index=web $earliest$ | stats count",
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped'],
    verified: false,
  },
  {
    spl: "index=web $latest$ | stats count",
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped'],
    verified: false,
  },
  // Regression: a NON-time template variable in value position is untouched.
  // Verified current behavior 2026-06-16: $sev$ survives as a single-quoted literal.
  {
    spl: "index=web status=$sev$ | stats count",
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' AND status = '$sev$'",
    verified: false,
  },
  // Boundary: a name that CONTAINS "earliest" but is neither `earliest` nor a
  // `.earliest` suffix must NOT be treated as a time token (guards against a
  // sloppy `.includes('earliest')` match). $earliestSeen$ is a value-position
  // variable here. Confirm exact output via CLI before locking the nrql string.
  {
    spl: "index=web earliestSeen=$earliestSeen$ | stats count",
    // nrql: confirm via bin/spl2nrql.js — expect `... AND earliestSeen = '$earliestSeen$'`
    //       (value-position literal, NO drop, NO warning).
    verified: false,
  },
  // Boundary: a standalone non-time $…$ search term (not .earliest/.latest, not
  // in span=) must fall through to the value/identifier path, NOT be dropped.
  // Confirm via CLI — expect a `{{timespan}}` identifier in WHERE, no warning.
  {
    spl: "index=web $timespan$ | stats count",
    // nrql: confirm via bin/spl2nrql.js — expect `... AND {{timespan}}` (identifier
    //       fall-through), NO time_token_bound_dropped, NO span_token_unsupported.
    verified: false,
  },
```

- [ ] **Step 2: Run, confirm they fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: the dotted case may already partly work via the suffix branch but with no warning (so `time_token_bound_dropped` not-called → FAIL); the global `$earliest$`/`$latest$` cases emit `... AND {{earliest}}` (nrql mismatch → FAIL). The `$sev$` regression case should already PASS (it asserts current behavior) — if it FAILS now, the asserted nrql is wrong; fix the expected string to the CLI output, not the code.

- [ ] **Step 3: Replace the `TemplateVariable` case**

In `src/input/spl/splToIR.js`, replace lines 505–514:

```javascript
      case 'TemplateVariable': {
        const isEarliest =
          node.name === 'earliest' || node.name.endsWith('.earliest');
        const isLatest =
          node.name === 'latest' || node.name.endsWith('.latest');
        if (isEarliest || isLatest) {
          const param = isEarliest ? 'earliest' : 'latest';
          sawTimeToken = true;
          warnings.push(
            messages.time_token_bound_dropped(param, `$${node.name}$`),
          );
          return null; // drop: do NOT set since/until to {{…}}
        }
        return Identifier(`{{${node.name}}}`); // non-time variable: unchanged
      }
```

(Note the case now uses braces `{ }` — the original was a braceless `case` falling through `if` blocks; the block form is required because we declare `const`s.)

- [ ] **Step 4: Run, confirm pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: all four new cases PASS; suite green. The `$sev$` case confirms the value-position fall-through is untouched.

- [ ] **Step 5: Confirm regression coverage**

Manual red: change `node.name === 'earliest' || node.name.endsWith('.earliest')` to just `node.name.endsWith('.earliest')` (the old suffix-only logic), re-run — the global `$earliest$` case must fail (falls through to `{{earliest}}`). Restore, green. This proves the whole-name match is what fixes the commonest bug.

- [ ] **Step 6: Add AI-DEV markers and commit**

Add the `// AI-DEV:` comment line above each new case object. Then:

```bash
git add src/input/spl/splToIR.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: drop standalone dashboard time tokens incl global bare"
```

---

### Task 4: Mixed literal+token window → escalate to unsupported

**Files:**
- Modify: `src/input/spl/splToIR.js` (set `sawTimeLiteral` on the `where _time` literal path ~line 295; return the flags from `translateSearchExpr` line 571; consume them in `translateAstToIR` lines 120–134)
- Test: `test/spl/spl.test.js`

Tasks 2 & 3 set `sawTimeToken`. Task 2 already sets `sawTimeLiteral` for literal `earliest=`/`latest=`. The spec A `where _time > relative_time(...)` lower-bound path (line ~295, `since = nrql`) is ALSO a literal bound and must set `sawTimeLiteral`. Then the flags must travel out of `translateSearchExpr` to `translateAstToIR`, where — if both are set — the window escalates to `unsupported` and any partial `since`/`until` is cleared.

- [ ] **Step 1: Add the failing test cases**

In `test/spl/spl.test.js` `cases`:

```javascript
  // ── Dashboard time tokens: mixed literal + token → unsupported ──
  {
    spl: "index=web earliest=-24h latest=$tok.latest$ | stats count",
    nrql: '',
    warningFunc: ['time_token_bound_dropped'],
    unsupportedFunc: ['mixed_token_literal_time_unsupported'],
    verified: false,
  },
  {
    spl: "index=web earliest=$tok.earliest$ latest=-2h | stats count",
    nrql: '',
    warningFunc: ['time_token_bound_dropped'],
    unsupportedFunc: ['mixed_token_literal_time_unsupported'],
    verified: false,
  },
  // Cross-path mix: a Path-2 standalone token ($tok.latest$) alongside a Path-1
  // literal (earliest=-24h) must ALSO escalate — proves the TemplateVariable
  // branch sets the same sawTimeToken flag the escalation reads.
  {
    spl: "index=web $tok.latest$ earliest=-24h | stats count",
    nrql: '',
    warningFunc: ['time_token_bound_dropped'],
    unsupportedFunc: ['mixed_token_literal_time_unsupported'],
    verified: false,
  },
  // Regression: literal-only window is untouched (no token, no escalation).
  {
    spl: "index=web earliest=-24h latest=-1h | stats count",
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' SINCE 24 hours ago UNTIL 1 hour ago",
    verified: false,
  },
```

- [ ] **Step 2: Run, confirm they fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: the two mixed cases FAIL — today the first emits `... SINCE 24 hours ago` and the second emits `... SINCE 24 hours ago UNTIL 2 hours ago` (+`latest_without_earliest`), neither carries `mixed_token_literal_time_unsupported`, and `nrql` is not `''`. The literal-only regression should PASS already.

- [ ] **Step 3: Set `sawTimeLiteral` on the `where _time` literal path**

In `src/input/spl/splToIR.js`, in the `where _time` relative-time branch, find the line `since = nrql;` (line ~296, inside `if (isLower)`). Immediately before it add `sawTimeLiteral = true;`:

```javascript
            if (isLower) {
              sawTimeLiteral = true;
              since = nrql;
            } else if (isUpper) {
```

(The `isUpper` branch pushes `unsupported` and sets no bound, so it does not mark a literal — leave it. Only a bound that actually lands on `since`/`until` counts as a literal window.)

- [ ] **Step 4: Return the flags from `translateSearchExpr`**

Change the return (line 571) from:

```javascript
  return { expr, warnings, unsupported, since, until, consumedTime };
```

to:

```javascript
  return {
    expr,
    warnings,
    unsupported,
    since,
    until,
    consumedTime,
    sawTimeToken,
    sawTimeLiteral,
  };
```

- [ ] **Step 5: Consume the flags in `translateAstToIR`**

In `src/input/spl/splToIR.js`, the leading-search block (lines 120–134). Change the destructure and add the escalation BEFORE the `latest_without_earliest` default (so a mixed window never reaches the fabricated-SINCE path):

```javascript
    const {
      expr,
      warnings,
      unsupported,
      since,
      until,
      sawTimeToken,
      sawTimeLiteral,
    } = translateSearchExpr(ast.search, ir);
    if (expr) ir.where.push(expr);
    if (sawTimeToken && sawTimeLiteral) {
      // Mixed literal+token window: dropping only the token would silently widen
      // or invert the range. Fail loud and emit no bound at all.
      ir.unsupported.push(messages.mixed_token_literal_time_unsupported());
    } else {
      if (since) ir.since = since;
      if (until) ir.until = until;
      // NRQL requires SINCE < UNTIL; default SINCE is 1h which may overlap UNTIL
      if (until && !since) {
        ir.since = '24 hours ago';
        ir.warnings.push(messages.latest_without_earliest());
      }
    }
    ir.warnings.push(...warnings);
    ir.unsupported.push(...unsupported);
```

(Putting `since`/`until`/`latest_without_earliest` in the `else` is the "clear any partial bound" requirement — when escalating, they are simply never copied onto `ir`. The token's own `time_token_bound_dropped` warning still flows through `warnings`.)

- [ ] **Step 6: Run, confirm pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: both mixed cases PASS (`nrql:''`, the token warning + the mixed unsupported both fire, `latest_without_earliest` does NOT fire). Literal-only regression still green. Token-only cases from Tasks 2–3 still green (they have `sawTimeToken` but not `sawTimeLiteral`, so they take the drop path, not escalation).

- [ ] **Step 7: Confirm regression coverage**

Manual red: change `if (sawTimeToken && sawTimeLiteral)` to `if (false)`, re-run — both mixed cases fail (they fall back to today's silent-widen / fabricated-SINCE behavior). Restore, green.

- [ ] **Step 8: Add AI-DEV markers and commit**

Add the `// AI-DEV:` comment above each new case. Then:

```bash
git add src/input/spl/splToIR.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: escalate mixed literal+token time window to unsupported"
```

---

### Task 5: Path 3 — `span=$timespan$` parses then rejects

**Files:**
- Modify: `src/input/spl/spl.grammar` (`span_value` rule, line 197)
- Regenerate: `src/input/spl/splParser.js` (via `npm run build:parsers`)
- Modify: `src/input/spl/aggregationHandlers.js` (`handleTimechart`, line 63)
- Modify: `src/input/spl/rowHandlers.js` (`handleBin`, line 109)
- Test: `test/spl/spl.test.js`

Today `span=$timespan$` makes `span_value` fail to match, so the whole `timechart` reads as unrecognized → generic `unsupported`. The fix: make `span_value` accept a `$…$` token (returning a tagged object `{type:'SpanToken', name}`), so the command parses; then in `handleTimechart` and `handleBin`, detect the tagged object before `formatSpan` and push the specific `span_token_unsupported`. `formatSpan` stays a pure string→string function (untouched).

- [ ] **Step 1: Add the failing test cases**

In `test/spl/spl.test.js` `cases`:

```javascript
  // ── Dashboard time tokens: Path 3 ($timespan$ in span=) ──
  {
    spl: "index=web | timechart span=$timespan$ count",
    nrql: '',
    unsupportedFunc: ['span_token_unsupported'],
    verified: false,
  },
  {
    spl: "index=web | bin _time span=$timespan$ | stats count",
    nrql: '',
    unsupportedFunc: ['span_token_unsupported'],
    verified: false,
  },
  // Regression: literal numeric span unchanged.
  {
    spl: "index=web | timechart span=5m count",
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' TIMESERIES 5 minutes",
    verified: false,
  },
  // Regression: bare-word duration span unchanged.
  {
    spl: "index=web | timechart span=hour count",
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' TIMESERIES 1 hour",
    verified: false,
  },
```

**Note:** the exact emitted NRQL for the two regression cases (`5m`→`5 minutes`, `hour`→`1 hour`) must be CONFIRMED via `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "index=web | timechart span=5m count"` before locking the string — adjust to the actual output if `formatSpan`'s spacing differs.

- [ ] **Step 2: Run, confirm they fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: the two `$timespan$` cases FAIL — today they report the generic `timechart`/`bin` unsupported (different key), not `span_token_unsupported`. The two regression cases should PASS already (confirm exact strings first).

- [ ] **Step 3: Add the `SpanToken` alternative to the grammar**

In `src/input/spl/spl.grammar`, replace the `span_value` rule (line 197):

```
span_value
  = '$' name:template_var_name '$'
    { return { type: 'SpanToken', name: name }; }
  / num:[0-9]+ unit:[smhdwMy]
    { return num.join('') + unit; }
  / 'day'i { return '1d'; }
  / 'hour'i { return '1h'; }
  / 'minute'i { return '1m'; }
  / 'month'i { return '1M'; }
  / 'week'i { return '1w'; }
```

The `$…$` alternative is FIRST (most specific — requires `$`), so literal `5m`/`hour` still fall through to the existing alternatives. `template_var_name` (`[a-zA-Z0-9_.]+`) already exists and is reused.

- [ ] **Step 4: Regenerate the parser**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run build:parsers`
Expected: `src/input/spl/splParser.js` regenerated, exits 0. (Generated file is excluded from lint/types — do not hand-edit it.)

- [ ] **Step 5: Reject the token in `handleTimechart`**

In `src/input/spl/aggregationHandlers.js`, `handleTimechart` (line 63). Replace the body's span line:

```javascript
export function handleTimechart(cmd, ir) {
  handleStats(cmd, ir);
  if (cmd.span && typeof cmd.span === 'object' && cmd.span.type === 'SpanToken') {
    ir.unsupported.push(messages.span_token_unsupported(`$${cmd.span.name}$`));
  } else {
    ir.timeseries = cmd.span ? formatSpan(cmd.span) : 'AUTO';
  }
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

- [ ] **Step 6: Reject the token in `handleBin`**

In `src/input/spl/rowHandlers.js`, `handleBin` (line 109). Add a token guard at the top:

```javascript
export function handleBin(cmd, ir) {
  if (cmd.span && typeof cmd.span === 'object' && cmd.span.type === 'SpanToken') {
    ir.unsupported.push(messages.span_token_unsupported(`$${cmd.span.name}$`));
    return;
  }
  if (cmd.field === '_time' && cmd.span) {
```

(The rest of `handleBin` is unchanged.)

- [ ] **Step 7: Run, confirm pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: the two `$timespan$` cases PASS with ONLY `span_token_unsupported` (exhaustive — no leftover generic timechart/bin unsupported). Regressions green. If a generic `timechart`/`bin` unsupported ALSO fires (making the array non-exhaustive), trace why the command still partly fails and ensure the token guard returns/short-circuits cleanly.

- [ ] **Step 8: Confirm regression coverage**

Manual red: in `handleTimechart`, change `cmd.span.type === 'SpanToken'` to `=== 'nope'`, re-run — the timechart `$timespan$` case must fail (token falls into `formatSpan`, which returns the object unstringified or throws). Restore, green.

- [ ] **Step 9: Add AI-DEV markers and commit**

Add `// AI-DEV:` comments above the new cases. Stage the regenerated parser too:

```bash
git add src/input/spl/spl.grammar src/input/spl/splParser.js src/input/spl/aggregationHandlers.js src/input/spl/rowHandlers.js test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: reject span= dashboard token as unsupported"
```

---

### Task 6: Subsearch scoping + full-suite gate

**Files:**
- Test: `test/spl/spl.test.js` (subsearch + a couple of edge cases)
- Verify only (no source change expected)

The subsearch path recurses through `translateAstToIR` (line ~539), so a token inside `[ search … ]` is handled in its own scope — the outer query's `since`/`until`/flags are untouched. This task proves that with tests and runs the full gate. NO source change is expected; if a test fails, investigate before editing code.

- [ ] **Step 1: Establish the subsearch baselines via CLI (resolve the UNSURE items)**

Run all three and read each output:
```
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "index=web [ search index=auth earliest=\$tok.earliest\$ ] | stats count"
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "index=web earliest=-24h [ search index=auth latest=\$tok.latest\$ ] | stats count"
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "index=web [ search index=auth earliest=-1h latest=\$tok.latest\$ ] | stats count"
```
The subsearch's messages are wrapped by `subsearch_warning(...)` / `subsearch_unsupported(...)` (see `splToIR.js` TopLevelSubsearch case ~line 540). Determine the ACTUAL keys/shapes that surface (likely the wrapper keys, not the raw `time_token_bound_dropped` / `mixed_token_literal_time_unsupported`). For all three: confirm the OUTER query's SINCE/UNTIL is what the test expects (untouched by the subsearch token; literal preserved in case 2). Write each test's `warningFunc`/`unsupportedFunc`/`nrql` to match the OBSERVED output, not an assumption.

- [ ] **Step 2: Add the subsearch test cases (with observed expectations)**

In `test/spl/spl.test.js` `cases` — fill `warningFunc` from Step 1's observation:

```javascript
  // ── Dashboard time tokens: subsearch scoping ──
  // Token in a subsearch: dropped within the subsearch scope; OUTER query
  // gets no SINCE/UNTIL from it. warningFunc reflects the subsearch_warning
  // wrapper observed via CLI in Step 1 — confirm before locking.
  {
    spl: "index=web [ search index=auth earliest=$tok.earliest$ ] | stats count",
    // nrql + warningFunc: FILL FROM STEP 1 CLI OUTPUT. Assert the outer query
    // carries NO SINCE/UNTIL (the token did not leak outward).
    verified: false,
  },
  // Outer literal + subsearch token must NOT escalate the outer window
  // (flags are scope-local; the subsearch's token never sets the outer's flag).
  {
    spl: "index=web earliest=-24h [ search index=auth latest=$tok.latest$ ] | stats count",
    // Expect outer SINCE 24 hours ago preserved, NO mixed_token_literal key on
    // the outer. Confirm exact nrql + funcs via CLI in Step 1 first.
    verified: false,
  },
  // Literal + token BOTH inside the same subsearch → that subsearch's window
  // escalates to unsupported within its own scope; outer unaffected. Confirm
  // via CLI whether the escalation surfaces as a wrapped subsearch_unsupported.
  {
    spl: "index=web [ search index=auth earliest=-1h latest=$tok.latest$ ] | stats count",
    // Expect a subsearch-scoped mixed-window unsupported (wrapped), outer clean.
    // FILL nrql + unsupportedFunc/warningFunc from Step 1 CLI output.
    verified: false,
  },
```

- [ ] **Step 3: Run, confirm pass (or investigate)**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test -- spl`
Expected: PASS once expectations match the observed CLI output. If the OUTER window IS affected by a subsearch token (it should not be), that is a real scoping bug — STOP and investigate `translateAstToIR`/subsearch isolation before changing the test.

- [ ] **Step 4: Edge case — token-only with no command**

Add and verify (confirm exact output via CLI first):

```javascript
  {
    spl: "index=web earliest=$tok.earliest$ latest=$tok.latest$",
    nrql: "FROM Log SELECT * WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped', 'time_token_bound_dropped'],
    verified: false,
  },
```

- [ ] **Step 5: Full suite + lint + types gate**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Then: `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check`
Expected: entire suite green; lint + types exit 0. The doc-currency `afterAll` in `spl.test.js` regenerates `docs/SPL_TO_NRQL.md` locally — if it shows as modified in `git status`, that is expected; stage it with the commit.

- [ ] **Step 6: Add AI-DEV markers and commit**

Add `// AI-DEV:` comments above the new cases. Then:

```bash
git add test/spl/spl.test.js docs/SPL_TO_NRQL.md
ASDF_NODEJS_VERSION=24.14.0 git commit -m "test: cover subsearch-scoped time tokens and edge cases"
```

---

## Resolved-during-implementation items (the spec's UNSURE list)

These were flagged in the two test-list reviews; resolve each via `bin/spl2nrql.js` at the step noted, never by inventing the expected string:
1. **`$sev$` value-position output** — confirmed `status = '$sev$'` (Task 3, already locked).
2. **Exhaustive key set for `$timespan$` (timechart + bin)** — Task 5 Step 7 (ensure only `span_token_unsupported` fires).
3. **Subsearch warning/unsupported wrapping** (`subsearch_warning`/`subsearch_unsupported` vs raw key) — Task 6 Step 1 (all three subsearch cases).
4. **Regression span strings** (`5m`→`5 minutes`, `hour`→`1 hour`) — Task 5 Step 1.
5. **`earliestSeen=$earliestSeen$` and standalone `$timespan$` outputs** — Task 3 (boundary cases): confirm `earliestSeen` is a value-position literal (no drop) and standalone `$timespan$` becomes a `{{timespan}}` identifier (no drop, no span-unsupported — it is not in a `span=` position).

### Genuine spec ambiguities (clean-room review) — confirm behavior, then pin the test; do NOT invent

These are scenarios the spec does not fully specify. Resolve by running the CLI and asserting the OBSERVED behavior, and note the resolution back in the spec if it is load-bearing:

- **Residual NRQL when the failing token IS the command's payload.** `index=web | timechart span=$timespan$ count` is `unsupported` for the span — but does the result still emit `FROM Log SELECT count(*)` (the surviving stats), or is `nrql` empty because `unsupported.length>0` forces `nrql===''`? Per the contract, ANY unsupported makes `nrql===''`. So "rest of the pipe still translates" means the WORK is done (count is computed in IR) but the emitted string is still empty. The Task 5 cases assert `nrql:''` accordingly — confirm that is what the spec intends (it is the project's loud-failure contract), and soften the spec's "rest of the pipe still translates" wording if it misleads.
- **Two tokens + one literal warning count.** `earliest=$a$ latest=$b$` plus a `where _time` literal: the rule escalates to `mixed_token_literal_time_unsupported`, but how many `time_token_bound_dropped` warnings fire (one per token = two)? Confirm via CLI and assert exhaustively. Not currently a plan case — add one if the corpus shows this shape; otherwise note as a known untested combination.
- **Mid-pipe `| search $earliest$`.** Whether a token in a non-leading `search` command is in the mixed-bound scope is unspecified. Out of scope for this plan (leading-search + subsearch only); flag if the corpus surfaces it.

## Notes for the implementer

- **Do NOT touch `parseSplTime` (`splTime.js`), the emitter (`irToNrql.js`), or `formatSpan`.** The token guards sit before/around them.
- **Regenerate the parser** (`npm run build:parsers`) after the Task 5 grammar edit — the committed `splParser.js` must match `spl.grammar`. Never hand-edit `splParser.js`.
- **`verified: false`** on every new case — only a human promotes verification level (project rule). Run `validate-test-cases` skill on the emitted NRQL before any promotion.
- **DO NOT push or open a PR.** The user initiates that. DO NOT commit until the user has approved committing (project rule) — the commit steps are written for when they say go.
- **Markdown-only? No.** This touches source + grammar, so the change needs sidekick review per engineering standards before merge.
