<a href="https://opensource.newrelic.com/oss-category/#new-relic-experimental"><picture><source media="(prefers-color-scheme: dark)" srcset="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/dark/Experimental.png"><source media="(prefers-color-scheme: light)" srcset="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/Experimental.png"><img alt="New Relic Open Source experimental project banner." src="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/Experimental.png"></picture></a>

# @newrelic/query-bridge

Multi-language query translator — SPL/Lucene/PromQL/PPL to NRQL/Trino. Pure ESM JavaScript, zero runtime dependencies, Node 20+.

## Install

```
npm install @newrelic/query-bridge
```

## Usage

```js
import { translateSplToNrql } from '@newrelic/query-bridge';

const result = translateSplToNrql('index=web status=500 | stats count by host');
console.log(result.nrql);
```

A `spl2nrql` CLI is also installed. See the
[monorepo README](https://github.com/newrelic-experimental/nr-query-bridge#readme)
for the CLI, playground, and full documentation.
