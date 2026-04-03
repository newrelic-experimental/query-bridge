---
name: nr-ai-standards-sync
description: Sync nr-ai-standards into this project. First run does full integration (explore → install → adapt). Subsequent runs pull updates and flag conflicts.
---

<!-- AI-DEV: This file is managed by nr-ai-standards via git subtree. Do NOT edit directly. -->

# nr-ai-standards-sync

This skill integrates New Relic AI standards into the current project. It has two modes depending on whether the project has been integrated before.

**Detect mode:** Check for `.claude/rules/nr-ai-standards` (the rules symlink).
- Symlink missing → **First Run** (Mode 1) — full three-phase integration
- Symlink exists → **Update** (Mode 2) — pull latest, diff overrides

Also check `.claude/.nr-ai-standards-version` — this tracks which version was last installed, used during updates to diff the CHANGELOG.

---

## Mode 1: First Run

Three phases, executed in order. The phase boundaries matter — do not skip ahead.

### Phase 1: Explore

> **Critical:** Standards are NOT yet visible in `.claude/rules/`. The subtree exists at `.claude/nr-ai-standards/` but no symlinks point into it yet. You must understand the project on its own terms before seeing the standards. This prevents confirmation bias — you need to find real divergences, not rubber-stamp compliance.

**Step 1: Snapshot existing config**

Run the gather script to capture the project's current `.claude/` setup:

```bash
.claude/nr-ai-standards/scripts/gather-project-context.sh
```

Read the output. Note what rules, skills, and settings already exist.

**Step 2: Investigate the codebase**

Explore these areas — read actual files, do not guess:

- **Build config:** Look for `package.json`, `build.gradle`, `go.mod`, `Gemfile`, `mix.exs`, `pyproject.toml`, `Makefile`, `pom.xml`, `Cargo.toml`, or similar. Identify the language, framework, and build tool.
- **Test runner and quality tools:** Find the test command (`npm test`, `./gradlew test`, `go test`, `bundle exec rspec`, etc.). Check for linter config (`.eslintrc`, `rubocop.yml`, `golangci-lint`, etc.) and formatter config (Prettier, Black, gofmt, etc.).
- **Test files (read 2-3):** Look at test structure, assertion style, mocking approach, coverage configuration. Note the test framework (Jest, JUnit, RSpec, pytest, etc.).
- **Source files (read 2-3):** Look at naming conventions (camelCase vs snake_case), architecture patterns (MVC, hexagonal, etc.), module organization.
- **Security practices:** How are secrets handled? Any `.env` files, vault references, environment variable patterns? Look for SQL/query construction patterns. Check for existing security scanning config (Dependabot, CodeQL, Trivy, FOSSA).
- **CI/CD:** Check `.github/workflows/`, `Jenkinsfile`, `grandcentral.yml`, or similar for build/deploy pipeline structure.

**Step 3: Check for existing copied rules (migration detection)**

If the project already has `.claude/rules/*.md` files from a previous `/integrate-standards` run:

- Compare each existing rule file against the standards in `.claude/nr-ai-standards/rules/`.
- **Verbatim copies** (identical or near-identical to a standard): Flag these for deletion. The symlinked versions will replace them.
- **Copies with project-specific content** (standard text plus custom overrides mixed in): Flag these for conversion into override files. Identify the project-specific paragraphs, move them into a new `project-<topic>.md` override file with an Overrides section, then delete the old copy.

Tell the user what you found and ask before deleting anything.

**Step 4: Summarize findings**

Write a brief summary organized by domain:

- **Language/Stack:** e.g., "Node.js 20 / TypeScript / Express"
- **Testing:** e.g., "Jest with ts-jest, ~45% coverage, no mutation testing"
- **Security:** e.g., "Secrets via env vars, no vault integration, Dependabot enabled"
- **Naming:** e.g., "camelCase throughout, PascalCase for classes"
- **CLI/Build:** e.g., "`npm run build`, `npm test`, ESLint + Prettier"
- **Migration:** e.g., "3 existing rule files: 2 verbatim copies, 1 with custom content"

---

### Phase 2: Install

**Step 5: Create symlinks**

Run the symlink script to wire up directory-level symlinks from `.claude/rules/` and `.claude/skills/` into the subtree:

```bash
.claude/nr-ai-standards/scripts/create-symlinks.sh
```

This creates:
- `.claude/rules/nr-ai-standards` → `../nr-ai-standards/rules` (directory symlink for rules)
- `.claude/skills/nr-ai-standards-sync/SKILL.md` → `../../nr-ai-standards/skills/nr-ai-standards-sync/SKILL.md` (per-file symlink for skills)

Note: If the bootstrap symlink (directory symlink from install step 2) is still present, the script detects and preserves it.

**Step 6: Copy output styles**

Copy output styles from the subtree into the project's output styles directory:

```bash
mkdir -p .claude/output-styles
cp .claude/nr-ai-standards/output-styles/*.md .claude/output-styles/
```

If the project already has output styles with the same names, ask before overwriting.

---

### Phase 3: Adapt

