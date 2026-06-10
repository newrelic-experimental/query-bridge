# SPL Reference

Quick reference for Splunk Search Processing Language (SPL) commands relevant to translation work.

## Query Structure

```
search <base_search> | command1 args | command2 args | ...
```

Implicit `search` at start. Pipe chains commands left-to-right. Each command transforms the result set from the previous command.

## Commonly Translated Commands

### search / where (filtering)
```spl
index=main sourcetype=access_combined status=500
index=web status>=400 AND status<500
... | where status > 200 AND method="GET"
... | where like(uri, "%/api/%")
... | where isnull(user)
... | where cidrmatch("10.0.0.0/8", src_ip)
```

### stats (aggregation)
```spl
... | stats count by status
... | stats avg(duration) as avg_dur, max(duration) as max_dur by host
... | stats dc(user) as unique_users by app
... | stats values(status) as statuses by host
... | stats sum(bytes) as total_bytes by sourcetype
... | stats earliest(timestamp) as first, latest(timestamp) as last
... | stats perc95(duration) as p95 by service
... | stats count as cnt by status | where cnt > 100
```

### timechart (time-series aggregation)
```spl
... | timechart span=5m count by status
... | timechart span=1h avg(duration)
... | timechart span=1d sum(bytes) by host limit=10
```

### chart (pivot table)
```spl
... | chart count over host by status
... | chart avg(duration) over time by app
```

### eval (computed fields)
```spl
... | eval duration_sec = duration / 1000
... | eval full_name = first_name . " " . last_name
... | eval status_group = if(status >= 400, "error", "ok")
... | eval category = case(status < 200, "info", status < 300, "success", status < 400, "redirect", 1=1, "error")
... | eval size_kb = round(bytes / 1024, 2)
... | eval domain = lower(host)
... | eval short = substr(message, 1, 100)
```

### table / fields (column selection)
```spl
... | table host, status, duration, message
... | fields host, status, duration
... | fields - _raw, _time, _serial
```

### sort (ordering)
```spl
... | sort -duration
... | sort +host, -count
... | sort 10 -duration
```

### head / tail (limiting)
```spl
... | head 100
... | tail 50
```

### rename (field renaming)
```spl
... | rename src_ip AS source_ip, dst_ip AS dest_ip
... | rename _time AS timestamp
```

### dedup (deduplication)
```spl
... | dedup host
... | dedup host, status
... | dedup 3 host
```

### rex (regex extraction)
```spl
... | rex field=message "user=(?<username>\w+)"
... | rex field=uri "\/api\/(?<version>v\d+)\/(?<endpoint>\w+)"
... | rex mode=sed field=message "s/password=[^&]*/password=REDACTED/g"
```

### top / rare (frequency)
```spl
... | top 10 status by host
... | top limit=5 useother=true uri
... | rare status by host
```

### bin (bucketing)
```spl
... | bin _time span=5m
... | bin duration span=100
```

### lookup / inputlookup (enrichment)
```spl
... | lookup users_lookup username OUTPUT department, team
... | inputlookup geo_data.csv
```

### join (combining datasets)
```spl
... | join host [search index=infra | stats avg(cpu) as avg_cpu by host]
... | join type=left host [search index=cmdb | table host, owner, tier]
```

### regex (filter by regex)
```spl
... | regex message="error|exception|fail"
... | regex _raw!="DEBUG"
```

### fillnull (replace nulls)
```spl
... | fillnull value="N/A"
... | fillnull value=0 duration, bytes
```

### spath (JSON/XML extraction)
```spl
... | spath input=message
... | spath input=payload path=data.items{}.name output=item_name
```

### strcat (string concatenation)
```spl
... | strcat host ":" port endpoint
```

### convert (type conversion)
```spl
... | convert num(bytes)
... | convert rmcomma(total)
... | convert dur2sec(elapsed)
... | convert ctime(timestamp) AS readable
... | convert mktime(datestr)
... | convert mstime(duration)
... | convert auto(field)
... | convert rmunit(size)
... | convert memk(memory)
```

