# CLAUDE.md

## Project Overview

nr-ai-standards is a collection of shared standards for LLM-assisted development at New Relic. Projects consume it via `git subtree`, which vendors the repo into `.claude/nr-ai-standards/`. Directory-level symlinks expose rules and skills to Claude Code.

## Repo Structure

- `rules/` -- Universal rule files (testing, security, CLI safety, AI-DEV, etc.). Loaded as Claude Code rules via symlink.
- `skills/` -- Distributable skills. `nr-ai-standards-sync` handles integration and updates. Reference files for generating project-specific skills (pr-review, quality-check, reflect) live here too.
- `output-styles/` -- Output style files (copied to projects, not symlinked).
- `scripts/` -- Setup and maintenance scripts:
  - `create-symlinks.sh` -- Creates directory-level symlinks into the subtree
  - `gather-project-context.sh` -- Captures pre-integration state for LLM analysis
  - `add-markers.sh` -- Idempotently adds AI-DEV markers to rule files
- `VERSION` -- Current version of the standards
- `CHANGELOG.md` -- Release history

## How Projects Consume This Repo

1. Add as a subtree:
   ```bash
   git subtree add --prefix .claude/nr-ai-standards \
     git@source.<GHE_DOMAIN>:ai-cop/nr-ai-standards.git master --squash
   ```

2. Bootstrap the sync skill:
   ```bash
   mkdir -p .claude/skills
   ln -s ../nr-ai-standards/skills/nr-ai-standards-sync \
     .claude/skills/nr-ai-standards-sync
   ```

3. Run `/nr-ai-standards-sync` in Claude Code. It discovers your project stack, creates symlinks, generates override files and project-specific skills.

## Updating

From inside any integrated project, run `/nr-ai-standards-sync`. It pulls subtree updates, diffs against your overrides, and flags conflicts.

## Before Every Commit

Update `CHANGELOG.md` and `VERSION` before committing. The pre-commit hook enforces this -- it will block the commit if either file is missing from staging. Bump the patch version for fixes, minor for new features.

## Setup

Git hooks are in `.githooks/` (not `.git/hooks/`). After cloning, run:
```
git config core.hooksPath .githooks
```

## When Editing Rules

Rule files in `rules/` have AI-DEV markers that prevent LLMs from modifying them. After editing rules, run:
```bash
bash scripts/add-markers.sh
```
This idempotently adds or refreshes AI-DEV markers on all rule files.
