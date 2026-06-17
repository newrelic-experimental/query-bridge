# Open-Source Readiness: OSS Scaffolding + CI Migration

**Date:** 2026-06-16
**Status:** Tiers A–C executed 2026-06-17 (PR #34); runbook (Phase 3–4) and importer-package files outstanding — see the plan's "Execution status" section.

## Context

nr-query-bridge is being open-sourced to `github.com/newrelic-experimental/nr-query-bridge`
(experimental org; can be promoted to the main `newrelic` org later). Two prerequisite efforts
bracket this one:

- **Customer-data scrub** (`docs/superpowers/specs/2026-06-02-open-source-scrub-design.md`) —
  Phase A (tree scrub + corpus relocation) and Phase B (history rewrite) are both complete. That spec
  explicitly deferred "Phase 3 — OSS scaffolding" to a separate spec. **This is that spec.**
- **Monorepo migration** (`docs/superpowers/plans/2026-06-16-dashboard-importer-phase-0-1.md`) —
  converts the flat repo into npm workspaces: `packages/nr-query-bridge` (the zero-dep translator)
  and `packages/nr-dashboard-importer` (carries a real runtime dep, `fast-xml-parser`). This spec
  assumes the **post-monorepo** layout.

The repo currently lives on internal GHE (`source.datanerd.us:logging/nr-query-bridge`) and has
not yet been pushed to github.com.

## Decisions (locked with user, 2026-06-16)

- **Target:** `newrelic-experimental` first; promote to `newrelic` later.
- **Published surface:** the whole monorepo goes public, and **both** packages publish to npm —
  so each published package needs its own README, LICENSE, and THIRD_PARTY_NOTICES.
- **Scrub docs:** the 2026-06-02 scrub spec/plan are left as historical records of Phase A against
  the flat layout; only their org references were corrected.

## Scope

**In scope** (built across the phases below):
- Open-source compliance files for a newrelic-experimental repo — at the monorepo root and per
  published package.
- Migrating CI off `grandcentral.yml` onto GitHub Actions (workspace-aware).
- GitHub repo settings OSPO requires, including **secret scanning + push protection**.

**Out of scope:**
- The customer-data scrub and history rewrite (its own spec — both phases now complete).
- The importer's feature work (its own plan).
- Promotion from `newrelic-experimental` to `newrelic`.

## The newrelic-experimental repo pattern

Verified against `newrelic-experimental/java-instrumentation-template` (the actively-maintained
`is_template` repo, updated 2026-05-11) on 2026-06-16. Its language-agnostic scaffolding vs. what
nr-query-bridge has today:

| File | Present today | Notes |
|---|---|---|
| `LICENSE` (Apache-2.0) | yes (root) | per-package copies needed for npm |
| `README.md` | yes (root) | needs NR Experimental disclaimer header + Support section; per-package READMEs for npm |
| `CONTRIBUTING.md` | missing | standard NR text |
| `CODE_OF_CONDUCT.md` | (none) | **must stay absent** — repolinter errors on a local CoC; it's centralized in `newrelic/.github` |
| `SECURITY.md` | missing | standard NR vuln-reporting text |
| `cla.md` | missing | NR contributor license agreement |
| `CHANGELOG.md` (+ workflow `.tpl`) | missing | drives the release workflow |
| `THIRD_PARTY_NOTICES.md` | missing | near-empty for translator; real for importer (`fast-xml-parser`) |
| `.github/ISSUE_TEMPLATE/{bug_report,enhancement}.md` | missing | |
| `.github/workflows/repolinter.yml` | missing | **enforces** the files above |
| `.github/dependabot.yml` | yes | repoint to public npm; add a per-package ecosystem entry each |
| `.github/pull_request_template.md` | yes | keep |

**Enforced vs. convention.** The automated gate is `newrelic/repolinter-action` against the
`new-relic-experimental` ruleset
(`https://raw.githubusercontent.com/newrelic/.github/main/repolinter-rulesets/new-relic-experimental.yml`,
read 2026-06-16). It *errors* on only: a LICENSE; a README that **starts with** the experimental
`<picture>` banner snippet and **contains** a `../../security/policy` link; and the **absence** of a
local `CODE_OF_CONDUCT` (centralized in `newrelic/.github`). It *warns* on a missing
`THIRD_PARTY_NOTICES`. Everything else in the table (`CONTRIBUTING.md`, `cla.md`, `SECURITY.md`,
issue templates, `CHANGELOG.md`) is NR-template convention the OSPO release checklist expects but
repolinter does not block on — a recommended second tier, not a hard gate.

## Approach

### Phase 1 — Compliance files (monorepo-aware)

**Root (shared):** `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (link to NR org-level CoC), `SECURITY.md`,
`cla.md`, `CHANGELOG.md`, `.github/ISSUE_TEMPLATE/`, and the NR Experimental disclaimer header on the
root `README.md`.

**Per published package** (`packages/nr-query-bridge`, `packages/nr-dashboard-importer`): a `LICENSE`
copy, a package `README.md`, `THIRD_PARTY_NOTICES.md`, and `package.json` publish metadata
(`repository.directory`, `files`, `publishConfig`).

THIRD_PARTY_NOTICES generation: the translator's is near-empty (zero runtime deps); the importer's
must enumerate `fast-xml-parser` and its transitive licenses. Generate it with NR's OSS notices
tooling rather than hand-maintaining (exact tool/Action — open question 1).

### Phase 2 — CI off Grand Central → GitHub Actions

Replace `grandcentral.yml` `test_suites` with `.github/workflows/ci.yml`: Node 24, `npm ci`, then
`npm run lint && npm run types:check && npm test` — the root scripts already fan out across
workspaces per the monorepo plan. Add `repolinter.yml` and a CodeQL (JavaScript) workflow, and wire
the third-party-notices check. GitHub Actions **do not run on internal GHE** (`source.datanerd.us`) — confirmed 2026-06-16. So the
workflows are authored in the monorepo now but stay **dormant on the internal repo**, where
`grandcentral.yml` remains the PR gate. They first execute on the public github.com repo; once green
there, they replace `grandcentral.yml` + `Dockerfile.gc`. `grandcentral.yml` is therefore retired as
part of the public push, not before.

### Phase 3 — GitHub repo settings (admin / OSPO)

Repo settings, not committable files — they run at/after public repo creation and need admin:
- **Secret scanning + push protection** (the OSPO requirement). UI: Settings → *Code security and
  analysis*. API: `PATCH /repos/{org}/{repo}` with
  `security_and_analysis.{secret_scanning,secret_scanning_push_protection}.status = enabled`
  (verify field names against current GitHub docs before scripting).
- Branch protection on the default branch (require PR review + green checks).
- CodeQL + Dependabot alerts enabled; topics + description set; `is_template: false`.

### Phase 4 — Publish

The scrub spec's **Phase B** (history rewrite) is complete. Push the monorepo to
`github.com/newrelic-experimental/nr-query-bridge`, confirm repolinter is green, then publish both
packages to npm under the `@newrelic/` scope (see npm naming below). Use `npm pack` / `git archive` for
any pre-publish inspection — never hand-zip (sweeps in `node_modules`, `.git`, gitignored
`docs/local/`).

## npm naming (recommended)

Both packages publish under the shared **`@newrelic/`** scope — NR's established public npm scope
(e.g. `@newrelic/publish-sourcemap`), verified live 2026-06-16. Idiomatic Node practice puts the org
in the scope and the thing in the name, so the redundant `nr-` prefix is dropped:

| Package dir | npm name |
|---|---|
| `packages/nr-query-bridge` | `@newrelic/query-bridge` |
| `packages/nr-dashboard-importer` | `@newrelic/dashboard-importer` |

An npm `name` need not match the directory or the GitHub repo name — that's normal and common. The
current `@datanerd/nr-query-bridge` is an internal scope, not the public name. Publishing under
`@newrelic/` needs npm publish access to that scope, which OSPO grants (same thread as open question
1). Fallback if `@newrelic/` access isn't granted to an experimental project: unscoped public names
(`nr-query-bridge` — verified available — and `nr-dashboard-importer`), which work but lack a
namespace.

## Critical files

- **New (root):** `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `cla.md`, `CHANGELOG.md`,
  `.github/ISSUE_TEMPLATE/{bug_report,enhancement}.md`, `.github/workflows/{ci,repolinter,codeql}.yml`.
- **New (each published package):** `LICENSE`, `README.md`, `THIRD_PARTY_NOTICES.md`.
- **Modified:** root `README.md` (NR Experimental header), `.github/dependabot.yml` (public npm +
  per-package ecosystems), `grandcentral.yml` (removed after GHA proven), the two `package.json`
  files (publish metadata).

## Verification

- `repolinter.yml` passes on a PR.
- GHA CI green: lint + types + the translator's 681-test suite + the importer suite, on Node 24.
- `npm pack` for each package contains only intended files (no `docs/local/`, no `node_modules`).
- Secret scanning + push protection show enabled in repo settings.
- Root `README.md` renders the NR Experimental disclaimer.

## Open questions

1. **Resolved 2026-06-16 (via the `new-relic-experimental` repolinter ruleset):** notices are
   generated with `newrelic/newrelic-oss-cli` for JS; `newrelic-experimental` does **not** mandate
   FOSSA-as-a-GHA — the ruleset's only third-party check is a *warning*-level `THIRD_PARTY_NOTICES`
   existence rule. **Still for Emily/OSPO:** `@newrelic/` npm publish access for an experimental repo.
2. **Resolved 2026-06-16:** GitHub Actions do not run on internal GHE — GHA workflows are authored
   but dormant until the public push; `grandcentral.yml` stays the internal gate (see Phase 2).
3. **Recommended 2026-06-16:** npm names settled to `@newrelic/query-bridge` +
   `@newrelic/dashboard-importer` (see npm naming) — pending the OSPO scope-access grant in item 1.

## Sequencing

Phase 1 (files) and Phase 2 (GHA workflows) can land on the internal repo right after the monorepo
migration. Phase 3 (settings) and Phase 4 (publish) happen at/after public repo creation, and the
public push is gated on OSPO approval (the scrub spec's Phase B is complete).
