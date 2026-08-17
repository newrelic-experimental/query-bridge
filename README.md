<a href="https://opensource.newrelic.com/oss-category/#new-relic-experimental"><picture><source media="(prefers-color-scheme: dark)" srcset="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/dark/Experimental.png"><source media="(prefers-color-scheme: light)" srcset="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/Experimental.png"><img alt="New Relic Open Source experimental project banner." src="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/Experimental.png"></picture></a>

# query-bridge

Translate Splunk **SPL** queries into New Relic **NRQL**. Pure ESM JavaScript, Node 20+.

> **Status — experimental.** Today the bridge translates **SPL → NRQL**. Its internals are built on a language-neutral intermediate representation, so more input languages (Lucene, PromQL, PPL) and output targets (Trino SQL) are on the roadmap — they are **not implemented yet**.

## Installation

```
npm install @newrelic/query-bridge
```

## Getting Started

Translate an SPL query from the command line:

```bash
spl2nrql "index=web status=500 | stats count by host"
```

Or call the translator from JavaScript:

```js
import { translateSplToNrql } from '@newrelic/query-bridge';

const result = translateSplToNrql('index=web status=500 | stats count by host');
console.log(result.nrql);
// FROM Log SELECT count(*) WHERE index = 'web' AND status = '500' OR numeric(status) = 500 FACET host
```

## Usage

The CLI reads a query as an argument, from stdin, or interactively:

```bash
# Translate a query
spl2nrql "index=web status=500 | stats count by host"

# Pipe from stdin
echo "index=web | stats count" | spl2nrql

# Interactive REPL
spl2nrql -i
```

The result object carries three fields. When a construct has no NRQL equivalent, `result.unsupported` is populated and `result.nrql` is an empty string — the bridge emits no query rather than a wrong one. `result.warnings` flags precision loss where the NRQL is still valid.

```js
if (result.warnings.length) {
  console.warn(result.warnings);
}
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

## Testing

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
  git archive --format=zip --prefix=query-bridge/ -o ../query-bridge.zip HEAD
  ```
- **Verify before sending** — must print `0`:
  ```
  unzip -l ../query-bridge.zip | grep -cE 'node_modules/|docs/local/'
  ```

Both `npm pack` and `git archive` exclude gitignored paths automatically, so
`docs/local/` stays out without manual excludes.

## Support

New Relic has open-sourced this project. This project is provided AS-IS WITHOUT WARRANTY OR DEDICATED SUPPORT. Issues and contributions should be reported to the project here on GitHub.

We encourage you to bring your experiences and questions to the [Explorers Hub](https://discuss.newrelic.com) where our community members collaborate on solutions and new ideas.

## Contributing

We encourage your contributions to improve query-bridge! Keep in mind that when you submit your pull request, you'll need to sign the CLA via the click-through using CLA-Assistant. You only have to sign the CLA one time per project. If you have any questions, or to execute our corporate CLA (required if your contribution is on behalf of a company), please drop us an email at opensource@newrelic.com. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

**A note about vulnerabilities**

As noted in our [security policy](../../security/policy), New Relic is committed to the privacy and security of our customers and their data. If you believe you have found a security vulnerability, report it to New Relic through [HackerOne](https://hackerone.com/newrelic).

## License

query-bridge is licensed under the [Apache 2.0](http://apache.org/licenses/LICENSE-2.0.txt) License.
