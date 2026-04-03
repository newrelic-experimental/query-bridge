#!/usr/bin/env bash
# Quick verification of nr-ai-standards integration in a target project.
# Usage: ./verify.sh <target-project-path>
# Runs from the nr-ai-standards repo root.

set -euo pipefail

TARGET="${1:?Usage: verify.sh <target-project-path>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# .claude/skills/verify-integration/ -> git root is 3 levels up
GIT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REF_DIR="$GIT_ROOT/.claude/skills/integrate-standards/references"

# Resolve target to absolute path (relative to cwd, not script location)
if [[ ! "$TARGET" = /* ]]; then
  TARGET="$(cd "$TARGET" && pwd)"
fi

echo "## nr-ai-standards Verification Report"
echo ""

# === VERSION ===
current=$(cat "$GIT_ROOT/VERSION")
if [[ -f "$TARGET/.claude/.nr-ai-standards-version" ]]; then
  installed=$(cat "$TARGET/.claude/.nr-ai-standards-version" | tr -d '[:space:]')
else
  installed="NOT FOUND"
fi
echo "**Target:** $TARGET"
echo "**Installed version:** $installed"
echo "**Current version:** $current"
if [[ "$installed" == "$current" ]]; then
  echo "**Status:** UP TO DATE"
else
  echo "**Status:** BEHIND (see CHANGELOG)"
fi
echo ""

# === RULES ===
echo "### Rules Coverage"
echo ""
echo "| File | Ref Lines | Diff Lines | Installed Lines | Status |"
echo "|---|---|---|---|---|"

issues=()

for f in "$REF_DIR"/*.md; do
  name=$(basename "$f")
  [[ "$name" == "claude-md.md" ]] && continue

  inst_name="$name"
  installed_file="$TARGET/.claude/rules/$inst_name"

  if [[ ! -f "$installed_file" ]]; then
    echo "| $name | — | — | — | **MISSING** |"
    issues+=("$name: no corresponding installed file")
    continue
  fi

  ref_lines=$(grep -c . "$f" || true)
  inst_lines=$(grep -c . "$installed_file" || true)
  diff_lines=$(diff "$f" "$installed_file" 2>/dev/null | grep -c '^[<>]' || true)

  # Rough match: if diff lines are less than 40% of ref, it's OK
  threshold=$(( ref_lines * 40 / 100 ))
  if [[ $diff_lines -gt $threshold ]]; then
    status="**REVIEW** ($diff_lines diff lines > 40% of ref)"
    issues+=("$inst_name: $diff_lines diff lines vs $ref_lines ref lines")
  else
    status="OK"
  fi
  echo "| $inst_name | $ref_lines | $diff_lines | $inst_lines | $status |"
done

echo ""

# === SETTINGS ===
echo "### Settings Coverage"
ref_settings="$REF_DIR/settings.json"
inst_settings="$TARGET/.claude/settings.json"

if [[ -f "$inst_settings" && -f "$ref_settings" ]]; then
  if settings_result=$(python3 -c "
import json, sys
ref = set(json.load(open('$ref_settings'))['permissions']['allow'])
inst = set(json.load(open('$inst_settings'))['permissions']['allow'])
missing = ref - inst
extra = inst - ref
print(f'- Reference entries present: {len(ref - missing)}/{len(ref)}')
print(f'- Project-specific additions: {len(extra)}')
if missing:
    print(f'- **Missing: {\", \".join(sorted(missing))}**')
    sys.exit(1)
else:
    print('- Missing: none')
"); then
    echo "$settings_result"
  else
    echo "$settings_result"
    issues+=("Settings: missing reference entries")
  fi
else
  echo "- **Settings file missing**"
  issues+=("Settings file missing")
fi

echo ""

# === SKILLS ===
echo "### Skills Coverage"
echo ""
for skill_ref in "$REF_DIR"/skills/*.md; do
  skill_name=$(basename "$skill_ref" .md)
  inst_skill="$TARGET/.claude/skills/$skill_name/SKILL.md"
  if [[ -f "$inst_skill" ]]; then
    echo "- **$skill_name**: installed"
  else
    echo "- **$skill_name**: **MISSING**"
    issues+=("Skill $skill_name: not installed")
  fi
done

echo ""

# === CLAUDE.md ===
echo "### CLAUDE.md Structure"
claudemd="$TARGET/CLAUDE.md"
checks=0
total=7
if [[ -f "$claudemd" ]]; then
  lines=$(wc -l < "$claudemd" | tr -d ' ')

  grep -qi "overview\|^# " "$claudemd" && ((checks++)) || true
  grep -q "@" "$claudemd" && ((checks++)) || true
  grep -qi "test\|lint\|build" "$claudemd" && ((checks++)) || true
  [[ $lines -lt 200 ]] && ((checks++)) || true
  grep -q "\.claude/rules" "$claudemd" && ((checks++)) || true

  # Check no section > 30 lines (rough: count lines between ## headings)
  max_section=$(awk '/^## /{if(n>0)print c; c=0; n++; next}{c++}END{print c}' "$claudemd" | sort -rn | head -1)
  [[ ${max_section:-0} -le 30 ]] && ((checks++)) || true

  # Check timeless (no plans/tasks/debug)
  if ! grep -qi "TODO\|FIXME\|plan:\|task list\|debugging session" "$claudemd"; then
    ((checks++))
  fi

  echo "$checks/$total checks passing ($lines lines)"
else
  echo "**MISSING**"
  issues+=("CLAUDE.md missing")
fi

echo ""

# === AGENTS.md ===
echo -n "### AGENTS.md: "
if [[ -L "$TARGET/AGENTS.md" ]]; then
  link=$(readlink "$TARGET/AGENTS.md")
  if [[ "$link" == "CLAUDE.md" ]]; then
    echo "OK (symlink -> CLAUDE.md)"
  else
    echo "SYMLINK but points to $link (expected CLAUDE.md)"
    issues+=("AGENTS.md symlink points to $link")
  fi
elif [[ -f "$TARGET/AGENTS.md" ]]; then
  echo "**NOT A SYMLINK** (regular file)"
  issues+=("AGENTS.md is a regular file, should be symlink to CLAUDE.md")
else
  echo "**MISSING**"
  issues+=("AGENTS.md missing")
fi

echo ""

# === .gitignore ===
echo -n "### .gitignore: "
if grep -q "settings.local.json" "$TARGET/.gitignore" 2>/dev/null; then
  echo "OK"
else
  echo "**MISSING** .claude/settings.local.json entry"
  issues+=(".gitignore missing settings.local.json")
fi

echo ""

# === ISSUES ===
echo "### Issues Found"
if [[ ${#issues[@]} -eq 0 ]]; then
  echo "- None"
  echo ""
  echo "**Integration verified. All files match references.**"
else
  for issue in "${issues[@]}"; do
    echo "- $issue"
  done
  echo ""
  echo "Run \`/integrate-standards\` to fix issues."
fi
