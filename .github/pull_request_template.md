https://new-relic.atlassian.net/browse/NR-

_Enter a summary of the PR here._

### Checklist for author
- [ ] New test cases have correct `verified` level and `doc` tag
- [ ] LLM-generated tests followed red-green-refactor verification (see `.claude/rules/llm-test-verification.md`)
- [ ] No `verified: 'human'` tests were modified (these are protected — fix the code, not the test)

### Checklist for reviewer
- [ ] Is it clear what the PR is doing and why?
- [ ] Do new NRQL translations match expected SPL semantics?
- [ ] Are `verified` levels appropriate? (Don't approve `verified: 'human'` without actually verifying)

### Testing plan
-
