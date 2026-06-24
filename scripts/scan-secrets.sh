#!/usr/bin/env bash
# Scan the repo for secrets with gitleaks, using .gitleaks.toml (which extends
# the upstream ruleset with New Relic key patterns ported from rusty-hog).
#
#   scripts/scan-secrets.sh         scan full git history (default)
#   scripts/scan-secrets.sh dir     scan the working tree only (uncommitted too)
#
# gitleaks is an external binary (not an npm dependency). Install it with:
#   brew install gitleaks
# or grab a release from https://github.com/gitleaks/gitleaks/releases
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "error: gitleaks is not installed." >&2
  echo "  macOS:  brew install gitleaks" >&2
  echo "  other:  https://github.com/gitleaks/gitleaks/releases" >&2
  exit 127
fi

mode="${1:-git}"
case "$mode" in
  git) target="git" ;;   # full commit history
  dir) target="dir" ;;   # working tree, including uncommitted files
  *) echo "usage: $0 [git|dir]" >&2; exit 2 ;;
esac

# --redact keeps any found secret out of the logs; non-zero exit on findings.
exec gitleaks "$target" --config .gitleaks.toml --redact --verbose
