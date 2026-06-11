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

Apache-2.0
