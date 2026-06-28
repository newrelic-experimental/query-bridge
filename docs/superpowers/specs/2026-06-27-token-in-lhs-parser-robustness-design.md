# Token in comparison LHS — parser robustness (`supported-command-reported-unsupported`)

**Date:** 2026-06-27
**Status:** Draft for review. (Brainstorming output — design forks flagged as Open Questions.)
**Scope:** `@newrelic/query-bridge` (grammar + IR). Couples to importer multiselect-variable
handling (cross-referenced, not owned here).
**Source:** `known-issues-laundry-list` row `supported-command-reported-unsupported`
(BUG, **High**). Repros 100% synthetic.

## Problem

A dashboard `$token$` in a comparison **LHS/field position** isn't accepted by the search
grammar, so the parse fails — and the failure isn't local to that clause, it poisons the
whole command. Verified `cceb76a`, two faces:

```
# base-search position → hard PARSE ERROR
web_logs $cat$="*" | stats count
→ error: Failed to parse SPL at line 1:15: Expected "|", end of input, or whitespace but "=" found.

# pipeline-command position → the command falls back to UnsupportedCommand
web_logs | where ($cat$="*" OR category="$cat$")
→ unsupported: SPL command 'where' has no known NRQL equivalent
```

Either way the importer makes the panel a placeholder. By contrast, a token in **RHS/value**
position works (`category="$cat$"` → `category = {{cat}}`) — the grammar's `search_value`
rule already accepts a `template_variable`, but the LHS/field rules do not.

The trigger is the **Splunk multiselect "means-all" idiom**: a dropdown whose "all" choice
sets the token to `*`, paired as `($tok$="*" OR field="$tok$")` — "if the user picked all,
match everything; otherwise filter by the value." It is extremely common in real dashboards,
so this single shape accounts for a large share of wrongly-placeholdered panels.

## Root cause

In `spl.grammar`, the comparison rules (`field:search_field … op … value:search_value`)
accept a `template_variable` only on the `search_value` (RHS) side. `search_field` and the
base-search field position do not, so `$tok$ =` never matches a comparison → the search
expression parse dies at `=` (base position) or the pipeline command's body fails and
degrades to `UnsupportedCommand` (`splToIR.js:749`).

## Goal

A `$token$` in LHS/field position must **not** poison the whole command. The translatable
parts of the search survive, and the means-all idiom gets a faithful (or at least loud,
local) result. Eliminate both the hard parse error and the whole-command `unsupported`.

## Options (the design fork)

**Option A — grammar accepts a token LHS, emit a clause-level signal.** Let `template_variable`
match in field/LHS position so the command parses; represent `$tok$ = "*"` in IR. But emitting
`{{tok}} = '*'` does not work: a template variable in **field/identifier position is not
substituted** — NR substitutes `{{var}}` in value position only (verified at the dashboard
substitution layer — `project_nr_dashboard_var_substitution`; *not* reproducible via raw NRQL,
which can't define a variable). (This is a distinct failure from `splunk-env-tokens`, where the
`:` character breaks the NRQL token grammar outright.) So the clause itself must become a loud
warning/unsupported. *Problem:* a clause-level `unsupported` still makes the importer
placeholder the panel — so A alone does **not** salvage the panel; it only fixes the
crash/poisoning. Necessary but insufficient.

**Option B — recognize the means-all idiom and resolve it (recommended).** Detect
`$tok$ = "*"` (a token compared to a literal `*`) as the always-true means-all disjunct.
Within `($tok$="*" OR field="$tok$")`, drop the always-true disjunct and emit
`field = {{tok}}` (or `field IN ({{tok}})` for a multiselect, per the importer's variable
handling), plus a warning that "all" is realized by the NR variable, not the literal. This is
the faithful translation and matches how NR multiselect-with-all works. Standalone
`$tok$="*"` (no OR partner) → "always true" → drop with a warning (a no-op filter).
Note: the all-sentinel is conventionally `*` but not always (some dashboards use `"ALL"`), so
recognize the *shape* (token-LHS self-comparison to a sentinel literal) rather than hardcoding
`*`. And never translate the disjunct as data — NRQL `field = '*'` is a **literal asterisk
match** (matches 0 rows — verified), not match-all, so emitting it would be silent-wrong.

