---
name: pr-review
description: Review a pull request for quality, security, and best practices
disable-model-invocation: true
---

Review the current branch's changes against the universal PR review checklist and project-specific criteria.

## Process

1. **Gather context**: Run `git diff master...HEAD` and `git log master..HEAD --oneline` to understand the full changeset.

2. **Universal checklist** (from `@.claude/rules/pr-review-checklist.md`):
   - Security: no secrets, no unverified deps, no injection, inputs validated
   - Testing: new behavior has tests, confirmed tests untouched, test names match contents
   - Code quality: focused changes, no over-engineering, no dead code
   - Commits: conventional format, "why" not "what"
   - AI-specific: AI-DEV markers preserved, no hallucinated imports

3. **Project-specific checks**:
   - IR node factories receive non-null arguments (see `@.claude/rules/type-strictness.md`)
   - No `.filter(Boolean)` silently dropping nulls from IR arrays
   - All user-facing messages go through `src/messages.js` catalog — no inline template literals
   - Smart backticking rules followed (only backtick identifiers with dots/dashes/spaces/colons/curlies)
   - DualCheck used for SPL equality comparisons (not manual dual-emit)
   - `warningFunc`/`unsupportedFunc` arrays in tests are exhaustive
   - Test `verified` field not promoted by AI (only humans promote)
   - No customer-identifiable data in test fixtures

4. **Failure thinking** (relevant categories only):
   - **Logic**: Can new behavior be turned off? What cases skip guards?
   - **Edge cases / Nulls**: What if a field is null? Empty string? Unexpected type?
   - **Deployment**: New env vars? Post-deploy tasks?

5. **Report**: Severity-rate each finding as blocking, non-blocking, or trivial.
