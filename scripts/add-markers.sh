#!/usr/bin/env bash
set -euo pipefail

# add-markers.sh
# Adds AI-DEV markers to all .md files in rules/.
# Idempotent: skips files that already have the marker.

MARKER='<!-- AI-DEV: This file is managed by nr-ai-standards via git subtree. Do NOT edit directly. To override a specific rule, ask Claude: "Override [rule name] from this file" and it will create a project-level override in .claude/rules/ -->'

for f in rules/*.md; do
  [ -f "$f" ] || continue
  if head -1 "$f" | grep -q 'AI-DEV:'; then
    echo "skip (already has marker): $f"
    continue
  fi
  tmp=$(mktemp)
  echo "$MARKER" > "$tmp"
  echo '' >> "$tmp"
  cat "$f" >> "$tmp"
  mv "$tmp" "$f"
  echo "added marker: $f"
done
