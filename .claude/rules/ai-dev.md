<!-- AI-DEV: This file is managed by nr-ai-standards via git subtree. Do NOT edit directly. To override a specific rule, ask Claude: "Override [rule name] from this file" and it will create a project-level override in .claude/rules/ -->

# AI-DEV Notes Standard

## What Are AI-DEV Notes?

AI-DEV notes are inline comments directed at LLMs that provide instructions LLMs must follow when working with code. They can appear anywhere in code. Place AI-DEV notes inside the method body they protect, not at the top of the file. LLMs process a window of surrounding code when editing a function — a note at the top of a 500-line file may be outside that window.

## Format

```
// AI-DEV: <instruction>
```

Use bold for emphasis on critical words:

```
// AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.
```

## Rules

1. **AI-DEV notes MUST NOT be removed** — They are permanent instructions, not temporary comments
2. **LLMs MUST follow AI-DEV instructions** — These are not suggestions, they are directives
3. **AGENTS.md must document that the project uses AI-DEV notes and that LLMs must obey them** — Example line for AGENTS.md: "This project uses // AI-DEV: comments as binding instructions. Never remove them. Always follow them."
4. **Place an AI-DEV note inside every function or method it applies to** — Do not place a single AI-DEV note at the top of a file and expect it to protect all functions below — small-context models may not see it.

## Common AI-DEV Patterns

### Confirmed Test Protection
```javascript
// AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.
```

### Critical Code Protection
```javascript
// AI-DEV: AI **MUST NOT** modify this function without explicit human approval. It handles financial calculations.
```

### Implementation Notes
```javascript
// AI-DEV: This intentionally uses a recursive approach for readability. Do NOT refactor to iterative.
```

### Dependency Warnings
```javascript
// AI-DEV: This import order matters. CSS modules must load before component styles.
```
