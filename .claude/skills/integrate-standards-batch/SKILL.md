---
name: integrate-standards-batch
description: Scan parent directories for projects, update already-integrated ones, and offer to integrate new ones. Batch mode for nr-ai-standards.
disable-model-invocation: true
argument-hint: <parent-dir> [<parent-dir2> ...]
---

# Batch Update NR AI Standards

You are scanning one or more parent directories to find projects that need nr-ai-standards updates or integration.

The parent directories are provided in `$ARGUMENTS` (space-separated paths).

## Phase 0: User-Level Rules Check

Before scanning projects, check `~/.claude/rules/` for nr-ai-standards user-level rules. Look for files with a `<!-- nr-ai-standards vX.Y.Z -->` version marker comment.

- If user-level rules exist and are current: note this silently, mention in the final report.
- If user-level rules exist but are stale: update them to the current version as part of the batch run. No need to ask — user already opted into user-level rules.
- If no user-level rules exist: offer to install them (same multi-select as `/integrate-standards` Step 0). This handles the case where someone jumps straight to the batch skill.

## Phase 1: Discovery

### 1a. Load scan config

Check for `.claude/.nr-ai-standards-scan-config` in this repo (the nr-ai-standards repo, not the target projects). If it exists, read it. The format is:

```json
{
  "skipped": {
    "/absolute/path/to/repo": "reason it was skipped"
  }
}
```

### 1b. Find projects

Run the discovery and classification scripts:

```bash
bash .claude/skills/integrate-standards-batch/discover.sh $ARGUMENTS \
  | python3 .claude/skills/integrate-standards-batch/classify.sh \
    --skip-config .claude/.nr-ai-standards-scan-config
```

The pipeline outputs JSON with these arrays:
- `integrated` — projects with `.claude/.nr-ai-standards-version` (name, version, path)
- `recommended` — active repos, last commit < 3 months (name, stack, last_commit, path)
- `maybe` — 3-6 months since last commit (name, stack, last_commit, path)
- `probably_not` — inactive, read-only clone, or no git (name, stack, last_commit, path, reason)
- `previously_skipped` — paths in scan config's skipped map (name, stack, path, reason)

### 1c. Assess candidates

For each candidate (not already integrated, not previously skipped), gather context:

- **Stack:** What language/framework based on build files
- **Activity:** When was the last commit? (`git -C <path> log -1 --format=%ci 2>/dev/null`)
- **Ownership:** Is it a fork? (`git -C <path> remote -v` — if the repo has no local branches beyond the default branch AND no commits authored by the current git user (`git -C <path> log --author="$(git config user.email)" --since="6 months ago" --oneline | head -1`) in the last 6 months, classify it as a read-only clone)

Classify each candidate into one of three tiers:

1. **Recommended** — Last commit less than 3 months ago, has app code
2. **Maybe** — Last commit 3 months to 6 months ago, or ambiguous (has code but might be a utility/script repo)
3. **Probably not** — Last commit 6 months ago or older, read-only clone, or non-app code (pure Terraform, docs-only, data-only)

## Phase 2: Summary and Selection

Present results using AskUserQuestion. **Constraints:**
- Max 4 options per question (AskUserQuestion hard limit)
- Always include a "None of these" option (so the user can decline all)
- That leaves 3 project slots per question — paginate if more than 3 projects in a tier
- Present your-repos-first (not read-only clones) before read-only clones

### Question 1: Updates for already-integrated projects

Read the current `VERSION` file in the nr-ai-standards repo. For each integrated project, compare its version against the current version.

Present a summary:

```
## Already Integrated

| Project | Current | Latest | Status |
|---------|---------|--------|--------|
| ~/ghe/my-app | 1.2.0 | 1.4.0 | 2 versions behind |
| ~/ghe/api-service | 1.4.0 | 1.4.0 | Current |
```

If there are out-of-date projects, summarize what changed by reading CHANGELOG.md for the relevant version range.

Then ask (multi-select): "Which projects should I update?" with each out-of-date project as an option plus "None of these". If more than 3 out-of-date projects, paginate across multiple questions. Skip this question entirely if everything is current.

### Question 2: Recommended and Maybe candidates

Present candidates from the Recommended and Maybe tiers, paginated in groups of 3 (plus "None of these"). Show the stack and last commit date. Sort: your repos first (not read-only clones), then read-only clones. Recommended before Maybe within each group.

Skip this question if there are no candidates in these tiers.

### Question 3: Long-shot candidates

Present candidates from the Probably Not tier, paginated in groups of 3 (plus "None of these"). Show the reason for skepticism.

Skip this question if there are no candidates in this tier.

### Post-selection: Skipped repos summary

After all selection questions, list every declined candidate as a comma-separated summary:

```
These repos were skipped: aags, api_analysis, background-runner, ...
Want to add standards to any of these?
```

Present them in paginated multi-select questions (3 per page + "None of these"). Any the user selects get added to the integration queue. Any still declined get offered for permanent skip (saved to `.claude/.nr-ai-standards-scan-config`).

### Previously skipped projects

After the selection questions, show a collapsed note:

```
## Previously Skipped (N projects)
- ~/ghe/terraform-infra — "not app code"
- ~/ghe/docs-site — "not app code"
To reconsider these, edit .claude/.nr-ai-standards-scan-config or pass --include-skipped
```

If `$ARGUMENTS` contains `--include-skipped`, move all previously skipped projects back into the candidate tiers (re-assess them) and clear them from the config.

## Phase 3: Execution

### Permission limitation

Subagents spawned from this repo cannot write to sibling repos — they only have read access. There are two execution strategies:

**Strategy A — Analysis + handoff (default):** Dispatch parallel read-only agents to analyze each project (diff rules, identify conflicts, plan changes). Then present the user with per-project instructions to run `/integrate-standards` from each target project directory in separate sessions. This is the safest approach.

**Strategy B — Direct write (requires user setup):** If the user has added `Edit` and `Write` permissions for target project paths in this repo's settings.json, agents can write directly. Ask the user which strategy to use.

### Updates (already-integrated projects)

For each approved update, dispatch a parallel read-only agent that:

1. Reads the target project's `.claude/.nr-ai-standards-version` for the old version
2. Reads CHANGELOG.md in the nr-ai-standards repo for what changed
3. Diffs each rules file against the current references
4. Identifies conflicts between upstream changes and local customizations
5. Reports back: files to update, files to add, conflicts found

Then present the user with a per-project summary and instructions:
```
cd ~/ghe/<project> && claude
/integrate-standards ~/ghe/nr-ai-standards
```

### New integrations

For each approved new integration, provide the user with instructions to run in a separate session:
```
cd ~/ghe/<project> && claude
/integrate-standards ~/ghe/nr-ai-standards
```

New integrations are interactive (they ask about stack, rules, skills) and must run from the target project directory.

## Phase 4: Final Report

After all work is done, present a summary:

```
## Batch Update Complete

### User-Level Rules (~/.claude/rules/)
Updated to vX.Y.Z (or: Already current | or: Newly installed)

### Updated (N projects)
| Project | From | To | Files Changed |
|---------|------|----|---------------|
| ~/ghe/my-app | 1.2.0 | 1.4.0 | testing.md, engineering-standards.md, +2 |

### Newly Integrated (N projects)
| Project | Stack |
|---------|-------|
| ~/ghe/new-service | Java/Gradle |

### Skipped (N projects)
~/ghe/terraform-infra, ~/ghe/docs-site

### Conflicts (if any)
| Project | File | Issue |
|---------|------|-------|
| ~/ghe/my-app | testing.md | Local customization conflicts with upstream change in v1.3.0 |
```
