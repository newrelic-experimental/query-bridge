# CLI Tool

The SPL-to-NRQL translator is available as a standalone command-line tool. It requires Node.js 20 or later.

## Quick start

```bash
# From the repo root, build the CLI bundle (one-time, or after spl.js changes):
npm run build:cli

# Translate a query:
node bin/spl2nrql.js "index=web status=500 | stats count by host"

# Pipe from stdin:
echo "index=web | stats count" | node bin/spl2nrql.js

# Interactive REPL:
node bin/spl2nrql.js -i
```

## Install globally (optional)

If you want the `spl2nrql` command available anywhere:

```bash
# From the repo root:
npm link

# Now you can run from any directory:
spl2nrql "index=web | stats count by host"
```

To unlink later: `npm unlink -g @datanerd/shared-component-logs`

## Output formats

By default the tool prints the assembled NRQL string to stdout. Warnings and errors go to stderr so they don't interfere with piping.

```bash
# NRQL string (default):
node bin/spl2nrql.js "index=web | stats count"
# → FROM Log SELECT count(*) WHERE `index` = 'web'

# Full result as JSON:
node bin/spl2nrql.js --json "index=web | stats count"
# → { "where": "`index` = 'web'", "select": ["count(*)"], ... }
```

## Interactive REPL

```
$ node bin/spl2nrql.js -i
SPL-to-NRQL translator. Type .quit or Ctrl-D to exit.
spl> index=web status=500 | stats count by host
FROM Log SELECT count(*) WHERE `index` = 'web' AND (`status` = '500' OR numeric(`status`) = 500) FACET `host`
spl> .quit
```

## Options reference

| Flag | Description |
|---|---|
| `-h`, `--help` | Show help |
| `-i`, `--interactive` | Start interactive REPL |
| `--nrql` | Output assembled NRQL string (default) |
| `--json` | Output full translation result as JSON |
| `--no-telemetry` | Disable usage telemetry for this invocation |

## Usage telemetry (optional)

If you want translated queries logged to NRDB so the team can see what SPL patterns people are translating, create a `.env` file in the repo root:

```bash
cp .env.example .env
# Then edit .env with your values:
```

```
NEW_RELIC_LICENSE_KEY=your_ingest_license_key_here
NEW_RELIC_ACCOUNT_ID=1
```

The license key is write-only (ingest) — it can only send events, not read anything. Translations are sent as `SplToNrqlTranslation` custom events. You can query them with:

```sql
FROM SplToNrqlTranslation SELECT spl, nrql, warningCount, unsupportedCount SINCE 1 week ago
```

To disable telemetry for a single run, use `--no-telemetry`. If no `.env` file exists, telemetry is silently skipped.

## Rebuilding the bundle

The CLI uses a pre-built bundle (`bin/spl2nrql-bundle.cjs`) checked into the repo. After editing `spl.js`, `spl.grammar`, or `nrqlEncoding.js`, rebuild it:

```bash
npm run build:cli
```

This uses `esbuild` (downloaded on demand via `npx`) to bundle the ESM translator into a single CJS file.
