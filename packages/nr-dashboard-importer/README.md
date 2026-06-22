<a href="https://opensource.newrelic.com/oss-category/#new-relic-experimental"><picture><source media="(prefers-color-scheme: dark)" srcset="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/dark/Experimental.png"><source media="(prefers-color-scheme: light)" srcset="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/Experimental.png"><img alt="New Relic Open Source experimental project banner." src="https://github.com/newrelic/opensource-website/raw/main/src/images/categories/Experimental.png"></picture></a>

# @newrelic/dashboard-importer

Import Splunk dashboards into New Relic. Translates a Splunk **Simple XML** dashboard export into runnable New Relic **Terraform**, bridging each panel's SPL through [`@newrelic/query-bridge`](https://www.npmjs.com/package/@newrelic/query-bridge). Node 20+.

**Experimental.** This is an early vertical slice: Terraform output only, line/table/billboard widgets, no template variables. Untranslatable panels are preserved as markdown placeholders rather than dropped.

## Install

```
npm install @newrelic/dashboard-importer
```

## Usage

```
spl-dashboard dashboard.xml --account 12345 --out ./terraform
```

Reads a Splunk Simple XML file (or stdin) and writes `<slug>.tf`, `versions.tf`, `variables.tf`, and a `<slug>.report.md` coverage summary to the output directory (default `.`). Omit `--account` to emit `account_id = var.account_id` instead of a baked literal.

See the
[monorepo README](https://github.com/newrelic-experimental/nr-query-bridge#readme)
for the full pipeline, supported syntax, and the translator it builds on.
