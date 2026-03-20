# AI-DEV Notes Standard

## What Are AI-DEV Notes?

AI-DEV notes are inline comments directed at LLMs that provide instructions LLMs must follow when working with code. They can appear anywhere in code, but because of limited LLM attention, it's best for them to appear _inside_ a method body.

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
3. **AI-DEV notes must be specified in AGENTS.md** — So all AI coding agents (not just Claude) know about them
4. **Place markers inside each scope** — Don't rely on file-level markers alone; small-context models may not see them

## Common AI-DEV Patterns

### Confirmed Test Protection
```javascript
// AI-DEV: AI **MUST NOT** touch this test. If the test is failing, it is because you removed or broke code.
```

### Critical Code Protection
```javascript
// AI-DEV: AI **MUST NOT** modify this function without explicit human approval.
```

### Implementation Notes
```javascript
// AI-DEV: This intentionally uses a recursive approach for readability. Do NOT refactor to iterative.
```

### Dependency Warnings
```javascript
// AI-DEV: This import order matters. CSS modules must load before component styles.
```
