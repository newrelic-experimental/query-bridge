# Splunk environment tokens (`$env:…$`) + colon/hyphen token names → unsupported — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop emitting parse-erroring NRQL template variables for two distinct token classes. (1) Splunk's `$env:…$` runtime-context namespace (current app/page/user/locale + user-profile) has no NR equivalent → `unsupported` in WHERE/value position, never a dead `{{env:app}}`. (2) Any other dashboard token whose **name** contains `:` or `-` cannot tokenize inside an NRQL `{{…}}` variable (a hard NRDB parse error, verified) → `unsupported`, never a parse-erroring `{{my-var}}`.

**Architecture:** No grammar change — the Peggy grammar already parses `env:app` and `my-var` as token names (the `template_var_name` charset includes `:` and `-`). The fix lives entirely in the IR-building stage (`src/input/spl/splToIR.js`): a module-scope `isEnvToken(name)` predicate plus two guards inserted at every site that currently emits `Identifier(`{{name}}`)`. There are four such sites, all in the `splToIR` walk: the unquoted comparison value (`field=$tok$` → `TemplateVariable` node), the quoted-standalone comparison value (`field="$tok$"` → string), the bare standalone `TemplateVariable` search term, and the wildcard-only LIKE path (`field="*$tok$*"`). Order at each site: env-prefix check first (more specific, semantic message), then the generic colon/hyphen check.

**Tech Stack:** Pure ESM JavaScript; IR node factories in `src/ir/nodes.js` (`Identifier`, `BinOp`, `Like`, `Not`); centralized message catalog in `src/messages.js` (handlers call `messages.key()` — never an inline string); Vitest data-driven `cases` array in `test/spl/spl.test.js`.

**Branch:** `feat/splunk-env-tokens` off `origin/master`. Spec: `docs/superpowers/specs/2026-06-27-splunk-env-tokens-design.md`.

## Global Constraints

