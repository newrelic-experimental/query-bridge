---
name: corpus-progress
description: Use when measuring or reporting how much the translator has improved on the corpus — interpreting clean/warn/unsupported/error bucket deltas, comparing branch/stack tips, or answering "how much progress / was this worth it". Prevents reporting a bucket diff as if it were the value delivered.
---

# Interpreting corpus progress

The corpus diagnostic buckets every query as `clean` / `warningsOnly` / `unsupported` / `errors`. **The bucket diff is a misleading proxy for the value of translator work** — it understates and often *penalizes* correctness. Never report a raw bucket delta as "progress" without this framing.

## The bucket chart hides three kinds of win

1. **silent-wrong → loud `unsupported`** — a correctness WIN, but shows as `unsupported`↑ and `clean`/`warn`↓ (looks like a regression). This project's whole thesis is loud-failure-over-silent-wrong, so `unsupported`↑ replacing wrong output is the work succeeding.
2. **wrong-but-`clean` → correct-but-`clean`** — a real fix with **zero** bucket movement. Completely invisible.
3. **ungraceful `error` → graceful `unsupported` (with a reason)** — a WIN that shows as `errors`↓ `unsupported`↑.

So "new successes" (clean↑) is the *smallest* and most misleading slice. Lead any progress report with the correctness reframe, not the clean count.

## The goal is "nothing lies," not "all clean"

100% `clean` is **impossible** — SPL is strictly more expressive than NRQL (`join`, `transaction`, `map`, windowed `eventstats` have no NRQL form). The achievable, shippable bar is: every query is correctly translated, translated-with-a-warning, or honestly told it can't be. An `unsupported` query is **done** (it shows the original SPL + a reason) — it is not a backlog item.

## Review burden is per-pattern, not per-query

- `unsupported` + `error`: ~zero per-query review. Review the *message* once per key (~100 keys), not per query.
- `clean` + `warn`: reviewed per distinct translation *shape* via `verified:'human'` test cases. The corpus is the **regression net** that proves a pattern holds across all instances — it saves review, it isn't a review queue. 32k queries collapse to a few hundred shapes (`sample-shapes.mjs` in the corpus repo counts them).

## Measuring (the harness)

`corpus-diagnostic.mjs` lives in the **private sibling repo** `../nr-query-bridge-corpus` (reads its `spl-real-world.json`, imports this repo's `packages/nr-query-bridge/src/translate.js`). Run it with the `ASDF_NODEJS_VERSION=24.14.0 node …` prefix.

- Measure a branch/stack tip by `git switch --detach <tip>` then running the diagnostic; switch back after. `NRQB_TRANSLATOR=<abs path>` overrides the translator location.
- **Importer-only stacks cannot move this corpus** (it only runs `translateSplToNrql`). Check `git diff --stat master..<tip> -- packages/nr-query-bridge/src`; 0 files → corpus unchanged, don't bother running.
- **Stack deltas don't sum** — independent stacks overlap on shared corpus queries and stacked siblings share a base. For the true "after all PRs" number, merge the translator stacks onto one integration branch and run once; per-stack deltas are estimates only.
