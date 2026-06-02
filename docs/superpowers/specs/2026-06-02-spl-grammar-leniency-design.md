# SPL Grammar Leniency — Design

**Date:** 2026-06-02
**Status:** Approved (pending user review of this spec)
**Branch:** `corpus/add-sre-splunk-queries`

## Problem

The real-world corpus (`test/spl/spl-real-world.json`, 1881 queries) was expanded
on 2026-05-07 with 1,542 production SPL queries extracted from a customer's
committed Splunk dashboard XML and savedsearches.conf. 292 of these (15.5%) fail
to **parse**. Investigation (per-command isolation diagnostic) shows the failures
are overwhelmingly **valid SPL that our grammar rejects** — not malformed input.

Guiding principle (user): *if a query is committed and running in the customer's
production Splunk, it is de-facto valid SPL and our parser should accept it.*

This is a parser-leniency problem, not a translation-correctness problem. The
goal is to accept the valid SPL we currently reject, reclaiming parse failures
and lifting the clean-translate rate.

## Scope

### In scope
- Grammar leniency fixes in `src/input/spl/spl.grammar`, sequenced by failure
  frequency.
- Emit/IR changes only where needed to translate newly-parseable constructs.
- `verified: false` regression test cases drawn from real corpus queries.
- Re-running the per-command diagnostic after each commit to measure reclaim.

### Out of scope
- The `unsupported` bucket (tstats/CIM, mvexpand, streamstats, mvjoin, etc.) —
  these parse correctly and are honest loud-failures, not bugs.
- Genuinely malformed SPL that Splunk itself rejects. (The expert reviewed our
  four leading suspects; all four are Splunk-valid. None found malformed.)
- Promoting any `verified` level — humans only.

### Success criteria
Each commit measurably reduces the 292-error count with zero regressions: the
existing suite stays green, and an old-vs-new corpus comparison shows errors
moving only down, clean/warnings only up. Any query going clean→error blocks the
commit.

## Diagnostic findings (real failure distribution)

Attribution via per-command isolation: split each failing query on top-level `|`,
re-translate each segment in a minimal wrapper, attribute the failure to the first
segment that fails. 290/292 attributed to a single command.

| Command | Failures | Root cause |
|---|---|---|
| timechart | 132 (45%) | BY-clause field-list swallows `limit=`/`useother=`/`usenull=` as field names, never reaching option rules |
| top | 27 | `Top` (case), `top limit=N a, b` (options before field list, multi-field) |
| bin | 20 | `bin span=Xm _time as alias` — the `as` rename not parsed |
| sort | 19 | `sort - field`, trailing `limit=N`, multi-key, `num()/str()/ip()` type hints |
| where | 18 | `!(...)` negation, `.25` leading-dot decimals, `mvcount()>1` |
| stats/join/eval/fields/lookup/chart/spath/rex/table | ~37 | separators, quoted identifiers, nested funcs |
| THROWN | 0 | (already eliminated in prior session) |

Plus four tokenizer-leniency cases confirmed Splunk-valid by the SPL expert
(see below).

## Per-command fixes & translations

All emit targets verified by the NRQL expert; the percent subquery (item 2) was
live-validated against account 1 (see Validation section).

### 1. timechart (132)
**Parse fix:** `by_field_list` treats whitespace as a field separator, so
`by service limit=0` parses `service limit` as two fields and chokes on `=`. Make
the BY-field matcher stop before a `keyword=` option token (negative lookahead for
known option names, or stop-at-`identifier=`). May share root cause with sort/chart
— merge into one commit only if identical.

**Emit:** `... FACET service TIMESERIES <span> LIMIT N`.
- `limit=N` → `LIMIT N`; `limit=0` → `LIMIT MAX`.
- `useother=false` → silent no-op (NRQL never synthesizes an OTHER bucket; default
  already matches). Only `useother=true` would warrant a warning (cannot reproduce).
