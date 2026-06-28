# rex → `capture()` RE2-compatibility — design

**Date:** 2026-06-27 (revised 2026-06-28 — engine confirmed in source; corpus census added;
detection method resolved)
**Status:** Draft for review.
**Scope:** `@newrelic/query-bridge` (SPL→NRQL translator, rex handling).
**Source:** `known-issues-laundry-list` row `rex-regex-robustness` (BUG). **Reframed after
investigation.** Repros 100% synthetic; NRQL claims live-verified on staging acct 1 (`cceb76a`);
engine + corpus claims verified 2026-06-28.

## Investigation correction

The laundry-list row says the translator "frequently can't parse real `rex` patterns — general
parse failures, max_match, lookahead/lookbehind." Probing shows the regex→`capture()` converter
is **robust and largely correct**: named/defaulted/multi-capture groups, escaped/single quotes,
char classes, alternation, non-capturing/nested/unnamed groups, `\d{3}-\d{4}`, and multi-group
destructuring `AS (a, b)` all translate (the last live-verified valid). `max_match`,
lookahead/lookbehind, and `mode=sed` already emit loud `unsupported`. So "can't parse" is not the
real defect. The real defect is **silent emission of `capture()` patterns NRQL's regex engine
rejects at runtime** (e.g. backreferences) — looks translated, breaks live.

## Engine — confirmed (no longer inferred)

NRQL `capture()` is backed by **RE2/J** (`com.google.re2j`), confirmed in the dirac-nrql source:
`RegexCaptureEvaluable.java`, `RegexUtils.java`, and `CompilerRegexPlan.java` all
`import com.google.re2j.Pattern`; `build.gradle` declares `api libs.com.google.re2j` (plus a NR
`nre2` wrapper). RE2/J is the pure-Java port of Google's RE2, so the reject set below is RE2's by
construction — not a behavioral guess.

## Problem (the actual bug) + prevalence

The translator detects *some* RE2-incompatibilities (lookaround → loud `unsupported`) but passes
others through. Confirmed live:

```
* | rex field=x "(?<a>\w+)=\1"     # backreference
→ FROM Log WITH capture(x, r'.*(?P<a>\w+)=\1.*') AS (a) SELECT *
→ NRQL Syntax Error: invalid regex pattern: invalid escape sequence: `\1`
```

**Prevalence (corpus census, 4226 rex-bearing real-world entries, 2026-06-28):** the slip-through
is **rare-but-real**. A rough scan of the 1833 clean/warning `capture()` outputs found **0**
carrying an RE2-incompatible marker (lookaround is already caught — 61 `unsupported`). So this is a
correctness-hardening fix for a low-frequency dangerous class, not a high-volume one. The live
`\1` repro is the proof-of-class; we fix it because a single silently-broken panel is worse than a
placeholder, not because it is common.

## RE2-incompatible construct set (detect → `unsupported`)

`capture()` rejects the following — **all live-verified rejected on staging acct 1
(`run_nerdgraph_query`)**, each a real PCRE/`rex` construct:
- **Backreferences** — `\1`…`\9` (`invalid escape sequence: \1`), named `(?P=name)` /
  `\k<name>`.
- **Lookaround** — lookahead `(?=…)`/`(?!…)`, lookbehind `(?<=…)`/`(?<!…)`.
- **Atomic groups** `(?>…)`; **possessive quantifiers** `*+`/`++`/`?+`/`{n,m}+`.
- **Recursion / subroutine** `(?R)`/`(?1)`/`\g<…>`; **conditionals** `(?(1)…|…)`.

**Verified ACCEPTED — do NOT reject:** bare inline flags `(?i)`/`(?m)`/`(?s)` AND scoped inline
flags `(?i:…)` both run clean. The detector must not flag these.

## Detection method — RESOLVED

**Recommendation: a runtime re2js compile-check as the authoritative gate, plus a thin token layer
for friendly messages.** Rationale:

- **re2js *is* the engine.** It is a pure-JS port of `re2j` (`github le0pard/re2js`: 0 runtime
  deps, MIT, ~18 KB gzipped, maintained). "Does re2js compile this pattern?" ≈ "will `capture()`
  accept it?" authoritatively, and it catches **un-enumerated** incompatibilities too — no
  hand-maintained construct list to drift.
