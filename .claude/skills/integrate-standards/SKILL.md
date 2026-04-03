---
name: integrate-standards
description: Install or update nr-ai-standards in a target project. Creates .claude/ structure with rules, skills, settings, and CLAUDE.md tailored to the project.
disable-model-invocation: true
argument-hint: <target-repo-path>
---

# Integrate NR AI Standards

You are integrating nr-ai-standards into the target project at `$ARGUMENTS`.

## Process

### Step 0: User-Level Rules and Returning User Detection

Before doing anything with the target project, check the user's environment:

**Check for scan config:** Read `.claude/.nr-ai-standards-scan-config` in this repo (nr-ai-standards). If it doesn't exist, this is a first-time user.

**Check user-level rules:** Check whether `~/.claude/rules/` exists and contains nr-ai-standards rules. Look for a version marker comment at the top of any installed rule (e.g., `<!-- nr-ai-standards vX.Y.Z -->`).

**First-time user (no scan config):**
After completing the project integration (Steps 1-5), offer to install universal rules at the user level:

> "These rules apply regardless of project and can live in your user profile (`~/.claude/rules/`) so they're active in every repo:"

Present a multi-select with these rules pre-selected:
- `ai-dev.md` — AI-DEV markers, don't modify confirmed tests
- `cli-safety.md` — Don't run destructive commands
- `security.md` — Don't commit secrets, don't disable security checks
- `llm-test-verification.md` — Red-green-refactor cycle, test quality
- `engineering-standards.md` — NR engineering standards (STAN)
- `pr-review-checklist.md` — PR review standards

And `testing.md` as NOT pre-selected (with note: "This one has project-specific tool references — usually better at project level").

For each selected rule, install using the same two-pass process (Pass 1: copy verbatim, Pass 2: adapt). Since these are user-level, skip project-specific adaptations — install the reference versions as-is, with a version marker comment added to the top: `<!-- nr-ai-standards vX.Y.Z -->`.

Then create the scan config:
```json
{
  "first_run_complete": true,
  "user_rules_installed": true,
  "user_rules_version": "X.Y.Z"
}
```

**Returning user (scan config exists):**
- Check if user-level rules exist and compare their version marker against the current VERSION. If stale, update them silently and mention it in the summary.
- After completing the project integration, prompt:

> "You've used `/integrate-standards` before. If you want to update standards across all your repos at once, try `/integrate-standards-batch ~/ghe` (or wherever your repos live)."

Only show this prompt if the scan config does NOT already have a `"batch_prompted": true` flag. After showing it, set that flag so it only appears once.

### Step 1: Understand the Target Project

Read the target project to understand what you're working with:

- Read existing `CLAUDE.md`, `AGENTS.md`, `.claude/` directory if they exist
- Read `package.json`, `Makefile`, `build.gradle`, `Cargo.toml`, `Rakefile`, or whatever build config exists
- Read `.gitignore`
- Look at the project structure (`ls` the root and key directories)
- Identify the language, framework, test runner, and build tools
- Check for existing `.claude/rules/`, `.claude/skills/`, `.claude/commands/`

### Step 2: Plan the Integration

Based on what you found, plan what needs to happen. Present the plan to the user and get approval before making changes. The plan should cover:

