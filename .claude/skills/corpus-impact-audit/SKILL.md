---
name: corpus-impact-audit
description: Use when you've changed the SPL→NRQL translator (grammar, handlers, IR, emitter) and need to see what it did to the real-world corpus — not just the bucket totals the diagnostic prints, but exactly WHICH queries changed verdict (errors→unsupported, errors→clean, or regressions like clean→anything).
---

# Corpus Impact Audit

The corpus diagnostic (`corpus-diagnostic.mjs` in the sibling private repo
`../nr-query-bridge-corpus`) prints bucket COUNTS only — `clean / warningsOnly /
unsupported / errors / thrown`. It does NOT tell you which individual queries
moved, or in which direction. After any translator change you usually want the
delta, especially to catch regressions (a `clean` query going `unsupported`/`errors`).

## The corpus

- `../nr-query-bridge-corpus/spl-real-world.json` IS the full corpus (~32k real
  customer queries). The `test/spl/spl-real-world.json` in THIS repo is a tiny
  synthetic stub, not the real thing.
- Each row is `{ spl, nrql, warnings, unsupported, errors }`.
- `translateSplToNrql(spl)` returns `{ nrql, warnings, unsupported, errors }`.
- Bucket priority (same as the diagnostic): `errors.length` → `errors`; else
  `unsupported.length` → `unsupported`; else `warnings.length` → `warningsOnly`;
  else `clean`. A thrown exception is its own `thrown` bucket.

## Bucket totals (fast, no script)

```bash
cd ../nr-query-bridge-corpus && ASDF_NODEJS_VERSION=24.14.0 node corpus-diagnostic.mjs
```
`thrown` must stay 0 (the non-negotiable invariant). The diagnostic imports the
translator live from `../nr-query-bridge/src/translate.js`, so it always reflects
the current working tree.

## Per-query delta (which queries changed, and how)

To diff BEFORE vs AFTER a change you need both translator versions at once. Use a
git worktree at the base commit, then run both translators over every corpus row:

```bash
# 1. worktree the pre-change baseline (e.g. the commit before your branch's work)
git worktree add -q /tmp/prefeat-nqb <base-commit>

# 2. write a compare script (read-only; runs node, so run it explicitly)
cat > /tmp/corpus-delta.mjs <<'EOF'
import { readFileSync } from 'node:fs';
const { translateSplToNrql: pre } = await import('/tmp/prefeat-nqb/src/translate.js');
const { translateSplToNrql: post } = await import('/ABS/PATH/nr-query-bridge/src/translate.js');
const corpus = JSON.parse(readFileSync('/ABS/PATH/nr-query-bridge-corpus/spl-real-world.json','utf8'));
const bucket = (r) => (r.errors?.length ? 'errors' : r.unsupported?.length ? 'unsupported' : r.warnings?.length ? 'warningsOnly' : 'clean');
for (const row of corpus) {
  let a,b; try { a=bucket(pre(row.spl)); } catch { a='thrown'; }
  try { b=bucket(post(row.spl)); } catch { b='thrown'; }
  if (a !== b) console.log(`${a} -> ${b}\t${row.spl.replace(/\s+/g,' ').slice(0,200)}`);
}
EOF
ASDF_NODEJS_VERSION=24.14.0 node /tmp/corpus-delta.mjs > /tmp/delta.txt

# 3. clean up
git worktree remove /tmp/prefeat-nqb --force && git worktree prune
```

Then `grep '-> errors'` / `grep 'clean ->'` etc. to inspect transitions. To see a
single query's FULL message set (the diagnostic and a first-message tally both
hide that a deep query hits many blockers), translate it directly:
`ASDF_NODEJS_VERSION=24.14.0 node bin/spl2nrql.js "<spl>"`.

## Gotchas (learned the hard way)

- **Count every message, not the first.** A real corpus query is a deep multi-pipe
  dashboard hitting MANY unsupported constructs. Tallying only `unsupported[0]`
  badly undercounts which features fire (e.g. a per-first-message tally said a
  guard fired in 1 query; counting all messages, it was 12). When attributing a
  flip to YOUR change, check the full `unsupported`/`warnings` arrays.
- **A flip TO unsupported is usually GOOD.** If a query was `errors` (parse failure)
  before and `unsupported` after, your change let it parse further and it failed
  loud at its real downstream blocker — better diagnostics, not a regression.
  The transitions to actually worry about: `clean -> anything` and `* -> errors`.
- **`thrown` must stay 0.** Any `-> thrown` is a hard regression.
- **Corpus junk exists.** Some rows contain literal markdown triple-backticks or
  other malformations; a parse change can surface those as new `errors`. Judge by
  whether real NRQL would be wrong (it won't be — both states are loud), not by
  the raw count.
