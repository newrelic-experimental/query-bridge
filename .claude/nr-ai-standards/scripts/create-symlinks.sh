#!/usr/bin/env bash
set -euo pipefail

# create-symlinks.sh
# Creates symlinks from .claude/rules/ and .claude/skills/ into
# .claude/nr-ai-standards/ (the subtree).
# Rules: one directory symlink (.claude/rules/nr-ai-standards -> subtree/rules/)
# Skills: per-skill symlinks (.claude/skills/<name>/SKILL.md -> subtree SKILL.md)
#   because Claude Code discovers skills at exactly one level deep.
#
# Run from the project root. Expects .claude/nr-ai-standards/ to exist.

SUBTREE=".claude/nr-ai-standards"

if [ ! -d "$SUBTREE" ]; then
  echo "Error: $SUBTREE not found. Run 'git subtree add' first." >&2
  exit 1
fi

# Ensure target directories exist
mkdir -p .claude/rules
mkdir -p .claude/skills

# --- Rules symlink ---
RULES_LINK=".claude/rules/nr-ai-standards"
RULES_TARGET="../nr-ai-standards/rules"

if [ -L "$RULES_LINK" ]; then
  current=$(readlink "$RULES_LINK")
  if [ "$current" = "$RULES_TARGET" ]; then
    echo "rules symlink: already correct"
  else
    rm "$RULES_LINK"
    ln -s "$RULES_TARGET" "$RULES_LINK"
    echo "rules symlink: recreated (was pointing to $current)"
  fi
elif [ -e "$RULES_LINK" ]; then
  echo "Error: $RULES_LINK exists but is not a symlink. Remove it manually." >&2
  exit 1
else
  ln -s "$RULES_TARGET" "$RULES_LINK"
  echo "rules symlink: created"
fi

# --- Per-skill symlinks ---
# Claude Code discovers skills at .claude/skills/<name>/SKILL.md (exactly one level deep).
# A directory symlink would create .claude/skills/nr-ai-standards/<name>/SKILL.md (two levels),
# which Claude Code doesn't discover. So we create per-skill directories with symlinked SKILL.md files.
for skill_dir in "$SUBTREE"/skills/*/; do
  [ -d "$skill_dir" ] || continue
  skill_name=$(basename "$skill_dir")
  skill_link=".claude/skills/$skill_name/SKILL.md"
  # Relative path from .claude/skills/<name>/ up to .claude/, then into subtree
  skill_target="../../nr-ai-standards/skills/$skill_name/SKILL.md"

  # If the skill directory is itself a symlink (e.g. from bootstrap), it already works
  if [ -L ".claude/skills/$skill_name" ]; then
    echo "skill $skill_name: already linked (directory symlink)"
    continue
  fi

  mkdir -p ".claude/skills/$skill_name"

  if [ -L "$skill_link" ]; then
    current=$(readlink "$skill_link")
    if [ "$current" = "$skill_target" ]; then
      echo "skill $skill_name: already correct"
    else
      rm "$skill_link"
      ln -s "$skill_target" "$skill_link"
      echo "skill $skill_name: recreated (was pointing to $current)"
    fi
  elif [ -e "$skill_link" ]; then
    echo "skill $skill_name: skipped (project-owned SKILL.md exists)"
  else
    ln -s "$skill_target" "$skill_link"
    echo "skill $skill_name: created"
  fi
done

echo "Done."
