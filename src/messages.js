/**
 * Centralized message catalog for user-facing warnings, unsupported, and errors.
 *
 * Each message is a keyed function with a JSDoc comment showing the smallest
 * SPL example that triggers it. Handlers call messages.key(...args) instead
 * of inline template literals.
 */

export const messages = {
  // ── extractionHandlers ────────────────────────────────────────────

  // SPL: `* | rex mode=sed field=msg "s/foo/bar/g"`
  rex_sed_unsupported: () => 'rex mode=sed has no NRQL equivalent',

  // SPL: `* | rex`
  rex_parse_failed: () => 'rex command could not be parsed',

  // SPL: `* | rex "no-groups-here"`
  rex_no_groups: () =>
    'rex pattern has no named capture groups; nothing to extract',

  // SPL: `* | rex max_match=0 "(?<a>\\w+)"`
  rex_max_match: () =>
    'rex max_match not supported; NRQL capture() returns first match only',

  // SPL: `* | rex "(?<=prefix)(?<a>\\w+)"`
  rex_lookaround: () =>
    'rex pattern uses lookahead/lookbehind assertions which NRQL capture() does not support; rewrite the regex without lookaround',

  // SPL: `* | rex "(?<a>\\w+)" | rex "(?<b>\\w+)" | ... (6+ rex commands)`
  rex_capture_limit: (count) =>
    `query uses ${count} rex extractions but NRQL capture() is limited to 5 per query; consider using aparse() for anchor-based patterns`,

  // SPL: `* | spath input=message`
  spath_no_path: () =>
    'spath without path= does auto-extraction, which has no NRQL equivalent; specify path= to extract a specific JSON field',

  // SPL: `* | spath input=message path=data.id output=data_id`
  spath_json_only: () =>
    'jparse() only works on JSON data; if the input is XML, use capture() with a regex pattern instead',

  // SPL: `* | regex foo=$bar$` (unquoted RHS or template variable, no quoted pattern)
  regex_command_unparsed: (rawText) =>
    `regex command pattern could not be parsed: ${rawText.trim()}`,

  // ── rowHandlers ───────────────────────────────────────────────────

  // SPL: `* | fields - host`
  fields_exclude_limited: () =>
    'fields - (exclude mode) has limited NRQL support',

  // SPL: `* | sort -duration +host`
  sort_single_field: () =>
    'NRQL ORDER BY supports only one field; additional sort fields ignored',

  // SPL: `* | rename * as prefix_*`
  rename_wildcard: (from, to) =>
    `Wildcard rename (${from} as ${to}) not supported in NRQL; rename specific fields`,

  // SPL: `* | rename eval(x) as y`
  rename_parens: (from) =>
    `Cannot rename field with parentheses in name: "${from}"`,

  // SPL: `* | rename host as hostname`
  rename_keeps_original: () =>
    'NRQL rename keeps original field names alongside aliases',

  // SPL: `* | dedup host`
  dedup_facet_warning: () =>
    'dedup translated to FACET; add latest(field) for each field you want to keep',

  // SPL: `* | dedup userId | stats count by routeName`
  dedup_limit_max_cap: () =>
    'dedup translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields',

  // SPL: `* | dedup userId | timechart count span=1m`
  dedup_timeseries_warning: () =>
    'dedup with timechart: TIMESERIES on a nested subquery only populates the first time bucket; remaining buckets return null. Consider using uniqueCount() per time bucket instead of nested dedup.',

  // SPL: `* | bin size span=10`
  bin_unsupported: () =>
    'bin command not fully supported; use TIMESERIES for time or histogram() for numeric fields',

  // SPL: `* | stats count | reverse`
  reverse_after_agg: () =>
    'reverse after aggregation may not produce correct results; NRQL ORDER BY timestamp ASC does not match SPL row-order reversal',

  // SPL: `* | fillnull value=0`
  fillnull_no_fields: () =>
    'fillnull without field list not supported — NRQL requires explicit field names',

  // SPL: `* | convert badcmd(x)`
  convert_parse_failed: (rawText) =>
    `convert command could not be fully parsed: ${rawText}`,

  // SPL: `* | convert auto(bytes)`
  convert_auto_unsupported: (field) =>
    `convert auto(${field}) is not supported; NRQL has no auto-type-detection function`,

  // SPL: `* | convert dur2sec(elapsed)`
  convert_dur2sec_unsupported: (field) =>
    `convert dur2sec(${field}) is not supported; NRQL has no duration string parser`,

  // SPL: `* | convert mstime(duration)`
  convert_mstime_unsupported: (field) =>
    `convert mstime(${field}) is not supported; NRQL has no mm:ss.ms parser`,

  // SPL: `* | convert rmunit(size)`
  convert_func_unsupported: (func, field) =>
    `convert ${func}(${field}) not supported in NRQL`,

  // SPL: `* | convert num(bytes)` (when field already exists)
  convert_alias_warning: (func, field, outputName) =>
    `convert ${func}(${field}): NRQL cannot overwrite a field in-place; aliased to ${outputName}`,

  // SPL: `* | strcat host`
  strcat_too_few_args: () => 'strcat requires at least 2 arguments',

  // SPL: `* | mvexpand perms`
  mvexpand_unsupported: () =>
    'mvexpand is not supported; NRQL cannot expand multivalue fields into separate rows',

  // SPL: `* | spath path=Items{} | mvexpand items | spath path=Channels{} | mvexpand channels`
  mvexpand_cascading: () =>
    'cascading mvexpand (expand-then-expand) not directly supported; use nested FROM with EXPAND at each level as a workaround',

  // SPL: `* | mvexpand validations | mvexpand items | where val_sku=sku_data_sku`
  mvexpand_cross_field: () =>
    'expanding and matching across two different arrays in the same event is not supported in NRQL; split into separate queries',

  // SPL: `* | uniq`
  uniq_unsupported: () => 'uniq has no direct NRQL equivalent',

  // ── evalHandlers ──────────────────────────────────────────────────

  // SPL: `* | eval x = someUnsupportedExpr`
  eval_not_supported: (rawText) => `eval expression not supported: ${rawText}`,

  // SPL: `* | eval x = len(mvfield)`
  eval_length_warning: () =>
    'length() returns string length in NRQL, not multivalue count; results may differ for non-array fields',

  // SPL: `* | eval x = replace(msg, "\\d+", "N")`
  eval_replace_regex: (pattern) =>
    `replace() with regex pattern '${pattern}' not supported — NRQL replace() is literal-only`,

  // SPL: `* | eval x = mvjoin(tags, ",")`
  eval_mvjoin_unsupported: () =>
    'mvjoin() has no NRQL equivalent — NRQL cannot join array elements into a delimited string',

  // SPL: `* | eval x = mvindex(field)`
  eval_mvindex_args: () =>
    'mvindex() requires at least 2 arguments (field, index)',

  // SPL: `* | eval parts = split(field, "},{")`
  split_multi_char_delimiter: (delimiter) =>
    `split() with multi-character delimiter '${delimiter}' not supported; NRQL split() accepts single characters only`,

  // SPL: `* | eval paired = mvzip(nodes, skus)`
  mvzip_unsupported: () =>
    'mvzip() has no NRQL equivalent; cannot zip two arrays element-wise into paired tuples',

  // SPL: `* | eval last = mvindex(result, mvcount(result)-1)`
  mvindex_last_element: () =>
    'mvindex with computed index (e.g., mvcount-1 for last element) not supported; NRQL jparse() does not support negative array indexing',

  // SPL: `* | eval x = typeof(field)`
  eval_func_unsupported: (name) =>
    `eval function ${name}() has no NRQL equivalent`,

  // ── enrichmentHandlers ────────────────────────────────────────────

  // SPL: `* | join type=outer host [search *]`
  join_outer_unsupported: () =>
    'NRQL does not support full outer join; only INNER and LEFT joins are available',

  // SPL: `* | join host [search * | badcommand]`
  join_parse_failed: (msg) => `join subsearch could not be parsed: ${msg}`,

  // SPL: (subsearch warning forwarded through join)
  join_subsearch_warning: (w) => `join subsearch: ${w}`,

  // SPL: (subsearch unsupported forwarded through join)
  join_subsearch_unsupported: (u) => `join subsearch: ${u}`,

  // SPL: `* | join host [search *]`
  join_needs_fields: () =>
    'Subsearch joins require explicit fields. Add a table or fields command to specify which fields to bring over',

  // SPL: `* | join host [search * | stats avg(duration) by host]`
  join_cardinality_limit: () =>
    'NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit',

  // SPL: `* | appendpipe [search * | badcommand]`
  appendpipe_parse_failed: (msg) =>
    `appendpipe subsearch could not be parsed: ${msg}`,

  // SPL: `* | appendpipe [stats count | where count=0]`
  appendpipe_empty_guard: () =>
    'appendpipe empty-result guard removed; NRQL returns empty results natively',

  // SPL: `* | appendpipe [stats sum(bytes) as total]`
  appendpipe_row_append: () =>
    'appendpipe adds summary rows to results; NRQL cannot append rows to a query. ' +
    'The sub-pipeline aggregation is available as a nested query, but the "append as new row" behavior must be handled by the UI.',

  // SPL: `* | append [search * | badcommand]`
  append_parse_failed: (label, msg) =>
    `${label} subsearch could not be parsed: ${msg}`,

  // SPL: (subsearch warning forwarded through append/appendcols)
  append_subsearch_warning: (label, w) => `${label} subsearch: ${w}`,

  // SPL: (subsearch unsupported forwarded through append/appendcols)
  append_subsearch_unsupported: (label, u) => `${label} subsearch: ${u}`,

  // SPL: `* | append [search * | table host]` (no aggregation)
  append_no_agg: (label) =>
    `${label} with subsearch cannot be automatically translated; consider using filter() to compute multiple aggregations in a single query, or use separate widgets for each data source`,

  // SPL: `* | stats count by host | append [search * | stats count by status]`
  append_facet_mismatch: (label, mainDesc, subDesc) =>
    `${label} with subsearch has mismatched FACET: main groups by ${mainDesc}, subsearch groups by ${subDesc}`,

  // SPL: `* | stats count by host | append [search * | stats dc(status) by host]`
  append_merged: (label) =>
    `${label} merged into a single query; SPL append runs the subsearch independently, but here both sides query the same events`,

  // SPL: `index=web | stats count | append [search index=api | stats count]`
  append_filter_warning: (label) =>
    `${label} translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log`,

  // SPL: `* | inputlookup geo_data.csv` / `* | lookup users_lookup user`
  lookup_upload_reminder: (table) =>
    `Ensure lookup table '${table}' is uploaded via the Lookups UI`,

  // SPL: `* | inputlookup data.csv where status=200`
  inputlookup_where_warning: () =>
    'inputlookup WHERE condition translated as-is; verify field names match the lookup table schema',

  // SPL: `| where _time >= now()`
  where_time_future_bound_unsupported: () =>
    'where _time >= now() (lower bound at/after present) matches no historical events; NRQL SINCE now does not compile',

  // SPL: `| where _time = now()`
  where_time_point_unsupported: () =>
    'where _time = now() (point-in-time, matches nothing) / != now() (degenerate no-op) has no NRQL SINCE/UNTIL equivalent',

  // SPL: `| where _time > relative_time(eventField, "-1d")`
  where_relative_time_nonliteral_unsupported: () =>
    'relative_time() with a non-now() anchor is a per-event value, not a static SINCE/UNTIL bound',

  // SPL: `| where _time > relative_time(now(), "-7d")` when earliest=/latest= already set
  where_time_constraints_collapsed: () =>
    'multiple time constraints collapsed into one SINCE/UNTIL (last-writer-wins)',

  // ── splExprUtils mapFunction warnings ────────────────────────────

  // SPL: `* | stats stdevp(latency) by host`
  stdevp_precision: () =>
    'SPL stdevp() is population stddev; mapped to NRQL stddev() which is sample stddev. Results may differ.',

  // SPL: `* | stats exactperc95(latency) by host`
  perc_precision: (variant, n) =>
    `SPL ${variant}${n}() mapped to NRQL percentile(); precision may differ`,

  // SPL: `* | stats mode(status) by host`
  no_equiv_func: (name) => `SPL ${name}`,

  // SPL: `* | stats xyzfunc(field) by host`
  unknown_stats_func: (name) =>
    `SPL function ${name}() has no known NRQL equivalent`,

  // ── aggregationHandlers ───────────────────────────────────────────

  // SPL: `* | top 10 status by host`
  top_groupby_warning: () =>
    'top with groupBy: NRQL FACET groups all fields together; SPL groups within each by-field value',

  // SPL: `* | top useother=true status`
  top_useother: () =>
    'useother: NRQL pie chart automatically shows an "Other" category for values outside LIMIT',

  // SPL: `* | eventstats avg(duration) as avg_dur`
  eventstats_scalar_subquery: () =>
    'eventstats without BY translated as scalar subquery in SELECT; ' +
    'for percentage calculations, use the subquery result in downstream eval',

  // SPL: `* | eventstats count by host, status`
  eventstats_multi_by: (fields) =>
    `eventstats with multiple BY fields (${fields}) cannot be translated; NRQL subquery JOIN only supports a single ON key`,

  // ── splToIR ───────────────────────────────────────────────────────

  // SPL: `* latest=-1h`
  latest_without_earliest: () =>
    'SPL latest without earliest defaults to 24h lookback in Splunk; added SINCE 24 hours ago to match',

  // SPL: `_raw=*error*`
  raw_mapped_to_message: () =>
    '_raw is not a valid NRQL field; mapped to message',

  // SPL: `` `my_macro` ``
  macro_translated: (name, nrqlMacro) =>
    `SPL macro \`${name}\` translated to NRQL macro ${nrqlMacro}; ensure a matching NRQL macro exists`,

  // SPL: `NOT [search index=exclude | fields host]`
  not_inputlookup_translated: (csvFile, tableName) =>
    `NOT [|inputlookup ${csvFile}] translated to NOT IN lookup subquery. ` +
    `Replace {{column}} with the exclusion field name from ${csvFile}. ` +
    `Upload the CSV to New Relic Lookup tables as '${tableName}'.`,

  // SPL: `NOT [search index=other | stats count]`
  not_subsearch_unsupported: () =>
    'NOT [subsearch] exclusion pattern; manually convert to NOT IN or WHERE NOT conditions in NRQL',

  // SPL: (subsearch warning forwarded)
  subsearch_warning: (w) => `subsearch: ${w}`,

  // SPL: (subsearch unsupported forwarded)
  subsearch_unsupported: (u) => `subsearch: ${u}`,

  // SPL: `[search invalid | badcmd]`
  subsearch_parse_failed: (msg) => `[subsearch] could not be parsed: ${msg}`,

  // SPL: `* | where like(field, "%x%") AND status=500` (when like() fails)
  search_func_unsupported: (name) =>
    `SPL function '${name}()' in search expression could not be translated`,

  // SPL: (unknown AST node in search expression)
  search_unknown_node: (type) => `Unknown search node type: ${type}`,

  // SPL: `* | stats count | predict count` (without timechart)
  predict_needs_timeseries: () =>
    'PREDICT requires TIMESERIES; added TIMESERIES AUTO automatically',

  // SPL: `| tstats count from datamodel=Web`
  tstats_unsupported: () =>
    'tstats queries target Splunk CIM data models which normalize events from multiple sourcetypes into a standard schema. ' +
    'To translate, identify which sourcetypes populate the data model in your Splunk deployment, then query those events directly using their raw field names.',

  // SPL: `* | stats count by host`
  facet_default_limit: () =>
    'NRQL FACET defaults to 10 groups; Splunk computes all groups by default. Add LIMIT N or LIMIT MAX to include more groups.',

  // SPL: `* | timechart count by f usenull=false`
  usenullNoEquivalent: () =>
    'Splunk timechart usenull option has no NRQL equivalent; null groups are included',

  // SPL: `* | streamstats count as row_num`
  streamstats_unsupported: () =>
    'streamstats has no NRQL equivalent; NRQL does not support row-to-row references (LAG/LEAD) or running aggregations',

  // SPL: `* | kvparse` or `* | extract`
  kvparse_unsupported: () =>
    'key=value extraction from unstructured text has no NRQL equivalent; use Grok parsing rules to extract fields at ingest time, or restructure logs as JSON',

  // SPL: `* | stats list(eventType) by orderId`
  list_order_warning: () =>
    'SPL list() mapped to NRQL uniques(); duplicates are removed and insertion order is not preserved',

  // SPL: `* | timewrap 1d`
  unsupported_command: (name) =>
    `SPL command '${name}' has no known NRQL equivalent`,

  // SPL: (unrecognized command type in AST)
  command_not_implemented: (type) => `command '${type}' not yet implemented`,
};
