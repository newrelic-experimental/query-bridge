# Dashboard Time Tokens Design

**Goal:** Make SPL dashboard time tokens — `$tok.earliest$`, `$tok.latest$`, and `$timespan$` (a `span=` argument) — fail loud instead of failing silent or emitting non-compiling NRQL. A token in a time context has no correct static NRQL translation, so the right answer is to DROP the bound and WARN (for `earliest=`/`latest=`/standalone), or `unsupported` (for `$timespan$` in `span=`). No token ever produces a SINCE/UNTIL the user didn't ask for.

**Depends on:** nothing (translator-only; ready to plan). **Blocks:** dashboard importer Phase 2 (`docs/superpowers/specs/2026-06-12-dashboard-importer-design.md`) — Phase 2 ingests time pickers and relies on the translator degrading tokens cleanly. Importer Phase 0/1 has no token surface and is NOT blocked.

**Sibling:** spec A is `docs/superpowers/specs/2026-06-10-where-comparison-rhs-design.md` (the `where _time` comparison path, shipped on `eval/parse-error-burndown`). Spec A scoped dashboard tokens OUT (its deferred gap #6) and pointed here. The discovery trail is `docs/superpowers/specs/2026-06-10-dashboard-time-tokens-HANDOFF.md` — this spec supersedes it.

## Problem

Splunk dashboards expose time-range pickers as tokens. A picker named `tok` auto-exposes `$tok.earliest$` / `$tok.latest$`; a single global picker exposes prefix-less `$earliest$` / `$latest$`. In real dashboards these are almost always referenced as the RHS of `earliest=`/`latest=` (e.g. `earliest=$earliest$ latest=$latest$`) — i.e. a `TimeConstraint` (Path 1). A token standing alone in the search body (`TemplateVariable`, Path 2) is the rarer form but must still be handled. A token conventionally named `$timespan$` supplies a `span=` argument (`$timespan$` is just a token name, not a Splunk reserved word — by convention a duration input, though a dashboard could derive it from the picker):

```
index=web earliest=$tok.earliest$ latest=$tok.latest$ | stats count
index=web | timechart span=$timespan$ count
```

A token's value is resolved **only at dashboard-run-time**, after the user touches (or defaults) the picker. At static-translation time we have only a placeholder — and its format is unpredictable (relative string `-24h@h`, or epoch **seconds** `1717977600`, depending purely on picker mode). NRQL has no placeholder syntax in time clauses, so there is no static form to emit. Today these tokens translate three different wrong ways (see Bugs below).

### Why not deferred binding (the load-bearing question)

The HANDOFF's open question #1 asked whether the NR NRQL gateway could expand a time-token placeholder the way it expands `$macro$`, giving a deferred-binding path instead of `unsupported`. **Answer: no.** Verified against NQG source (`../dirac/nrql-query-gateway`) and MCP, 2026-06-11:

- NQG's `macros/` compiler expands **`$macro$`** (dollar-delimited) before the query reaches NRDB. It does **not** touch `{{var}}`.
- `{{var}}` (template variables) are resolved by the **dashboard platform** — and only into filter/value positions (string values get quoted), never into SINCE/UNTIL.
- The NRQL compiler/grammar (`dirac/dirac-nrql-ast`) rejects **both** placeholder syntaxes directly in a time clause.

So no layer will ever turn a `{{tok.earliest}}` or `$tok.earliest$` into a valid time bound. Deferred binding does not exist for time clauses. `unsupported`/drop-and-warn is the end state. Confirmed at the NRDB grammar directly (MCP, account 1, 2026-06-11): both `SINCE {{x}} UNTIL {{y}}` (`unexpected '{'`) AND `SINCE $x$ UNTIL $y$` (`unexpected '$'`) fail to compile — neither placeholder syntax is accepted in a time clause. (These findings are documented in `.claude/references/nrql-reference.md` under "Placeholders: `$macro$` vs `{{var}}`".)

### Verified NRQL constraints (MCP, account 1)

| Query | Result |
|---|---|
| `SINCE {{myStart}} UNTIL {{myEnd}}` | FAILURE — `unexpected '{'` (no template syntax in time clauses) |
| `SINCE 1717200000000 UNTIL 1717221600000` (epoch **ms**) | SUCCESS |
| `SINCE '2026-06-01 00:00:00' UNTIL '2026-06-01 06:00:00'` (datetime string) | SUCCESS |
| `SINCE 7 days ago` (relative) | SUCCESS |
| `... UNTIL 3 hours ago` with no SINCE | FAILURE — `start time must be before its end time` (default SINCE is 1h) |
| `... UNTIL now` with no SINCE | SUCCESS |
| `SINCE $myStart$ UNTIL $myEnd$` | FAILURE — `unexpected '$'` (no macro syntax in time clauses either) |
| `TIMESERIES {{mySpan}}` | FAILURE — `unexpected '{'` (no placeholder span) |

(The `$…$`-in-SINCE and `TIMESERIES {{…}}` rows were run fresh 2026-06-11 to close the prior review's untested-claim gap; the rest are from 2026-06-10, re-confirmed. The "default SINCE is 1h" note is documented: NRQL SINCE-clause reference, "The default value is 1 hour ago" — https://docs.newrelic.com/docs/nrql/nrql-syntax-clauses-functions/#sel-since. The inverted-window boundary was re-verified via MCP 2026-06-16: `SINCE 24 hours ago UNTIL 2 hours ago` SUCCEEDS, `SINCE 24 hours ago UNTIL 25 hours ago` FAILS.)

So SINCE/UNTIL accept only a concrete literal: relative `N units ago`, epoch **milliseconds** (note: SPL absolute tokens are epoch **seconds** — a unit mismatch that never arises statically since the value is run-time-only), or a datetime string. A placeholder is never one of these.

## The three bugs (located in code, verified 2026-06-11)

How a token parses decides which bug fires:

1. **`earliest=$tok.earliest$` / `latest=$tok.latest$` → silent wrong window.** The `time_constraint` grammar rule (`spl.grammar:1276`) matches `earliest=`/`latest=`, then `time_value` (`:1286`, `[^ \t\r\n\f|()]+`) greedily eats `$tok.earliest$` as raw chars. The `TimeConstraint` handler (`splToIR.js:487`) calls `parseSplTime('$tok.earliest$')`, which falls through `TIME_REGEX` to the no-match branch (`splTime.js:66`) → `{nrql: null, warning: 'Unrecognized SPL time expression: …'}`. Because `nrql` is null, `since`/`until` is **never set** — the query silently uses NRQL's default window (`SINCE 1 hour ago`). **This is the worst failure class for the project:** a valid-looking query bound to the wrong time range, no loud signal. The `Unrecognized SPL time expression` warning is buried among others and does not stop emission.

2. **Standalone `$tok.earliest$` / `$tok.latest$` in a search expr → non-compiling NRQL.** When a `$x.earliest$` token appears bare in the search (not after `earliest=`), it parses as `TemplateVariable` (`spl.grammar:1227`). The handler (`splToIR.js:505-512`) sets `since = '{{tok.earliest}}'` / `until = '{{tok.latest}}'` by name suffix; the emitter passes `{{…}}` through into `SINCE {{tok.earliest}}`, which **does not compile** (verified above). Emits broken NRQL.

3. **`span=$timespan$` → generic unsupported (the wrong reason).** `span_value` (`spl.grammar:197`) accepts only `[0-9]+[smhdwMy]` or a bare duration word (`day`/`hour`/…). It does **not** accept `$timespan$`, so the `span2:(_+ 'span=' …)?` optional in `timechart` (`:171`) fails to match. Verified via CLI 2026-06-16: `index=web | timechart span=$timespan$ count` emits no NRQL and reports `unsupported: SPL command 'timechart' has no known NRQL equivalent` — the whole `timechart` is rejected as unrecognized, NOT a clean per-token reason. (It is an `unsupported`, not an `errors`-bucket parse failure.) The fix is to *parse* the token (so the rest of the pipe survives) and reject it with a specific `span_token_unsupported` reason — not invent a `TIMESERIES` argument, and not let the whole command read as unrecognized.

## The decision: drop-and-warn, no mode flag

Two design questions were settled in brainstorm (2026-06-11):

**No mode flag (YAGNI).** We will soon port exported Splunk dashboards to NR dashboard JSON, which raised the question of a `translateSplToDashboard` mode that emits NR-native dashboard time tokens. But in *both* a hypothetical dashboard mode and plain NRQL mode, the SPL token gets dropped from the query body — an NR dashboard supplies its own time range from the dashboard's picker, exactly as Splunk does. `earliest=$tok.earliest$` is literally asking for "the dashboard's picker value," which NR dashboards already provide globally. So there is nothing a mode flag would change about token handling *today*. Do not add one; add it when a concrete dashboard-emission target needs it.

**Drop the bound + WARN (not silent, not hard `unsupported`) for `earliest=`/`latest=`/standalone tokens — but only when the window is token-only.** Dropping a token bound leaves the query running on NR's default (or dashboard-supplied) window, which is correct *when the dashboard owns the whole time range*. But a silent drop is the bug, so drop and emit a WARNING naming the token. This matches spec A's snap-policy direction (loud, never silently wrong) and the project's loud-failure rule.

**The mixed literal+token window is the dangerous case (raised by both expert reviews, 2026-06-11) — escalate it to `unsupported`.** A query can pin one bound with a literal and defer the other to a token: `earliest=-24h latest=$tok.latest$`. The author explicitly chose the lower bound; the picker only supplies the upper. Dropping just the token here is silent-wrong in two distinct ways:

- **Silent-widen direction** — `earliest=-24h latest=$tok.latest$`: today (CLI-verified 2026-06-16) the token `latest` drops with only a buried `Unrecognized SPL time expression` warning, the literal `since` survives, and the query emits `... SINCE 24 hours ago` (no UNTIL). The author pinned the lower bound and deferred the upper to the picker; instead they get "from 24h ago to *now*." Compiles fine, wrong window — silent-wrong.
- **Inverted-window direction** — `earliest=$tok.earliest$ latest=-2h`: today (CLI-verified 2026-06-16) the token `earliest` drops, the literal `latest` survives, and because `until` is set with no `since`, the existing `latest_without_earliest` rule fabricates `SINCE 24 hours ago`, emitting `... SINCE 24 hours ago UNTIL 2 hours ago`. That *compiles* (24h ago precedes 2h ago) but is a fabricated window the author never asked for — silent-wrong. **It only fails to compile when the literal `latest` is older than the fabricated 24h SINCE:** verified via MCP (account 1, 2026-06-16), `SINCE 24 hours ago UNTIL 2 hours ago` succeeds, while `SINCE 24 hours ago UNTIL 25 hours ago` fails with `start time must be before its end time`. So the danger here is usually a wrong-but-compiling window, occasionally an outright compile failure — both unacceptable.

So the rule is: **if any time bound in a search has a token AND any sibling bound in the same search is a literal, the whole window is `unsupported`** — emit no SINCE/UNTIL, fail loud. Only when *every* time bound in the search is a token (or there is just one token bound and no literal partner) does the drop+warn path apply. A search-level flag tracks whether a literal time bound (`earliest=`/`latest=` OR a `where _time` relative-time clause that sets `since`/`until`) was seen alongside a token (see Architecture → Mixed-bound detection).

**Known cost (SPL-expert review + Splunk docs, 2026-06-16):** `earliest=-7d latest=$tok.latest$` ("pin the floor at 7 days, let the picker move the ceiling") is a *legitimate* Splunk idiom, not a malformed query — per [Splunk search time modifiers](https://docs.splunk.com/Documentation/Splunk/latest/SearchReference/SearchTimeModifiers), a search-syntax `earliest=` overrides the time-range picker and stands on its own. So escalating to `unsupported` deliberately discards a real, knowable user intent (the `-7d` floor). We accept that cost: the translator cannot resolve the token statically, and emitting a floor-only window (`SINCE 7 days ago`, no UNTIL → defaults to `now`) would silently change the semantics the author expressed. Loud `unsupported` beats a silently-altered window. This is a trade-off, not an oversight.

**`unsupported` (not warn) for `$timespan$`.** `$timespan$` in `span=` has no defensible drop semantics — silently dropping a `span=` would change the chart's bucket size to NRQL's auto-default, a different and invisible result. So `$timespan$` is `unsupported`: loud, no `TIMESERIES`/bucket emitted for that clause, rest of the pipe still translates.

**Snap tokens are not a separate case.** A run-time token value *could* carry a snap (`$tok.earliest$` resolving to `-24h@h`), but we cannot see inside a token statically — the value is run-time-only. So there is nothing to branch on: every `earliest=`/`latest=` token takes the drop+warn path regardless of whether its eventual value snaps. The *literal* snap policy (`-1d@d` written directly, not via a token) is spec A's deferred gap #4 and is untouched here.

## Goals

1. `earliest=$…$` / `latest=$…$` (the `TimeConstraint` path, any token name) → DROP the bound, set neither `since` nor `until`, emit a WARNING naming the token. Never call `parseSplTime` on a token.
2. Standalone time tokens in a search expr (the `TemplateVariable` path) → same: drop, do not set `since`/`until` to `{{…}}`, WARN. This must cover BOTH `$tok.earliest$` (dotted) AND bare `$earliest$`/`$latest$` (global, no prefix). (The common `earliest=$earliest$` RHS form is Path 1, not this path — see Goal 1.) Never emit `SINCE {{…}}`.
3. **Mixed literal+token window** (`earliest=-24h latest=$tok.latest$`) → `unsupported`; clear any partial `since`/`until`. Dropping one bound while keeping a literal partner silently widens or inverts the window.
4. `span=$timespan$` (and any `$…$` token where `span_value` is expected) → parse the token, then `unsupported`. No `errors`-bucket parse failure, no invented `TIMESERIES`.
5. Respect subsearch scoping: tokens inside `[ search … ]` affect only that subsearch's bounds, never the outer query.
6. Corpus: the silent-wrong default-window queries (bug 1) become loud; `$timespan$` queries leave the `errors` bucket for a clean `unsupported`. `threw` stays 0; no clean query regresses to wrong-but-clean.

## Non-goals

- **Non-time template variables.** `$x$` as a field value or filter (e.g. `status=$sev$`) is out of scope — this spec only touches tokens in TIME contexts (`earliest=`/`latest=`, standalone `.earliest`/`.latest`, `span=`). Note (verified via CLI 2026-06-16): a value-position `$sev$` currently emits `status = '$sev$'` (the token survives as a raw single-quoted literal), NOT `{{sev}}`. Whether it *should* become `{{sev}}` for the dashboard platform to resolve is a separate, untouched question. The Path 2 fix must not alter this — only the `TemplateVariable` time-suffix branches change; the value-position fall-through stays exactly as-is.
- **A `translateSplToDashboard` mode.** Deferred per the no-mode-flag decision until a concrete dashboard-emission target exists.
- **Literal snap unification** (`-1d@d` in `earliest=`/`where _time`). That's spec A's deferred gap #4, owned by a future `parseSplTime` change. This spec does not modify `parseSplTime` (other than ensuring tokens never reach it).
- **Epoch-seconds→ms conversion.** The token value is run-time-only; no static path ever emits a concrete epoch, so the unit mismatch never arises. Noted, not handled.

## Architecture

A token is detectable statically by shape: `$…$` (dollar-delimited, `TemplateVariable` node) or a raw value beginning with `$` (the `TimeConstraint` raw string). The fix is a guard at each of the three sites that recognizes the token shape and routes to drop-warn or unsupported — no new IR nodes, no emitter change, no `parseSplTime` change.

> **Source paths (post-2026-06-16 monorepo migration):** the translator now lives in `packages/nr-query-bridge/`. All bare filenames below (`splToIR.js`, `spl.grammar`, `splTime.js`, `messages.js`) are under `packages/nr-query-bridge/src/input/spl/` (or `src/` for `messages.js`); tests are under `packages/nr-query-bridge/test/`; the CLI is `packages/nr-query-bridge/bin/spl2nrql.js`. Line numbers are pre-migration but the move is a pure rename, so they still resolve relative to the file.

### Path 1 — `TimeConstraint` (`splToIR.js:487`)

Before calling `parseSplTime`, test the raw value for a token shape (`/\$[^$]+\$/`):

```js
case 'TimeConstraint': {
  if (/\$[^$]+\$/.test(node.value)) {
    sawTimeToken = true; // for mixed-bound detection
    warnings.push(messages.time_token_bound_dropped(node.param, node.value));
    return null; // drop: leave since/until unset
  }
  const { nrql, warning } = parseSplTime(node.value);
  if (warning) warnings.push(warning);
  if (nrql) {
    sawTimeLiteral = true; // a real offset was applied
    if (node.param === 'earliest') since = nrql;
    else until = nrql;
  }
  return null;
}
```

Dropping (returning null without setting `since`/`until`) leaves the query on the surrounding/default window. The warning names the param and token so the user knows which bound vanished. The `sawTimeToken`/`sawTimeLiteral` flags feed the mixed-bound check below.

### Path 2 — `TemplateVariable` (`splToIR.js:505-514`)

The current branches match only `.earliest`/`.latest` *suffixes*. That MISSES the commonest token form: global `$earliest$` / `$latest$` (no picker prefix, no dot), which a single global time picker injects (spl-expert, 2026-06-11). Those fall through to `return Identifier('{{earliest}}')`, re-creating bug 2 for the most common case. The fix must recognize a time token by the **whole name** being `earliest`/`latest` OR ending in `.earliest`/`.latest`:

```js
case 'TemplateVariable': {
  const n = node.name;
  const isEarliest = n === 'earliest' || n.endsWith('.earliest');
  const isLatest = n === 'latest' || n.endsWith('.latest');
  if (isEarliest || isLatest) {
    const param = isEarliest ? 'earliest' : 'latest';
    sawTimeToken = true; // for mixed-bound detection (below)
    warnings.push(messages.time_token_bound_dropped(param, `$${n}$`));
    return null; // drop: do NOT set since/until to {{…}}
  }
  return Identifier(`{{${n}}}`); // non-time variable: unchanged
}
```

This kills the `SINCE {{…}}` non-compiling emission for both `$tok.earliest$` and bare `$earliest$`. Path 1's `/\$[^$]+\$/` test already catches custom-named token bounds (`earliest=$myStart$`) since they arrive as raw `TimeConstraint` values — so the two paths now have matching coverage (closes Risk #4's consistency claim).

### Mixed-bound detection (the escalation mechanism)

Both bound-handling paths and the literal `parseSplTime` success path must record, per search scope, whether they saw a TOKEN bound and whether they saw a LITERAL bound. After the search expr is walked, if BOTH were seen → the window is mixed → emit `unsupported`, and CLEAR any `since`/`until` the literal path set (so no partial window leaks).

Concretely, in the `translateSearchExpr` scope add two flags (alongside the existing `consumedTime`):
- `sawTimeToken` — set by Path 1 (token branch) and Path 2 (the time-suffix branch).
- `sawTimeLiteral` — set whenever a LITERAL offset actually lands on `since`/`until`: Path 1's `parseSplTime` success branch AND spec A's `where _time > relative_time(...)` lower-bound path (the `since = nrql` assignment). The `where _time` *upper*-bound/point branches push `unsupported` and set no bound, so they do NOT mark a literal.

`translateSearchExpr` already returns `{ expr, warnings, unsupported, since, until, consumedTime }`; add `sawTimeToken` and `sawTimeLiteral` to that return. The escalation then happens in the CALLER, `translateAstToIR` (where `since`/`until` are committed onto `ir`, currently `splToIR.js:120-134`) — that is the right place because clearing a partial bound means simply NOT copying it onto `ir`:

```js
if (sawTimeToken && sawTimeLiteral) {
  ir.unsupported.push(messages.mixed_token_literal_time_unsupported());
  // do NOT copy since/until onto ir, and do NOT run the latest_without_earliest default
} else {
  if (since) ir.since = since;
  if (until) ir.until = until;
  if (until && !since) {
    ir.since = '24 hours ago';
    ir.warnings.push(messages.latest_without_earliest());
  }
}
```

Token-only windows fall through to drop+warn (since/until already unset). Literal-only windows are untouched. Subsearches recurse through their own `translateAstToIR` call, so their flags and bounds are naturally scope-isolated — a subsearch token never escalates the outer window. This is the only place the silent-widen / inverted-window cases are caught, so it is load-bearing — see Testing.

### Path 3 — `span=$timespan$` (grammar + handler)

`span_value` must first *parse* the token (so it doesn't error out), then the command handler rejects it. Add a token alternative to `span_value` (`spl.grammar:197`) that captures the token as a tagged value:

```
span_value
  = '$' name:template_var_name '$'
    { return { type: 'SpanToken', name }; }   // NEW — first, so $…$ is consumed
  / num:[0-9]+ unit:[smhdwMy]
    { return num.join('') + unit; }
  / 'day'i  { return '1d'; }
  / 'hour'i { return '1h'; }
  / 'minute'i { return '1m'; }
  / 'month'i { return '1M'; }
  / 'week'i { return '1w'; }
```

`span_value` is consumed by `timechart` (`:171`, `:194`) and `bin` (`:727`). In each consuming handler, detect the `SpanToken` shape and push `unsupported` (no NRQL for that clause):

```js
if (span && typeof span === 'object' && span.type === 'SpanToken') {
  ir.unsupported.push(messages.span_token_unsupported(`$${span.name}$`));
  // do not emit TIMESERIES / bucket
}
```

Existing string-valued `span` (`'5m'`, `'1d'`) flows unchanged. This converts a parse-error into a loud `unsupported` and keeps the rest of the pipe translatable.

### Subsearch scoping

`earliest=`/`latest=` inside `[ search … ]` bind only the subsearch and do NOT propagate to the outer search ([Splunk: About subsearches](https://docs.splunk.com/Documentation/SplunkCloud/latest/Search/Aboutsubsearches)). The translator already walks subsearches in their own `translateSearchExpr` scope, so Path 1/2 drops AND the mixed-bound check fire against the *subsearch's* flags/`since`/`until`, never the outer query's. The regression test must assert the OUTER query is unaffected (the correct direction — a subsearch with no bounds inherits the outer/dispatch window, but a subsearch's bounds never leak outward).

### Data flow

- Paths 1 & 2 set nothing; they push a warning and return null. The leading-search caller (`splToIR.js:120-131`) and subsearch walkers already tolerate unset `since`/`until`. **One interaction to verify:** the `latest_without_earliest` default at `:128` fires when `until` is set but `since` is not — dropping a `latest=` token means `until` stays unset, so this branch correctly does NOT fire. Confirm with a test.
- Path 3 pushes `unsupported`; the `timechart`/`bin` handler emits no time-bucket for that clause.

### Message catalog (new entries in `packages/nr-query-bridge/src/messages.js`)

Per the project rule, all user-facing text lives in the catalog — handlers call `messages.key()`, no inline literals. New entries (wording to finalize during implementation):

```js
time_token_bound_dropped: (param, token) =>
  `${param}=${token} is a dashboard time-range token resolved only at run time; ` +
  `it has no static NRQL time bound. Dropped — the query uses the surrounding/default time range.`,
mixed_token_literal_time_unsupported: () =>
  `This search mixes a literal time bound with a dashboard time-range token. ` +
  `Dropping only the token would silently widen or invert the window, so the whole ` +
  `time range is unsupported. Make both bounds literal, or both tokens.`,
span_token_unsupported: (token) =>
  `span=${token} is a dashboard token resolved only at run time; NRQL TIMESERIES needs a concrete duration ` +
  `(TIMESERIES AUTO would silently pick its own bucket size). Specify a literal span (e.g. 5 minutes) instead.`,
```

`time_token_bound_dropped` is a WARNING; `mixed_token_literal_time_unsupported` and `span_token_unsupported` are UNSUPPORTED. (There is NO separate `messages.test.js` — corrected 2026-06-16. The exhaustive bidirectional check lives in the case runner in `packages/nr-query-bridge/test/spl/spl.test.js` (~line 3711): it spies every key in `messages`, then asserts each test case's `warningFunc`/`unsupportedFunc` arrays fired AND no unlisted key fired. New keys are exercised simply by being listed in a case's arrays.) (The `span_token_unsupported` text names `TIMESERIES AUTO` explicitly to preempt the "why not auto-bucket?" question — auto would change the chart resolution the SPL `span=` specified, the same silent-different-result class we reject.)

## Testing

Synthetic `verified: false` cases (humans promote). Assert ACTUAL emitted NRQL (capture via `packages/nr-query-bridge/bin/spl2nrql.js`); `warningFunc`/`unsupportedFunc` arrays must be exhaustive (list every message key that fires).

- **Path 1 token-only (drop+warn):** `index=web earliest=$tok.earliest$ latest=$tok.latest$ | stats count` → `FROM Log SELECT count(*) WHERE …` with NO SINCE/UNTIL; `warningFunc: ['time_token_bound_dropped', 'time_token_bound_dropped']` (one per dropped bound). Confirm `latest_without_earliest` does NOT fire.
- **Path 1 single token (drop+warn):** `index=web latest=$tok.latest$ | stats count` → no UNTIL, no SINCE, one `time_token_bound_dropped`; `latest_without_earliest` does NOT fire (until unset).
- **Path 1 not-a-token (regression):** `earliest=-24h latest=now` → unchanged (`SINCE 24 hours ago`, etc.); no token warning.
- **Mixed bound — silent-widen direction:** `index=web earliest=-24h latest=$tok.latest$ | stats count` → `unsupportedFunc: ['mixed_token_literal_time_unsupported', 'time_token_bound_dropped']` (the token still warns; the window escalates to unsupported); emitted NRQL has NO SINCE and NO UNTIL (the literal `since` is cleared). Assert no `SINCE 24 hours ago` leaks.
- **Mixed bound — inverted-window direction:** `index=web earliest=$tok.earliest$ latest=-2h | stats count` → same unsupported; assert NO `UNTIL 2 hours ago` leaks (that clause alone would fail to compile — `start time must be before its end time`, verified MCP 2026-06-11).
- **Path 2 dotted (drop+warn):** a query where `$tok.earliest$` appears bare in the search expr → no `SINCE {{…}}` emitted; `time_token_bound_dropped` fires.
- **Path 2 GLOBAL token (drop+warn):** bare `$earliest$` / `$latest$` (no prefix) in the search expr → drop+warn, NOT a `{{earliest}}` identifier. This is the case the old suffix-only check missed; it must produce `time_token_bound_dropped`, never `SINCE {{earliest}}`.
- **Path 2 non-time variable (regression):** `status=$sev$` → still emits `WHERE status = {{sev}}` (or current value-position behavior); NO drop, NO warning.
- **Path 3 (`$timespan$` unsupported):** `index=web | timechart span=$timespan$ count` → parses (NOT in `errors` bucket); `unsupportedFunc: ['span_token_unsupported']`; the rest of the pipe still translates. Same for `| bin _time span=$timespan$`.
- **Path 3 not-a-token (regression):** `| timechart span=5m count` → `TIMESERIES 5 minutes` unchanged.
- **Subsearch scoping:** `index=web [ search index=auth earliest=$tok.earliest$ ] | stats count` → the token drop/warn is scoped to the subsearch; the OUTER query's `since`/`until` is untouched (assert outer-unaffected, not subsearch-isolated).
- **Corpus gate:** silent-wrong default-window queries (bug 1) move to carrying a `time_token_bound_dropped` warning; `$timespan$` queries move from `errors` to `unsupported`; `threw` stays 0; clean must not fall; no command bucket regresses.

## Risks

- **`parseSplTime` is shared with the literal `earliest`/`latest` path and spec A's `where _time`.** This spec does not modify it — the token guard sits *before* the `parseSplTime` call in Path 1, so literal offsets are unaffected. Do not touch `parseSplTime`; regressing literal `earliest=`/`latest=` is the bigger risk.
- **`span_value` ordering.** The `SpanToken` alternative must come FIRST (most specific — requires `$…$`), so a literal `5m` still falls through to the numeric alternative. A bare word like `day` must not be swallowed by the token rule (it can't — no `$`).
- **Token-shape regex breadth.** Path 1's `/\$[^$]+\$/` test must not misfire on a legitimate literal containing `$` (none exist in `time_value` — SPL time literals are `-24h`, `@d`, epoch digits, never `$`). Confirm with the not-a-token regression test.
- **Two distinct token nodes for one user intent.** `earliest=$x$` is `TimeConstraint` (Path 1); bare `$x.earliest$`/`$earliest$` is `TemplateVariable` (Path 2). Both must drop+warn identically and both must set `sawTimeToken`, or the same dashboard query gives inconsistent output (or escapes the mixed-bound check) depending on how the author wrote the bound. Both share the `time_token_bound_dropped` message and both feed the same flag.
- **Mixed-bound flag scoping.** `sawTimeToken`/`sawTimeLiteral` must be scoped to the SAME search-expr walk as the `since`/`until` they guard — a subsearch's flags must not bleed into the outer check, or a token in a subsearch + a literal in the outer search would wrongly escalate the outer window. Each `translateSearchExpr` scope owns its own pair.
- **Clearing partial bounds.** The escalation MUST clear `since`/`until`, not just push `unsupported` — leaving a half-set `since` would emit a window alongside the unsupported message (violates the project rule that unsupported emits no NRQL for that clause).

## Deferred gaps (FIXME-tracked)

1. **`translateSplToDashboard` emission mode** — when a concrete dashboard-JSON target exists, tokens may map to NR-native dashboard variables instead of dropping. Not needed today (drop is correct for both modes). Add the flag then.
2. **Literal snap-to in `earliest=`/`where _time`** (`-1d@d`) — inherited from spec A deferred gap #4; owned by a future `parseSplTime` snap-unification. This spec only handles *tokens*, whose run-time snap is undetectable statically.
3. **`$timespan$` as a real duration** — if a future deferred-binding mechanism (or dashboard mode) can supply the span, Path 3 could emit `TIMESERIES {{…}}`. None exists today (verified: NRQL rejects placeholders), so it stays `unsupported`.
4. **`addinfo` / `info_min_time` / `info_max_time`** — `| addinfo` injects the dashboard's effective window as epoch-seconds fields (`info_min_time`/`info_max_time`, or `0.000`/`+Infinity` for all-time), sometimes fed into `where _time >= info_min_time`. These are NOT `$…$` tokens, so neither guard fires — they pass through as bare identifiers and likely mistranslate. Same "dashboard-supplied time bound" intent as tokens; out of scope here but flagged so it isn't lost. A future spec should give them the same loud treatment.