- **It dissolves the hard edge cases.** Applying real RE2 semantics, re2js correctly rejects `\1`
  in *any* position — in or out of a character class (`capture()` does the same: `x[\1]y` →
  `invalid escape sequence: \1`, staging-verified) — accepts `\\1` (escaped backslash), and
  disambiguates `(?<=…)` (reject) from `(?<name>…)` (accept), so we ship **no** fragile
  escape-parity / char-class / lookbehind-disambiguation logic (this resolves the former Open Q2).
- **The runtime dep is justified here.** The translator is destined for the **New Relic Logs UI**
  as a JS lib; in a large web app an 18 KB MIT 0-dep library is negligible. "Zero runtime
  dependency" is positioning, not a hard constraint that survives that destination.
- **The thin token layer** detects the common constructs (backref, lookaround, atomic,
  possessive) only to phrase a friendly construct-specific `unsupported` (mirror the existing
  lookaround message); for anything else, surface re2js's own reason. This is for message quality,
  not correctness — re2js is the gate, so the token layer can be naive.

**Rejected alternatives:**
- **devDependency-only re2js (validate a hand-rolled scanner in CI).** Gives CI confidence but
  **no runtime robustness** to the shipped artifact; and since the lib ships into the Logs UI,
  there is no runtime-footprint reason to keep re2js out of the bundle. Doesn't get us anywhere a
  runtime gate doesn't.
- **Node's built-in `RegExp`.** V8 Irregexp (backtracking) — it *accepts* backreferences and
  lookaround, so it cannot serve as an RE2-compatibility oracle.
- **Token-scanner-only (no dep).** Valid and lighter, covers the staging-verified finite set, but
  requires hand-maintained edge-case logic and misses un-enumerated constructs. Acceptable
  fallback if zero-dep is later re-prioritized over robustness.

**Pre-adoption gate — PASSED (2026-06-28).** Spot-checked re2js@2.8.3 against the staging-verified
set: **20/20 match** `capture()`'s actual accept/reject, with byte-identical RE2 error strings
(`invalid escape sequence: \1`, `invalid or unsupported Perl syntax: (?=`, `invalid nested
repetition operator: *+`, …). The `nre2` wrapper introduces no syntax-level divergence. The one
case that initially differed (`[\1]`) corrected *my* assumption, not re2js — see below.

## `\1` is rejected everywhere — RESOLVED (corrected assumption)

The action on a backreference is **always `unsupported`** — there is no RE2 equivalent, so emitting
a `capture()` containing one is the silent-wrong path (the engine rejects it at runtime). We never
translate a backreference.

**Corrected assumption:** `[\1]` is *not* a preserved literal in `capture()`. "A backreference
inside a character class is a literal" is a PCRE-ism; RE2 treats `\1` as an **invalid escape
everywhere** — staging-verified: `WITH capture(message, r'x[\1]y…')` → `invalid regex pattern:
invalid escape sequence: \1` (acct 1, 2026-06-28), the same error as a bare backref. So the correct
behavior is `unsupported` for `\1` in *any* position, in or out of a class — not "preserve the
literal."

This is exactly why the re2js gate is safer than a hand-rolled scanner: re2js rejects `x[\1]y`
correctly, whereas a scanner built on the "treat `[\1]` as literal" assumption would have emitted a
runtime-invalid `capture()` (silent-wrong). Under the token-only fallback: flag `\1` in *any*
position (correct), guarding only escape-parity (`\\1` = escaped backslash + literal `1`, which
`capture()` accepts) to avoid that single false-reject.

## General parse-failure census — RESOLVED (Open Q3)

Census of 4226 rex-bearing corpus entries (2026-06-28): `{ CLEAN 595, WARNING 1250, UNSUPPORTED
1861, ERROR 520, THREW 0 }`. Findings:

- **No silent parse-failure bucket.** `THREW = 0` — the converter never throws on a valid pattern.
- **The 520 `ERROR`s are general SPL-grammar failures, not rex/regex** — samples show subsearches
  `[search …]`, backtick macros, `multisearch`, `tstats`, `|eval` (no space), and `$token$`
  placements. These belong to grammar-leniency work, **out of scope** for this spec.
