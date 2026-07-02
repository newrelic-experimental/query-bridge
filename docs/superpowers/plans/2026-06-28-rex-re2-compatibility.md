# rex → `capture()` RE2-compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the translator silently emitting `capture()` patterns that NRQL's RE2/J-backed regex engine rejects at runtime. During `rex`→`capture()` conversion, gate the emitted pattern through a faithful pure-JS RE2 oracle (`re2js`); if RE2 can't compile it (backreferences, atomic groups, possessive quantifiers, recursion, conditionals, …), emit `unsupported` instead of a `capture()` that breaks live. A thin token layer phrases construct-specific messages; anything else surfaces re2js's own reason.

**Architecture:** A new pure module `src/input/spl/re2Compat.js` owns two functions: `getRe2Compatibility(pattern) → {compatible, reason}` (compile via `RE2JS.compile`, catch → `{compatible:false, reason}`) is the authoritative gate; `resolveConstructMessageKey(pattern) → string|null` is a **naive** token-layer probe that names the common construct for a friendly message. `handleRex` (`src/input/spl/extractionHandlers.js`) calls the gate on the fully-assembled `fullPattern` right before building the `capture()` `Func`; on rejection it pushes the construct-specific message (if the token layer knows it) or the generic re2js-reason message, then returns without emitting. The existing lookaround early-return stays as-is. **Key safety property:** the naive token layer is only ever consulted *after* the gate has rejected, so it cannot false-flag an accepted pattern (e.g. `\\1` — an escaped backslash + literal `1` — compiles fine, so the token layer never sees it; no escape-parity logic needed).

