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

Dispatch an Agent (model: opus, subagent_type: general-purpose) with the SPL cases. The agent must invoke the `spl-knowledge` skill (or read `.claude/skills/spl-knowledge/SKILL.md`) and `.claude/references/spl-reference.md` first.

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

The agent must invoke the `nrql-knowledge` skill (or read `.claude/skills/nrql-knowledge/SKILL.md`) and `.claude/references/nrql-reference.md` first.

Ask the NRQL expert to:
1. Confirm the NRQL achieves the **same intent** as the SPL (even if the mechanism is wildly different)
2. Flag any NRQL syntax issues, wrong functions, or semantic differences
3. Note if the translation is a reasonable approximation with caveats vs. fundamentally wrong
4. For cases with `warningFunc` or `unsupportedFunc`, confirm the warning/unsupported message is appropriate

**Key principle:** The NRQL doesn't need to be a literal translation. It needs to answer the same question the SPL user was asking.

**Before flagging any translation as a defect, check whether it's settled behavior.** `grep` `test/spl/spl.test.js` for the construct and look for a `verified: 'human'` case, and check the relevant `src/input/spl/*Handlers.js` for a deliberate mapping. If a human already approved it (or a handler maps it on purpose), it is NOT a defect — it's intended. This catches the recurring failure mode of applying a SQL/boolean prior to NRQL's un-SQL-like semantics (e.g. `OR` value-coalesces; `WITH`/`FACET` alias rules) and crying bug on a correct mapping. When the divergence rests on NRQL behavior you're inferring rather than know, confirm with the live compiler (`execute_nrql_query`); if the NR MCP is disconnected, two agents agreeing on docs is corroboration, not proof — record the verdict as pending, don't assert it as fact.

**Adjudicate the translator's ACTUAL output, never a report's quoted/paraphrased NRQL.** A defect report's example may be stale (the translator was since fixed) or a lossy paraphrase (a simplified SPL that drops a distinguishing filter, making two correct distinct outputs collapse into one that *looks* wrong). Before promoting OR withdrawing, re-run the real SPL through `node bin/spl2nrql.js "<query>"` and, when the example is paraphrased, pull a genuine instance from the corpus (`jq '.[] | select(.spl | test("..."))' spl-real-world.json`) rather than the report's transcription.

#### Step 3: NRQL Validation (Opus subagent)

Dispatch an Agent (model: opus, subagent_type: general-purpose) that invokes the `nrql-validation` skill (or reads `.claude/skills/nrql-validation/SKILL.md`).

For each case that has an `nrql` field:
1. Run the NRQL against account 1 via `execute_nrql_query` with `LIMIT 1` appended (unless LIMIT already present)
2. If timeout or slow, retry against account 10671289 (fewer logs)
3. Classify: SUCCESS (compiled, even if 0 rows) or FAILURE (syntax/semantic error)
4. For failures, report the exact error message

For cases that only have `errorIncludes`, `warningFunc`, or `unsupportedFunc` (no `nrql`), skip MCP validation — these are expected-failure cases. (Note: `warningIncludes`/`unsupportedIncludes` are NOT implemented by the runner — only `errorIncludes` (substring) and `warningFunc`/`unsupportedFunc` (exhaustive message-key arrays) are asserted.)

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
4. **Full message text** — look up the message key used in `warningFunc`/`unsupportedFunc`/`errorIncludes` and find the full message text from `src/messages.js`. Show the complete rendered message, not just the substring.
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

## Mode 3: Real-Data Validation (NRQL Semantic Verification)

Validates that translated NRQL not only compiles but produces meaningful results against real data in account 1.

### When to Use

- Tagging test cases with `semantic_verification: 'mcp'`
- After implementing new NRQL features (EXPAND, new clause types)
- For queries involving array expansion, nested JSON, or subquery nesting
- When MCP compilation passes but semantic correctness is uncertain

### What Counts as Proof

The query must return **non-null, non-zero, non-empty computed values**. None of the following count as proof:

- `0` (e.g., `count: 0`) — proves compilation, not computation
- `[]` — empty result set
- `''` — empty string
- `null`
- Timeout
- Error

If the exact query returns any of the above, adapt it to target real data (use known fields from `nrql-corpus.md`). If you can't get real computed values after 3 attempts, leave it untagged.

**Exception — `numeric()`-wrapped arithmetic.** `numeric(field)` returns null when `field` holds a non-numeric string, but returns the value (and arithmetic works) on an already-numeric field — see `nrql-reference.md`. So `numeric(stringField)` nulls against staging data that isn't a numeric string. That is a **satisfiable** query (feed it numeric-string data and it computes), NOT an impossible one — do not demote it for a null here. If a `numeric()`-wrapped expression nulls, prove the arithmetic *structure* by pointing it at a numeric field (e.g. `numeric(timestamp) * 2 + numeric(timestamp)` → real number) or a numeric-string literal (`numeric('123')` → 123); promote on structure + expert sign-off. Reserve the null/zero failure bar for genuinely impossible queries (inverted time ranges, undefined template vars, contradictory predicates).

### Workflow

1. **Find matching data**: Use discovery queries to confirm data exists
2. **Run the translated NRQL**: Execute against account 1
3. **Check results return real values**: Numbers > 0, non-empty strings, actual rows with populated fields. See "What Counts as Proof" above.
4. **Verify semantics**: Does the result represent what the SPL query intended?

### Output Format

After every batch of 4, show a proof table:

```
| Line | Pattern | Adapted NRQL | Proof Value | Tag |
```

After every 5 batches (20 tags), pause for a scorecard checkpoint showing: total tagged, total skipped, FIXMEs found.

---

## Handling Edge Cases

- **Template variables** (`$var$`): Substitute a literal value before MCP validation (e.g., `$host$` → `'web-01'`)
- **Exotic event types**: If the NRQL uses `FROM Metric` or other non-Log types, that's fine — MCP will still compile-check it
- **Known FIXMEs**: If a test case has a FIXME comment, note it in the report but still validate current behavior
- **Cases with only warnings/unsupported**: These are valid — the translator intentionally flags these. Validate the message content is reasonable.
- **Skipped tests (`skip: true`)**: These are FIXME placeholders for future work. Include them in Mode 2 presentation if they have `verified: 'llm'`, but note they are skipped.

## Scaling to many cases (agent swarm + main-thread MCP)

Subagents usually CANNOT reach the NR MCP (`execute_nrql_query`). For a large backlog, split the work: dispatch parallel Opus expert-review agents (each owns a contiguous block of test-file line ranges, reads only its slice, invokes `spl-knowledge` + `nrql-knowledge`), and have each return a compact per-case block — intent, semantic verdict, an **MCP-ready adapted NRQL** (template tokens/placeholder fields swapped for real values), and a discovery query. The **main thread** then runs every MCP query itself (agents produce queries, never run them). This keeps the giant test file out of your context and parallelizes the slow expert review while you stay the single MCP caller.

## Batch Size

4 cases per batch. This keeps each agent's context focused and prevents timeout issues. Run batches sequentially — each batch's results inform whether to continue or stop for human review.

## Output Format (Mode 1)

After each batch, report:

```
Batch N (lines X-Y):
  Case 1: "SPL query..." → PASS (promoted to 'llm') | FAIL (reason)
  Case 2: ...
```
