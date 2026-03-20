---
name: reflect
description: Review this session and update project knowledge with durable insights
disable-model-invocation: true
---

Review the current session and capture durable knowledge.

## Process

1. **Review the session** — What was accomplished? What was learned?

2. **Update CLAUDE.md** — Add timeless project knowledge discovered during the session:
   - CLAUDE.md is for Claude, not humans. README.md is for both.
   - Prefer `@path` imports over inline content
   - No section should exceed 30 lines — move it to `.claude/rules/` and reference it
   - Total file under 200 lines
   - Only timeless information. No debugging reports, plans, task lists, or session-specific state.
   - Be specific: "Use 2-space indentation" not "Format code properly"

3. **Create or update rules** — If a reusable standard was discovered:
   - Create a `.claude/rules/<topic>.md` file
   - Rules are always-on context, loaded every session

4. **Create or update skills** — If a reusable workflow was discovered:
   - Create a `.claude/skills/<name>/SKILL.md`
   - Skills are invocable with `/name` and can auto-trigger based on description

5. **What NOT to save**:
   - Session-specific context or temporary state
   - Information that duplicates existing CLAUDE.md content
   - Speculative conclusions from reading a single file
