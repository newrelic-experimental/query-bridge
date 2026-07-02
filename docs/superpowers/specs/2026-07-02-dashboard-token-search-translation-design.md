# Dashboard token in comparison-LHS & bare-term position → NRQL

Status: design approved (2026-07-02), pending writing-plans.

## Problem

Splunk dashboard searches put a `$token$` in three shapes the translator does not yet
handle faithfully:

1. **Token in comparison FIELD (left) position** — `$cat$="*"`, `$experiment$=true`. The
   dropdown picks *which field* to filter (a field-selector). Today: a hard **parse error**
   on master; on the unmerged flip branch (#91) `$tok$="*"` becomes `'*' = {{tok}}`, a
   translation we have since proven wrong (it misreads `="*"` and only "works" for the
   all-sentinel by coincidence).
2. **Bare token as a search term** — `search $tok$` (no `field=`). Today: emits a dangling
   `Identifier('{{tok}}')`.
3. **The multiselect "match-all-or-filter" OR idiom** — `($tok$="*" OR field="$tok$")`. The
   corpus's only shape for token-in-field-position (**124 occurrences, always this idiom**).

`$tok$="*"` in field position is, per the SPL expert + the repo's own human-confirmed
`field="*"`→`LIKE '%'` cases, a **field-existence check where the field NAME is the token
value** — not a value compare, not a bare-term search.

## Dispositions (the contract)

| SPL construct | NRQL | Mechanism |
|---|---|---|
| `$tok$="*"` (standalone) | `{{tok}} IS NOT NULL` | token in attribute position; needs `replacementStrategy: IDENTIFIER` (importer) |
| `$tok$ <op> <value>` (standalone, e.g. `$experiment$=true`) | `{{tok}} <op> <value>` | identifier passthrough (field-selector) |
| bare `search $tok$` | `message LIKE {{tok}}` + `wildcard_token_like` warning | substring search of the log body |
| bare literal `search error` | `message LIKE '%error%'` | **already done** (`splToIR.js:598`, `BareKeyword`) — no change |
| `($tok$="*" OR field="$tok$")` / any query with the SAME token in both field AND value position | **unsupported** (`token_strategy_conflict`) | one NR variable carries one `replacementStrategy`; the two positions demand IDENTIFIER vs value — irreconcilable |

**`allColumnSearch` is deliberately NOT used.** A Splunk bare term matches `_raw`/index-time
tokens, not search-time-extracted field values; `allColumnSearch` scans every attribute
VALUE and so *over-matches* (invents hits from derived attributes a Splunk user never sees).
`message LIKE` is the faithful and cheaper target. (Staging-verified 2026-07-02 that ACS
works in `WHERE`, is capped at 2 calls/query, and needs a constant arg — but faithfulness,
not the cap, is why we reject it here.)

This **supersedes #91's flip**: the flip logic and `means_all_token` message are removed.

## Key design decisions

- **Broad conflict invariant.** Detection is not a shape-match of the specific OR idiom. It
  is: *the same token appears in both field position (`lhsToken`) and value position in one
  query* → `token_strategy_conflict` unsupported. Root-cause, not pattern; can't be dodged by
  a differently-arranged conflict. Pipeline-level, mirroring the wildcard-rename ambiguity
  guard (`_wildcardRenames` / `beforeNames`): collect the set of tokens seen in each position
  across the WHERE tree, then after the loop, if the intersection is non-empty → unsupported.
  **Only the SAME token in both positions conflicts.** Two DIFFERENT tokens in a comparison —
  `$cat$ = $other$` — are different variables with independent strategies (`$cat$`→IDENTIFIER
  field, `$other$`→value), so they pass through as `{{cat}} = {{other}}` (→ `field = 'val'`)
  and translate fine. This **supersedes #91's `token_vs_token_unsupported`** (that message is
  removed — a two-different-token comparison is no longer categorically unsupported; it only
  fails via the same-token conflict guard). *[Confirm at review: this reverses #91's
  token-vs-token behavior. The `$cat$=$other$` shape may be synthetic — not corpus-confirmed.]*
- **`="*"` is special-cased to `IS NOT NULL`;** every other operator/value passes through as
  `{{tok}} <op> <value>`. Only the exact wildcard RHS `"*"` means existence. A partial-wildcard
  value (`$tok$="err*"`) is out of scope for this spec → falls to the existing token/compare
  path or unsupported; not handled here (flag for a follow-up if the corpus shows demand).
