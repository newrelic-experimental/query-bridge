# Open-Source Scrub + Corpus Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all customer-identifiable and private data from the `nr-query-bridge` repo (working tree + git history) and relocate the real-world query corpus to a private repo, so the project can be published at `github.com/newrelic/nr-query-bridge`.

**Architecture:** Two gated phases. Phase A relocates the corpus to a new private repo, deletes it here, swaps in a synthetic stub, redacts customer specifics, and updates infra refs — all as normal reviewable commits. Phase B rewrites git history on a throwaway mirror clone (never the live repo) and force-pushes only after explicit human go-ahead.

**Tech Stack:** Node 24 (vitest, ESLint, Prettier, TypeScript checkJs), `git-filter-repo` (installed at `/opt/homebrew/bin/git-filter-repo`), GitHub Enterprise (`source.<GHE_DOMAIN>`).

---

## CRITICAL — Read before starting

- **The single source of truth for every real→placeholder mapping is `docs/local/scrub-mappings.yml`** (gitignored). This plan, like the spec, uses ONLY neutral placeholders (`<ACCOUNT_ID>`, `<CUSTOMER_A>`, `<PLATFORM_A>`, etc.). Look up the real values from that file at execution time. **Never write a real customer identifier into this plan, the spec, a commit message, a PR body, or any tracked file.**
- **`<CUSTOMER_A>` is NAMED in the corpus** via a short company-initial prefix (`<prefix>-*-prod` cluster names + a `<prefix>*` field family). The real prefix is in the mapping file. When sweeping for it, use anchored patterns `\b<prefix>[-_][a-z0-9]` — a bare prefix substring collides with the NRQL keyword `WHERE` and public Splunk `whoami` content.
- **Commit rules (project):** lowercase conventional-commit subject, ≤72 chars. Commit with `ASDF_NODEJS_VERSION=24.14.0 git commit` (hooks need Node 24). Ask the human before each commit if unsure.
- **Phase B is irreversible and force-pushes a shared remote (11 branches).** Do NOT run any history-rewrite or force-push step without explicit human go-ahead at the Phase B gate.

---

## Phase 0 — Relocate corpus to private repo (BEFORE any deletion)

> **Source archives (provided):**
> - `~/Downloads/REDACTED.tgz` (34MB) — full Splunk SRE app repo export for **Customer A** (apps prefixed with the `<CUSTOMER_A>` company-initial prefix). Contains 119 `.conf` files, 836 embedded `.git` objects, and an apikeys app — i.e. infra-as-code that MAY hold live credentials. Per owner decision: stored raw in the private repo; NOT scanned; NOT used as the query source.
> - `~/Downloads/REDACTED.saved.zip` (15MB) — Splunk knowledge-object export for **Customer B** (`saved_searches.json` 155MB + `dashboards.json` 54MB uncompressed). Carries Splunk Cloud hostnames + servicesNS metadata (`<SPLUNK_HOST_B>`, app/user paths). **This is the query source.**
> - `~/Downloads/function_usage_counts.csv` — usage statistics only (function → occurrence counts), NOT queries. Stored as a coverage reference; feeds deferred Phase 2.
>
> **AI-DEV:** Both archives name real customers (mapping file has the details). The query JSON the generator emits must contain ONLY SPL `search` strings with all hostname/app/user metadata stripped — see Task 0.2.

### Task 0.1: Create the private corpus repo

**Files:** none in this repo.

- [ ] **Step 1: Create the private GHE repo.**

Run:
```bash
GH_HOST=source.<GHE_DOMAIN> gh repo create logging/nr-query-bridge-corpus --private \
  --description "Real-world SPL corpus + generator for nr-query-bridge (private; contains customer data)"
```
Expected: repo URL printed. If it already exists, skip.

- [ ] **Step 3: Clone it locally, outside this repo's tree.**

Run:
```bash
git clone git@source.<GHE_DOMAIN>:logging/nr-query-bridge-corpus.git ../nr-query-bridge-corpus
```
Expected: empty repo cloned to a sibling directory.

### Task 0.2: Store raw archives + write the query generator

