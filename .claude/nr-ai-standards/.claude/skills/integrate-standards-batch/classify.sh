#!/usr/bin/env bash
# Wrapper: classify discover.sh output into tiers.
# Usage: discover.sh .. | bash classify.sh [--skip-config <path>]
# Delegates to classify.py in the same directory.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$SCRIPT_DIR/classify.py" "$@"