## Aggregation-Enrichment Commands

### eventstats (add aggregation as column)
Adds aggregate statistics as new fields to every event without collapsing rows (like SQL window functions).

```spl
... | eventstats avg(duration) AS avg_dur
... | eventstats count AS total_count
... | eventstats avg(duration) AS avg_dur BY host
... | eventstats sum(bytes) AS host_total BY host
... | eventstats max(_time) AS lastImport BY source
```

**Common patterns:**

Percentage calculation (~47% of real usage):
```spl
index=web | stats count as appCount by app
| eventstats sum(appCount) as total
| eval pct = round(appCount / total * 100, 2)
```

Count filtering (~43% of real usage):
```spl
index=web | eventstats count by host
| where count > 100
| stats dc(uri) by host
```

Latest record per group (~10% of real usage):
```spl
index=imports | eventstats max(_time) as lastImport by source
| where _time = lastImport
```

### streamstats (running/cumulative stats)
Running aggregation over ordered events. Stateful — depends on event order.

```spl
... | streamstats count AS row_num
... | streamstats sum(bytes) AS running_total
... | streamstats avg(duration) AS running_avg window=10
... | streamstats count by host reset_after="duration > 300"
```

### append (union results)
Appends results from a subsearch to current results.

```spl
index=web status=500 | append [search index=web status=503]
index=web | stats count as errors by host | append [search index=web | stats dc(uri) as pages by host]
```

### appendcols (add columns from subsearch)
Adds fields from subsearch as new columns (matched by row position).

```spl
index=web | stats count by host
| appendcols [search index=web | stats avg(duration) by host]
```

### appendpipe (branch and merge)
Runs subsearch on current results and appends output.

```spl
... | stats count by status
| appendpipe [stats sum(count) as total | eval status="TOTAL"]
```

### transaction (session grouping)
Groups events into transactions based on field values and time constraints.

```spl
... | transaction session_id maxpause=5m
... | transaction host startswith="login" endswith="logout"
... | transaction session_id maxspan=1h maxevents=100
```

## Stats Functions

### Aggregation
| Function | Description |
|---|---|
| `count` / `count(field)` | Count events / non-null values |
| `dc(field)` / `distinct_count(field)` | Count distinct values |
| `avg(field)` / `mean(field)` | Average |
| `sum(field)` | Sum |
| `min(field)` / `max(field)` | Extremes |
| `median(field)` | Median |
| `mode(field)` | Most frequent value |
| `stdev(field)` / `stdevp(field)` | Standard deviation (sample/population) |
| `var(field)` / `varp(field)` | Variance (sample/population) |
| `range(field)` | max - min |
| `sumsq(field)` | Sum of squares |
| `values(field)` | Multivalue list of distinct values |
| `list(field)` | Multivalue list (including duplicates) |
| `first(field)` / `last(field)` | First/last by input order |
| `earliest(field)` / `latest(field)` | Earliest/latest by _time |
| `earliest_time(field)` / `latest_time(field)` | Timestamps of earliest/latest |
| `percN(field)` | Nth percentile (e.g., `perc95(duration)`) |
| `exactpercN(field)` | Exact Nth percentile |
| `upperpercN(field)` | Upper Nth percentile bound |
| `estdc(field)` | Estimated distinct count |
| `estdc_error(field)` | Estimated DC error rate |
| `rate(field)` | Per-second rate |

### Eval Functions (commonly used)

**Conditionals**: `if(cond, true, false)`, `case(cond1, val1, cond2, val2, ...)`, `coalesce(field1, field2, ...)`, `nullif(field1, field2)`, `validate(cond1, msg1, cond2, msg2, ...)`

