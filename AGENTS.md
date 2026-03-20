# AI Agent Standards for nr-query-bridge

## AI-DEV Inline Markers

This project uses AI-DEV inline markers to protect confirmed code and tests. See `.claude/rules/ai-dev.md` for the full standard.

Key rules:
- AI-DEV markers **MUST NOT** be removed
- If a test with an AI-DEV marker is failing, fix the production code, not the test
- Place markers inside each test/function body, not just at file level

## Expert Agents

Three specialized agents are available in `.claude/agents/`:

### spl-expert
SPL domain expert. Use for understanding SPL query intent, syntax edge cases, and command semantics. Invoke via Agent tool with `name: 'spl-expert'`.

### nrql-expert
NRQL domain expert. Use for finding NRQL equivalents of SPL patterns, validating syntax, and suggesting optimal query approaches. Invoke via Agent tool with `name: 'nrql-expert'`.

### nrql-validator
Executes NRQL queries against New Relic account 1 via MCP. Reports SUCCESS/FAILURE with exact error messages. Use to bulk-validate translated queries before accepting them as correct. Invoke via Agent tool with `name: 'nrql-validator'`.

## Translation Analysis Process

When analyzing how to translate a new SPL command:
1. Grep `test/spl/spl-real-world.json` for all queries using the command
2. Pass SPL to spl-expert: determine intent, log structure, why the command is used
3. Pass intent + structure to nrql-expert: write simplest NRQL for each intent
4. Identify distinct patterns of usage
5. Compare to what the translator produces — correct, close, or wrong?
6. Implement fixes, add unit tests with `v2nrql` assertions
7. Validate via nrql-validator
