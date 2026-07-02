# Spec — an authoritative NRQL function catalog from NRQLDocServlet

## Summary

The translator hand-maintains three drift-prone lists of NRQL function names —
`NRQL_AGG_FUNCS` and `FOLD_SAFE_FUNCS` (both inline in
`packages/nr-query-bridge/src/ir/foldPostAggregation.js`) and
`ROW_WISE_UNIMPLEMENTED` (`packages/nr-query-bridge/src/input/spl/splToIR.js`) —
plus the function sections of `.claude/references/nrql-reference.md`. NRDB's own
NRQLDocServlet publishes the ground truth. We propose a refresh script (run by an
NR employee on the prod VPN) that fetches the servlet JSON, filters it to
customer-facing functions, and writes a checked-in catalog module the translator
consumes offline. `NRQL_AGG_FUNCS` becomes derived from the catalog; `FOLD_SAFE_FUNCS`
stays a curated overlay guarded by a subset test; `ROW_WISE_UNIMPLEMENTED` stays
hand-maintained. Constraint: the servlet is **prod-VPN-only**, so the artifact must
be committed and every consumer path must work with no network and no dependency.

## Problem

Three separate function-name sets are maintained by hand and kept in sync by staging
probes and memory. They drift. The catalog's own definition of the "distributed"
(fold-safe) set already diverges from ours today — verified against a live fetch on
2026-07-02:

- The servlet's distributed set (functions present in **both** its `aggregators` and
  `functions` arrays) is `{abs, ceil, clamp_max, clamp_min, convert, exp, extractfield,
  filter, floor, if, ln, log, log10, log2, mod, pow, round, sqrt, string, toDatetime,
  toTimestamp}`.
- Our `FOLD_SAFE_FUNCS` omits `clamp_max`, `clamp_min`, `filter`, `toDatetime`,
  `toTimestamp`, and lists `case` — which the catalog knows as `cases`, a scalar-only
  function that is **not** distributed. That entry is either dead or a bug; nothing tells
  us which today.

The `execute_nrql_query` MCP tool can't be the authority either: it runs a stale grammar
that false-negatives on 12 functions (per CLAUDE.md). The servlet is the engine's own
answer to "does this function exist, in what category."

**Who it's for:** the translator's fold/subquery logic (which uses the aggregate set to
decide when a query is post-aggregation) and future work that needs a trustworthy
function inventory.

**Success criteria (measurable):**

1. All three lists trace to one committed artifact; `npm run refresh:nrql-catalog`
   regenerates it in one command.
2. A drift test fails when the committed catalog differs from a fresh customer-facing
   fetch (on VPN) and **skips** cleanly off-VPN — no red CI for OSS maintainers.
3. Consumers import the catalog with zero runtime dependency and no network call.
4. No `INTERNAL_STABLE` or `nrAdminOnly` function names or internal stage dates land in
   tracked files.

## What the servlet gives us

Live fetch of `https://staging-nrql-query-gateway.vip.cf.nr-ops.net/nrql_doc.json`
(HTTP 200, ~96 KB, no auth, prod VPN only) returns three arrays:

| Array | Count | Meaning |
|---|---|---|
| `aggregators` | 92 | aggregate-capable functions |
| `functions` | 89 | row-wise / scalar functions |
| `eventFilters` | 6 | WHERE-clause filter functions (no consumer today) |

Each entry carries `name`, `aliases`, typed `arguments`, `features`, `stage`
(`STABLE` 109 / `BETA` 33 / `EXPERIMENTAL` 2 / `INTERNAL_STABLE` 43), `stageDate`, and
`nrAdminOnly`. Names are canonical-lowercase; friendly forms are aliases
(`getField`→`extractfield`, `jparse`→`jsonparse`, `percentile`→`nrpercentile`).

What it **can't** give us: `ROW_WISE_UNIMPLEMENTED`. That list encodes which functions
fail on a WHERE *comparison RHS* — a per-context evaluator behavior the catalog doesn't
express (a function's presence in `functions` says it exists, not that it works in every
clause). So the list can't be derived from the catalog and stays hand-maintained,
independent of this work.

