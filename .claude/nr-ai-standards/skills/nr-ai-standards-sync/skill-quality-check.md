# Quality Check Skill Reference

This is a reference for a project's quality check skill. It should run the project's actual quality commands in sequence, then evaluate results. Items 5-6 below contain the relevant test-verification and testing-philosophy checks; no external file references are needed in the generated skill.

## Structure

```
.claude/skills/quality-check/SKILL.md
```

## Frontmatter

```yaml
---
name: quality-check
description: Run all quality checks (types, tests, linting) in sequence
disable-model-invocation: true
---
```

## Content should include

1. The project's actual commands in order (e.g., type check, unit tests, lint, e2e)
2. On first failure: stop the sequence, print the failing command and its stderr/stdout, and report which check failed and why (do not attempt to fix it)
3. Summary table format for results
4. Coverage thresholds if applicable
5. After tests pass, run the LLM test verification checks:
   - Test names match test contents
   - No trivially passing tests (testing mocks instead of code)
   - No duplicate coverage
   - Tests containing `// AI-DEV` comment markers have not been modified or removed
   - Flag any test that spins up external services (database, HTTP server, message queue) for logic that could be tested with mocks and no I/O
6. Testing philosophy reminders (from testing.md):
   - Unit tests are 95% of the suite, fast and isolated
   - Integration tests are spot-checks on mocks, not the safety net
   - Sandi Metz rules: only test the public interface, mock outgoing commands, don't test private methods