- Dev requires **Node 24**: prefix every command `ASDF_NODEJS_VERSION=24.14.0` (hooks + commit need it).
- Run one package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- <filter>`.
- Conventional commits, lowercase subject ≤72 chars, body lines ≤100. `git commit -F <file>` for multi-line bodies. `git push origin HEAD` (never bare, never to master).
- **Loud failure over silent-wrong:** an `env:` token or a colon/hyphen token name → `messages.*` unsupported (the predicate is dropped from WHERE, the importer placeholders the panel), never a `{{…}}` that parse-errors at NRDB or silently never substitutes.
- Messages live in `src/messages.js`; handlers call `messages.key()` — no inline strings. **Message-key existence + exhaustiveness is enforced inside `test/spl/spl.test.js`** (the `translateSplToNrql` describe spies on every `messages` key: each listed `warningFunc`/`unsupportedFunc` key MUST fire and no unlisted key may fire — a misspelled/missing key makes `spies[fn]` undefined and the case fails). There is **no** separate `test/messages.test.js` in this repo.
- New/changed translations land at `verified: false` (a human promotes to `'llm'`/`'human'` later; AI may only set `false`).
- **`verified: false` for every new case.** These are `unsupported`-emitting cases (no NRQL reaches NRDB), so there is nothing to staging-validate as a value; the load-bearing fact (`{{env:app}}` / `{{my-var}}` are hard NRDB parse errors) is already verified in the spec (acct 1, `run_nerdgraph_query`).
- **No `npm run build:parsers`** — this plan touches no grammar. (If a future change edits `spl.grammar`, regen and commit `splParser.js`.)
- Use `'loglines'`, never Splunk's `'events'`, in any prose/comments.

## File Structure

- **Modify** `src/input/spl/splToIR.js` — add module-scope `isEnvToken(name)`; insert the env guard (Task 1) and the colon/hyphen guard (Task 2) at the four `{{name}}` emission sites.
- **Modify** `src/messages.js` — add `splunk_env_token` (Task 1) and `token_name_unsupported` (Task 2).
- **Modify** `test/spl/spl.test.js` — data-driven `cases` for both behaviors. Reuse the existing `doc: 'dashboard-time-tokens'` tag (the dashboard-token cases already use it — no new SPL_TO_NRQL.md sentinel needed).
- **Modify (Task 3 only)** `.claude/rules/design-decisions.md` and `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md`.

**Source landmarks confirmed (open them — line numbers drift):**
- `splToIR.js` ~373–379: unquoted `field=$tok$` (`value.type === 'TemplateVariable'`) → `BinOp(op, Identifier(field), Identifier(`{{${value.name}}}`))`.
- `splToIR.js` ~387–396: quoted standalone `field="$tok$"` — `value` is the string, `tokenOnly = /^\$([A-Za-z0-9_.:-]+)\$$/.exec(value)` → `Identifier(`{{${tokenOnly[1]}}}`)`.
- `splToIR.js` ~405–416: wildcard-only `field="*$tok$*"` → `Like(Identifier(field), `{{${wildcardToken[1]}}}`)` (+ `wildcard_token_like` warning); affixed → `affixed_token_unsupported`.
- `splToIR.js` ~579–597: `case 'TemplateVariable'` (bare search term) → after the time-token drop, `return Identifier(`{{${node.name}}}`)`.
- `messages.js` ~389–401: `affixed_token_unsupported` / `wildcard_token_like` — model the new keys' comment style on these.
- `test/spl/spl.test.js` ~777–858: existing dashboard-token cases, incl. `index=$idx$` → `WHERE index = {{idx}}` and `index="$env$"` → `WHERE index = {{env}}` (these ARE the normal-token + `$env$`-disambiguation regression — keep them green, do not duplicate).

---

### Task 1: Detect the `env:` namespace → `unsupported` in WHERE/value position

**Files:**
- Modify: `src/messages.js` — add `splunk_env_token`.
- Modify: `src/input/spl/splToIR.js` — add `isEnvToken`; guard the four `{{name}}` emission sites.
- Test: `test/spl/spl.test.js` — data-driven `cases`.

**Interfaces:**
- Consumes: `Identifier(name)`, `BinOp(op,left,right)`, `Like(field,pattern)`, `Not(child)` from `src/ir/nodes.js`; the in-scope `unsupported` / `warnings` arrays the `splToIR` walk already pushes to; `messages` (already imported in `splToIR.js`).
- Produces: `isEnvToken(name: string) → boolean` (module-scope, `true` iff `name` begins `env:`).

**Behavior (from the spec — Resolved decisions 1–3):** A token whose name begins `env:` (colon required) in filter/WHERE/value position → `unsupported` (`splunk_env_token`), never `{{env:…}}`. A plain `$env$` (no colon) is a normal user variable and is unchanged. `eval`-expression position already rejects any `$token$` as `unsupported` (no change here). The "drop env filters" opt-in flag (spec Option A / PR 2) is **out of scope** for this plan.

- [ ] **Step 1: Add failing data-driven `cases`** to the `cases` array in `test/spl/spl.test.js` (near the existing dashboard-token cases ~line 800):

```javascript
// Splunk $env:…$ runtime-context token in WHERE/value position → unsupported,
// NOT {{env:app}} (a hard NRDB parse error — ':' doesn't tokenize — with no
// backing variable). Quoted-standalone form (string value, tokenOnly regex site).
{
  spl: 'app="$env:app$" | stats count',
  unsupportedFunc: ['splunk_env_token'],
  doc: 'dashboard-time-tokens',
  verified: false,
},
// Unquoted form: hits the TemplateVariable-node comparison site.
{
  spl: 'app=$env:user$ | stats count',
  unsupportedFunc: ['splunk_env_token'],
  doc: 'dashboard-time-tokens',
  verified: false,
},
// Bare standalone env token (search-term position) → also unsupported, no {{}} leak.
{
  spl: 'index=web $env:page$ | stats count',
  unsupportedFunc: ['splunk_env_token'],
  doc: 'dashboard-time-tokens',
  verified: false,
},
// Multiple env tokens → splunk_env_token fires per token (exhaustive check still
// lists it once); no {{env:…}} anywhere. Both predicates drop from WHERE.
{
  spl: 'app="$env:app$" page="$env:page$" | stats count',
  unsupportedFunc: ['splunk_env_token'],
  doc: 'dashboard-time-tokens',
  verified: false,
},
// Wildcard-only wrap of an env token → unsupported too (not LIKE {{env:app}}).
{
  spl: 'app="*$env:app$*" | stats count',
  unsupportedFunc: ['splunk_env_token'],
  doc: 'dashboard-time-tokens',
  verified: false,
},
```

> **Disambiguation + normal-token regression are the EXISTING cases** at ~line 796/804: `index=$idx$ | stats count` → `WHERE index = {{idx}}` and `index="$env$" | stats count` → `WHERE index = {{env}}`. `$env$` has no colon, so `isEnvToken('env')` is false and it stays `{{env}}`. Do NOT duplicate these — just confirm they stay green.

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
  Expected: FAIL — `app="$env:app$"` etc. currently emit `WHERE app = {{env:app}}` and call NO message function, so the `unsupportedFunc: ['splunk_env_token']` expectation (spy never called) fails.

- [ ] **Step 3: Add the message** to `src/messages.js` (next to `affixed_token_unsupported` / `wildcard_token_like` ~line 389):

```javascript
  // SPL: `app="$env:app$"` — Splunk's $env:…$ runtime-context namespace (current
  // app/page/user/locale + user-profile fields the Splunk UI injects at render time).
  // NR dashboards expose no widget-level runtime-context token, and ':' cannot appear
  // inside an NRQL {{…}} variable (a hard NRDB parse error). So an env: token can never
  // become a faithful {{…}} — flag unsupported, never emit a dead {{env:…}}.
  splunk_env_token: (token) =>
    `$${token}$ is a Splunk runtime-context token (the $env:…$ namespace — current ` +
    'app/page/user/locale). New Relic dashboards have no equivalent runtime-context ' +
    'variable, and the colon cannot appear in an NRQL {{…}} template variable, so this ' +
    'filter cannot be translated. Remove the env-scoped filter or re-scope the widget ' +
    'with a New Relic template variable.',
