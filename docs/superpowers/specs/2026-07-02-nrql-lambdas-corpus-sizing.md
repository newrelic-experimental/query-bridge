# NRQL Lambdas / Complex-Data feature set — corpus sizing report

**Date:** 2026-07-02 · **Status:** sizing/findings only — **no translator code changes proposed here.**
**Question:** which parts of the translator could be revised/simplified using NRQL's new LP "lambdas,
complex data & JSON" feature set, and what corpus-progress change could that buy?
**Method note:** every capability claim below was **empirically validated** against a flag-enabled
account (313870) — not inferred from the Beta Guide PDF or from error messages (see "How to reproduce").

## TL;DR

Validated against real NRQL execution, the LP feature set helps a **small, mostly flag-gated slice**:

- **LP-lambda-unique wins (need a Beta flag): ~150–175 corpus occurrences**, much of it *partial*. The one
  solid win is `EXPAND split()` / `EXPAND [a,b]` for `mvexpand` (~126); everything else is thin.
- **The bigger leverage is GA / no-flag translator work this exercise surfaced (~700+):** `uniques()`
  rewrite for `stats values()|mvexpand` (~91), the `compound_collapse` `multiEvalReagg` fold-pass fix
  (~510, compiles today), `searchmatch`/`in()` → GA `filter()`/`IN` (~180). None need the LP flags.
- **Correctness fixes this surfaced (ship regardless of LP):** multi-char `split(x,'::')` currently emits
  **non-compiling** NRQL + a warning instead of `unsupported` (**129 cases** — a loud-failure violation);
  `mvfind → find` would be **silent-wrong** (SPL `mvfind` returns an index, NRQL `find` returns the element).

**The decisive negative result:** you **cannot** run `map`/`filter`/`reduce` over a cross-event
`uniques()`/`values()` list — the "map over a list of uniques" idea. Confirmed across chain, nested,
`WITH`-bound, and subquery forms. So the ~1,795 `stats values()`-then-process corpus queries are **not**
reachable by lambdas. This is what caps the estimate at hundreds, not thousands.

## Baseline (corpus = 32,436 queries, via `corpus-diagnostic.mjs`)

| bucket | count | % |
|---|---|---|
| clean | 10,897 | 33.6% |
| warningsOnly | 9,562 | 29.5% |
| unsupported | 9,423 | 29.1% |
| errors | 2,554 | 7.9% |

The 2,554 `errors` are almost all parse/grammar failures — outside the lambda feature set's reach.
The lambda-addressable surface lives in `unsupported` + `warningsOnly`.

## The verified capability boundary

This is the load-bearing finding; every number depends on it. All tested on account 313870 (LP flags on):

| capability | verdict | evidence (run on 313870) |
|---|---|---|
| within-event array/JSON: `filter/map/reduce` over `[lit]`, `split()`, `jparse(str,'a[*]')` | ✅ | `filter([42,130,87,250], ms->ms>100)` → `[130,250]` |
| within-event chain **then** cross-event aggregate (removes a subquery-wrap) | ✅ | `average(jparse('{"a":[120,340,55]}','a[*]').reduce(sum))` → `515` |
| method chain on a within-event list | ✅ | `split('a,b,c',',').map(x->concat(x,'!'))` → `["a!","b!","c!"]` |
| **`map`/`filter`/`reduce`/`length` over a cross-event `uniques()`/`values()` list** | ❌ | rejected in **all** forms — see below |

The cross-event rejection, tested four ways (the point being to not trust a single error string):

| form | result |
|---|---|
| method chain: `uniques(host).map(x->x)` | `Unknown function uniques()` |
| nested: `map(uniques(host), x->x)` / `reduce(uniques(host), sum)` | `Unknown function uniques()` |
| any chain off it: `uniques(host).length()` | `Unknown function uniques()` |
| `WITH`-bound: `WITH uniques(host) AS h SELECT h.map(...)` | `Unknown function uniques()` |
| **subquery: `SELECT map(hosts,...) FROM (SELECT uniques(host) AS hosts FROM Transaction)`** | **`Nested aggregation query contains an unsupported function`** |

