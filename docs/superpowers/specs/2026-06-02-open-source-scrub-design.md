# Open-Source Prep: Scrub Customer Data + Relocate Corpus

**Date:** 2026-06-02
**Status:** Design — approved for spec, pending user review

## Context

`nr-query-bridge` (SPL→NRQL query translator) is being open-sourced at
`github.com/newrelic/nr-query-bridge` (verified: correct NR public OSS org; repo name currently 404 /
available). Before publishing, every trace of customer-identifiable and private information must be removed
from both the working tree **and** git history, and the real-world query corpus must be relocated to a new
private repo.

A maximum-effort sweep (tree + all-branch history) established the actual exposure. It is more significant
than Chuck initially expected, and the corpus finding reshaped the approach.

### Findings by tier

| Tier | What | Where | Treatment |
|---|---|---|---|
| 1 | Customer account ID (`<ACCOUNT_ID>`) | 2 superpowers docs; commit `226a412` | Redact → `<ACCOUNT_ID>` |
| 2 | Customer engagement narrative (`<N> users/hr` business specific, sampling %, migration story for Customer B) | `docs/superpowers/plans/2026-03-27-nrql-feature-gaps.md`, `.../specs/2026-03-27-nrql-feature-gaps-design.md`; commit `226a412` | Drop both docs |
| 3 | Customer B specifics in shipping code/tests (customer field name → `userId`, two route names → generic events, `<N> users/hr` comment, derived-metric formula) | `src/messages.js`, `test/spl/spl.test.js`; commit `1bc53f2` | Genericize fully |
| 4 | Internal infra references (not secrets) | `package.json` (repo URL + team email), `.github/dependabot.yml` (artifactory URL) | Update for OSS |
| 5 | **Full real-world corpus** — 1,881 queries saturated with TWO identifiable customers (Customer A: `<PLATFORM_A>`–`<PLATFORM_C>`, `<INDEX_1>`–`<INDEX_3>`, 100+ index/service names, incl. named third-party vendors `<VENDOR_A>`–`<VENDOR_D>`; Customer B: `<INDEX_4>`–`<INDEX_6>`, `<LOOKUP_HOSTS>`, `<LOOKUP_SKU>`, `<APP_1>`, `<FIELD_1>`) | `test/spl/spl-real-world.json`; commits `6d138f7`, `4eb7d37`, `45aae88` | **Relocate to private repo, regenerate from source zips, delete from this repo + purge from history** |

> **Real identifier ↔ placeholder mappings live in `docs/local/scrub-mappings.yml` (gitignored).** That file
> is the single source of truth for both the placeholders above and the Phase B `replacements.txt`. The full
> unredacted spec lives in the private repo `logging/nr-query-bridge-corpus`. This repo only ever sees placeholders.

### Confirmed clean (no action)
- **No secrets** anywhere in history: no API keys, AWS keys (`AKIA`), `NRAK-`/`NRAA-` tokens, bearer tokens,
  passwords, or license keys. (`NRAK-` appears only in nr-ai-standards docs explaining the key-prefix standard.)
- **No public IPs** (only placeholder/private ranges) and **no real emails** beyond the team list
  (`<PUBLIC_CONTACT>`, Tier 4).
- **No zip files ever committed** on any branch — the corpus source zips are not a history-rewrite target.
- The Customer A / Customer B identifiers are **confined to `spl-real-world.json`** (commit `45aae88`) — they
  did NOT leak into `spl.test.js`, `SPL_TO_NRQL.md`, `v2-show.test.js`, or `messages.js`.
- `docs/local/dashboard-backup-*.json` (real internal data) is correctly gitignored — never tracked.

### Customer identity — Customer A is NAMED in the corpus
A short company-initial prefix throughout the corpus identifies Customer A by name: the `<prefix>-*-prod`
cluster names enumerate its entire production estate, and a matching `<prefix>*` field-name family tags
hundreds of events. This is the strongest single identifier present, and it reinforces the delete-and-purge
decision — dozens of these tokens cannot be safely string-replaced, especially since the prefix collides with
the NRQL keyword `WHERE` and public Splunk `whoami` content. The actual prefix, company name, sector, and full
token list are recorded only in `docs/local/scrub-mappings.yml` (gitignored) and the private corpus repo.

### Why the approach changed
The corpus has 108 distinct index values, 41 sourcetypes, and 36 kube-container names tied to real
customers. Per-string replacement (the original idea) cannot responsibly cover that volume and would
produce semantically-broken queries. The corpus is therefore treated as a unit: relocated and deleted, not
anonymized in place.

## Decisions (confirmed with user)

- **Account ID is sensitive here.** A bare account number is a weak identifier, but bound to an identifiable
  customer narrative it becomes customer-confidential. No single STAN page states "account IDs are
  Confidential" verbatim — documented judgment call, not a cited rule.
- **History tool:** `git-filter-repo` (installed at `/opt/homebrew/bin/git-filter-repo`). Modern,
  git-recommended replacement for BFG/filter-branch. BFG not needed.
- **Corpus:** move the real corpus to a new **private GHE repo `logging/nr-query-bridge-corpus`**, verbatim
  (no anonymization). **Regenerate** it from the source zip files (the current JSON is a derived artifact);
  zips + a new repeatable generator + the regenerated corpus all live in the corpus repo. Delete the file
  from this repo and purge it from all history.
- **Public test corpus:** ship a small **synthetic stub** so the real-world test code path
  (`spl-fuzz.test.js` invariants, `spl.test.js` real-world block) keeps running.
- **Sequencing:** Phase 0 (corpus relocation) completes inside Phase A *before* deletion → Phase A tree
  scrub (reviewable PR) → Phase B history rewrite (gated, mirror clone, explicit go-ahead before force-push).