```

- [ ] **Step 4: Implement** in `src/input/spl/splToIR.js`. First add the module-scope predicate (near the other top-level helpers, above `translateSplToNrql`):

```javascript
// A Splunk `$env:…$` runtime-context token (current app/page/user/locale + user-profile
// fields). Detected by the literal `env:` prefix — the colon is required, so a plain
// `$env$` user variable (no colon) is never reclassified. NR has no widget-level
// runtime-context token, so an env: token can never become a faithful {{…}} variable.
function isEnvToken(name) {
  return name.startsWith('env:');
}
```

Then guard each emission site (env check FIRST, before the existing `{{…}}` emit):

```javascript
// Site 1 — unquoted `field=$tok$` (TemplateVariable node), ~line 373:
if (value && typeof value === 'object' && value.type === 'TemplateVariable') {
  if (isEnvToken(value.name)) {
    unsupported.push(messages.splunk_env_token(value.name));
    return null;
  }
  return BinOp(op, Identifier(field), Identifier(`{{${value.name}}}`));
}

// Site 2 — quoted standalone `field="$tok$"`, ~line 387:
if (typeof value === 'string') {
  const tokenOnly = /^\$([A-Za-z0-9_.:-]+)\$$/.exec(value);
  if (tokenOnly) {
    if (isEnvToken(tokenOnly[1])) {
      unsupported.push(messages.splunk_env_token(tokenOnly[1]));
      return null;
    }
    return BinOp(op, Identifier(field), Identifier(`{{${tokenOnly[1]}}}`));
  }
}