**Files:**
- Create: `../nr-query-bridge-corpus/sources/` (raw archives, verbatim)
- Create: `../nr-query-bridge-corpus/generate-corpus.mjs`
- Create: `../nr-query-bridge-corpus/spl-real-world.json` (generator output)
- Create: `../nr-query-bridge-corpus/README.md`
- Create: `../nr-query-bridge-corpus/.gitattributes` (Git LFS for large files)

- [ ] **Step 1: Enable Git LFS for the large archives + JSON.** `saved_searches.json` is ~155MB uncompressed; the tgz is 34MB. Track binaries/large blobs via LFS so the repo stays usable.

```bash
cd ../nr-query-bridge-corpus
git lfs install
printf '%s\n' 'sources/** filter=lfs diff=lfs merge=lfs -text' '*.tgz filter=lfs diff=lfs merge=lfs -text' '*.zip filter=lfs diff=lfs merge=lfs -text' > .gitattributes
mkdir -p sources
cd -
```

- [ ] **Step 2: Copy the raw archives verbatim into `sources/`** (owner-approved: configs/keys/.git included, stored only in this private repo).

```bash
cp ~/Downloads/REDACTED.tgz ~/Downloads/REDACTED.saved.zip ~/Downloads/function_usage_counts.csv ../nr-query-bridge-corpus/sources/
```