**String**: `lower(str)`, `upper(str)`, `len(str)`, `substr(str, start, len)` (**1-based** start, SQLite semantics; negative start counts from end — NRQL `substring` is 0-based, so SPL start `N` → NRQL `N-1`), `replace(str, regex, replacement)`, `trim(str)`, `ltrim(str)`, `rtrim(str)`, `split(str, delim)`, `urldecode(str)`, `urlencode(str)`, `printf(fmt, args...)`

**Type conversion**: `tonumber(str [, base])`, `tostring(val [, format])`, `typeof(val)`

**Math**: `abs(n)`, `round(n [, places])`, `ceiling(n)`, `floor(n)`, `sqrt(n)`, `pow(base, exp)`, `exp(n)`, `ln(n)`, `log(n, base)`, `pi()`, `exact(expr)`, `sigfig(n)`

**Time**: `now()`, `time()`, `relative_time(epoch, offset)`, `strftime(epoch, format)`, `strptime(str, format)`

**Multivalue**: `mvappend(mv1, mv2)`, `mvcount(mv)`, `mvindex(mv, start [, end])`, `mvfind(mv, regex)`, `mvjoin(mv, delim)`, `mvsort(mv)`, `mvdedup(mv)`, `mvfilter(expr)`, `mvrange(start, end, step)`, `mvzip(mv1, mv2 [, delim])`, `split(str, delim)`

**Crypto**: `md5(str)`, `sha1(str)`, `sha256(str)`, `sha512(str)`

**JSON**: `json_extract(json, path)`, `json_set(json, path, val)`, `json_valid(json)`, `spath(input, path)`

**Informational**: `isnum(val)`, `isstr(val)`, `isnull(val)`, `isnotnull(val)`, `isint(val)`, `isbool(val)`

## Translation Gotchas

These are non-obvious SPL behaviors that cause silent bugs if a translator gets them wrong.

- **`rename` pairs are space-separated**, not comma-separated: `rename a AS b c AS d` (no comma).
- **`search` does substring match, `where` does exact match.** `| search foo=bar` ≈ `LIKE '%bar%'`. `| where foo="bar"` = exact. Don't translate both as `=`.
- **`stats` resets the field set.** After `| stats count by host`, only `count` and `host` exist. Prior fields are gone.
- **`rex` default field is `_raw`**, not `message`. `| rex "(?<val>\w+)"` extracts from `_raw`. In NRQL, map to `capture(message, ...)` only if log text is in `message`.
- **`eval` concat: both `.` and `+` concatenate strings.** `.` is dedicated concat (always string, coerces numbers). `+` adds two numbers OR concatenates two strings, decided per-row at runtime (Splunk docs, SearchReference→Eval→Operators — verified 2026-06-03). `eval x = a . " " . b` and `eval x = a + " " + b` both → `concat(a, ' ', b)`. For `field + field` with no literal operand the type is undecidable statically; corpus shows it's ~always numeric, so default to arithmetic.
- **`dedup sortby` changes which row is kept.** `| dedup host sortby -duration` keeps highest duration per host. Ignoring `sortby` silently changes results.
- **`$var$` = dashboard template variables** — must pass through, not parse as syntax error.
- **`TERM()` = indexer hint** — strip it entirely. Not a function.
- **Triple backticks = inline comments** — strip them or parser will choke on comment text.
- **`tstats` targets CIM data models** — don't translate to `FROM Log`. Semantically different data source.
- **`bucket` = alias for `bin`; `c` = shorthand for `count`** — parser must recognize both.
- **`head`/`tail` after FACET**: SPL `| stats count by host | head 5` limits result rows. In NRQL with FACET, `LIMIT` controls facet groups, not row count.

## Metadata Fields

| SPL field | Description |
|---|---|
| `_time` | Event timestamp (epoch) |
| `_raw` | Raw event text |
| `index` | Index name |
| `sourcetype` | Source type |
| `source` | Source file/path |
| `host` | Originating host |
| `_serial` | Event serial number |
| `linecount` | Number of lines in event |
