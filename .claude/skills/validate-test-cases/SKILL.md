---
name: validate-test-cases
description: Use when verifying unverified SPL-to-NRQL test cases in spl.test.js, promoting verification levels, or bulk-validating translator output against New Relic accounts
---

# Validate Test Cases

Two modes depending on the current verification level of the cases.

## Mode 1: `verified: false` → `verified: 'llm'` (Agent Pipeline)

Three-agent pipeline: SPL expert confirms intent, NRQL expert confirms semantic equivalence, validator confirms compilation.

### When to Use

- Verifying `verified: false` test cases in `test/spl/spl.test.js`
- Promoting cases to `verified: 'llm'` after expert + MCP review
- Bulk-validating translator output after code changes

### Workflow

Work in batches of 4 test cases. For each batch:

#### Step 1: SPL Expert Review (Opus subagent)

Dispatch an Agent (model: opus, subagent_type: general-purpose) with the SPL cases. The agent must read `.claude/agents/spl-expert.md` and `.claude/rules/spl-reference.md` first.

Ask the SPL expert to:
1. Confirm each SPL query is valid/reasonable (our parser is permissive — judge by intent, not strict Splunk syntax)
2. Describe the **intent** of each query in plain English
3. Describe what the **underlying data probably looks like** (field names, types, example rows)
4. Flag any SPL gotchas relevant to translation (e.g., `search` does substring match, `stats` resets fields)

#### Step 2: NRQL Expert Review (Opus subagent)

Dispatch an Agent (model: opus, subagent_type: general-purpose) with:
- The SPL queries
- The SPL expert's intent analysis and data shape
- The current NRQL output from the test case

The agent must read `.claude/agents/nrql-expert.md` and `.claude/rules/nrql-reference.md` first.

Ask the NRQL expert to:
1. Confirm the NRQL achieves the **same intent** as the SPL (even if the mechanism is wildly different)
2. Flag any NRQL syntax issues, wrong functions, or semantic differences
3. Note if the translation is a reasonable approximation with caveats vs. fundamentally wrong
4. For cases with `warningIncludes` or `unsupportedIncludes`, confirm the warning/unsupported message is appropriate

**Key principle:** The NRQL doesn't need to be a literal translation. It needs to answer the same question the SPL user was asking.

#### Step 3: NRQL Validation (Opus subagent)

Dispatch an Agent (model: opus, subagent_type: general-purpose) that reads `.claude/agents/nrql-validator.md`.

For each case that has an `nrql` field:
1. Run the NRQL against account 1 via `execute_nrql_query` with `LIMIT 1` appended (unless LIMIT already present)
2. If timeout or slow, retry against account 10671289 (fewer logs)
3. Classify: SUCCESS (compiled, even if 0 rows) or FAILURE (syntax/semantic error)
4. For failures, report the exact error message

For cases that only have `errorIncludes`, `warningIncludes`, or `unsupportedIncludes` (no `nrql`), skip MCP validation — these are expected-failure cases.

#### Step 4: Update Verification Status

After all three agents report back:

- **All clear** (SPL valid, NRQL semantically correct, MCP compiled): Update `verified: false` → `verified: 'llm'` in the test file
- **NRQL compilation failure**: Do NOT update verified. Report the failure for human review. The translator may need a fix.
- **Semantic mismatch** (NRQL doesn't match SPL intent): Do NOT update verified. Report the mismatch for human review.
- **SPL invalid/unreasonable**: Note it but still validate — our parser accepts it, so the test case documents current behavior.

Use the Edit tool to update the `verified` field. Do not change any other fields in the test case.

---

## Mode 2: `verified: 'llm'` → `verified: 'human'` (Human Review)

Present cases to the human for review and approval. **Only the human can promote to `verified: 'human'`.**

### When to Use

- After agent pipeline has promoted cases to `verified: 'llm'`
- When the human invokes this skill on `verified: 'llm'` cases
- During audit sessions

### Workflow

Work in batches of 4 test cases. For each batch:

#### Step 1: Gather case data

For each case, collect:
1. **Line number** where the test case starts in `test/spl/spl.test.js`
2. **SPL** — the `spl` field
3. **NRQL** — the `nrql` field (or "_(unsupported — no NRQL emitted)_" if absent)
4. **Full message text** — look up the message key used in `warningIncludes`/`unsupportedIncludes`/`errorIncludes` and find the full message text from `src/messages.js`. Show the complete rendered message, not just the substring.
5. **FIXMEs/TODOs** — any FIXME or TODO comments in the lines above the test case
6. **Current verified status** — should be `'llm'`

#### Step 2: Present to human

Present 4 cases at a time using this format:

```
**#N** (line XXXX)  `verified: 'llm'`
SPL:  `the spl query`
NRQL: `the nrql output`
warning: full rendered message text from messages.js
FIXME: any fixme text (omit if none)
```

Then wait for the human to respond. They may:
- **Approve all** → promote each to `verified: 'human'`
- **Approve some** → promote only the approved ones
- **Flag issues** → do NOT promote, note the issue
- **Request changes** → make the requested changes, do NOT promote until re-validated

#### Step 3: Update Verification Status

For approved cases only, use the Edit tool to change `verified: 'llm'` → `verified: 'human'`.

**IMPORTANT:** Only the human can authorize promotion to `'human'`. Never auto-promote.

---

## Handling Edge Cases

- **Template variables** (`$var$`): Substitute a literal value before MCP validation (e.g., `$host$` → `'web-01'`)
- **Exotic event types**: If the NRQL uses `FROM Metric` or other non-Log types, that's fine — MCP will still compile-check it
- **Known FIXMEs**: If a test case has a FIXME comment, note it in the report but still validate current behavior
- **Cases with only warnings/unsupported**: These are valid — the translator intentionally flags these. Validate the message content is reasonable.
- **Skipped tests (`skip: true`)**: These are FIXME placeholders for future work. Include them in Mode 2 presentation if they have `verified: 'llm'`, but note they are skipped.

## Batch Size

4 cases per batch. This keeps each agent's context focused and prevents timeout issues. Run batches sequentially — each batch's results inform whether to continue or stop for human review.

## Output Format (Mode 1)

After each batch, report:

```
Batch N (lines X-Y):
  Case 1: "SPL query..." → PASS (promoted to 'llm') | FAIL (reason)
  Case 2: ...
```
