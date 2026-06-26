#!/usr/bin/env bash
#
# Scan tracked content for customer-identifying names before they can be
# committed — defense-in-depth alongside gitleaks (which only covers secrets).
#
# The denylist is intentionally NOT tracked in this (public-bound) repo:
# committing customer names to block customer names would leak them. Its
# canonical, version-controlled home is the PRIVATE corpus repo, resolved below
# at ../nr-query-bridge-corpus/customer-denylist.txt. A CUSTOMER_DENYLIST env var
# or a local docs/local/ copy take precedence. When no denylist is found — any
# contributor without the corpus sibling, or the public mirror — the scan SKIPS
# and never blocks.
#
# Usage:
#   scripts/scan-customer-names.sh          # scan the staged index (pre-commit)
#   scripts/scan-customer-names.sh --tree   # scan the whole HEAD tree (CI)
set -euo pipefail

# Resolve the denylist: explicit env override, then a local docs/local/ copy,
# then the canonical copy in the sibling corpus repo (version-controlled there,
# so it can't be lost like the original scrub-mappings.yml was).
DENYLIST="${CUSTOMER_DENYLIST:-}"
if [ -z "$DENYLIST" ]; then
  for cand in docs/local/customer-denylist.txt ../nr-query-bridge-corpus/customer-denylist.txt; do
    if [ -s "$cand" ]; then DENYLIST="$cand"; break; fi
  done
fi

if [ -z "$DENYLIST" ] || [ ! -s "$DENYLIST" ]; then
  echo "customer-name scan: no denylist found (env / docs/local / corpus sibling) — skipping (not a failure)."
  exit 0
fi

# Active patterns = non-comment, non-blank lines.
patterns="$(grep -vE '^[[:space:]]*(#|$)' "$DENYLIST" || true)"
if [ -z "$patterns" ]; then
  echo "customer-name scan: denylist empty — skipping."
  exit 0
fi

scope=(--cached)
[ "${1:-}" = "--tree" ] && scope=(HEAD)

pat_file="$(mktemp)"
trap 'rm -f "$pat_file"' EXIT
printf '%s\n' "$patterns" >"$pat_file"

# -F fixed strings (denylist entries are literal, not regex), -i case-insensitive,
# -I skip binary, -n line numbers. `-f <patfile>` MUST precede the <rev> in
# scope[] (e.g. `-f file HEAD`), or git parses the flag as a bad revision.
# git grep exits 0 on match, 1 on no match, ≥2 on error — an ERROR must NOT be
# read as "clean", so branch on the exact code rather than truthiness.
git grep -iInF -f "$pat_file" "${scope[@]}" -- . ':(exclude)docs/local/' && rc=0 || rc=$?
if [ "${rc:-0}" -eq 0 ]; then
  echo ""
  echo "ERROR: customer-identifying string(s) found in tracked content (above)."
  echo "Scrub them before committing. Denylist: $DENYLIST"
  exit 1
elif [ "$rc" -eq 1 ]; then
  echo "customer-name scan: clean."
else
  echo "ERROR: customer-name scan could not run (git grep exit $rc) — NOT treating as clean." >&2
  exit 2
fi