// Site 3 — wildcard-only `field="*$tok$*"`, inside the existing
// `if (wildcardToken && value.includes('*'))` block (~line 407), before the Like():
if (isEnvToken(wildcardToken[1])) {
  unsupported.push(messages.splunk_env_token(wildcardToken[1]));
  return null;
}

// Site 4 — bare standalone `case 'TemplateVariable'` (~line 596), after the
// time-token drop, before `return Identifier(`{{${node.name}}}`)`:
if (isEnvToken(node.name)) {
  unsupported.push(messages.splunk_env_token(node.name));
  return null;
}
```

- [ ] **Step 5: Run, confirm green** (`-- spl.test`): the five new cases pass; the existing `index=$idx$` / `index="$env$"` cases stay green. Then the whole package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge` — no regressions.

- [ ] **Step 6: CLI spot-check.** `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'app="$env:app$" | stats count'` — confirm it reports `unsupported` (the `splunk_env_token` text) and emits NO `{{env:app}}`. Spot-check `app="$env$" | stats count` still emits `WHERE app = {{env}}`.

- [ ] **Step 7: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/messages.js packages/nr-query-bridge/src/input/spl/splToIR.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: flag splunk \$env:…\$ runtime-context tokens unsupported"
```

---

### Task 2: Colon/hyphen token names → `unsupported` (the cross-cutting tokenizer bug)

> **Scope note (spec tension — read before building):** The spec's *Problem* section documents this colon/hyphen bug as a **distinct, cross-cutting finding** and says *"This spec fixes only the `env:` case"*, proposing the hyphen bug be filed as **its own laundry-list row**. The team-lead direction overrides: fix it **here**, with tests. This task implements the loud-failure fix; Task 3 files/reclassifies the row. If the executing human prefers to ship Task 1 alone and defer this, Task 2 is cleanly separable (its own PR) — see **Double-check targets**.

**Files:**
- Modify: `src/messages.js` — add `token_name_unsupported`.
- Modify: `src/input/spl/splToIR.js` — at the same four sites, after the `isEnvToken` check, reject any remaining name containing `:` or `-`.
- Test: `test/spl/spl.test.js` — data-driven `cases`.

**Interfaces:** same IR factories + in-scope `unsupported` array as Task 1. Add a module-scope predicate `hasUntranslatableTokenChar(name) → boolean` (`true` iff `name` contains `:` or `-`).

**Behavior:** Any dashboard token whose **name** contains `:` or `-` would emit `{{name}}` / `LIKE {{name}}`, which is a hard NRDB parse error (`:`/`-` do not tokenize inside `{{…}}` — verified end-to-end in the spec: `host="$my-var$"` → `WHERE hostname = {{my-var}}` → `unexpected '…{{my-'`). Loud-failure → `unsupported`, dropping the predicate so the importer placeholders the panel. **Ordering:** `isEnvToken` is checked first at every site, so an `env:` token keeps the more-specific `splunk_env_token` message; a non-env colon/hyphen name (e.g. `a:b`, `my-var`) gets `token_name_unsupported`. A clean name (letters/digits/`_`/`.`) is unaffected.

- [ ] **Step 1: Add failing `cases`** to `test/spl/spl.test.js` (next to the Task 1 cases):

```javascript
// A (non-env) dashboard token whose NAME contains '-' → unsupported. Emitting
// {{my-var}} is a hard NRDB parse error ('-' doesn't tokenize — verified acct 1).
{
  spl: 'host="$my-var$" | stats count',
  unsupportedFunc: ['token_name_unsupported'],
  doc: 'dashboard-time-tokens',
  verified: false,
},
// A non-env colon token (NOT the env: namespace) → unsupported (':' doesn't tokenize).
{
  spl: 'host="$a:b$" | stats count',
  unsupportedFunc: ['token_name_unsupported'],
  doc: 'dashboard-time-tokens',
  verified: false,
},
// Unquoted hyphen token (TemplateVariable-node site) → unsupported too.
{
  spl: 'host=$my-var$ | stats count',
  unsupportedFunc: ['token_name_unsupported'],
  doc: 'dashboard-time-tokens',
  verified: false,
},
```

> **Ordering regression is guarded by the EXISTING Task-1 case** `app="$env:app$"` (pins `splunk_env_token`). If the generic guard wrongly fired first, that case would flip to `token_name_unsupported` and fail — so no separate ordering case is needed (and adding one would duplicate the spl). The clean-name regression is the existing `index=$idx$` → `{{idx}}` case.

- [ ] **Step 2: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
  Expected: FAIL — `host="$my-var$"` currently emits `WHERE host = {{my-var}}` (or `WHERE hostname = {{my-var}}`) and calls no message function, so `token_name_unsupported` (spy never called) fails.

- [ ] **Step 3: Add the message** to `src/messages.js` (next to `splunk_env_token`):

```javascript
  // SPL: `host="$my-var$"` / `$a:b$` — a (non-env) dashboard token whose NAME contains
  // ':' or '-'. Those chars do not tokenize inside an NRQL {{…}} variable, so emitting
  // {{my-var}} is a hard NRDB parse error (verified acct 1). The variable itself is
  // legitimate (unlike env:, which has no NR equivalent at all) — but the NAME is
  // untranslatable. Loud failure over a parse-erroring {{…}}.
  token_name_unsupported: (name) =>
    `$${name}$ is a dashboard token whose name contains ':' or '-', which New Relic's ` +
    "{{…}} template-variable syntax does not allow (it is a hard NRQL parse error). " +
    "Rename the dashboard variable to use only letters, digits, '_', and '.', or remove " +
    'the filter.',