Caveat worth flagging (out of scope here): spot-checks on 2026-07-02 via NerdGraph
(acct 1) show `jparse` and `convert` now **compile** on a WHERE-comparison RHS, contra
the list's `2026-06-10` in-code note (which likely used the stale `execute_nrql_query`
grammar). `ROW_WISE_UNIMPLEMENTED` may be over-conservative today. That is a separate
investigation — this spec does not change its contents or behavior.

## Proposed approach

Two audiences, one committed artifact:

```
NR employee on prod VPN:                     Everyone else (offline, zero-dep):
  npm run refresh:nrql-catalog                 import { NRQL_AGGREGATE_FUNCS,
    ├ curl /nrql_doc.json                                isDistributed, stageOf }
    ├ filter → customer-facing                         from './nrqlCatalog.js'
    │   (drop nrAdminOnly + INTERNAL_STABLE)
    ├ normalize: dedupe by name, expand          CI drift test:
    │   aliases, lowercase-canonical                   live-fetch IF reachable →
    ├ write nrqlCatalog.snapshot.json (audit)          assert committed == fresh;
    ├ write nrqlCatalog.js (materialized Sets)         SKIP off-VPN (mirrors
    └ prettier --write both → commit                   scan-customer-names.sh)
```

**Files**

- `scripts/refresh-nrql-catalog.mjs` — NR-employee tool. Fetch → filter → normalize →
  write both files → `prettier --write`. Uses Node freely (a dev script, not runtime).
- `packages/nr-query-bridge/src/ir/nrqlCatalog.snapshot.json` — filtered audit artifact.
  Its diff is the reviewable record of what changed in the catalog.