The `Unknown function uniques()` text is misleading (uniques works standalone) so we did not rely on it.
The subquery form returns a **meaningful** rejection, and the Beta Guide corroborates: `uniques` appears
in the doc **only** as a within-event `reduce` aggregator (`reduce([0,0,1,5,5,7,1,100], n -> uniques(n))`
→ `[0,5,100,1,7]`, reproduced working) — never over a cross-event result. Three independent signals agree.

### `map` vs `reduce` — which functions go where (validated)

- **`map` takes a 1→1 per-element transform only.** Row-wise functions work: binary ops (`x -> x + 5`
  → `[6,7,8]`), math (`x -> pow(x,2)` → `[4,9,16]`), `if` (`x -> if(x>1,x,0)` → `[0,2,3]`), built-ins
  (`round`, `upper`). **Aggregators are rejected in `map`** — bare *and* in-body: `map([1,2,3], sum)`
  and `map([1,2,3], x -> sum(x))` both → `Unknown function sum()`; same for `percentile`.
- **`reduce` takes an N→1 aggregator** — and *does* accept an aggregator body: `reduce(arr, n -> sum(n+5))`,
  `reduce(arr, n -> uniques(n))`. This asymmetry is the rule: aggregators live in `reduce`, never `map`.
  Supported reduce aggregators: `count, sum, average, min, max, percentile, median, uniquecount, uniques,
  percentage, if`, math (`pow`/`log`), binary ops (`OR`/`+`). `funnel` and other complex aggregators are not.

## Per-category results (validated)

| category | matched | LP-lambda-unique (flag-gated) | GA / no-flag win surfaced | notes |
|---|---|---|---|---|
| `mvexpand` → `EXPAND`/`split`/array-lit | 796 | **~126** (`EXPAND split(f,',')` 82 + `EXPAND [a,b]` mvappend 44) — EXPAND validated: compiles, fans out per element | **~91** (`stats values(X)\|mvexpand X` → GA `SELECT uniques(X)`) | P1 expand-then-filter needs no expansion (GA `LIKE`); split is **1-char delimiter only** |
| mv-eval funcs → `map/filter/find` | 1522 | **~15–35** (`mvmap` over `split()`, partial) | — | `mvzip/mvjoin/mvsort/mvdedup` have **no primitive** (confirmed: `zip()/sort()/dedup()`→Unknown, `join()`→syntax err); `mvindex/mvcount` already handled by `getField`/`length`; **`mvfind→find` is silent-wrong** (index vs element) |
| within-event JSON arrays | 406 | **~6** (filter-then-count via `length(filter(jparse(...),…))`) | — | most array shapes already handled by GA `length()`/`contains()`; the mvexpand-of-array fan-out is counted under `mvexpand` (needs EXPAND, not lambdas) |
| `compound_collapse` (982 sole / 3,176 total) | — | **~0** | **~510** (`multiEvalReagg` — flat NRQL compiles today; a fold-pass fix, no flag) | the within-event-array-between-aggregations shape is essentially absent — Splunk uses `values()` (cross-event = rejected). Prior "no" was right, for a now-correct reason |
| `bin`/FACET-by-expr + `split`/`trim` | ~66 bin | **~5** faithful-label bucketize (`FACET floor(x/N)*N`, needs FACETVALUE) | **~5 flag-free** via bucket-index `FACET floor(x/N)` (GA today); native `split`/`trim` (1-arg) already emitted | reusable-aggregator lambdas (`WITH d->percentile(d,95) AS p95`) are **readability-only** (byte-identical buckets); `ltrim`/`rtrim` native **do not exist** |
| `searchmatch`/`in()`/`foreach` | ~250 | **~0** | **~180** (`searchmatch`→GA `filter()`+`LIKE`; eval-`in()`→GA `IN`) | blocker is the translator's eval-expr **parse ladder**, not an NRQL gap. `foreach` = schema-field iteration, addressable by neither GA nor lambdas |

