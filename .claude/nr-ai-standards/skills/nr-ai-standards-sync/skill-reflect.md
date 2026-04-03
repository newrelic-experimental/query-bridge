# Reflect Skill Reference

This is a reference for a project's reflect skill. It should guide Claude through reviewing a session and capturing durable knowledge.

## Structure

```
.claude/skills/reflect/SKILL.md
```

## Frontmatter

```yaml
---
name: reflect
description: Review this session and update project knowledge with durable insights
disable-model-invocation: true
---
```

## Content should include

Instructions to:

1. **Review the session** — What was accomplished? What was learned?

2. **Update CLAUDE.md** — Add timeless project knowledge discovered during the session:
   - CLAUDE.md is for Claude, not humans. README.md is for both.
   - Prefer `@path` imports over inline content. CLAUDE.md should mostly be pointers: "Important paths / starting points" linking to README, style configs, rules files, runbooks.
   - No section should exceed 30 lines — move it to `.claude/rules/` and reference it.
   - Total file under 200 lines.
   - Only timeless information. No debugging reports, plans, task lists, or session-specific state.
   - Be specific: "Use 2-space indentation" not "Format code properly"

3. **Create or update rules** — If a reusable standard was discovered:
   - Create a `.claude/rules/<topic>.md` file
   - Rules are always-on context, loaded every session
   - Add `paths:` frontmatter when the rule applies only to specific file extensions. Example:
     ```yaml
     ---
     paths: ["**/*.tsx", "**/*.ts"]
     ---
     ```
     Omit `paths:` when the rule applies to all files.

4. **Create or update skills** — If a reusable workflow was discovered:
   - Create a `.claude/skills/<name>/SKILL.md`
   - Skills can be invoked explicitly with `/name`. Claude also auto-invokes skills when the user's request matches the skill's `description` field — unless `disable-model-invocation: true` is set in the frontmatter.
   - Use `disable-model-invocation: true` for explicit actions (deploy, review, etc.)
   - Use `user-invocable: false` for background knowledge Claude should auto-load

5. **What NOT to save**:
   - Session-specific context or temporary state
   - Information that duplicates existing CLAUDE.md content
   - Conclusions based on a single file that might not represent the whole project (e.g., 'this project doesn't use tests' after seeing one directory without test files)