Now the standards are visible via the symlinks. This is where you tailor them to the project.

**Step 7: Read the standards**

Read the rule files now visible at `.claude/rules/nr-ai-standards/`:
- `ai-dev.md`
- `cli-safety.md`
- `engineering-standards.md`
- `llm-test-verification.md`
- `naming-conventions.md`
- `pr-review-checklist.md`
- `security.md`
- `testing.md`

**Step 8: Compare and generate override files**

Compare each standard against the Phase 1 findings. For every divergence, create a project-specific override file in `.claude/rules/`. The override file format:

```markdown
# Project Testing Standards

## Overrides
These replace conflicting guidance from the universal testing standards:
- "Unit test coverage SHOULD be at least 70%" → Project target is 85% per team agreement. See JIRA-1234.
- "Integration/e2e tests SHOULD cover key workflows" → We use Cypress for e2e; integration tests use Testcontainers.

## Project Config
- Test runner: Jest with ts-jest
- Coverage tool: Istanbul via Jest --coverage
- Coverage threshold: 85% (enforced in jest.config.ts)
- Mutation testing: Not configured (consider adding Stryker)
- Test location: `__tests__/` directories colocated with source
```

Rules for override files:
- Name them descriptively: `project-testing.md`, `project-security.md`, `project-naming.md`
- Only create override files where there are actual divergences. Do not create empty override files.
- Quote the specific standard text being overridden so the conflict is explicit.
- Explain *why* the project diverges (team decision, tech constraint, etc.) when known.

**Step 9: Generate project-specific skills**

Read the reference instructions for each skill from the sibling files in this skill's directory:
- `skill-pr-review.md` — Generate a PR review skill tailored to the project
- `skill-quality-check.md` — Generate a quality check skill with the project's actual commands
- `skill-reflect.md` — Generate a reflect skill for the project

Write the generated skills to `.claude/skills/` in the project (e.g., `.claude/skills/pr-review/SKILL.md`).

**Step 10: Generate or update CLAUDE.md**

Read `claude-md-guidance.md` (sibling file in this skill's directory) for structural guidance.

- If the project has no `CLAUDE.md`: Generate one from the guidance, populated with the project's actual build commands, test commands, and conventions discovered in Phase 1.
- If the project already has a `CLAUDE.md`: Review it against the guidance. Suggest additions (missing build commands, missing conventions) but do not remove existing content without asking.

Keep CLAUDE.md under 200 lines. If it would exceed that, split content into `.claude/rules/` files.

**Step 11: Create or update settings.json**

Read `settings-reference.json` (sibling file in this skill's directory) as a starting point.

- Adapt auto-approval patterns to the project's actual tools (e.g., if the project uses `yarn` instead of `npm`, adjust accordingly).
- Add project-specific safe commands (e.g., `Bash(./gradlew test:*)` if it's a Gradle project).
- Preserve any existing settings.json entries that don't conflict.

**Step 12: Record version and report**

Write the current nr-ai-standards version to `.claude/.nr-ai-standards-version`:

```bash
cp .claude/nr-ai-standards/VERSION .claude/.nr-ai-standards-version
```

Report to the user:
- Files created (override rules, skills, CLAUDE.md, settings.json)
- Files deleted (verbatim copies replaced by symlinks)
- Files converted (existing rules turned into override files)
- Symlinks created
- Any standards that need attention (divergences the user should decide on)

---

## Mode 2: Update (Subsequent Run)

The project already has standards integrated. Pull the latest and reconcile.

**Step 1: Pull latest standards**

```bash
git subtree pull --prefix .claude/nr-ai-standards git@source.<GHE_DOMAIN>:ai-cop/nr-ai-standards.git master --squash
```

If the pull has merge conflicts, stop and tell the user. Do not auto-resolve subtree conflicts.

**Step 2: Refresh symlinks**

```bash
.claude/nr-ai-standards/scripts/create-symlinks.sh
```

This picks up any new content categories (new rule files, new skills) added upstream.

**Step 3: Read the changelog**

Read `.claude/nr-ai-standards/CHANGELOG.md`. Find the section for the currently installed version (from `.claude/.nr-ai-standards-version`) and everything above it. Summarize what changed.

**Step 4: Diff updated standards against overrides**

For each override file in `.claude/rules/project-*.md`:
- Read the override's "Overrides" section
- Check whether the quoted standard text still exists in the updated standards
- If the standard text changed, flag it: the override may need updating
- If new standards were added that weren't previously reviewed, flag those too

**Step 5: Handle new conflicts**

For any new divergences found in Step 4:
- Show the user the old standard text, the new standard text, and their current override
- Ask whether to update the override or keep it as-is

**Step 6: Copy new output styles**

Check for new output styles in `.claude/nr-ai-standards/output-styles/` that don't exist in `.claude/output-styles/`. Copy them. For existing ones, ask before overwriting.

**Step 7: Update version**

```bash
cp .claude/nr-ai-standards/VERSION .claude/.nr-ai-standards-version
```

Report what changed, what was updated, and any overrides that need human review.
