<!-- AI-DEV: This file is managed by nr-ai-standards via git subtree. Do NOT edit directly. To override a specific rule, ask Claude: "Override [rule name] from this file" and it will create a project-level override in .claude/rules/ -->

# PR Review Checklist (Universal)

## Roles

### Reviewer
- Comment on the code, not the author. "I think this code is trying to do X" not "You wrote this wrong."
- Word critiques as questions — the author may have a good reason.
- Avoid "why" — it reads as accusatory. "Did you mean to leave out the parentheses?" is better.
- Praise good decisions alongside critiques.
- Stick to code issues aligned with the goals below. Avoid philosophical debates.
- Severity-rate your comments: blocking, non-blocking, trivial.

### Author
- The target of the review is the code, not you.
- Defend your work if critiques miss something, but remain flexible.
- It's okay to talk with your reviewer in person about PR comments.

## Goals

1. **Deliver without incident** — Think broadly about what could go wrong. Check fiddly details. Verify code matches the tech design and doesn't miss story notes.
2. **Collaboration** — Can other people read this? Reduce silos. Help cross-team members with your team's unique patterns.
3. **Code quality** — Tests truly cover the problem and edges. Code is simple and discoverable. Follows established architectural patterns.
4. **Pave the way to production** — Migrations/post-deploy tasks annotated. CI issues addressed. Clean commit history.

## Security
- [ ] No secrets, API keys, tokens, or credentials in the diff
- [ ] No new dependencies without verification — check for known CVEs, license compatibility, and download counts before adding (see .claude/rules/security.md)
- [ ] No SQL injection, XSS, command injection, or other OWASP Top 10 vulnerabilities
- [ ] Inputs validated at system boundaries
- [ ] String interpolation checked for XSS possibilities

## Testing
- [ ] New behavior has tests
- [ ] Tests follow red-green-refactor (see .claude/rules/testing.md)
- [ ] Confirmed tests (those containing `// AI-DEV` comment markers) have NOT been modified
- [ ] No integration tests where unit tests would suffice
- [ ] Test names describe expected behavior

## Code Quality
- [ ] Changes are focused — one concern per PR
- [ ] No over-engineering or premature abstraction
- [ ] No dead code, commented-out code, or TODO comments without tickets
- [ ] Error handling is appropriate (not excessive, not missing)

## Commits
- [ ] Conventional commit format (`feat:`, `fix:`, `chore:`, etc.)
- [ ] Commit messages explain "why", not just "what"
- [ ] No fixup commits that should be squashed

## AI-Specific
- [ ] `// AI-DEV` comment markers preserved (not removed or modified)
- [ ] No hallucinated library imports
- [ ] No unnecessary changes outside the scope of the PR

## Thinking About Failures

Evaluate each category below against the PR's actual changes. Skip categories that are clearly irrelevant (e.g., skip Database if the PR has no database changes). For relevant categories, check each item.

### Network
- What if the network is down? Slow? Do we need circuit breakers or retries?
- Will this create excessive traffic? Do we need to log or audit?
- Invalid JSON? Unexpected status codes?

### Database
- Query performance? N+1 queries? Missing indices? Table locks?
- Could any queries be cached?
- Timezone columns?

### Exceptional Conditions
- What if a file doesn't exist? Server has full disk or empty memory?
- Are all raised exceptions handled?

### Logic
- Can this feature be turned off quickly (feature flag)?
- What cases skip validations or guards?
- Are we relying on variables or formats not defined in this code?

### Deployment
- Does this need to be deployed with something else?
- Post-deploy tasks? Can we rollback?
- New services needed (Redis, etc.)? New environment variables?

### Edge Cases / Nulls
- What if this variable is nil? Empty string? Too long/big?

### Timezones
- Are we using timezones? Should we be?

### Background Workers
- Could this be a background worker? Exponential backoff?
- Will we have enough data to replay the job on failure?
- What happens at high concurrency?

### Multi-threading / HA
- Multi-threading concerns? Will this behave on multiple servers?
- What if one server runs old code and another runs this code?

### CLI Scripts
- Audit log entries needed?
- Can it resume if it fails midway? Is it idempotent?
- How do you identify which records failed? Can you rerun for just those?
- Do you need batches?
