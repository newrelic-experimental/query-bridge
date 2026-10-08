/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

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
  // Structured: names the field and sed script so tooling can triage it.
  // (Not "use a parsing rule": New Relic parsing rules extract, they don't substitute.)
  rex_sed_unsupported: (field, script) =>
    `rex mode=sed has no exact NRQL equivalent (field=${field}, sed script '${script}'); NRQL replace() is literal-only and capture() can rebuild only a single anchored or non-global match`,

  // SPL: `* | rex field=uri mode=sed "s/[0-9]+/N/g"` — global, unanchored regex.
  rex_sed_untranslatable: (field, script, reason) =>
    `rex mode=sed on ${field} (sed script '${script}') cannot be translated exactly: ${reason}. NRQL replace() is literal-only; capture() can rebuild one anchored or non-global substitution`,

  // SPL: `* | rex` / `* | rex "(?<a>x)"\"` (stray characters after the regex)
  rex_parse_failed: (rawText) =>
    rawText
      ? `rex command could not be parsed: ${rawText}`
      : 'rex command could not be parsed',

  // SPL: `* | rex "\"cur\":\"(?<cur>[^\"]+)"\"` — the quote closes early, leaving stray
  // characters. Splunk tolerates this; it is a defect in the source query.
  rex_malformed_regex: (rawText) =>
    `rex regex is malformed in the source query (its quoted string ends early and is followed by stray characters): ${rawText}`,

  // SPL: `* | rex field=_raw "(?<a>\\w+)" $extraFilter$` — a token with no pipe before it.
  rex_trailing_token: (token) =>
    `rex is followed by the dashboard token $${token}$ with no pipe; the token carries a search clause resolved only at run time, so the query cannot be translated until it is expanded`,

  // SPL: `* | rex "no-groups-here"`
  rex_no_groups: () =>
    'rex pattern has no named capture groups; nothing to extract',

  // SPL: `* | stats count by m | rex field=m "(?<y>\d)"`
  rex_after_aggregation: (names) =>
    `rex extracting ${names.join(', ')} after an aggregation (stats, dedup, …) cannot be translated: it would read the raw events, not the aggregated rows. Move the rex before the aggregation`,

  // SPL: `* | rex max_match=0 "(?<a>\\w+)"` (max_match=1 is the default and translates)
  rex_max_match: (n) =>
    `rex max_match=${n} not supported; NRQL capture() returns only the first match per event`,

  // SPL: `* | rex "(?<!prefix)(?<a>\\w+)"` (a leading positive lookbehind /
  // trailing positive lookahead translates — it only asserts context)
  rex_lookaround: () =>
    'rex pattern uses lookahead/lookbehind assertions which NRQL capture() does not support; rewrite the regex without lookaround',

  // SPL: `* | rex field=x "(?<a>\\w+)=\\1"` (backreference — \1..\9, \k<name>, (?P=name))
  rex_backreference: () =>
    'rex pattern uses a backreference (\\1, \\k<name>, or (?P=name)), which NRQL capture() does not support; rewrite the regex without backreferences',

  // SPL: any rex pattern RE2 rejects without a more specific message
  rex_re2_incompatible: (reason) =>
    `rex pattern is not compatible with NRQL capture() (RE2): ${reason}; rewrite the regex without the unsupported construct`,

  // SPL: `* | rex field=x "(?>(?<a>\\w+))"`
  rex_atomic_group: () =>
    'rex pattern uses an atomic group (?>...), which NRQL capture() (RE2) does not support; rewrite the regex without atomic groups',

  // SPL: `* | rex field=x "(?<a>\\w++)"`
  rex_possessive_quantifier: () =>
    'rex pattern uses a possessive quantifier (*+, ++, ?+, {n,m}+), which NRQL capture() (RE2) does not support; use a greedy quantifier instead',

  // SPL: `* | rex field=x "(?<a>\\w+)(?1)"`
  rex_recursion: () =>
    'rex pattern uses recursion or a subroutine reference ((?R), (?1), \\g<name>), which NRQL capture() (RE2) does not support',

  // SPL: `* | rex field=x "(?(1)yes|no)(?<a>\\w+)"`
  rex_conditional: () =>
    'rex pattern uses a conditional ((?(1)...)), which NRQL capture() (RE2) does not support',

  // SPL: `* | rex "(?<a>\\w+)" | rex "(?<b>\\w+)" | ... (6+ rex commands)`
  rex_capture_limit: (count) =>
    `query uses ${count} capture() extractions that cannot be rewritten as aparse() (only literal-anchored patterns can), but NRQL allows 5 capture() calls per query`,

  // SPL: six `rex "\"id\":\"(?<id>[^\"]+)\""`-style extractions in one query
  rex_as_aparse: (names) =>
    `rex extraction(s) ${names.join(', ')} translated as aparse() to stay within NRQL's 5 capture() calls; aparse matches the anchor text case-insensitively, where Splunk's rex is case-sensitive`,

  // SPL: `* | spath input=message`
  spath_no_path: () =>
    'spath without path= does auto-extraction, which has no NRQL equivalent; specify path= to extract a specific JSON field',

  // SPL: `* | spath input=message path=data.id output=data_id`
  spath_json_only: () =>
    'jparse() only works on JSON data; if the input is XML, use capture() with a regex pattern instead',

  // SPL: `* | spath | stats count by status` — no path= auto-extract, rewritten to
  // per-field jparse for the enumerable downstream references.
  spath_auto_extract: (fields) =>
    `spath without path= auto-extracts all fields; rewrote downstream reference(s) ${fields} as jparse(<source>, '<field>') — confirm each is a JSON property of the source`,

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

  // SPL: `* | where level=x | rename log.* as * | ... level ...` — `level` exists both
  // before and after the rename, so we can't tell the real field from the stripped form.
  wildcard_rename_ambiguous: (name) =>
    `Wildcard rename is ambiguous for "${name}": it is referenced both before and after the ` +
    'rename, so it cannot be safely attributed to the prefix. Rename the specific field instead.',

  // SPL: two `rename <prefix>.* as *` in one pipeline — competing prefixes.
  wildcard_rename_multiple: () =>
    'More than one wildcard rename in the pipeline; a bare field cannot be attributed to a ' +
    'single prefix. Rename the specific fields instead.',

  // SPL: `* | rename log.* as *` with no downstream reference — the rename is a no-op in NRQL.
  wildcard_rename_dropped: (affix) =>
    `Wildcard rename (${affix}* as *) dropped: no downstream field references it, so fields ` +
    'keep their original names.',

  // SPL: `* | sort -dc(requestId)` with no matching `stats dc(requestId)` before it
  sort_unknown_stats_column: (field) =>
    `sort field '${field}' names a stats output column that no preceding aggregation produces`,

  // SPL: `* | table a Totals*` (no preceding aggregation)
  list_wildcard_field: (command, field) =>
    `${command} wildcard field '${field}' has no NRQL equivalent; NRQL SELECT cannot match attributes by name pattern — list the fields explicitly`,

  // SPL: `* | table _time _raw` — show the raw events.
  list_raw_select_all: (command) =>
    `${command} _raw shows the whole raw event; translated as SELECT * (every attribute of the event — display it as a log table), which may include more columns than the other fields listed`,

  // SPL: `* | table a, max(b)` with no stats before it
  list_stats_column_without_stats: (command, field) =>
    `${command} field '${field}' names a stats output column, but no stats/chart/timechart precedes it`,

  // SPL: `* | stats count by a | table a, b` — b is not produced by the aggregation
  list_column_not_produced: (command, fields) =>
    `${command} column(s) ${fields.join(', ')} are not produced by the preceding aggregation (Splunk shows them empty); skipped`,

  // SPL: `* | stats count by a | table a`
  list_keeps_aggregates: (command) =>
    `${command} lists no aggregate column, but NRQL needs at least one alongside FACET; the aggregate column(s) are still returned`,

  // SPL: `* | stats count by a, b | table a, count`
  list_keeps_facets: (command, facets) =>
    `${command} omits FACET key(s) ${facets.join(', ')}, but NRQL always returns FACET keys; they remain in the output`,

  // SPL: `* | dedup 3 host` — keeps 3 events per key.
  dedup_count_unsupported: (n) =>
    `dedup ${n} keeps ${n} events per key; NRQL FACET returns one row per key, so there is no equivalent (dedup 1 translates)`,

  // SPL: `* | dedup host`
  dedup_facet_warning: () =>
    'dedup translated to FACET; add latest(field) for each field you want to keep',

  // SPL: `* | dedup orderId | stats sum(amount) by region`
  dedup_latest_per_field: (fields) =>
    `dedup translated to FACET with latest() of ${fields.join(', ')}: each field is read from the newest event that has it, while Splunk reads every field from the newest event (they differ only when that event lacks the field)`,

  // SPL: `* | dedup userId | where status>=500 | stats count by host`
  dedup_unique_count: (key) =>
    `dedup ${key} followed by count translated to uniqueCount(${key}) (no nesting, no 5,000-key cap). Differences: uniqueCount is approximate at high cardinality; a ${key} value seen in several groups or time buckets counts once in each (dedup keeps one row); a filter after dedup tests every event with that value, not only the one dedup kept. Exact when duplicate events are copies of one event`,

  // SPL: `* | dedup userId | stats avg(duration) by userId`
  dedup_limit_max_cap: () =>
    'dedup translated as nested FACET with LIMIT MAX; NRQL caps at 5,000 facets which may sample high-cardinality fields',

  // SPL: `* | dedup userId | timechart avg(duration) span=1m`
  dedup_timeseries_warning: () =>
    'dedup with timechart: TIMESERIES on a nested subquery only populates the first time bucket; remaining buckets return null. Consider using uniqueCount() per time bucket instead of nested dedup.',

  // SPL: `* | stats values(status) as s by host | where s>5`
  // A non-scalar aggregate column across a subquery boundary: values/uniques exposes a
  // LIST, median/percentile a KEYED OBJECT. A median/percentile reference in a WHERE or
  // trailing aggregate IS extractable (getField(col,'<N>') — handled, never reaches
  // here); but a LIST has no scalar form, and an eval-projection over a non-scalar that
  // cannot fold flat leaves a bare reference that resolves to null. Loud unsupported.
  eval_after_agg_nonscalar: (field) =>
    `references '${field}', a non-scalar aggregate result (a \`values\`/\`uniques\` list, or a \`median\`/\`percentile\` keyed object that did not fold into the stats step) that cannot be used as a scalar across a subquery boundary; the reference would resolve to null. Compute the value inside the stats step instead.`,

  // SPL: `* | stats count, sum(throughput) as count by host | eval x = count * 2`
  // Two inner aggregates resolve to the same subquery column name; the engine keeps
  // only the last (silent drop). Loud unsupported rather than wrong data.
  subquery_name_collision: (name) =>
    `eval after stats: two aggregates resolve to the same subquery column '${name}', which NRQL would silently collapse to one. Give them distinct aliases before the eval.`,

  // SPL: `* | stats count by host | eval pct = count * 100`
  // eval after stats projects facet keys + computed columns only (option A); the
  // raw aggregate columns are not re-projected. Splunk's eval would keep them, so
  // warn that they are absent from the output rather than dropping them silently.
  eval_after_agg_drops_source: (columns) =>
    `eval after stats: the source aggregate column(s) ${columns.join(', ')} are not in the output — only facet keys and eval results are projected, though Splunk's eval would keep the originals too.`,

  // SPL: `* | stats count by host | head 10 | stats avg(count)`
  // head N = the first N rows in stats output order; a nested-subquery LIMIT N is
  // the top N by aggregate value. Different selections, so no faithful translation.
  head_between_aggregations: () =>
    'head/tail between two aggregations has no NRQL equivalent: SPL keeps the first N rows in stats order, but a nested-subquery LIMIT N keeps the top N by aggregate value. Reorder so the head/tail is not between aggregations.',

  // SPL: `* | stats count by host | where count > 5 | where count < 100`
  // After folding, a residual row-wise SubquerySource inner means the chain cannot
  // be collapsed into legal NRQL. Loud unsupported over non-compiling NRQL.
  // (eval/where/stats AFTER an aggregation are generally supported — this is only
  // the residual shape of a per-row step feeding a further aggregation.)
  compound_collapse_unsupported: () =>
    'Per-row step (eval, rex, …) between two aggregations would have to run inside the nested aggregation, which NRQL does not allow; not yet supported',

  // SPL: `* | stats count by host | eval a=count/60 | eval b=count/120`
  post_agg_column_folded_away: (name) =>
    `Post-aggregation step references '${name}', an aggregate column an earlier eval folded into its own result; reference the eval result instead, or compute both in one eval`,

  // SPL: `* | stats count by uri | eval t=strftime(_time, "%H")`
  post_agg_time_not_grouped: () =>
    "Post-aggregation step references _time, but _time is not in the grouped output (the stats has no 'by _time'; Splunk's own value here is empty) — group by _time (or use timechart) to keep it",

  // SPL: `* | stats count by uri | eval x=bytes*2`
  post_agg_field_not_produced: (name) =>
    `Post-aggregation step references '${name}', which the aggregation does not output (only its BY fields and aggregate columns survive stats)`,

  // SPL: `* | stats count by host | eval a=count/60 | sort count`
  post_agg_sort_on_folded_column: () =>
    'sort after the aggregation uses an aggregate column an earlier eval folded into its result; sort on the eval result instead',

  // SPL: `* | stats count by host | stats sum(count) by region`
  // A trailing aggregating layer over an aggregating inner subquery is legal NRQL
  // re-aggregation ONLY when the outer's FACET keys are a subset of the columns the
  // inner exposes. When the regroup field is not produced by the inner (here `region`
  // was never faceted), NRQL groups on null → silently empty. Loud unsupported over
  // wrong. Time-bucket fields (_time/timestamp/bin-alias) are exempt: TIMESERIES
  // re-supplies them even though they are stripped from the inner facet.
  compound_trailing_regroup_unsupported: (field) =>
    `trailing 'stats … by ${field}' regroups by a field the inner aggregation does not produce; cannot translate faithfully`,

  // SPL: `* | bin size span=10`
  bin_unsupported: () =>
    'bin command not fully supported; use TIMESERIES for time or histogram() for numeric fields',

  // SPL: `* | stats count | reverse`
  reverse_after_agg: () =>
    'reverse after aggregation may not produce correct results; NRQL ORDER BY timestamp ASC does not match SPL row-order reversal',

  // SPL: `* | fillnull value=0`
  fillnull_no_fields: () =>
    'fillnull without field list not supported — NRQL requires explicit field names',

  // SPL: `* | timechart count as n | fillnull value=0 n`
  fillnull_aggregate_zero: (field) =>
    `fillnull on '${field}' dropped: it is a count/sum column, and New Relic already reports an empty bucket as 0`,

  // SPL: `* | stats avg(x) as a by host | fillnull value=0 a`
  fillnull_aggregate_value: (field) =>
    `fillnull on aggregate column '${field}' has no NRQL equivalent: NRQL cannot re-read an aggregate column in the same query, and only count/sum report an empty bucket as 0`,

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

  // SPL: `* | eval a=split(x,",") | mvexpand a | eval b=split(y,",") | mvexpand b`
  expand_cascading_unverified: (count) =>
    `cascading mvexpand emitted as ${count} EXPAND clauses at one query level; this assumes NRQL fans them out as a cartesian product like Splunk, which is NOT yet verified against a flag-enabled account — check the row counts before relying on the result`,
  // SPL: `* | eval parts = split(tags, ",") | mvexpand parts`
  expand_truncation_cap: () =>
    'EXPAND fans out at most 100 elements per event and truncates the rest SILENTLY (the query still runs), so an event whose list is longer than 100 contributes only its first 100 elements',

  // SPL: `* | eval parts = split(tags, ",") | mvexpand parts limit=5`
  expand_limit_ignored: (limit) =>
    `mvexpand limit=${limit} was ignored; NRQL EXPAND has no per-event element limit, only a fixed 100-element cap`,

  // SPL: `* | eval parts = split(tags, ",") | mvexpand parts | join host [...]`
  expand_with_join_unsupported: () =>
    'EXPAND combined with JOIN is not supported; both multiply rows and their interaction is undefined in the current NRQL preview',

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
    `replace() with regex pattern '${pattern}' not supported — NRQL replace() is literal-only, and SPL replace() is global, so only an anchored (^…/…$) pattern can be rebuilt exactly with capture()`,

  // SPL: `* | eval x = mvjoin(tags, ",")`
  eval_mvjoin_unsupported: () =>
    'mvjoin() has no NRQL equivalent — NRQL cannot join array elements into a delimited string',

  // SPL: `* | eval x = mvindex(field)`
  eval_mvindex_args: () =>
    'mvindex() requires at least 2 arguments (field, index)',

  // SPL: `* | eval parts = split(field, "},{")`
  split_multi_char_delimiter: (delimiter) =>
    `split() with multi-character delimiter '${delimiter}' has no NRQL equivalent; NRQL split() rejects a delimiter that is not exactly one character ("split delimiter must be one character")`,

  // SPL: `* | eval parts = split(field, "")`
  split_empty_delimiter: () =>
    'split() with an empty delimiter splits into single characters in Splunk; NRQL split() requires a delimiter of exactly one character',

  // SPL: `* | eval parts = split(field, sepField)`
  split_dynamic_delimiter: () =>
    'split() with a non-literal delimiter cannot be translated; NRQL split() requires a delimiter of exactly one character, which a runtime value cannot be proven to be',

  // SPL: `* | bin duration span=100 | stats count by duration`
  bin_facet_expression: (field, width) =>
    `bin ${field} span=${width} translated as FACET floor(numeric(${field})/${width})*${width}; the group label is the bucket's lower bound, matching Splunk`,

  // SPL: `* | bin duration span=100 | stats count by duration`
  bucket_index_label: (field, width) =>
    `bin ${field} span=${width} translated as FACET floor(numeric(${field})/${width}); the group label is the bucket INDEX, where Splunk labels each group with the bucket's lower bound — multiply by ${width} to compare, or enable the facetEvaluables preview flag to emit the lower bound directly`,

  // SPL: `* | eval parts = split(field, ",")`
  split_element_cap: () =>
    'split() returns at most 256 elements in NRQL; a longer delimited value is silently truncated past the 256th item',

  // SPL: `* | eval x = ltrim(code, "0")`
  trim_charset_unsupported: (func) =>
    `${func}() with a character-set argument has no NRQL equivalent; SPL strips every character in that set, while NRQL trim() only strips whitespace`,

  // SPL: `* | eval big = mvfilter(someAttr > 5)`
  mv_lambda_source_unknown: () =>
    'multivalue function could not be translated: NRQL map()/filter() need a collection that exists within one event (a split(), a jparse() array, or an array literal). A plain attribute or a cross-event values()/uniques() list is rejected',

  // SPL: `* | eval parts = split(x, ",") | eval t = mvmap(parts, sum(parts))`
  map_rejects_aggregator: () =>
    'mvmap() with an aggregate in its body has no NRQL equivalent; NRQL map() takes a one-to-one row-wise transform and rejects an aggregator, which only reduce() accepts',

  // SPL: `* | eval paired = mvzip(nodes, skus)`
  mvzip_unsupported: () =>
    'mvzip() has no NRQL equivalent; cannot zip two arrays element-wise into paired tuples',

  // SPL: `* | eval last = mvindex(result, -1)` / `mvindex(result, mvcount(result)-1)`
  mvindex_last_element: () =>
    'mvindex with a negative or computed index is not supported; NRQL getField() indexes from 0 only and has no negative (from-the-end) form, so there is no faithful last-element translation',

  // SPL: `* | eval sub = mvindex(result, 0, 2)`
  mvindex_range_unsupported: () =>
    'mvindex with a start and end index returns a sublist; NRQL getField() takes one index and has no range form',

  // SPL: `* | eval x = typeof(field)`
  eval_func_unsupported: (name) =>
    `eval function ${name}() has no NRQL equivalent`,

  // SPL: `* | eval s = tostring(bytes, "commas")`
  tostring_format_unsupported: (format) =>
    `tostring() format "${format}" has no NRQL equivalent; NRQL string() takes only a numeric precision`,

  // SPL: `* | eval s = tostring(total, "commas")`
  tostring_commas_grouping_lost: () =>
    'tostring(x, "commas") translated as string(x, 2): rounded to 2 decimal places like Splunk, but without the thousands separators',

  // SPL: `* | where searchmatch("error")`
  searchmatch_raw_event: () =>
    "searchmatch() translated as a search on the message attribute; Splunk matched bare terms against the whole raw event, so terms that only appear in other attributes won't match",

  // SPL: `* | where searchmatch(pattern_field)`
  searchmatch_nonliteral: () =>
    'searchmatch() needs a single quoted search string; a field or expression argument cannot be translated',

  // SPL: `* | where searchmatch("a | b")`
  searchmatch_unparsed: (text) =>
    `searchmatch("${text}") contains search syntax that could not be translated`,

  // SPL: `* | eval t = relative_time(_time, "-1d@d")`
  eval_relative_time_unsupported: () =>
    'relative_time() in eval computes a per-event time and has no NRQL equivalent; to bound the time range use earliest=/latest= or where _time >= relative_time(now(), "<offset>")',

  // SPL: `* | eval x = strftime(_time, "%s")` — a %-code with no Java pattern letter.
  strftime_unmappable_code: (code) =>
    `strftime/strptime format code '${code}' has no Java DateTimeFormatter equivalent; remove it or reformat the field another way`,
  // SPL: `* | eval d = strftime(_time, fmtField)` — format isn't a quoted literal.
  strftime_nonliteral_format: (name) =>
    `${name}() needs a quoted string format literal; a field or expression format can't be precompiled to a Java DateTimeFormatter pattern`,
  // SPL: `* | eval t = strptime(ds, "%Y-%m-%d")` — toTimestamp returns ms, strptime seconds.
  strptime_units_warning: () =>
    'strptime() result divided by 1000: NRQL toTimestamp() returns milliseconds, Splunk strptime() returns seconds',
  // SPL: `* | eval d = strftime(epoch_field, "%Y-%m-%d")` — a non-_time epoch field.
  strftime_epoch_units_warning: () =>
    'strftime() on a non-_time epoch field assumes milliseconds (NRQL timestamp unit); a seconds-epoch field yields a 1970 date — multiply by 1000 to match',

  // ── enrichmentHandlers ────────────────────────────────────────────

  // SPL: `* | join type=outer host [search *]`
  join_outer_unsupported: () =>
    'NRQL does not support full outer join; only INNER and LEFT joins are available',

  // SPL: `* | join type=left a, b [search … | table a b c]`
  join_multi_key: (fields) =>
    `join on multiple keys (${fields}) has no NRQL equivalent; NRQL JOIN … ON supports a single key`,

  // SPL: `* | join id [search index=other | fields id owner]` — raw subsearch, default max=1
  join_max_matches_differ: (max) =>
    `join max=${max} joins each row to at most ${max} subsearch match(es), but NRQL JOIN returns every match (up to 100); if the subsearch can repeat a key, rows will multiply — aggregate the subsearch by the key (e.g. stats latest(x) by key) or use max=0 if every match is intended`,

  // SPL: `* | join [search index=other | fields id owner]` — no key list
  join_no_key: () =>
    'join without a key list joins on every shared field; NRQL JOIN needs a single explicit key — name the key field',

  // SPL: `* | join left=L right=R where L.id=R.user_id [search …]`
  join_where_keys_differ: (left, right) =>
    `join where ${left}=${right} compares differently-named fields; NRQL JOIN … ON only supports the same field name on both sides here`,

  // SPL: `* | join host [search * | badcommand]`
  join_parse_failed: (msg) => `join subsearch could not be parsed: ${msg}`,

  // SPL: (subsearch warning forwarded through join)
  join_subsearch_warning: (w) => `join subsearch: ${w}`,

  // SPL: (subsearch unsupported forwarded through join)
  join_subsearch_unsupported: (u) => `join subsearch: ${u}`,

  // SPL: `* | join type=inner requestId [search "retry"] | timechart count`
  join_key_only_subsearch: (key) =>
    `join subsearch names no fields and nothing later reads one, so it joins on ${key} alone as an existence filter; subsearch fields Splunk would overwrite (_time, host, …) are not carried`,

  // SPL: `* | join max=0 id [search index=other | fields id]`
  join_single_column_subsearch: (key) =>
    `join on ${key}: the subsearch returns a single column, but a NRQL JOIN subquery must select at least 2 values; with max=0 (or a non-key column) there is no faithful key-only form — add another field to the subsearch's fields/table`,

  // SPL: `* | join host [search *]`
  join_needs_fields: () =>
    'Subsearch joins require explicit fields. Add a table or fields command to specify which fields to bring over',

  // SPL: `* | dedup id | join id [search index=other | table id, x] | foo`
  join_after_dedup_reads_unknown: (key) =>
    `join on ${key} after a dedup: the fields read after the join can't be enumerated, so the dedup can't carry the ones the subsearch doesn't supply`,

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

  // SPL: `index=web | stats count | append [search index=payments | stats count]`
  append_cross_source: (label) =>
    `${label} subsearch reads a different index/sourcetype/source than the main search; ` +
    'NR Log has no UNION or multi-source FROM, so one FROM Log query cannot read both datasets',

  // SPL: `* | inputlookup geo_data.csv` / `* | lookup users_lookup user`
  lookup_upload_reminder: (table) =>
    `Ensure lookup table '${table}' is uploaded via the Lookups UI`,

  // SPL: `* | inputlookup data.csv where status=200`
  inputlookup_where_warning: () =>
    'inputlookup WHERE condition translated as-is; verify field names match the lookup table schema',

  // SPL: `| where _time >= now()`
  where_time_future_bound_unsupported: () =>
    "where _time >= now() makes no sense. NRDB doesn't allow future-dated events, so there are no events >= now.",

  // SPL: `| where _time = now()`
  where_time_point_unsupported: () =>
    "where _time = now() makes no sense. NRDB doesn't allow future-dated events, so there are no events = now.",

  // SPL: `| where _time < now()` / `<= now()`
  where_time_tautology_dropped: () =>
    'where _time < now() is a tautology (NRDB stores no future-dated events, so every event precedes now); constraint dropped',

  // SPL: `| where _time < relative_time(now(), "-1d")`
  where_time_past_upper_bound_unsupported: () =>
    'where _time < <past time> has no NRQL equivalent: an UNTIL in the past with no lower bound inverts the default window, and any invented SINCE would be wrong',

  // SPL: `| where _time > relative_time(eventField, "-1d")`
  where_relative_time_nonliteral_unsupported: () =>
    'relative_time() with a non-now() anchor is a per-event value, not a static SINCE/UNTIL bound',

  // SPL: `| where created < now()`
  where_nontime_relative_unsupported: () =>
    'comparison of a non-_time field against now()/relative_time() has no NRQL equivalent (now() is rejected in WHERE)',

  // SPL: `| where _time > relative_time(now(), "-7d")` when earliest=/latest= already set
  where_time_constraints_collapsed: () =>
    'multiple time constraints collapsed into one SINCE/UNTIL (last-writer-wins)',

  // SPL: `* | where a="x" b="y"` — implicit AND (search syntax) inside where.
  where_implicit_and: () =>
    'where: implicit AND is not valid in where (it is search syntax); join the conditions with AND — this is a defect in the source query',

  // SPL: `* | where "a"="b"` — the whole condition constant-folds to false.
  where_always_false: () =>
    'where condition is always false (a comparison between two different literals), so the query would return no rows; remove or fix the condition',

  // SPL: `* | where "$region$"="*" OR region="$region$"` — the dashboard "all" guard.
  where_token_all_guard_dropped: (token) =>
    `where "$${token}$"="*" (the dashboard "all values" guard) was dropped: New Relic substitutes {{${token}}} ` +
    `directly into the field comparison, so a literal * would match nothing. To offer "all values", enable the ` +
    `New Relic variable's multi-value / include-all option instead of a * choice.`,

  // SPL: `* | where "$env$"="prod"` — a token compared with a literal other than "*".
  where_token_const_comparison: (expr) =>
    `where ${expr} compares a dashboard token with a literal; the result depends on the value chosen at run time and cannot be translated`,

  // SPL: `* | where "1"=1` — string literal compared with a number literal.
  where_mixed_const_comparison: (expr) =>
    `where ${expr} compares a string literal with a number literal; Splunk's coercion for this cannot be reproduced reliably`,

  // SPL: `index=web | where bytes > jparse(payload, "size")`
  where_rhs_func_not_row_wise: (name) =>
    `${name}() is not supported on a comparison's right-hand side.`,

  // ── splExprUtils mapFunction warnings ────────────────────────────

  // SPL: `* | stats stdevp(latency) by host`
  stdevp_precision: () =>
    'SPL stdevp() is population stddev; mapped to NRQL stddev() which is sample stddev. Results may differ.',

  // SPL: `* | stats exactperc95(latency) by host`
  perc_precision: (variant, n) =>
    `SPL ${variant}${n}() mapped to NRQL percentile(); precision may differ`,

  // SPL: `* | stats count(eval(status=success))` — `success` is a FIELD in SPL eval.
  filter_field_vs_field: (left, right) =>
    `count(eval(…)) compares two fields (${left} with ${right}); NRQL filter() needs a constant on one side of each comparison. In SPL eval an unquoted word is a field name — if '${right}' was meant as text, quote it ("${right}")`,

  // SPL: `* | stats dc(eval(status="ok"))`
  stats_eval_condition_unsupported: (fn) =>
    `${fn}(eval(<condition>)) cannot be translated: Splunk's condition is true or null, a NRQL condition is true or false, so ${fn}() would count false too. Use count(eval(<condition>)), or ${fn}(eval(if(<condition>, <value>, null())))`,

  // SPL: `* | stats mode(status) by host`
  no_equiv_func: (name) => `SPL ${name}`,

  // SPL: `* | stats xyzfunc(field) by host`
  unknown_stats_func: (name) =>
    `SPL function ${name}() has no known NRQL equivalent`,

  // SPL: `* | stats round(dur + avg(x), 2)` — a bare field inside an aggregate expression.
  agg_expr_bare_field: (field) =>
    `field '${field}' is used outside an aggregate in a stats expression; each group needs one value, so wrap it in an aggregate (e.g. avg(${field}))`,

  // SPL: `* | stats eval(a . avg(x))` — a construct the aggregate-expression walker can't express.
  agg_expr_unsupported: (name) =>
    `${name}(…) in stats position contains an operation that cannot be applied to an aggregate in NRQL`,

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

  // SPL: `* | eventstats values(src) as srcs by id | stats count by srcs`
  eventstats_list_join: (names) =>
    `eventstats values()/list() column(s) ${names.join(', ')} cannot be translated: the value is a list, and New Relic cannot carry a list through a JOIN`,

  // SPL: `* | eventstats values(src) as srcs by id | stats count` (srcs never read)
  eventstats_unread_list_dropped: (names) =>
    `eventstats values()/list() column(s) ${names.join(', ')} dropped: nothing later reads them, and New Relic cannot carry a list through a JOIN`,

  // SPL: `* | eventstats count by host, status`
  eventstats_multi_by: (fields) =>
    `eventstats with multiple BY fields (${fields}) cannot be translated; NRQL subquery JOIN only supports a single ON key`,

  // ── splToIR ───────────────────────────────────────────────────────

  // SPL: `* latest=-1h` — an upper time bound with no lower bound. NRQL has no
  // safe way to fabricate the missing lower bound: any fixed default (e.g. 24h)
  // inverts the window whenever latest resolves to older than that default, and
  // NRQL rejects an inverted range. (Splunk fills the missing earliest from the
  // dashboard picker / all-time, which we can't resolve statically.)
  latest_without_earliest_unsupported: () =>
    'latest= without earliest= has no lower time bound, so there is no safe NRQL ' +
    'time range to produce. Add an explicit earliest= (e.g. earliest=-24h) or a ' +
    'literal datetime range (e.g. earliest="01/01/2024:00:00:00").',

  // SPL: `earliest=$tok.earliest$` / `$earliest$` — a dashboard time-range token,
  // resolved only at dashboard run time, with no static value we can translate.
  time_token_bound_dropped: (param, token) =>
    `${param}=${token} is a dashboard time variable resolved only at run time; ` +
    'it has no static value to translate. This has been dropped — the query will ' +
    "use the dashboard's default time range. To set a fixed bound, use a literal " +
    'datetime (e.g. earliest=-24h or earliest="01/01/2024:00:00:00").',

  // SPL: `earliest=-24h latest=$tok.latest$` — one literal bound, one token bound.
  mixed_token_literal_time_unsupported: () =>
    'This search mixes a literal time bound with a dashboard time variable. ' +
    'Dropping only the variable would widen or invert the window, so the whole ' +
    'time range is unsupported. Make both bounds literal datetimes ' +
    '(e.g. earliest=-24h latest=now).',

  // SPL: `| timechart span=$timespan$ count`
  span_token_unsupported: (token) =>
    `span=${token} is a dashboard time variable resolved only at run time; NRQL TIMESERIES needs a concrete duration ` +
    '(TIMESERIES AUTO would silently pick its own bucket size). Specify a literal span (e.g. span=5m) or leave the span empty.',

  // SPL: `index="*fps-$tok$*"` / `index="$tok$-suffix"` — a dashboard token embedded with
  // literal text inside a value. New Relic substitutes a dashboard variable only where
  // {{tok}} stands as a whole value (never inside a string literal/pattern), so emitting the
  // literal $tok$ would silently never substitute. No faithful translation exists.
  affixed_token_unsupported: (field, value) =>
    `${field}="${value}" embeds a dashboard token inside literal text. New Relic substitutes ` +
    'a dashboard variable only in value position, never inside a string, so this cannot be ' +
    'translated. Use a standalone token (field=$tok$) or a wildcard-only token (field="*$tok$*").',

  // SPL: `index="*$tok$*"` / `"$tok$*"` / `"*$tok$"` — a token wrapped in ONLY wildcards
  // becomes `field LIKE {{tok}}`. New Relic puts the wildcards in the variable's VALUE, so for
  // a substring/prefix/suffix match the variable's values must carry the % (we can inject it for
  // a static dropdown, but not for a free-text or search-backed variable resolved at run time).
  wildcard_token_like: (field, token) =>
    `A wildcard dashboard token became ${field} LIKE {{${token}}}. For a substring match, the ` +
    `dashboard variable ${token}'s values must include % wildcards (e.g. %value%); New Relic ` +
    'substitutes the value as-is and does not add wildcards.',

  // SPL: `app="$env:app$"` — Splunk's $env:…$ runtime-context namespace (current
  // app/page/user/locale + user-profile fields injected at render time). NR dashboards
  // expose no widget-level runtime-context token, and ':' cannot appear inside an NRQL
  // {{…}} variable (a hard NRDB parse error) — so an env: token can never become a
  // faithful {{…}}. Flag unsupported, never emit a dead {{env:…}}.
  splunk_env_token: (token) =>
    `$${token}$ is a Splunk runtime-context token (the $env:…$ namespace — current ` +
    'app/page/user/locale). New Relic dashboards have no equivalent runtime-context ' +
    'variable, and the colon cannot appear in an NRQL {{…}} template variable, so this ' +
    'filter cannot be translated. Remove the env-scoped filter or re-scope the widget ' +
    'with a New Relic template variable.',

  // SPL: `host="$my-var$"` / `$a:b$` — a (non-env) dashboard token whose NAME contains
  // ':' or '-'. Those chars do not tokenize inside an NRQL {{…}} variable, so emitting
  // {{my-var}} is a hard NRDB parse error (verified acct 1). The variable itself is
  // legitimate (unlike env:); only the NAME is untranslatable. Loud failure over a
  // parse-erroring {{…}}.
  token_name_unsupported: (name) =>
    `$${name}$ is a dashboard token whose name contains ':' or '-', which New Relic's ` +
    '{{…}} template-variable syntax does not allow (a hard NRQL parse error). Rename the ' +
    "dashboard variable to use only letters, digits, '_', and '.', or remove the filter.",

  // SPL: `_raw=*error*`
  raw_mapped_to_message: () =>
    '_raw is not a valid NRQL field; mapped to message',

  // SPL: `_raw=*error*` — a search across the whole raw event. (`like(_raw, …)` stays on message.)
  raw_search_dimensions: () =>
    '_raw search translated as dimensions() LIKE, which matches across all attribute values of the event (the closest NRQL form of a raw-event search); match counts can differ where Splunk tokenizes the raw text differently',

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

  // SPL: `index=web "status":"500"` — the JSON-fragment search idiom.
  search_json_fragment: (value) =>
    `search term ${value} is a JSON fragment (quoted pieces joined by ':'); Splunk matches it by breaking it into terms, which a text match cannot reproduce — rewrite it as a field comparison (e.g. status=500 after spath) or a single quoted phrase`,

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

  // SPL: `* | timechart span=90ms count` — a span unit NRQL TIMESERIES cannot express.
  span_unrecognized: (span) =>
    `span=${span} is not a time span NRQL TIMESERIES can express (use s, m, h, d, w, mon, q, or y units)`,

  // SPL: `* | chart count over host span=1` — span bins the over field, not time.
  chart_span_non_time: (span) =>
    `chart span=${span} bins the 'over' field into numeric ranges; only 'over _time' maps to NRQL TIMESERIES — use bin/histogram() for a numeric field`,

  // SPL: `* | timechart bins=90 count` / `minspan=1h` — Splunk's auto-bucket hints.
  timechart_bucket_hint_auto: (option) =>
    `${option} steers Splunk's automatic bucket size; translated as TIMESERIES AUTO, which also picks the bucket size from the time window, so bucket boundaries may differ`,

  // SPL: `* | timechart cont=false count` — rendering-only options.
  agg_display_options_ignored: (command, options) =>
    `${command} option(s) ${options.join(', ')} only affect Splunk's rendering and were ignored`,

  // SPL: `* | timechart aligntime=@d count` — an option with no NRQL equivalent.
  agg_option_unsupported: (command, option) =>
    `${command} option ${option} has no NRQL equivalent`,

  // SPL: `* | timechart count by f usenull=false`
  usenullNoEquivalent: () =>
    'Splunk timechart usenull option has no NRQL equivalent; null groups are included',

  // SPL: `* | streamstats count as row_num`
  streamstats_unsupported: () =>
    'streamstats has no NRQL equivalent; NRQL does not support row-to-row references (LAG/LEAD) or running aggregations',

  // SPL: `* | kvparse` or `* | extract`
  kvparse_unsupported: () =>
    'key=value extraction from unstructured text has no NRQL equivalent; use Grok parsing rules to extract fields at ingest time, or restructure logs as JSON',

  // SPL: `* | transaction user_id maxspan=30s` — no NRQL sessionization primitive (Option A).
  transaction_unsupported: (windowArg) =>
    windowArg
      ? `SPL 'transaction' groups loglines into per-key sessions and the '${windowArg}' arg splits them on a time gap/boundary; NRQL has no sessionization primitive (FACET groups globally, TIMESERIES buckets by wall-clock), so it has no equivalent`
      : `SPL 'transaction' groups loglines into per-key sessions; NRQL has no sessionization primitive, and even bare 'transaction' is not a plain FACET (Splunk's maxevents=1000 splits high-cardinality keys and connected=true groups by stream connectivity), so it has no equivalent`,

  // SPL: `* | sort -x | stats first(y)` — first/last after the rows were re-ordered.
  first_last_after_reorder: (name) =>
    `${name}() after a sort/reverse/tail depends on the re-ordered row order; NRQL latest()/earliest() pick by timestamp, so the result would differ`,

  // SPL: `* | timewrap 1d`
  unsupported_command: (name) =>
    `SPL command '${name}' has no known NRQL equivalent`,

  // SPL: `* | where "a" LIKE b c` — a command we translate, whose arguments its own
  // grammar rule rejected. Names the construct, not the command.
  command_args_unparsed: (name, detail) =>
    detail
      ? `SPL '${name}' arguments could not be parsed ${detail}`
      : `SPL '${name}' arguments could not be parsed`,

  // SPL: (unrecognized command type in AST)
  command_not_implemented: (type) => `command '${type}' not yet implemented`,

  // Internal contract (translate.js): an empty NRQL must always carry a reason.
  // Reaching this is a translator bug, reported instead of an empty, reasonless result.
  empty_translation_internal: () =>
    'internal: translation produced no NRQL and no reason; please report this query as a translator bug',
};