- **Identifier strategy is the importer's job.** The translator emits `{{tok}}` in attribute
  position; making the dashboard variable `replacementStrategy: IDENTIFIER` is the
  dashboard-importer's responsibility — a **separate follow-on spec** (cross-package). The
  translator side is complete without it; a consumer that leaves the variable STRING-strategy
  gets a compiling-but-inert clause, never a crash.
- **Bare token rides the existing LIKE path.** `search $tok$` → `message LIKE {{tok}}` reuses
  the `wildcard_token_like` warning (the `%` must live in the variable's values). Bare literal
  keywords already emit `message LIKE '%term%'` and are untouched. `message` is a guaranteed
  attribute on every NR log record (product invariant — confirmed), so the LIKE target is
  always valid; no per-account field-existence check needed.

## Components touched

- `spl.grammar` — token-LHS (`Comparison{lhsToken}`) and bare `$tok$` (`TemplateVariable`)
  already parse (on #90's grammar). No new grammar expected; verify during writing-plans.
- `splToIR.js` — the `case 'Comparison'` `node.lhsToken` branch (replace flip with the
  IS-NOT-NULL/passthrough split); the `case 'TemplateVariable'` bare-term branch (→ `message
  LIKE`); a post-loop token-position-conflict check.
- `messages.js` — add `token_strategy_conflict`; remove `means_all_token` and
  `token_vs_token_unsupported` (superseded — see the conflict-invariant note); reuse
  `wildcard_token_like`. `token_lhs_unsupported` remains as the residual floor for any
  token-LHS shape PRs 2–3 don't translate (verify during writing-plans whether any remain).
- `spl.test.js` — cases per construct; regenerate `SPL_TO_NRQL.md`.

## Testing

Data-driven `cases` per row of the disposition table: standalone `="*"`→IS NOT NULL;
`$experiment$=true`→passthrough; bare `$tok$`→`message LIKE {{tok}}` + warning; bare literal
unchanged; the OR idiom + a non-idiom both-positions case → `token_strategy_conflict`. Fuzz
×20 (grammar-adjacent). Staging-validate the emitted shapes (identifier `IS NOT NULL`, LIKE)
via the dashboardCreate harness where `{{var}}` substitution matters.

## PR breakdown (git-town stacked; each stacks on the previous)

Built for a git-town stack — every PR branches from the one above it, smallest shippable
slice first, refactor before behavior. Baseline: #90's `token_lhs_unsupported` floor (the
flip PR #91 is superseded — its flip is removed in PR 1).

1. **Revert the flip → #90's clean floor.** On the flip branch: remove the operand-flip,
   `means_all_token`, AND `token_vs_token_unsupported` (different-token comparisons stop being
   categorically unsupported — they translate in PR 2). All token-LHS returns the plain
   `token_lhs_unsupported` floor. Net-negative diff; re-baselines the stack. (~small)
2. **Field-selector passthrough.** `$tok$ <op> <value>` → `{{tok}} <op> <value>` (non-`*`).
   Grammar already emits `lhsToken`; splToIR passthrough + tests. (~small)
3. **Existence.** `$tok$="*"` → `{{tok}} IS NOT NULL` (special-case the `"*"` RHS) + tests. (~small)
4. **Conflict guard.** Post-loop "same token in field + value position" → `token_strategy_
   conflict` unsupported; covers the OR idiom + non-idiom conflicts + tests. Depends on 2–3
   (both positions must translate before the guard can see them). (~medium)
5. **Bare-token search.** `case 'TemplateVariable'` bare term → `message LIKE {{tok}}` +
   `wildcard_token_like` + tests (literal keywords unchanged). Independent of 2–4; stacked
   last to keep the diff isolated. (~small)

Each PR: green suite + fuzz ×20 + regenerated `SPL_TO_NRQL.md`, landed bottom-up via
`git town ship`.

## Out of scope (follow-on specs)

- **Importer: IDENTIFIER `replacementStrategy` for field-position tokens** (cross-package;
  the dashboard-importer must emit it so PRs 2–3 render correctly). Its own spec + stack.
- Partial-wildcard token values in field position (`$tok$="err*"`).
- `allColumnSearch`-based translations (rejected here; a genuine "substring anywhere on the
  event" need would be a separate feature).