**Option B′ — operand flip (preferred for equality; surfaced in review).** Since `=` is
commutative, flip the sentinel comparison so the template variable lands in value position:
`$tok$ = "*"` → `'*' = {{tok}}`. This is valid NRQL and folds correctly (live-verified, acct 1:
`WHERE '*' = 'prod'` → 0 rows; `WHERE '*' = '*'` → matched all rows; `WHERE '*' = category` →
accepted). So `($tok$="*" OR field="$tok$")` → `('*' = {{cat}} OR field = {{cat}})`: when the
var is `*`, `'*'='*'` is true → matches all; otherwise the OR falls through to `field = {{tok}}`.
**Advantage over B:** a mechanical operand flip, no idiom recognition, and it preserves
means-all *literally* — so it works even for a free-text variable where the user types `*` (B's
drop-the-disjunct relies on the importer configuring a multiselect-with-"all", which a free-text
var lacks). **Limits:** equality-only (`=`/`!=`; an ordering op would need operator inversion);
the always-true `'*'='*'` scans all rows (the literal means-all cost, not free); and it does not
compose with a multiselect `IN ({{tok}})` (`'*' IN ({{tok}})` is a different shape) — for a true
multiselect, fall back to B/C.

**Option C — full multiselect IN-expansion in the importer.** The means-all semantics
ultimately belong to the importer's per-variable handling (multiselect → `IN ({{tok}})`,
per `design-decisions.md` → Variables). The translator emits the field/value comparison; the
importer wires the variable. Out of scope for the translator spec, but the recommended B
output must be the shape the importer expects. **Cross-reference required.**

## Resolved decisions

1. **B′ (mechanical operand flip) is the default for token-LHS equality; B for multiselect; A
   otherwise.** Both shapes exist in real dashboards, so:
   - **Token-LHS equality with one non-token operand** (`$tok$ = "*"` sentinel, `$tok$ = field`,
     `$tok$ = "lit"`) → **B′ flip**: move the template var to value position (`'*' = {{tok}}`,
     `field = {{tok}}`). This is a *mechanical* flip, **not** idiom recognition — so it avoids the
     "bugs and special cases if we can't fully catch the idiom" risk, and means-all falls out
     naturally (`'*' = '*'` true → match all; `'*' = 'prod'` false → the `OR field = {{tok}}`
     filters). Live-verified shapes.
   - **Multiselect variable → B (drop the always-true disjunct → `field IN ({{tok}})`).** The
     importer realizes "all" by expanding the multiselect, so the sentinel disjunct is redundant —
     this is the "drop the `*`" case (a match-everything filter is a no-op, so it comes out).
   - **Un-flippable token-LHS** (`$tok$ = $other$` token-vs-token, or an un-invertible operator) →
     **A: loud clause-level `unsupported`** — never a silent `{{tok}}`-in-field.
   - **The `*`→`%` (NRQL `LIKE`) idea is a *separate*, already-handled concern, deliberately not
     mixed in here.** It applies to a **value-position wildcard** token (`field="*$tok$*"` →
     `field LIKE {{tok}}`, the `wildcard_token_like` path in `design-decisions.md`), where `*` is a
     wildcard pattern. The means-all `$tok$="*"` is a **sentinel** (a flag meaning "all selected"),
     not a field-wildcard, so B′ catches it directly and no `*`→`%` is needed — keeping the two
     paths separate is what avoids the special-casing.
   - **Substitution-layer caveat:** the NRQL *shape* `'*' = {{tok}}` is live-verified; NR turning
     it into `'*' = 'prod'` is value-position substitution, which `project_nr_dashboard_var_substitution`
     already confirms works — re-confirm this exact shape at the dashboardCreate layer before
     promoting past `verified:false` (PR 2 gate).
2. **B/B′ where the idiom applies, A otherwise — and yes, A-only still placeholders the panel
   (accepted).** A clause-level `unsupported` does not salvage the panel (the importer chokepoint
   placeholders on any `unsupported`); that is an inherent importer limitation, not fixable here.
   So B/B′ are what actually salvage the means-all panels; A is the honest fallback for the rest.
