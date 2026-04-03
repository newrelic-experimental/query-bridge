# Changelog

## 2.0.4

- Fix: use per-skill symlinks instead of directory symlink for skills. Claude Code discovers skills at `.claude/skills/<name>/SKILL.md` (one level deep), not from nested directories.
- Fix: `create-symlinks.sh` now detects and preserves bootstrap directory symlinks gracefully.
- Fix: `gather-project-context.sh` now includes symlinks in output (was silently skipping them with `-type f`). Added `-P` flag to prevent following directory symlinks into the subtree.
- Fix: stale path `references/pr-review-checklist.md` → `rules/pr-review-checklist.md` in skill-pr-review.md.
- Fix: SKILL.md now accurately describes per-file symlinks for skills (was describing directory symlinks).
- Fix: AI-DEV marker moved after YAML frontmatter in SKILL.md (was before it, which could break frontmatter parsing).
- Fix: first-run detection now checks for rules symlink (not just version file). Version file still used for changelog diffing during updates.
- Fix: clarified migration "extraction" step — move project-specific paragraphs into override file, delete old copy.
- Add `.claude/settings.local.json` back to `.gitignore`.
- Add anti-bypass paragraph to `cli-safety.md` (do not wrap denied commands in bash scripts).

## 2.0.0

**Breaking change: repo restructured for subtree-based distribution.**

- Distributable content moved to top-level directories (`rules/`, `skills/`, `output-styles/`, `scripts/`)
- Old `.claude/` directory removed -- integration now runs from target projects, not from this repo
- New `/nr-ai-standards-sync` skill handles both first-time integration and updates
- Projects consume standards via `git subtree add` + directory-level symlinks
- AI-DEV markers added to all managed rule files to prevent LLM edits
- `create-symlinks.sh` creates symlinks: directory-level for rules (`.claude/rules/nr-ai-standards`), per-skill for skills (`.claude/skills/<name>/SKILL.md`)
- `gather-project-context.sh` captures pre-integration state for LLM analysis
- `add-markers.sh` idempotently adds AI-DEV markers to rule files
- Skill generation references (pr-review, quality-check, reflect) bundled with sync skill
- Old `/integrate-standards`, `/integrate-standards-batch`, and `/verify-integration` skills removed

## 1.6.4

- Batch skill now documents the subagent write-permission limitation. Phase 3 uses read-only analysis agents with per-project handoff instructions instead of attempting direct writes to sibling repos.
- Saved 53 permanent skips to scan config from first batch run.

## 1.6.3

- Added "Before Every Commit" section to CLAUDE.md so LLMs know to update VERSION and CHANGELOG before committing.

## 1.6.2

- Added `discover.sh` and `classify.py` scripts to `/integrate-standards-batch`. Discovery scans parent dirs for projects; classify pipes output through Python to tier candidates (recommended/maybe/probably not) based on activity, ownership, and stack. Bash wrapper avoids interpreter deny-list issues.
- Updated batch skill SKILL.md: paginated selection (max 3 projects + "None of these" per question), post-selection skip summary, permanent skip persistence in scan config.

## 1.6.1

- Fixed verify script bug: removed hardcoded filename mapping that expected `pr-review-checklist.md` to be installed as `pr-review.md`. Installed rules now use the same filename as their reference.

## 1.6.0

- New `naming-conventions.md` reference: constrained verb vocabulary for function and variable naming. Covers A/HC/LC naming structure, S-I-D principle, closed boolean prefix set (`is`/`has`/`should`/`did`/`can`), common opposites, and a core verb table (12 concepts, each with one allowed verb and a banned-synonym list). Domain-specific extension tables for HTTP/Web, Kafka/Event Streaming, Background Jobs/Workers, Data Pipelines/Compilers, and Database/Persistence.

## 1.5.0

