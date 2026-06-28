# `transaction` (session grouping) → loud `unsupported` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic `unsupported_command('transaction')` message with a dedicated `transaction_unsupported` message that names Splunk `transaction`'s session-grouping semantics (and the blocking window/boundary arg when one is present), for **every** form of the command. No NRQL is ever emitted — `transaction` has no faithful NRQL equivalent (Option A from the spec). The deliverable is a *better loud message*, not a translation.

**Architecture:** `transaction` is parsed by the grammar's `unknown_command` catch-all into `{ type: 'UnsupportedCommand', name: 'transaction', rawText: '<args after the command name>' }` (e.g. `rawText = 'user_id maxspan=30s'`). The dispatch already lives in `splToIR.js`'s `case 'UnsupportedCommand'` (line 749), which special-cases `streamstats`/`kvparse`/`extract`/`kv` before the generic `messages.unsupported_command(name)` fallback. We add a `name === 'transaction'` branch that scans `cmd.rawText` for the first window/boundary arg (`maxspan`, `maxpause`, `startswith`, `endswith`) and pushes `messages.transaction_unsupported(windowArg)` (`windowArg` is the matched arg name, or `null` for the bare form). No grammar change, no IR node, no emitter change.

**Tech Stack:** Pure ESM JavaScript; AST dispatch in `src/input/spl/splToIR.js`; message catalog in `src/messages.js` (handlers call `messages.key()` — no inline strings); Vitest with the data-driven `cases` array in `test/spl/spl.test.js`.

**Branch:** `feat/transaction` off `origin/master`. Spec: `docs/superpowers/specs/2026-06-27-transaction-design.md`.

## Global Constraints