```

- [ ] **Step 4: Implement** in `src/input/spl/splToIR.js`. Add the predicate next to `isEnvToken`:

```javascript
// A token NAME containing ':' or '-' cannot tokenize inside an NRQL {{…}} variable
// (a hard NRDB parse error — verified acct 1). Emitted as {{name}} it would not run.
function hasUntranslatableTokenChar(name) {
  return name.includes(':') || name.includes('-');
}
```

Then, at each of the four sites, insert the generic check IMMEDIATELY AFTER the `isEnvToken` guard (so env: keeps its specific message), before the `{{…}}` emit. E.g. Site 2 (quoted standalone) becomes:

```javascript
  if (tokenOnly) {
    if (isEnvToken(tokenOnly[1])) {
      unsupported.push(messages.splunk_env_token(tokenOnly[1]));
      return null;
    }
    if (hasUntranslatableTokenChar(tokenOnly[1])) {
      unsupported.push(messages.token_name_unsupported(tokenOnly[1]));
      return null;
    }
    return BinOp(op, Identifier(field), Identifier(`{{${tokenOnly[1]}}}`));
  }
```

Apply the same two-line `hasUntranslatableTokenChar` block after the `isEnvToken` block at Site 1 (unquoted, `value.name`), Site 3 (wildcard, `wildcardToken[1]`), and Site 4 (bare `case 'TemplateVariable'`, `node.name`).

- [ ] **Step 5: Run, confirm green** (`-- spl.test`): the three new cases pass; Task-1 cases + existing token cases stay green. Then whole-package — no regressions.

- [ ] **Step 6: CLI spot-check.** `ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js 'host="$my-var$" | stats count'` — reports `token_name_unsupported`, emits NO `{{my-var}}`. Re-confirm `app="$env:app$"` still reports `splunk_env_token` (ordering).

- [ ] **Step 7: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/messages.js packages/nr-query-bridge/src/input/spl/splToIR.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: flag colon/hyphen dashboard token names unsupported"
```

---

### Task 3: Fuzz, graduate (docs + laundry-list reclass)