- **Genuinely rex-pattern failures are LOUD** — `"rex command could not be parsed"` (112,
  `unsupported`), splitting into: (a) **`mode=sed`** substitutions (the majority) — loud, but
  mis-messaged as "could not be parsed" instead of naming sed; (b) a real **over-rejection** of
  valid RE2-compatible PCRE — e.g. a named group with an escaped-metachar char class like
  `"<Header:(?<h>[\s\{\[\".\w:,-\}\]]*)>"` — the converter wrongly refuses it (loud, not silent);
  (c) some unquoted/malformed patterns.

So the laundry-list "general parse failures" is **mostly mis-attributed**: the failures are
general-grammar, not rex. The two real rex follow-ups it surfaces — **better `mode=sed` messaging**
and **the over-rejection robustness bug** — are separate, smaller concerns from this RE2-compat
spec; file them as their own rows rather than folding them in here.

## Behavior

- During rex→`capture()` conversion, gate the emitted pattern through the re2js compile-check
  (recommended) — if rejected, emit `unsupported`; never emit the `capture()`. The token layer
  supplies a friendly construct-specific message for the common constructs; otherwise surface
  re2js's reason.
- Patterns using only RE2-supported constructs → translate unchanged (do not regress the
  already-correct converter).
- `max_match` / `mode=sed` unchanged here (separate honest GAPs; sed-message improvement tracked
  separately).

## Acceptance criteria (synthetic)

- `* | rex field=x "(?<a>\w+)=\1"` → `unsupported` (backreference), not invalid `capture()`.
- `* | rex field=x "(?>(?<a>\w+))"` → `unsupported` (atomic group — staging-confirmed rejected).
- `* | rex field=x "(?i:foo)(?<a>\w+)"` → unchanged ✅ (scoped flag ACCEPTED — must NOT reject).
- `* | rex field=x "user=(?<user_id>\w+)"` → unchanged ✅ (no regression).
- `* | rex field=x "(?<a>\w+) (?<b>\w+)"` → unchanged ✅ `capture(…) AS (a, b)` (verified valid).
- `* | rex field=x "x[\1]y(?<a>\w+)"` → `unsupported` — `capture()` rejects `\1` in a class too
  (staging-verified `invalid escape sequence: \1`); it is **not** a preserved literal.

## Testing

Data-driven `cases` in `test/spl/spl.test.js`: one per RE2-incompatible construct
(`unsupportedFunc`), plus regression cases asserting RE2-*compatible* patterns still translate
(named/unnamed/nested groups, alternation, quantifiers, escaped quotes, multi-capture
destructuring, the `[\1]`-literal case). The re2js gate makes validation deterministic in CI: a
test asserts each "unsupported" pattern is rejected by re2js and each "supported" pattern is
accepted — this is the pre-adoption fidelity gate (run 2026-06-28: **20/20** match `capture()`,
identical RE2 error strings; `nre2` adds no divergence), now standing in CI. Fuzz ×20.

## PR breakdown

1. **re2js compile-gate + backreference message** (~140 lines, behavior) — add re2js as a runtime
   dependency (vet on add: MIT, 0-dep, maintained — confirmed); gate the emitted `capture()`
   pattern through it; emit `unsupported` on rejection, with a friendly backreference-specific
   message via the thin token layer (the single confirmed-live bug). Add the backreference `case`,
   the `[\1]`-literal regression case, and the no-regression cases. Include the fidelity spot-check
   test against the staging-verified set. Dependency: none. *(If zero-dep is preferred instead:
   ship the token scanner for backreferences here and defer re2js — the lighter fallback.)*
2. **Friendly messages for the remaining constructs** (~120 lines, behavior) — token-detect atomic
   groups, possessive quantifiers, recursion, conditionals, named backref for friendly messages
   (re2js already gates them); regression case that scoped inline flags `(?i:…)` are NOT rejected.
   Dependency: PR 1 (shares the gate + token layer).
3. **(Docs) reframe the laundry-list row + file the two real follow-ups** (~30 lines) — record the
   RE2-compat reframing and the census result; open separate small rows for `mode=sed` messaging
   and the valid-pattern over-rejection robustness bug (both loud today, neither this spec's
   scope). Dependency: PRs 1–2.
