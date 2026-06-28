# `spath` without `path=` (auto-extract) — design

**Date:** 2026-06-27
**Status:** Draft for review. (Brainstorming output — design forks flagged as Open Questions.)
**Scope:** `@newrelic/query-bridge` (translator). Couples to the deferred native-JSON work.
**Source:** `known-issues-laundry-list` row `spath-auto-extract` (GAP, Medium). Verified `cceb76a`.

## Problem

`spath` with no `path=` auto-extracts **every** field from the JSON/XML in `_raw` (or a named
`input=` field) into top-level fields. Today the translator correctly emits a loud placeholder:

```
* | spath
→ unsupported: spath without path= does auto-extraction, which has no NRQL equivalent;
  specify path= to extract a specific JSON field
```

That is honest — NRQL cannot "extract all fields" from a JSON blob into columns without
enumerating them, and the translator has no schema to enumerate from. But like `wildcard-rename`,
the value is in **not losing the panel** when downstream steps reference only a handful of the
auto-extracted fields.

## Relationship to the targeted `spath path=` form

`spath path=foo.bar` (a specific field) **already translates** (verified `cceb76a`):
`spath path=user.id output=uid` → `WITH jparse(message, 'user.id') AS uid`. So this spec is only
the **no-`path=`** auto-extract form, and its fix reuses that same `jparse(field, 'path')` form
for each field a downstream step references.

## Intent

Two uses, structurally distinct (mirrors `wildcard-rename`):

1. **Auto-extract then reference specific fields.** `… | spath | stats count by status` — the
   `status` field came from the JSON. The auto-extract is load-bearing only for the fields
   actually referenced downstream.
2. **Auto-extract for display of all fields** (`… | spath | table *`) — genuinely needs every
   field; no NRQL target. Stays `unsupported`.

## Options (the design fork)

**Option A — keep the placeholder (status quo).** Honest, loses the panel. Fine for use #2,
wasteful for use #1.

**Option B — jparse-rewrite of downstream references (CHOSEN).** When `spath`
(no path) is followed by references to specific bare fields, bind each referenced field `f` via
`jparse(<source>, '<f>')` — **the exact form the translator already emits for `spath path=`**
(verified: `spath path=user.id output=uid` → `WITH jparse(message, 'user.id') AS uid`). This
reuses the established `jparse`-first stance (`design-decisions.md` → "Native JSON access
(deferred — keep `jparse()`-first)"). So `… | spath | stats count by status` →
`FROM Log WITH jparse(message, 'status') AS status SELECT count(*) FACET status`. Refuse loudly
(`unsupported`) for `table *` / auto-extract-all with no enumerable downstream reference.

## Resolved decisions

1. **jparse-rewrite is the mechanism — the only option.** Native JSON access is deferred and "going
   to be a while," so Option B emits `jparse(<source>, '<path>')`, never native `field['k']`. Stays
   consistent with `design-decisions.md` → "Native JSON access (deferred — keep `jparse()`-first)";
   does not pre-empt that decision.
2. **Nested paths — settled, not an open question.** A downstream `foo.bar` maps to the 2-arg
   `jparse(message, 'foo.bar')`, the same form `spath path=foo.bar` already emits; multi-level
   paths are already supported (no new bracket-indexing to validate).
3. **`input=`/`output=` — same resolution.** Handle `input=` in v1 (source = that field);
   `output=` rename rides the existing `rename` family. No new mechanism.
4. **Cost / multiple fields — accepted.** Each referenced field becomes its own
   `WITH jparse(<source>, '<f>') AS <f>` binding; N referenced fields → N bindings over the same
   source. The cost is accepted. The only "all-at-once" form — a single `jparse(<source>)` followed
   by property access on the result — *is* the deferred native-JSON path, so per-field bindings are
   the only option until that GAs. (Whether NRDB common-subexpression-eliminates repeated
   `jparse(message, …)` over one field is unverified; correctness holds either way.)

## Behavior (assuming Option B)

- `spath` (no path), followed by downstream references to specific fields → bind each referenced
  field `f` as `WITH jparse(<source>, '<f>') AS <f>` (the established `spath path=` form); the
  downstream `f` references then resolve to the binding. `<source>` = `input=` field, else
  `message`.
- Auto-extract-all with no enumerable downstream reference (`spath | table *`, or `spath` as the
  last command) → `unsupported` (the existing message).
- A downstream field that is genuinely ambiguous (could be a real top-level attribute, not from
  the JSON) → refuse, per the same guard family as `wildcard-rename`.

## Acceptance criteria (synthetic)

- `web_logs | spath | stats count by status`
  → `FROM Log WITH jparse(message, 'status') AS status SELECT count(*) FACET status` (clean; was
  `unsupported`) — the same shape the existing `spath path=status` already emits.
- `web_logs | spath input=payload | where code="500" | stats count`
  → `… WITH jparse(payload, 'code') AS code … WHERE code = '500'`.
- `web_logs | spath | table *` → `unsupported` (auto-extract-all, no enumerable reference).
- `web_logs | spath` (last command) → `unsupported`.

## Testing

Data-driven `cases` in `test/spl/spl.test.js` (`verified: false` → `'llm'` after staging). The
emitted `WITH jparse(field, 'k')` form is the same one `spath path=` already produces, so it is
effectively pre-validated; still confirm a multi-field case runs (use `run_nerdgraph_query`;
`jparse` is in the `execute_nrql_query` false-reject set). Fuzz ×20. Corpus before/after via
`dashboard-diagnostic.mjs`.

## PR breakdown

1. **(Scope confirmation, done)** — `spath path=foo` already translates to `WITH jparse(message,
   'foo') AS foo` (verified `cceb76a`), so this spec is purely the no-`path=` form reusing that
   form. No code; folded into PR 2's context. Dependency: none.
2. **jparse-rewrite of downstream references** (~200 lines, behavior) — when `spath` (no path) is
   followed by enumerable field references, bind each referenced field as `WITH jparse(<source>,
   '<f>') AS <f>` (the established form) so its references resolve; refuse (`unsupported`) for
   auto-extract-all / ambiguous references. Add the acceptance `cases` (`verified: false`).
   Dependency: none (the `jparse(field,'path')` form is already validated).
3. **(Optional) graduate** (~30 lines, docs) — promote validated cases, graduate the invariant,
   strike the laundry-list row. Dependency: PR 2 + staging validation.
