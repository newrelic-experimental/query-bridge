# Splunk Dashboard Importer — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the repo to an npm-workspaces monorepo (Phase 0), then build the thinnest end-to-end slice that turns one Splunk Simple XML dashboard into runnable New Relic Terraform (Phase 1).

**Architecture:** A pipeline of small pure stages — `detectFormat → parseSimpleXml → DashboardModel → translateWidgets → emitTerraform` — living in a new `packages/nr-dashboard-importer` package that depends on the existing translator package `@datanerd/nr-query-bridge`. The translator is a consumer-facing zero-runtime-dep library; the importer carries the XML parser and file I/O. A neutral `DashboardModel` is the seam between Splunk parsing and NR emission.

**Tech Stack:** Pure ESM JavaScript, Node 24 (`ASDF_NODEJS_VERSION=24.14.0`), npm workspaces, Vitest, `fast-xml-parser` 5.8.0 (importer only), `@datanerd/nr-query-bridge` (workspace-local translator). No TypeScript emit; `checkJs` only.

**Source spec:** `docs/superpowers/specs/2026-06-12-dashboard-importer-design.md`

---

## Scope of this plan

This plan covers **Phase 0** (monorepo migration — its own PR, no importer logic) and **Phase 1** (Terraform-only vertical slice: one Simple XML file → `dashboard.tf` + `versions.tf` + `variables.tf`, line/table/billboard widgets only, no variables, no base/post-process).

**Explicitly NOT in this plan** (later plans): all of Phase 2 (Simple XML breadth — all viz types, template variables, base/post-process resolution, placeholder widgets, REST-envelope bulk path, reports roll-up), Phase 3 (Dashboard Studio), Phase 4 (NerdGraph + UI-paste emitters), Phase 5 (live push). The file structure below names the later-phase files so the seams exist, but this plan only creates the Phase 0/1 ones.

## Two PRs

- **PR 1 = Phase 0** (Tasks 1–9): the mechanical migration. Merge before any importer work. The translator's existing 681-test suite must be green before and after with zero behavior change. Reviewers see a pure path-move.
- **PR 2 = Phase 1** (Tasks 10–21): the importer vertical slice. Depends on PR 1 being merged.

Do not interleave them. The whole point of the split is that the giant path-move diff stays separate from logic.

## Ground-truth facts (verified against the repo 2026-06-16)

These are the real names/paths/contracts the tasks below rely on. Do not re-derive them; do not guess alternatives.

- **Translator public entry:** `translateSplToNrql(spl)` exported from `src/index.js`. NOT `translate()`. After migration it is imported as `import { translateSplToNrql } from '@datanerd/nr-query-bridge'`.
- **Translate result contract:** `{ nrql: string, warnings: string[], unsupported: string[], errors: string[] }`. When `unsupported.length > 0 || errors.length > 0`, `nrql === ''`. Empty/blank input returns `{ nrql: 'FROM Log SELECT *', warnings: [], unsupported: [], errors: [] }` (a sentinel, not an error).
- **Translator source files that move** (all under `src/`): `index.js`, `translate.js`, `messages.js`, `ir/{nodes,optimize,transform}.js`, `input/spl/{aggregationHandlers,enrichmentHandlers,evalHandlers,extractionHandlers,rowHandlers,splExprUtils,splParser,splTime,splToIR}.js`, `input/spl/spl.grammar`, `output/nrql/{irToNrql,nrqlEncoding}.js`.
- **Translator test files that move** (all under `test/`): `ir/{nodes,optimize,transform}.test.js`, `output/irToNrql.test.js`, `playground/examples.test.js`, `spl/{spl-fuzz,spl,v2-show}.test.js`, `spl/spl-real-world.json`.
- **Translator bin that moves:** `bin/spl2nrql.js`.
- **Self-anchored path couplings inside tests (survive the move because relative to the test file):**
  - `test/spl/spl-fuzz.test.js:17` → `new URL('./spl-real-world.json', import.meta.url)` — JSON travels with it, OK.
  - `test/spl/spl.test.js:4050` → `path.join(import.meta.dirname, 'spl-real-world.json')` — OK.
- **Doc-anchored path couplings inside tests (break unless docs travel too):**
  - `test/spl/spl.test.js:3761` → `path.resolve(import.meta.dirname, '../../docs/SPL_TO_NRQL.md')`.
  - `test/playground/examples.test.js:2` → `import { EXAMPLES } from '../../docs/playground/examples.js'`.
  - **Decision (this plan):** move the translator's own docs INTO the package so `../../docs/` stays valid unchanged. See Docs split below.
- **Docs split:**
  - **Into `packages/nr-query-bridge/docs/`:** `ARCHITECTURE.md`, `CLI.md`, `SPL_TO_NRQL.md`, `playground/{examples.js,index.html,playground.js}`.
  - **Stay at repo-root `docs/`:** `superpowers/specs/`, `superpowers/plans/` (this file lives here).
  - `docs/references/` does not exist; code comments citing `docs/references/splunk-to-nr-migration-guide.md` are pre-existing stale refs — do not touch them in this plan.
- **Husky hooks (root `.husky/`):** `pre-commit` runs `npm test` then `git add docs/SPL_TO_NRQL.md`; `pre-push` runs `npm run lint && npm run types:check`; `commit-msg` runs commitlint. The `git add` path becomes `packages/nr-query-bridge/docs/SPL_TO_NRQL.md`.
- **CI:** `grandcentral.yml` `test_suites` runs `npm ci && npm run lint && npm run types:check && npm test` on `Dockerfile.gc` (Node 24). There is NO GitHub Actions test workflow. `.github/` holds only `dependabot.yml` + `pull_request_template.md`.
- **Path-bearing configs at root:** `package.json` (main/exports/bin/files/scripts), `vitest.config.js` (`test/**`), `tsconfig.json` (`src/**`,`bin/**`, excludes `src/input/spl/splParser.js`), `eslint.config.js` (ignores `src/input/spl/splParser.js`; globs `test/**`, `docs/playground/**`), `.prettierignore`, `.lintstagedrc`.
- **bin conventions (mirror in new CLI):** stdout for the emitted artifact path/content; stderr with `warning:`/`unsupported:`/`error:` prefixes; `process.exitCode = 1` on errors; dispatch on `--help`/`-i`/args/stdin.
- **Commit discipline:** lowercase conventional-commit subject ≤72 chars; commit with `ASDF_NODEJS_VERSION=24.14.0 git commit`; never `git push` bare — use `git push origin HEAD`. DO NOT push or open PRs without the user asking.
- **There is a stray `nr-query-bridge.zip` at repo root** (gitignored? no — `.gitignore` lists `*.tgz` not `*.zip`). Do not commit it. If `git status` shows it untracked, leave it alone; do not `git add` it.

## File structure (Phase 0 + Phase 1 only)

```
nr-query-bridge/ (repo root → workspace root)
  package.json                       ← MODIFY: workspaces:[nr-query-bridge, nr-dashboard-importer], root scripts delegate
  vitest.config.js                   ← MODIFY or remove (per-package config preferred)
  packages/
    nr-query-bridge/                 ← the translator, MOVED here, unchanged behavior, zero-dep
      package.json                   ← MOVED (name @datanerd/nr-query-bridge), paths unprefixed (now package-relative)
      vitest.config.js               ← CREATE (test/**)
      tsconfig.json                  ← MOVED
      eslint.config.js               ← MOVED
      .prettierignore                ← MOVED
      src/ ... (all translator src)  ← MOVED
      bin/spl2nrql.js                ← MOVED
      test/ ...                      ← MOVED
      docs/{ARCHITECTURE,CLI,SPL_TO_NRQL}.md, docs/playground/  ← MOVED (translator docs only)
    nr-dashboard-importer/           ← NEW package (Phase 1 fills src/)
      package.json                   ← CREATE (deps: @datanerd/nr-query-bridge, fast-xml-parser)
      vitest.config.js               ← CREATE
      src/
        detectFormat.js              ← CREATE (Phase 1: single-file Simple XML only)
        parseSimpleXml.js            ← CREATE (Phase 1: <chart>/<table>/<single> only)
        model.js                     ← CREATE (Phase 1: minimal model + 3 vizTypes)
        translateWidgets.js          ← CREATE (Phase 1: translate + clean/placeholder)
        emitTerraform.js             ← CREATE (Phase 1: resource + versions/variables skeleton)
        report.js                    ← CREATE (Phase 1: one-dashboard summary)
      bin/spl-dashboard.js           ← CREATE (Phase 1: single-file, --account, --out)
      test/
        fixtures/                    ← CREATE (de-identified Simple XML samples)
        *.test.js                    ← CREATE per src file
  docs/superpowers/{specs,plans}/    ← STAY at root
  .husky/{pre-commit,pre-push,commit-msg}  ← MODIFY pre-commit git-add path
  grandcentral.yml                   ← MODIFY command to run workspace tests
  Dockerfile.gc                      ← unchanged (Node 24 image)
```

Later-phase files NOT created in this plan but reserved in the package: `parseStudio.js`, `emitNerdGraph.js`, `emitUiPaste.js`, `pushDashboard.js`.

---

# PR 1 — Phase 0: Monorepo Migration

**Exit criteria:** repo builds as npm workspaces; translator lives in `packages/nr-query-bridge/`; its suite reports **681 passed | 6 skipped (687)** unchanged; `packages/nr-dashboard-importer/` scaffold exists with one passing trivial test; no importer logic. Mechanical only — zero behavior change.

**Baseline to preserve (verified 2026-06-16):** `8 test files, 681 passed | 6 skipped (687)`, Vitest v4.1.8.

### Task 1: Capture the green baseline

**Files:** none (verification only)

