# mvexpand → NRQL EXPAND Translation (design)

> **Problem tracking consolidated into** [`2026-06-27-known-issues-laundry-list-design.md`](./2026-06-27-known-issues-laundry-list-design.md) (the `mvexpand-*` / `mvzip` family). This file is kept for its fix-design detail.

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

## PR breakdown

> Retrofit per CLAUDE.md "Small PRs" rule. Each PR below is independently reviewable and shippable; land in order.

1. **Grammar: detect `{}` arrays → `ArrayField` nodes** (~150 lines, grammar) — add a field/`by_field` grammar rule that detects `{}` in a field name and produces `ArrayField` nodes carrying `array` and `subfield`; run `npm run build:parsers`. No emitter behavior yet — nodes are parsed but still route to `mvexpand_unsupported`/existing paths. Add parser-level `spl.test.js`/IR cases confirming `validations{}.code` and `items{}.status` produce `ArrayField`. Dependency: independent. Scaffolding first, before any emit consumes it.
2. **`expand` field on IR node factory + `wrapAsSubquery` propagation** (~120 lines, scaffolding) — add the `expand` field to the IR (`src/ir/nodes.js`) and extend `wrapAsSubquery` (`splExprUtils.js`) to carry it into the inner `SelectQuery` (today it copies only `dataSource/bindings/select/where/facet/limit`), so cascading EXPAND can later wrap. Scope `applyFieldReplacements`/`transformTree` to NOT substitute inside EXPAND/WITH source expressions. No EXPAND emitted yet. Dependency: needs PR 1 (`ArrayField` is the field the `expand` carries). Plumbing before the feature that consumes it.
3. **Emit EXPAND for `count by {}` + message keys** (~200 lines, behavior) — emit `FROM … WITH jparse(array) AS field_parsed EXPAND field_parsed AS field_expanded SELECT …` for the primary `stats count by validations{}.code` case, enforcing WITH-before-EXPAND ordering, non-leading-underscore aliases, and an EXPAND alias distinct from its WITH binding; gate emission to last-resort (only where no `contains(jparse())` equivalent exists). Wire `irToNrql` + any new `messages.js` keys. Move the primary EXPAND `spl.test.js` case from unsupported → asserting the EXPAND output (`verified: false`, staging-validate before promoting). Dependency: needs PR 2 (`expand` field + scoping). Single-mvexpand consumes this path too.
4. **mvexpand + cascading EXPAND** (~150 lines, behavior) — route `handleMvexpand` (`rowHandlers.js`, currently two lines → `mvexpand_unsupported`) to the EXPAND path; a second mvexpand wraps the current query as a `SubquerySource` and adds a new EXPAND on the outer (relies on PR 2's `expand` propagation). Flip the 4 skipped `mvexpand` `spl.test.js` cases (bare, cascading, cross-field) from asserting `unsupported`. Dependency: needs PR 3 (reuses the EXPAND emitter). Largest-behavior slice last, after the primary `count by {}` path proves the emitter.
