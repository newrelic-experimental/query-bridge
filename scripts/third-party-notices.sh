#!/usr/bin/env bash
# Regenerate THIRD_PARTY_NOTICES.md and third_party_manifest.json.
#
# The `oss` CLI walks ./node_modules from its working directory, and npm
# workspaces hoists every package to the repo root — so it finds zero
# dependencies both here and inside a package directory. Hence the isolated tree.
# Pin it to what the lockfile resolved: re-resolving would document versions that
# are not what ships, because some ranges float.
#
# `lastUpdated` is stripped so output is byte-identical across runs, which is
# what lets CI gate staleness by regenerating and diffing (`npm run
# verify:notices`). Committing the regenerated files from CI instead would need a
# token that can bypass branch protection, and this repo has no bypass actors.
set -euo pipefail
cd "$(dirname "$0")/.."

build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
export PATH="$PWD/node_modules/.bin:$PATH"

npm ls --all --omit=dev --json \
  -w @newrelic/query-bridge \
  -w @newrelic/dashboard-importer |
  jq '[paths(objects) as $p | select(($p | last) != "dependencies")
       | {n: ($p | last), v: (getpath($p).version // empty)}]
      | map(select(.v)) | map(select(.n | startswith("@newrelic/") | not))
      | {name: "query-bridge-notices", version: "0.0.0",
         dependencies: (unique_by(.n) | map({key: .n, value: .v}) | from_entries)}' \
    >"$build/package.json"

cp third_party_manifest.json THIRD_PARTY_NOTICES_FOOTER.md "$build/"
cd "$build"
npm install --silent --no-audit --no-fund
oss third-party manifest
oss third-party notices
cd - >/dev/null

jq 'del(.lastUpdated)' "$build/third_party_manifest.json" >third_party_manifest.json
cp "$build/THIRD_PARTY_NOTICES.md" THIRD_PARTY_NOTICES.md
echo "regenerated THIRD_PARTY_NOTICES.md ($(jq '.dependencies | length' third_party_manifest.json) direct runtime dependencies)"
