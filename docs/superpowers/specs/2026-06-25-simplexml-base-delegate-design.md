# Simple XML Base Search → Delegate Model — Design

**Date:** 2026-06-25
**Status:** Draft — pending review
**Scope:** `@newrelic/dashboard-importer` only (`parseSimpleXml.js`). No translator changes.
**Sibling:** `2026-06-25-dashboard-studio-phase-3-design.md` (Studio uses this delegate model from day one).

## Summary

Simple XML base-search resolution (`resolveBaseSearch`, shipped in Phase 2) placeholders any panel
whose base is **transforming** (`stats`/`timechart`/`chart`/`top`/`rare`/`dedup`/`eval`) — a rule from
when composing `base | post-process` was unsafe. The translator now subquery-wraps those chains
(`wrapAsSubquery`, with the `compound-chain-collapse` rework extending it further). So the parser-side
placeholder is now too conservative: it placeholders panels the translator could emit, and it diverges
from the Studio parser, which composes unconditionally and delegates. This phase converges Simple XML
onto the same delegate model.

## Problem

- **Over-conservative placeholdering.** `resolveBaseSearch` returns `unsupportedReason` for a transforming
  base. Those panels become markdown placeholders even when the translator can wrap
  `stats … | <post-process>` into a valid nested-subquery NRQL today.
- **Format divergence.** Studio (sibling spec) composes `root | mid | leaf` unconditionally and lets the
  translator decide; Simple XML placeholders in the parser. Two formats, two behaviors for the same
  conceptual operation — a maintenance and correctness asymmetry.

**Success criteria:**
1. A Simple XML panel with a transforming base composes `base | post-process` and translates; if the
   translator can't wrap it, the result is a loud placeholder (translator `unsupported`), never silent-wrong.
2. The corpus placeholder rate for base-search panels drops (measured before/after); 0 new silent drops.
3. Genuinely unresolvable bases — missing id, `ref=` saved-search root — still placeholder loudly.

## Proposed approach

Replace the blanket transforming-base placeholder in `resolveBaseSearch` with compose-and-delegate,
mirroring the Studio chain walk — but keep a narrow guard for the shapes the translator can't yet
wrap-or-fail:

- **Compose and delegate.** Resolve the base chain to its root (walking a chained `<search id base=>` to
  its parent, as Studio walks `extend`), set `rawSpl = root | mid | … | post-process`, and hand it to the
  translator; its `wrapAsSubquery` either produces nested-subquery NRQL or returns `unsupported`
  (→ existing chokepoint placeholder). Verified 2026-06-25 (CLI + live NRQL, acct 1): `stats|where` and
  `stats|stats` wrap correctly today — those stop being placeholders immediately.
- **Keep loud placeholders for the unresolvable:** a missing base id, a `ref=` saved-search root (no inline
  SPL), or a cycle — exactly as Studio's savedSearch/csv roots.
- **Narrow interim guard (remove when `fix/subquery-wrapping` lands).** Master's `handleEval` does NOT wrap
  (verified): `eval`-after-a-transforming-base is silently-wrong NRQL, and `head`-between / `timechart`→
  outer-where are wrong/non-compiling. So `resolveBaseSearch` keeps a placeholder for *only* those shapes
  until the rework lands. This is far narrower than today's blanket `TRANSFORMING_COMMAND` gate (which
  placeholders all `stats`/`timechart`/`chart`/`top`/`rare`/`dedup` bases).
- **Correct the comment.** Today's regex labels `eval` a transforming command; it is not — `eval` is a
  distributable-streaming, row-wise command (SPL semantics, verified). It belongs in the interim guard only
  as a shield for the translator's eval-after-agg bug, not because it reshapes rows.

`baseRef` is still recorded either way (unchanged).

## Consequences, risk, and tradeoffs

- **Shipped Phase-2 behavior changes.** Panels that were placeholders may become real widgets (the win) or
  translator-`unsupported` placeholders (still loud). The existing transforming-base canary flips from
  "expect placeholder" to the new behavior — a deliberate, human-approved change, not a regression.
- **Risk: silent-wrong if the gate is dropped too far, too soon.** The eval-after-agg non-scalar/collision
  guards that make eval-after-stats safe live in `fix/subquery-wrapping`, NOT master (verified
  `evalHandlers.js` in both, 2026-06-25). On master, eval-after-a-transforming-base compiles to wrong NRQL
  with no `unsupported` — so a blanket gate-drop would convert ~10% of base panels from safe placeholders
  into wrong widgets. The narrow interim guard (above) is what holds loud-failure until the rework lands;
  the mitigation is that guard plus the translator's guards-once-merged, not a bare delegate.
- **Sequencing (a correctness prerequisite for the guarded shapes, not just an optimization).** The
  `stats|where` / `stats|stats` conversion is safe to land now. Full removal of the interim guard
  (eval/head/timechart shapes) MUST wait for `fix/subquery-wrapping` (`compound-chain-collapse`) to wrap-or-
  fail those shapes. Landing the guard-removal before the rework would reintroduce silent-wrong output.
- **Reversible.** A code-path change, not a data migration.

## Alternatives considered

- **Leave Simple XML as-is, accept divergence** (rejected): the two formats drift further as the translator
  improves; every translator gain helps Studio and not Simple XML.
- **Move composition into the translator** (rejected): base/chain resolution is a dashboard concept; the
  translator is dashboard-agnostic (zero importer knowledge). The parser composes; the translator translates.

## Scope

- **In:** rewrite `resolveBaseSearch` to compose-and-delegate; walk chained bases to root; keep loud
  placeholders for missing-id / `ref=` / cycle AND the narrow interim guard (eval/head/timechart-after-
  transforming-root) until `fix/subquery-wrapping` lands; correct the `eval`-is-transforming comment;
  update the affected canaries.
- **Out:** translator changes; Studio (sibling spec); the `compound-chain-collapse` rework (own branch).

## Test plan

- **Flip the transforming-base canary** in `dashboards.integration.test.js` to the new behavior
  (compose+translate or loud placeholder), with red→green proving the change.
- **New canaries:** non-transforming base still composes (guard); transforming base composes and
  translates; chained base walks to root; missing-id / `ref=` saved-search → loud placeholder; cycle →
  loud placeholder.
- **Corpus diff:** snapshot base-panel placeholder rate before/after via the sibling `corpus-diagnostic.mjs`
  harness; confirm the rate drops and 0 new silent drops.
- **Parser units** per the explicit-test style (no fixture loops).

## Review checklist

- [ ] Narrowing (not dropping) the `TRANSFORMING_COMMAND` gate to only eval/head/timechart-after-transform
  until the rework lands — agree this is the right interim safety net vs. waiting entirely?
- [ ] Chained-base walk-to-root for Simple XML (matching Studio) — in scope here, or split out?
- [ ] Sequencing vs. `compound-chain-collapse` — land this after the rework, or independently now?
- [ ] The flipped canary — confirm the new expected behavior is what we want, not just what the code does.
