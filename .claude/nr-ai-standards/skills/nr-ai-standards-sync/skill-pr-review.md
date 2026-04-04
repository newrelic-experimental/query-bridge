# PR Review Skill Reference

This is a reference for a project's PR review skill. It should combine the universal PR review checklist (from pr-review-checklist.md) with project-specific review criteria.

## Structure

```
.claude/skills/pr-review/SKILL.md
```

## Frontmatter

```yaml
---
name: pr-review
description: Review a pull request for quality, security, and best practices
disable-model-invocation: true
---
```

`disable-model-invocation: true` because PR review is an explicit action, not something Claude should auto-trigger.

## Content should include

1. The checklist from `rules/pr-review-checklist.md` (roles, goals, security, testing, commits, AI-specific, failure thinking)
2. Project-specific review criteria (architecture patterns, framework conventions, performance concerns)
3. From the failure-thinking checklist, keep only the categories that apply to this project's stack. Drop categories that don't apply (e.g., drop 'CLI scripts' and 'database' for a frontend app; keep 'network' and 'edge cases').
4. Common anti-patterns specific to this codebase
5. Red flags and approval/rejection criteria
