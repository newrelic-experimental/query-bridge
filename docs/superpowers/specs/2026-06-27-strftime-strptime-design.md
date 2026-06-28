# `strftime`/`strptime` → `toDatetime`/`toTimestamp` — design

**Date:** 2026-06-27
**Status:** Draft for review. (Brainstorming output — design forks flagged as Open Questions.)
**Scope:** `@newrelic/query-bridge` (SPL→NRQL translator, eval functions).
**Source:** `known-issues-laundry-list` row `strftime-strptime` (listed GAP, **High**).
**Reclassified after investigation: not a GAP — a missed-coverage BUG.** NRQL claims
live-verified on staging acct 1 (`run_nerdgraph_query`, 2026-06-27).

## Investigation correction

The laundry list lists `strftime`/`strptime` as a coverage GAP ("no NRQL equivalent"), and
the translator emits `eval function strftime() has no NRQL equivalent`. **That is wrong.**
NRQL has direct two-argument equivalents, both verified live:

```
FROM Log SELECT toDatetime(timestamp, 'yyyy-MM-dd HH:mm:ss')   → "2026-06-28 04:00:22"
                toDatetime(timestamp, 'hh:mm a')               → "04:00 AM"
                toDatetime(timestamp, 'EEE MMM dd')            → "Sun Jun 28"
                toTimestamp('15/01/2026', 'dd/MM/yyyy')        → 1768435200000
```

- **`strftime(epoch, fmt)`** (epoch → formatted string) ≡ **`toDatetime(epoch, fmt)`**.
- **`strptime(str, fmt)`** (string → epoch) ≡ **`toTimestamp(str, fmt)`**.

