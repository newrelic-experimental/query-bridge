---
name: verify-integration
description: Verify an nr-ai-standards integration by comparing installed files against current references
disable-model-invocation: true
argument-hint: <target-repo-path>
---

# Verify NR AI Standards Integration

Run the verification script, then review the output.

## Step 1: Run the script

```bash
bash .claude/skills/verify-integration/verify.sh $ARGUMENTS
```

## Step 2: Review output

The script checks:
- Version match
- Rules files: diff line count vs reference (flags >40% divergence)
- Settings: all reference entries present
- Skills: installed for each reference
- CLAUDE.md: structure checks (overview, @paths, commands, length, timeless content)
- AGENTS.md: is a symlink to CLAUDE.md
- .gitignore: has settings.local.json

If the script reports all OK, print the output and end with: **Integration verified. All files match references.**

If issues are found, review each flagged file manually (read both reference and installed) to determine whether the divergence is:
- A legitimate project-specific adaptation (OK)
- Missing content that should be present (flag it)

Present the final report with your assessment. Do NOT make changes — this skill is read-only. Tell the user to run `/integrate-standards` to fix issues.