- [ ] **Step 1: Confirm clean tree**

Run: `git status --short`
Expected: only untracked `docs/superpowers/plans/2026-06-16-dashboard-importer-phase-0-1.md` (and possibly a stray `nr-query-bridge.zip` — leave it untracked, never `git add` it).

- [ ] **Step 2: Run the full suite at the current layout**

Run: `ASDF_NODEJS_VERSION=24.14.0 npx vitest run`
Expected: `Test Files  8 passed (8)` / `Tests  681 passed | 6 skipped (687)`. Record this exact line; every later step compares against it.

- [ ] **Step 3: Confirm lint + types are green**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check`
Expected: both exit 0, no output errors.

### Task 2: Create the workspace root package.json

**Files:**
- Modify: `package.json` (repo root)

The root becomes a thin workspace coordinator. The translator's real package.json moves to the package dir in Task 4. Root keeps only workspace wiring, dev-tooling shared across packages, and delegating scripts.

- [ ] **Step 1: Rewrite root package.json as a workspace root**

Replace the entire `package.json` with:

```json
{
  "name": "nr-query-bridge-workspaces",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Workspace root for the nr-query-bridge translator and the dashboard importer.",
  "workspaces": [
    "packages/nr-query-bridge",
    "packages/nr-dashboard-importer"
  ],
  "engines": {
    "node": ">=20"
  },
  "license": "Apache-2.0",
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "lint:fix": "npm run lint:fix --workspaces --if-present",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "types:check": "npm run types:check --workspaces --if-present",
    "build:parsers": "npm run build:parsers --workspace=@datanerd/nr-query-bridge",
    "build:types": "npm run build:types --workspace=@datanerd/nr-query-bridge",
    "prepare": "husky"
  },
  "devDependencies": {
    "@commitlint/cli": "*",
    "@commitlint/config-conventional": "*",
    "@eslint/js": "*",
    "eslint": "*",
    "eslint-config-prettier": "*",
    "fast-check": "*",
    "husky": "*",
    "lint-staged": "*",
    "peggy": "*",
    "prettier": "*",
    "typescript": "*",
    "vitest": "*"
  },
  "overrides": {
    "vite": ">=8.0.5",
    "postcss": ">=8.5.10"
  }
}
```

Rationale: `devDependencies` stay hoisted at root so both packages share one toolchain install. The translator package will declare NO `dependencies` (its zero-dep guarantee). `prettier`/`husky`/`commitlint`/`lint-staged` are root-level (they operate across the whole tree). Root `prepare: husky` keeps hooks installed from root where `.husky/` lives.

- [ ] **Step 2: Do NOT install yet**

Installation happens in Task 7 after the package dirs and their package.json files exist. Moving on.

### Task 3: Create the two package directories

**Files:**
- Create: `packages/nr-query-bridge/` (dir)
- Create: `packages/nr-dashboard-importer/` (dir)

- [ ] **Step 1: Make the directories**

Run: `mkdir -p packages/nr-query-bridge packages/nr-dashboard-importer/src packages/nr-dashboard-importer/test/fixtures packages/nr-dashboard-importer/bin`
Expected: dirs exist; `ls packages` shows both.

### Task 4: Move the translator source, tests, bin, and configs with git mv

**Files:**
- Move: `src/` → `packages/nr-query-bridge/src/`
- Move: `test/` → `packages/nr-query-bridge/test/`
- Move: `bin/spl2nrql.js` → `packages/nr-query-bridge/bin/spl2nrql.js`
- Move: `tsconfig.json` → `packages/nr-query-bridge/tsconfig.json`
- Move: `eslint.config.js` → `packages/nr-query-bridge/eslint.config.js`
- Move: `.prettierignore` → `packages/nr-query-bridge/.prettierignore`

Use `git mv` so history follows the files and the diff reads as a rename.

- [ ] **Step 1: Move source tree**

Run: `git mv src packages/nr-query-bridge/src`
Expected: `git status --short` shows `R` (renamed) rows for every file under `src/`.

- [ ] **Step 2: Move test tree**

Run: `git mv test packages/nr-query-bridge/test`
Expected: renames for all 9 test files incl. `spl/spl-real-world.json`.

- [ ] **Step 3: Move the translator bin**

Run: `mkdir -p packages/nr-query-bridge/bin && git mv bin/spl2nrql.js packages/nr-query-bridge/bin/spl2nrql.js`
Expected: `spl2nrql.js` renamed; root `bin/` now empty (remove it: `rmdir bin` if empty).

- [ ] **Step 4: Move the translator-scoped configs**

Run: `git mv tsconfig.json packages/nr-query-bridge/tsconfig.json && git mv eslint.config.js packages/nr-query-bridge/eslint.config.js && git mv .prettierignore packages/nr-query-bridge/.prettierignore`
Expected: three renames.

- [ ] **Step 5: Move the translator's own docs into the package**

Run:
```bash
mkdir -p packages/nr-query-bridge/docs
git mv docs/ARCHITECTURE.md packages/nr-query-bridge/docs/ARCHITECTURE.md
git mv docs/CLI.md packages/nr-query-bridge/docs/CLI.md
git mv docs/SPL_TO_NRQL.md packages/nr-query-bridge/docs/SPL_TO_NRQL.md
git mv docs/playground packages/nr-query-bridge/docs/playground
```
Expected: four renames. `docs/superpowers/` stays at root untouched.

- [ ] **Step 6: Verify the doc-anchored test paths now resolve**

The two doc-coupled tests use `../../docs/...` relative to `packages/nr-query-bridge/test/...`. With docs now at `packages/nr-query-bridge/docs/`, `test/spl/../../docs` = `packages/nr-query-bridge/docs` ✓ and `test/playground/../../docs` = `packages/nr-query-bridge/docs` ✓. No code edit needed. Confirm by reading the two anchors:

Run: `grep -n "../../docs" packages/nr-query-bridge/test/spl/spl.test.js packages/nr-query-bridge/test/playground/examples.test.js`
Expected: the two known lines (`spl.test.js` DOC_PATH, `examples.test.js` import) — both still `../../docs/`, now correct.

### Task 5: Create the translator package.json

**Files:**
- Create: `packages/nr-query-bridge/package.json`

This is the OLD root package.json with paths made package-relative (they already are — `src/`, `bin/` are relative), tooling-only scripts kept, and shared devDeps removed (hoisted to root).

- [ ] **Step 1: Write the package package.json**

```json
{
  "name": "@datanerd/nr-query-bridge",
  "version": "0.1.0",
  "type": "module",
  "description": "Multi-language query translator — SPL/Lucene/PromQL/PPL to NRQL/Trino",
  "main": "src/index.js",
  "types": "types/src/index.d.ts",
  "exports": {
    ".": {
      "types": "./types/src/index.d.ts",
      "import": "./src/index.js"
    }
  },
  "bin": {
    "spl2nrql": "./bin/spl2nrql.js"
  },
  "files": [
    "src/",
    "bin/",
    "types/"
  ],
  "engines": {
    "node": ">=20"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/newrelic/nr-query-bridge.git"
  },
  "bugs": {
    "url": "https://github.com/newrelic/nr-query-bridge/issues"
  },
  "homepage": "https://github.com/newrelic/nr-query-bridge#readme",
  "author": {
    "name": "Logging Team"
  },
  "scripts": {
    "prepublishOnly": "npm test && npm run build:types",
    "test": "vitest run",
    "build:parsers": "peggy -o src/input/spl/splParser.js --format es src/input/spl/spl.grammar",
    "build:types": "tsc --declaration --emitDeclarationOnly --noEmit false --outDir types",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "types:check": "tsc --noEmit"
  }
}
```

Rationale: no `dependencies` block at all — preserves the zero-runtime-dep guarantee. No `devDependencies` — those hoist from root. No `prepare`/`format` — husky and prettier are root concerns. `eslint .`/`tsc`/`vitest run` now run within the package dir (each picks up the package-local `eslint.config.js`/`tsconfig.json`/`vitest.config.js`).

### Task 6: Create the translator package vitest config

**Files:**
- Create: `packages/nr-query-bridge/vitest.config.js`
- Delete: root `vitest.config.js` (replaced by per-package configs)

- [ ] **Step 1: Write the package vitest config**

Identical content to the old root one (paths are package-relative globs):

```javascript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    globals: true,
  },
});
```

- [ ] **Step 2: Remove the root vitest config**

Run: `git rm vitest.config.js`
Expected: deletion staged. (Root `npm test` now fans out to workspaces via `--workspaces`.)

### Task 7: Install workspaces and verify the translator suite is byte-for-byte green

**Files:** none (install + verify)

- [ ] **Step 1: Install with workspaces**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm install`
Expected: npm links `@datanerd/nr-query-bridge` into `node_modules/@datanerd/`, regenerates `package-lock.json` for the workspace layout, exits 0.

- [ ] **Step 2: Run the translator suite from root via workspaces**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test`
Expected: the `@datanerd/nr-query-bridge` workspace runs vitest and reports `Tests  681 passed | 6 skipped (687)` — identical to the Task 1 baseline. If the count differs, STOP: a path coupling broke. Do not adjust counts; fix the path.

- [ ] **Step 3: Run lint + types via workspaces**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check`
Expected: both exit 0. (eslint/tsc run inside the package against package-relative configs.)

### Task 8: Update root-level path references (hooks, CI, AGENTS, README)

**Files:**
- Modify: `.husky/pre-commit`
- Modify: `grandcentral.yml`
- Modify: `AGENTS.md:28`
- Modify: `README.md:44`

- [ ] **Step 1: Fix the pre-commit doc-add path**

