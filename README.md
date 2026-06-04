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
must be _served_ (browsers block module imports over `file://`). From the repo
root:

```bash
npx serve          # or: python3 -m http.server
```

Then open the printed URL with `/docs/playground/` appended. Serve from the
**repo root**, not from inside `docs/playground/` — the page imports
`../../src/index.js`.

## API

```js
import { translateSplToNrqlV2 } from '@datanerd/nr-query-bridge';

const result = translateSplToNrqlV2('index=web status=500 | stats count by host');
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

## License

MIT
