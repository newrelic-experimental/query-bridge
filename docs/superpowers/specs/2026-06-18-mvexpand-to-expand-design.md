# mvexpand → NRQL EXPAND Translation (design)

**Date:** 2026-06-18
**Status:** **Design only — NOT implemented.** Extracted from `.claude/rules/design-decisions.md` on 2026-06-18, where this machinery had been recorded as if shipped. A pickaxe over the full history (`git log -S field_expanded`, `-S ArrayField`) confirms these constructs have **only ever existed in design docs**, never in `src/`. This spec is the unbuilt design record; nothing here is in the code today.

## Why this spec exists

`design-decisions.md` is the ledger of *shipped* decisions. It carried a five-bullet "EXPAND (mvexpand Translation)" section describing a `by_field`-detects-`{}` grammar rule, `ArrayField` IR nodes, `field_expanded` aliasing, and cascading via `wrapAsSubquery`. None of it is implemented:

- `handleMvexpand` (`src/input/spl/rowHandlers.js`) is two lines: `ir.unsupported.push(messages.mvexpand_unsupported())`.
- `field_expanded`, `ArrayField`, and the `{}`-detecting `by_field` rule have **zero** matches in `src/`.
- The only `EXPAND` token in `src/` is a string in `messages.js` that tells users to write nested `FROM … EXPAND` *manually* as a workaround.

So the section was graduated from design before the feature was built. It belongs in a spec until we actually build it. Overlaps the EXPAND opportunity already sketched in `docs/superpowers/specs/2026-03-30-skipped-tests-design.md §2`; this is the dedicated home for the build.

## Current behavior (shipped)

- `mvexpand` → `mvexpand_unsupported()`. Cascading (`spath→mvexpand→spath→mvexpand`) and cross-field mvexpand have their own unsupported messages (`mvexpand_cascading`, `mvexpand_cross_field`).
- `{}` array-membership filters use `contains(jparse(message, 'path[*]'), …)` — the chosen, efficient path for equality/LIKE checks. **This stays; it is not what EXPAND replaces.**
- `spath path=items{}.status` → `WITH jparse(message, 'items[*].status') AS status` (WITH binding). Real and shipped.
- No NRQL `EXPAND` clause is emitted anywhere.

## Background: NRQL EXPAND (Limited Preview, Q1 2026)

Source: Confluence "Introducing NRQL EXPAND, Split, String Interpolation and Replace to Limited Preview" (QLD space, page 4423319618).

- **Syntax:** `FROM Event EXPAND listAttribute AS element SELECT …`
- Works with `FACET` (`EXPAND x AS el FACET el` — frequency per element) and `WHERE` (filter on expanded element values).
- **Known bug:** EXPAND + JOIN combination. (Out of scope here.)
- **Limited Preview, not GA** — so EXPAND is a last resort, used only when no `contains(jparse())` equivalent exists.

## The use cases that genuinely need EXPAND

1. **`stats count by validations{}.code`** — per-element grouping. `uniques()` covers `values(arr)` because it natively handles arrays, but `count by` needs real row expansion. **Primary case.** Target: `EXPAND jparse(validations) AS val FACET getField(val, 'code')`.
2. **`mvexpand`** — the 4 currently-unsupported tests (bare, cascading, cross-field) in `test/spl/spl.test.js`. mvexpand is literally row expansion; EXPAND is its NRQL equivalent.

## Proposed design (to build — none of this exists yet)

- **Grammar:** a `by_field`/field rule that detects `{}` in a field name, producing `ArrayField` nodes carrying `array` and `subfield`. (Today's `by_field_item` is the stats `BY` clause and does not detect `{}`.)
- **Naming:** `field_parsed` for jparse WITH bindings (already exists), `field_expanded` for EXPAND aliases (new). No leading underscores (NRQL rejects them). The EXPAND alias must differ from its WITH binding name.
- **Clause ordering:** NRQL requires `FROM … WITH … EXPAND … SELECT`. WITH must precede EXPAND (EXPAND references the WITH alias). Inline expressions inside EXPAND fail — always WITH-bind the array first, then EXPAND the binding.
- **Cascading:** a second mvexpand wraps the current query as a `SubquerySource` and adds a new EXPAND on the outer query. **This requires extending `wrapAsSubquery`** — its current body (`src/input/spl/splExprUtils.js`) copies only `dataSource/bindings/select/where/facet/limit` into the inner query; it does not carry an `expand` field, so cascading EXPAND cannot work until that field exists and is propagated.
- **Field-replacement scoping:** `applyFieldReplacements` must not substitute inside EXPAND or WITH source expressions, or it corrupts the array source. (The optimizer's `transformTree` traversal must exclude those positions.)

## Decision / gating

EXPAND is Limited Preview. The translator should emit it **only when no `contains(jparse())` alternative exists** — i.e. for `count by {}` and `mvexpand`, not for array-membership equality/LIKE (which keep `contains(jparse())`). Treat mvexpand→EXPAND as opt-in / last-resort, and keep emitting `unsupported` until the path is built and validated against the corpus.

## Non-goals

- EXPAND + JOIN (known NRQL preview bug).
- Changing the `contains(jparse())` membership path (it is correct and efficient).
- Any importer-side template-variable / time-token work (separate concerns).

## Test cases (currently skipped / unsupported)

- The 4 `mvexpand` cases in `test/spl/spl.test.js` (bare, cascading, cross-field) — currently assert `unsupported`.
- `stats count by validations{}.code` — currently broken/unsupported (the primary EXPAND case).

When this ships, graduate the load-bearing invariants (clause ordering, no-leading-underscore aliases, WITH-before-EXPAND, cascading via extended `wrapAsSubquery`, field-replacement scoping) back into `design-decisions.md` and delete this spec per the graduation rule.