**Tech Stack:** Pure ESM JavaScript; new runtime dependency `re2js` (`>=2.8.3`, MIT, 0 transitive deps — the translator package's **first** runtime dep, explicitly sanctioned in `.claude/rules/design-decisions.md` → "Dependency direction"); IR node factories in `src/ir/nodes.js` (`Func`, `Identifier`, `Regex`, `Binding`); message catalog in `src/messages.js`; Vitest (unit tests for the new module + the data-driven `cases` array in `test/spl/spl.test.js`).

**Branch:** `feat/rex-re2` off `origin/master`. Spec: `docs/superpowers/specs/2026-06-27-rex-re2-compatibility-design.md`.

## Global Constraints

- Dev requires **Node 24**: prefix every command `ASDF_NODEJS_VERSION=24.14.0` (hooks + commit need it).
- Run one package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- <filter>`.
- Conventional commits, lowercase subject ≤72 chars, body lines ≤100. `git commit -F <file>` for multi-line bodies. `git push origin HEAD` (never bare, never to master).
- **Loud failure over silent-wrong:** any regex feature RE2 rejects (backreferences `\1`…`\9` — **including inside a character class** — named backrefs `(?P=name)`/`\k<name>`, lookaround, atomic groups `(?>…)`, possessive quantifiers `*+`/`++`/`?+`/`{n,m}+`, recursion `(?R)`/`(?1)`/`\g<…>`, conditionals `(?(1)…)`) → `messages.*` `unsupported`, **never** a non-compiling or altered `capture()`.
- **Do NOT reject inline flags:** bare `(?i)`/`(?m)`/`(?s)` AND scoped `(?i:…)` run clean in `capture()` (staging-verified). The gate must accept them — re2js does.
- Messages live in `src/messages.js`; handlers call `messages.key()` — no inline strings. Message-key consistency is enforced inside `test/spl/spl.test.js` (the `translateSplToNrql` describe block spies on every `messages` key: each `warningFunc`/`unsupportedFunc` entry must fire, and **no unlisted key may fire** — the arrays are exhaustive). There is no separate `test/messages.test.js`.
- New/changed translations land at `verified: false` (only a human promotes to `'llm'`/`'human'`).
- Every `cases` entry MUST carry a `doc:` tag (an AI-DEV-protected test enforces it — use `doc: 'fields-rex-pcre'` for the RE2-reject cases, matching the existing lookaround case).
- Adding `re2js` edits `packages/nr-query-bridge/package.json` — use a **`>=` floor** (`">=2.8.3"`), never an exact pin.
- Writing convention: call raw records **"loglines"**, never Splunk's "events".
- Fuzz reseeds each run — a single green is a false-green. Loop ×20 before trusting a translator change.

## File Structure

- **Create** `src/input/spl/re2Compat.js` — the pure RE2-compatibility gate + token-layer construct probe. One responsibility: "does RE2 accept this pattern, and if not, which known construct caused it?" No IR, no message strings (returns message *keys*).
- **Create** `test/spl/re2Compat.test.js` — explicit unit tests (one scenario per `it()`, per project test-authoring style; NOT a fixture loop), including the **fidelity gate** asserting re2js's accept/reject matches `capture()`'s staging-verified set.
- **Modify** `packages/nr-query-bridge/package.json` — add `dependencies: { "re2js": ">=2.8.3" }`; refresh the root lockfile.
- **Modify** `src/input/spl/extractionHandlers.js` — wire the gate into `handleRex` (between `fullPattern` assembly at ~line 65 and the `capture()` `Func` at ~line 69); import from `./re2Compat.js`.
- **Modify** `src/messages.js` — add `rex_backreference`, `rex_re2_incompatible` (PR1); `rex_atomic_group`, `rex_possessive_quantifier`, `rex_recursion`, `rex_conditional` (PR2).
- **Modify** `test/spl/spl.test.js` — data-driven `cases` for the reject + no-regression behavior.
- **Modify (Task 4)** `.claude/rules/design-decisions.md` and `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md`.

**PR mapping (per the spec's PR breakdown):** PR1 = Tasks 1–2 (dep + gate + backref message + cases); PR2 = Task 3 (friendly messages for the remaining constructs); PR3 = Task 4 (graduate docs + reclass + file two follow-ups). Land stacked off `feat/rex-re2` in that order.

---

### Task 1: Add `re2js` + the pure `re2Compat.js` gate + fidelity tests (inert)

**Files:**
- Modify: `packages/nr-query-bridge/package.json`
- Create: `src/input/spl/re2Compat.js`
- Test: `test/spl/re2Compat.test.js`

**Interfaces:**
- `getRe2Compatibility(pattern: string) → { compatible: boolean, reason: string|null }`. Compiles via `RE2JS.compile`; on success `{compatible:true, reason:null}`, on throw `{compatible:false, reason: err.message}`.
- `resolveConstructMessageKey(pattern: string) → string|null`. Naive token probe → a `messages` key for a known RE2-incompatible construct, else `null`. **PR1 scope: backreferences only** (numbered `\1`…`\9`, named `\k<…>`/`(?P=…)`); the remaining constructs are added in Task 3.

**Dependency-verification note (record in the PR description — per `.claude/rules/security.md` "Library Verification"):**
- **Package:** `re2js` on npm — verified 2026-06-28 against `https://registry.npmjs.org/re2js/latest`.
- **Latest:** `2.8.4` (spec spot-checked `2.8.3`; floor `>=2.8.3` admits both). **License:** MIT (compatible with this Apache-2.0 package; not in the prohibited reciprocal set). **Runtime deps:** none (no `dependencies` key in its manifest — keeps the translator's transitive surface at zero). **Module:** ships ESM (`build/index.js`) + CJS; `type:module`; `engines.node >=18` (our consumers need `>=20`, fine). **Publisher/repo:** `github:le0pard/re2js`, author Oleksii Vasyliev, maintainer `leopard_me`, published via GitHub Actions trusted publisher. Widely used (Kibana, Zulip, RSSHub).
- **Why a runtime dep is justified here** (overrides the package's zero-dep default): re2js *is* a pure-JS port of `re2j`, the exact engine behind NRQL `capture()`. "Does re2js compile this?" ≈ "will `capture()` accept it?" authoritatively, catching un-enumerated incompatibilities a hand-rolled scanner would miss. The translator is destined for the NR Logs UI (a JS web app), where the lib's footprint is negligible. Sanctioned in `.claude/rules/design-decisions.md` → "Dependency direction".
- **Publish follow-up (not a PR blocker):** the first runtime dep means `THIRD_PARTY_NOTICES.md` must include re2js before any `npm publish` (regenerated via FOSSA/OSPO tooling — tracked in NR-578293); FOSSA license scan should confirm MIT.

- [ ] **Step 1: Add the dependency.** Edit `packages/nr-query-bridge/package.json` to add (after `"engines"`):

```json
  "dependencies": {
    "re2js": ">=2.8.3"
  },
```

Then refresh the root lockfile (network install of one MIT 0-dep package):

```bash
ASDF_NODEJS_VERSION=24.14.0 npm install
```

Confirm: `re2js` appears under `packages/nr-query-bridge` in `package-lock.json` and `node -e` is **not** needed — verify by import in the tests below.

- [ ] **Step 2: Write the failing unit tests** in `test/spl/re2Compat.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import {
  getRe2Compatibility,
  resolveConstructMessageKey,
} from '../../src/input/spl/re2Compat.js';

describe('getRe2Compatibility', () => {
  // ── Fidelity gate: these accept/reject verdicts are the staging-verified
  // capture() behaviour (spec §"Pre-adoption gate"). If re2js ever diverges,
  // this suite fails and the gate is no longer trustworthy.
  it('accepts a plain named-group pattern', () => {
    expect(getRe2Compatibility('user=(?P<user_id>\\w+)').compatible).toBe(true);
  });
  it('accepts a bare inline flag', () => {
    expect(getRe2Compatibility('(?i)foo(?P<a>\\w+)').compatible).toBe(true);
  });
  it('accepts a scoped inline flag', () => {
    expect(getRe2Compatibility('(?i:foo)(?P<a>\\w+)').compatible).toBe(true);
  });
  it('accepts an escaped backslash followed by a digit (not a backref)', () => {
    expect(getRe2Compatibility('a\\\\1b').compatible).toBe(true);
  });
  it('rejects a numbered backreference and reports a reason', () => {
    const r = getRe2Compatibility('(?P<a>\\w+)=\\1');
    expect(r.compatible).toBe(false);
    expect(r.reason).toBeTruthy();
  });
  it('rejects a backreference inside a character class', () => {
    expect(getRe2Compatibility('x[\\1]y(?P<a>\\w+)').compatible).toBe(false);
  });
  it('rejects lookahead', () => {
    expect(getRe2Compatibility('(?=foo)(?P<a>\\w+)').compatible).toBe(false);
  });
  it('rejects lookbehind', () => {
    expect(getRe2Compatibility('(?<=foo)(?P<a>\\w+)').compatible).toBe(false);
  });
  it('rejects an atomic group', () => {
    expect(getRe2Compatibility('(?>(?P<a>\\w+))').compatible).toBe(false);
  });
  it('rejects a possessive quantifier', () => {
    expect(getRe2Compatibility('(?P<a>\\w++)').compatible).toBe(false);
  });
});

describe('resolveConstructMessageKey', () => {
  it('names a numbered backreference', () => {
    expect(resolveConstructMessageKey('(?P<a>\\w+)=\\1')).toBe('rex_backreference');
  });
  it('names a named backreference (\\k<name>)', () => {
    expect(resolveConstructMessageKey('(?P<a>\\w+)\\k<a>')).toBe('rex_backreference');
  });
  it('names a named backreference ((?P=name))', () => {
    expect(resolveConstructMessageKey('(?P<a>\\w+)(?P=a)')).toBe('rex_backreference');
  });
  it('returns null for a pattern with no known construct', () => {
    expect(resolveConstructMessageKey('(?>(?P<a>\\w+))')).toBeNull();
  });
});
```

> **Note on `\\\\1` (Step 2, line "escaped backslash"):** in a JS string `'a\\\\1b'` the runtime characters are `a \ \ 1 b` — RE2 reads `\\` as a literal backslash then `1` as a literal digit, so it compiles. This proves the gate does not false-reject escaped backslashes — the reason the token layer can stay naive.

- [ ] **Step 3: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- re2Compat`
  Expected: FAIL — module missing / functions undefined.

- [ ] **Step 4: Implement** `src/input/spl/re2Compat.js`:

```javascript
/**
 * RE2-compatibility gate for rex → capture() conversion.
 *
 * NRQL capture() is backed by RE2/J (com.google.re2j). re2js is the pure-JS
 * port of the same engine, so "does re2js compile this pattern?" authoritatively
 * answers "will capture() accept it at runtime?" — including constructs no
 * hand-maintained list enumerates. getRe2Compatibility is the gate;
 * resolveConstructMessageKey is a naive token probe used ONLY to phrase a
 * friendlier message after the gate has already rejected (so it never has to
 * distinguish a real backref from an escaped backslash — the gate did that).
 */
import { RE2JS } from 're2js';

/**
 * @param {string} pattern
 * @returns {{ compatible: boolean, reason: string|null }}
 */
export function getRe2Compatibility(pattern) {
  try {
    RE2JS.compile(pattern);
    return { compatible: true, reason: null };
  } catch (err) {
    return { compatible: false, reason: err && err.message ? err.message : String(err) };
  }
}

// Naive construct probes — message-quality only, consulted post-rejection.
// PR1: backreferences. Task 3 extends this list (atomic/possessive/recursion/
// conditional). Order is irrelevant since the gate has already rejected.
const CONSTRUCT_PROBES = [
  // numbered \1..\9, named \k<name>, named (?P=name)
  { re: /\\[1-9]|\\k<|\(\?P=/, key: 'rex_backreference' },
];

/**
 * @param {string} pattern
 * @returns {string|null} a messages key, or null if no known construct matches
 */
export function resolveConstructMessageKey(pattern) {
  for (const probe of CONSTRUCT_PROBES) {
    if (probe.re.test(pattern)) return probe.key;
  }
  return null;
}
```

- [ ] **Step 5: Run, confirm green** (same command). All `re2Compat` tests pass.

- [ ] **Step 6: Post-hoc test review.** Re-read `re2Compat.test.js`: every test name matches its assertion; the accept/reject set is the staging-verified one; no trivially-passing tests. (Do NOT add AI-DEV markers yet — those go on only after the full red-green/mutation cycle in a later hardening pass.)

- [ ] **Step 7: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/package.json package-lock.json \
  packages/nr-query-bridge/src/input/spl/re2Compat.js \
  packages/nr-query-bridge/test/spl/re2Compat.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: add re2js RE2-compatibility gate for rex (inert)"
```

---

### Task 2: Wire the gate into `handleRex` + backreference message + cases

**Files:**
- Modify: `src/input/spl/extractionHandlers.js` — add the gate call in `handleRex`; add `re2Compat.js` to the imports.
- Modify: `src/messages.js` — add `rex_backreference`, `rex_re2_incompatible`.
- Test: `test/spl/spl.test.js` (data-driven `cases`).

**Interfaces:**
- Consumes: `getRe2Compatibility(pattern) → {compatible, reason}`, `resolveConstructMessageKey(pattern) → string|null` (Task 1); `messages[key]()` from `src/messages.js`.

**Behavior (from the spec):** during conversion, gate the assembled `fullPattern` through `getRe2Compatibility`. On rejection, push a construct-specific message if the token layer names one, else `rex_re2_incompatible(reason)`, and **return without emitting** the `capture()`. RE2-supported patterns translate unchanged (no regression). The existing `mode=sed`, `rex_no_groups`, `max_match`, and lookaround paths are untouched.

- [ ] **Step 1: Add the messages** to `src/messages.js`, next to the other `rex_*` keys (~line 28, after `rex_lookaround`):

```javascript
  // SPL: `* | rex field=x "(?<a>\\w+)=\\1"` (backreference — \1..\9, \k<name>, (?P=name))
  rex_backreference: () =>
    'rex pattern uses a backreference (\\1, \\k<name>, or (?P=name)), which NRQL capture() (RE2) does not support; rewrite the regex without backreferences',

  // SPL: any rex pattern RE2 rejects without a more specific message
  rex_re2_incompatible: (reason) =>
    `rex pattern is not compatible with NRQL capture() (RE2): ${reason}; rewrite the regex without the unsupported construct`,
```

- [ ] **Step 2: Add failing data-driven `cases`** to the `cases` array in `test/spl/spl.test.js`, in the rex PCRE section (~line 1980, next to the lookaround case):

```javascript
  // backreference — capture() (RE2) rejects \1 at runtime; must be loud, not a
  // silently-broken capture() (the confirmed-live bug).
  {
    spl: '* | rex field=x "(?<a>\\w+)=\\1"',
    unsupportedFunc: ['rex_backreference'],
    doc: 'fields-rex-pcre',
    verified: false,
  },
  // backreference inside a character class — NOT a preserved literal in RE2;
  // capture() rejects `\1` everywhere (staging-verified).
  {
    spl: '* | rex field=x "x[\\1]y(?<a>\\w+)"',
    unsupportedFunc: ['rex_backreference'],
    doc: 'fields-rex-pcre',
    verified: false,
  },
  // no-regression: a plain named group still translates unchanged.
  {
    spl: '* | rex field=x "user=(?<user_id>\\w+)"',
    nrql: "FROM Log WITH capture(x, r'.*user=(?P<user_id>\\w+).*') AS (user_id) SELECT *",
    doc: 'fields-rex-pcre',
    verified: false,
  },
  // no-regression: multi-capture destructuring still translates (staging-valid).
  {
    spl: '* | rex field=x "(?<a>\\w+) (?<b>\\w+)"',
    nrql: "FROM Log WITH capture(x, r'.*(?P<a>\\w+) (?P<b>\\w+).*') AS (a, b) SELECT *",
    doc: 'fields-rex-pcre',
    verified: false,
  },
```

> **Confirm the `nrql` strings byte-for-byte** with `node bin/spl2nrql.js` in Step 5 — the field name (`x`), the `.*` prefix/suffix wrapping, and the `(?P<…>)` conversion must match exactly. The existing rex cases (e.g. `* | rex field=message "(?<ip>…)"`) show the shape; copy it precisely.

- [ ] **Step 3: Run, confirm red.** `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl.test`
  Expected: FAIL — the two backref cases currently emit a (broken) `capture()` so `unsupportedFunc` does not match; `rex_backreference` is not yet wired.

- [ ] **Step 4: Implement** the gate in `handleRex` (`src/input/spl/extractionHandlers.js`). First add to the imports at the top of the file:

```javascript
import {
  getRe2Compatibility,
  resolveConstructMessageKey,
} from './re2Compat.js';
```

Then insert the gate between the `fullPattern` assembly (~line 65) and the `capture()` construction (~line 69):

```javascript
  const fullPattern = `${prefix}${normalizedPattern}${suffix}`;

  // RE2-compatibility gate: capture() is backed by RE2/J, which rejects
  // backreferences, atomic groups, possessive quantifiers, recursion, and
  // conditionals. re2js is a faithful RE2 oracle — if it can't compile the
  // emitted pattern, capture() will reject it at runtime. Emit unsupported
  // (loud) rather than a capture() that breaks live. (Lookaround is caught
  // above with its own message.)
  const { compatible, reason } = getRe2Compatibility(fullPattern);
  if (!compatible) {
    const key = resolveConstructMessageKey(cmd.pattern);
    if (key) {
      ir.unsupported.push(messages[key]());
    } else {
      ir.unsupported.push(messages.rex_re2_incompatible(reason));
    }
    return;
  }

  // Single capture() call with tuple destructuring for multiple groups:
  // WITH capture(field, r'...(?P<a>...)...(?P<b>...)...') AS (a, b)
  const captureExpr = Func('capture', [Identifier(field), Regex(fullPattern)]);
```

> The gate runs on `fullPattern` (the exact pattern reaching `capture()`); the token-layer message is keyed off `cmd.pattern` (the user's raw regex — the `.*` wrapping doesn't change which construct is present).

- [ ] **Step 5: CLI spot-check + match the test `nrql`.** Confirm the reject and no-regression shapes:

```bash
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | rex field=x "(?<a>\w+)=\1"'
ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js '* | rex field=x "user=(?<user_id>\w+)"'
```

The first must show `unsupported` (backreference), no NRQL; the second must show the `capture(x, r'.*user=(?P<user_id>\w+).*') AS (user_id)` NRQL. Fix the test `nrql` strings if the projection differs.

- [ ] **Step 6: Run, confirm green** (`-- spl.test`), then the whole package: `ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge`. No regressions — every existing rex case (named/multi-capture/char-class) still emits its `capture()`; the real-world suite still passes (spec census: 0 clean/warning outputs carry an RE2-incompatible marker, so none flip to unsupported).

- [ ] **Step 7: Fuzz ×20.**

```bash
for i in $(seq 1 20); do ASDF_NODEJS_VERSION=24.14.0 npm run test --workspace=@newrelic/query-bridge -- spl-fuzz || break; done
```

- [ ] **Step 8: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/extractionHandlers.js \
  packages/nr-query-bridge/src/messages.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: gate rex capture() through re2js, reject backreferences"
```

> **PR1 = Tasks 1 + 2** (two commits). Open it after Task 2; PR2 (Task 3) stacks on top.

---

### Task 3 (PR2): Friendly messages for the remaining RE2-incompatible constructs

> The re2js gate (Task 2) **already rejects** atomic groups, possessive quantifiers, recursion/subroutines, and conditionals — today they surface the generic `rex_re2_incompatible(reason)`. This task only upgrades the *message quality* by teaching the naive token layer to name them. No correctness change; it cannot regress the gate.

**Files:**
- Modify: `src/input/spl/re2Compat.js` — extend `CONSTRUCT_PROBES`.
- Modify: `src/messages.js` — add `rex_atomic_group`, `rex_possessive_quantifier`, `rex_recursion`, `rex_conditional`.
- Test: `test/spl/re2Compat.test.js` (probe unit tests), `test/spl/spl.test.js` (case-level messages + scoped-flag regression).

- [ ] **Step 1: Add failing probe unit tests** to `test/spl/re2Compat.test.js` (in the `resolveConstructMessageKey` describe):

```javascript
  it('names an atomic group', () => {
    expect(resolveConstructMessageKey('(?>(?P<a>\\w+))')).toBe('rex_atomic_group');
  });
  it('names a possessive quantifier', () => {
    expect(resolveConstructMessageKey('(?P<a>\\w++)')).toBe('rex_possessive_quantifier');
  });
  it('names a recursion/subroutine reference', () => {
    expect(resolveConstructMessageKey('(?P<a>\\w+)(?1)')).toBe('rex_recursion');
  });
  it('names a conditional', () => {
    expect(resolveConstructMessageKey('(?(1)yes|no)(?P<a>\\w+)')).toBe('rex_conditional');
  });
```

- [ ] **Step 2: Run, confirm red** (`-- re2Compat`) — these patterns currently resolve to `null`.

- [ ] **Step 3: Extend `CONSTRUCT_PROBES`** in `src/input/spl/re2Compat.js`. **Order matters** — atomic `(?>` must be probed before recursion would mis-catch, and lookaround-shaped tokens are already gated; keep backreference first:

```javascript
const CONSTRUCT_PROBES = [
  // numbered \1..\9, named \k<name>, named (?P=name)
  { re: /\\[1-9]|\\k<|\(\?P=/, key: 'rex_backreference' },
  // atomic group (?>...)
  { re: /\(\?>/, key: 'rex_atomic_group' },
  // possessive quantifiers: *+ ++ ?+ {n,m}+
  { re: /(?:[*+?]|\})\+/, key: 'rex_possessive_quantifier' },
  // recursion / subroutine: (?R) (?1) \g<name>
  { re: /\(\?R\)|\(\?\d+\)|\\g</, key: 'rex_recursion' },
  // conditional: (?(1)...|...)
  { re: /\(\?\(/, key: 'rex_conditional' },
];
```

> **Probe-overlap caution (verify in Step 6):** `(?P=name)` (named backref) starts `(?` but is matched by the backreference probe first, so it never reaches the recursion `(?\d+)` probe. `(?(` (conditional) and `(?>` (atomic) are distinct prefixes. Confirm via the unit tests that each pattern resolves to its intended key and no probe shadows another.

- [ ] **Step 4: Add the messages** to `src/messages.js` (after `rex_re2_incompatible`):

```javascript
  // SPL: `* | rex field=x "(?>(?<a>\\w+))"`
  rex_atomic_group: () =>
    'rex pattern uses an atomic group (?>...), which NRQL capture() (RE2) does not support; rewrite the regex without atomic groups',

  // SPL: `* | rex field=x "(?<a>\\w++)"`
  rex_possessive_quantifier: () =>
    'rex pattern uses a possessive quantifier (*+, ++, ?+, {n,m}+), which NRQL capture() (RE2) does not support; use a greedy quantifier instead',

  // SPL: `* | rex field=x "(?<a>\\w+)(?1)"`
  rex_recursion: () =>
    'rex pattern uses recursion or a subroutine reference ((?R), (?1), \\g<name>), which NRQL capture() (RE2) does not support',

  // SPL: `* | rex field=x "(?(1)yes|no)(?<a>\\w+)"`
  rex_conditional: () =>
    'rex pattern uses a conditional ((?(1)...)), which NRQL capture() (RE2) does not support',
```

- [ ] **Step 5: Add the case-level + scoped-flag-regression `cases`** to `test/spl/spl.test.js` (rex PCRE section):

```javascript
  // atomic group → unsupported (staging-confirmed rejected).
  {
    spl: '* | rex field=x "(?>(?<a>\\w+))"',
    unsupportedFunc: ['rex_atomic_group'],
    doc: 'fields-rex-pcre',
    verified: false,
  },
  // possessive quantifier → unsupported.
  {
    spl: '* | rex field=x "(?<a>\\w++)"',
    unsupportedFunc: ['rex_possessive_quantifier'],
    doc: 'fields-rex-pcre',
    verified: false,
  },
  // scoped inline flag MUST NOT be rejected (capture() accepts it — staging-verified).
  {
    spl: '* | rex field=x "(?i:foo)(?<a>\\w+)"',
    nrql: "FROM Log WITH capture(x, r'.*(?i:foo)(?P<a>\\w+).*') AS (a) SELECT *",
    doc: 'fields-rex-pcre',
    verified: false,
  },
```

> Confirm the scoped-flag `nrql` byte-for-byte with `node bin/spl2nrql.js '* | rex field=x "(?i:foo)(?<a>\w+)"'` in Step 7 — especially that `(?i:foo)` survives unchanged and only `(?<a>` becomes `(?P<a>`.

- [ ] **Step 6: Run, confirm green** (`-- re2Compat`, then `-- spl.test`), then whole package. Confirm each probe resolves to its intended key (Step 3 caution) and the scoped-flag case still emits a `capture()`.

- [ ] **Step 7: CLI spot-check** the three new SPL inputs; confirm the two reject cases are loud and the scoped-flag case translates.

- [ ] **Step 8: Fuzz ×20** (as Task 2 Step 7).

- [ ] **Step 9: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add packages/nr-query-bridge/src/input/spl/re2Compat.js \
  packages/nr-query-bridge/src/messages.js \
  packages/nr-query-bridge/test/spl/re2Compat.test.js packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: friendly rex messages for atomic/possessive/recursion/conditional"
```

> **PR2 = Task 3** (one commit), stacked on PR1.

---

### Task 4 (PR3): Graduate (docs) + reclass laundry-list + file two follow-ups

**Files:**
- Modify: `.claude/rules/design-decisions.md` (add the invariant)
- Modify: `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` (reclassify the `rex-regex-robustness` row + add two follow-up rows)
- Modify: `test/spl/spl.test.js` (`verified: false` → `'llm'` once staging-validated)

> **FLAG — file conflict:** `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md` is **also edited by PR #72** (the 9-specs PR). This branch is cut off `master` *after* PR #72 lands, so the row exists when this task runs. If PR #72 has NOT yet landed, rebase first. Touch only the `rex-regex-robustness` row + the two new follow-up rows; do not disturb other rows.

- [ ] **Step 1: Staging-validate** the reject + no-regression behavior is faithful (spec already ran 20/20; re-confirm the live `\1` repro). Via `run_nerdgraph_query` (acct 1; `capture()` is fine on `execute_nrql_query`, but use NerdGraph to be safe):
  - `FROM Log WITH capture(message, r'.*(?P<a>\w+)=\1.*') AS (a) SELECT * SINCE 30 minutes ago LIMIT 1` → expect `invalid escape sequence: \1` (proves the construct we now reject would have broken live).
  - `FROM Log WITH capture(message, r'.*user=(?P<user_id>\w+).*') AS (user_id) SELECT * SINCE 30 minutes ago LIMIT 1` → runs clean (proves the no-regression path is valid).

- [ ] **Step 2: Promote** the staging-confirmed `cases` (the no-regression `capture()` ones whose NRQL was validated in Step 1) from `verified: false` to `verified: 'llm'`. The `unsupported` cases stay `verified: false` unless a human promotes them.

- [ ] **Step 3: Graduate the invariant** to `.claude/rules/design-decisions.md` under the "Messages & Pipeline" (or a new "rex / capture()") bullet:

```markdown
- **rex → capture() RE2 gate**: `handleRex` gates the assembled `fullPattern` through
  `getRe2Compatibility` (`src/input/spl/re2Compat.js`, backed by the `re2js` runtime dep — the
  package's only one). NRQL `capture()` is RE2/J; re2js is the faithful pure-JS RE2 oracle, so a
  pattern re2js can't compile → loud `unsupported`, never an emitted `capture()` that breaks live
  (backreferences `\1`/`\k<>`/`(?P=)` — in OR out of a character class — atomic groups, possessive
  quantifiers, recursion, conditionals). Inline flags `(?i)`/`(?i:…)` are ACCEPTED — must not be
  rejected. `resolveConstructMessageKey` is a **naive** token probe consulted ONLY after the gate
  rejects (so it needs no escape-parity logic); it names the common construct for a friendly
  message, else the generic `rex_re2_incompatible(reason)` surfaces re2js's own reason. The
  fidelity gate (`test/spl/re2Compat.test.js`) pins re2js's accept/reject to the staging-verified
  `capture()` set.
```

- [ ] **Step 4: Reclassify the laundry-list row.** In `docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md`, the `rex-regex-robustness` row's characterization ("frequently can't parse real `rex` patterns — general parse failures") is **mis-attributed** (spec §"General parse-failure census"). Reframe it as a shipped correctness-hardening BUG fix: the converter is robust; the real defect was silent emission of RE2-incompatible `capture()` (now gated). Mark it shipped/resolved by this work.

- [ ] **Step 5: File the two real follow-ups** as their own rows (spec §"General parse-failure census" surfaces these; they are NOT this spec's scope):
  - **`rex-sed-messaging`** (cosmetic): `mode=sed` substitutions are loud but mis-messaged as `rex_parse_failed` ("could not be parsed") instead of naming sed — improve the message.
  - **`rex-valid-pattern-over-rejection`** (BUG): the converter over-rejects some valid RE2-compatible PCRE (e.g. a named group with an escaped-metachar char class like `"<Header:(?<h>[\s\{\[\".\w:,-\}\]]*)>"`) — loud, not silent, but a real over-rejection. (Note: with the re2js gate now present, a follow-up could *relax* the converter's hand-rolled rejections and defer to the gate.)

- [ ] **Step 6: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git add .claude/rules/design-decisions.md \
  docs/superpowers/specs/2026-06-27-known-issues-laundry-list-design.md \
  packages/nr-query-bridge/test/spl/spl.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: graduate rex re2-compat gate, reclass laundry-list row"
```

> **PR3 = Task 4** (one commit), stacked on PR2.

---

## Global Verification

- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm test` — full workspace suite green (translator + dashboard-importer).
- [ ] `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check` — clean (note `re2js` ships its own `.d.ts`, so `checkJs` sees the import types).
- [ ] No `npm run build:parsers` needed — no grammar change (`handleRex` reads the already-parsed `cmd`).
- [ ] Fuzz ×20 green (Task 2 / Task 3).
- [ ] `package-lock.json` committed; `re2js` resolves under `packages/nr-query-bridge`; no other dependency drift. After `npm ci`, the working tree is clean (no dirty-mode files).
- [ ] Open each PR (PR1 = 2 commits, PR2 = 1, PR3 = 1) with the dependency-verification note from Task 1 in PR1's body; invoke `write-gooder` for every PR body (100–200 words, summary + test plan).

## Self-Review

1. **Spec coverage:** re2js dep + gate + backref message + reject/no-regression cases + fidelity test (Tasks 1–2 = spec PR1) ✓; friendly messages for atomic/possessive/recursion/conditional + scoped-flag regression (Task 3 = spec PR2) ✓; graduate + laundry-list reclass + two follow-ups (Task 4 = spec PR3) ✓.
2. **Loud-failure:** every RE2-incompatible pattern → `unsupported` (Task 2 Step 4 returns after pushing); never an emitted `capture()`. The gate runs on the exact `fullPattern` that would reach `capture()`.
3. **No false-reject of accepted constructs:** inline flags `(?i)`/`(?i:…)` accepted (fidelity test + scoped-flag case); `\\1` (escaped backslash) accepted (fidelity test) — the naive token layer never sees it because the gate accepted it.
4. **Type/interface consistency:** `getRe2Compatibility → {compatible, reason}` and `resolveConstructMessageKey → string|null` (Task 1) consumed with those exact shapes (Tasks 2–3). `Func`/`Identifier`/`Regex`/`Binding` unchanged from `src/ir/nodes.js`. No null reaches an IR factory — on rejection we return before constructing `capture()`.
5. **Message consistency:** six new keys (`rex_backreference`, `rex_re2_incompatible`, `rex_atomic_group`, `rex_possessive_quantifier`, `rex_recursion`, `rex_conditional`) all referenced in `cases` `unsupportedFunc` arrays; exhaustiveness enforced by the spy check in `test/spl/spl.test.js`.
6. **No regression:** existing rex cases (named/multi-capture/char-class/dlq) are all RE2-safe → still emit `capture()`; real-world census = 0 incompatible markers in clean/warning outputs → none flip.

## Double-check targets (flagged uncertainties)

1. **re2js parse mode — false-accept risk (HIGHEST).** re2js's default `RE2JS.compile(pattern)` parses in a **JS-compatibility mode** (its own test suite notes "default parses as JS mode"). The spec's 20/20 spot-check covered the staging-verified reject set, but the executor MUST re-run the fidelity gate (Task 1 tests) and additionally probe whether default-mode re2js *accepts* anything `capture()` (strict RE2/J) rejects — e.g. JS-only group/escape syntax. If a divergence appears, investigate whether a stricter compile flag is needed. This is the single load-bearing assumption.
2. **Exact re2js error-message strings.** The spec claims byte-identical RE2 error strings (`invalid escape sequence: \1`, …). The plan does NOT assert exact `reason` text (tests assert `reason` is truthy, not its content) to avoid coupling to re2js's wording — confirm that's acceptable, or tighten if the spec wants exact-string fidelity.
3. **Possessive-quantifier probe breadth.** The probe `/(?:[*+?]|\})\+/` aims at `*+ ++ ?+ {n,m}+` but is message-quality only (gate is authoritative). Verify on the unit tests it doesn't mis-key a benign pattern that the gate *accepted* — but since it's consulted only post-rejection, a stray match just yields a slightly-off friendly message, never a wrong accept/reject.
4. **`fullPattern` vs `cmd.pattern` for the gate.** The plan gates `fullPattern` (with `.*` wrapping + `(?P<…>)` conversion) as the most faithful "what capture() receives." Confirm the `.*` prefix/suffix and `(?<name>)`→`(?P<name>)` rewrite never themselves trip re2js (they shouldn't — both are RE2-safe — but verify in the no-regression cases).
5. **Laundry-list row dependency on PR #72.** Task 4 edits the same file PR #72 edits. Branch is cut after #72 lands; if not, rebase. Confirm the `rex-regex-robustness` row text/location before editing (grep it — it's at line ~59 today).
6. **`THIRD_PARTY_NOTICES` / FOSSA at publish.** Adding the first runtime dep means notices must regenerate before `npm publish` (NR-578293). Out of PR scope but flagged so it isn't lost.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-28-rex-re2-compatibility.md`. The branch (`feat/rex-re2`) is cut off `master` **after PR #72 lands** (Task 4 shares a file with it). Run `/double-check` on this plan first — focus the clean-room test derivation on (a) the fidelity gate (re2js accept/reject == `capture()`) and (b) the false-accept question in Double-check target #1 — then execute via subagent-driven-development, landing the three stacked PRs in order (PR1 = Tasks 1–2, PR2 = Task 3, PR3 = Task 4). All translator coding uses **Opus** per the project rule.