In `.husky/pre-commit`, change the last line from `git add docs/SPL_TO_NRQL.md` to `git add packages/nr-query-bridge/docs/SPL_TO_NRQL.md`. The `npm test` line stays (root fan-out runs the package suite, whose afterAll regenerates the doc at its new package path).

- [ ] **Step 2: Confirm CI command still works under workspaces**

`grandcentral.yml`'s command is `npm ci && npm run lint && npm run types:check && npm test`. With the root delegating scripts (Task 2), these fan out to workspaces unchanged — no edit needed. Verify by re-reading the file and confirming the command line is unchanged and still valid. (If `npm ci` fails under workspaces in CI, that is a lockfile issue resolved by committing the Task 7 regenerated `package-lock.json`.)

- [ ] **Step 3: Fix AGENTS.md path reference**

In `AGENTS.md`, line ~28 references `test/spl/spl-real-world.json`. Change to `packages/nr-query-bridge/test/spl/spl-real-world.json`.

- [ ] **Step 4: Fix README path reference**

In `README.md`, line ~44 references `../../src/index.js`. Update to the new location `packages/nr-query-bridge/src/index.js` (adjust the relative prefix to match the surrounding sentence's vantage point; if it is an absolute-from-root reference, use `packages/nr-query-bridge/src/index.js`).

- [ ] **Step 5: Re-run the full check after edits**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test`
Expected: still `681 passed | 6 skipped (687)`. The pre-commit path change does not affect the test run, only what gets staged.

### Task 9: Commit Phase 0 as one mechanical migration commit

**Files:** all staged moves + config edits from Tasks 2–8

- [ ] **Step 1: Stage everything except the stray zip**

Run: `git add package.json packages/ .husky/pre-commit grandcentral.yml AGENTS.md README.md && git rm vitest.config.js package-lock.json --cached 2>/dev/null; git add package-lock.json`
Expected: `git status --short` shows the renames (`R`), the new package.json files (`A`), config modifications (`M`), and the regenerated lockfile. Confirm `nr-query-bridge.zip` is NOT staged.

- [ ] **Step 2: Verify the diff is a move, not a rewrite**

Run: `git diff --cached --stat | tail -30`
Expected: mostly rename lines with low churn. Source files under `src/` should show `{src => packages/nr-query-bridge/src}` rename notation with 0 or near-0 line changes. If a source file shows large +/- churn, STOP — a file was edited, violating "no behavior change."

- [ ] **Step 3: Commit**

```bash
ASDF_NODEJS_VERSION=24.14.0 git commit -m "chore: convert repo to npm workspaces monorepo"
```
Expected: pre-commit hook runs `npm test` (passes, 687), stages the regenerated doc, commit succeeds. Conventional, lowercase, ≤72 chars.

- [ ] **Step 4: Final green check on the committed state**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test && ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check`
Expected: all green; `681 passed | 6 skipped`. **Phase 0 done.** Do NOT push or open a PR unless the user asks.

---

# PR 2 — Phase 1: Terraform Vertical Slice

**Exit criteria:** one real (de-identified) Simple XML file → valid `dashboard.tf` + `versions.tf` + `variables.tf`; re-run overwrites identically; line/table/billboard widgets only; no variables, no base/post-process. `terraform validate` passes if the binary is available (skip the assertion gracefully if not).

**Depends on:** PR 1 merged. All Phase 1 work happens inside `packages/nr-dashboard-importer/`.

**Convention for these tasks:** every code step shows the full file content or the exact addition. Tests use Vitest `describe/it/expect` (globals on, per the package vitest config). Run a single test file with `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- <relpath>`.

### Task 10: Scaffold the importer package and verify fast-xml-parser

**Files:**
- Create: `packages/nr-dashboard-importer/package.json`
- Create: `packages/nr-dashboard-importer/vitest.config.js`
- Create: `packages/nr-dashboard-importer/test/smoke.test.js`

- [ ] **Step 1: Verify fast-xml-parser is genuine before adding it**

The security rules require verifying any LLM-suggested library. The spec already did this (`fast-xml-parser` 5.8.0, MIT, maintainer NaturalIntelligence/Amit Gupta, ~72.9M weekly downloads), but re-confirm the version still resolves and the license is permissive:

Run: `ASDF_NODEJS_VERSION=24.14.0 npm view fast-xml-parser@5.8.0 name version license maintainers`
Expected: `name = fast-xml-parser`, `version = 5.8.0`, `license = MIT`. If the version no longer exists, pick the latest `5.x` and record it. Do NOT proceed with an unverified version.

- [ ] **Step 2: Write the importer package.json**

```json
{
  "name": "@datanerd/nr-dashboard-importer",
  "version": "0.0.1",
  "type": "module",
  "private": true,
  "description": "Import Splunk dashboard exports into New Relic via the nr-query-bridge translator.",
  "engines": {
    "node": ">=20"
  },
  "license": "Apache-2.0",
  "bin": {
    "spl-dashboard": "./bin/spl-dashboard.js"
  },
  "scripts": {
    "test": "vitest run",
    "lint": "eslint .",
    "types:check": "tsc --noEmit"
  },
  "dependencies": {
    "@datanerd/nr-query-bridge": "*",
    "fast-xml-parser": "5.8.0"
  }
}
```

Rationale: this package legitimately HAS `dependencies` (the translator + XML parser) — that is exactly why it is a separate package from the zero-dep translator. The `"*"` on the translator resolves to the workspace-local copy. `tsconfig.json`/`eslint.config.js` are added in Task 11 alongside first source.

- [ ] **Step 3: Write the package vitest config**

```javascript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    globals: true,
  },
});
```

- [ ] **Step 4: Write a trivial smoke test (proves the harness runs)**

`packages/nr-dashboard-importer/test/smoke.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

describe('importer package harness', () => {
  it('runs vitest in the new package', () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 5: Install and run the smoke test**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm install`
Then: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer`
Expected: `fast-xml-parser` installs into the importer's tree; smoke test passes (`1 passed`).

- [ ] **Step 5b: Confirm the translator stayed zero-dep**

Open `packages/nr-query-bridge/package.json` and confirm there is still NO `dependencies` key (the importer's deps must not have leaked upward). Do not use `node -e` to read it — just read the file.

- [ ] **Step 6: Commit the scaffold**

```bash
git add packages/nr-dashboard-importer/package.json packages/nr-dashboard-importer/vitest.config.js packages/nr-dashboard-importer/test/smoke.test.js package-lock.json
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: scaffold nr-dashboard-importer package"
```

### Task 11: Define the neutral model and vizType enum

**Files:**
- Create: `packages/nr-dashboard-importer/src/model.js`
- Create: `packages/nr-dashboard-importer/tsconfig.json`
- Create: `packages/nr-dashboard-importer/eslint.config.js`
- Test: `packages/nr-dashboard-importer/test/model.test.js`

Phase 1 model is minimal: title/description, a `widgets[]` with the 3 Phase-1 vizTypes, no `variables`/`defaultTimeRange` logic yet (fields exist but stay empty). The neutral enum is the full spec enum (cheap to define now; emitters only handle 3 in Phase 1).

- [ ] **Step 1: Write the failing test**

`packages/nr-dashboard-importer/test/model.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { createDashboardModel, createWidget, VIZ_TYPES } from '../src/model.js';

describe('createDashboardModel', () => {
  it('builds a model with defaults for omitted fields', () => {
    const m = createDashboardModel({ title: 'My Dash' });
    expect(m.title).toBe('My Dash');
    expect(m.description).toBe('');
    expect(m.sourceFormat).toBe('simple-xml');
    expect(m.variables).toEqual([]);
    expect(m.defaultTimeRange).toBeNull();
    expect(m.widgets).toEqual([]);
  });
});

describe('createWidget', () => {
  it('builds a widget carrying vizType, rawSpl, and layout', () => {
    const w = createWidget({
      title: 'Errors',
      vizType: 'line',
      rawSpl: 'index=web | timechart count',
      layout: { x: 0, y: 0, w: 6, h: 3 },
    });
    expect(w.title).toBe('Errors');
    expect(w.vizType).toBe('line');
    expect(w.rawSpl).toBe('index=web | timechart count');
    expect(w.baseRef).toBeNull();
    expect(w.options).toEqual({});
    expect(w.layout).toEqual({ x: 0, y: 0, w: 6, h: 3 });
  });
});

describe('VIZ_TYPES', () => {
  it('is the frozen neutral enum', () => {
    expect(VIZ_TYPES).toContain('line');
    expect(VIZ_TYPES).toContain('table');
    expect(VIZ_TYPES).toContain('billboard');
    expect(VIZ_TYPES).toContain('markdown');
    expect(VIZ_TYPES).toContain('unknown');
    expect(Object.isFrozen(VIZ_TYPES)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- model`
Expected: FAIL — `Cannot find module '../src/model.js'`.

- [ ] **Step 3: Write model.js**

`packages/nr-dashboard-importer/src/model.js`:

```javascript
/**
 * The neutral dashboard model — the seam between Splunk parsers and NR emitters.
 * Both parsers target this shape; all emitters consume it. Nothing downstream of
 * the parsers branches on sourceFormat.
 *
 * @typedef {object} DashboardModel
 * @property {string} title
 * @property {string} description
 * @property {'simple-xml'|'studio'} sourceFormat
 * @property {Variable[]} variables
 * @property {{earliest:string,latest:string}|null} defaultTimeRange
 * @property {Widget[]} widgets
 *
 * @typedef {object} Variable
 * @property {string} name
 * @property {'enum'|'string'} type
 * @property {string} defaultValue
 * @property {string[]} choices
 * @property {string|null} sourceQuery
 *
 * @typedef {object} Widget
 * @property {string} title
 * @property {VizType} vizType
 * @property {string} rawSpl
 * @property {string|null} baseRef
 * @property {Record<string, unknown>} options
 * @property {{x:number,y:number,w:number,h:number}} layout
 *
 * @typedef {'line'|'area'|'bar'|'column'|'pie'|'scatter'|'billboard'|'table'|'markdown'|'map'|'unknown'} VizType
 */

/** The neutral vizType enum — the contract between parsers and emitters. */
export const VIZ_TYPES = Object.freeze([
  'line',
  'area',
  'bar',
  'column',
  'pie',
  'scatter',
  'billboard',
  'table',
  'markdown',
  'map',
  'unknown',
]);

/**
 * @param {Partial<DashboardModel> & {title: string}} fields
 * @returns {DashboardModel}
 */
export function createDashboardModel(fields) {
  return {
    title: fields.title,
    description: fields.description ?? '',
    sourceFormat: fields.sourceFormat ?? 'simple-xml',
    variables: fields.variables ?? [],
    defaultTimeRange: fields.defaultTimeRange ?? null,
    widgets: fields.widgets ?? [],
  };
}

/**
 * @param {Partial<Widget> & {title: string, vizType: VizType}} fields
 * @returns {Widget}
 */
export function createWidget(fields) {
  return {
    title: fields.title,
    vizType: fields.vizType,
    rawSpl: fields.rawSpl ?? '',
    baseRef: fields.baseRef ?? null,
    options: fields.options ?? {},
    layout: fields.layout ?? { x: 0, y: 0, w: 12, h: 3 },
  };
}
```

- [ ] **Step 4: Add the package tsconfig and eslint config**

`packages/nr-dashboard-importer/tsconfig.json`:

```json
{
  "compilerOptions": {
    "checkJs": true,
    "allowJs": true,
    "noEmit": true,
    "strict": false,
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "ES2022",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.js", "bin/**/*.js"],
  "exclude": ["node_modules", "dist", "tmp"]
}
```

`packages/nr-dashboard-importer/eslint.config.js`:

```javascript
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['node_modules/', 'dist/', 'tmp/', 'coverage/'] },
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
  },
];
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- model`
Expected: PASS (3 tests).

- [ ] **Step 6: Confirm the model test catches regressions**

Mutation check (manual red): temporarily change `createWidget`'s `baseRef: fields.baseRef ?? null` to `baseRef: 'oops'`, re-run — the "baseRef defaults to null" assertion must fail. Restore the line, re-run — green. This proves the test is coupled to the behavior.

- [ ] **Step 7: Add AI-DEV markers and commit**

After the red-green confirmation, add inside each `it()` body:
`// AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.`

```bash
git add packages/nr-dashboard-importer/src/model.js packages/nr-dashboard-importer/test/model.test.js packages/nr-dashboard-importer/tsconfig.json packages/nr-dashboard-importer/eslint.config.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: add neutral DashboardModel and vizType enum"
```

---

### Task 12: detectFormat — single-file Simple XML detection

**Files:**
- Create: `packages/nr-dashboard-importer/src/detectFormat.js`
- Test: `packages/nr-dashboard-importer/test/detectFormat.test.js`

Phase 1 only handles a standalone Simple XML string (`<form>` or `<dashboard version="1...">`). REST-envelope and Studio routing are Phase 2/3 — `detectFormat` returns `'simple-xml'` for those inputs now and throws a clear "not yet supported in Phase 1" for envelope/Studio shapes so nothing silently mis-routes.

- [ ] **Step 1: Write the failing test**

`packages/nr-dashboard-importer/test/detectFormat.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { detectFormat } from '../src/detectFormat.js';

describe('detectFormat', () => {
  it('detects <form> as simple-xml', () => {
    expect(detectFormat('<form>\n<label>X</label>\n</form>')).toBe('simple-xml');
  });

  it('detects <dashboard version="1.1"> as simple-xml', () => {
    expect(detectFormat('<dashboard version="1.1"><label>X</label></dashboard>')).toBe(
      'simple-xml',
    );
  });

  it('detects a leading-whitespace / xml-decl prefixed <form> as simple-xml', () => {
    expect(detectFormat('<?xml version="1.0"?>\n  <form><label>X</label></form>')).toBe(
      'simple-xml',
    );
  });

  it('throws a clear error for a Studio v2 dashboard (Phase 3, not yet supported)', () => {
    expect(() => detectFormat('<dashboard version="2"><definition><![CDATA[{}]]></definition></dashboard>')).toThrow(
      /Dashboard Studio.*Phase 3/,
    );
  });

  it('throws a clear error for a REST envelope (Phase 2, not yet supported)', () => {
    expect(() => detectFormat('{"entry":[{"content":{"eai:data":"<form/>"}}]}')).toThrow(
      /REST envelope.*Phase 2/,
    );
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- detectFormat`
Expected: FAIL — module not found.

- [ ] **Step 3: Write detectFormat.js**

`packages/nr-dashboard-importer/src/detectFormat.js`:

```javascript
/**
 * Sniff the format of a single dashboard payload string.
 *
 * Phase 1 supports ONLY a standalone Simple XML string. REST envelopes and
 * Dashboard Studio are recognized and rejected loudly (loud failure over a
 * silent mis-route) so later phases can extend this without surprise.
 *
 * @param {string} input - raw dashboard payload (file contents or stdin).
 * @returns {'simple-xml'} the detected format.
 * @throws {Error} for not-yet-supported formats.
 */
export function detectFormat(input) {
  const trimmed = input.trimStart();

  // REST export envelope: JSON object with an entry array carrying eai:data.
  if (trimmed.startsWith('{') && /"eai:data"/.test(trimmed)) {
    throw new Error(
      'Splunk REST envelope (dashboards.json) is not yet supported — that is Phase 2.',
    );
  }

  // Strip an optional XML declaration so the root-element check sees the real root.
  const body = trimmed.replace(/^<\?xml[^>]*\?>\s*/, '');

  // Dashboard Studio: <dashboard version="2"> (XML-wrapped) or pure JSON graph.
  if (/^<dashboard\b[^>]*\bversion\s*=\s*["']2/.test(body)) {
    throw new Error('Dashboard Studio (version 2) is not yet supported — that is Phase 3.');
  }
  if (body.startsWith('{') && /"dataSources"|"visualizations"/.test(body)) {
    throw new Error('Dashboard Studio (pure JSON) is not yet supported — that is Phase 3.');
  }

  // Simple XML: <form> or <dashboard version="1...">/<dashboard> (no version).
  if (/^<form\b/.test(body) || /^<dashboard\b/.test(body)) {
    return 'simple-xml';
  }

  throw new Error(
    'Unrecognized dashboard format: expected a Splunk Simple XML <form> or <dashboard>.',
  );
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- detectFormat`
Expected: PASS (5 tests).

- [ ] **Step 5: Confirm regression coverage**

Manual red: temporarily change the Studio v2 regex to never match (e.g. `/^XXX/`), re-run — the "throws for Studio v2" test must fail (it would fall through to simple-xml). Restore, re-run green.

- [ ] **Step 6: Add AI-DEV markers and commit**

Add the AI-DEV marker inside each `it()`. Then:

```bash
git add packages/nr-dashboard-importer/src/detectFormat.js packages/nr-dashboard-importer/test/detectFormat.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: detect simple-xml format, reject studio/envelope loudly"
```

### Task 13: parseSimpleXml — title and a single line chart

**Files:**
- Create: `packages/nr-dashboard-importer/src/parseSimpleXml.js`
- Test: `packages/nr-dashboard-importer/test/parseSimpleXml.test.js`
- Create: `packages/nr-dashboard-importer/test/fixtures/single-chart.xml`

Phase-1 parser handles only `<label>`, `<row><panel>` with `<chart>`/`<table>`/`<single>`, and `<search><query>`. No `<fieldset>` variables, no `<search base>`, no time inputs. Viz mapping: `<chart>` + `charting.chart` enum → `line`/`area`/`bar`/`column`/`pie`/`scatter` (default `line` when the option is absent, per Splunk); `<table>` → `table`; `<single>` → `billboard`. Phase 1 emits only `line`/`table`/`billboard`, but the chart-subtype map is written now so Phase 2 just adds emitter coverage.

- [ ] **Step 1: Write the fixture**

`packages/nr-dashboard-importer/test/fixtures/single-chart.xml` (synthetic, no customer data):

```xml
<form>
  <label>Web Health</label>
  <description>Synthetic fixture</description>
  <row>
    <panel>
      <chart>
        <title>Requests over time</title>
        <search>
          <query>index=web | timechart count</query>
        </search>
        <option name="charting.chart">line</option>
      </chart>
    </panel>
  </row>
</form>
```

- [ ] **Step 2: Write the failing test**

`packages/nr-dashboard-importer/test/parseSimpleXml.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSimpleXml } from '../src/parseSimpleXml.js';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');

describe('parseSimpleXml — title and a single chart', () => {
  it('reads the label as the model title', () => {
    const m = parseSimpleXml(fixture('single-chart.xml'));
    expect(m.title).toBe('Web Health');
    expect(m.description).toBe('Synthetic fixture');
    expect(m.sourceFormat).toBe('simple-xml');
  });

  it('produces one line widget carrying the query SPL', () => {
    const m = parseSimpleXml(fixture('single-chart.xml'));
    expect(m.widgets).toHaveLength(1);
    expect(m.widgets[0].vizType).toBe('line');
    expect(m.widgets[0].title).toBe('Requests over time');
    expect(m.widgets[0].rawSpl).toBe('index=web | timechart count');
  });
});
```

- [ ] **Step 3: Run the test, confirm it fails**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- parseSimpleXml`
Expected: FAIL — module not found.

- [ ] **Step 4: Write parseSimpleXml.js (minimal — single chart path)**

`packages/nr-dashboard-importer/src/parseSimpleXml.js`:

```javascript
import { XMLParser } from 'fast-xml-parser';
import { createDashboardModel, createWidget } from './model.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep single children as objects; we normalize to arrays ourselves.
  isArray: () => false,
  trimValues: true,
});

/** charting.chart enum → neutral vizType. Default 'line' when absent (Splunk default). */
const CHART_TYPE_MAP = {
  line: 'line',
  area: 'area',
  bar: 'bar',
  column: 'column',
  pie: 'pie',
  scatter: 'scatter',
};

/** Coerce a value that may be a single object or an array into an array. */
function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Extract the option[name="charting.chart"] value from a viz element's <option> list. */
function chartingChart(vizEl) {
  for (const opt of asArray(vizEl.option)) {
    if (opt?.['@_name'] === 'charting.chart') {
      return typeof opt['#text'] === 'string' ? opt['#text'] : String(opt['#text'] ?? '');
    }
  }
  return undefined;
}

/** Pull the query string from a viz element's <search><query>. */
function queryOf(vizEl) {
  const search = vizEl.search;
  const query = search?.query;
  if (typeof query === 'string') return query.trim();
  if (query && typeof query['#text'] === 'string') return query['#text'].trim();
  return '';
}

/**
 * Parse a Splunk Simple XML dashboard string into a DashboardModel.
 * Phase 1: <label>/<description>, rows of panels with <chart>/<table>/<single>.
 *
 * @param {string} xml
 * @returns {import('./model.js').DashboardModel}
 */
export function parseSimpleXml(xml) {
  const tree = parser.parse(xml);
  const root = tree.form ?? tree.dashboard ?? {};

  const title = typeof root.label === 'string' ? root.label : (root.label?.['#text'] ?? '');
  const description =
    typeof root.description === 'string'
      ? root.description
      : (root.description?.['#text'] ?? '');

  const widgets = [];
  const rows = asArray(root.row);
  rows.forEach((row, rowIndex) => {
    const panels = asArray(row.panel);
    const panelCount = panels.length || 1;
    panels.forEach((panel, panelIndex) => {
      // A panel can hold chart/table/single children in document order.
      for (const [tag, vizType] of [
        ['chart', null],
        ['table', 'table'],
        ['single', 'billboard'],
      ]) {
        for (const vizEl of asArray(panel[tag])) {
          let resolvedType = vizType;
          if (tag === 'chart') {
            const ct = chartingChart(vizEl);
            resolvedType = CHART_TYPE_MAP[ct ?? 'line'] ?? 'line';
          }
          const w = createWidget({
            title:
              typeof vizEl.title === 'string'
                ? vizEl.title
                : (vizEl.title?.['#text'] ?? ''),
            vizType: resolvedType,
            rawSpl: queryOf(vizEl),
            layout: {
              x: panelIndex * Math.floor(12 / panelCount),
              y: rowIndex * 3,
              w: Math.floor(12 / panelCount),
              h: 3,
            },
          });
          widgets.push(w);
        }
      }
    });
  });

  return createDashboardModel({ title, description, sourceFormat: 'simple-xml', widgets });
}
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- parseSimpleXml`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit (markers added at the end of Task 14 once table/single/default-line are proven)**

Hold AI-DEV markers until Task 14 finishes exercising the other viz branches. Commit the working single-chart path:

```bash
git add packages/nr-dashboard-importer/src/parseSimpleXml.js packages/nr-dashboard-importer/test/parseSimpleXml.test.js packages/nr-dashboard-importer/test/fixtures/single-chart.xml
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: parse simple-xml label and single line chart"
```

### Task 14: parseSimpleXml — table, single, default-line, and multi-panel layout

**Files:**
- Modify: `packages/nr-dashboard-importer/test/parseSimpleXml.test.js` (add cases)
- Create: `packages/nr-dashboard-importer/test/fixtures/multi-panel.xml`

The parser code from Task 13 already handles these branches; this task proves each with a test (start-from-full-branch-coverage discipline). If a branch is wrong, fix the code.

- [ ] **Step 1: Write the multi-panel fixture**

`packages/nr-dashboard-importer/test/fixtures/multi-panel.xml`:

```xml
<form>
  <label>Mixed Panels</label>
  <row>
    <panel>
      <chart>
        <title>No explicit type</title>
        <search><query>index=web | stats count by status</query></search>
      </chart>
    </panel>
    <panel>
      <table>
        <title>Top hosts</title>
        <search><query>index=web | top host</query></search>
      </table>
    </panel>
  </row>
  <row>
    <panel>
      <single>
        <title>Total</title>
        <search><query>index=web | stats count</query></search>
      </single>
    </panel>
  </row>
</form>
```

- [ ] **Step 2: Add the failing test cases**

Append to `describe('parseSimpleXml ...')` in `parseSimpleXml.test.js`:

```javascript
describe('parseSimpleXml — viz types and layout', () => {
  it('defaults a <chart> with no charting.chart option to line', () => {
    const m = parseSimpleXml(fixture('multi-panel.xml'));
    const chart = m.widgets.find((w) => w.title === 'No explicit type');
    expect(chart.vizType).toBe('line');
  });

  it('maps <table> to table and <single> to billboard', () => {
    const m = parseSimpleXml(fixture('multi-panel.xml'));
    expect(m.widgets.find((w) => w.title === 'Top hosts').vizType).toBe('table');
    expect(m.widgets.find((w) => w.title === 'Total').vizType).toBe('billboard');
  });

  it('computes a 12-col layout from row and panel position', () => {
    const m = parseSimpleXml(fixture('multi-panel.xml'));
    // Row 0 has 2 panels → each width 6; row 1 has 1 panel → width 6 (12/1 floored is 12).
    const chart = m.widgets.find((w) => w.title === 'No explicit type');
    const table = m.widgets.find((w) => w.title === 'Top hosts');
    const single = m.widgets.find((w) => w.title === 'Total');
    expect(chart.layout).toEqual({ x: 0, y: 0, w: 6, h: 3 });
    expect(table.layout).toEqual({ x: 6, y: 0, w: 6, h: 3 });
    expect(single.layout).toEqual({ x: 0, y: 3, w: 12, h: 3 });
  });
});
```

- [ ] **Step 3: Run, confirm pass (code already handles these)**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- parseSimpleXml`
Expected: PASS. If the layout test fails because the single-panel row computed width differs, reconcile the assertion with the actual `Math.floor(12/1)=12` — the expected value above is already 12 for the single. If a real bug surfaces, fix `parseSimpleXml.js`, not the test.

- [ ] **Step 4: Confirm regression coverage on the default-line branch**

Manual red: change `CHART_TYPE_MAP[ct ?? 'line'] ?? 'line'` to `CHART_TYPE_MAP[ct] ?? 'unknown'`, re-run — the "defaults to line" test must fail. Restore, green.

- [ ] **Step 5: Add AI-DEV markers across all parseSimpleXml tests and commit**

Add the AI-DEV marker inside every `it()` in `parseSimpleXml.test.js` (Task 13 + Task 14 cases). Then:

```bash
git add packages/nr-dashboard-importer/test/parseSimpleXml.test.js packages/nr-dashboard-importer/test/fixtures/multi-panel.xml
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: parse table, single, default-line, multi-panel layout"
```

---

### Task 15: translateWidgets — bridge each widget through the translator

**Files:**
- Create: `packages/nr-dashboard-importer/src/translateWidgets.js`
- Test: `packages/nr-dashboard-importer/test/translateWidgets.test.js`

Phase 1: no base/chain resolution (every widget's `baseRef` is null). For each widget, call `translateSplToNrql(rawSpl)`. Clean/warnings-only → attach the NRQL + warnings to the widget. `unsupported`/`errors` → convert the widget to a `markdown` placeholder carrying the original SPL, the reason text, and (only if partial NRQL exists) that NRQL labeled unverified. Returns a new widget array plus a per-widget outcome tag the report consumes.

- [ ] **Step 1: Write the failing test**

`packages/nr-dashboard-importer/test/translateWidgets.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { translateWidgets } from '../src/translateWidgets.js';
import { createWidget } from '../src/model.js';

describe('translateWidgets — clean translation', () => {
  it('attaches NRQL and marks a translatable widget clean', () => {
    const widgets = [
      createWidget({ title: 'C', vizType: 'line', rawSpl: 'index=web | stats count' }),
    ];
    const out = translateWidgets(widgets);
    expect(out[0].outcome).toBe('clean');
    expect(out[0].nrql).toMatch(/SELECT count/i);
    expect(out[0].vizType).toBe('line');
  });
});

describe('translateWidgets — placeholder on no NRQL', () => {
  it('converts an untranslatable widget to a markdown placeholder with SPL and reason', () => {
    // A construct the translator reports as unsupported/errors → nrql === ''.
    const widgets = [
      createWidget({ title: 'Bad', vizType: 'table', rawSpl: '| nonsensecommand foo bar' }),
    ];
    const out = translateWidgets(widgets);
    expect(out[0].outcome).toBe('placeholder');
    expect(out[0].vizType).toBe('markdown');
    expect(out[0].placeholderText).toContain('| nonsensecommand foo bar'); // original SPL fenced
    expect(out[0].placeholderText).toMatch(/unsupported|error/i); // the reason
    expect(out[0].placeholderText).not.toMatch(/Partial — unverified/); // no partial NRQL present
    expect(out[0].nrql).toBeUndefined();
  });
});

describe('translateWidgets — warnings attach but stay clean', () => {
  it('keeps a warned widget as a real widget and records the warnings', () => {
    // Pick SPL the translator emits NRQL for but with a warning. If none is known,
    // assert the shape: outcome 'clean' AND warnings is an array.
    const widgets = [
      createWidget({ title: 'W', vizType: 'line', rawSpl: 'index=web | stats count' }),
    ];
    const out = translateWidgets(widgets);
    expect(out[0].outcome).toBe('clean');
    expect(Array.isArray(out[0].warnings)).toBe(true);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- translateWidgets`
Expected: FAIL — module not found.

- [ ] **Step 3: Write translateWidgets.js**

`packages/nr-dashboard-importer/src/translateWidgets.js`:

```javascript
import { translateSplToNrql } from '@datanerd/nr-query-bridge';

/**
 * @typedef {import('./model.js').Widget} Widget
 * @typedef {Widget & {outcome:'clean', nrql:string, warnings:string[]}} CleanWidget
 * @typedef {Widget & {outcome:'placeholder', vizType:'markdown', placeholderText:string, warnings:string[]}} PlaceholderWidget
 */

/**
 * Build the markdown body for a placeholder widget: title, original SPL fenced,
 * the reason, and partial NRQL ONLY if the translator produced some. Per the
 * project's error/unsupported rule, omit the NRQL section entirely when nrql === ''.
 *
 * @param {Widget} widget
 * @param {{nrql:string, unsupported:string[], errors:string[]}} result
 * @returns {string}
 */
function placeholderBody(widget, result) {
  const reasons = [...result.unsupported, ...result.errors];
  let body = `### ${widget.title || '(untitled panel)'}\n\n`;
  body += `**This panel could not be translated automatically.**\n\n`;
  body += `Original SPL:\n\n\`\`\`\n${widget.rawSpl}\n\`\`\`\n\n`;
  body += `Reason:\n\n`;
  for (const r of reasons) body += `- ${r}\n`;
  if (result.nrql) {
    body += `\nPartial — unverified NRQL:\n\n\`\`\`sql\n${result.nrql}\n\`\`\`\n`;
  }
  return body;
}

/**
 * Translate every widget's SPL. Clean/warnings-only widgets get NRQL attached;
 * unsupported/errors become markdown placeholders that preserve the original SPL.
 * Phase 1: baseRef is always null (no base/post-process resolution yet).
 *
 * @param {Widget[]} widgets
 * @returns {(CleanWidget|PlaceholderWidget)[]}
 */
export function translateWidgets(widgets) {
  return widgets.map((widget) => {
    const result = translateSplToNrql(widget.rawSpl);
    const failed = result.unsupported.length > 0 || result.errors.length > 0;
    if (failed) {
      return {
        ...widget,
        vizType: 'markdown',
        outcome: 'placeholder',
        placeholderText: placeholderBody(widget, result),
        warnings: result.warnings,
      };
    }
    return {
      ...widget,
      outcome: 'clean',
      nrql: result.nrql,
      warnings: result.warnings,
    };
  });
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- translateWidgets`
Expected: PASS (3 tests). If the placeholder test's SPL `| nonsensecommand foo bar` actually translates (no error), swap it for a construct the translator genuinely rejects — run `node packages/nr-query-bridge/bin/spl2nrql.js "| nonsensecommand foo bar"` and confirm it prints an `error:`/`unsupported:` line and no NRQL; if it unexpectedly succeeds, pick another rejected construct and update the fixture SPL in the test.

- [ ] **Step 5: Confirm regression coverage on the placeholder branch**

Manual red: change `const failed = ...` to `const failed = false`, re-run — the placeholder test must fail (the bad widget would be treated as clean). Restore, green.

- [ ] **Step 6: Add AI-DEV markers and commit**

```bash
git add packages/nr-dashboard-importer/src/translateWidgets.js packages/nr-dashboard-importer/test/translateWidgets.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: translate widgets, placeholder untranslatable panels"
```

### Task 16: emitTerraform — dashboard resource for clean widgets

**Files:**
- Create: `packages/nr-dashboard-importer/src/emitTerraform.js`
- Test: `packages/nr-dashboard-importer/test/emitTerraform.test.js`

Emits three strings: `dashboard.tf` (the `newrelic_one_dashboard` resource), `versions.tf` (provider pin), `variables.tf` (account_id + sensitive api key + provider block). Phase-1 widget map: `line→widget_line`, `table→widget_table`, `billboard→widget_billboard`, `markdown→widget_markdown` (placeholder). Each NRQL widget block carries `nrql_query { account_id = var.account_id  query = "<nrql>" }`; markdown carries `text = "<body>"` and NO nrql_query. **AI-DEV note for the implementer: the exact `newrelic_one_dashboard` field nesting must be confirmed against the provider docs during implementation (spec Emit §). The shapes below are the spec's known-good Phase-1 subset; if the provider schema differs, fix the emitter to match the provider, not the test to match a guess.**

- [ ] **Step 1: Write the failing test**

`packages/nr-dashboard-importer/test/emitTerraform.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { emitTerraform } from '../src/emitTerraform.js';

const model = {
  title: 'Web Health',
  description: 'desc',
  widgets: [
    { title: 'Reqs', vizType: 'line', outcome: 'clean', nrql: 'FROM Log SELECT count(*)', warnings: [], layout: { x: 0, y: 0, w: 6, h: 3 } },
    { title: 'Note', vizType: 'markdown', outcome: 'placeholder', placeholderText: '### Note\nbad panel', warnings: [], layout: { x: 6, y: 0, w: 6, h: 3 } },
  ],
};

describe('emitTerraform — file set', () => {
  it('returns dashboard.tf, versions.tf, and variables.tf', () => {
    const files = emitTerraform(model, { accountId: null });
    expect(Object.keys(files).sort()).toEqual(['dashboard.tf', 'variables.tf', 'versions.tf']);
  });
});

describe('emitTerraform — dashboard.tf', () => {
  it('emits a newrelic_one_dashboard resource with the dashboard name', () => {
    const { 'dashboard.tf': tf } = emitTerraform(model, { accountId: null });
    expect(tf).toContain('resource "newrelic_one_dashboard"');
    expect(tf).toContain('name = "Web Health"');
  });

  it('emits a widget_line with an nrql_query carrying account_id and the NRQL', () => {
    const { 'dashboard.tf': tf } = emitTerraform(model, { accountId: null });
    expect(tf).toContain('widget_line {');
    expect(tf).toContain('account_id = var.account_id');
    expect(tf).toContain('query      = "FROM Log SELECT count(*)"');
  });

  it('emits a widget_markdown with text and NO nrql_query for placeholders', () => {
    const { 'dashboard.tf': tf } = emitTerraform(model, { accountId: null });
    const markdownBlock = tf.slice(tf.indexOf('widget_markdown {'));
    expect(markdownBlock).toContain('text =');
    expect(markdownBlock.slice(0, markdownBlock.indexOf('}'))).not.toContain('nrql_query');
  });

  it('bakes a literal account_id when provided', () => {
    const { 'dashboard.tf': tf } = emitTerraform(model, { accountId: 12345 });
    expect(tf).toContain('account_id = 12345');
    expect(tf).not.toContain('account_id = var.account_id');
  });
});

describe('emitTerraform — versions.tf and variables.tf', () => {
  it('pins the newrelic provider in versions.tf', () => {
    const { 'versions.tf': v } = emitTerraform(model, { accountId: null });
    expect(v).toContain('newrelic/newrelic');
    expect(v).toContain('required_providers');
  });

  it('declares a sensitive api key var and NO literal key in variables.tf', () => {
    const { 'variables.tf': vars } = emitTerraform(model, { accountId: null });
    expect(vars).toContain('variable "newrelic_api_key"');
    expect(vars).toContain('sensitive = true');
    expect(vars).toContain('variable "account_id"');
    expect(vars).toContain('provider "newrelic"');
    expect(vars).not.toMatch(/NRAK-/); // never a literal key
  });

  it('emits no backend block (state config is the user\\'s)', () => {
    const files = emitTerraform(model, { accountId: null });
    for (const tf of Object.values(files)) {
      expect(tf).not.toContain('backend "');
    }
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- emitTerraform`
Expected: FAIL — module not found.

- [ ] **Step 3: Write emitTerraform.js**

`packages/nr-dashboard-importer/src/emitTerraform.js`:

```javascript
/**
 * Emit a runnable Terraform skeleton for a translated dashboard model.
 * Three files: dashboard.tf (resource), versions.tf (provider pin),
 * variables.tf (account_id + sensitive key + provider block). NO backend
 * block — state config is environment-specific and belongs to the user.
 *
 * @typedef {import('./model.js').VizType} VizType
 */

/** neutral vizType → Terraform widget block name (Phase-1 subset). */
const WIDGET_BLOCK = {
  line: 'widget_line',
  table: 'widget_table',
  billboard: 'widget_billboard',
  markdown: 'widget_markdown',
};

/** Escape a string for an HCL double-quoted literal. */
function hclString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Render the account_id line — literal when given, else the variable reference. */
function accountIdLine(accountId) {
  return accountId === null || accountId === undefined
    ? 'account_id = var.account_id'
    : `account_id = ${accountId}`;
}

/** Render one widget block. */
function widgetBlock(widget, accountId) {
  const block = WIDGET_BLOCK[widget.vizType] ?? 'widget_markdown';
  const lines = [];
  lines.push(`  ${block} {`);
  lines.push(`    title  = "${hclString(widget.title)}"`);
  lines.push(`    row    = ${widget.layout.y + 1}`);
  lines.push(`    column = ${widget.layout.x + 1}`);
  lines.push(`    width  = ${widget.layout.w}`);
  lines.push(`    height = ${widget.layout.h}`);
  if (widget.vizType === 'markdown') {
    lines.push(`    text = "${hclString(widget.placeholderText)}"`);
  } else {
    lines.push(`    nrql_query {`);
    lines.push(`      ${accountIdLine(accountId)}`);
    lines.push(`      query      = "${hclString(widget.nrql)}"`);
    lines.push(`    }`);
  }
  lines.push(`  }`);
  return lines.join('\n');
}

/** Stable, lowercase, hyphenated slug for resource labels and filenames. */
export function slugify(title) {
  return (
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'dashboard'
  );
}

/**
 * @param {{title:string, description:string, widgets:any[]}} model
 * @param {{accountId:number|null}} opts
 * @returns {{'dashboard.tf':string, 'versions.tf':string, 'variables.tf':string}}
 */
export function emitTerraform(model, opts) {
  const accountId = opts?.accountId ?? null;
  const slug = slugify(model.title);

  const widgetBlocks = model.widgets.map((w) => widgetBlock(w, accountId)).join('\n\n');
  const dashboardTf = [
    `resource "newrelic_one_dashboard" "${slug}" {`,
    `  name        = "${hclString(model.title)}"`,
    `  description = "${hclString(model.description)}"`,
    ``,
    `  page {`,
    `    name = "${hclString(model.title)}"`,
    ``,
    widgetBlocks,
    `  }`,
    `}`,
    ``,
  ].join('\n');

  const versionsTf = [
    `terraform {`,
    `  required_providers {`,
    `    newrelic = {`,
    `      source  = "newrelic/newrelic"`,
    `      version = "~> 3"`,
    `    }`,
    `  }`,
    `}`,
    ``,
  ].join('\n');

  const variablesTf = [
    `variable "account_id" {`,
    `  type        = number`,
    `  description = "New Relic account ID."`,
    `}`,
    ``,
    `variable "newrelic_api_key" {`,
    `  type        = string`,
    `  sensitive   = true`,
    `  description = "New Relic User API key. Provide via TF_VAR_newrelic_api_key / NEW_RELIC_API_KEY env — never a literal value here."`,
    `}`,
    ``,
    `provider "newrelic" {`,
    `  account_id = var.account_id`,
    `  api_key    = var.newrelic_api_key`,
    `  region     = "US"`,
    `}`,
    ``,
  ].join('\n');

  return { 'dashboard.tf': dashboardTf, 'versions.tf': versionsTf, 'variables.tf': variablesTf };
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- emitTerraform`
Expected: PASS (8 tests). If the `query      =` alignment in the test differs from the emitter's spacing, make them match (the emitter is the source of truth for whitespace; adjust the test's expected substring to the emitter's actual output rather than fighting alignment).

- [ ] **Step 5: Confirm regression coverage on the markdown/nrql fork**

Manual red: in `widgetBlock`, change `if (widget.vizType === 'markdown')` to `if (false)` — the "markdown has no nrql_query" test must fail (placeholder would emit an nrql_query with `undefined`). Restore, green.

- [ ] **Step 6: Add AI-DEV markers and commit**

```bash
git add packages/nr-dashboard-importer/src/emitTerraform.js packages/nr-dashboard-importer/test/emitTerraform.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: emit terraform skeleton from dashboard model"
```

### Task 17: Verify emitted HCL parses with terraform (optional, graceful skip)

**Files:**
- Modify: `packages/nr-dashboard-importer/test/emitTerraform.test.js` (add a guarded integration check)

`terraform validate` confirms HCL syntax (not semantics — that is honest and stated in the report). Skip gracefully when the binary is absent so CI without terraform still passes.

- [ ] **Step 1: Add a terraform-guarded test**

Append to `emitTerraform.test.js`:

```javascript
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function hasTerraform() {
  try {
    execFileSync('terraform', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('emitTerraform — terraform validate (integration)', () => {
  it.skipIf(!hasTerraform())('emitted HCL passes terraform validate', () => {
    const files = emitTerraform(model, { accountId: 12345 });
    const dir = mkdtempSync(join(tmpdir(), 'tf-emit-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    execFileSync('terraform', ['init', '-backend=false', '-input=false'], { cwd: dir, stdio: 'ignore' });
    execFileSync('terraform', ['validate'], { cwd: dir, stdio: 'pipe' });
    expect(existsSync(join(dir, 'dashboard.tf'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- emitTerraform`
Expected: if terraform is installed, the validate test runs and passes (the provider downloads on init); if not, it is skipped (shown as skipped, not failed). If `terraform validate` reports a schema mismatch (e.g. a field name the provider rejects), FIX the emitter to match the real provider schema and re-run — this is the task where the `[assumed]` field nesting gets confirmed against reality.

- [ ] **Step 3: Commit**

```bash
git add packages/nr-dashboard-importer/test/emitTerraform.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "test: validate emitted terraform when binary present"
```

---

### Task 18: report — per-dashboard coverage summary

**Files:**
- Create: `packages/nr-dashboard-importer/src/report.js`
- Test: `packages/nr-dashboard-importer/test/report.test.js`

A markdown coverage report: N widgets, M clean, K warned, J placeholders with reasons. The honest "valid .tf ≠ working dashboard" caveat is stated in the report (spec Risks).

- [ ] **Step 1: Write the failing test**

`packages/nr-dashboard-importer/test/report.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { buildReport } from '../src/report.js';

const translated = [
  { title: 'A', outcome: 'clean', warnings: [] },
  { title: 'B', outcome: 'clean', warnings: ['precision loss on foo'] },
  { title: 'C', outcome: 'placeholder', placeholderText: 'reason: unsupported xyz', warnings: [] },
];

describe('buildReport', () => {
  it('counts clean, warned, and placeholder widgets', () => {
    const md = buildReport('Web Health', translated);
    expect(md).toContain('Web Health');
    expect(md).toContain('3 widgets');
    expect(md).toContain('2 clean'); // A and B both translated
    expect(md).toContain('1 warned'); // B carries a warning
    expect(md).toContain('1 placeholder'); // C
  });

  it('lists each placeholder with its title', () => {
    const md = buildReport('Web Health', translated);
    expect(md).toContain('C');
  });

  it('states the validate-is-syntax-only caveat', () => {
    const md = buildReport('Web Health', translated);
    expect(md).toMatch(/valid.*does not.*working|syntax.*not.*semantic/i);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- report`
Expected: FAIL — module not found.

- [ ] **Step 3: Write report.js**

`packages/nr-dashboard-importer/src/report.js`:

```javascript
/**
 * Build a per-dashboard coverage report (markdown). Counts clean/warned/
 * placeholder widgets and lists placeholder reasons. States the honest caveat
 * that emitted HCL is syntactically valid, not a guaranteed-working dashboard.
 *
 * @param {string} title
 * @param {{title:string, outcome:'clean'|'placeholder', warnings:string[], placeholderText?:string}[]} translated
 * @returns {string}
 */
export function buildReport(title, translated) {
  const total = translated.length;
  const placeholders = translated.filter((w) => w.outcome === 'placeholder');
  const clean = translated.filter((w) => w.outcome === 'clean');
  const warned = clean.filter((w) => w.warnings.length > 0);

  let md = `# Import report: ${title}\n\n`;
  md += `${total} widgets — ${clean.length} clean, ${warned.length} warned, ${placeholders.length} placeholder.\n\n`;

  if (warned.length > 0) {
    md += `## Warnings\n\n`;
    for (const w of warned) {
      md += `- **${w.title}**: ${w.warnings.join('; ')}\n`;
    }
    md += `\n`;
  }

  if (placeholders.length > 0) {
    md += `## Placeholders (could not translate)\n\n`;
    for (const w of placeholders) {
      md += `- **${w.title}**\n`;
    }
    md += `\n`;
  }

  md += `---\n\n`;
  md += `_Note: emitted Terraform is syntactically valid HCL; this does not guarantee a working New Relic dashboard. Widget NRQL correctness is proven separately (the deferred validation phase). Review placeholders and warnings before applying._\n`;

  return md;
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- report`
Expected: PASS (3 tests).

- [ ] **Step 5: Confirm regression coverage on the warned count**

Manual red: change `clean.filter((w) => w.warnings.length > 0)` to `clean.filter(() => false)`, re-run — the "1 warned" assertion must fail. Restore, green.

- [ ] **Step 6: Add AI-DEV markers and commit**

```bash
git add packages/nr-dashboard-importer/src/report.js packages/nr-dashboard-importer/test/report.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: build per-dashboard coverage report"
```

### Task 19: CLI — wire the pipeline end to end

**Files:**
- Create: `packages/nr-dashboard-importer/bin/spl-dashboard.js`
- Test: `packages/nr-dashboard-importer/test/cli.test.js`

The bin: read a file (or stdin) → `detectFormat` → `parseSimpleXml` → `translateWidgets` → `emitTerraform` → write `<slug>.tf`/`versions.tf`/`variables.tf` + `<slug>.report.md` to `--out` (default `.`). `--account <id>` bakes the literal account_id. Mirrors the translator bin's stderr/exit conventions. Pure pipeline lives in an exported `runImport()` so the test drives it without spawning a process.

- [ ] **Step 1: Write the failing test**

`packages/nr-dashboard-importer/test/cli.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { runImport } from '../bin/spl-dashboard.js';

const xml = `<form><label>CLI Dash</label><row><panel><chart>
  <title>T</title><search><query>index=web | stats count</query></search>
  <option name="charting.chart">line</option>
</chart></panel></row></form>`;

describe('runImport', () => {
  it('produces the three tf files and a report keyed by slug', () => {
    const out = runImport(xml, { account: null });
    expect(out.files['versions.tf']).toContain('newrelic/newrelic');
    expect(out.files['variables.tf']).toContain('variable "account_id"');
    expect(out.files['cli-dash.tf']).toContain('newrelic_one_dashboard');
    expect(out.files['cli-dash.report.md']).toContain('1 widgets');
    expect(out.slug).toBe('cli-dash');
  });

  it('bakes the account id when --account is given', () => {
    const out = runImport(xml, { account: 999 });
    expect(out.files['cli-dash.tf']).toContain('account_id = 999');
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- cli`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the bin**

`packages/nr-dashboard-importer/bin/spl-dashboard.js`:

```javascript
#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectFormat } from '../src/detectFormat.js';
import { parseSimpleXml } from '../src/parseSimpleXml.js';
import { translateWidgets } from '../src/translateWidgets.js';
import { emitTerraform, slugify } from '../src/emitTerraform.js';
import { buildReport } from '../src/report.js';

const usage = `Usage:
  spl-dashboard <file.xml>              translate a Splunk Simple XML dashboard to Terraform
  cat dash.xml | spl-dashboard          read from stdin
  spl-dashboard <file.xml> --out ./dir  output directory (default: .)
  spl-dashboard <file.xml> --account 12345  bake a literal account_id`;

/**
 * Pure pipeline: XML string → { slug, files }. No file I/O — testable directly.
 * @param {string} xml
 * @param {{account:number|null}} opts
 * @returns {{slug:string, files:Record<string,string>}}
 */
export function runImport(xml, opts) {
  detectFormat(xml); // Phase 1: throws loudly for non-simple-xml
  const model = parseSimpleXml(xml);
  const translated = translateWidgets(model.widgets);
  const emitModel = { ...model, widgets: translated };
  const tf = emitTerraform(emitModel, { accountId: opts.account });
  const slug = slugify(model.title);
  const report = buildReport(model.title, translated);
  return {
    slug,
    files: {
      [`${slug}.tf`]: tf['dashboard.tf'],
      'versions.tf': tf['versions.tf'],
      'variables.tf': tf['variables.tf'],
      [`${slug}.report.md`]: report,
    },
  };
}

function parseArgs(argv) {
  const opts = { out: '.', account: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--account') opts.account = Number(argv[++i]);
    else if (a === '--format') i++; // accepted, terraform-only in Phase 1
    else if (!a.startsWith('-')) opts.file = a;
  }
  return opts;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(usage);
    return;
  }
  const opts = parseArgs(argv);
  const xml = opts.file ? readFileSync(opts.file, 'utf-8') : await readStdin();
  if (!xml.trim()) {
    console.log(usage);
    return;
  }
  let out;
  try {
    out = runImport(xml, { account: opts.account });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(opts.out, { recursive: true });
  for (const [name, body] of Object.entries(out.files)) {
    const path = join(opts.out, name);
    writeFileSync(path, body);
    process.stdout.write(`${path}\n`);
  }
}

// Only run main when invoked as a script, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('spl-dashboard.js')) {
  main();
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- cli`
Expected: PASS (2 tests).

- [ ] **Step 5: Confirm regression coverage on slug-keyed filenames**

Manual red: change the runImport return key `[`${slug}.tf`]` to a fixed `'dashboard.tf'`, re-run — the `cli-dash.tf` assertion must fail. Restore, green.

- [ ] **Step 6: Add AI-DEV markers and commit**

```bash
git add packages/nr-dashboard-importer/bin/spl-dashboard.js packages/nr-dashboard-importer/test/cli.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "feat: wire spl-dashboard cli end to end"
```

### Task 20: End-to-end fixture test on a real (de-identified) dashboard

**Files:**
- Create: `packages/nr-dashboard-importer/test/fixtures/realistic-deidentified.xml`
- Test: `packages/nr-dashboard-importer/test/e2e.test.js`

The spec's Phase-1 exit wants one real (de-identified) Simple XML file driven end to end. Build a realistic multi-row dashboard from a REDACTED corpus view (`../nr-query-bridge-corpus/sources/REDACTED/`) **with all customer index/host/app names scrubbed** before committing. If you cannot access the corpus, hand-author a realistic synthetic one (multiple rows, line + table + single, generic field names).

- [ ] **Step 1: Create the de-identified fixture**

`packages/nr-dashboard-importer/test/fixtures/realistic-deidentified.xml` — a multi-row dashboard. Scrub every real index/host/sourcetype/app name to generic placeholders (`index=app_logs`, `host=node-1`, `sourcetype=access`). Example shape:

```xml
<form>
  <label>Service Overview</label>
  <description>De-identified sample for importer e2e test.</description>
  <row>
    <panel>
      <chart>
        <title>Request rate</title>
        <search><query>index=app_logs | timechart count by status</query></search>
        <option name="charting.chart">line</option>
      </chart>
    </panel>
    <panel>
      <single>
        <title>Total errors</title>
        <search><query>index=app_logs status>=500 | stats count</query></search>
      </single>
    </panel>
  </row>
  <row>
    <panel>
      <table>
        <title>Top endpoints</title>
        <search><query>index=app_logs | top uri_path</query></search>
      </table>
    </panel>
  </row>
</form>
```

**AI-DEV: Before committing this fixture, confirm it contains NO real customer index, host, app, or sourcetype names. The corpus is real REDACTED/REDACTED data; committing un-scrubbed names violates the no-customer-data rule.**

- [ ] **Step 2: Write the e2e test**

`packages/nr-dashboard-importer/test/e2e.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runImport } from '../bin/spl-dashboard.js';

const xml = readFileSync(
  new URL('./fixtures/realistic-deidentified.xml', import.meta.url),
  'utf-8',
);

describe('end-to-end: realistic Simple XML → Terraform', () => {
  it('never throws — every dashboard produces output', () => {
    expect(() => runImport(xml, { account: 12345 })).not.toThrow();
  });

  it('emits one resource, three widgets, and a report', () => {
    const out = runImport(xml, { account: 12345 });
    const tf = out.files[`${out.slug}.tf`];
    expect(tf).toContain('resource "newrelic_one_dashboard"');
    expect((tf.match(/widget_/g) || []).length).toBe(3); // line + single + table
    expect(out.files[`${out.slug}.report.md`]).toContain('3 widgets');
  });

  it('re-running produces byte-identical output (idempotent)', () => {
    const a = runImport(xml, { account: 12345 });
    const b = runImport(xml, { account: 12345 });
    expect(a.files).toEqual(b.files);
  });

  it('contains no customer-identifying names (de-identification guard)', () => {
    const all = Object.values(runImport(xml, { account: 12345 }).files).join('\n');
    expect(all.toLowerCase()).not.toContain('REDACTED');
    expect(all.toLowerCase()).not.toContain('REDACTED');
  });
});
```

- [ ] **Step 3: Run, confirm pass**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test --workspace=@datanerd/nr-dashboard-importer -- e2e`
Expected: PASS (4 tests). The idempotency test proves the stable-filename re-run claim; the de-identification guard proves the fixture is clean.

- [ ] **Step 4: Add AI-DEV markers and commit**

```bash
git add packages/nr-dashboard-importer/test/fixtures/realistic-deidentified.xml packages/nr-dashboard-importer/test/e2e.test.js
ASDF_NODEJS_VERSION=24.14.0 git commit -m "test: end-to-end import of de-identified dashboard"
```

### Task 21: Final Phase 1 verification

**Files:** none (full-suite gate)

- [ ] **Step 1: Run the whole workspace suite**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm test`
Expected: translator suite still `681 passed | 6 skipped`; importer suite green (model, detectFormat, parseSimpleXml, translateWidgets, emitTerraform, report, cli, e2e, smoke). No failures.

- [ ] **Step 2: Lint and types across both packages**

Run: `ASDF_NODEJS_VERSION=24.14.0 npm run lint && ASDF_NODEJS_VERSION=24.14.0 npm run types:check`
Expected: both exit 0. If the importer's `checkJs` flags a JSDoc type gap, fix the annotation (do not weaken to `any` — project type-strictness rule).

- [ ] **Step 3: Manual CLI smoke against the fixture**

Run: `ASDF_NODEJS_VERSION=24.14.0 node packages/nr-dashboard-importer/bin/spl-dashboard.js packages/nr-dashboard-importer/test/fixtures/realistic-deidentified.xml --account 12345 --out ./tmp-out`
Expected: prints four output paths; `tmp-out/` holds `service-overview.tf`, `versions.tf`, `variables.tf`, `service-overview.report.md`. Inspect the `.tf` by reading it. Then clean up: `rm -rf ./tmp-out`.

- [ ] **Step 4: Confirm clean tree and stop**

Run: `git status --short`
Expected: only the (untracked) stray `nr-query-bridge.zip` if present — everything else committed. **Phase 1 done.** Do NOT push or open a PR unless the user asks.

---

## Notes for the implementer

- **`[assumed]` calls this plan rests on** (from spec Open Questions) — none are load-bearing for Phase 1 EXCEPT the Terraform widget field nesting, which Task 17 confirms against the real provider via `terraform validate`. If `terraform` is unavailable in your environment, the `.tf` is "syntactically plausible" but unconfirmed; say so, and resolve it before Phase 2.
- **Quoting trap** (`{{var}}` unquoted) does not arise in Phase 1 — there are no template variables yet (no `<fieldset>` parsing). It lands in Phase 2. Do not pre-build it.
- **Base/post-process** is Phase 2 — `baseRef` stays null throughout Phase 1; `translateWidgets` does not resolve it. A `<search base>` in a Phase-1 input would currently translate the leading-pipe fragment alone and likely become a placeholder. That is acceptable for Phase 1 (loud, not silent).
- **Do not push or open PRs.** Two commits-worth of PRs (Phase 0, then Phase 1) are the user's to initiate.