- [ ] **Step 3: Write `generate-corpus.mjs`.** It must:
  1. Read `sources/REDACTED.saved.zip` → parse `saved_searches.json` and `dashboards.json` (each is `{ entry: [ { name, content: { search, ... }, ... } ] }`; dashboards embed SPL in panel `<query>`/`search` elements).
  2. Extract ONLY the SPL string from each entry — the `content.search` field for saved searches, the panel query text for dashboards. **Discard all metadata** (`id`, `links`, `origin`, `updated`, `acl`, hostnames, servicesNS user/app paths). This is the metadata-stripping requirement: a query body may look generic while its surrounding `id`/`origin` carry `<SPLUNK_HOST_B>`.
  3. Emit `spl-real-world.json` as a deduplicated, sorted array of `{ "spl": "<query>" }` — the shape both consumers expect (verified: `realWorldEntries.forEach((entry) => entry.spl)` in `spl.test.js`; `.map((q) => q.spl)` in `spl-fuzz.test.js`). Verbatim queries, no anonymization (this is the private repo).
  4. (The Customer A tgz is NOT a query source — it's archival only. Skip it in the generator.)

- [ ] **Step 4: Run the generator.**

```bash
cd ../nr-query-bridge-corpus && node generate-corpus.mjs && cd -
```
Expected: `spl-real-world.json` written; print the query count.

- [ ] **Step 5: Confirm NO hostname/metadata leaked into the query JSON.** The output must contain SPL only. Sweep for the Customer B hostname/app patterns (look them up in `docs/local/scrub-mappings.yml` → `customer_b`) plus generic metadata markers:

```bash
grep -ciE "<SPLUNK_HOST_B-real>|servicesNS|<CUSTOMER_B-real>|\borigin\b|https://" ../nr-query-bridge-corpus/spl-real-world.json
```
Expected: `0`. If non-zero, the extractor is pulling metadata, not just the `search` field — fix Step 3 before continuing.

- [ ] **Step 6: Write `README.md`** documenting: what this repo is (private archival source + query generator), why it's separate (contains data for two named customers + possible live credentials — cannot be public), how to regenerate (`node generate-corpus.mjs`), the LFS setup, and a pointer to the public repo.

- [ ] **Step 7: Commit + push the corpus repo.**

```bash
cd ../nr-query-bridge-corpus
git add .gitattributes sources/ generate-corpus.mjs spl-real-world.json README.md
git commit -m "feat: add source archives, generator, and regenerated corpus"
git push origin HEAD
cd -
```
Expected: pushed to the private repo. **The source of truth is now safely relocated — deletion in Phase A is recoverable from here.**

---

## Phase A — Tree scrub (normal reviewable commits)

### Task A.1: Replace the corpus with a synthetic stub

**Files:**
- Modify (overwrite contents): `test/spl/spl-real-world.json`
- Test: `test/spl/spl.test.js`, `test/spl/spl-fuzz.test.js` (run only — no code change needed)

Rationale: both consumers read the file by its literal name and iterate dynamically (`realWorldEntries.forEach`, `realWorldCorpus.length`). Swapping the file *contents* for a small synthetic array keeps the real-world test code path alive with zero consumer changes.

- [ ] **Step 1: Overwrite `test/spl/spl-real-world.json` with a synthetic stub.** Use only invented indexes/fields — no customer vocabulary. Cover a spread of SPL commands so the fuzz invariants exercise real branches:

```json
[
  { "spl": "index=web status=500 | stats count by host" },
  { "spl": "index=app sourcetype=access_combined | timechart span=1m count" },
  { "spl": "index=main | eval latency=round(duration/1000) | stats avg(latency) by service" },
  { "spl": "index=infra | dedup userId | stats count by region" },
  { "spl": "index=api error=* | top limit=10 endpoint" },
  { "spl": "index=logs | rex field=_raw \"user=(?<user>\\w+)\" | stats count by user" },
  { "spl": "index=metrics | where value > 100 | sort -value | head 20" },
  { "spl": "index=events action=login | timechart span=1h count by action" }
]
```

- [ ] **Step 2: Run the real-world + fuzz suites to confirm the stub works.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: PASS. The `spl-real-world translations` block now reports 8 queries; fuzz `real-world corpus invariants` run against the stub without crashing.

- [ ] **Step 3: Commit.**

```bash
git add test/spl/spl-real-world.json
ASDF_NODEJS_VERSION=24.14.0 git commit -m "test: replace real-world corpus with synthetic stub"
```

### Task A.2: Redact the account ID (Tier 1)

**Files:**
- Modify: `docs/superpowers/plans/2026-03-27-nrql-feature-gaps.md`, `docs/superpowers/specs/2026-03-27-nrql-feature-gaps-design.md` (these are dropped entirely in Task A.4 — but A.4 is git rm, so account-ID redaction here is moot for THOSE two files; the real concern is any OTHER surviving file).

> Look up `<ACCOUNT_ID>` real value in `docs/local/scrub-mappings.yml` (`account_id` section).

- [ ] **Step 1: Find every surviving occurrence of the account ID.**

Run: `git grep -n "<ACCOUNT_ID-real-value>" -- . ':(exclude)package-lock.json'`
Expected: hits only in the two superpowers docs slated for deletion in A.4. If it appears in ANY other tracked file, redact it there → `<ACCOUNT_ID>`.

- [ ] **Step 2: If found outside the to-be-deleted docs, redact and commit.** Otherwise skip — deletion in A.4 handles it.

```bash
# only if Step 1 found it elsewhere
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: redact customer account id"
```

### Task A.3: Genericize Customer B specifics in code/tests/docs (Tier 3)

**Files (Customer B identifiers leak into all four — line numbers as of writing):**
- Modify: `src/messages.js` — `// SPL:` comments at lines 72, 76 (FAMILY_1) and line 127 (FAMILY_2). Message bodies are clean.
- Modify: `test/spl/spl.test.js` — ~2989–3141 (FAMILY_1) and line 3062 (FAMILY_2).
- Modify: `docs/SPL_TO_NRQL.md` — lines 1562, 1567 (FAMILY_2 in a doc example).

> **All real→placeholder pairs are in `docs/local/scrub-mappings.yml` → `customer_b_code_leak`. Read them from there; this plan names none.** Two families:
> - **FAMILY_1** — the user/event field + two route names + the "<N> users/hr" comment phrase (→ `userId`, `AddItem`/`Submit`, `<N> users/hr`).
> - **FAMILY_2** — the SKU/channel field family (→ `itemId`/`items`/`itemSku`/`channel`/`brand`).
>
> **AI-DEV:** FAMILY_2 was found by a targeted Customer B sweep AFTER the FAMILY_1 pass — do not assume FAMILY_1 is the only Customer B leak. When string-replacing FAMILY_2, do the longest variants first (the `...Id`/`...s` forms before the bare stem) so substrings aren't half-replaced.

- [ ] **Step 1: Run the suite first (baseline green).**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: PASS. Record that it's green before edits.

- [ ] **Step 2: Edit `src/messages.js`.** In the `// SPL:` comments at lines 72, 76, replace the FAMILY_1 field with `userId`; at line 127, replace the FAMILY_2 field with its `items` placeholder. Comment-only — message *bodies* stay byte-for-byte unchanged (no behavior change).

- [ ] **Step 3: Edit `test/spl/spl.test.js`.** In ~2989–3141 apply FAMILY_1 placeholders and strip the "<N> users/hr" + derived-metric customer comments; at line 3062 apply the FAMILY_2 placeholder in the `spl:` input. Update each `spl:` input AND its expected `nrql:` output together. The `LIMIT MAX 5K` warning assertions stay — only example values change.

- [ ] **Step 3b: Edit `docs/SPL_TO_NRQL.md` lines 1562, 1567.** Apply the FAMILY_2 placeholder in both the SPL example and the NRQL example so they stay consistent.

- [ ] **Step 4: Run the suite — confirm still green.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test`
Expected: PASS. If a test fails, an expected `nrql:` string still references an old name — fix the expectation to match the genericized input (do NOT change translator behavior).

- [ ] **Step 5: Confirm ALL Customer B identifiers are gone from surviving files.** Build the pattern from the `customer_b_code_leak` real values in the mapping file:

Run: `git grep -niF -f <(awk '/real:/{gsub(/.*real: *"|".*/,""); print}' docs/local/scrub-mappings.yml) -- src/messages.js test/spl/spl.test.js docs/SPL_TO_NRQL.md`
Expected: empty.

- [ ] **Step 6: Commit.**

```bash
git add src/messages.js test/spl/spl.test.js docs/SPL_TO_NRQL.md
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: genericize customer-specific field and route names"
```

### Task A.4: Drop the two customer-narrative superpowers docs (Tier 2)

**Files:**
- Delete: `docs/superpowers/plans/2026-03-27-nrql-feature-gaps.md`
- Delete: `docs/superpowers/specs/2026-03-27-nrql-feature-gaps-design.md`
- **Keep:** `docs/superpowers/specs/2026-03-30-skipped-tests-design.md`, this plan, and the scrub spec.

- [ ] **Step 1: Delete the two docs.**

```bash
git rm docs/superpowers/plans/2026-03-27-nrql-feature-gaps.md \
       docs/superpowers/specs/2026-03-27-nrql-feature-gaps-design.md
```

- [ ] **Step 2: Confirm the kept docs are untouched.**

Run: `ls docs/superpowers/specs/2026-03-30-skipped-tests-design.md docs/superpowers/specs/2026-06-02-open-source-scrub-design.md`
Expected: both exist.

- [ ] **Step 3: Commit.**

```bash
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: drop customer-specific planning docs"
```

### Task A.5: Update infra references for OSS (Tier 4)

**Files:**
- Modify: `package.json` (repository URL ~line 23, team email ~line 27)
- Modify: `.github/dependabot.yml` (registry ~line 6)

> Team-email decision is an open item — confirm with the human (keep / public alias / remove) before editing line 27.

- [ ] **Step 1: Read the current values.**

Run: `git grep -nE "datanerd\.us|newrelic\.com|artifacts\." -- package.json .github/dependabot.yml`
Expected: shows the `source.<GHE_DOMAIN>` repo URL, team email, and `artifacts.<GHE_DOMAIN>` registry.

- [ ] **Step 2: Edit `package.json`.** Set `repository.url` → `git+https://github.com/newrelic/nr-query-bridge.git`; set `bugs.url` → `https://github.com/newrelic/nr-query-bridge/issues`; handle the team email per the human's decision.

- [ ] **Step 3: Edit `.github/dependabot.yml`.** Replace the `artifacts.<GHE_DOMAIN>` artifactory registry with the public npm registry (or remove the custom registry block so dependabot uses the default).

- [ ] **Step 4: Confirm internal refs are gone.**

Run: `git grep -nE "datanerd\.us|artifacts\.datanerd" -- package.json .github/dependabot.yml`
Expected: empty.

- [ ] **Step 5: Commit.**

```bash
git add package.json .github/dependabot.yml
ASDF_NODEJS_VERSION=24.14.0 git commit -m "chore: update repo metadata for open-source release"
```

### Task A.6: Phase A verification gate

**Files:** none (verification only).

- [ ] **Step 1: Full suite + lint + types.**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run test && ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check`
Expected: all PASS.

- [ ] **Step 2: Sweep the working tree for every real identifier.** For each `real:` value in `docs/local/scrub-mappings.yml`:

Run: `git grep -niF "<each-real-value>" -- . ':(exclude)package-lock.json' ':(exclude)docs/local/'`
Expected: empty (or only genericized forms). Use the anchored `\b<prefix>[-_][a-z0-9]` pattern for the `<CUSTOMER_A>` prefix — never a bare prefix substring.

- [ ] **Step 3: Customer-name + Splunk-host sweep (tree).** Both customers are named; the KO export carries Splunk Cloud hostnames. Look up the real Customer B name + host in `docs/local/scrub-mappings.yml` (`customer_b`) and sweep for them plus the generic `servicesNS` marker:

```bash
git grep -niE "<CUSTOMER_B-real>|<SPLUNK_HOST_B-real>|servicesNS" -- . ':(exclude)package-lock.json' ':(exclude)docs/local/'
```
Expected: empty. (Customer A's prefix is covered by Step 2's anchored pattern.)

- [ ] **Step 4: Broad regex sweep (tree).**

Run:
```bash
git grep -niE "[a-z0-9._%+-]+@(newrelic|datanerd)" -- . ':(exclude)package-lock.json'
git grep -nE "NRAK-[A-Za-z0-9]|AKIA[0-9A-Z]{8}" -- . ':(exclude)package-lock.json' ':(exclude).claude/nr-ai-standards/*'
```
Expected: no real secrets; only the intended/none.

- [ ] **Step 5: STOP — Phase A done.** The tree is clean and reviewable as a PR. Get human confirmation before starting Phase B (history rewrite).

---

## Phase B — History rewrite (GATED; mirror clone; explicit go-ahead before force-push)

> **DANGER:** Every step here is irreversible and the final push force-updates a shared remote with 11 branches. Do NOT begin without explicit human go-ahead. Work on a throwaway mirror — never the live repo — so the original remains intact until the force-push.

### Task B.1: Mirror-clone the repo

**Files:** none in this repo (operates on a sibling mirror).

- [ ] **Step 1: Confirm Phase A is merged to the branch you intend to publish from**, so the rewrite operates on the scrubbed tree.

- [ ] **Step 2: Fresh mirror clone.**

```bash
git clone --mirror git@source.<GHE_DOMAIN>:logging/nr-query-bridge.git ../nr-query-bridge-scrub.git
```
Expected: a bare mirror at `../nr-query-bridge-scrub.git` with all refs/branches.

### Task B.2: Generate replacements.txt from the mapping file

**Files:**
- Create (transient, NOT committed anywhere): `../replacements.txt`

- [ ] **Step 1: Build `replacements.txt`** with one `real==>placeholder` line per entry in `docs/local/scrub-mappings.yml`. Cover Tier 1 (account id), Tier 3 (field + route names + "<N> users/hr"), the `<CUSTOMER_A>` name + cluster names + the `<prefix>*` field family, vendors, Tier 5 lookups/apps/fields, and the team email. Use `regex:` lines for families (e.g. the prefix). Example shape (substitute real values from the mapping file):

```
<account-id>==><ACCOUNT_ID>
<real-field>==>userId
literal:<N> users/hr==><N> users/hr
<real-customer-name>==><CUSTOMER_A>
regex:\b<prefix>-[a-z-]+-prod==><CLUSTER>
```

- [ ] **Step 2: Keep this file outside any repo** (e.g. the parent dir). It contains real values — it must never be committed.

### Task B.3: Drop paths from history

**Files:** operates on `../nr-query-bridge-scrub.git`.

- [ ] **Step 1: Drop the corpus from ALL history.**

```bash
cd ../nr-query-bridge-scrub.git
git filter-repo --invert-paths --path test/spl/spl-real-world.json --force
```
Expected: filter-repo rewrites all commits; the corpus file no longer exists in any historical version. (The synthetic stub from Task A.1 has the same path — confirm in B.5 that the stub survives on the published branch while the large historical versions are gone. If filter-repo removes the stub too, re-add it as a post-rewrite commit.)

- [ ] **Step 2: Drop the two customer docs from history.**

```bash
git filter-repo --invert-paths \
  --path docs/superpowers/plans/2026-03-27-nrql-feature-gaps.md \
  --path docs/superpowers/specs/2026-03-27-nrql-feature-gaps-design.md --force
```
Expected: both paths gone from all history. The kept docs (skipped-tests, scrub spec, this plan) remain.

### Task B.4: Replace residual strings in surviving files' history

- [ ] **Step 1: Apply replacements.**

```bash
git filter-repo --replace-text ../replacements.txt --force
```
Expected: every historical version of surviving files has real identifiers swapped for placeholders.

### Task B.5: Verify the rewritten mirror

**Files:** operates on `../nr-query-bridge-scrub.git`.

- [ ] **Step 1: Corpus absent from all history.**

```bash
git -C ../nr-query-bridge-scrub.git log --all -- test/spl/spl-real-world.json
```
Expected: empty (or only the small synthetic-stub commit on the published branch — verify the content is the stub, not the real corpus, via `git -C ../nr-query-bridge-scrub.git show <ref>:test/spl/spl-real-world.json | head`).

- [ ] **Step 2: Every real identifier gone from history.** For each `real:` value in `docs/local/scrub-mappings.yml`:

```bash
git -C ../nr-query-bridge-scrub.git log --all -S"<each-real-value>" --oneline
```
Expected: empty. Use anchored patterns for the `<CUSTOMER_A>` prefix.

- [ ] **Step 3: Broad secret/infra sweep across all history.**

```bash
git -C ../nr-query-bridge-scrub.git log --all -S'NRAK-' --oneline
git -C ../nr-query-bridge-scrub.git log --all -S'<GHE_DOMAIN>' --oneline
```
Expected: only known-benign hits (e.g. nr-ai-standards docs explaining the `NRAK-` prefix). Investigate anything unexpected.

- [ ] **Step 4: If ANY check is non-empty, fix and re-run from a fresh mirror.** Add the missed string to `replacements.txt` (or the path to an `--invert-paths`), re-clone the mirror, and re-run B.3–B.5. Do not patch the existing rewritten mirror in place.

### Task B.6: Force-push (FINAL GATE)

- [ ] **Step 1: STOP. Get explicit human go-ahead.** Confirm: (a) all B.5 checks are empty, (b) anyone holding a clone of the 11 branches has been warned, (c) the human authorizes the force-push.

- [ ] **Step 2: Re-add origin (filter-repo strips it by design).**

```bash
cd ../nr-query-bridge-scrub.git
git remote add origin git@source.<GHE_DOMAIN>:logging/nr-query-bridge.git
```

- [ ] **Step 3: Force-push all refs (only after Step 1 authorization).**

```bash
git push --force --mirror origin
```
Expected: all branches/tags updated on the remote with rewritten history.

- [ ] **Step 4: Post-push verification.** Re-clone fresh from origin and re-run the B.5 sweeps against the new clone to confirm the remote reflects the scrubbed history.

---

## Deferred — separate plans (NOT this effort)

These run later, in separate sessions:
- **Phase 2 — Corpus coverage study.** Study each real query in the private corpus repo for translation patterns not covered by `spl.test.js`; add synthetic test cases.
- **Phase 3 — OSS scaffolding.** LICENSE, CONTRIBUTING.md, issue/PR templates, public README, per NR OSPO expectations.

## Open items (resolve before the relevant task)

- **Source archives** — RESOLVED: `~/Downloads/REDACTED.tgz` (Customer A, archival only), `~/Downloads/REDACTED.saved.zip` (Customer B, query source), `~/Downloads/function_usage_counts.csv` (usage stats / coverage ref).
- **`package.json` team email** — keep / public alias / remove. (Blocks Task A.5 Step 2.)
- **Force-push coordination** — warn holders of the 11 branches. (Blocks Task B.6.)
- **(Advisory, owner-acknowledged)** the tgz may contain live customer credentials (an apikeys app + 119 `.conf` files). Stored in the private repo per owner decision; consider rotating any keys that are still live — independent of this effort.
