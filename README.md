# nr-ai-standards

Shared standards for LLM-assisted development at New Relic.

## Installation

```bash
# 1. Add as a git subtree
git subtree add --prefix .claude/nr-ai-standards \
  git@source.<GHE_DOMAIN>:ai-cop/nr-ai-standards.git master --squash

# 2. Bootstrap the sync skill
mkdir -p .claude/skills
ln -s ../nr-ai-standards/skills/nr-ai-standards-sync \
  .claude/skills/nr-ai-standards-sync

# 3. Open Claude Code and run:
#    /nr-ai-standards-sync
```

The sync skill discovers your project's stack, creates symlinks, generates override files for customization, and builds project-specific skills (pr-review, quality-check, reflect) tailored to your codebase.

## Updating

Run `/nr-ai-standards-sync` from inside the project. It pulls subtree updates, diffs against your overrides, and flags new conflicts. Your customizations are preserved.

## What You Get

| Category | Contents | How it's exposed |
|---|---|---|
| **Rules** | testing, security, CLI safety, AI-DEV notes, engineering standards, PR review checklist, naming conventions, LLM test verification | Directory-level symlink from `.claude/rules/nr-ai-standards` into the subtree |
| **Skills** | `nr-ai-standards-sync` (integration/updates), plus project-specific `pr-review`, `quality-check`, `reflect` generated during setup | Symlinked or generated into `.claude/skills/` |
| **Output styles** | Learning modes for engineers at different levels | Copied to `.claude/output-styles/` |

## How It Works

`git subtree` vendors this repo into `.claude/nr-ai-standards/` inside your project. The sync skill creates directory-level symlinks so Claude Code picks up rules and skills automatically:

```
.claude/
  nr-ai-standards/          # subtree (vendored copy of this repo)
  rules/
    nr-ai-standards -> ../nr-ai-standards/rules   # symlink
  skills/
    nr-ai-standards-sync -> ../nr-ai-standards/skills/nr-ai-standards-sync  # symlink
    pr-review/              # generated, project-specific
    quality-check/          # generated, project-specific
  output-styles/            # copied from subtree
```

Project-specific overrides live alongside the symlinked standards. The subtree is read-only in your project; customizations go in override files.

## Overriding Standards

The sync skill generates override files for each rule category. To customize a standard for your project, add an `## Overrides` section to the relevant override file. The sync skill respects these during updates and will flag conflicts when upstream changes touch overridden areas.

## What the Standards Cover

- **Testing** -- Unit vs integration, when to use each, how to stop LLMs from "fixing" tests after they break code
- **Security** -- Preventing hallucinated libraries, secret leaks, PII in logs
- **CLI Safety** -- What should and shouldn't be auto-approved in AI coding tools
- **AI-DEV Notes** -- `// AI-DEV:` comments that LLMs must read and obey
- **Engineering Standards** -- Export of NR's STAN Confluence standards for offline LLM access
- **PR Review** -- Checklist including AI-specific items (hallucinated imports, AI-DEV marker preservation)
- **Naming Conventions** -- Constrained verb vocabulary for functions and variables
- **LLM Test Verification** -- Expanded red-green-refactor with confirmation cycle

## Contributing

1. Clone this repo and run `git config core.hooksPath .githooks`
2. Edit rule files in `rules/`, skill files in `skills/`, or output styles in `output-styles/`
3. Run `bash scripts/add-markers.sh` to refresh AI-DEV markers on rule files
4. Update `VERSION` and `CHANGELOG.md`
5. Submit a PR

Once merged, teams pick up changes next time they run `/nr-ai-standards-sync`.

## Pre-commit Hook

The repo includes a pre-commit hook (in `.githooks/`) that blocks commits missing VERSION or CHANGELOG.md updates. Enable it with:

```bash
git config core.hooksPath .githooks
```