## The reframe (per the corpus-progress skill: count all four transitions, don't read a bucket diff as value)

1. **LP-lambda-unique (needs a Beta flag): ~150–175 occurrences**, much *partial*. Solid: `mvexpand`
   `EXPAND`/`split` (~126). Thin: mv-eval partials (~25), JSON filter-then-count (~6), FACET bucketize (~5).
2. **GA / no-flag (shippable today, ~700+):** `uniques()` rewrite (~91) + `compound_collapse`
   `multiEvalReagg` fold-pass (~510) + `searchmatch`/`in()` wiring (~180) + flag-free `floor(x/N)` bucketize (~5).
3. **Correctness fixes (wrong→correct / loud-failure):** multi-char `split` non-compile bug (**129**);
   guard `mvfind` as unsupported (silent-wrong otherwise). No flag, ship regardless.
4. **Readability-only (invisible in buckets):** reusable aggregator/predicate lambdas, `trim()` swap (~262).

Piles 2–3 (~800+, no flag) dwarf pile 1 (~150–175, flag-gated). **The lambda beta is not where the
corpus leverage is.**

## Corpus-progress estimate (validated ranges)

Stated as ranges — categories overlap on shared queries, so a true "after" number needs a combined build
+ one measurement (out of scope for a no-code sizing pass):

- **LP-lambda-unique ceiling:** **~150–175 queries** move `unsupported/error → clean/partial`
  (≈ **0.5% of the corpus**), all flag-gated, several needing a truncation warning (`EXPAND` 1:100 cap).
