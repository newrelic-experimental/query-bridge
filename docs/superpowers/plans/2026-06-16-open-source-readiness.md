# Open-Source Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the nr-query-bridge monorepo pass the New Relic Experimental repolinter gate and carry the NR open-source scaffolding, with CI authored on GitHub Actions, so it is ready to publish to `github.com/newrelic-experimental/nr-query-bridge`.

**Architecture:** Three tiers, ordered by enforcement. **Tier A** is the hard gate — the files repolinter *errors* on. **Tier B** is the NR-template convention the OSPO release checklist expects (repolinter does not block on it). **Tier C** authors the GitHub Actions CI that replaces `grandcentral.yml` (dormant on internal GHE; live once public). Repo-settings and the actual publish are a manual runbook at the end, gated on events outside this repo.

**Tech Stack:** npm workspaces (post-monorepo), Node 24 (`ASDF_NODEJS_VERSION=24.14.0`), `repolinter` CLI (local gate), `newrelic/repolinter-action` (CI gate), `newrelic/newrelic-oss-cli` (THIRD_PARTY_NOTICES), GitHub Actions, `actionlint` (workflow lint).

**Source spec:** `docs/superpowers/specs/2026-06-16-open-source-readiness-design.md`

---

## Execution status — 2026-06-17

Tiers A–C executed on branch `oss/readiness` (PR #34). The repolinter gate is verified green locally (5/5 ERROR rules pass). Deviations from the tasks below:

- **The package rename rippled further than Task 7/8 anticipated.** Renaming the translator to `@newrelic/query-bridge` broke the root `build:parsers`/`build:types` `--workspace=` refs, the lockfile, and `CLAUDE.md`. All synced; local usage re-proven (706 tests pass — the baseline grew from 681).
- **Importer-package files deferred.** `packages/nr-dashboard-importer/` is empty on `master`/`oss/readiness` — its source lives in the `feature/dashboard-importer-phase-1` worktree. So Task 7's importer LICENSE/README/`package.json`, Task 8's importer `THIRD_PARTY_NOTICES`, and the importer dependabot npm entry are NOT done here; they land with the importer.
- **CONTRIBUTING CoC links repointed** to the centralized `newrelic/.github` CoC — the template assumed a local `./CODE_OF_CONDUCT.md`, which the experimental ruleset forbids.

Still outstanding:

- **Cross-branch:** the importer branch imports `@datanerd/nr-query-bridge` and must switch to `@newrelic/query-bridge` at merge.
- **Runbook R1–R5** (repo creation, secret scanning + push protection, branch protection, retire `grandcentral.yml`, `npm publish`) — unchanged; gated on OSPO approval (GitHub repo creation in `newrelic-experimental` + `@newrelic/` npm scope access). The scrub's Phase B history rewrite is **complete**.
- **OSPO:** confirm `@newrelic/` npm publish access (else fall back to the unscoped `nr-query-bridge`).

---

## Preconditions

This plan assumes the **monorepo migration has landed** (`docs/superpowers/plans/2026-06-16-dashboard-importer-phase-0-1.md`, Phase 0). It targets the post-migration layout:

- Workspace root `package.json` (`name: nr-query-bridge-workspaces`, `private: true`, `workspaces: [packages/nr-query-bridge, packages/nr-dashboard-importer]`).
- Translator package at `packages/nr-query-bridge/` (zero runtime deps).
- Importer package at `packages/nr-dashboard-importer/` (runtime dep `fast-xml-parser`).
- Root keeps: `README.md`, `LICENSE`, `.github/`, `.husky/`, `grandcentral.yml`, `Dockerfile.gc`, `docs/`.

If the migration has **not** landed, stop and run that plan first — paths below will not exist.

## Verified facts (read 2026-06-16)

- **repolinter ruleset (the gate):** `https://raw.githubusercontent.com/newrelic/.github/main/repolinter-rulesets/new-relic-experimental.yml`. ERROR rules: `license-file-exists`, `readme-file-exists`, `readme-starts-with-experimental-header`, `readme-contains-link-to-security-policy`, `code-of-conduct-should-not-exist-here`. WARNING rule: `third-party-notices-file-exists`.
- **Experimental banner** must appear in the README's first 5 lines (exact HTML in Task 2).
- **Security link:** README must contain `../../security/policy` (or the absolute `github.com/newrelic-experimental/<repo>/security/policy`).
- **No local CODE_OF_CONDUCT** — repolinter errors if one exists.
- **Notices tool:** `newrelic/newrelic-oss-cli` for JS projects.
- **npm names (recommended):** `@newrelic/query-bridge` (translator), `@newrelic/dashboard-importer` (importer). `nr-query-bridge` unscoped is available as a fallback.
- **GHA does not run on internal GHE** — workflows authored here stay dormant until the public push; `grandcentral.yml` is the internal gate until then.

## File structure

```
nr-query-bridge/ (workspace root)
  README.md                         ← MODIFY (Tier A: experimental header + security link)
  LICENSE                           ← present (Apache-2.0) — verify only
  CONTRIBUTING.md                   ← CREATE (Tier B)
  cla.md                            ← CREATE (Tier B)
  SECURITY.md                       ← CREATE (Tier B)
  CHANGELOG.md                      ← CREATE (Tier B)
  THIRD_PARTY_NOTICES.md            ← CREATE per package (Tier B; importer is the real one)
  .github/
    workflows/
      repolinter.yml                ← CREATE (Tier A)
      ci.yml                        ← CREATE (Tier C)
      codeql.yml                    ← CREATE (Tier C)
    ISSUE_TEMPLATE/
      bug_report.md                 ← CREATE (Tier B)
      enhancement.md                ← CREATE (Tier B)
    dependabot.yml                  ← MODIFY (Tier B: public npm + per-package)
    pull_request_template.md        ← present — keep
  packages/nr-query-bridge/
    README.md                       ← CREATE (Tier B: npm-facing)
    LICENSE                         ← CREATE (copy of root)
    package.json                    ← MODIFY (Tier B: name @newrelic/query-bridge, publish metadata)
  packages/nr-dashboard-importer/
    README.md                       ← CREATE (Tier B)
    LICENSE                         ← CREATE (copy of root)
    THIRD_PARTY_NOTICES.md          ← CREATE (Tier B: oss-cli output, lists fast-xml-parser)
    package.json                    ← MODIFY (Tier B: name @newrelic/dashboard-importer, publish metadata)
  grandcentral.yml                  ← retire at public push (runbook), not in this plan's commits
```

---

# Tier A — repolinter green (the hard gate)

**Exit criteria:** a local `repolinter` run against the experimental ruleset reports the five ERROR rules passing.

### Task 1: Add the repolinter workflow + confirm no local CoC

**Files:**
- Create: `.github/workflows/repolinter.yml`

- [ ] **Step 1: Create the workflow verbatim from the NR template**

This is the canonical content from `newrelic-experimental/java-instrumentation-template@main` (read 2026-06-16) — it is project-agnostic, so no edits are needed:

```yaml
# NOTE: This file should always be named `repolinter.yml` to allow
# workflow_dispatch to work properly
name: Repolinter Action

# NOTE: This workflow will ONLY check the default branch!
on: [push, workflow_dispatch]

jobs:
  repolint:
    name: Run Repolinter
    runs-on: ubuntu-latest
    steps:
      - name: Test Default Branch
        id: default-branch
        uses: actions/github-script@v2
        with:
          script: |
            const data = await github.repos.get(context.repo)
            return data.data && data.data.default_branch === context.ref.split('/').slice(-1)[0]
      - name: Checkout Self
        if: ${{ steps.default-branch.outputs.result == 'true' }}
        uses: actions/checkout@v2
      - name: Run Repolinter
        if: ${{ steps.default-branch.outputs.result == 'true' }}
        uses: newrelic/repolinter-action@v1
        with:
          config_url: https://raw.githubusercontent.com/newrelic/.github/main/repolinter-rulesets/new-relic-experimental.yml
          output_type: issue
```

- [ ] **Step 2: Confirm no local CODE_OF_CONDUCT exists**

Run: `ls CODE_OF_CONDUCT* CODE-OF-CONDUCT* 2>/dev/null; echo "exit:$?"`
Expected: no files listed (a local CoC would make repolinter error; the CoC is centralized in `newrelic/.github`).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/repolinter.yml
ASDF_NODEJS_VERSION=24.14.0 git commit -m "ci: add new relic experimental repolinter workflow"
```

### Task 2: Add the experimental header + security link to the root README

**Files:**
- Modify: `README.md` (workspace root)

- [ ] **Step 1: Run repolinter locally to see it fail (red)**

Run: `npx repolinter@latest lint -u https://raw.githubusercontent.com/newrelic/.github/main/repolinter-rulesets/new-relic-experimental.yml .`
(If `-u` is rejected, check `npx repolinter lint --help` for the remote-ruleset flag.)
Expected: FAIL on `readme-starts-with-experimental-header` and `readme-contains-link-to-security-policy`; PASS on `license-file-exists` and `code-of-conduct-should-not-exist-here`.

- [ ] **Step 2: Prepend the experimental banner as the very first line of `README.md`**

The ruleset matches this exact HTML in the first 5 lines:

```html
<a href="https://opensource.newrelic.com/oss-category/#new-relic-experimental"><picture><source media="(prefers-color-scheme: dark)" srcset="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/dark/Experimental.png"><source media="(prefers-color-scheme: light)" srcset="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/Experimental.png"><img alt="New Relic Open Source experimental project banner." src="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/Experimental.png"></picture></a>
```

Insert it as line 1, then a blank line, then the existing README content.

- [ ] **Step 3: Add a security-policy link in the README body**

Add a "A note about vulnerabilities" section that contains the relative security link `../../security/policy`:

```markdown
## A note about vulnerabilities

As noted in our [security policy](../../security/policy), New Relic is committed to the privacy and security of our customers and their data. If you believe you have found a security vulnerability, report it to New Relic through [HackerOne](https://hackerone.com/newrelic).
```

- [ ] **Step 4: Re-run repolinter to confirm green**

Run: `npx repolinter@latest lint -u https://raw.githubusercontent.com/newrelic/.github/main/repolinter-rulesets/new-relic-experimental.yml .`
Expected: all five ERROR rules PASS. (`third-party-notices-file-exists` may still WARN — addressed in Tier B.)

- [ ] **Step 5: Commit**

```bash
git add README.md
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: add experimental header and security link to readme"
```

---

# Tier B — NR-template convention (OSPO checklist; not repolinter-blocking)

**Exit criteria:** the recommended NR scaffolding files exist at root, both packages carry npm-publish metadata + LICENSE + README, and the importer has a generated `THIRD_PARTY_NOTICES.md`.

### Task 3: Add CONTRIBUTING.md and cla.md from the canonical NR template

**Files:**
- Create: `CONTRIBUTING.md`, `cla.md`

- [ ] **Step 1: Copy both files verbatim from the canonical template**

Source (read these raw URLs and write the bytes to the local files):
- `https://raw.githubusercontent.com/newrelic-experimental/java-instrumentation-template/main/CONTRIBUTING.md` → `CONTRIBUTING.md`
- `https://raw.githubusercontent.com/newrelic-experimental/java-instrumentation-template/main/cla.md` → `cla.md`

- [ ] **Step 2: Apply project adaptations to `CONTRIBUTING.md` only**

Replace any bracketed project-name placeholder (e.g. `[Project Name]`) with `nr-query-bridge`. `cla.md` is the standard NR CLA and needs no edits.

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md cla.md
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: add contributing guide and cla"
```

### Task 4: Add SECURITY.md (populates the GitHub security tab the README links to)

**Files:**
- Create: `SECURITY.md`

- [ ] **Step 1: Write `SECURITY.md`**

```markdown
# Security Policy

## Reporting security vulnerabilities

New Relic is committed to the privacy and security of our customers and their data. If you believe you have found a security vulnerability in this project or any New Relic product, report it to New Relic through [HackerOne](https://hackerone.com/newrelic).

Please do not report security vulnerabilities through public GitHub issues.
```

- [ ] **Step 2: Commit**

```bash
git add SECURITY.md
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: add security policy"
```

### Task 5: Add issue templates

**Files:**
- Create: `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/enhancement.md`

- [ ] **Step 1: Copy both from the canonical template**

- `https://raw.githubusercontent.com/newrelic-experimental/java-instrumentation-template/main/.github/ISSUE_TEMPLATE/bug_report.md`
- `https://raw.githubusercontent.com/newrelic-experimental/java-instrumentation-template/main/.github/ISSUE_TEMPLATE/enhancement.md`

These are project-agnostic; no edits needed.

- [ ] **Step 2: Commit**

```bash
git add .github/ISSUE_TEMPLATE/
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: add bug-report and enhancement issue templates"
```

### Task 6: Add CHANGELOG.md

**Files:**
- Create: `CHANGELOG.md`

- [ ] **Step 1: Write an initial changelog**

```markdown
# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- Initial public release preparation.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
ASDF_NODEJS_VERSION=24.14.0 git commit -m "docs: add changelog"
```

### Task 7: Per-package npm publish metadata + LICENSE + README

**Files:**
- Create: `packages/nr-query-bridge/LICENSE`, `packages/nr-query-bridge/README.md`, `packages/nr-dashboard-importer/LICENSE`, `packages/nr-dashboard-importer/README.md`
- Modify: `packages/nr-query-bridge/package.json`, `packages/nr-dashboard-importer/package.json`

- [ ] **Step 1: Copy the root LICENSE into each package**

```bash
cp LICENSE packages/nr-query-bridge/LICENSE
cp LICENSE packages/nr-dashboard-importer/LICENSE
```

- [ ] **Step 2: Set the public npm name + publish metadata in each package.json**

In `packages/nr-query-bridge/package.json` set:
```json
"name": "@newrelic/query-bridge",
"repository": { "type": "git", "url": "git+https://github.com/newrelic-experimental/nr-query-bridge.git", "directory": "packages/nr-query-bridge" },
"publishConfig": { "access": "public" }
```
In `packages/nr-dashboard-importer/package.json` set:
```json
"name": "@newrelic/dashboard-importer",
"repository": { "type": "git", "url": "git+https://github.com/newrelic-experimental/nr-query-bridge.git", "directory": "packages/nr-dashboard-importer" },
"publishConfig": { "access": "public" }
```
(`publishConfig.access: public` is required for scoped packages — without it npm tries to publish privately and fails.)

- [ ] **Step 3: Write a short npm-facing README in each package**

Each package README needs the experimental banner (same HTML as Task 2), a one-line description, an install line (`npm install @newrelic/query-bridge`), and a link back to the monorepo. Keep it short — the root README is the full story.

- [ ] **Step 4: Verify each package packs only intended files**

Run: `npm pack --dry-run --workspace=@newrelic/query-bridge` and `npm pack --dry-run --workspace=@newrelic/dashboard-importer`
Expected: the file list includes `src/`, `README.md`, `LICENSE` and excludes `test/`, `docs/local/`, `node_modules/`.

- [ ] **Step 5: Commit**

```bash
git add packages/*/LICENSE packages/*/README.md packages/*/package.json
ASDF_NODEJS_VERSION=24.14.0 git commit -m "chore: add per-package npm publish metadata, license, readme"
```

### Task 8: Generate THIRD_PARTY_NOTICES (importer) + repoint dependabot

**Files:**
- Create: `packages/nr-dashboard-importer/THIRD_PARTY_NOTICES.md`
- Modify: `.github/dependabot.yml`

- [ ] **Step 1: Generate the importer's notices with the NR oss-cli**

The translator has zero runtime deps, so its notices are empty/omitted. The importer depends on `fast-xml-parser`, so it needs a real notices file. Generate it with `newrelic/newrelic-oss-cli` (the JS notices generator named by the repolinter ruleset). From `packages/nr-dashboard-importer/`, run the oss-cli's third-party-notices command per its README (confirm exact invocation there — it reads `package.json` deps and emits `THIRD_PARTY_NOTICES.md`).

- [ ] **Step 2: Verify the notices file lists fast-xml-parser**

Run: `grep -i fast-xml-parser packages/nr-dashboard-importer/THIRD_PARTY_NOTICES.md`
Expected: a match (the dep is attributed).

- [ ] **Step 3: Repoint dependabot to public npm with per-package directories**

Rewrite `.github/dependabot.yml` so the npm ecosystem points at each workspace and (if present) drop any internal-registry config:
```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/packages/nr-query-bridge"
    schedule: { interval: "weekly" }
  - package-ecosystem: "npm"
    directory: "/packages/nr-dashboard-importer"
    schedule: { interval: "weekly" }
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule: { interval: "weekly" }
```

- [ ] **Step 4: Commit**

```bash
git add packages/nr-dashboard-importer/THIRD_PARTY_NOTICES.md .github/dependabot.yml
ASDF_NODEJS_VERSION=24.14.0 git commit -m "chore: add importer third-party notices, repoint dependabot to public npm"
```

---

# Tier C — GitHub Actions CI (dormant on internal GHE, live once public)

**Exit criteria:** `ci.yml`, `codeql.yml`, and `changelog.yml` exist and are well-formed YAML. They cannot execute on internal GHE (no runners) — they run on the first push to github.com. `grandcentral.yml` stays the internal gate and is retired in the runbook below.

### Task 9: Author the CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `ci.yml`**

The root scripts already fan out across workspaces (`npm run test/lint/types:check` use `--workspaces --if-present` per the monorepo root package.json), so a single set of root commands covers both packages:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run types:check
      - run: npm test
```

- [ ] **Step 2: Verify the YAML is well-formed**

Run: `npx prettier --check .github/workflows/ci.yml`
Expected: "All matched files use Prettier code style!" (semantic execution is deferred — GHA does not run on internal GHE).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
ASDF_NODEJS_VERSION=24.14.0 git commit -m "ci: add github actions test workflow (node 24, workspaces)"
```

### Task 10: Author the CodeQL workflow

**Files:**
- Create: `.github/workflows/codeql.yml`

- [ ] **Step 1: Write `codeql.yml`**

```yaml
name: CodeQL
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '31 7 * * 1'
jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      actions: read
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript
      - uses: github/codeql-action/analyze@v3
```

- [ ] **Step 2: Verify the YAML is well-formed**

Run: `npx prettier --check .github/workflows/codeql.yml`
Expected: passes. (CodeQL runs only on the public repo.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/codeql.yml
ASDF_NODEJS_VERSION=24.14.0 git commit -m "ci: add codeql analysis workflow"
```

### Task 11: Enforce CHANGELOG updates on PRs

**Files:**
- Create: `.github/workflows/changelog.yml`

A `## Unreleased` block already exists in `CHANGELOG.md` (Task 6). This gate fails a
PR that doesn't touch `CHANGELOG.md`, unless the author applies a `skip-changelog`
label — the standard low-friction pattern. **CI, not a pre-commit hook:** a hook
fires on every commit (including WIP) and has no PR context, so it just trains
`--no-verify`. Use a dependency-free inline check (no third-party Action to vet),
in keeping with the repo's zero-dep ethos.

- [ ] **Step 1: Write `changelog.yml`**

```yaml
name: Changelog
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
jobs:
  changelog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Require a CHANGELOG.md entry
        if: ${{ !contains(github.event.pull_request.labels.*.name, 'skip-changelog') }}
        run: |
          if git diff --name-only "origin/${{ github.base_ref }}...HEAD" | grep -qx 'CHANGELOG.md'; then
            echo "CHANGELOG.md updated."
          else
            echo "::error::CHANGELOG.md not updated. Add an entry under '## Unreleased' or apply the 'skip-changelog' label."
            exit 1
          fi
```

- [ ] **Step 2: Verify the YAML is well-formed**

Run: `npx prettier --check .github/workflows/changelog.yml`
Expected: passes. (The gate runs only on the public repo — GHA does not run on internal GHE.)

- [ ] **Step 3: Create the `skip-changelog` label**

This is a repo-settings action; it belongs with the runbook (label must exist before
the gate can be bypassed). Recorded in R2 below.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/changelog.yml
ASDF_NODEJS_VERSION=24.14.0 git commit -m "ci: enforce changelog updates on prs"
```

---

# Runbook — repo settings + publish (manual; gated; not committable)

These steps are **not** TDD tasks — they are admin/ops actions performed at or after public-repo creation. They are listed for completeness and to be executed in order once their gates clear.

### R1. Create the public repo (gate: OSPO repo-creation approval — scrub Phase B history rewrite is done)

Create `github.com/newrelic-experimental/nr-query-bridge` (via OSPO repo-creation), then push the scrubbed, monorepo-migrated, scaffolded tree.

### R2. Repo settings (gate: repo exists; needs admin)

- **Secret scanning + push protection** (the OSPO requirement). UI: Settings → *Code security and analysis* → enable both. Or API (verify field names against current GitHub docs first):
  ```bash
  gh api -X PATCH repos/newrelic-experimental/nr-query-bridge --input - <<'JSON'
  {"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
  JSON
  ```
- **Branch protection** on the default branch: require PR review + passing CI + repolinter checks.
- Enable **CodeQL** + **Dependabot alerts**; set repo description + topics; confirm `is_template: false`.
- Create the **`skip-changelog`** label (Task 11's gate bypass): `gh label create skip-changelog -d "PR exempt from the CHANGELOG.md gate"`.

### R3. Confirm CI + repolinter green on the public repo

First push triggers `ci.yml`, `codeql.yml`, `changelog.yml`, and `repolinter.yml`. Confirm all green (this is the first real execution — they were dormant internally).

### R4. Retire internal CI

Once GHA is green on the public repo, remove the internal gate:
```bash
git rm grandcentral.yml Dockerfile.gc
ASDF_NODEJS_VERSION=24.14.0 git commit -m "ci: retire grand central, github actions is now the gate"
```

### R5. Publish to npm (gate: `@newrelic/` scope access granted — Emily/OSPO)

```bash
npm publish --workspace=@newrelic/query-bridge
npm publish --workspace=@newrelic/dashboard-importer
```
`publishConfig.access: public` (Task 7) makes these publish publicly. If `@newrelic/` access is not granted, fall back to the unscoped names per the spec.

---

## Open items carried from the spec

- **Emily/OSPO:** `@newrelic/` npm publish access for an experimental repo (blocks R5; fallback exists).
- **Gate:** R1–R5 depend on OSPO approval (GitHub repo creation + `@newrelic/` scope). The scrub spec's Phase B (history rewrite) is complete.
