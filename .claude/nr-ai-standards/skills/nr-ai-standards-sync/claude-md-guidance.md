# CLAUDE.md Reference

This is a reference for what a well-structured CLAUDE.md looks like. When integrating standards into a project, use this as a starting point and adapt it to the project's actual stack, commands, and conventions.

CLAUDE.md should be under 200 lines. If it grows beyond that, split content into `.claude/rules/` files or use `@path` imports. See https://docs.anthropic.com/en/docs/claude-code/memory for details.

## Structure

```markdown
# CLAUDE.md

## Project Overview
<!-- What this project does, key technologies, architecture in 2-3 sentences -->

## Important paths / starting points
<!--
List of:
* Where to find build, lint, test commands. Usually @README.md.
* Where to find style guidances. Usually @.eslintrc or similar.
* Where to find internal documentation, wikis, runbooks about this project or ecosystem.
* Where to find debugging guidance for common problems. Usually @.claude/rules/debugging.md.
-->
```

## Key Principles

- Information in CLAUDE.md should _not_ change over time; it should be timeless.
  + No debugging information. No reports about what we just did. No plans. No task lists.
- Be specific and concrete: "Use 2-space indentation" not "Format code properly"
- Optimize CLAUDE.md for machine parsing, not human readability. README.md serves both humans and LLMs.
- If a section would exceed 30 lines, move it to a `.claude/rules/` file and add an `@path` import in CLAUDE.md pointing to that file (e.g., `@.claude/rules/testing.md`)
