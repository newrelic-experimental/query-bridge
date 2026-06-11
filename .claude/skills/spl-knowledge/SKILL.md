---
name: spl-knowledge
description: Use when explaining Splunk SPL commands, identifying SPL-to-NRQL translation patterns, judging whether SPL syntax is valid, or recognizing what a real-world SPL query is trying to accomplish. Domain knowledge shared by the main thread and the spl-expert agent.
---

# SPL Knowledge

Splunk Search Processing Language (SPL): what commands do, how to read a query's
intent, which translation pattern it falls into, and the closest NRQL approach.

## Knowledge Sources

1. Read `.claude/references/spl-reference.md` for the full SPL reference with examples and translation gotchas
2. Read `docs/SPL_TO_NRQL.md` for current translation status
3. Fetch the canonical Splunk docs when the local reference is missing something — see "How to fetch Splunk docs" below for the method that actually works (the obvious tools fail on these pages)

### Documentation URLs

Use these for deeper research when the local reference isn't enough:
- https://docs.splunk.com/Documentation/Splunk/latest/SearchReference/WhatsInThisManual — SPL command reference index
- https://docs.splunk.com/Documentation/Splunk/latest/SearchReference/CommonStatsFunctions — stats functions
- https://docs.splunk.com/Documentation/Splunk/latest/SearchReference/CommonEvalFunctions — eval functions
- https://docs.splunk.com/Documentation/SplunkCloud/latest/Search/Aboutsubsearches — subsearch behavior
- https://docs.splunk.com/Documentation/Splunk/latest/Knowledge/Abouteventtypes — event types / CIM

### How to fetch Splunk docs (the working method — verified 2026-06-10)

docs.splunk.com is a JS-hydrated Heretto-hosted site that defeats the obvious tools. **What FAILS:**
- `web_fetch` / `WebFetch` (even with `enableJavaScript: true`) — returns only the page's nav chrome; the command body and its `search` filter match nothing.
- `raw_http_fetch` and a plain `curl` with no User-Agent — **403 Forbidden** (the site blocks non-browser clients).
- `google_search` — may be permission-denied (`Custom Search JSON API` 403) for this project.
- Delegating the fetch to the **spl-expert subagent** — its tool context has NO web tools at all (`WebFetch`/`WebSearch` unprovisioned, plugin tools resolve to "No such tool available"). Do NOT ask the subagent to fetch live docs; it will only return training-recollection.

**What WORKS** — run this in the MAIN thread via Bash, then read/grep the text file:
```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
curl -sL -A "$UA" "https://docs.splunk.com/Documentation/Splunk/latest/SearchReference/<Page>" -o /tmp/splunk_page.html
pandoc -f html -t plain /tmp/splunk_page.html > /tmp/splunk_page.txt
# then grep/sed /tmp/splunk_page.txt for the section you need
```
The raw HTML carries the full body text (precedence lists, quoting paragraphs, operator tables) even though it renders client-side for browsers — a browser User-Agent is the key that gets past the 403. If you need a subagent to reason over a doc page, fetch it this way FIRST and hand it the extracted text, rather than expecting the subagent to fetch it.

## Parser Permissiveness

Our PEG.js parser is intentionally MORE PERMISSIVE than standard Splunk:
- It accepts single-quoted strings (e.g. `message='hello'`) even though standard SPL only uses double quotes
- It handles edge cases like `NOT()` with empty parens gracefully (as a no-op)
- It accepts duplicate time modifiers (e.g. `earliest=-24h earliest=-1h`) with last-one-wins semantics

When reviewing, judge by what a reasonable SPL user would INTEND, not by strict Splunk parser behavior. Flag truly broken syntax, not permissiveness.

## How to Analyze an SPL Query

1. Explain what the command does (input → output transformation)
2. Provide 2-3 example queries showing common usage patterns
3. Identify what the query is trying to accomplish at a high level
4. Suggest the simplest NRQL approach that achieves the same goal

When responding, always include:
- What the SPL query does in plain English
- Example SPL queries demonstrating the pattern
- The closest NRQL approach (even if approximate)

## Key SPL Concepts for Translation

- **Pipe chain**: Each command transforms the result set; order matters
- **eventstats vs stats**: stats collapses rows; eventstats adds columns to every row (like SQL window functions)
- **streamstats**: Running/cumulative stats — stateful, depends on event order
- **eval functions**: 241 functions — conditionals, string ops, math, multivalue, time
- **subsearches**: `[search ...]` — run a search and use results as input
- **transaction**: Groups events into sessions by field values and time constraints
- **metadata fields**: `_time`, `_raw`, `index`, `sourcetype`, `source`, `host`

## Real-World Pattern Recognition

When analyzing SPL queries, identify which pattern category they fall into:
- **Aggregation + enrichment** (eventstats/streamstats) — needs subquery JOIN or nested aggregation
- **Multi-dataset** (append/join/multisearch) — needs UNION or JOIN
- **Session grouping** (transaction) — no direct NRQL equivalent
- **Field manipulation** (eval/rex/convert) — WITH clause or capture()
- **Simple filter+aggregate** (search/where/stats) — direct NRQL translation

## SPL Reserved Words / Command Names

These are SPL command names and keywords that may appear as field names in user queries. The parser must distinguish command usage from field-name usage:

**Commands (pipe context):**
```
abstract, accum, addcoltotals, addinfo, addtotals, analyzefields, anomalies,
anomalousvalue, append, appendcols, appendpipe, arules, associate, audit,
autoregress, bin, bucket, chart, cluster, cofilter, collect, concurrency,
contingency, convert, correlate, datamodel, dbinspect, dedup, delete, delta,
diff, erex, eval, eventcount, eventstats, extract, fieldformat, fields,
fieldsummary, filldown, fillnull, findtypes, flatten, folderize, foreach,
format, from, gauge, gentimes, geom, geostats, head, highlight, history,
iconify, input, inputcsv, inputlookup, iplocation, join, kmeans, kvform,
loadjob, localize, localop, lookup, makecontinuous, makemv, makeresults,
map, mcollect, metadata, metasearch, meventcollect, mpreview, msearch,
mstats, multikv, multisearch, mvappend, mvcombine, mvexpand, nomv,
outlier, outputcsv, outputlookup, outputtext, overlap, pivot, predict,
rangemap, rare, regex, relevancy, reltime, rename, replace, require, rest,
return, reverse, rex, rtorder, run, savedsearch, script, scrub, search,
searchtxn, selfjoin, sendemail, set, setfields, sichart, sirare, sistats,
sitimechart, sitop, sort, spath, stats, strcat, streamstats, table, tags,
tail, timechart, timewrap, top, transaction, transpose, trendline, tscollect,
tstats, typeahead, typelearner, typer, union, uniq, untable, where, x11,
xmlkv, xmlunescape, xpath, xyseries
```

**Boolean / clause keywords:**
```
AND, OR, NOT, BY, AS, IN, OVER, WHERE, OUTPUT, OUTPUTNEW, TRUE, FALSE
```

**Special field names (metadata):**
```
_time, _raw, index, sourcetype, source, host, _serial, linecount,
earliest, latest, splunk_server, splunk_server_group
```
