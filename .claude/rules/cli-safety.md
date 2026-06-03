<!-- AI-DEV: This file is managed by nr-ai-standards via git subtree. Do NOT edit directly. To override a specific rule, ask Claude: "Override [rule name] from this file" and it will create a project-level override in .claude/rules/ -->

# CLI Safety Standards

## Never Auto-Approve Arbitrary Code Execution

These commands run arbitrary code. They require human review each time because the LLM controls what code runs.

The following must **NOT** be auto-approved in Claude Code or similar AI coding tools:

- `python` / `python3`
- `node` / `node -e`
- `ruby` / `ruby -e`
- `bash -c` / `sh -c`
- `eval`
- `ls | xargs`
- `$()` / `${}`
- Any command that accepts and executes arbitrary user-supplied code strings (e.g., `perl -e`, `lua -e`, `powershell -Command`)

These commands can execute arbitrary code. Auto-approving them means an LLM can run anything without human review.

**Do NOT bypass the deny list by wrapping denied commands in a bash script.** Writing a `.sh` wrapper that internally calls `python3` or `node` defeats the purpose of the deny list. If a command is denied, do not use it — rewrite the logic in a language that is allowed, or use shell built-ins.

## Never Auto-Approve Irreversible Production Commands

The following **MUST NOT** be auto-approved ever under any circumstances:

- `kubectl exec`, `kubectl delete`, `kubectl apply`, `kubectl scale`
- `helm upgrade`, `helm uninstall`
- `terraform apply`, `terraform destroy`
- `aws ec2 terminate-instances`, `aws rds delete-db-instance`, `aws s3 rm`
- `gcloud compute instances delete`, `az vm delete`
- `psql`, `mysql` with `-c`/`-e`/`--eval` (arbitrary SQL/queries)
- `vault delete`, `aws secretsmanager delete-secret`
- `git push --force` to `main`/`master`

Common thread: **irreversible at scale** — one command can destroy production state with no undo.

## Script-ify Repeated Patterns

When you find yourself repeatedly approving the same CLI pattern:

1. **Extract it into a script** (shell script, Makefile target, npm script, etc.)
2. **Auto-approve the script** instead of the raw command

Why this matters:
- Auto-approved scripts are **auditable** — you can review the script once and trust it
- Raw shell commands are **not auditable** — each invocation could be different
- Scripts create a record of what operations are expected in the project
- Scripts can include safety checks (confirmation prompts, dry-run modes)

Example:
```bash
# BAD: auto-approving raw node
# Bash(node:*)  ← LLM can run ANY JavaScript

# GOOD: auto-approving a specific script
# Bash(./scripts/lint.sh:*)  ← reviewed, scoped, auditable, read-only-safe
```

## Safe Auto-Approval Patterns

These are generally safe to auto-approve because they are read-only or scoped:

- `git log`, `git status`, `git diff`, `git branch` (read-only git operations)
- `ls`, `cat`, `head`, `tail` (read-only file operations)
- MCP tool calls for reading data (search, get, list operations)
- `npm test`, `npm run lint` — safe only if you have reviewed the test and lint scripts in package.json. Do not auto-approve these in repositories you haven't audited.