- Dev requires **Node 24**: prefix every command `ASDF_NODEJS_VERSION=24.14.0` (hooks + commit need it).
- Run one package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- <filter>`.
- Conventional commits, lowercase subject ≤72 chars, body lines ≤100. `git commit -F <file>` for multi-line bodies. `git push origin HEAD` (never bare, never to master).
- **Loud failure over silent-wrong:** `transaction` always lands in `ir.unsupported` (never `ir.warnings`, never an emitted FACET form). The spec rejected the lossy FACET approximation (Option B) outright — do **not** emit any NRQL for `transaction`.
- Messages live in `src/messages.js`; handlers call `messages.key()` — no inline strings. Lead each message with a meaningful word (the `SPL_TO_NRQL.md` generator backticks the first token).
- **Message-key enforcement lives in `test/spl/spl.test.js`, NOT a separate `messages.test.js`** (that file does not exist in this repo). The `describe('translateSplToNrql')` block (≈line 4562) spies on every key of `messages` in `beforeEach`; a case's `warningFunc`/`unsupportedFunc` array is checked for (a) every listed key having been called and (b) no *unlisted* key having been called — so the arrays must be **exhaustive**, and an undefined key fails because `spies[fn]` is `undefined`.
- New/changed translations land at `verified: false` (only a human promotes to `'llm'`/`'human'`). This change emits no NRQL and needs no staging run, so the cases **stay `verified: false`** — graduation here is docs-only, never a verified-level bump.
- Terminology: raw input records are **loglines**, never Splunk's "events" ("event" is reserved for NRDB event types). The grouped output is a **transaction** (session).

## Decided (2026-06-28) — Option A: `transaction` is UNSUPPORTED in every form

Resolved in brainstorming and in the spec's Verdict/Decision sections. NRQL has **no session/sessionization primitive**: `FACET` groups globally into one group per key, `TIMESERIES` buckets by wall-clock — neither can "start a new transaction when the per-key time gap exceeds N seconds," which is exactly what `maxspan`/`maxpause`/`startswith`/`endswith` express. Even the **bare** `transaction <field>` (no window) is *not* a plain FACET: Splunk's documented defaults `maxevents=1000` (splits any key with >1000 loglines into multiple transactions) and `connected=true` (groups by logline-stream connectivity, not global group-by-key) mean a FACET form mis-merges high-cardinality keys and ignores connectivity — a lossy approximation, not faithful. So **all** forms → `unsupported`. The win is a message that names the session semantics and the specific blocking arg, replacing the generic "has no known NRQL equivalent."

## File Structure

- **Modify** `src/messages.js` — add one key: `transaction_unsupported(windowArg)`.
- **Modify** `src/input/spl/splToIR.js` — add a `name === 'transaction'` branch in the `case 'UnsupportedCommand'` block (line 749), with a small inline window/boundary-arg scan over `cmd.rawText`.
- **Modify** `test/spl/spl.test.js` — repoint the existing transaction case to the new key + `verified: false`, and add the bare, no-field, and boundary-arg `cases`.
- **Modify (Task 2 only)** `.claude/rules/design-decisions.md` — graduate the invariant.
- **Modify (Task 2 only)** `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` — update the `transaction-unsupported` row. **⚠️ MERGE-ORDER FLAG:** both Task-2 files are also edited by PR #72 (branch `docs/laundry-list-translation-specs`). If #72 is unmerged when this branch is cut, expect a conflict on these two files — rebase `feat/transaction` onto master *after* #72 lands, and re-confirm the laundry-list row's line number and the design-decisions section before editing. Do **not** touch these two files in Task 1.

### Untouched on purpose

- `src/input/spl/spl.grammar` + `src/input/spl/splParser.js` — `transaction` already routes through `unknown_command`; no grammar change → no `npm run build:parsers`.
- `src/input/spl/splExprUtils.js` line ~326 — `transaction` is already in the known-transforming-command regex (used for subquery decisions); leave it.
- No IR node, no `irToNrql` change — the unsupported path emits no NRQL.

---

### Task 1: `transaction` → dedicated loud `unsupported` (all forms)

**Files:**
- Modify: `src/messages.js` — add `transaction_unsupported`.
- Modify: `src/input/spl/splToIR.js` — add the `transaction` branch in `case 'UnsupportedCommand'` (line 749).
- Test: `test/spl/spl.test.js` — repoint the existing case + add three new `cases`.

**Interfaces:**
- `case 'UnsupportedCommand'` reads `cmd.name` (lowercased by the grammar) and `cmd.rawText` (the text after the command name, e.g. `'user_id maxspan=30s'`; `''` when no args). It pushes onto `ir.unsupported` (a string array). The new message takes one arg: `transaction_unsupported(windowArg)` where `windowArg` is the matched window/boundary arg name (string) or `null`.

- [ ] **Step 1: Add failing data-driven `cases`** to the `cases` array in `test/spl/spl.test.js`. Replace the existing transaction case (currently `unsupportedFunc: ['unsupported_command']`, `verified: 'human'`, ≈line 3271) with the repointed case below, and add the three new cases beside it. All reuse `doc: 'correlation-transaction'` (its `<!-- spl-cases: correlation-transaction -->` sentinel already exists in `SPL_TO_NRQL.md`). The unsupported path emits no NRQL, so these carry no `nrql` field.

```javascript
  {
    // windowed: maxspan splits a key's session on a time gap — no NRQL equivalent
    spl: '* | transaction clientip maxspan=10m',
    unsupportedFunc: ['transaction_unsupported'],
    doc: 'correlation-transaction',
    verified: false,
  },
  {
    // bare (no window): still not a plain FACET — maxevents=1000 + connected=true
    spl: '* | transaction user_id',
    unsupportedFunc: ['transaction_unsupported'],
    doc: 'correlation-transaction',
    verified: false,
  },
  {
    // no fields at all
    spl: '* | transaction',
    unsupportedFunc: ['transaction_unsupported'],
    doc: 'correlation-transaction',
    verified: false,
  },
  {
    // boundary args (startswith/endswith) — exercises the window-arg scan
    spl: '* | transaction user_id startswith="login" endswith="logout"',
    unsupportedFunc: ['transaction_unsupported'],
    doc: 'correlation-transaction',
    verified: false,
  },
```

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
  Expected FAIL, two distinct ways (both prove the test bites): (a) the new cases reference `transaction_unsupported`, which does not exist yet, so `spies['transaction_unsupported']` is `undefined` → `expect(undefined).toHaveBeenCalled()` throws; (b) the repointed existing case still fires `unsupported_command` (old code) → the spy loop fails with "unexpected message function 'unsupported_command' was called but not listed".

- [ ] **Step 3: Add the message** to `src/messages.js`, immediately after `kvparse_unsupported` (≈line 461), keeping the leading-comment convention:

```javascript
  // SPL: `* | transaction user_id maxspan=30s` — no NRQL sessionization primitive (Option A).
  transaction_unsupported: (windowArg) =>
    windowArg
      ? `SPL 'transaction' groups loglines into per-key sessions and the '${windowArg}' arg splits them on a time gap/boundary; NRQL has no sessionization primitive (FACET groups globally, TIMESERIES buckets by wall-clock), so it has no equivalent`
      : `SPL 'transaction' groups loglines into per-key sessions; NRQL has no sessionization primitive, and even bare 'transaction' is not a plain FACET (Splunk's maxevents=1000 splits high-cardinality keys and connected=true groups by stream connectivity), so it has no equivalent`,
