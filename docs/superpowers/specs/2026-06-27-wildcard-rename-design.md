# Wildcard rename (`rename a.* as *`) — design

**Date:** 2026-06-27
**Status:** Draft for review. (Brainstorming output — design forks flagged as Open Questions.)
**Scope:** `@newrelic/query-bridge` (SPL→NRQL translator). Possible follow-on in the importer.
**Source:** `known-issues-laundry-list` row `wildcard-rename` (GAP, **Very High** — the single
largest placeholder reason in real exports). Repros 100% synthetic.

## Problem

`rename <prefix>.* as *` bulk-renames every field matching a wildcard by rewriting the
matched portion — most commonly stripping a prefix so downstream steps use short names:

```
... | rename log.* as *            # log.level → level, log.msg → msg, ...
... | rename meta.annotations.* as *
```

Today (HEAD, verified `cceb76a`) the translator emits a correct loud placeholder:

```
* | rename log.* as *
→ unsupported: Wildcard rename (log.* as *) not supported in NRQL; rename specific fields
```

That is honest, but it is the **largest** placeholder bucket in the corpus — so the whole
panel is lost whenever a dashboard does prefix-cleanup, even when the rest of the query is
fully translatable. The value is not in the rename itself (NRQL has no bulk-rename); it is
in **not throwing away the surrounding query**.

## Why it has no direct NRQL form

NRQL `SELECT *` returns attributes under their stored names; there is no wildcard
`AS`-rename, and the translator has **no schema/account context** (per ARCHITECTURE.md), so
it cannot enumerate which concrete fields `log.*` matches. A faithful expansion is
impossible at translate time.

## Intent in real dashboards

Two dominant uses, structurally distinct:

1. **Display cleanup, names NOT reused downstream.** `... | rename log.* as * | table ...`
   where the projected/aggregated columns are referenced by their *original* names (or the
   rename is purely cosmetic for a `table` header). Dropping the rename changes display
   labels only.
2. **Prefix-strip then reference the short name.** `... | rename log.* as * | stats count by
   level` where `level` is the stripped form of `log.level`. Here the rename is load-bearing:
   dropping it leaves `level` undefined (NRDB resolves it to null → silently empty/wrong).

The translator cannot always tell these apart without resolving every downstream bare
identifier against the wildcard — the crux of the design fork below.

## Options (the design fork)

