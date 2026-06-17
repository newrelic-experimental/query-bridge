<a href="https://opensource.newrelic.com/oss-category/#new-relic-experimental"><picture><source media="(prefers-color-scheme: dark)" srcset="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/dark/Experimental.png"><source media="(prefers-color-scheme: light)" srcset="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/Experimental.png"><img alt="New Relic Open Source experimental project banner." src="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/Experimental.png"></picture></a>

# nr-query-bridge

Multi-language query translator — SPL/Lucene/PromQL/PPL to NRQL/Trino.

Pure ESM JavaScript, zero runtime dependencies, Node 20+.

## Install

```
npm install @datanerd/nr-query-bridge
```

## CLI

```bash
# Translate a query
spl2nrql "index=web status=500 | stats count by host"

# Pipe from stdin
echo "index=web | stats count" | spl2nrql

# Interactive REPL
spl2nrql -i
```

## Playground

An interactive browser playground lets you paste SPL and see the live NRQL
translation, with color-coded warnings and unsupported messages.

**Live:** published via GitHub Pages once enabled — see the `Deploy Pages`
workflow run output for the URL (path: `…/docs/playground/`).

**Local:** the playground imports the translator as a native ES module, so it
must be _served_ (browsers block module imports over `file://`). From the
translator package directory (`packages/nr-query-bridge`):

```bash
cd packages/nr-query-bridge
npx serve          # or: python3 -m http.server
```

Then open the printed URL with `/docs/playground/` appended. Serve from the
**package root** (`packages/nr-query-bridge`), not from inside `docs/playground/`
— the page imports `../../src/index.js`.

## API

```js
import { translateSplToNrql } from '@datanerd/nr-query-bridge';

const result = translateSplToNrql('index=web status=500 | stats count by host');
console.log(result.nrql);
// FROM Log SELECT count(*) WHERE index = 'web' AND status = '500' OR numeric(status) = 500 FACET host

if (result.warnings.length) {
  console.warn(result.warnings);
}
```

## Test

```
npm test
```

## Packaging & distribution

Do **not** hand-zip the working directory. It sweeps in `node_modules` (~110MB), the
`.git` folder, and — critically — `docs/local/`, which is gitignored and contains
private data that must never leave the repo. Use a method that ships only what belongs:

- **Consumable package** (what a dependant installs) — ships only the `files` field:
  ```
  npm pack
  ```
- **Source tree** (tracked files at HEAD, no deps, no history, no gitignored paths):
  ```
  git archive --format=zip --prefix=nr-query-bridge/ -o ../nr-query-bridge.zip HEAD
  ```
- **Verify before sending** — must print `0`:
  ```
  unzip -l ../nr-query-bridge.zip | grep -cE 'node_modules/|docs/local/'
  ```

Both `npm pack` and `git archive` exclude gitignored paths automatically, so
`docs/local/` stays out without manual excludes.

## A note about vulnerabilities

As noted in our [security policy](../../security/policy), New Relic is committed to the privacy and security of our customers and their data. If you believe you have found a security vulnerability, report it to New Relic through [HackerOne](https://hackerone.com/newrelic).

## License

Apache-2.0