- `usenull=*` → warning ("Splunk option usenull has no NRQL equivalent").
- Semantics confirmed: SPL `limit=N` keeps top-N by-values ranked by the
  aggregation — matches NRQL FACET-limit semantics.

### 2. top (27)
**Parse fix:** `'top'i` already case-insensitive (verify); accept `limit=N` before
the field list; accept comma/space-separated multi-field list.

**Emit:** the actual emitter form (observed in review) is
`FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*) <WHERE>) AS 'percent' <WHERE> FACET a, b ORDER BY count DESC LIMIT N`.
Note: subquery is `(FROM Log SELECT count(*) ...)` not `(SELECT count(*) FROM Log
...)`; only `percent` is aliased (`count` is bare); `ORDER BY count DESC` is present.
- NRQL FACET supports multiple fields. ✓
- **Percent ALREADY works today** for single-field top — this task only adds the
  multi-field PARSE. The percent subquery wiring (with matched WHERE) already exists.
- SPL `top` emits `count` AND `percent` columns by default. Emit percent faithfully
  via subquery — validated working (see Validation).
- **Guardrail:** the percent subquery's `(FROM Log SELECT count(*) ...)` MUST carry
  the SAME WHERE clause as the outer query, or the denominator is the whole dataset
  and percentages are wrong. (Already satisfied by the existing wiring.)

### 3. bin (20)
**Parse fix:** add optional `as_clause` to the bin/bucket productions.
**Guardrail:** `as min` is a FIELD RENAME, not the `min()` function — grammar must
not confuse the two.

**Emit:** `bin span=Xm _time as alias` → `TIMESERIES X`. The alias is an internal
SPL handle for the binned time field; dropped. If the alias is later referenced as
a non-time field, that path is **unsupported** (loud failure).

### 4. sort (19)
**Parse fix:** allow space after `-`/`+`; accept trailing `limit=N`; multi-field
sort; tolerate `num()/str()/ip()` type-hint wrappers around the field.

**Emit:** `ORDER BY <first> DESC LIMIT N` (existing single-field ORDER BY).
- `-field` desc, `+field`/bare asc; `-` applies only to the immediately-following
  field (`sort -aaa username` = `aaa` DESC, `username` ASC).
- 2nd+ sort key → warning that it is dropped (NRQL ORDER BY is single-field;
  existing behavior).
- `limit=N` → `LIMIT N`; `limit=0` → `LIMIT MAX`.

### 5. where (18)
**Parse fix:** add `!` as NOT in where context; allow leading-dot number literals;
ensure multivalue funcs (`mvcount`, etc.) resolve in where.

**Emit:**
- `!(match(field,"regex"))` → `NOT (field RLIKE 'regex')`. NRQL supports `NOT (...)`;
  `RLIKE` is correct for `match()` (regex), NOT `LIKE` (literal/`%`).
- **GUARDRAIL:** `!=` comparison must be matched BEFORE the bare-`!` NOT rule, and
  bare `!` only matches when followed by `(` or whitespace+expr — never `=`.
  Otherwise `where x != 5` mis-parses as `!(x = 5)`. (Verified currently correct;
  must stay correct after adding `!` NOT.)
- **`where`-after-`stats` does NOT emit HAVING** — the emitter has no HAVING support.
  It wraps as a subquery: `FROM (FROM Log SELECT count(*) ... FACET f LIMIT MAX)
  SELECT * WHERE <cond>`. Any HAVING assertion is wrong.
- `.25` leading-dot decimal is a real EMIT BUG today, not just a parse gap:
  `where .25 > count` (after stats) currently emits `` WHERE `.25` > 'count' `` —
  `.25` wrongly backticked as an attribute, `count` as a string. Fix must classify a
  leading-dot token as a NUMBER so the comparison builder treats the field as a
  field. Target: `... WHERE .25 > numeric(count)`. (NRQL accepts leading-dot
  decimals — live-validated — so pass-through of the literal is fine; the bug is the
  operand misclassification.)
- `="TRUE"` in where is an exact string match (distinct from search substring).