NRQL's format dialect is **Java `DateTimeFormatter`** patterns (`yyyy MM dd HH mm ss a EEE
MMM`), not C `strftime` `%`-codes. So the only real work is **mapping Splunk's `%`-codes to
Java pattern letters**; the functions themselves map one-to-one.

## Problem

A `High`-prevalence, fully-translatable construct is emitted as a loud placeholder, losing
the panel — purely because the function mapping and a format-code translation were never
built. Every `eval x = strftime(_time, "%Y-%m-%d")` / `strptime(field, "%Y-%m-%d")` in real
dashboards becomes a placeholder today.

## Goal

Translate `strftime`/`strptime` to `toDatetime`/`toTimestamp`, converting the Splunk
`%`-code format string to the equivalent Java `DateTimeFormatter` pattern. Emit `unsupported`
only for the residual `%`-codes that have no Java-pattern equivalent — never silent-wrong.

## Format-code mapping (Splunk strftime `%`-code → Java pattern)

Core set — **every Java target below is live-verified on staging acct 1** (2026-06-27,
`run_nerdgraph_query`), including the tail (`DDD`/`zzz`/`Z`/`yy`/`SSS`/`MMMM`/`EEEE`):

| Splunk | Java | | Splunk | Java |
|---|---|---|---|---|
| `%Y` | `yyyy` | | `%H` | `HH` |
| `%y` | `yy` | | `%I` | `hh` |
| `%m` | `MM` | | `%M` | `mm` |
| `%d` | `dd` | | `%S` | `ss` |
| `%j` | `DDD` | | `%p` | `a` |
| `%b`/`%h` | `MMM` | | `%a` | `EEE` |
| `%B` | `MMMM` | | `%A` | `EEEE` |
| `%Z` | `zzz` | | `%z` | `Z` |
| `%%` | `%` (literal) | | `%3N`/`%6N`/`%9N` | `SSS`/`SSSSSS`/`SSSSSSSSS` (verified) |

> **`%f` is NOT a Splunk code** — it is Python's microsecond code. Splunk strftime uses the
> `%N`-family (`%N`, `%3N`, `%6N`, `%9N`) for sub-seconds. Do not map `%f`; treat it as an
> unmapped code (literal or unsupported).

Literal characters pass through; a Java pattern letter that appears literally in the format
must be quoted (`'…'`) per `DateTimeFormatter` rules — the converter must escape stray
letters so `"GMT"` in a format doesn't become pattern tokens. **This is a silent-wrong trap:
an unmapped or `%`-prefixed format does NOT error — `toDatetime(timestamp,'%Y-%m-%d')` returns
the garbage string `"%2026-%38-%28"` (live-verified), since `%` is a literal and `Y`/`m`/`d`
are Java tokens.** The converter MUST translate every code; compile-checking cannot catch a
mapping bug (see Testing — value-level assertions required).

**Residual `%`-codes with no clean Java equivalent → `unsupported` for that specific code** (do
NOT drop them silently): `%s` (epoch seconds), `%U`/`%W` (week-of-year), `%e`, `%k` — each
staging-verified in PR 3 before being mapped or rejected. `%c`/`%x`/`%X` are **confirmed
unmappable** (locale-default composites are `DateTimeFormatter.ofLocalized*` `FormatStyle`
factories, not pattern strings — no `'<pattern>'` exists to pass `toDatetime`). The `%N`-family
(`%3N`/`%6N`/`%9N`/bare `%N`) is **confirmed mappable** (verified — see the mapping table), not
residual.

## Resolved decisions

1. **Java dialect edges — resolved; no edges remain open.** Core table ships as verified.
   **Sub-second widths verified (staging acct 1, 2026-06-28):** `%3N`→`SSS`, `%6N`→`SSSSSS`,
   `%9N`→`SSSSSSSSS`, bare `%N`→`SSSSSSSSS` (Splunk's nanosecond default) — all accepted
   (`toDatetime(1719500000123, '…SSS')` → `.123`, `…SSSSSS` → `.123000`, `…SSSSSSSSS` →
   `.123000000`); NRQL `timestamp` is ms-precision so `%6N`/`%9N` zero-pad (width faithful,
   precision not). **Locale composites `%c`/`%x`/`%X` → `unsupported`** — no `DateTimeFormatter`
   pattern string exists for them (they are `ofLocalized*` `FormatStyle` factories).
2. **Unmappable-code policy — translate what you can, per *format*.** Translate every format whose
   codes all map (do not blanket-reject `strftime`/`strptime`). A format containing **any**
   unmappable code → **whole-function `unsupported`** naming that code — never a partial format,
   which is silently wrong (the unmappable code emits as a garbage literal, e.g. `%c` → `c`). "What
   you can" is per-format (all-or-`unsupported`), not per-code-within-a-format.
3. **`strptime` auto-detect fallback — no.** Always pass the converted Java format when the
   `%`-format fully maps; the no-format `toTimestamp(str)` auto-detect is lossy, so never fall back
   to it when a real format is available.
4. **`_time` handling — best-effort, loud when unsure.** `_time`→`timestamp` is unit-correct
   (`timestamp` is ms — verified: `1719500000123`→`2024-06-27`). A **non-`_time` epoch field** is
   translated but carries a units caveat: the translator can't know if the field is stored in
   seconds or ms, and feeding seconds to `toDatetime` yields a 1970 date — so **warn** on a
   non-`_time` epoch arg. A genuinely-unmappable format → `unsupported` (explode loud, never
   guess).
5. **`strptime` seconds-vs-ms — divide by 1000.** `toTimestamp` returns ms, Splunk `strptime`
   returns seconds; divide the `toTimestamp` result by 1000 when it feeds arithmetic/comparison so
   downstream math matches Splunk, and warn. (When the result is only reformatted downstream, no
   divide is needed.)

## Behavior

- `eval out = strftime(<epochExpr>, "<spl-fmt>")` → `toDatetime(<epochExpr>, '<java-fmt>')`
  (as a `WITH` binding or SELECT alias per the existing eval-projection path), where
  `<java-fmt>` is the converted format. `_time` → `timestamp`.
- `eval out = strptime(<strExpr>, "<spl-fmt>")` → `toTimestamp(<strExpr>, '<java-fmt>')`.
  **Units caveat (live-verified):** `toTimestamp` returns **milliseconds**
  (`toTimestamp('2024-01-15 10:30:00','yyyy-MM-dd HH:mm:ss')` → `1705314600000`), but Splunk
  `strptime` returns **seconds** (`1705314600`). A downstream expression that treats the
  result as seconds (arithmetic, or comparison to a seconds-epoch field) is then 1000× off —
  a silent-wrong path. See Open Question 5.
- A format containing an unmappable `%`-code → `unsupported` naming that code.
- Both compose with the eval-after-aggregation / fold paths unchanged (these are row-wise
  functions, fold-safe candidates — `convert` is already in `FOLD_SAFE_FUNCS`; evaluate
  whether `toDatetime`/`toTimestamp` should join it).

## Acceptance criteria (synthetic, staging-validated)

- `web_logs | eval d = strftime(_time, "%Y-%m-%d")`
  → `… toDatetime(timestamp, 'yyyy-MM-dd') AS d` (live-runs, returns formatted date).
- `web_logs | eval d = strftime(_time, "%H:%M:%S")` → `toDatetime(timestamp, 'HH:mm:ss')`.
- `web_logs | eval t = strptime(ds, "%Y-%m-%d %H:%M:%S")`
  → `toTimestamp(ds, 'yyyy-MM-dd HH:mm:ss')`.
- `web_logs | eval x = strftime(_time, "%s")` → `unsupported` (epoch-seconds code unmappable).
- A literal in the format (`strftime(_time, "%Y GMT")`) → letters quoted so `GMT` stays literal.
- `web_logs | eval age = now() - strptime(ds, "%Y-%m-%d")` → the `strptime` result is ms; the
  arithmetic must stay unit-consistent (divide-by-1000 or warn) — see Open Question 5.

## Testing

Data-driven `cases` in `test/spl/spl.test.js`: the core mappings (`verified: false` → `'llm'`
after staging), the unmappable-code `unsupported`, the literal-escaping case, the `strptime`
units case. **Compile-checking is insufficient — a wrong format string returns garbage with NO
error (`%Y-%m-%d` → `"%2026-%38-%28"`, live-verified), so the tests must assert the EXPECTED
VALUE, not just that the query runs.** Staging-validate via `run_nerdgraph_query` (both
functions are in the `execute_nrql_query` false-reject set). Fuzz ×20. Corpus before/after via
`dashboard-diagnostic.mjs`.

## PR breakdown

1. **Format-code converter (Splunk `%` → Java pattern)** (~180 lines, scaffold+unit) — a pure
   `splFormatToJava(fmt) → {pattern, unmappable: string[]}` helper + unit tests for the core
   table, literal escaping, and unmappable-code detection. Inert: not wired into a handler
   yet. Dependency: none.
2. **Wire `strftime`/`strptime` → `toDatetime`/`toTimestamp`** (~150 lines, behavior) — in the
   eval-function resolver, replace the two "no equivalent" rejections with emission of
   `toDatetime`/`toTimestamp` using the converted format; if `unmappable` is non-empty →
   `unsupported` naming the code; `_time`→`timestamp`. Add the acceptance `cases`
   (`verified: false`). Dependency: PR 1. Lands the behavior + its tests together.
3. **Verify the long-tail codes + fold-safety** (~80 lines, behavior) — staging-verify the
   tail codes (`%j`, `%z`, `%U`, fractional), map or reject each per result; decide whether
   `toDatetime`/`toTimestamp` join `FOLD_SAFE_FUNCS`. Dependency: PR 2.
4. **(Optional) graduate** (~30 lines, docs) — promote validated cases to `'llm'`, graduate
   the invariant, **reclassify the laundry-list row from GAP to a shipped BUG fix** (the
   "no NRQL equivalent" characterization was wrong). Dependency: PR 3 + staging validation.