- **Public home:** `github.com/newrelic/nr-query-bridge`; dependabot registry → public npm.

## Approach

### Phase A — Corpus relocation + tree scrub (normal reviewable commits)

**A0. Relocate corpus (before any deletion).**
1. Create private GHE repo `logging/nr-query-bridge-corpus`.
2. Add the source zip files (user-provided) to that repo.
3. Write a documented, repeatable **zip→`spl-real-world.json` generator** (lives in the corpus repo; net-new
   — no existing script). Commit zips + generator + regenerated verbatim corpus there.
4. Verify the regenerated corpus matches the intended real content, then proceed.

**A1. Delete corpus from this repo.** `git rm test/spl/spl-real-world.json`.

**A2. Test harness → synthetic stub.** Add a small fully-synthetic stub corpus **committed in this repo**
(e.g. `test/spl/spl-real-world.sample.json` or inline fixture) and point the consumers at it so the suite
passes:
- `test/spl/spl.test.js` (~lines 3470–3501, `spl-real-world translations` block)
- `test/spl/spl-fuzz.test.js` (~line 17 read, ~1091–1262 invariants + mutation ranges keyed off
  `realWorldCorpus.length`)
Consumers use `.length`/`.forEach` dynamically — no hardcoded count — so a stub of any size works.

**A3. Tier 1–3 redaction.** Apply the `real → placeholder` pairs from `docs/local/scrub-mappings.yml`.
- Account ID → `<ACCOUNT_ID>` everywhere.
- Genericize the Customer B field name → `userId`, the two route names → generic events, and strip the
  `<N> users/hr` + derived-metric comments. Files: `src/messages.js` (~72–76), `test/spl/spl.test.js`
  (~2989–3141). The `LIMIT MAX 5K` warning *behavior* stays — only example values/comments change. Update
  expected NRQL strings that referenced the old field names.
- Drop the two customer-flavored superpowers docs (Tier 2). **Keep** `2026-03-30-skipped-tests-design.md` and
  this spec (`2026-06-02-open-source-scrub-design.md`).

**A4. Tier 4 infra.** `package.json` repo URL → `github.com/newrelic/nr-query-bridge`; team email per the
open item below (keep / swap for public alias / remove). `.github/dependabot.yml` → public npm registry.

**A5. Verify (see Verification), commit as logically-separate commits.**

### Phase B — History rewrite (gated; mirror clone; explicit go-ahead before force-push)

Run on a fresh `git clone --mirror`, never the live repo.
1. Drop the corpus from all history: `git filter-repo --invert-paths --path test/spl/spl-real-world.json`.
2. Drop the two customer docs: `--invert-paths` their two paths (keep the clean one + this spec).
3. `--replace-text replacements.txt` for strings in *surviving* files' history. Generate `replacements.txt`
   from `docs/local/scrub-mappings.yml` (one `real==>placeholder` per line) — that file is the source of truth.
4. filter-repo strips `origin` by design — re-add it.
5. Verify the rewritten mirror across all branches (Verification). Then, with explicit user go-ahead and a
   heads-up to anyone holding clones of the 11 branches, force-push.

## Critical files

- `test/spl/spl-real-world.json` — relocate + delete + purge (Tier 5)
- `test/spl/spl.test.js`, `test/spl/spl-fuzz.test.js` — repoint to synthetic stub
- `src/messages.js`, `test/spl/spl.test.js` — Tier 3 genericization
- `docs/superpowers/plans/2026-03-27-nrql-feature-gaps.md`, `.../specs/2026-03-27-nrql-feature-gaps-design.md` — drop
- `package.json`, `.github/dependabot.yml` — Tier 4
- New (corpus repo): source zips, zip→JSON generator, regenerated corpus
- New (transient, not committed): `replacements.txt` for filter-repo

## Verification

- **Corpus gone:** `git log --all -- test/spl/spl-real-world.json` → empty; file absent from every ref.
- **Identifiers gone (tree + `git log --all -S` over history):** sweep for every `real:` value in
  `docs/local/scrub-mappings.yml` → empty (or only the genericized `placeholder:` forms). The mapping file is
  the authoritative checklist; do not hand-maintain a second list here.
- **Customer A prefix caution:** sweep with anchored patterns (`\b<prefix>[-_][a-z0-9]`) and the explicit
  field names from the mapping file — NOT a bare prefix substring (collides with NRQL `WHERE` and public
  Splunk `whoami`). The real prefix is in `docs/local/scrub-mappings.yml`.
- **Re-run broad regex sweeps** on the rewritten mirror: emails, internal domains (`<GHE_DOMAIN>`,
  `nr-ops.net`), public IPs, secret tokens (`NRAK-`, `AKIA`, bearer/license/password).
- **Tests + lint + types:** `ASDF_NODEJS_VERSION=24.14.0 npm run test && npm run lint && npm run types:check`.
- **Diff sanity:** only intended renames/redactions; 5K-cap warning behavior unchanged.

## Deferred — separate specs/plans (NOT this effort)

Both run in parallel, in separate Claude instances, after this effort lands:
- **Phase 2 — Corpus coverage study.** Study each real query (in the private corpus repo) for translation
  patterns not covered by the curated `spl.test.js` suite; add those as new synthetic test cases.
- **Phase 3 — OSS scaffolding.** LICENSE, CONTRIBUTING.md, issue/PR templates, README for public audience,
  per NR OSPO open-source-release expectations.

## Open items for the user

- Provide the source zip file paths for corpus regeneration.
- Final public contact for `package.json` (keep `<PUBLIC_CONTACT>`, swap for a public alias, or remove?).
- Phase B force-push needs a heads-up to anyone with an existing clone of the 11 branches.
