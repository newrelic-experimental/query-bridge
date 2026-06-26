# Rename & Alias Resolution — Unified Design

**Date:** 2026-06-25 (NRQL claims re-verified against the post-#44 tree, 2026-06-26)
**Status:** Reviewed; ready for implementation (plan: `../plans/2026-06-25-rename-alias-resolution.md`).
**Scope:** `@newrelic/query-bridge` (SPL→NRQL translator). No dashboard-importer changes.
**Adjacent work:** `2026-06-26-post-aggregation-grouping-gaps-design.md` (PR #44 follow-up). Its
**Gap C** — `eval host = count*2` *overwriting* a facet key → loud `unsupported` — borders this
spec's Family C and Part 2 facet-key handling, but is a distinct case (overwrite vs faithful
projection) on a distinct code path (the eval-after-stats `Alias(expr, field)` projection, not
`resolveSelectField`). The two do not collide; see Out of scope.

## Problem

Renaming is the translator's most persistent defect cluster. A name introduced by one
SPL command (`rename`, `eval … AS`, `stats … as`, `rex (?<n>)`, `spath output=`,
`convert … as`, `eventstats … as`) is, at most downstream surfaces, **silently lost** —
re-emitted bare, overwritten, or dropped. Confirmed members of the family:

- **CONFIRMED-7 (A)** — `rename A as B` then `table`/`fields`/`timechart by B`: the
  `A AS B` alias is overwritten; a bare `B` (a non-existent attribute) is emitted → null.
- **CONFIRMED-7 (B)** — `stats f(x) as Y | fields …`: the aggregate is overwritten by a
  bare identifier → invalid NRQL (`FACET cannot be used when selecting on event fields`).
- **FACET-by-alias candidate** (this sweep, CONFIRMED 2026-06-25) — `… by B` after a
  rename emits a bare `FACET B`, grouping on null. Folds into CONFIRMED-7.
- **CONFIRMED-15** — `eval X = f(X)` (the binding's expression references its own target
  name) silently drops the WITH binding when any command follows; the transformation is lost.
  Sibling shapes at the other `WITH`-binding producers: `convert … as X`, `spath output=X`,
  `strcat … X`. **Not** `eventstats … as X` (it emits a `SubqueryExpr`/`JoinClause`, not a
  `WITH` — no circular-binding hazard) and **not** `rex (?<X>…)` (its binding name is a tuple
  `(a, b)`, never a self-reference). (The `eventstats` candidate in the CONFIRMED-15 follow-up
  sweep rested on a stale report; the current JOIN form has no circular-WITH defect.)

Root cause (verified, surface map 2026-06-25; re-confirmed against the post-#44 tree
2026-06-26): **there is no alias-tracking structure on the IR** (`grep` confirms only
`_fieldReplacements`, `_fillnullMap`, `_timeBucketAliases`, `_currentAlias`, `_hasAggregation`,
`_headBetweenAgg` exist — no `_renameMap`; `_rowWiseOuter` was removed when the compound-chain
fold pass landed in #44). Each producer writes an alias into a different IR slot (`ir.select` Alias
nodes, `ir.bindings` WITH, `ir.facet` Identifiers), and most consumers re-emit the name
bare without resolving it. The emitter is NOT the blocker — `irToNrql` already renders
every faithful form (`expr AS 'label'` for SELECT/FACET, `expr AS name` for WITH); the
defect is entirely IR-construction discarding the binding before the emitter sees it.

## The families (two owned, one seam)

The cluster splits cleanly. This spec owns Families A and C, and defines the seam to B:

- **Family A — name resolution (single level, no nesting).** SPL `rename A as B`
  *rebinds* the field: downstream the field is `B` and `A` is gone (it is NOT a
  display alias — that is NRQL's `AS` semantics, not SPL's). NRQL has no field-rename
  primitive, so the translator must resolve a downstream reference to `B` back to its
  source attribute `A` and emit the NRQL relabel form. Also covers a `stats` aggregate
  consumed by a projection. Fix: *resolve the name, don't overwrite/emit-bare.* No subqueries.
- **Family C — collision (in-place reassignment).** An alias equal to an existing source
  field, which NRQL `WITH` cannot bind. Fix: *alias to a fresh name and rewrite downstream
  references* (faithful), reusing the existing `_fieldReplacements` pass.
- **Family B — rename across an aggregation boundary** (`stats … | … | rename …`). This
  is the same machinery the **now-shipped** compound-chain fold pass
  (`src/ir/foldPostAggregation.js`, PR #44 merged; invariants in
  `.claude/rules/design-decisions.md` → "IR & Optimization") provides — subquery-wrap-and-project
  collapsed by an optimizer pass. This spec **defines the seam** (below) but defers the
  implementation to compose with that pass.

## NRQL facts this design rests on (verified 2026-06-25)

All via `run_nerdgraph_query` (the trustworthy oracle; `execute_nrql_query` runs an older
grammar — see CLAUDE.md), accounts 1 and 10671289, 5-minute windows:

1. **`FACET <source> AS '<label>'`** groups on the real source attribute and relabels the
   output column. `FROM Log SELECT count(*) FACET level AS 'Severity'` → rows carry both a
   `facet` key and a `Severity` column. ✓ (acct 1) — **this is the faithful rename-in-FACET form.**
2. **`ORDER BY <select-alias>`** works: `SELECT count(*) AS cnt FACET level ORDER BY cnt DESC`
   returns groups sorted by the alias. ✓ (acct 10671289)
3. **A `WITH` binding is usable as a FACET key** (`WITH expr AS v … FACET v` compiles). ✓
4. **A SELECT `AS` label is not referenceable elsewhere in the same query level, and the
   failure mode is surface-dependent — mostly SILENT, not loud.** Verified acct 1, 2026-06-25,
   with a guaranteed-fake alias `xqv` (acct 1 Log has real short-named fields — e.g. `c` →
   NETWORK/ACCESS/WTCHKPT — that silently poison a test aliasing to them):
   - **WHERE** (comparison or post-FACET), **FACET `<alias>`**, and an **alias used as a
     function arg** (`latest(alias)`) → read as a nonexistent attribute → null/empty, **NO
     error**: `… AS xqv WHERE xqv>5` → `{xqv:0}`; `… AS xqv FACET xqv` → `[]`;
     `latest(x) AS d, latest(d) AS e` → `e:null`.
   - **A bare alias operand in a scalar SELECT expression** (`… AS xqv, xqv + 1 AS xqv2`) →
     LOUD `Value must be constant in its context: Id{name='xqv'}`. This is the ONLY surface
     that errors.
   - **`ORDER BY <alias>`** works (the projected column is materialized by then).
   `WITH` is the only intra-level referenceable name. Mechanism (dirac `CompilerExpressionPlan`):
   WHERE/FACET/func-arg compile the bare name as an event-field ref (unknown → null, silent);
   only a scalar value position (`compileAsTaggedValue`) raises `unsupportedNonConstant`.
   **Why it matters (strengthens the design):** because WHERE/FACET fail SILENTLY, a
   bare-emitted rename on those surfaces is silent wrong data, not a crash — NRQL will NOT
   catch it. Resolve-at-consumer (Part 2) for WHERE and FACET is the only line of defense, and
   Part 4's "warn when a rename can't be resolved" is essential, not cosmetic. NRQL's loud
   error backstops only the scalar-sibling case.
   Reference: `.claude/references/nrql-reference.md` → "Renaming & relabeling".
5. **The emitter already prints the faithful forms** — `irToNrql` Alias case →
   `expr AS '<name>'`; WITH bindings → `expr AS <name>` (smart-backticked). No emitter
   change is needed for Families A/B except the collision guard (Family C).

## Design — Approach: unified alias registry + resolve-at-consumer

Rejected alternatives: emitter-side symbol-table resolution (wrong layer — the emitter
already supports the forms; the bug is upstream IR construction; also fights the
compound-chain pass which works on IR) and the V1 shared-select accumulator (regresses the
explicit-select IR model, doesn't generalize to FACET/ORDER BY).

### Part 1 — `ir._renameMap` (display-only resolution)

`handleRename` records `{ aliasName → sourceExpr }` for each `rename A as B`, in addition
to what it does today. The map is the single source of truth for "a downstream reference to
this renamed name resolves to that source attribute" — needed because NRQL has no
field-rename primitive (SPL has rebound the field to `B`, but NRQL can only reach the data
via the original attribute `A`). The map holds `rename` bindings only: `eval`/`stats`
aliases are real computed columns that already live in `ir.select`/`ir.bindings` and are
resolved against those structures, not the map.

### Part 2 — resolve-don't-overwrite at every consumer

The destructive `ir.select = cmd.fields.map(...)` in `handleTable`/`handleFields`
(`rowHandlers.js`) is replaced by a resolver: for each requested field name, resolve
against, in order, (a) an existing `ir.select` `Alias`/aggregate item (preserve it —
fixes CONFIRMED-7 Symptom B, the dropped stats aggregate), then (b) `ir._renameMap` (emit
`source AS 'alias'` — fixes Symptom A), else (c) a bare identifier as today.

The same resolution is applied at the other consumer surfaces the surface map found
emitting bare:
- **FACET** (`handleStats`/`handleTimechart`/`handleTop`/`handleRare`/`handleDedup`):
  a group-by name found in `_renameMap` emits `FACET source AS 'alias'` (NRQL fact #1).
- **ORDER BY** (`handleSort`): resolve through `_renameMap` to the source (or keep a
  stats-alias bare — NRQL fact #2 says a SELECT alias is a valid ORDER BY key).
- **post-stats `where`/`search`** and **downstream `eval`**: resolve referenced names the
  same way before building the comparison/expression.

### Part 3 — collision family (Family C, faithful rewrite)

The `WITH`-binding producers — `handleEval`, `handleConvert`, `handleStrcat`, `handleSpath`
(NOT `handleRex`, whose binding name is a tuple `(a, b)`; NOT `handleEventstats`, which builds
a `SubqueryExpr`/`JoinClause`, not a `WITH`): the real NRQL constraint is **self-reference,
not name collision** (verified acct 1, 2026-06-25; re-confirmed acct 10671289, 2026-06-26:
`WITH concat(level,'_x') AS level` → `Circular dependency found. Variable assignment 'level'
cannot be dependent on itself`). `WITH X AS <expr that references X>` fails; but
`WITH <expr not referencing X> AS X` is *accepted* and correctly shadows an existing field
`X`. So the trigger is precisely the `eval X = f(X)` shape — a binding whose expression
references its own target name (exactly the CONFIRMED-15 cases).

The eval path is **already** routed by an existing check: `translateEvalExpr` detects this
shape with `exprReferencesField(expr, assignment.field)` and currently does `ir.select.push(expr)`
— a bare, name-less push that a following `table` overwrites (the silent-drop). The fix
**rewrites that existing branch** (and the analogous `Binding` sites in convert/strcat/spath)
via one shared helper: alias to a fresh deterministic name (e.g. `total_MB` → `total_MB__r1`)
and register a `_fieldReplacements` entry so downstream references resolve to it — preserving
the transformation. Reuse the **existing** `exprReferencesField` from `splExprUtils.js`; do not
add a parallel self-reference helper. A *non*-self-referential reassignment (`eval X = <const /
other fields>` where `X` merely happens to exist) needs **no** rewrite: `WITH <expr> AS X`
already shadows the field faithfully. `applyFieldReplacements` already rewrites
select/where/facet/orderBy (and deliberately NOT bindings/expand/dataSource — see
`design-decisions.md`), the safe surface for this rewrite — and crucially it covers WHERE/FACET
references uniformly, which a per-consumer resolver would have to wire by hand. The trade-off:
the rewrite is to a **bare** fresh name, so the output column is `total_MB__r1` (value-faithful,
column cosmetically renamed). A relabel back to the original name (`total_MB__r1 AS 'total_MB'`)
is valid NRQL (verified acct 10671289, 2026-06-26) but deferred — it is select-only, whereas
the replacement must also serve bare-name WHERE/FACET/ORDER BY positions. The fresh-name scheme
must be deterministic (byte-identical re-runs) and collision-checked against the existing field
set.

As a backstop, add an emitter-side guard: a `WITH` binding that is **self-referential** (its
name appears in its own expression, detected with the same `exprReferencesField`) is a
translator bug by the time it reaches the emitter — surface a loud `unsupported`/throw rather
than emit NRQL that fails the circular-dependency check.

### Part 4 — fix the backwards `rename_keeps_original` warning

Today `rename_keeps_original` fires only on the `!ir._hasAggregation` path (where a
`Wildcard()` is pushed and the alias actually IS kept), and is **silent** on the
post-stats / `table` / `facet` paths where the alias is lost. Flip it: fire when a rename
cannot be resolved (genuinely dropped); do not fire when resolution succeeds. The exact
message wording is settled during implementation against the message-key checks in
`test/spl/spl.test.js` (there is no separate `messages.test.js`).

## Part 5 — the Family B seam (compound-chain-collapse integration)

A `rename` appearing **after** an aggregation is just one more post-aggregation transform.
It must compose with the shipped compound-chain fold pass (`src/ir/foldPostAggregation.js`,
PR #44), not duplicate it:

- **`_renameMap` population already survives** the fold pass's "naive-wrap" design. That pass
  has the post-aggregation handlers (`handleEval`/`handleWhere`/trailing-`stats`) naively call
  `wrapAsSubquery`, then `foldPostAggregation` collapses the over-nesting (`_rowWiseOuter`/
  `compound_rewrap_unsupported` were removed). `handleRename` is not in that pass's edit set,
  so `_renameMap` population (Task 2 of the plan) is unaffected — but the fold pass's walk must
  read `_renameMap` when it projects/renames on the outer.
- **Cross-aggregation rename resolves on the OUTER.** When the aggregation becomes an inner
  subquery, a trailing `rename Y as Z` (Y = a stats alias exposed by the inner) becomes a
  `Z`-labeled projection on the outer (`SELECT Y AS 'Z'`), resolved via the same registry.
  The optimizer pass owns the wrap; this spec owns the name resolution it calls into.
- **Shared `wrapAsSubquery`; one owner for nesting.** Both this work and the shipped fold pass
  touch `wrapAsSubquery` and the post-aggregation handlers. The nesting/fold decision stays
  owned by `foldPostAggregation`; this spec contributes only the alias-resolution helper the
  pass (and the single-level consumers) call. Because the pass already exists, Family B's
  resolution plugs into it when built; until then Family B stays `unsupported`/subquery (the
  existing behavior). Family A/C (this plan) is independent and safe to land now.

## Messages

- **New:** a message for an unresolvable rename (replacing the misdirected
  `rename_keeps_original` firing) — fires only when a renamed name is genuinely dropped.
- **Reused:** the existing in-place-overwrite warning (`convert`'s current message) becomes
  the shared Family-C signal when a faithful rewrite is not possible.
- **Kept:** `subquery_name_collision` (still applies to inner-aggregate name clashes).
- Every new/changed key is validated by the message-key spy check in `test/spl/spl.test.js`
  (there is no separate `messages.test.js`): a key fires only if a case lists it in
  `warningFunc`/`unsupportedFunc`, and those arrays must be exhaustive.

## Test plan

Tests are derived in three layers, in this order, to avoid context-poisoning:

1. **Clean-room (spec-only) layer.** A fresh subagent is given ONLY this spec — no source,
   no file paths, no IR/key names — and asked to propose, in prose, the SPL→NRQL cases that
   would prove each behavior (and each failure mode). This produces the open-minded coverage
   set the implementer would otherwise miss.
2. **Code-specific layer.** On top of the clean-room set, add cases tied to the actual
   surfaces: the CONFIRMED-7 A+B rows and the CONFIRMED-15 rows from `TEST_MATRIX.md`
   (including the critical guards — new-name aliasing works, chained *distinct*-name assign
   works — that pin the defect to *same-name* collision), plus FACET-relabel and ORDER-BY-
   alias rows.
3. **Collapse duplicates.** Merge cases from layers 1–2 that exercise the same path.

All land as data-driven `cases` in `test/spl/spl.test.js` (the sanctioned array),
`verified: false` until a human promotes them, with exhaustive `warningFunc`/
`unsupportedFunc` arrays. Each `regression` case must FAIL on HEAD (proving it catches the
bug) and pass after the fix; `guard` cases pass today and lock correct behavior.

- **Expert review:** the SPL-expert and NRQL-expert agents review this spec's translation
  claims; any change they propose is **independently verified** (`run_nerdgraph_query`,
  5-min windows, or the SPL docs/3-parser cross-check) before adoption — subagents err from
  missing context.
- **Corpus baseline:** snapshot per-query verdicts via `corpus-diagnostic.mjs` (private
  sibling repo) before/after; diff to see exactly what changed (verdicts/counts only in this
  repo — query text stays in the sibling repo).
- **NRQL validation caveat:** confirm emitted NRQL via `run_nerdgraph_query`, never a single
  `execute_nrql_query` verdict (CLAUDE.md).

## Out of scope

- The compound-chain optimizer pass itself (shipped in #44; this spec composes with it at the seam).
- **`eval`/`stats` that *overwrites* a facet-key name** (`stats count by host | eval host = count*2`)
  → owned by `2026-06-26-post-aggregation-grouping-gaps-design.md` (Gap C, loud `unsupported`).
  This spec's Part 2 only *drops a projected facet key* from `table`/`fields` (a faithful case —
  `fields host, cnt` after `stats … by host`; FACET re-supplies `host`), never the overwrite case.
- Native-JSON access changes; `EXPAND`-based rewrites.
- Renaming forms already `unsupported` and correct to stay so (`rename` with `*` wildcards,
  `rename` of a parenthesized expression).