**Option A — better message only (status quo+).** Keep the placeholder; sharpen the message
to name the workaround ("list the specific fields, or remove the rename if downstream uses
the original names"). Zero risk, near-zero value — still loses the panel. *Rejected as the
sole fix* given this is the #1 bucket.

**Option B — drop the rename with a warning, keep original names.** Emit the rest of the
query, dropping the wildcard rename, and warn that fields keep their original (prefixed)
names. **Unsafe for use #2**: a downstream `by level` then references a non-existent `level`
→ silent null. Violates loud-failure. *Rejected unless gated on "no downstream reference to a
stripped name."*

**Option C — prefix-strip rewrite (recommended, gated).** Treat `rename <prefix>.* as *` as a
scoped rewrite rule: for every *downstream* bare identifier `X` that is not otherwise bound
(not a facet alias, eval result, capture, etc.), rewrite `X` → `<prefix>.X` in
select/where/facet/orderBy (the same surfaces `applyFieldReplacements` already covers). This
makes `... | rename log.* as * | stats count by level` →
`FROM Log SELECT count(*) FACET log.level` — faithful for the common prefix-strip case.
- **Guard (loud) — never guess; fall back to the existing `unsupported`:** (a) a downstream
  reference is **ambiguous** (could be a real top-level field *or* the affix-transformed form);
  (b) **more than one wildcard rename** in the pipeline — competing prefixes/affixes mean a bare
  name can't be attributed to one rename (the 2-renames case); (c) the rename is **not a clean
  single-affix transform** — mid-string wildcards (`a.*.b as *`) or multiple `*`.
- This reuses the field-replacement machinery and the `_fieldReplacements` scoping already in
  the IR (see `design-decisions.md` → "Field replacement scoping").

## Resolved decisions

1. **Conservative eligibility (chosen): rewrite a bare name only when it appears *nowhere except
   downstream* of the rename, and is not otherwise bound** (facet alias, eval result, capture). A
   name that also appears before the rename, or that could plausibly be a real top-level field as
   well as the affix-transformed form, is **not** rewritten → `unsupported` (ambiguous). Most
   conservative reading — never guess. (This subsumes the shadowing worry: if a bare name has any
   life outside the post-rename scope, we don't claim it.)
2. **Lives in the translator.** Field-replacement scoping (`_fieldReplacements`,
   `applyFieldReplacements`) already lives there; one implementation serves both the CLI and the
   importer.
3. **Both shapes in scope, as separate PRs.** Support leading-prefix strip (`a.* as *` → bare `X`
   becomes `a.X`) **and** single re-prefix (`* as prefix_*` → `prefix_X` maps back to stored `X`)
   — both are clean single-affix transforms. Leading-prefix strip first; re-prefix in a follow-on
   PR (same machinery, inverse direction). Genuinely messy shapes (mid-string `a.*.b as *`,
   multiple wildcards, multiple competing renames) stay loud `unsupported`.

## Behavior (Option C — clean single-affix transforms)

- `rename <prefix>.* as *` (leading-prefix strip) records `<bare> → <prefix>.<bare>`;
  `rename * as <prefix>_*` (re-prefix) records `<prefix>_<bare> → <bare>` — each applied to
  downstream select/where/facet/orderBy bare identifiers **only when the name appears nowhere
  except downstream and is not otherwise bound** (Q1).
- More than one wildcard rename, an ambiguous top-level-vs-transformed reference, or a
  non-single-affix shape (mid-string `a.*.b as *`, multiple `*`) → loud `unsupported`, never a
  silent rewrite.
- A purely trailing wildcard rename with no downstream references → drop with a warning (Option B
  is safe *only* in this sub-case).
- All other wildcard-rename shapes → existing `wildcard_rename` unsupported (unchanged).

## Acceptance criteria (synthetic)

- `web_logs | rename log.* as * | stats count by level`
  → `FROM Log SELECT count(*) FACET log.level` — the dotted name is **backticked** by
  smart-backticking (`FACET` + the backticked `log.level`); clean, was `unsupported`.
- `web_logs | rename log.* as * | where level="error" | stats count`
  → `FROM Log SELECT count(*) WHERE` the backticked `log.level` `= 'error'`.
- `web_logs | rename log.* as *` (no downstream ref) → emit base query + drop-warning.
- `web_logs | rename * as fld_* | stats count by fld_level` → `… FACET level` (re-prefix shape,
  follow-on PR) — `fld_level` maps back to its stored name `level`.
- `web_logs | rename a.*.b as *` (mid-string shape) → still `unsupported` (`wildcard_rename`).
- A query with a downstream name bound by an `eval`/`stats as` → that name is NOT rewritten.
- Collision: downstream `status` where both `log.status` and a native `status` plausibly exist
  → `unsupported` (ambiguous which the user meant), per the Option-C guard.
- Stripped name that is a reserved word (`log.limit` → bare `limit`) → the rewrite target
  `log.limit` is backticked (smart-backticking handles it).

## Testing

Data-driven `cases` in `test/spl/spl.test.js`: the prefix-strip rewrite (`verified: false` →
`'llm'` after staging validation), the no-downstream-ref drop+warning, the non-prefix shape
staying `unsupported`, and the eval-bound-name-not-rewritten guard. Fuzz ×20. Re-measure the
corpus placeholder delta with `dashboard-diagnostic.mjs` (private repo) before/after.

## PR breakdown

1. **Message + grammar/IR plumbing for prefix-strip recognition** (~150 lines, refactor+scaffold)
   — parse `rename <prefix>.* as *` into a structured `WildcardRename{prefix}` IR marker
   (today it's caught and turned straight into `unsupported`); keep emitting the existing
   `wildcard_rename` unsupported for all shapes (no behavior change yet). Add a unit test that
   the marker is produced for the prefix shape and NOT for non-prefix shapes. Inert: nothing
   consumes the marker yet. Dependency: none.
2. **Apply leading-prefix strip as scoped field replacement + guards** (~250 lines, behavior) —
   consume the marker: register `<bare> → <prefix>.<bare>` in `_fieldReplacements` for downstream
   bare identifiers that appear nowhere except downstream and are not otherwise bound (Q1); add the
   guards (loud `unsupported`): ambiguous top-level-vs-stripped, **more than one wildcard rename**,
   non-single-affix shapes; the no-downstream-ref drop+warning sub-case. Add the acceptance `cases`
   (`verified: false`). Dependency: PR 1. The behavior change; lands with its tests.
3. **Re-prefix shape (`* as prefix_*`)** (~120 lines, behavior) — the inverse single-affix
   transform: register `<prefix>_<bare> → <bare>` under the same eligibility + guards. Add its
   acceptance `case`. Dependency: PR 2 (shares the machinery + guards).
4. **(Optional) corpus re-measure + graduate** (~30 lines, docs) — record the placeholder delta,
   promote validated cases to `'llm'`, graduate the invariant to `design-decisions.md`, strike the
   `wildcard-rename` row. Dependency: PRs 2–3 + staging validation.
