#!/usr/bin/env bash
# Discover projects under one or more parent directories.
# Usage: ./discover.sh <parent-dir> [<parent-dir2> ...]
# Output: TSV lines — TYPE|NAME|DETAIL1|DETAIL2
#   INTEGRATED|name|version
#   CANDIDATE|name|stack|last_commit_date
#   SKIPPED_DIR|name  (non-project directories silently skipped)

set -uo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: discover.sh <parent-dir> [<parent-dir2> ...]" >&2
  exit 1
fi

GIT_USER_EMAIL=$(git config user.email 2>/dev/null || echo "")

for parent in "$@"; do
  # Resolve to absolute path
  if [[ ! "$parent" = /* ]]; then
    parent="$(cd "$parent" && pwd)"
  fi

  for d in "$parent"/*/; do
    [[ -d "$d" ]] || continue
    name=$(basename "$d")

    # Skip non-project dirs
    case "$name" in
      node_modules|.git|vendor|target|build|dist|.cache|.npm|.nvm) continue;;
    esac

    # Already integrated?
    if [[ -f "$d/.claude/.nr-ai-standards-version" ]]; then
      ver=$(tr -d '[:space:]' < "$d/.claude/.nr-ai-standards-version")
      echo "INTEGRATED|$name|$ver|$d"
      continue
    fi

    # Check if it looks like a code project
    has_code=false
    for bf in package.json build.gradle build.gradle.kts pom.xml Cargo.toml go.mod Gemfile mix.exs pyproject.toml Makefile CMakeLists.txt Rakefile; do
      if [[ -f "$d/$bf" ]]; then
        has_code=true
        break
      fi
    done
    for sd in src lib app; do
      [[ -d "$d/$sd" ]] && has_code=true
    done

    if ! $has_code; then
      continue  # silently skip non-code directories
    fi

    # Detect stack
    stack=""
    [[ -f "$d/package.json" ]] && stack="JS/Node"
    [[ -f "$d/build.gradle" || -f "$d/build.gradle.kts" ]] && stack="Java/Gradle"
    [[ -f "$d/pom.xml" ]] && stack="Java/Maven"
    [[ -f "$d/go.mod" ]] && stack="Go"
    [[ -f "$d/Gemfile" ]] && stack="Ruby"
    [[ -f "$d/pyproject.toml" ]] && stack="Python"
    [[ -f "$d/Cargo.toml" ]] && stack="Rust"
    [[ -f "$d/mix.exs" ]] && stack="Elixir"
    [[ -f "$d/Makefile" && -z "$stack" ]] && stack="Make"
    [[ -z "$stack" ]] && stack="unknown"

    # Last commit date
    last_commit=$(git -C "$d" log -1 --format=%ci 2>/dev/null || echo "no-git")

    # Check if read-only clone (no local branches beyond default, no commits by user)
    is_readonly="false"
    if [[ -n "$GIT_USER_EMAIL" && "$last_commit" != "no-git" ]]; then
      local_branches=$(git -C "$d" branch --list 2>/dev/null | wc -l | tr -d ' ' || echo "0")
      local_branches=${local_branches:-0}
      user_commits=$(git -C "$d" log --author="$GIT_USER_EMAIL" --since="6 months ago" --oneline 2>/dev/null | head -1 || true)
      if [[ "$local_branches" -le 1 && -z "$user_commits" ]]; then
        is_readonly="true"
      fi
    fi

    echo "CANDIDATE|$name|$stack|$last_commit|$is_readonly|$d"
  done
done
