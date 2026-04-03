#!/usr/bin/env bash
set -euo pipefail

# gather-project-context.sh
# Concatenates all files in .claude/ (excluding the nr-ai-standards subtree)
# into a single output with filenames as headers.
#
# Run from the project root.

CLAUDE_DIR=".claude"

if [ ! -d "$CLAUDE_DIR" ]; then
  echo "No .claude/ directory found." >&2
  exit 0
fi

# Find all files, excluding the subtree and common binary/large files
find -P "$CLAUDE_DIR" \
  -path "$CLAUDE_DIR/nr-ai-standards" -prune -o \
  \( -type f -o -type l \) -print | sort | while read -r filepath; do

  # Show symlink target if applicable
  if [ -L "$filepath" ]; then
    target=$(readlink "$filepath")
    echo "=== $filepath -> $target (symlink) ==="
  else
    echo "=== $filepath ==="
  fi

  # Print content (skip binary files)
  if file "$filepath" | grep -qiE 'text|json|xml|yaml'; then
    cat "$filepath"
  else
    echo "(binary file, skipped)"
  fi

  echo ""
done