### 6. Long tail + tokenizer leniency (~37)
Per-construct smallest viable grammar change. Includes the four expert-confirmed
tokenizer cases:

1. `| table, a, b` — leading/empty comma. Splunk drops the empty token →
   `table a, b`. Make list items empty-tolerant.
2. `cs_uri_query !="*Lucky*"cs_uri_query != "*nui*"` — closing double-quote is a
   hard token boundary in **search context**; tokenizes as two ANDed comparisons.
3. `IN ("a","b" "c", "d")` — `IN` list separators are comma-OR-whitespace; the
   space between `"b"` and `"c"` is a valid separator → 4 items.
4. `sourcetype="..."cs_uri_query = "..."` — same quote-boundary rule as #2.

## Cross-cutting guardrails

1. **Separator leniency (comma/space/empty interchangeable) applies ONLY to**
   `stats` / `top` / `fields` / `by` / `IN` lists. It MUST NOT touch `rename` pairs
   (`rename a AS b c AS d` — space-separated, a comma breaks pairing) or `eval`
   comma-chained assignments (commas separate distinct assignments).
2. **Quote-as-token-boundary leniency is search-context only** — do not generalize
   to eval/where.
3. **`bin ... as X`** — rename, not `min()`.
4. **`top` percent subquery** — must inherit the outer WHERE.

## Approach: frequency-first, one command per commit

Commit order by reclaim: timechart → top → bin → sort → where → long-tail +
tokenizer leniency. Each command is its own commit (per the project's
commit-separation rule), EXCEPT where two commands share an identical root cause
(e.g. by-clause-vs-option ambiguity in timechart and sort) — then fix together,
since splitting would be artificial.

Per-commit checklist:
1. Edit `src/input/spl/spl.grammar`.
2. `npm run build:parsers` (regenerate `splParser.js`).
3. Add `verified: false` regression cases from the real corpus queries this fix
   reclaims.
4. `npm run test` + `npm run lint` + `npm run types:check` — all green.
5. Re-run the per-command diagnostic; record the error-count reclaim.
6. Old-vs-new corpus comparison: errors only ↓, clean/warnings only ↑. Any
   clean→error regression blocks the commit.

## Validation

- **Percent subquery (item 2):** live-validated against account 1 via
  `execute_nrql_query` — the nested-aggregate-in-SELECT percentage pattern compiles
  and returns correct percentages. ✓ (The clause order I tested was NRQL's
  order-tolerant form; the translator's actual emitter output is
  `FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*) <WHERE>) AS 'percent' <WHERE> FACET <fields> ORDER BY count DESC LIMIT N`,
  which is equivalent and already what the codebase produces for single-field top.)
- **Leading-dot decimal (item 5):** live-validated against account 1. NRQL accepts
  `.25` directly and evaluates it to exactly `0.25` (`SELECT .25 AS quarter` →
  `0.25`; `WHERE .5 > 0.25` filters correctly). Design passes the literal through
  unchanged — no normalization needed.
- **All new test cases land `verified: false`** per project rule (LLM-reviewed, not
  human-approved). Use the `validate-test-cases` skill to validate translated NRQL
  via MCP before any future promotion (humans only).

## Testing standards

- Follow `.claude/rules/nr-ai-standards/llm-test-verification.md`: test names match
  assertions; exhaustive `warningFunc`/`unsupportedFunc` arrays (list ALL message
  functions that fire).
- AI-DEV markers added only after a test passes the red-green-refactor cycle.
- No `verified` promotion in this work.

## Risks

- **By-clause/option disambiguation** is the highest-value and highest-risk change
  (45% of payoff). A too-aggressive lookahead could mis-parse legitimate by-fields
  named like options (a field literally named `limit`). Mitigation: lookahead must
  require `identifier =` (option shape), so a bare by-field `limit` without `=`
  still parses as a field.
- **Separator leniency over-reach** into rename/eval — explicitly guard-railed above.
- **Quote-boundary leniency** could change tokenization of valid search terms —
  scope to search context, add regression cases for both the lenient case and the
  normal spaced case.