```

- [ ] **Step 4: Add the `transaction` branch** to `case 'UnsupportedCommand'` in `src/input/spl/splToIR.js`. Insert it in the existing `if (name === 'streamstats') … else if …` ladder (line 756+), before the generic `else { ir.unsupported.push(messages.unsupported_command(name)); }` fallback:

```javascript
      } else if (name === 'transaction') {
        // No faithful NRQL equivalent: NRQL has no sessionization primitive, and
        // even bare transaction != FACET (maxevents=1000 + connected=true). Name
        // the first blocking window/boundary arg when one is present.
        const windowMatch = /\b(maxspan|maxpause|startswith|endswith)\b/i.exec(
          cmd.rawText || '',
        );
        const windowArg = windowMatch ? windowMatch[1].toLowerCase() : null;
        ir.unsupported.push(messages.transaction_unsupported(windowArg));
```

- [ ] **Step 5: Run, confirm green.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test` — the four cases pass. Then the whole package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge` — no regressions (`unsupported_command` still fires for other catch-all commands like `timewrap`/`rest`/`tstats`).

- [ ] **Step 6: CLI spot-check.** Confirm each form emits the dedicated message and no NRQL:
```bash
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | transaction clientip maxspan=10m'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | transaction user_id'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | transaction'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | transaction user_id startswith="login" endswith="logout"'
```
Expect: line 1 names `'maxspan'`; line 4 names `'startswith'` (first match wins); lines 2–3 give the bare-form message (maxevents/connectivity). No `FROM`/`SELECT`/`FACET` in any output.

- [ ] **Step 7: Fuzz ×20** (mandated for translator changes):
```bash
for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done
```

- [ ] **Step 8: Lint + types, then commit.**
```bash
ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/messages.js packages/nr-query-bridge/src/input/spl/splToIR.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: emit dedicated transaction_unsupported message"
```

This is PR 1 (the spec's PR 1; ~80 lines, behavior). Dependency: none.

---

### Task 2: Graduate (docs)

> **⚠️ MERGE-ORDER FLAG (repeat):** both files below are also edited by PR #72 (`docs/laundry-list-translation-specs`). Land this task only after #72 is on master, and re-confirm the laundry-list row's line number + the design-decisions target section before editing — line numbers below are as of 2026-06-28 and will drift.

**Files:**
- Modify: `.claude/rules/design-decisions.md` — add the invariant.
- Modify: `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` — update the `transaction-unsupported` row (line ≈85).

**No verified-level change.** This change emits no NRQL and needs no staging run, so the Task-1 cases stay `verified: false`. Do not promote them here (only a human promotes).

- [ ] **Step 1: Graduate the invariant** to `.claude/rules/design-decisions.md`. Add this one-liner under the **Messages & Pipeline** section (a message-emission invariant; the human may relocate if a better home exists):

```markdown
- **`transaction` → loud `transaction_unsupported` (all forms, permanent)**: `transaction` parses via the
  `unknown_command` catch-all (`UnsupportedCommand`, `cmd.rawText` carries the args). The `name === 'transaction'`
  branch in `splToIR.js` pushes `messages.transaction_unsupported(windowArg)`, naming the first window/boundary
  arg (`maxspan|maxpause|startswith|endswith`) when present, else the bare-form message. NRQL has no sessionization
  primitive (FACET groups globally, TIMESERIES buckets by wall-clock); bare `transaction` is **not** a plain FACET
  (`maxevents=1000` splits high-cardinality keys, `connected=true` groups by stream connectivity). The lossy FACET
  approximation was rejected — never emit NRQL for `transaction`.
```

- [ ] **Step 2: Update the laundry-list row.** The row stays in the **Coverage gaps** section and stays class `GAP` (it is a genuine no-equivalent gap — Option A). Update its `problem` text to record that a dedicated message now ships, replacing the generic one. From:

```markdown
| `transaction-unsupported` | GAP | `transaction` (session grouping by field + time window) has no NRQL primitive. | `… \| transaction user_id maxspan=30s` | Placeholder | Medium | corpus |
```

to:

```markdown
| `transaction-unsupported` | GAP | `transaction` (session grouping by field + time window) has no NRQL sessionization primitive. **Shipped:** dedicated `transaction_unsupported` message names the session semantics + the blocking window/boundary arg (all forms); no FACET form emitted. | `… \| transaction user_id maxspan=30s` | Placeholder (dedicated message) | Medium | corpus |
```

(Decide strike-vs-update with the human — see Double-check targets. The spec's PR-2 line says "strike the row," but the gap is real and permanent, so annotating-as-shipped is the conservative default; do not silently delete a true coverage gap.)

- [ ] **Step 3: Commit.**
```bash
ASDF_NODEJS_VERSION=24.14.0 git add .claude/rules/design-decisions.md docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: graduate transaction unsupported invariant"
```

This is PR 2 (the spec's PR 2; ~30 lines, docs). Dependency: PR 1.

---

## Global Verification

- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm test` — full workspace suite green.
- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check` — clean (Prettier included).
- [ ] No `npm run build:parsers` needed — no grammar change.
- [ ] Fuzz ×20 green (Task 1 Step 7).
- [ ] Spot-check confirms zero NRQL emitted for any `transaction` form (Task 1 Step 6).
- [ ] Open the PR(s); invoke `write-gooder` for the body (100–200 words, summary + test plan).

## Self-Review

1. **Spec coverage:** windowed/bare/no-field forms all → `unsupported` with `transaction_unsupported` (Task 1 cases match the spec's three Acceptance criteria, plus a boundary-arg case exercising the scan branch). Graduate + laundry-list reclass (Task 2). ✓
2. **Loud-failure:** every form pushes to `ir.unsupported`; the spec-rejected FACET form is never emitted. ✓
3. **Type consistency:** the branch reads `cmd.name`/`cmd.rawText` (the `UnsupportedCommand` AST shape from `unknown_command`) and pushes a string onto `ir.unsupported`. `transaction_unsupported(windowArg)` is a 1-arg message; the spy check only asserts the function was called, so the arg value is unconstrained by the harness. ✓
4. **Message consistency:** one new key `transaction_unsupported`, referenced in the Task-1 `cases` arrays; enforcement is the `spl.test.js` spy loop (NOT a nonexistent `messages.test.js`). ✓
5. **Exhaustiveness:** each case's `unsupportedFunc` is exactly `['transaction_unsupported']` and no other message fires for `* | transaction …` (the bare `*` injects no WHERE; the old human-verified case fired only `unsupported_command`, which we replace 1:1). ✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-28-transaction.md`. Implement via **subagent-driven-development** (or executing-plans). Cut `feat/transaction` off `master` **after PR #72 lands** (Task 2 edits two files #72 also touches). PR 1 is self-contained behavior+tests; PR 2 is docs and depends on PR 1.

## Double-check targets (verify before/while executing)

- **`messages.test.js` does not exist.** Confirmed 2026-06-28: message-key existence + exhaustiveness is enforced only by the spy loop in `test/spl/spl.test.js` (`describe('translateSplToNrql')`, ≈line 4562). The brief/exemplar's reference to `test/messages.test.js` is stale — the plan deliberately omits it. Re-confirm no such file appeared.
- **Existing case line number (≈3271) and its current fields** (`unsupportedFunc: ['unsupported_command']`, `verified: 'human'`, `doc: 'correlation-transaction'`). Re-grep before editing; it may move.
- **`UnsupportedCommand` dispatch line (≈749–763) and the `if/else if` ladder shape** in `splToIR.js`. Confirm `cmd.rawText` is the field name (set by the `unknown_command` grammar rule) and is `''` (not `undefined`) for the no-arg form — the branch uses `cmd.rawText || ''` to be safe either way.
- **Message-anchor line (≈461, after `kvparse_unsupported`)** in `src/messages.js`. Re-confirm placement.
- **Bare `*` injects no WHERE for `* | transaction …`.** Verified via CLI 2026-06-28 (output was the single `unsupported:` line, no `FROM`/`WHERE`). Re-confirm in Task 1 Step 6 — if a WHERE *did* appear, the cases would need a different leading term but the `unsupportedFunc` assertion is unaffected (no `nrql` field).
- **`startswith`/`endswith` parse cleanly through `rest_of_command`** (`[^|]+`) so `rawText` captures them. Confirm the boundary case emits and names `'startswith'`.
- **PR #72 file overlap + merge ordering** for `.claude/rules/design-decisions.md` and the laundry-list spec. Confirm #72's final state before Task 2, and re-confirm the row line number + the design-decisions section heading.
- **Strike vs. annotate the laundry-list row** (Task 2 Step 2). The spec says "strike"; the plan defaults to annotate-as-shipped because it remains a true permanent GAP. Human decides.
- **design-decisions placement.** The plan suggests the **Messages & Pipeline** section; confirm that section exists and is the best home (vs. a new bullet).