**Rules** (`.claude/rules/`):
- Which reference standards apply? Install ALL rules by default. Only skip a rule if the rule is language-specific and the project uses a completely different language, or if the user explicitly asks to skip it.
- What needs to be adapted? (e.g., a Python project doesn't need JavaScript test examples)
- Are there existing rules that overlap or conflict?
- Install ALL rules by default. Only skip a rule if the rule is language-specific and the project uses a completely different language, or the user explicitly asks to skip it.

**Settings** (`.claude/settings.json`):
- Does one exist already? If so, merge additively (add missing allows, never remove existing ones)
- If not, create from the reference settings.json
- BE CONSERVATIVE!
- **Cross-repo read access**: Ask the user: "Where do your repos live? (e.g., `~/ghe/`, `~/code/`, `~/src/`)" — if they provide a path, add `Read(<path>*)`, `Glob(<path>*)`, and `Grep(<path>*)` to the allow list. This lets Claude read sibling repos without prompting, which is essential for standards audits, cross-repo analysis, and referencing shared code. Only add read permissions, never write.

**CLAUDE.md**:
- Does one exist? If so, read it carefully. Identify what's missing from the reference structure.
- Propose additions/changes, explain why, and ask before modifying.
- Never delete existing content without asking.
- Keep it under 200 lines. Move detailed content to rules.
- Walk us through each of the changes and why. This is going to be the most significant change because most projects have _terrible_ CLAUDE.md files.

**AGENTS.md**:
- AGENTS.md should be a symlink to CLAUDE.md (`ln -s CLAUDE.md AGENTS.md`)
- This ensures all AI coding agents (Codex, Jules, Aider, Copilot, etc.) read the same instructions
- If an AGENTS.md file (not symlink) already exists, ask the user whether to merge its content into CLAUDE.md and replace it with a symlink, or leave it as-is

**Skills**:
- Which skills make sense for this project?
- Are there existing commands that should migrate to skills? (Note: as of 2025, 'commands' are now called 'skills' in Claude Code. If the project has a .claude/commands/ directory, those should be migrated to .claude/skills/.)
- Are there existing skills that overlap with the references?

**Output Styles** (`.claude/output-styles/`):
- Which output styles would benefit this team? Present the options and let the user choose.
- Output styles are interaction modes (e.g., Socratic learning), not code standards — they install verbatim with no adaptation.

**.gitignore**:
- Ensure `.claude/settings.local.json` is gitignored.

### Step 3: Execute — Two-Pass Process

After the user approves the plan, create each file using this two-pass method:

**Pass 1 — Copy.** For each reference file that maps to a rules or skills file, start by copying the reference content verbatim into the target file. Do not write from memory. Do not paraphrase. Read the reference, then write its content.

**Pass 2 — Adapt.** Make a second pass over the copied file, changing _only_ what must change:
- Code examples: change language syntax (e.g., JS → Go, Python → Rust)
- Tool names: change to the project's actual tools (e.g., `npm test` → `make test`)
- Package registries: change to the project's ecosystem (e.g., npmjs → pkg.go.dev)
- Framework-specific references: change to the project's framework (e.g., Jest → testify)
- Add project-specific sections as _new_ paragraphs or subsections — never replace existing content to make room

**What you must NOT do in Pass 2:**
- Do not drop paragraphs, reasoning, or examples. If the reference explains _why_ something matters (Rainsberger's math, the 2am framing, the Script-ify reasoning, the Failure Thinking categories), keep it.
- Do not reword for style. If the reference says "One class or function," leave it. Only change if the original is actually wrong or misleading for the target stack.
- Do not compress. A 60-line reference should produce a ≥60-line installed file (longer if you added project-specific content).
- If you think something should be dropped, ask the user first. Explain what you'd remove and why.

**File creation order:**
1. `.claude/rules/` files (two-pass from references)
2. `.claude/settings.json` (copy reference, add project-specific auto-approvals)
3. `CLAUDE.md` (this one is written from scratch using the claude-md.md template as structural guidance — it's the one file that should be mostly new project-specific content)
4. `AGENTS.md` symlink → `CLAUDE.md`
5. `.claude/skills/` — Skills use a DIFFERENT process than rules:
   - Read the skill reference template
   - Generate the SKILL.md by following the template's instructions (the template tells you what to produce — it is not copied verbatim)
   - Preserve all prescribed content verbatim: checklist items, philosophy text, and quoted passages
   - Adapt only tool names, language syntax, and framework references to the target stack
6. `.claude/output-styles/` (verbatim copy only — no Pass 2. These are interaction modes, not code standards, so they apply identically regardless of stack.)
7. `.gitignore` update
8. `.claude/.nr-ai-standards-version`

### Step 4: Self-Check with Coverage Report

Before presenting the summary to the user, verify your work by comparing each installed file against its reference.

**For each rules file**, read both the reference and the installed file, then:

1. Count non-blank lines in the reference
2. Count how many are present in the installed file (verbatim or with a legitimate stack adaptation)
3. Count lines added in the installed file that aren't in the reference
4. Calculate match percentage: matched / reference lines

**For each skill**, check whether each prescribed content item from the skill reference template is present in the installed SKILL.md. Report coverage of prescribed items.

**For CLAUDE.md**, check against the claude-md.md reference structure:
- Has Project Overview section
- Has Important Paths section with `@path` references
- Has build/test/lint commands
- Content is timeless (no debugging reports, plans, task lists)
- Under 200 lines, no section over 30 lines

**For output styles**, verify each selected file was copied verbatim (byte-for-byte match with the reference).

**For settings.json**, verify all reference allows are present plus any project-specific additions.

Present the results as a table:

| File | Match % | Notes |
|---|---|---|
| testing.md | 100% | Verbatim |
| llm-test-verification.md | 87% | JS→Go examples |
| ... | ... | ... |

If any file is below 80%, fix it before proceeding. Adapted lines (language syntax, tool names, registries) count as matched — only missing/dropped content counts against the percentage.

### Step 5: Summary

Print a summary of everything that was created or modified, including the coverage table from Step 4.

## On Subsequent Runs (Updating)

When the target project already has nr-ai-standards integrated:

1. **Determine what changed upstream:**
   - Read `.claude/.nr-ai-standards-version` in the target project to find the last integrated version
   - Read the current `VERSION` file in the nr-ai-standards repo
   - Read `CHANGELOG.md` in the nr-ai-standards repo to see what changed between those versions
   - If the version file is missing, treat it as a first-time integration and do a full comparison

2. **Detect structural divergences:**
   For each reference file, check whether the target project uses the same file structure. Flag cases where:
   - A reference exists as a standalone file but its content was inlined into another file in the target project
   - A reference was split into multiple files in the target project
   - A file exists in the target project but has no corresponding reference

   When flagging, explain *why* the reference uses that structure (check the CHANGELOG for context). Ask the user whether the divergence was intentional. Example:
   > `llm-test-verification.md` exists as a standalone reference, but in this project its content is inlined in `testing.md`. This was split out in v1.1.0 because LLMs lose track of verification steps when buried in a long file. Was this combined intentionally, or should I split it back out?

3. **Diff each rules file:**
   - Compare the target project's rule against the current reference
   - If the reference changed upstream (per CHANGELOG), show what changed and why, and ask whether to incorporate
   - If the project customized the rule, respect the customization — but flag if it conflicts with a new upstream change

4. **Same approach for skills** — diff, ask, adapt

5. **Output styles** — check for new output styles in the references. Since these are verbatim copies, any upstream change means replacing the file entirely. Ask before replacing.

6. **Settings.json** — merge additively as always

7. **CLAUDE.md** — flag any new sections from the references that the project doesn't have yet

8. **Update `.claude/.nr-ai-standards-version`** to the current version after all changes are applied

Never silently overwrite. Always show what changed and why, and ask before modifying.