- `packages/nr-query-bridge/src/ir/nrqlCatalog.js` — generated module. Exports Sets as
  **materialized literals** (no JSON import at runtime, so the runtime path is pure JS,
  offline, dep-free). Everything lowercased and alias-expanded so lookups are
  case-insensitive:
  - `NRQL_AGGREGATE_FUNCS` — the `aggregators` array (customer-facing), ~58 distinct names.
  - `NRQL_SCALAR_FUNCS` — the `functions` array (customer-facing), ~74 distinct names.
  - `NRQL_DISTRIBUTED_FUNCS` — the fold-safe capability set. Computed as `aggregators ∩
    functions` from the **unfiltered** arrays (see "The distributed set is computed
    pre-filter" below), 21 names.
  - `stageOf(name)` → `'STABLE' | 'BETA' | 'EXPERIMENTAL'`.

Counts verified against a live fetch on 2026-07-02: 92 aggregator entries / 89 function
entries collapse to fewer distinct names (`extractfield`, `uniquecount`,
`regexcapture`, `boolean` appear more than once); dropping `INTERNAL_STABLE` +
`nrAdminOnly` leaves ~58 aggregate and ~74 scalar names.

### The distributed set is computed pre-filter

Fold-safety is an engine *capability* (can this function run in aggregate/distributed
position), which is independent of a function's documentation `stage`. Computing
`NRQL_DISTRIBUTED_FUNCS` from the customer-facing-*filtered* arrays would silently drop
`extractfield` — it is `INTERNAL_STABLE` as an aggregator but `STABLE` as a function —
and `extractfield`/`getField` is load-bearing in the fold path (`foldPostAggregation.js`
uses `getField(col, '50')` for non-scalar extraction). So the distributed set is computed
from the **unfiltered** intersection. This admits exactly one `INTERNAL_STABLE` name
(`extractfield`), which the translator already emits in tracked source today — so it
leaks nothing new. The customer-facing filter still applies to the recognition/inventory
exports (`NRQL_AGGREGATE_FUNCS`, `NRQL_SCALAR_FUNCS`).

**Consumption**

- `NRQL_AGG_FUNCS` (foldPostAggregation.js) → **derived** from `NRQL_AGGREGATE_FUNCS`.
  This broadens aggregate recognition from 15 names to ~58, feeding `isAggregateExpr` and
  thus fold/subquery decisions — a real behavior change, verified against corpus + fuzz
  and landed last. `isAggregateExpr` must lowercase the node name before lookup.
  - **Preserved-recognition check (strict superset).** 14 of the current 15 names are
    catalog aggregators (name or alias). The 15th, `standarddeviation`, is deliberately
    kept via a curated `AGG_ADDITIONS = ['standarddeviation']` overlay, so the derived set
    is a strict superset of today's 15 and Task 3 never narrows recognition. A test
    asserts this superset. Why it's needed: `standardDeviation()` is not a callable NRQL
    function (NerdGraph: `Unknown function standardDeviation()`), but a bare `stddev(x)`
    **exposes its subquery column as lowercase `standarddeviation`** (verified on staging
    acct 1: `SELECT * FROM (SELECT stddev(consumingAccountId) FROM NrDailyUsage)` →
    column `standarddeviation`; NRQL attribute refs are case-sensitive). The translator
    emits `stddev` (`splExprUtils.js:69`) and maps its exposed name to `standarddeviation`
    (`foldPostAggregation.js:80/198/318`). Keeping `standarddeviation` in the recognition
    set costs nothing, leaks nothing (it is not a customer/internal identifier), and
    preserves current behavior exactly.
- `FOLD_SAFE_FUNCS` → **curated overlay**, unchanged in behavior. A test asserts it is a
  **subset** of `NRQL_DISTRIBUTED_FUNCS`: staying conservative (omitting distributed
  functions) is allowed; claiming a function is fold-safe when the catalog says it isn't
  fails. This flags our `case` entry: `case` is not a catalog name at all (the nearest is
  the scalar-only function `cases`, which is not in the distributed set), so it fails the
  subset check and must be reconciled — removed if dead, corrected if it maps to a real
  distributed function.
- `ROW_WISE_UNIMPLEMENTED` → hand-maintained. Optional soft test: every name is a real
  catalog function (catches typos).

The consolidated `nrqlAggregates.js` referenced in the handoff lives on an unmerged
branch (`feat/render-fails-order-by`). If it lands first, the derived export replaces
its contents; the design is the same either way.

## Alternatives considered

- **Live fetch at runtime** — rejected by the firm zero-runtime-dependency / offline rule
  (`.claude/rules/design-decisions.md`) and by the VPN gate.
- **Drift-test only, no generation** — keeps all three lists hand-curated and just flags
  divergence. Rejected: it leaves the aggregate set (a pure catalog fact) hand-copied
  when it could be generated. We keep the *fold-safe* list curated for exactly the reason
  this option cites, but not the aggregate list.
- **Full replace** (consume catalog for everything, including fold-safe) — rejected: it
  discards deliberate translator conservatism (we omit `filter`, `clamp_*` on purpose).

## Consequences, risk, and tradeoffs

- **Behavior change in PR3 is the real risk.** Aggregate recognition 15 → ~58 changes
  which queries `isAggregateExpr` treats as post-aggregation, which changes fold/subquery
  output. Mitigated by full corpus + fuzz(20×) before landing, and by staging PR3 behind
  the inert module (PR1) and the guard test (PR2). Worst case: a newly-recognized
  aggregate (e.g. `apdex`, `histogram`) triggers a subquery wrap that previously didn't
  happen. Corpus diff catches it. **Watch `derivative` and `predictLinear`** — verified
  live as timeseries-oriented functions that return `null` without a TIMESERIES and don't
  compose like ordinary group-reducing aggregates; treating them as plain aggregates could
  misclassify. Confirm their fold/subquery handling explicitly in PR3, or exclude them
  from the derived set with a comment.
- **Casing is a correctness trap.** Catalog names are lowercase; today's `NRQL_AGG_FUNCS`
  has `uniqueCount` (camelCase). If a consumer compares raw `node.name` against a
  lowercased set, recognition silently breaks. Every consumer lowercases before lookup.
- **Refresh is manual and NR-only.** OSS maintainers can't regenerate; they consume the
  committed artifact. The drift test skips for them. Accepted — the catalog is not
  env-specific data and moves slowly.
- **Reversibility:** two-way door. The module is additive scaffolding (PR1–PR2); the one
  behavior change (PR3) reverts by restoring the inline set.

## Rollout — PR breakdown

Ordered, smallest shippable slice first, scaffolding before the behavior that consumes
it, wire/activate last. Each layer ships with the tests that exercise *it*.

1. **Refresh script + checked-in catalog (inert).** `scripts/refresh-nrql-catalog.mjs`,
   the `npm run refresh:nrql-catalog` wire-up, the filtered `nrqlCatalog.snapshot.json`,
   and the generated `nrqlCatalog.js`. Nothing imports the module yet. Unit tests run
   **offline against the committed snapshot** (not the network): alias expansion, lowercase
   normalization, `INTERNAL_STABLE`/`nrAdminOnly` excluded, `NRQL_DISTRIBUTED_FUNCS ==
   aggregators ∩ functions`, `stageOf` returns the committed stage. Add `nrqlCatalog.js`
   to the same lint/format posture as the generated parser (or keep it prettier-clean so
   no exclusion is needed). ~moderate.

2. **Offline-safe drift test.** One test that live-fetches when reachable and asserts the
   committed snapshot equals a fresh customer-facing fetch, `NRQL_AGGREGATE_FUNCS` equals
   the catalog aggregators, and `FOLD_SAFE_FUNCS ⊆ NRQL_DISTRIBUTED_FUNCS`. Off-VPN /
   unreachable → `it.skip` with a clear message, mirroring `scan-customer-names.sh`. Never
   runs in public CI. ~small.

3. **Consume: derive `NRQL_AGG_FUNCS` from the catalog (behavior change).** Replace the
   inline set in `foldPostAggregation.js` with the derived export; make `isAggregateExpr`
   lowercase before lookup. Reconcile the `case`/`cases` mismatch. Verify with the full
   corpus, fuzz(20×), and new `spl.test.js` cases for any newly-recognized aggregate whose
   output changes. Gated on PR1 + PR2 green. ~larger, the activate-last step.

4. *(optional, only if corpus-justified)* **Reconcile `FOLD_SAFE_FUNCS` toward the
   catalog.** Add only the distributed functions proven safe to fold on the corpus
   (`clamp_max`, `clamp_min`, `toDatetime`, `toTimestamp`, `filter`), each corpus-verified;
   otherwise stay conservative and let the subset test pass. Drop for a first cut if the
   subset test is already green. ~small, careful.

Deploy phases: none — this is a library-internal change with no service, migration, or
production surface.

## Concerns / open questions

1. **Prod endpoint parity.** We only have the staging URL. A function catalog isn't
   env-specific, so staging suffices — but confirm there's no prod-only function set
   before treating staging as authoritative. *Weighing:* proceed on staging; note the
   assumption in the script header.
2. **`case` / `cases`.** The subset test will fail on the current `FOLD_SAFE_FUNCS` until
   we reconcile `case`. *Options:* if the translator never emits `case()`, remove it; if it
   does, confirm the real emitted name and its distributed status. Resolve inside PR3.
3. **`nrqlCatalog.js` lint/format posture.** Generated file — exclude like `splParser.js`,
   or run `prettier --write` as the script's last step so it stays in-tree clean and
   reviewable. *Leaning:* prettier-clean, no exclusion. Decide in PR1.
4. **`.claude/references/nrql-reference.md` is out of scope.** It's human narrative, not a
   list. The drift test can *inform* manual updates; regenerating it is not planned.

## Review checklist

- [ ] Offline guarantee: no consumer path fetches at runtime; `nrqlCatalog.js` has no
      import of the snapshot JSON (Sets are materialized literals).
- [ ] OSS hygiene: no `INTERNAL_STABLE` / `nrAdminOnly` names or internal stage dates in
      any tracked file (grep the snapshot + module).
- [ ] Drift test genuinely skips off-VPN (run it with the VPN down) and genuinely fails on
      an injected divergence (mutate the snapshot, confirm red on VPN).
- [ ] PR3 corpus diff: every output change is intended and explained; fuzz green 20×.
- [ ] Casing: `isAggregateExpr` lowercases before lookup; no camelCase leak in the set.