> **Ordering gate:** This task edits `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md`, which **PR #72 also adds/edits** (task #85, the spec-landing PR). This branch is cut off `master` AFTER #72 merges; do Task 3 only once #72 is on `master`, or expect a conflict on the laundry-list file. (Tasks 1–2 touch only `src/` + `test/` and are unaffected.)

**Files:**
- Modify: `.claude/rules/design-decisions.md` (extend the Dashboard-tokens invariant)
- Modify: `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` (reclassify rows)
- (Optional) Modify: `test/spl/spl.test.js` (`verified: false` → `'llm'`)

- [ ] **Step 1: Fuzz ×20** (mandated for any translator change; reseeds each run, so one green is a false-green):

```bash
for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done
```

- [ ] **Step 2: Extend the Dashboard-tokens invariant** in `.claude/rules/design-decisions.md` (the existing "**Dashboard tokens → `{{tok}}`, bare / value / quoted**" bullet under *Dashboard Importer*). Append:

```markdown
  A token whose name begins `env:` (Splunk's `$env:…$` runtime-context namespace — current
  app/page/user/locale + user-profile) → `unsupported` (`splunk_env_token`) in WHERE/value
  position, never `{{env:…}}` (NR has no widget runtime-context token; `:` is also a hard NRDB
  `{{…}}` parse error). A plain `$env$` (no colon) is a normal variable, unchanged. Any OTHER
  token whose NAME contains `:` or `-` → `unsupported` (`token_name_unsupported`) — those chars
  do not tokenize inside `{{…}}` (verified acct 1), so `{{my-var}}` is a hard NRDB parse error.
  Both guards live at the four `{{name}}` emission sites in `splToIR.js`, env-prefix checked
  first; `isEnvToken` / `hasUntranslatableTokenChar` are the predicates.
```

- [ ] **Step 3: Reclassify the laundry-list rows.** In `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md`:
  - `splunk-env-tokens` row: change status from open BUG to **FIXED** (env: tokens now emit `unsupported`; reference branch `feat/splunk-env-tokens`).
  - Add (or mark FIXED) the cross-cutting **colon/hyphen token-name** row the spec called for filing — note it shipped in the same branch (`token_name_unsupported`). Per the spec, this was a distinct finding; record it explicitly rather than folding it silently into the env row.

- [ ] **Step 4 (optional): Promote cases.** Only a human promotes to `'human'`. AI may set `'llm'` after the `validate-test-cases` skill confirms behavior; for these `unsupported` cases (no NRQL on NRDB) the load-bearing fact is the spec's verified parse-error, so promotion is a human call — leave at `verified: false` unless a human directs otherwise.