3. **Both positions in scope.** The grammar fix covers the base-search field position (parse
   error) and the `where`/`search` pipeline-command position (UnsupportedCommand) — they share the
   root cause.

## Behavior (assuming B + grammar fix, both positions)

- Grammar accepts a `template_variable` in comparison LHS/field position (base and pipeline).
- A token-LHS **equality** comparison with one non-token operand — `$tok$ = "*"` (sentinel),
  `$tok$ = field`, `$tok$ = "lit"` — is handled by **operand flip** (B′): move the template var to
  value position (`'*' = {{tok}}`, `field = {{tok}}`), keeping any surrounding `OR field = {{tok}}`
  intact; add a `means_all_token` warning for the sentinel shape. This is mechanical — no idiom
  recognition. For a **multiselect** variable, use B instead (drop the always-true disjunct →
  `field IN ({{tok}})`).
- A token-LHS comparison that can't flip — token-vs-token (`$tok$ = $other$`) or an un-invertible
  operator — parses, then a loud clause-level `unsupported` (Option A; no silent `{{tok}}`-in-field
  emission).
- The rest of the command translates normally — no whole-command poisoning.

## Acceptance criteria (synthetic)

- `web_logs ($cat$="*" OR category="$cat$") | stats count`
  → `FROM Log SELECT count(*) WHERE ('*' = {{cat}} OR category = {{cat}})` (B′ flip, + means-all
  warning) — was a parse error.
- `web_logs | where ($cat$="*" OR category="$cat$")`
  → `… WHERE ('*' = {{cat}} OR category = {{cat}})` — was `unsupported`.
- `web_logs $cat$="*" | stats count` (standalone) → `… WHERE '*' = {{cat}}` + means-all warning.
- `web_logs | where $cat$ = $other$` → parses, clause-level `unsupported` (no `{{cat}}` in field).
- RHS token unchanged: `category="$cat$"` → `category = {{cat}}`.

## Testing

Grammar change → `npm run build:parsers`. Data-driven `cases` in `test/spl/spl.test.js` for
each acceptance row (`verified: false` → `'llm'`). Importer integration: a means-all panel
should now emit a real widget, not a placeholder — add an importer integration case + regen
`GAP_INVENTORY.md`. Fuzz ×20 (the grammar change is parser-surface — fuzz is the safety net).
Corpus before/after via `dashboard-diagnostic.mjs`.

## PR breakdown

1. **Grammar: accept a template variable in comparison LHS/field position** (~150 lines,
   refactor+scaffold) — extend `search_field`/comparison LHS (base + pipeline) to match
   `template_variable`; produce a structured `Comparison{ lhs: TemplateVariable, … }` IR node.
   `npm run build:parsers`. The IR handler emits a loud clause-level `unsupported` for ALL
   token-LHS comparisons for now (no means-all special-casing yet) — this alone kills the
   parse error and whole-command poisoning. Add `spl.test.js` cases: base + pipeline token-LHS
   now parse (and emit clause-level unsupported, not whole-command). Dependency: none.
2. **Means-all idiom resolution** (~200 lines, behavior) — detect the sentinel self-comparison
   `$tok$ = "*"` and emit the **operand flip** `'*' = {{tok}}` (B′), keeping the surrounding
   `OR field = {{tok}}`; add the `means_all_token` message. (For a multiselect variable, drop
   the disjunct → `field IN ({{tok}})` instead — Option B.) Add the means-all acceptance cases.
   Dependency: PR 1. **Verify the `'*' = {{tok}}` substitution at the dashboardCreate layer
   before promoting past `verified:false`.**
3. **Importer wiring + multiselect-IN alignment** (~150 lines, behavior) — ensure the emitted
   `field = {{tok}}` aligns with the importer's multiselect `IN ({{tok}})` variable handling;
   add an importer integration case (means-all panel → real widget) and regenerate
   `GAP_INVENTORY.md`. Dependency: PR 2 + the importer Variables path. Gate B on a
   multiselect hint here if Open Question 1 resolves that way.
4. **(Optional) graduate** (~30 lines, docs) — corpus re-measure, promote cases to `'llm'`,
   graduate the invariant, strike the laundry-list row. Dependency: PR 3 + staging validation.
