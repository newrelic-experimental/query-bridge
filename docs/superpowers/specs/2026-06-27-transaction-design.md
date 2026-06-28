# `transaction` (session grouping) — design

**Date:** 2026-06-27 (revised 2026-06-28 — Option A chosen; terminology fixed)
**Status:** Draft for review.
**Scope:** `@newrelic/query-bridge` (translator).
**Source:** `known-issues-laundry-list` row `transaction-unsupported` (GAP, Medium). Verified `cceb76a`.

> Terminology: Splunk calls its raw records "events"; in our house "event" is reserved (NRDB event
> types). This spec calls the raw input records **loglines** and the grouped output a
> **transaction** (session). `duration`/`eventcount` in backticks are Splunk's own auto-created
> field names.

## Verdict

**`transaction` → `unsupported` for every form (Option A).** NRQL has no session/sessionization
primitive, and even the bare no-window case is not faithfully approximable (see below). The win is
a *better message* naming transaction's session semantics — not a translation.

## Problem

`transaction <fields> [maxspan=…] [maxpause=…] [startswith=…] [endswith=…]` groups a stream of
**loglines** into **transactions** (sessions): consecutive loglines sharing the `<fields>` value
are collapsed into one transaction, split into a new one whenever a time gap exceeds `maxpause` or
the span exceeds `maxspan`. Each output transaction carries the grouped loglines plus computed
`duration` and `eventcount` fields. Today:

```
* | transaction user_id maxspan=30s
→ unsupported: SPL command 'transaction' has no known NRQL equivalent
```

This is honest — NRQL has **no session/sessionization primitive**. The defining feature (splitting
the same key into *multiple* transactions on a time gap) cannot be expressed in NRQL.

## Why there is no faithful equivalent

NRQL aggregates by FACET into **one group per key value** — it has no notion of "start a new group
when the gap exceeds N seconds." `maxspan`/`maxpause`/`startswith`/`endswith` are exactly that
gap/boundary logic, and NRQL offers nothing equivalent (`FACET` groups globally; `TIMESERIES`
buckets by wall-clock, not by per-key gaps). So a query that *relies* on session-splitting has no
faithful translation.

## Why even the bare (no-window) case can't be approximated

A `transaction <field>` with **no** `maxspan`/`maxpause`/`startswith`/`endswith` looks like it
should map to a plain FACET aggregation that reproduces the two computed fields:

```
… | transaction user_id   (no window)
↛ FROM Log SELECT (latest(timestamp) - earliest(timestamp)) / 1000 AS duration,
                  count(*) AS eventcount FACET user_id
```

The shape is *legal* NRQL — `latest(timestamp) - earliest(timestamp)` is a per-facet duration
(how long a key's session spanned — e.g. how long a user was on the site), `count(*)` is the
logline count; the arithmetic-on-two-aggregates and FACET-grouping are both live-verified (acct 1,
per-host `duration`/`eventcount` rows). **Units:** the duration is **milliseconds** (NRQL
`timestamp` is ms) and Splunk's `duration` is **seconds**, so it would need `/1000` (the same ms/s
class as strftime/strptime).

**But it is not faithful, even with no window (doc-verified).** Splunk's official transaction
reference gives the defaults `maxspan=-1`/`maxpause=-1` (no time split — fine) but also
**`maxevents=1000`** (a positive default that splits any key with >1000 loglines into multiple
transactions) and **`connected=true`** (grouping by logline-stream *connectivity*, not the global
group-by-key a FACET does). So the FACET form mis-merges high-cardinality keys and ignores
connectivity — a **lossy approximation, not faithful** — even before any window arg. That is why
Option A (unsupported) is correct rather than shipping the FACET form.

## Decision

**Option A — `unsupported` for all `transaction` (CHOSEN).** Safe and honest; loud-over-wrong. The
deliverable is a clear `transaction_unsupported` message that names the session semantics and the
blocking window/boundary arg when present.

**Option B — lossy FACET approximation (REJECTED, not built).** Emitting
`SELECT (latest(timestamp)-earliest(timestamp))/1000 AS duration, count(*) AS eventcount FACET
<fields>` would be plausibly-wrong on real data (ignores `maxevents=1000` splitting and
`connected=true` connectivity; merges what any window arg time-splits). Not shipped — not even as
an opt-in — because a plausible-but-wrong panel is the failure mode this project avoids.

## Open questions — resolved

1. **Is the no-window FACET form equivalent? No (doc-verified).** `maxevents=1000` +
   `connected=true` mean bare `transaction` ≠ FACET. → Option A.
2. **`duration`/`eventcount` field names — moot.** Only relevant to Option B (the FACET form would
   have had to alias to those exact names); since B is not built, no aliasing work.
3. **Multi-field transactions — moot.** Same: an Option-B-only concern.

## Behavior

- `transaction …` (**any** form — windowed, bare, multi-field, or no fields) → `unsupported`
  (`transaction_unsupported`), with a message naming transaction's session semantics and the
  blocking window/boundary arg if one is present. No FACET form is ever emitted.

## Acceptance criteria (synthetic)

- `web_logs | transaction user_id maxspan=30s` → `unsupported` (`transaction_unsupported`), message
  naming the `maxspan` window split.
- `web_logs | transaction user_id` (no window) → `unsupported` (bare transaction ≠ FACET:
  `maxevents=1000` + connectivity).
- `web_logs | transaction` (no fields) → `unsupported`.

## Testing

Data-driven `cases` in `test/spl/spl.test.js`: the windowed, bare, and no-field forms all →
`unsupported` with the `transaction_unsupported` message key. `test/messages.test.js` reference for
the new key. No NRQL is emitted, so no staging run is needed for the behavior; the doc facts
(`maxspan/maxpause=-1`, `maxevents=1000`, `connected=true`) are confirmed from Splunk's official
transaction reference. Fuzz ×20.

## PR breakdown

1. **`transaction` → loud `unsupported` (all forms)** (~80 lines, behavior) — replace the generic
   `unsupported_command('transaction')` with a `transaction_unsupported` message that names the
   session semantics and the blocking window/boundary arg when present. Add the windowed/bare/
   no-field `cases` + the `messages.test.js` reference. Dependency: none.
2. **(Optional) graduate** (~30 lines, docs) — promote cases, graduate the invariant (NRQL has no
   sessionization primitive; bare transaction ≠ FACET — `maxevents=1000` + connectivity), strike
   the laundry-list row. Dependency: PR 1.
