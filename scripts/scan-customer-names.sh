#!/usr/bin/env bash
#
# Scan tracked content for customer-identifying names before they can be
# committed — defense-in-depth alongside gitleaks (which only covers secrets).
#
# The denylist is intentionally NOT tracked: committing customer names in order
# to block customer names would itself leak them. It lives in the gitignored
# docs/local/ (the designated private dir) for local use, or is supplied via the
# CUSTOMER_DENYLIST env var in CI (written from a secret). When no denylist is
# present — any contributor without corpus access, or the public repo — the scan
# SKIPS and never blocks.
#
# Usage:
#   scripts/scan-customer-names.sh          # scan the staged index (pre-commit)
#   scripts/scan-customer-names.sh --tree   # scan the whole HEAD tree (CI)
set -euo pipefail

DENYLIST="${CUSTOMER_DENYLIST:-docs/local/customer-denylist.txt}"

if [ ! -s "$DENYLIST" ]; then
  echo "customer-name scan: no denylist at '$DENYLIST' — skipping (not a failure)."
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
# -I skip binary, -n line numbers. git grep exits 0 on match, 1 on none.
if git grep -iInF "${scope[@]}" -f "$pat_file" -- . ':(exclude)docs/local/'; then
  echo ""
  echo "ERROR: customer-identifying string(s) found in tracked content (above)."
  echo "Scrub them before committing. Denylist: $DENYLIST"
  exit 1
fi

echo "customer-name scan: clean."
