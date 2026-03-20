# CLI Safety Standards

## No Auto-Approval for Interpreters

The following must **NOT** be auto-approved in Claude Code or similar AI coding tools:

- `python` / `python3`
- `node` / `node -e`
- `ruby` / `ruby -e`
- `bash -c` / `sh -c`
- `eval`
- `ls | xargs`
- `$()` / `${}`
- And other similar commands.

These commands can execute arbitrary code. Auto-approving them means an LLM can run anything without human review.

## ABSOLUTELY NO auto-approval for destructive production commands

The following **MUST NOT** be auto-approved ever under any circumstances:

- `kubectl exec`, `kubectl delete`, `kubectl apply`, `kubectl scale`
- `helm upgrade`, `helm uninstall`
- `terraform apply`, `terraform destroy`
- `aws ec2 terminate-instances`, `aws rds delete-db-instance`, `aws s3 rm`
- `psql`, `mysql` with `-c`/`-e`/`--eval` (arbitrary SQL/queries)
- `vault delete`, `aws secretsmanager delete-secret`
- `gcloud compute instances delete`, `az vm delete`
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

## Safe Auto-Approval Patterns

These are generally safe to auto-approve because they are read-only or scoped:

- `git log`, `git status`, `git diff`, `git branch` (read-only git operations)
- `ls`, `cat`, `head`, `tail` (read-only file operations)
- MCP tool calls for reading data (search, get, list operations)
- `npm test`, `npm run lint` (assuming trusted package.json scripts)
