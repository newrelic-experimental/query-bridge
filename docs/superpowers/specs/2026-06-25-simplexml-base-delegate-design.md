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

Replace the transforming-base and `eval` placeholder branches in `resolveBaseSearch` with unconditional
composition, mirroring the Studio chain walk:

- **Compose unconditionally.** Resolve the base chain to its root (walking a chained `<search id base=>`
  to its parent, as Studio walks `extend`), then set `rawSpl = root | mid | … | post-process`. Hand it to
  the translator; its `wrapAsSubquery` either produces nested-subquery NRQL or returns `unsupported`
  (→ existing chokepoint placeholder).
- **Keep loud placeholders only for the unresolvable:** a missing base id, a `ref=` saved-search root (no
  inline SPL), or a cycle. These have no SPL to compose, exactly as Studio's savedSearch/csv roots.
- **Drop the `TRANSFORMING_COMMAND` gate entirely** from `resolveBaseSearch`. Composition correctness is
  now the translator's responsibility, where the subquery machinery and its `unsupported` guards live.

`baseRef` is still recorded either way (unchanged).

## Consequences, risk, and tradeoffs

- **Shipped Phase-2 behavior changes.** Panels that were placeholders may become real widgets (the win) or
  translator-`unsupported` placeholders (still loud). The existing transforming-base canary flips from
  "expect placeholder" to the new behavior — a deliberate, human-approved change, not a regression.
- **Risk: a chain the translator wraps *wrong* now emits wrong NRQL** where before it was a safe
  placeholder. This is the same risk the translator carries for every `stats | …` query; it rests on the
  translator's own `unsupported` guards (the compound-rewrap guard, the eval-after-agg non-scalar/collision
  guards). The mitigation is the translator's guards, not a parser-side block.
- **Sequencing.** Best landed after — or alongside — `compound-chain-collapse` (`fix/subquery-wrapping`),
  which widens the set of chains the translator wraps correctly. Landing this first is safe but converts
  fewer placeholders; landing it after maximizes the win. Either order is correct; neither is wrong.
- **Reversible.** A code-path change, not a data migration.

## Alternatives considered

- **Leave Simple XML as-is, accept divergence** (rejected): the two formats drift further as the translator
  improves; every translator gain helps Studio and not Simple XML.
- **Move composition into the translator** (rejected): base/chain resolution is a dashboard concept; the
  translator is dashboard-agnostic (zero importer knowledge). The parser composes; the translator translates.

## Scope

- **In:** rewrite `resolveBaseSearch` to compose-and-delegate; walk chained bases to root; keep loud
  placeholders for missing-id / `ref=` / cycle; update the affected canaries.
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

- [ ] Dropping the `TRANSFORMING_COMMAND` gate — agree the translator's guards are the right safety net?
- [ ] Chained-base walk-to-root for Simple XML (matching Studio) — in scope here, or split out?
- [ ] Sequencing vs. `compound-chain-collapse` — land this after the rework, or independently now?
- [ ] The flipped canary — confirm the new expected behavior is what we want, not just what the code does.