- [ ] **Step 5: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add .claude/rules/design-decisions.md docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: graduate splunk env-token + token-name fixes"
```

---

## Global Verification

- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm test` — full workspace suite green.
- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check` — clean.
- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run format:check` (prettier) — clean.
- [ ] No `npm run build:parsers` needed — no grammar change (confirm `git status` shows `splParser.js` unchanged).
- [ ] Fuzz ×20 green (Task 3 Step 1).
- [ ] CLI smoke: `$env:app$` → `splunk_env_token`; `$my-var$` → `token_name_unsupported`; `$env$`/`$idx$` → `{{…}}` unchanged.
- [ ] Open the PR(s); invoke `write-gooder` for the body (100–200 words, summary + test plan). Land per repo mechanics (`--rebase`, `sidekick:approved` label, AI can't self-approve).

## Self-Review

1. **Spec coverage:** env: detection in WHERE/value position incl. quoted, unquoted, bare, and wildcard sites + multi-token + `$env$` disambiguation + normal-token regression (Task 1) ✓; the cross-cutting colon/hyphen token-name bug the spec flagged → loud `unsupported` (Task 2, with the spec-tension callout) ✓; fuzz + graduate + laundry-list reclass (Task 3) ✓. The opt-in "drop env filters" flag (spec PR 2, Optional/gated) is explicitly out of scope.
2. **Loud-failure:** every guard pushes `unsupported` and returns `null` (predicate dropped, panel placeholdered) — never a `{{…}}` that parse-errors at NRDB or silently never substitutes.
3. **Type/factory consistency:** uses only `Identifier`, `BinOp`, `Like`, `Not` (existing `src/ir/nodes.js` factories); no new IR node, no grammar/parser change. Predicates return `boolean`.
4. **Message consistency:** two new keys (`splunk_env_token`, `token_name_unsupported`) referenced only via `cases` `unsupportedFunc` arrays; existence + exhaustiveness enforced by the `spl.test.js` spy runner (no separate `messages.test.js`).
5. **Ordering:** `isEnvToken` precedes `hasUntranslatableTokenChar` at all four sites (env: would otherwise be swallowed by the generic colon guard); enforced by the existing `app="$env:app$"` case staying on `splunk_env_token`.
6. **No-leak:** all four `{{name}}` emission sites are guarded, so no `{{env:…}}` or `{{name-with-dash}}` can reach NRQL from any token position.

## Execution Handoff

Plan complete, saved to `docs/superpowers/plans/2026-06-28-splunk-env-tokens.md`. Branch `feat/splunk-env-tokens` is cut off `master` **after PR #72 lands** (task #85; needed for Task 3's laundry-list edit). Recommended path: run `/double-check` on this plan (clean-room test list for the env: + colon/hyphen behavior), resolve the **Double-check targets** below, then execute via subagent-driven-development. Tasks 1 and 2 are independent reviewable PRs; Task 3 is docs-only and gated on #72.

## Double-check targets (flagged uncertainties — resolve before/while building)

1. **Spec-vs-direction conflict on the hyphen fix (Task 2).** The spec says *"This spec fixes only the `env:` case"* and proposes filing the colon/hyphen bug as a **separate laundry-list row** (not fixing it here). The team-lead direction is to fix it in this plan, with tests. The plan implements it (Task 2) but keeps it a separable PR. **Confirm the human wants Task 2 in this branch** vs. split to its own ticket (task #92 "token-in-lhs" is a *different* token bug — LHS/grammar — not this name-charset bug; don't conflate).
2. **Fix shape for colon/hyphen names: `unsupported` vs sanitize.** The spec floats two remedies: *"the importer must sanitize `:`/`-` out of emitted `{{…}}` names, or unsupport them."* This plan chose **unsupport** (loud-failure; the translator has no view of the importer's variable-definition names, so sanitizing the usage would desync it from the `variable {}` block the importer emits). If the human prefers sanitize, that is an **importer-side** change (coordinate name-mangling across definition + usage), not this translator change — re-scope accordingly.
3. **Exact NRQL byte-shapes / field handling.** Test `nrql` for the regression cases (`index=$idx$`, `app="$env$"`) is copied from existing green cases; the new cases pin only `unsupportedFunc` (no `nrql`). Still byte-confirm via `node bin/spl2nrql.js` in each Step 6 — in particular that `host=` is emitted as `host` (not remapped) and that a dropped-predicate search with `| stats count` yields `FROM Log SELECT count(*)` with no stray `WHERE`.
4. **Bare/wildcard env coverage is belt-and-suspenders.** Sites 3 (wildcard) and 4 (bare search term) are guarded for completeness; the spec's acceptance criteria are all comparison-position. If a reviewer wants the change minimal-to-spec, Sites 3–4 guards (and their cases: `app="*$env:app$*"`, `index=web $env:page$`) can be dropped — but that re-opens a `{{env:…}}` leak from those positions. Recommend keeping them.
5. **`doc:` tag reuse.** New cases use `doc: 'dashboard-time-tokens'` (the tag the existing token cases use) so no new `SPL_TO_NRQL.md` sentinel is required. Confirm the doc generator is happy (the `every case has a doc: tag` test + `afterAll` regen) — it should be, since the tag already has a sentinel/table entry.