- **GA/no-flag reachable (this exercise's real find):** **~700+ queries**, no flag dependency.
- **The ~1,795 `stats values()`-then-process cases are confirmed OUT of reach** (cross-event list
  processing unsupported) — this is what bounds the answer to hundreds, not thousands.

## Where it does NOT help

`join`, `transaction` (sessionization), `tstats`, `streamstats` (windowing), `top`/`timechart`/`rest`/
`pivot`/`rename`/`table`/`chart` (grammar), all `rex_*` (regex — `capture()` track), `wildcard_rename`
(schema wildcard), dashboard-token embeds, `foreach` (schema iteration), and the bulk of `compound_collapse`
(cross-event/SPL-chaining). `facet_default_limit` (4,959 warn) and `dedup_facet_warning` (1,400 warn) are
NRQL-default advisories no feature removes.

## Corrections this crawl made to the earlier blind pass

- The `histogram()` emit is **not** broken — `histogram(numeric(duration),10)` compiles fine on 313870.
  The real `bin field span=N | stats by field` gap is the post-aggregation path, fixed by FACET-by-expr.
- The JSON-array family is **not** a large lambda win — most shapes are already GA (`length()`/`contains()`)
  or need `EXPAND`; the lambda-unique slice there is ~6, not hundreds.
- `mvfind → find` is a **silent-wrong trap** (index vs element) — must stay `unsupported`, not "partial".

## Gating / maturity

All gated behind Beta flags (`NrqlLambdas`/`LAMBDAS`, `Expand`, `FACETVALUE`, `SplitFunction`, native-JSON).
Verified rejected on account 1 ("BETA feature … not enabled"); enabled on 313870. **LP customer-enable
target: 2026-07-07; GA: 2026-09-30.** `sort`/`zip`/`flatten`/`mergeMap`/`intersectMap` deferred to GA.
Hard traps if emitted: `EXPAND` **silently truncates at the 100th element**; `split` is 1-char/256-cap;
native JSON has no `FACET`/`EXPAND`/`LIKE`, `Log`-only.

## Recommendations

1. **Don't adopt the lambda feature set for corpus leverage now** — payoff is ~150–175 gated queries,
   several partial. Revisit at GA (2026-09-30) and when the translator meets JSON-heavy log telemetry
   (the beta's real sweet spot, not this SRE/retail corpus).
2. **Bank the GA/no-flag wins instead** (~700+, each its own small PR + tests): `uniques()` rewrite for
   `values|mvexpand`; the `compound_collapse` `multiEvalReagg` fold-pass fix; `searchmatch`/`in()` into the
   existing `filter()`/`IN` machinery; flag-free `floor(x/N)` bucketize.
3. **Fix the correctness bugs regardless of LP:** make multi-char `split` emit `unsupported` (not a
   warning + broken NRQL); keep `mvfind` unsupported.
4. **If/when lambdas ship**, the clear candidates are `EXPAND split()` (mvexpand P4) and `EXPAND [a,b]`
   (mvexpand P3), behind a caller opt-in flag, each emitting a 1:100-truncation warning.

## How to reproduce (for Ashton, or anyone re-running this)

Two independent things were measured: **(A) the NRQL capability boundary** (does a given lambda form
run?) and **(B) corpus counts** (how many real queries hit each pattern). You can redo either.

### A. Capability probes — run lambda NRQL against a flag-enabled account

Account **313870** (a New Relic **staging** account) has the Beta flags on (`LAMBDAS`, `Expand`,
`FACETVALUE`, native-JSON). Account 1 does **not** — it returns `NRQL contains BETA feature LAMBDAS, which
has not been enabled`, which is how we confirmed the gate. Per the Beta Guide, internal users can also
enable per-query with a trailing `NR_FEATURES('<Flag>')`, but that clause is **"for internal New Relic use
only"** and was rejected through the NerdGraph path used here — so we used the flag-on account instead.

**Prereq:** a **staging** User API key with read access to account 313870 (the `curl` form below hits
`staging-api.newrelic.com`); or, if you have a flag-enabled account of your own, substitute its id.

Run any candidate via NerdGraph (`actor.account.nrql`). With the New Relic MCP server:

```
run_nerdgraph_query(
  nerdgraph_query: "query($id:Int!,$q:Nrql!){actor{account(id:$id){nrql(query:$q){results}}}}",
  variables: { "id": 313870, "q": "<candidate NRQL>" }
)
```

Or plain `curl` against NerdGraph:

```bash
curl -s https://staging-api.newrelic.com/graphql \
  -H "Content-Type: application/json" -H "API-Key: $NR_API_KEY" \
  -d '{"query":"{actor{account(id:313870){nrql(query:\"SELECT latest(filter([42,130,87,250], ms -> ms > 100)) FROM Transaction SINCE 1 day AGO LIMIT 1\"){results}}}}"}'
```

**Reading the result:** a `results` payload (even `[{"x":null}]`) = the query **compiled/ran**; an
`"error"` (`Unknown function …`, `BETA feature … not enabled`, a parse error, or
`Nested aggregation … unsupported function`) = **rejected**. Prefer literal-driven queries so you get a
concrete value rather than `null`. Keep queries cheap (`FROM Transaction SINCE 1 day AGO LIMIT 1`); wide
multi-eventtype `FACET` queries time out on 313870.

**The exact probes behind this report's boundary claims** (run each on 313870):

```sql
-- within-event: WORKS
SELECT latest(filter([42,130,87,250], ms -> ms > 100)) FROM Transaction SINCE 1 day AGO LIMIT 1      -- [130,250]
SELECT latest(reduce([120,45,230], sum)) FROM Transaction SINCE 1 day AGO LIMIT 1                    -- 395 (needs a row)
SELECT average(jparse('{"a":[120,340,55]}','a[*]').reduce(sum)) FROM Transaction SINCE 1 day AGO      -- 515
SELECT latest(split('a,b,c',',').map(x -> concat(x,'!'))) FROM Transaction SINCE 1 day AGO LIMIT 1    -- ["a!","b!","c!"]
SELECT latest(reduce([0,0,1,5,5,7,1,100], n -> uniques(n))) FROM Transaction SINCE 1 day AGO LIMIT 1  -- [0,5,100,1,7]

-- cross-event aggregate list: REJECTED (every form)
SELECT uniques(host).map(x -> x) FROM Transaction SINCE 1 day AGO LIMIT 5                             -- Unknown function uniques()
SELECT map(uniques(host), x -> x) FROM Transaction SINCE 1 day AGO                                    -- Unknown function uniques()
SELECT uniques(host).length() FROM Transaction SINCE 1 day AGO                                        -- Unknown function uniques()
SELECT map(hosts, x -> x) FROM (SELECT uniques(host) AS hosts FROM Transaction) SINCE 1 day AGO       -- Nested aggregation query contains an unsupported function

-- map vs reduce rule
SELECT latest(map([1,2,3], x -> x + 5)) FROM Transaction SINCE 1 day AGO LIMIT 1                      -- [6,7,8]
SELECT latest(map([1,2,3], sum)) FROM Transaction SINCE 1 day AGO LIMIT 1                             -- Unknown function sum()
SELECT latest(map([1,2,3], x -> sum(x))) FROM Transaction SINCE 1 day AGO LIMIT 1                     -- Unknown function sum() (map rejects aggregator body; reduce accepts it)

-- EXPAND (mvexpand candidate) + split limits
FROM Transaction SELECT count(*) EXPAND split('a,b,c',',') AS e FACET e SINCE 1 day AGO               -- fans out per element
SELECT latest(split('a::b::c','::')) FROM Transaction SINCE 1 day AGO LIMIT 1                         -- "split delimiter must be one character"
```

### B. Corpus counts — how many real queries hit each pattern

The corpus (32,436 real customer SPL queries) and its harness live in the **private** sibling repo
[`logging/nr-query-bridge-corpus`](https://source.datanerd.us/logging/nr-query-bridge-corpus) on GHE
(never public — real customer data). The translator it measures is
[`logging/nr-query-bridge`](https://source.datanerd.us/logging/nr-query-bridge); the harness expects the
two checked out as **siblings** (it imports `../nr-query-bridge/.../translate.js`).

**Prerequisites**
- Clone with Git LFS (corpus + source exports are LFS-tracked): `git lfs install`, then clone.
- Node 24 — prefix every command with `ASDF_NODEJS_VERSION=24.14.0`.
- Both repos as siblings, or set `NRQB_TRANSLATOR=<abs path to translate.js>` to point at any build.
- **The two `diag-*` scripts below must be committed to the corpus repo first** — as of this writing they
  are **untracked** (written for this analysis). A fresh clone will not have them until they land; copy
  them in from this analysis or commit them (see Appendix).

```bash
cd ../nr-query-bridge-corpus
ASDF_NODEJS_VERSION=24.14.0 node corpus-diagnostic.mjs          # baseline buckets + errors-by-command
ASDF_NODEJS_VERSION=24.14.0 node diag-message-keys.mjs          # unsupported/warn buckets broken down by messages.js key
# per-category counts + current translator output + examples for any regex:
SUBPATTERNS='split-src=split\s*\([^|]*\|.*mvexpand;;mvappend=mvappend' \
  ASDF_NODEJS_VERSION=24.14.0 node diag-category.mjs '\bmvexpand\b' 12
```

`diag-message-keys.mjs` and `diag-category.mjs` are measurement-only (they do not modify the translator).
`NRQB_TRANSLATOR=<abs path to translate.js>` overrides which translator build they run against, so a
branch/PR can be measured before merge.

## Appendix — scripts

- `corpus-diagnostic.mjs` (pre-existing) — baseline bucket counts + errors-by-command.
- `diag-message-keys.mjs` (new) — reverse-maps each fired message string to its `messages.js` key,
  breaking the unsupported/warn buckets down by key (sole-reason + co-occurrence).
- `diag-category.mjs '<regex>' [N]` with `SUBPATTERNS='n=re;;…'` (new) — per-category corpus counts,
  current-output split, and reproduced examples. Reusable for any future sizing pass.