- Expanded reference `settings.json` with comprehensive safe Bash auto-approvals (git read-only, ls, cp, echo, cat, wc, grep, find, npm run) and deny list for interpreters (python, node, ruby, sed, awk, xargs). Added NR MCP server read-only tools and additional GHE read tools.
- Integration skill now asks where the user's repos live and adds cross-repo read permissions (Read, Glob, Grep) for that path, enabling sibling repo inspection without prompts.
- Pre-commit hook now requires VERSION to be staged alongside CHANGELOG.md for non-trivial commits.
- Moved pre-commit hook from `.git/hooks/` to `.githooks/` so it's version-controlled. Contributors run `git config core.hooksPath .githooks` once after cloning.
- Added mutation testing subsection to `llm-test-verification.md` as a faster alternative to the manual remove-code-and-verify cycle (steps 5-8). Includes tool recommendations per language (PIT for Java, Stryker for JS/TS, mutant for Ruby, mutmut for Python, gremlins for Go, mutation for Elixir).
- New `/integrate-standards-batch` skill for scanning parent directories and updating multiple projects at once. Discovers already-integrated projects, assesses candidates by stack/activity/ownership, presents tiered recommendations, fans out parallel agents for updates, and persists skip decisions in a local config file.
- `/integrate-standards` now offers to install universal rules (ai-dev, cli-safety, security, llm-test-verification, engineering-standards, pr-review-checklist) in `~/.claude/rules/` so they apply to all repos. First-time users get the offer after project integration; returning users get stale rules updated automatically. Both skills maintain user-level rules alongside project-level ones.
- Progressive discovery: second-time `/integrate-standards` users are prompted about `/integrate-standards-batch` for bulk updates. Prompt only appears once.
- LLM clarity audit across all references, skills, and output styles (59 fixes). Resolved vague pronouns, undefined NR jargon (Relics, ER, urgent care, Upboard, SLC, Vortex), broken shell commands (xxd pipeline), ambiguous thresholds ("when possible", "major change", "or improving"), missing file paths in cross-references, contradictory instructions (skills two-pass, bot PR review rules), and undefined conditionals. Output styles updated to remove cross-file dependencies and fix overlapping thresholds.

## 1.4.0

- Added output style references: `learning-engineer.md` and `learning-senior.md`. Socratic learning modes that challenge engineers to navigate and understand codebases rather than passively accepting AI-generated fixes. Two variants: one for engineers building codebase fluency, one for senior/principal engineers maintaining connection to AI-assisted codebases.

## 1.3.0

- Exported full STAN Confluence standards into `engineering-standards.md` reference so LLMs can make correct decisions without live Confluence access. Covers Quality Standards (all sections), Secrets & Credentials (with explicit LLM guidance), Encryption, Code Review/Sidekick, Code Scanning, API Standards, Observability, Build/Deploy, AI Standards, and more.
- Added `verify-integration` bash script (`verify.sh`) for fast diff-based verification instead of slow LLM line-by-line comparison. Skill now runs the script first, only uses LLM judgment for flagged files.
- Added `.claude/settings.json` with auto-approve for the verify script.
- Improved `integrate-standards` skill with explicit two-pass process (copy verbatim, then adapt) and self-check coverage report.
- Clarified red-green-refactor step 6: make exactly one test fail, not all tests.

## 1.2.0

- Integration skill now tracks version in target projects (`.claude/.nr-ai-standards-version`). On subsequent runs, it reads the CHANGELOG to understand what changed upstream and flags structural divergences (e.g., content inlined vs. split into separate files).
- Added pre-commit hook requiring CHANGELOG.md updates on non-trivial commits.

## 1.1.0

- Recommend splitting `llm-test-verification.md` into its own rule file instead of inlining it in `testing.md`. LLMs lose track of the verification steps (especially expanded red-green-refactor) when they're buried in a long testing rules file.
- Added more context to `llm-test-verification.md` reference: explanations of *why* each step matters, not just the steps themselves.

## 1.0.0

- Initial release: rules, skills, settings, and CLAUDE.md references.
- Rules: testing, llm-test-verification, ai-dev, security, cli-safety, engineering-standards, pr-review-checklist.
- Skills: pr-review, quality-check, reflect.
- Settings: conservative permission allowlist for MCP tools, read-only git, and web fetching.
